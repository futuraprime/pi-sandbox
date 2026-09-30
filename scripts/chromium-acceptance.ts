#!/usr/bin/env node
import type { BashOperations } from "@earendil-works/pi-coding-agent";

/**
 * Model-free, real macOS Chromium acceptance check. Run from a normal host
 * Terminal with: pnpm exec tsx scripts/chromium-acceptance.ts
 * Optional: --chromium /path/to/Chromium --report tmp/<new-report>.json
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { SandboxConfig } from "../src/config.ts";

type Mode = "enabled" | "disabled";
type ExecResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  outputStream?: string;
  timedOut?: boolean;
  error?: string;
};
type Gate = { name: string; passed: boolean; verdict: string };
type WorkerResult = {
  mode: Mode;
  chromiumVersion?: ExecResult;
  browser?: ExecResult;
  probes: ExecResult[];
  gates: Gate[];
  lifecycle: { initialize: string; reset: string };
  failure?: string;
};
type HostBaseline = {
  version: ExecResult;
  result: ExecResult;
  gate: Gate;
  method: string;
};
type AcceptanceReport = {
  schema: 1;
  startedAt: string;
  finishedAt: string;
  verdict: "PASS" | "FAIL";
  scope: string;
  host: Record<string, unknown>;
  commands: Record<string, string>;
  modes: WorkerResult[];
  hostBaseline: HostBaseline;
  cleanup: Record<string, unknown>;
  warnings: string[];
};

const CAPTURE_LIMIT = 12_000;
const WORKER_TIMEOUT_MS = 90_000;
const RESULT_PREFIX = "PI_CHROMIUM_ACCEPTANCE_RESULT:";

export function assertSafeHost(
  platform: NodeJS.Platform,
  sandboxRuntime: string | undefined,
): void {
  if (platform !== "darwin")
    throw new Error("Refusing acceptance run: this harness requires macOS (Darwin).");
  if (sandboxRuntime !== undefined) {
    throw new Error(
      "Refusing acceptance run: SANDBOX_RUNTIME must be unset; do not run inside another sandbox.",
    );
  }
}

export function truncateOutput(
  value: string,
  limit = CAPTURE_LIMIT,
): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}\n[output truncated]`, truncated: true };
}

export function classifyResourceProbe(
  mode: Mode,
  name: string,
  result: Pick<ExecResult, "exitCode" | "stdout" | "stderr" | "timedOut" | "error">,
): Gate {
  const output = `${result.stdout}\n${result.stderr}`;
  const allowed = output.includes(`resource-allowed:${name}`);
  const denied = new RegExp(`resource-denied:${name}:(?:EPERM|EACCES)(?:\\b|$)`).test(output);
  if (result.timedOut || result.error)
    return { name, passed: false, verdict: "timeout or execution error is not a denial" };
  if (mode === "enabled") {
    const passed = result.exitCode === 0 && allowed && !denied;
    return { name, passed, verdict: passed ? "allowed" : "expected allowed resource operation" };
  }
  const passed = result.exitCode === 0 && denied && !allowed;
  return {
    name,
    passed,
    verdict: passed ? "denied with EPERM/EACCES" : "expected recognizable sandbox/resource denial",
  };
}

export function classifyHostBaseline(result: ExecResult): Gate {
  const classified = classifyBrowser("enabled", result);
  return {
    name: "host-baseline-launch",
    passed: classified.passed,
    verdict: classified.passed
      ? "diagnostic direct-host Chromium launch observed DevTools and DOM"
      : "diagnostic direct-host Chromium launch did not produce DevTools and DOM",
  };
}

export function acceptanceVerdict(
  modes: WorkerResult[],
  _hostBaseline: HostBaseline,
  cleanupFailed: boolean,
  fixtureRemoved: boolean,
  fatalFailure: boolean,
): "PASS" | "FAIL" {
  // The host baseline is diagnostic only; it cannot override sandbox worker gates.
  const gates = modes.flatMap((mode) => mode.gates);
  return !fatalFailure &&
    !cleanupFailed &&
    modes.length === 2 &&
    fixtureRemoved &&
    gates.length > 0 &&
    gates.every((gate) => gate.passed)
    ? "PASS"
    : "FAIL";
}

export function classifyBrowser(mode: Mode, result: ExecResult): Gate {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut || result.error) {
    return {
      name: "chromium-launch",
      passed: false,
      verdict: "timeout or execution error is a failure",
    };
  }
  if (mode === "enabled") {
    const devtools = /DevTools listening on ws:\/\/127\.0\.0\.1:/i.test(output);
    const dom = /<html[\s>]/i.test(result.stdout) && /<\/html>/i.test(result.stdout);
    const passed = result.exitCode === 0 && devtools && dom;
    return {
      name: "chromium-launch",
      passed,
      verdict: passed
        ? "DevTools marker and about:blank DOM observed"
        : "expected successful exit, DevTools marker, and DOM",
    };
  }
  const resourceDenial =
    /Operation not permitted|Permission denied|\bEPERM\b|Failed to create (?:a )?(?:ProcessSingleton|socket directory)|ProcessSingleton.*(?:failed|error|cannot)/i.test(
      output,
    );
  const passed = result.exitCode !== 0 && resourceDenial;
  return {
    name: "chromium-launch",
    passed,
    verdict: passed
      ? "nonzero exit with recognizable sandbox/resource denial"
      : "expected nonzero exit attributable to sandbox/resource denial",
  };
}

export function ownedChromiumPids(
  psOutput: string,
  userDataDir: string,
  chromiumExecutable: string,
): number[] {
  const marker = `--user-data-dir=${userDataDir}`;
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedExecutable = chromiumExecutable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pids: number[] = [];
  for (const line of psOutput.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (
      match &&
      new RegExp(`^(?:"${escapedExecutable}"|${escapedExecutable})\\s+--`).test(match[2]) &&
      new RegExp(`${escapedMarker}(?:\\s|$)`).test(match[2])
    )
      pids.push(Number(match[1]));
  }
  return [...new Set(pids)];
}

export function reportAsMarkdown(report: AcceptanceReport): string {
  const state = (passed: boolean) => (passed ? "PASS" : "FAIL");
  const rows = report.modes.flatMap((mode) => [
    `| ${mode.mode} | ${mode.gates.map((gate) => `${gate.name}: ${state(gate.passed)} (${gate.verdict})`).join("; ")} |`,
  ]);
  return [
    "# Model-free Chromium sandbox acceptance",
    "",
    `- Verdict: **${report.verdict}**`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Scope: ${report.scope}`,
    `- Host: ${JSON.stringify(report.host)}`,
    "",
    "| Mode | Gates |",
    "| --- | --- |",
    ...rows,
    `| host baseline (diagnostic only) | ${state(report.hostBaseline.gate.passed)} (${report.hostBaseline.gate.verdict}) |`,
    "",
    "Host baseline does not affect the enabled/disabled sandbox gate verdict.",
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    "",
  ].join("\n");
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function capture(limit = CAPTURE_LIMIT) {
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const append = (which: "stdout" | "stderr", chunk: unknown) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const current = which === "stdout" ? stdout : stderr;
    const remaining = Math.max(0, limit - current.length);
    const next = current + text.slice(0, remaining);
    if (text.length > remaining) truncated = true;
    if (which === "stdout") stdout = next;
    else stderr = next;
  };
  return { stdout: () => stdout, stderr: () => stderr, truncated: () => truncated, append };
}

function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
  agentDir: string,
  darwinTemp: string,
): NodeJS.ProcessEnv {
  const allowedNames = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM"]);
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && allowedNames.has(name)) result[name] = value;
  }
  return {
    PATH: result.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    ...(result.LANG ? { LANG: result.LANG } : {}),
    ...(result.LC_ALL ? { LC_ALL: result.LC_ALL } : {}),
    ...(result.LC_CTYPE ? { LC_CTYPE: result.LC_CTYPE } : {}),
    ...(result.TERM ? { TERM: result.TERM } : {}),
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    TMPDIR: darwinTemp,
  };
}

function runBoundedFile(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 5_000,
): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 256 * 1024,
    env,
  }).trim();
}

function getDarwinTempDir(env: NodeJS.ProcessEnv): string {
  const value = runBoundedFile("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], env);
  const canonical = realpathSync(value);
  if (!statSync(canonical).isDirectory())
    throw new Error("DARWIN_USER_TEMP_DIR did not resolve to a directory.");
  return canonical;
}

function resolveChromium(candidate: string): { executable: string; appReadPath: string } {
  const executable = realpathSync(resolve(candidate));
  if (!statSync(executable).isFile())
    throw new Error(`Chromium executable is not a regular file: ${executable}`);
  accessSync(executable, fsConstants.X_OK);
  const pieces = executable.split(sep);
  const appIndex = pieces.findIndex((piece) => piece.endsWith(".app"));
  const appReadPath =
    appIndex >= 0 ? pieces.slice(0, appIndex + 1).join(sep) || sep : dirname(executable);
  return { executable, appReadPath };
}

export function buildResourceProbeSource(name: string, path: string): string {
  const success = `console.log('resource-allowed:${name}')`;
  const denied = `console.log('resource-denied:${name}:'+e.code)`;
  const failure = `console.log('resource-error:${name}:'+String(e.code||'unknown'));process.exitCode=2`;
  let operation: string;
  if (name === "darwin-temp-file") {
    operation = `fs.writeFileSync(p,'acceptance',{flag:'wx'});fs.unlinkSync(p);${success}`;
  } else if (name === "loopback-bind") {
    operation = `const s=net.createServer();s.once('error',e=>{if(['EPERM','EACCES'].includes(e.code)){${denied}}else{${failure}}});s.listen(0,'127.0.0.1',()=>s.close(()=>${success}))`;
  } else {
    operation = `const s=net.createServer();s.once('error',e=>{if(['EPERM','EACCES'].includes(e.code)){${denied}}else{${failure}}});s.listen(p,()=>s.close(()=>{try{fs.unlinkSync(p)}catch{};${success}}))`;
  }
  const source = `const fs=require('node:fs'),net=require('node:net'),p=${JSON.stringify(path)};try{${operation}}catch(e){if(['EPERM','EACCES'].includes(e.code)){${denied}}else{${failure}}}`;
  return source;
}

function buildResourceCommand(name: string, path: string): string {
  return `${quoteShell(process.execPath)} -e ${quoteShell(buildResourceProbeSource(name, path))}`;
}

function chromiumLaunchArgs(profile: string): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--dump-dom",
    "about:blank",
  ];
}

function chromiumLaunchCommand(chromium: string, profile: string): string {
  return [chromium, ...chromiumLaunchArgs(profile)].map(quoteShell).join(" ");
}

function runHostCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ExecResult> {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeWorker = child;
  const output = capture();
  child.stdout?.on("data", (chunk) => output.append("stdout", chunk));
  child.stderr?.on("data", (chunk) => output.append("stderr", chunk));
  const commandText = [command, ...args].map(quoteShell).join(" ");
  return new Promise((resolvePromise) => {
    let timedOut = false;
    let spawnError: string | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateOwnedGroup(child);
    }, timeoutMs);
    child.once("error", (error) => {
      spawnError = error.message;
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (!timedOut) cancelGroupTermination(child);
      if (activeWorker === child) activeWorker = undefined;
      resolvePromise({
        command: commandText,
        exitCode,
        stdout: output.stdout(),
        stderr: output.stderr(),
        outputTruncated: output.truncated(),
        outputStream: "direct host child stdout/stderr",
        ...(timedOut ? { timedOut: true } : {}),
        ...(spawnError ? { error: spawnError } : {}),
      });
    });
  });
}

async function runHostBaseline(
  chromium: string,
  dir: string,
  profile: string,
  env: NodeJS.ProcessEnv,
): Promise<HostBaseline> {
  assertSafeHost(process.platform, process.env.SANDBOX_RUNTIME);
  const version = await runHostCommand(chromium, ["--version"], dir, env, 10_000);
  const result = await runHostCommand(chromium, chromiumLaunchArgs(profile), dir, env, 30_000);
  return {
    version,
    result,
    gate: classifyHostBaseline(result),
    method:
      "diagnostic direct host spawn without the outer sandbox runtime; Chromium's own sandbox remains enabled",
  };
}

async function runSandboxCommand(
  ops: BashOperations,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<ExecResult> {
  const output = capture();
  try {
    const result = await ops.exec(command, cwd, {
      onData: (chunk) => output.append("stdout", chunk),
      timeout: timeoutSeconds,
      signal,
      env,
    });
    return {
      command,
      exitCode: result.exitCode,
      stdout: output.stdout(),
      stderr: output.stderr(),
      outputTruncated: output.truncated(),
      outputStream: "BashOperations onData merged stdout/stderr",
    };
  } catch (error) {
    return {
      command,
      exitCode: null,
      stdout: output.stdout(),
      stderr: output.stderr(),
      outputTruncated: output.truncated(),
      outputStream: "BashOperations onData merged stdout/stderr",
      timedOut: error instanceof Error && /timeout/i.test(error.message),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runWorker(
  mode: Mode,
  fixture: string,
  chromium: string,
  chromiumReadPath: string,
  tempPaths: Record<string, string>,
): Promise<WorkerResult> {
  const { SandboxManager } = await import("@carderne/sandbox-runtime");
  const { initializeSandbox, createSandboxedBashOps } = await import("../src/sandbox-runtime.ts");
  const dir = join(fixture, mode);
  const profile = join(dir, "profile");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const env = process.env;
  const config: SandboxConfig = {
    enabled: true,
    sandboxUserShell: false,
    allowBrowserProcess: mode === "enabled",
    allowPty: false,
    network: { allowedDomains: [], deniedDomains: [], allowUnauthenticatedSocksProxy: false },
    filesystem: {
      allowRead: [chromiumReadPath, dirname(process.execPath)],
      allowWrite: [dir],
      denyRead: ["/Users", "/home"],
      denyWrite: [],
    },
  };
  const allowances = { domains: [], readPaths: [], writePaths: [], unixSockets: [] };
  const result: WorkerResult = {
    mode,
    probes: [],
    gates: [],
    lifecycle: { initialize: "not started", reset: "not run" },
  };
  try {
    await initializeSandbox(config, allowances, dir);
    result.lifecycle.initialize = "passed";
    const ops = createSandboxedBashOps("/bin/bash");
    result.chromiumVersion = await runSandboxCommand(
      ops,
      `${quoteShell(chromium)} --version`,
      dir,
      env,
      10,
      controller.signal,
    );
    result.gates.push({
      name: "chromium-version",
      passed:
        result.chromiumVersion.exitCode === 0 && /Chromium/i.test(result.chromiumVersion.stdout),
      verdict:
        result.chromiumVersion.exitCode === 0
          ? "version command completed in sandbox"
          : "version command failed in sandbox",
    });

    const launchCommand = chromiumLaunchCommand(chromium, profile);
    result.browser = await runSandboxCommand(ops, launchCommand, dir, env, 30, controller.signal);
    result.gates.push(classifyBrowser(mode, result.browser));

    for (const [name, path] of Object.entries(tempPaths)) {
      const command = buildResourceCommand(name, path);
      const probe = await runSandboxCommand(ops, command, dir, env, 10, controller.signal);
      result.probes.push(probe);
      result.gates.push(classifyResourceProbe(mode, name, probe));
    }
  } catch (error) {
    result.failure = error instanceof Error ? error.message : String(error);
    result.gates.push({
      name: "runtime-initialize",
      passed: false,
      verdict: "actual sandbox runtime initialization or execution failed",
    });
  } finally {
    try {
      await SandboxManager.reset();
      result.lifecycle.reset = "passed";
    } catch (error) {
      result.lifecycle.reset = `failed: ${error instanceof Error ? error.message : String(error)}`;
      result.gates.push({
        name: "runtime-reset",
        passed: false,
        verdict: "actual SandboxManager.reset() failed",
      });
    }
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
  return result;
}

function workerMain(argv: string[]): void {
  const [, , , modeValue, fixture, chromium, chromiumReadPath, userTemp, token] = argv;
  if (
    (modeValue !== "enabled" && modeValue !== "disabled") ||
    !fixture ||
    !chromium ||
    !chromiumReadPath ||
    !userTemp ||
    !token
  ) {
    throw new Error("Invalid internal worker invocation.");
  }
  const mode = modeValue as Mode;
  const tempPaths = {
    "darwin-temp-file": join(userTemp, `pichr-${token}-${mode}-file`),
    "loopback-bind": "unused",
    "darwin-temp-unix-socket": join(userTemp, `pichr-${token}-${mode}-sock`),
  };
  if (Buffer.byteLength(tempPaths["darwin-temp-unix-socket"]) >= 100)
    throw new Error("Canonical Darwin temp path is too long for AF_UNIX acceptance probe.");
  void runWorker(mode, fixture, chromium, chromiumReadPath, tempPaths).then(
    (result) => console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`),
    (error) =>
      console.log(
        `${RESULT_PREFIX}${JSON.stringify({ mode, probes: [], gates: [{ name: "worker", passed: false, verdict: "worker failed" }], lifecycle: { initialize: "failed", reset: "unknown" }, failure: error instanceof Error ? error.message : String(error) } satisfies WorkerResult)}`,
      ),
  );
}

function isWorkerResult(value: unknown): value is WorkerResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<WorkerResult>;
  return (
    (result.mode === "enabled" || result.mode === "disabled") &&
    Array.isArray(result.probes) &&
    result.probes.every(
      (probe) =>
        probe &&
        typeof probe.command === "string" &&
        typeof probe.outputTruncated === "boolean" &&
        (probe.exitCode === null || typeof probe.exitCode === "number"),
    ) &&
    Array.isArray(result.gates) &&
    result.gates.every(
      (gate) =>
        gate &&
        typeof gate.name === "string" &&
        typeof gate.passed === "boolean" &&
        typeof gate.verdict === "string",
    ) &&
    Boolean(result.lifecycle) &&
    typeof result.lifecycle?.initialize === "string" &&
    typeof result.lifecycle?.reset === "string"
  );
}

function runWorkerProcess(
  mode: Mode,
  fixture: string,
  chromium: string,
  chromiumReadPath: string,
  userTemp: string,
  token: string,
  env: NodeJS.ProcessEnv,
): Promise<{ result: WorkerResult; timedOut: boolean; processOutput: string }> {
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptPath,
      "--worker",
      mode,
      fixture,
      chromium,
      chromiumReadPath,
      userTemp,
      token,
    ],
    {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  activeWorker = child;
  const output = capture(256 * 1024);
  child.stdout?.on("data", (chunk) => output.append("stdout", chunk));
  child.stderr?.on("data", (chunk) => output.append("stderr", chunk));
  return new Promise((resolvePromise) => {
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateOwnedGroup(child);
    }, WORKER_TIMEOUT_MS);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelGroupTermination(child);
      activeWorker = undefined;
      const allOutput = `${output.stdout()}\n${output.stderr()}`;
      const line = allOutput
        .split(/\r?\n/)
        .reverse()
        .find((value) => value.startsWith(RESULT_PREFIX));
      let result: WorkerResult;
      try {
        const decoded: unknown = line ? JSON.parse(line.slice(RESULT_PREFIX.length)) : undefined;
        if (line && !isWorkerResult(decoded)) throw new Error("Invalid worker result shape.");
        result = line
          ? (decoded as WorkerResult)
          : {
              mode,
              probes: [],
              gates: [
                {
                  name: "worker-process",
                  passed: false,
                  verdict: "bounded worker exited without a result",
                },
              ],
              lifecycle: { initialize: "unknown", reset: "unknown" },
              failure: `worker exit code ${String(code)}; ${output.stderr()}`,
            };
      } catch {
        result = {
          mode,
          probes: [],
          gates: [
            { name: "worker-process", passed: false, verdict: "worker returned malformed result" },
          ],
          lifecycle: { initialize: "unknown", reset: "unknown" },
        };
      }
      if (code !== 0) {
        result.gates.push({
          name: "worker-exit",
          passed: false,
          verdict: `worker exited with status ${String(code)}`,
        });
      }
      if (result.mode !== mode) {
        result.gates.push({
          name: "worker-result",
          passed: false,
          verdict: "worker result mode did not match requested mode",
        });
      }
      if (result.lifecycle?.initialize !== "passed" || result.lifecycle?.reset !== "passed") {
        result.gates.push({
          name: "worker-lifecycle",
          passed: false,
          verdict: "sandbox initialize and reset must both complete successfully",
        });
      }
      if (timedOut)
        result.gates.push({
          name: "worker-timeout",
          passed: false,
          verdict: "worker exceeded bounded lifecycle deadline",
        });
      resolvePromise({
        result,
        timedOut,
        processOutput: `${output.stderr()}${output.truncated() ? "\n[worker output truncated]" : ""}`,
      });
    };
    child.once("error", (error) => {
      if (!settled) {
        const result: WorkerResult = {
          mode,
          probes: [],
          gates: [{ name: "worker-process", passed: false, verdict: "worker could not start" }],
          lifecycle: { initialize: "not started", reset: "not run" },
          failure: error.message,
        };
        settled = true;
        clearTimeout(timer);
        cancelGroupTermination(child);
        activeWorker = undefined;
        resolvePromise({ result, timedOut: false, processOutput: "" });
      }
    });
    child.once("close", finish);
  });
}

let activeWorker: ChildProcess | undefined;
let requestedSignal: string | undefined;
const groupTerminationTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();

function cancelGroupTermination(child: ChildProcess): void {
  const timer = groupTerminationTimers.get(child);
  if (timer) clearTimeout(timer);
  groupTerminationTimers.delete(child);
}

function terminateOwnedGroup(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The owned process group may already have exited.
  }
  if (groupTerminationTimers.has(child)) return;
  const force = setTimeout(() => {
    groupTerminationTimers.delete(child);
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // The owned process group may already have exited.
    }
  }, 1_500);
  groupTerminationTimers.set(child, force);
  force.unref();
}

function signalHandler(signal: string): void {
  requestedSignal = signal;
  if (activeWorker) terminateOwnedGroup(activeWorker);
}

function cleanOwnedPath(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (info.isDirectory() && !info.isSymbolicLink()) rmSync(path, { recursive: true });
    else unlinkSync(path);
    return !existsSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return true;
    return false;
  }
}

function listChromiumPids(
  profile: string,
  chromiumExecutable: string,
  env: NodeJS.ProcessEnv,
): { pids: number[]; error?: string } {
  try {
    const listing = runBoundedFile("/bin/ps", ["-axo", "pid=,command="], env, 5_000);
    return { pids: ownedChromiumPids(listing, profile, chromiumExecutable) };
  } catch (error) {
    return { pids: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function cleanEscapedChromium(
  profile: string,
  chromiumExecutable: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  pidsDetected: number[];
  pidsSignalled: number[];
  remaining: number[];
  inspectionError?: string;
}> {
  const initial = listChromiumPids(profile, chromiumExecutable, env);
  const detected = initial.pids;
  const signalled: number[] = [];
  const inspectionErrors: string[] = initial.error ? [initial.error] : [];
  for (const pid of detected) {
    const current = listChromiumPids(profile, chromiumExecutable, env);
    if (current.error) inspectionErrors.push(current.error);
    if (current.error || !current.pids.includes(pid)) continue;
    try {
      process.kill(pid, "SIGTERM");
      signalled.push(pid);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
        signalled.push(pid);
    }
  }
  if (signalled.length) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  const finalScan = listChromiumPids(profile, chromiumExecutable, env);
  const stillPresent = finalScan.pids;
  if (finalScan.error) inspectionErrors.push(finalScan.error);
  for (const pid of stillPresent) {
    const current = listChromiumPids(profile, chromiumExecutable, env);
    if (current.error) inspectionErrors.push(current.error);
    if (current.error || !current.pids.includes(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
      if (!signalled.includes(pid)) signalled.push(pid);
    } catch {
      // It exited between inspection and the owned-PID signal.
    }
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  const lastScan = listChromiumPids(profile, chromiumExecutable, env);
  if (lastScan.error) inspectionErrors.push(lastScan.error);
  return {
    pidsDetected: detected,
    pidsSignalled: signalled,
    remaining: lastScan.pids,
    ...(inspectionErrors.length
      ? { inspectionError: [...new Set(inspectionErrors)].join("; ") }
      : {}),
  };
}

function makeProbePaths(userTemp: string, token: string, mode: Mode): Record<string, string> {
  return {
    "darwin-temp-file": join(userTemp, `pichr-${token}-${mode}-file`),
    "loopback-bind": "unused",
    "darwin-temp-unix-socket": join(userTemp, `pichr-${token}-${mode}-sock`),
  };
}

function packageVersion(root: string): string | undefined {
  try {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return packageJson.dependencies?.["@carderne/sandbox-runtime"];
  } catch {
    return undefined;
  }
}

function hostMetadata(
  root: string,
  env: NodeJS.ProcessEnv,
  chromium: string,
  darwinUserTempDir: string,
): Record<string, unknown> {
  const safeGit = (args: string[]) => {
    try {
      return runBoundedFile("/usr/bin/git", ["-C", root, ...args], env, 5_000);
    } catch (error) {
      return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return {
    platform: process.platform,
    osRelease: runBoundedFile("/usr/bin/sw_vers", ["-productVersion"], env),
    osBuild: runBoundedFile("/usr/bin/sw_vers", ["-buildVersion"], env),
    arch: process.arch,
    node: process.version,
    sandboxRuntime: packageVersion(root) ?? "unavailable",
    chromiumExecutable: chromium,
    darwinUserTempDir,
    gitCommit: safeGit(["rev-parse", "HEAD"]),
    gitBranchAndStatus: safeGit(["status", "--short", "--branch"]),
  };
}

function saveReport(path: string | undefined, report: AcceptanceReport, root: string): void {
  if (!path) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const ignoredTmp = realpathSync(join(root, "tmp"));
  const target = resolve(path);
  const parent = realpathSync(dirname(target));
  const relParent = relative(ignoredTmp, parent);
  if (relParent.startsWith(`..${sep}`) || relParent === ".." || isAbsolute(relParent)) {
    throw new Error(
      "--report must be saved under this repository's existing ignored tmp directory.",
    );
  }
  if (existsSync(target)) throw new Error(`Refusing to overwrite existing report: ${target}`);
  const contents = target.endsWith(".md")
    ? reportAsMarkdown(report)
    : `${JSON.stringify(report, null, 2)}\n`;
  const fd = requireOpenExclusive(target, contents);
  if (!fd) throw new Error(`Could not create report without overwrite: ${target}`);
  console.log(`Acceptance report saved: ${target}`);
}

function requireOpenExclusive(path: string, content: string): boolean {
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function parseCli(args: string[]): { chromium?: string; report?: string } {
  const options: { chromium?: string; report?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if ((option === "--chromium" || option === "--report") && value && !value.startsWith("--")) {
      if (option === "--chromium") options.chromium = value;
      else options.report = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete option: ${option}`);
    }
  }
  return options;
}

async function acceptanceMain(): Promise<number> {
  assertSafeHost(process.platform, process.env.SANDBOX_RUNTIME);
  const options = parseCli(process.argv.slice(2));
  const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const ignoredTmp = join(root, "tmp");
  if (
    !existsSync(ignoredTmp) ||
    !statSync(ignoredTmp).isDirectory() ||
    lstatSync(ignoredTmp).isSymbolicLink()
  ) {
    throw new Error(
      "Expected an existing real repository-local ignored tmp/ directory; no external fixture location is used.",
    );
  }
  if (realpathSync(ignoredTmp) !== ignoredTmp)
    throw new Error("Repository-local tmp/ must not resolve outside the checkout.");
  const chromium = resolveChromium(
    options.chromium ?? "/Applications/Chromium.app/Contents/MacOS/Chromium",
  );
  const fixture = mkdtempSync(join(ignoredTmp, "pi-chromium-acceptance-"));
  const token = randomUUID().replaceAll("-", "").slice(0, 16);
  const startedAt = new Date().toISOString();
  const cleanupFailures: string[] = [];
  let cleanupFailed = false;
  const warnings: string[] = [];
  const recordCleanupFailure = (message: string) => {
    cleanupFailed = true;
    if (!cleanupFailures.includes(message)) cleanupFailures.push(message);
    if (!warnings.includes(message)) warnings.push(message);
  };
  const cleanup: Record<string, unknown> = {
    fixtureRemoved: false,
    browserProcesses: [],
    tempArtifactsRemoved: [],
    finalBrowserProcesses: [],
    finalTempArtifactsRemoved: [],
    failures: cleanupFailures,
  };
  const modes: WorkerResult[] = [];
  let hostReport: Record<string, unknown> = { platform: process.platform, node: process.version };
  const reportCommands: Record<string, string> = {
    invocation: "pnpm exec tsx scripts/chromium-acceptance.ts",
    chromium: chromiumLaunchArgs("<disposable>").join(" "),
    resourceProbes:
      "Darwin user-temp file; ephemeral loopback bind; scoped Darwin user-temp AF_UNIX bind",
    hostTempLookup: "/usr/bin/getconf DARWIN_USER_TEMP_DIR",
  };
  let env: NodeJS.ProcessEnv = {};
  let userTemp = "";
  let fatalFailure = false;
  const baselineDir = join(fixture, "host-baseline");
  const baselineProfile = join(baselineDir, "profile");
  let baselineEnv: NodeJS.ProcessEnv = {};
  let hostBaseline: HostBaseline = {
    version: {
      command: chromium.executable,
      exitCode: null,
      stdout: "",
      stderr: "not run",
      outputTruncated: false,
      error: "host baseline was not run",
    },
    result: {
      command: chromium.executable,
      exitCode: null,
      stdout: "",
      stderr: "not run",
      outputTruncated: false,
      error: "host baseline was not run",
    },
    gate: { name: "host-baseline-launch", passed: false, verdict: "host baseline was not run" },
    method:
      "diagnostic direct host spawn without the outer sandbox runtime; Chromium's own sandbox remains enabled",
  };
  const modeDirs: Record<Mode, string> = {
    enabled: join(fixture, "enabled"),
    disabled: join(fixture, "disabled"),
  };
  try {
    for (const mode of ["enabled", "disabled"] as const) {
      mkdirSync(join(modeDirs[mode], "home"), { recursive: true, mode: 0o700 });
      mkdirSync(join(modeDirs[mode], "pi-agent"), { recursive: true, mode: 0o700 });
    }
    mkdirSync(join(baselineDir, "home"), { recursive: true, mode: 0o700 });
    mkdirSync(join(baselineDir, "pi-agent"), { recursive: true, mode: 0o700 });
    const bootstrapEnv = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: join(modeDirs.enabled, "home"),
    };
    userTemp = getDarwinTempDir(bootstrapEnv);
    env = sanitizedEnvironment(
      process.env,
      join(modeDirs.enabled, "home"),
      join(modeDirs.enabled, "pi-agent"),
      userTemp,
    );
    hostReport = hostMetadata(root, env, chromium.executable, userTemp);
    baselineEnv = sanitizedEnvironment(
      process.env,
      join(baselineDir, "home"),
      join(baselineDir, "pi-agent"),
      userTemp,
    );
    for (const mode of ["enabled", "disabled"] as const) {
      if (requestedSignal) throw new Error(`Interrupted by ${requestedSignal}.`);
      const modeEnv = sanitizedEnvironment(
        process.env,
        join(modeDirs[mode], "home"),
        join(modeDirs[mode], "pi-agent"),
        userTemp,
      );
      const workerRun = await runWorkerProcess(
        mode,
        fixture,
        chromium.executable,
        chromium.appReadPath,
        userTemp,
        token,
        modeEnv,
      );
      const modeResult = workerRun.result;
      if (workerRun.timedOut)
        warnings.push(
          `${mode} worker exceeded ${WORKER_TIMEOUT_MS}ms; lifecycle cleanup is unverified.`,
        );
      if (workerRun.processOutput.trim())
        warnings.push(`${mode} worker stderr: ${truncateOutput(workerRun.processOutput).text}`);
      const profile = join(modeDirs[mode], "profile");
      const processCleanup = await cleanEscapedChromium(profile, chromium.executable, modeEnv);
      (cleanup.browserProcesses as unknown[]).push({ mode, ...processCleanup });
      if (processCleanup.pidsDetected.length) {
        recordCleanupFailure(
          `Escaped Chromium process(es) detected for ${mode}: ${processCleanup.pidsDetected.join(",")}`,
        );
        modeResult.gates.push({
          name: "browser-cleanup",
          passed: false,
          verdict: `escaped Chromium process(es) detected and signalled: ${processCleanup.pidsDetected.join(",")}`,
        });
      }
      if (processCleanup.remaining.length) {
        recordCleanupFailure(
          `Owned Chromium PIDs remain for ${mode}: ${processCleanup.remaining.join(",")}`,
        );
        modeResult.gates.push({
          name: "browser-cleanup",
          passed: false,
          verdict: `escaped Chromium PIDs remain: ${processCleanup.remaining.join(",")}`,
        });
      }
      if (processCleanup.inspectionError) {
        recordCleanupFailure(
          `Chromium cleanup inspection failed for ${mode}: ${processCleanup.inspectionError}`,
        );
        modeResult.gates.push({
          name: "browser-cleanup-inspection",
          passed: false,
          verdict: "could not verify whether owned Chromium processes remain",
        });
      }
      const artifacts = makeProbePaths(userTemp, token, mode);
      const artifactCleanup = Object.entries(artifacts)
        .filter(([name]) => name !== "loopback-bind")
        .map(([name, path]) => ({ name, removed: cleanOwnedPath(path) }));
      (cleanup.tempArtifactsRemoved as unknown[]).push({ mode, artifacts: artifactCleanup });
      for (const item of artifactCleanup)
        if (!item.removed) {
          recordCleanupFailure(
            `Owned Darwin temp probe artifact could not be removed: ${item.name} (${mode})`,
          );
          modeResult.gates.push({
            name: `cleanup-${item.name}`,
            passed: false,
            verdict: "owned Darwin temp probe artifact could not be removed",
          });
        }
      if (workerRun.timedOut)
        modeResult.gates.push({
          name: "worker-timeout",
          passed: false,
          verdict: "bounded worker timeout is a failure",
        });
      modes.push(modeResult);
    }
    hostBaseline = await runHostBaseline(
      chromium.executable,
      baselineDir,
      baselineProfile,
      baselineEnv,
    );
    const baselineCleanup = await cleanEscapedChromium(
      baselineProfile,
      chromium.executable,
      baselineEnv,
    );
    cleanup.hostBaselineBrowserProcesses = baselineCleanup;
    if (baselineCleanup.pidsDetected.length)
      recordCleanupFailure(
        `Escaped Chromium process(es) detected for host baseline: ${baselineCleanup.pidsDetected.join(",")}`,
      );
    if (baselineCleanup.remaining.length)
      recordCleanupFailure(
        `Host baseline Chromium PIDs remain: ${baselineCleanup.remaining.join(",")}`,
      );
    if (baselineCleanup.inspectionError)
      recordCleanupFailure(
        `Host baseline Chromium cleanup inspection failed: ${baselineCleanup.inspectionError}`,
      );
  } catch (error) {
    fatalFailure = true;
    warnings.push(error instanceof Error ? error.message : String(error));
  } finally {
    try {
      if (userTemp) {
        if (baselineEnv.PATH) {
          const processes = await cleanEscapedChromium(
            baselineProfile,
            chromium.executable,
            baselineEnv,
          );
          cleanup.hostBaselineFinalBrowserProcesses = processes;
          if (processes.pidsDetected.length)
            recordCleanupFailure(
              `Host baseline Chromium processes remained to final cleanup: ${processes.pidsDetected.join(",")}`,
            );
          if (processes.remaining.length)
            recordCleanupFailure(
              `Host baseline Chromium processes remain after final cleanup: ${processes.remaining.join(",")}`,
            );
          if (processes.inspectionError)
            recordCleanupFailure(
              `Final host baseline Chromium cleanup inspection failed: ${processes.inspectionError}`,
            );
        }
        for (const mode of ["enabled", "disabled"] as const) {
          const artifactCleanup = Object.entries(makeProbePaths(userTemp, token, mode))
            .filter(([name]) => name !== "loopback-bind")
            .map(([name, path]) => ({ name, removed: cleanOwnedPath(path) }));
          (cleanup.finalTempArtifactsRemoved as unknown[]).push({
            mode,
            artifacts: artifactCleanup,
          });
          for (const item of artifactCleanup) {
            if (!item.removed)
              recordCleanupFailure(
                `Final removal failed for Darwin temp probe artifact ${item.name} (${mode})`,
              );
          }
          const modeEnv = sanitizedEnvironment(
            process.env,
            join(modeDirs[mode], "home"),
            join(modeDirs[mode], "pi-agent"),
            userTemp,
          );
          const processes = await cleanEscapedChromium(
            join(modeDirs[mode], "profile"),
            chromium.executable,
            modeEnv,
          );
          (cleanup.finalBrowserProcesses as unknown[]).push({ mode, ...processes });
          if (processes.pidsDetected.length)
            recordCleanupFailure(
              `Chromium processes remained to final cleanup for ${mode}: ${processes.pidsDetected.join(",")}`,
            );
          if (processes.remaining.length)
            recordCleanupFailure(
              `Chromium processes remain after final cleanup for ${mode}: ${processes.remaining.join(",")}`,
            );
          if (processes.inspectionError)
            recordCleanupFailure(
              `Final Chromium cleanup inspection failed for ${mode}: ${processes.inspectionError}`,
            );
        }
      }
    } catch (error) {
      recordCleanupFailure(
        `Final cleanup could not be completed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      cleanup.fixtureRemoved = cleanOwnedPath(fixture);
      if (!cleanup.fixtureRemoved)
        recordCleanupFailure("Owned project-local acceptance fixture could not be removed.");
      cleanup.failures = cleanupFailures;
    }
  }

  const report: AcceptanceReport = {
    schema: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict: acceptanceVerdict(
      modes,
      hostBaseline,
      cleanupFailed,
      Boolean(cleanup.fixtureRemoved),
      fatalFailure,
    ),
    scope:
      "Model-free, real sandbox-runtime initialize/reset and BashOperations Chromium/resource acceptance only; not full extension UI, interactive prompt, or model acceptance.",
    host: hostReport,
    commands: reportCommands,
    modes,
    hostBaseline,
    cleanup,
    warnings,
  };
  if (
    report.modes.some((mode) =>
      [mode.chromiumVersion, mode.browser, ...mode.probes].some((item) => item?.outputTruncated),
    ) ||
    report.hostBaseline.version.outputTruncated ||
    report.hostBaseline.result.outputTruncated
  )
    report.warnings.push(
      "One or more subprocess outputs were truncated; inspect outputTruncated flags.",
    );
  saveReport(options.report, report, root);
  return report.verdict === "PASS" ? 0 : 1;
}

function isMain(): boolean {
  return Boolean(
    process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url,
  );
}

if (isMain()) {
  const isWorker = process.argv[2] === "--worker";
  try {
    assertSafeHost(process.platform, process.env.SANDBOX_RUNTIME);
    if (isWorker) workerMain(process.argv);
    else {
      process.on("SIGINT", () => signalHandler("SIGINT"));
      process.on("SIGTERM", () => signalHandler("SIGTERM"));
      void acceptanceMain().then(
        (code) => {
          process.exitCode = requestedSignal ? 1 : code;
        },
        (error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        },
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
