import { createHash } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";

import assert from "node:assert/strict";

import {
  acceptanceVerdict,
  assertSafeHost,
  buildResourceProbeSource,
  classifyBrowser,
  classifyHostBaseline,
  classifyResourceProbe,
  captureGeneratedProfile,
  isChromiumLaunchCommand,
  chromiumLaunchArgs,
  extractInlineSandboxProfile,
  ownedChromiumPids,
  reportAsMarkdown,
  truncateOutput,
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

test("Markdown report is explicit about model-free scope and verdict", () => {
  const markdown = reportAsMarkdown({
    schema: 1,
    startedAt: "start",
    finishedAt: "finish",
    verdict: "PASS",
    scope: "model-free only",
    host: { platform: "darwin" },
    commands: {},
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
  assert.match(markdown, /does not affect the enabled\/disabled sandbox gate verdict/);
});
