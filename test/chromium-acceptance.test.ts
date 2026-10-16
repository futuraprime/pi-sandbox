import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import assert from "node:assert/strict";

import {
  acceptanceVerdict,
  assertSafeHost,
  buildResourceProbeSource,
  classifyBrowser,
  classifyHostBaseline,
  classifyNestedSandboxProbe,
  classifyProbeCompilation,
  classifyResourceProbe,
  validateNestedSandboxProbeExecutable,
  capture,
  captureGeneratedProfile,
  isChromiumLaunchCommand,
  chromiumLaunchArgs,
  extractInlineSandboxProfile,
  ownedChromiumPids,
  PROCESS_LIST_MAX_BUFFER,
  readWorkerResultFile,
  runBoundedFile,
  reportAsMarkdown,
  truncateOutput,
  writeWorkerResultFile,
  MAX_WORKER_RESULT_BYTES,
} from "../scripts/chromium-acceptance.ts";

test("acceptance host guard requires bare Darwin", () => {
  assert.doesNotThrow(() => assertSafeHost("darwin", undefined));
  assert.throws(() => assertSafeHost("linux", undefined), /requires macOS/);
  assert.throws(() => assertSafeHost("darwin", "1"), /SANDBOX_RUNTIME must be unset/);
  assert.throws(() => assertSafeHost("darwin", ""), /SANDBOX_RUNTIME must be unset/);
});

test("Chromium observer matches only the raw or runtime-prefixed launch command", () => {
  const launch = "'/Applications/Chromium.app/Contents/MacOS/Chromium' --headless";
  const runtimePrefix = "unset GIT_SSH_COMMAND; ";

  assert.equal(isChromiumLaunchCommand(launch, launch), true);
  assert.equal(isChromiumLaunchCommand(`${runtimePrefix}${launch}`, launch), true);
  assert.equal(
    isChromiumLaunchCommand(`${runtimePrefix}'/Applications/Chromium' --version`, launch),
    false,
  );
  assert.equal(isChromiumLaunchCommand(`${runtimePrefix}node -e 'resource probe'`, launch), false);
  assert.equal(isChromiumLaunchCommand(`${runtimePrefix}echo unrelated`, launch), false);
});

test("resource verdicts accept enabled operations and only explicit disabled denials", () => {
  assert.equal(
    classifyResourceProbe("enabled", "loopback-bind", {
      exitCode: 0,
      stdout: "resource-allowed:loopback-bind",
      stderr: "",
    }).passed,
    true,
  );
  assert.equal(
    classifyResourceProbe("disabled", "darwin-temp-file", {
      exitCode: 0,
      stdout: "resource-denied:darwin-temp-file:EPERM",
      stderr: "",
    }).passed,
    true,
  );
  assert.equal(
    classifyResourceProbe("disabled", "darwin-temp-file", {
      exitCode: 0,
      stdout: "resource-error:darwin-temp-file:EEXIST",
      stderr: "",
    }).passed,
    false,
  );
  assert.equal(
    classifyResourceProbe("disabled", "darwin-temp-unix-socket", {
      exitCode: null,
      stdout: "resource-denied:darwin-temp-unix-socket:EPERM",
      stderr: "",
      timedOut: true,
    }).passed,
    false,
  );
});

test("generated network probes distinguish allowed, expected denial, and unexpected errors", () => {
  for (const name of ["loopback-bind", "darwin-temp-unix-socket"] as const) {
    const execute = (errorCode?: string) => {
      const output: string[] = [];
      const state: { exitCode?: number } = {};
      const server = {
        onError: undefined as ((error: { code: string }) => void) | undefined,
        once(event: string, callback: (error: { code: string }) => void) {
          assert.equal(event, "error");
          this.onError = callback;
          return this;
        },
        listen(...args: unknown[]) {
          if (errorCode) this.onError?.({ code: errorCode });
          else (args.at(-1) as () => void)();
          return this;
        },
        close(callback: () => void) {
          callback();
        },
      };
      const fakeFs = { unlinkSync() {}, writeFileSync() {} };
      runInNewContext(buildResourceProbeSource(name, "/tmp/probe.sock"), {
        require: (moduleName: string) =>
          moduleName === "node:fs"
            ? fakeFs
            : moduleName === "node:net"
              ? { createServer: () => server }
              : null,
        console: { log: (message: string) => output.push(message) },
        process: state,
      });
      return { stdout: output.join("\n"), exitCode: state.exitCode ?? 0 };
    };

    const allowed = execute();
    assert.equal(
      classifyResourceProbe("enabled", name, { ...allowed, stderr: "" }).passed,
      true,
      `${name}: ${JSON.stringify(allowed)}`,
    );
    for (const code of ["EPERM", "EACCES"]) {
      const denied = execute(code);
      assert.equal(denied.exitCode, 0, `${name} ${code} should be a normal denial`);
      assert.equal(classifyResourceProbe("disabled", name, { ...denied, stderr: "" }).passed, true);
    }
    const unexpected = execute("EADDRINUSE");
    assert.equal(unexpected.exitCode, 2);
    assert.match(unexpected.stdout, new RegExp(`resource-error:${name}:EADDRINUSE`));
    assert.equal(
      classifyResourceProbe("disabled", name, { ...unexpected, stderr: "" }).passed,
      false,
    );
  }
});

test("browser verdict requires live enabled markers and attributed disabled denial", () => {
  assert.equal(
    classifyBrowser("enabled", {
      command: "chromium",
      exitCode: 0,
      stdout: "<html><body></body></html>",
      stderr: "DevTools listening on ws://127.0.0.1:1234/devtools/browser/id",
      outputTruncated: false,
    }).passed,
    true,
  );
  assert.equal(
    classifyBrowser("disabled", {
      command: "chromium",
      exitCode: 21,
      stdout: "",
      stderr: "Failed to create a ProcessSingleton: Operation not permitted",
      outputTruncated: false,
    }).passed,
    true,
  );
  assert.equal(
    classifyBrowser("disabled", {
      command: "chromium",
      exitCode: 1,
      stdout: "",
      stderr: "Could not initialize unrelated browser component",
      outputTruncated: false,
    }).passed,
    false,
  );
  assert.equal(
    classifyBrowser("enabled", {
      command: "chromium",
      exitCode: null,
      stdout: "",
      stderr: "timeout",
      outputTruncated: false,
      timedOut: true,
    }).passed,
    false,
  );
});

test("nested probe executable validation requires the owned regular executable file", () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-nested-probe-test-"));
  const canonicalFixture = realpathSync(fixture);
  const executable = join(canonicalFixture, "sandbox_init_probe");
  try {
    writeFileSync(executable, "probe", { mode: 0o700 });
    assert.equal(validateNestedSandboxProbeExecutable(fixture, executable), undefined);

    const target = join(fixture, "other-probe");
    writeFileSync(target, "probe", { mode: 0o700 });
    rmSync(executable);
    symlinkSync(target, executable);
    assert.match(validateNestedSandboxProbeExecutable(fixture, executable)!, /symbolic link/);

    rmSync(executable);
    writeFileSync(executable, "probe", { mode: 0o600 });
    assert.match(validateNestedSandboxProbeExecutable(fixture, executable)!, /validation failed/);
    assert.match(
      validateNestedSandboxProbeExecutable(fixture, target)!,
      /not the owned fixture path/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("nested sandbox_init diagnostic separates initialization refusal from unavailable execution", () => {
  assert.equal(
    classifyNestedSandboxProbe({ exitCode: 0, stdout: "", stderr: "" }),
    "init-succeeded",
  );
  assert.equal(
    classifyNestedSandboxProbe({
      exitCode: 86,
      stdout: "",
      stderr: "sandbox-init-result:return=-1;errno=1;error=Operation not permitted",
    }),
    "init-refused-EPERM",
  );
  assert.equal(
    classifyNestedSandboxProbe({
      exitCode: 126,
      stdout: "",
      stderr: "Operation not permitted",
    }),
    "execution-failed",
  );
  assert.equal(
    classifyNestedSandboxProbe({
      exitCode: null,
      stdout: "",
      stderr: "timeout",
      timedOut: true,
    }),
    "timeout",
  );
  assert.equal(
    classifyProbeCompilation({ exitCode: null, error: "spawn /usr/bin/clang ENOENT" }),
    "diagnostic-unavailable",
  );
  assert.equal(classifyProbeCompilation({ exitCode: null, timedOut: true }), "timeout");

  const content = "(version 1)\\n";
  const mode = {
    mode: "enabled" as const,
    probes: [],
    nestedSandboxProbe: {
      result: {
        command: "sandbox-init-probe",
        exitCode: 0,
        stdout: "",
        stderr: "",
        outputTruncated: false,
      },
      classification: "init-succeeded" as const,
    },
    gates: [
      { name: "chromium-launch", passed: false, verdict: "browser failed" },
      { name: "generated-profile-capture", passed: true, verdict: "captured" },
    ],
    generatedSeatbeltProfile: {
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      captureMethod: "unit test",
    },
    lifecycle: { initialize: "passed", reset: "passed" },
  };
  const disabled = { ...mode, mode: "disabled" as const };
  const failedHost = classifyHostBaseline({
    command: "Chromium",
    exitCode: 1,
    stdout: "",
    stderr: "failed",
    outputTruncated: false,
  });
  assert.equal(
    acceptanceVerdict(
      [mode, disabled],
      {
        version: mode.nestedSandboxProbe.result,
        result: mode.nestedSandboxProbe.result,
        gate: failedHost,
        method: "test",
      },
      false,
      true,
      false,
    ),
    "FAIL",
  );
});

test("host baseline attributes timeouts and errors while preserving observed markers", () => {
  const timedOut = classifyHostBaseline({
    command: "Chromium",
    exitCode: null,
    stdout: "<html><body></body></html>",
    stderr: "DevTools listening on ws://127.0.0.1:1234/devtools/browser/id",
    outputTruncated: false,
    timedOut: true,
  });
  assert.equal(timedOut.passed, false);
  assert.match(timedOut.verdict, /timed out/);
  assert.match(timedOut.verdict, /DevTools observed; DOM observed/);

  const error = classifyHostBaseline({
    command: "Chromium",
    exitCode: null,
    stdout: "",
    stderr: "spawn failed",
    outputTruncated: false,
    error: "spawn failed",
  });
  assert.equal(error.passed, false);
  assert.match(error.verdict, /execution error/);
  assert.match(error.verdict, /DevTools missing; DOM missing/);
});

test("generated SBPL capture handles shell apostrophe quoting and omits wrapper secrets", () => {
  const profile = `(version 1)\n(deny default)\n; fixture user's path\n`;
  const quoted = profile.replaceAll("'", "'\"'\"'");
  const wrapper = `HTTP_PROXY=http://srt:proxy-secret@127.0.0.1:9000 /usr/bin/sandbox-exec -p '${quoted}' /bin/bash -c 'private-wrapper'`;
  assert.equal(extractInlineSandboxProfile(wrapper), profile);
  const capture = captureGeneratedProfile(wrapper, "enabled", (command) => command);
  assert.equal(capture.content, profile);
  assert.equal(capture.sha256, createHash("sha256").update(profile).digest("hex"));
  assert.doesNotMatch(JSON.stringify(capture), /proxy-secret|private-wrapper|HTTP_PROXY/);
});

test("worker result file preserves large generated profiles independently of diagnostic capture", () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-worker-result-test-"));
  const resultPath = join(fixture, "worker-result.json");
  try {
    const profile = `(version 1)\n(deny default)\n${Array.from(
      { length: 7_000 },
      (_, index) => `(allow file-read* (literal "/fixture/resource-${index}"))\n`,
    ).join("")}`;
    const wrapped = `/usr/bin/sandbox-exec -p '${profile}' /bin/bash`;
    const generatedSeatbeltProfile = captureGeneratedProfile(
      wrapped,
      "enabled",
      (command) => command,
    );
    const result = {
      mode: "enabled" as const,
      chromiumVersion: {
        command: "Chromium --version",
        exitCode: 0,
        stdout: "Chromium 154",
        stderr: "",
        outputTruncated: false,
      },
      browser: {
        command: "Chromium --dump-dom",
        exitCode: 0,
        stdout: "<html></html>",
        stderr: "DevTools listening on ws://127.0.0.1:1234/devtools/browser/id",
        outputTruncated: false,
      },
      probes: [],
      gates: [{ name: "generated-profile-capture", passed: true, verdict: "captured" }],
      lifecycle: { initialize: "passed", reset: "passed" },
      generatedSeatbeltProfile,
    };
    const diagnostics = capture(256 * 1024);
    diagnostics.append("stderr", "large diagnostic output ".repeat(20_000));
    assert.equal(diagnostics.truncated(), true);
    assert.equal(diagnostics.stderr().length, 256 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) > 256 * 1024);

    writeWorkerResultFile(resultPath, result);
    assert.equal(statSync(resultPath).mode & 0o777, 0o600);
    assert.throws(
      () => readWorkerResultFile(resultPath, "disabled"),
      /worker result mode does not match request/,
    );
    const symlinkPath = join(fixture, "worker-result-link.json");
    symlinkSync(resultPath, symlinkPath);
    assert.throws(
      () => readWorkerResultFile(symlinkPath, "enabled"),
      /worker result file is not a regular file/,
    );
    const captured = readWorkerResultFile(resultPath, "enabled");
    assert.deepEqual(captured.generatedSeatbeltProfile, generatedSeatbeltProfile);
    assert.equal(captured.browser?.stdout, "<html></html>");
    assert.equal(captured.generatedSeatbeltProfile?.content.length, profile.length);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("worker result files reject missing, malformed, invalid, and oversized data clearly", () => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-worker-result-invalid-test-"));
  const resultPath = join(fixture, "worker-result.json");
  try {
    assert.throws(
      () => readWorkerResultFile(resultPath, "enabled"),
      /worker result file is missing/,
    );

    writeFileSync(resultPath, "{invalid json");
    assert.throws(
      () => readWorkerResultFile(resultPath, "enabled"),
      /worker result JSON is malformed/,
    );

    writeFileSync(resultPath, "{}", { flag: "w" });
    assert.throws(
      () => readWorkerResultFile(resultPath, "enabled"),
      /worker result shape is invalid/,
    );

    writeFileSync(resultPath, Buffer.alloc(MAX_WORKER_RESULT_BYTES + 1), { flag: "w" });
    assert.throws(() => readWorkerResultFile(resultPath, "enabled"), /exceeds the 8 MiB limit/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("generated SBPL capture fails closed on truncated or malformed shell tokens", () => {
  assert.throws(
    () => extractInlineSandboxProfile("/usr/bin/sandbox-exec -p '(version 1)\n(deny default)"),
    /truncated or malformed/,
  );
  assert.throws(
    () => extractInlineSandboxProfile("/usr/bin/sandbox-exec -p (version 1)"),
    /single-quoted shell token/,
  );
  assert.throws(
    () =>
      extractInlineSandboxProfile(
        "/usr/bin/sandbox-exec -p '(version 1)\n(deny default)' /usr/bin/sandbox-exec -p '(version 1)\n(deny default)'",
      ),
    /exactly one/,
  );
});

test("profile derivation applies adapter augmentation only for enabled Chromium", () => {
  const base = "/usr/bin/sandbox-exec -p '(version 1)\n(deny default)' /bin/bash";
  const calls: boolean[] = [];
  const augment = (wrapper: string, allow: boolean) => {
    calls.push(allow);
    return allow
      ? wrapper.replace("(deny default)", "(deny default)\n; adapter Chromium grants")
      : wrapper;
  };
  const enabled = captureGeneratedProfile(base, "enabled", augment);
  const disabled = captureGeneratedProfile(base, "disabled", augment);
  assert.deepEqual(calls, [true, false]);
  assert.match(enabled.content, /adapter Chromium grants/);
  assert.doesNotMatch(disabled.content, /adapter Chromium grants/);
  assert.notEqual(enabled.sha256, disabled.sha256);
});

test("all Chromium launch modes include test-only mock keychain isolation", () => {
  for (const modeArgs of [
    chromiumLaunchArgs("/fixture/enabled"),
    chromiumLaunchArgs("/fixture/disabled"),
    chromiumLaunchArgs("/fixture/host"),
  ]) {
    assert.ok(modeArgs.includes("--use-mock-keychain"));
    assert.ok(!modeArgs.includes("--no-sandbox"));
  }
});

test("host baseline is diagnostic and cannot mask sandbox acceptance failures", () => {
  const baselineResult = {
    command: "Chromium",
    exitCode: 0,
    stdout: "<html></html>",
    stderr: "DevTools listening on ws://127.0.0.1:1234/devtools/browser/id",
    outputTruncated: false,
  };
  const baseline = {
    version: { ...baselineResult, stdout: "Chromium 152.0.0.0" },
    result: baselineResult,
    gate: classifyHostBaseline(baselineResult),
    method: "direct host diagnostic",
  };
  assert.equal(baseline.gate.passed, true);
  const failedResult = {
    ...baselineResult,
    exitCode: 133,
    stdout: "",
    stderr: "child sandbox_initEPERM",
  };
  assert.equal(classifyHostBaseline(failedResult).passed, false);
  const passedMode = (mode: "enabled" | "disabled") => ({
    mode,
    probes: [],
    gates: [
      { name: "sandbox", passed: true, verdict: "passed" },
      { name: "generated-profile-capture", passed: true, verdict: "captured" },
    ],
    generatedSeatbeltProfile: {
      content: "(version 1)\n",
      sha256: createHash("sha256").update("(version 1)\n").digest("hex"),
      captureMethod: "unit test",
    },
    lifecycle: { initialize: "passed", reset: "passed" },
  });
  const failedMode = {
    ...passedMode("enabled"),
    gates: [{ name: "sandbox", passed: false, verdict: "failed" }],
  };
  const missingProfileMode = {
    ...passedMode("enabled"),
    generatedSeatbeltProfile: undefined,
  };
  assert.equal(
    acceptanceVerdict([missingProfileMode, passedMode("disabled")], baseline, false, true, false),
    "FAIL",
  );
  assert.equal(
    acceptanceVerdict([failedMode, passedMode("disabled")], baseline, false, true, false),
    "FAIL",
  );
  const failedBaseline = {
    ...baseline,
    result: failedResult,
    gate: classifyHostBaseline(failedResult),
  };
  assert.equal(
    acceptanceVerdict(
      [passedMode("enabled"), passedMode("disabled")],
      failedBaseline,
      false,
      true,
      false,
    ),
    "PASS",
  );
  assert.equal(
    acceptanceVerdict([passedMode("enabled"), passedMode("disabled")], baseline, true, true, false),
    "FAIL",
  );
});

test("output truncation is explicit and bounded", () => {
  assert.deepEqual(truncateOutput("short", 5), { text: "short", truncated: false });
  const truncated = truncateOutput("0123456789", 4);
  assert.equal(truncated.truncated, true);
  assert.match(truncated.text, /output truncated/);
});

test("escaped-browser cleanup requires the exact Chromium executable and profile", () => {
  const ps = [
    "  101 /Applications/Chromium --user-data-dir=/tmp/owned-profile --type=renderer",
    "  102 /Applications/Chromium --user-data-dir=/tmp/owned-profile-other",
    "  103 /Applications/Chromium --user-data-dir=/tmp/unrelated",
    "  104 /Applications/Chromium Helper --user-data-dir=/tmp/owned-profile",
    "  105 /bin/echo --user-data-dir=/tmp/owned-profile",
  ].join("\n");
  assert.deepEqual(ownedChromiumPids(ps, "/tmp/owned-profile", "/Applications/Chromium"), [101]);
});

test("large process listings are captured from a bounded subprocess without widening ownership", () => {
  const source = [
    'const lines = ["  101 /Applications/Chromium --user-data-dir=/tmp/owned-profile --type=renderer"];',
    "for (let index = 0; index < 12_000; index++) {",
    '  lines.push("  " + (10_000 + index) + " /usr/bin/unrelated --argument=" + "x".repeat(20));',
    "}",
    'process.stdout.write(lines.join("\\n"));',
  ].join("\n");
  const listing = runBoundedFile(
    process.execPath,
    ["-e", source],
    process.env,
    5_000,
    PROCESS_LIST_MAX_BUFFER,
  );
  assert.ok(Buffer.byteLength(listing) > 256 * 1024);
  assert.deepEqual(
    ownedChromiumPids(listing, "/tmp/owned-profile", "/Applications/Chromium"),
    [101],
  );
});

test("bounded subprocess capture fails explicitly when output exceeds maxBuffer", () => {
  assert.throws(
    () =>
      runBoundedFile(
        process.execPath,
        ["-e", 'process.stdout.write("x".repeat(512 * 1024));'],
        process.env,
        5_000,
        256 * 1024,
      ),
    (error: NodeJS.ErrnoException) => error.code === "ENOBUFS",
  );
});

test("Markdown report is explicit about model-free scope and verdict", () => {
  const markdown = reportAsMarkdown({
    schema: 1,
    startedAt: "start",
    finishedAt: "finish",
    verdict: "PASS",
    scope: "model-free only",
    host: { platform: "darwin" },
    commands: {},
    nestedSandboxDiagnostic: {
      compiler: "/usr/bin/clang",
      compileCommand: "clang probe.c -lsandbox",
      profile: "kSBXProfilePureComputation (SANDBOX_NAMED)",
      api: "sandbox_init(...) ",
      compilation: {
        command: "clang probe.c -lsandbox",
        exitCode: 0,
        stdout: "",
        stderr: "",
        outputTruncated: false,
      },
      compilationClassification: "compiled",
      host: { classification: "init-succeeded" },
      modes: {},
      interpretation: "diagnostic only",
    },
    hostBaseline: {
      version: {
        command: "Chromium --version",
        exitCode: 0,
        stdout: "Chromium 152",
        stderr: "",
        outputTruncated: false,
      },
      result: {
        command: "Chromium",
        exitCode: 0,
        stdout: "<html></html>",
        stderr: "",
        outputTruncated: false,
      },
      gate: { name: "host-baseline-launch", passed: true, verdict: "diagnostic only" },
      method: "direct host launch",
    },
    modes: [
      {
        mode: "enabled",
        probes: [],
        gates: [{ name: "launch", passed: true, verdict: "DevTools and DOM" }],
        lifecycle: { initialize: "passed", reset: "passed" },
      },
    ],
    cleanup: { fixtureRemoved: true },
    warnings: [],
  });
  assert.match(markdown, /Verdict: \*\*PASS\*\*/);
  assert.match(markdown, /model-free only/);
  assert.match(markdown, /launch: PASS/);
  assert.match(markdown, /host baseline \(diagnostic only\)/);
  assert.match(markdown, /do not affect the enabled\/disabled sandbox gate verdict/);
});
