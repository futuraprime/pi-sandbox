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
    gates: [{ name: "sandbox", passed: true, verdict: "passed" }],
    lifecycle: { initialize: "passed", reset: "passed" },
  });
  const failedMode = {
    ...passedMode("enabled"),
    gates: [{ name: "sandbox", passed: false, verdict: "failed" }],
  };
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
