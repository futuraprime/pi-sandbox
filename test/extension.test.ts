import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { mock } from "node:test";

import { SandboxManager } from "@carderne/sandbox-runtime";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, type SandboxConfig } from "../src/config.ts";
import { renderDiagnosticBlockData, type SandboxDiagnosticBlockData } from "../src/diagnostics.ts";
import extension from "../src/extension.ts";
import { getVolumeCaseSensitivity } from "../src/path-security.ts";
import {
  gitUpstreamMutationCommands,
  nonGitUpstreamMutationCommands,
} from "./git-upstream-command-fixtures.ts";

type StatusUpdate = { key: string; value: string | undefined };

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function makePi(options: { noSandbox?: boolean } = {}) {
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any>>();
  const tools = new Map<string, any>();
  const shortcuts: unknown[] = [];
  const sentMessages: Array<{ customType: string; content: string; display: boolean }> = [];
  const pi = {
    registerFlag: () => undefined,
    getFlag: (name: string) => name === "no-sandbox" && options.noSandbox === true,
    registerTool: (definition: { name: string }) => {
      tools.set(definition.name, definition);
    },
    registerShortcut: (shortcut: unknown) => {
      shortcuts.push(shortcut);
    },
    registerCommand: (
      name: string,
      definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => {
      commands.set(name, definition.handler);
    },
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any>) => {
      handlers.set(name, handler);
    },
    sendMessage: (message: { customType: string; content: string; display: boolean }) => {
      sentMessages.push(message);
    },
    events: { emit: () => undefined },
  } as unknown as ExtensionAPI;
  return { pi, commands, handlers, tools, shortcuts, sentMessages };
}

function makeProjectTempDirectory(prefix: string): string {
  return mkdtempSync(join(process.cwd(), `.pi-sandbox-${prefix}-`));
}

function makePromptTestConfig(): SandboxConfig {
  return {
    ...DEFAULT_CONFIG,
    network: {
      ...DEFAULT_CONFIG.network!,
      allowedDomains: [],
      deniedDomains: [],
    },
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      allowRead: [],
      allowWrite: [],
      denyRead: [],
      denyWrite: [],
    },
  };
}

function allowSshTestDomain(root: string): void {
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "sandbox.json"),
    JSON.stringify({ network: { allowedDomains: ["host"] } }),
  );
}

function makeGitUpstreamFixture(): string {
  const repository = makeProjectTempDirectory("git-upstream-extension");
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "Test User"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["commit", "--allow-empty", "-m", "initial"]);
  git(repository, ["remote", "add", "origin", join(repository, "remote")]);
  git(repository, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return repository;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeLinkedWorktreeFixture(): {
  firstRepository: string;
  secondRepository: string;
  first: string;
  second: string;
  sibling: string;
  firstCommonDir: string;
  secondCommonDir: string;
} {
  const firstRepository = makeProjectTempDirectory("linked-worktree-first");
  const secondRepository = makeProjectTempDirectory("linked-worktree-second");
  for (const repository of [firstRepository, secondRepository]) {
    git(repository, ["init", "-q", "-b", "main"]);
    git(repository, ["config", "user.name", "Test User"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["commit", "--allow-empty", "-m", "initial"]);
  }
  const first = join(firstRepository, "first-worktree");
  const second = join(secondRepository, "second-worktree");
  const sibling = join(secondRepository, "sibling-worktree");
  git(firstRepository, ["worktree", "add", "--detach", first, "HEAD"]);
  git(secondRepository, ["worktree", "add", "--detach", second, "HEAD"]);
  git(secondRepository, ["worktree", "add", "--detach", sibling, "HEAD"]);
  writeFileSync(join(first, "old-worktree.txt"), "old worktree");
  writeFileSync(join(secondRepository, "original-checkout.txt"), "original checkout");
  writeFileSync(join(sibling, "sibling-worktree.txt"), "sibling worktree");
  return {
    firstRepository,
    secondRepository,
    first,
    second,
    sibling,
    firstCommonDir: realpathSync(join(firstRepository, ".git")),
    secondCommonDir: realpathSync(join(secondRepository, ".git")),
  };
}

function makeContext(
  cwd: string,
  notices: string[],
  statusUpdates: StatusUpdate[] = [],
): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: (key: string, value: string | undefined) => statusUpdates.push({ key, value }),
      theme: { fg: (_colour: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
}

function makeStaleContext(): ExtensionContext {
  return {
    get cwd(): string {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
    get ui(): never {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
  } as unknown as ExtensionContext;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stripOrdinarySshEnvironmentPrefix(command: string): string {
  const prefix = "unset GIT_SSH_COMMAND; ";
  assert.ok(command.startsWith(prefix), `expected ordinary-command environment prefix: ${command}`);
  return command.slice(prefix.length);
}

function blockedWriteCommand(path: string, nested = false): string {
  const failure = `printf 'bash: line 1: ${path}: Operation not permitted\\n' >&2; exit 1`;
  return nested ? `bash -c ${shellQuote(failure)}` : failure;
}

test("extension retains explicit sandbox commands without registering a toggle shortcut", () => {
  const { pi, commands, shortcuts } = makePi();
  extension(pi);

  assert.deepEqual(shortcuts, []);
  assert.equal(commands.has("sandbox-enable"), true);
  assert.equal(commands.has("sandbox-disable"), true);
});

test("extension wires pending, enabled, disabled, and shutdown statuses", async () => {
  const root = makeProjectTempDirectory("extension-status");
  const statusUpdates: StatusUpdate[] = [];
  const initialized: string[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    assert.deepEqual(statusUpdates.at(-1), { key: "sandbox", value: "ꗃ" });
    initialized.push("initialize");
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);

  try {
    const { pi, commands, handlers } = makePi();
    extension(pi);
    const ctx = makeContext(root, [], statusUpdates);

    await handlers.get("session_start")?.({}, ctx);
    assert.equal(initialized.length, 1);
    assert.deepEqual(statusUpdates, [
      { key: "sandbox", value: "ꗃ" },
      { key: "sandbox", value: "🔒" },
    ]);

    await handlers.get("session_start")?.({}, ctx);
    assert.deepEqual(statusUpdates.slice(-2), [
      { key: "sandbox", value: "ꗃ" },
      { key: "sandbox", value: "🔒" },
    ]);

    await commands.get("sandbox-disable")?.("", ctx);
    assert.deepEqual(statusUpdates.at(-1), { key: "sandbox", value: "ꗃ" });

    await handlers.get("session_shutdown")?.({}, ctx);
    assert.deepEqual(statusUpdates.at(-1), { key: "sandbox", value: undefined });
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension reports disabled status for --no-sandbox and config", async () => {
  const flagRoot = makeProjectTempDirectory("extension-status-flag");
  const configRoot = makeProjectTempDirectory("extension-status-config");
  mkdirSync(join(configRoot, ".pi"));
  writeFileSync(join(configRoot, ".pi", "sandbox.json"), JSON.stringify({ enabled: false }));

  try {
    const flagStatuses: StatusUpdate[] = [];
    const flag = makePi({ noSandbox: true });
    extension(flag.pi);
    const flagContext = makeContext(flagRoot, [], flagStatuses);
    await flag.handlers.get("session_start")?.({}, flagContext);
    assert.deepEqual(flagStatuses, [
      { key: "sandbox", value: "ꗃ" },
      { key: "sandbox", value: "ꗃ" },
    ]);

    const configStatuses: StatusUpdate[] = [];
    const config = makePi();
    extension(config.pi);
    const configContext = makeContext(configRoot, [], configStatuses);
    await config.handlers.get("session_start")?.({}, configContext);
    assert.deepEqual(configStatuses, [
      { key: "sandbox", value: "ꗃ" },
      { key: "sandbox", value: "ꗃ" },
    ]);
  } finally {
    rmSync(flagRoot, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test("extension reports unsupported status without initializing", async () => {
  const root = makeProjectTempDirectory("extension-status-unsupported");
  const statuses: StatusUpdate[] = [];
  const notices: string[] = [];

  try {
    const { pi, handlers } = makePi();
    extension(pi, { platform: "aix" });
    const ctx = makeContext(root, notices, statuses);
    await handlers.get("session_start")?.({}, ctx);
    assert.deepEqual(statuses, [
      { key: "sandbox", value: "ꗃ" },
      { key: "sandbox", value: "ꗃ" },
    ]);
    assert.match(notices.at(-1) ?? "", /not supported on aix/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension reports an initialization error after pending status", async () => {
  const root = makeProjectTempDirectory("extension-status-error");
  const statusUpdates: StatusUpdate[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    assert.deepEqual(statusUpdates.at(-1), { key: "sandbox", value: "ꗃ" });
    throw new Error("test initialization failure");
  });

  try {
    const { pi, handlers } = makePi();
    extension(pi);
    const notices: string[] = [];
    const ctx = makeContext(root, notices, statusUpdates);

    await handlers.get("session_start")?.({}, ctx);
    assert.deepEqual(statusUpdates, [
      { key: "sandbox", value: "ꗃ" },
      { key: "sandbox", value: "ꗃ" },
    ]);
    assert.match(notices.at(-1) ?? "", /initialization failed/);

    await handlers.get("session_shutdown")?.({}, ctx);
    assert.deepEqual(statusUpdates.at(-1), { key: "sandbox", value: undefined });
  } finally {
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown invalidates a stale session_start success and keeps Bash fail-closed", async () => {
  const root = makeProjectTempDirectory("stale-start-shutdown-success");
  mkdirSync(join(root, ".pi"));
  writeFileSync(
    join(root, ".pi", "sandbox.json"),
    JSON.stringify({ network: { allowedDomains: ["*"] } }),
  );
  const marker = join(root, "must-not-run");
  const statusUpdates: StatusUpdate[] = [];
  const notices: string[] = [];
  const initializeStarted = deferred<void>();
  const initializeFinished = deferred<void>();
  const resetCalls: string[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    initializeStarted.resolve(undefined);
    await initializeFinished.promise;
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resetCalls.push("reset");
  });

  try {
    const { pi, handlers, tools, sentMessages } = makePi();
    extension(pi);
    const ctx = makeContext(root, notices, statusUpdates);
    const startHandler = handlers.get("session_start");
    assert.ok(startHandler);

    const startPromise = startHandler({}, ctx);
    await initializeStarted.promise;
    await handlers.get("session_shutdown")?.({}, ctx);
    const statusAfterShutdown = [...statusUpdates];
    const noticesAfterShutdown = [...notices];

    assert.deepEqual(statusAfterShutdown, [
      { key: "sandbox", value: "ꗃ" },
      { key: "sandbox", value: undefined },
    ]);
    assert.equal(resetCalls.length, 0);

    initializeFinished.resolve(undefined);
    await startPromise;
    await startHandler({}, makeStaleContext());

    assert.deepEqual(statusUpdates, statusAfterShutdown);
    assert.deepEqual(notices, noticesAfterShutdown);
    assert.equal(sentMessages.length, 0);
    assert.equal(resetCalls.length, 1);

    const bash = tools.get("bash");
    assert.ok(bash);
    await assert.rejects(
      bash.execute(
        "stale-shutdown-success",
        { command: `printf stale > ${marker}` },
        undefined,
        undefined,
        ctx,
      ),
      /command execution remains blocked/,
    );
    assert.equal(existsSync(marker), false);

    const userBash = await handlers.get("user_bash")?.(
      { command: "printf stale", excludeFromContext: false },
      ctx,
    );
    assert.equal(userBash?.result?.exitCode, 1);
    assert.equal(userBash?.operations, undefined);
    assert.deepEqual(
      await handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "printf stale" } },
        ctx,
      ),
      {
        block: true,
        reason: "Sandbox is not ready; command execution remains blocked.",
      },
    );
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown invalidates a stale session_start failure without changing status", async () => {
  const root = makeProjectTempDirectory("stale-start-shutdown-failure");
  const statusUpdates: StatusUpdate[] = [];
  const notices: string[] = [];
  const initializeStarted = deferred<void>();
  const initializeFinished = deferred<void>();
  const resetCalls: string[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    initializeStarted.resolve(undefined);
    await initializeFinished.promise;
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resetCalls.push("reset");
  });

  try {
    const { pi, handlers, sentMessages } = makePi();
    extension(pi);
    const ctx = makeContext(root, notices, statusUpdates);
    const startHandler = handlers.get("session_start");
    assert.ok(startHandler);

    const startPromise = startHandler({}, ctx);
    await initializeStarted.promise;
    await handlers.get("session_shutdown")?.({}, ctx);
    const statusAfterShutdown = [...statusUpdates];
    const noticesAfterShutdown = [...notices];

    initializeFinished.reject(new Error("stale initialization failure"));
    await startPromise;
    await startHandler({}, makeStaleContext());

    assert.deepEqual(statusUpdates, statusAfterShutdown);
    assert.deepEqual(notices, noticesAfterShutdown);
    assert.equal(sentMessages.length, 0);
    assert.equal(resetCalls.length, 1);
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown does not clear a replacement runtime after deferred reset", async () => {
  const firstRoot = makeProjectTempDirectory("deferred-shutdown-reset-first");
  const secondRoot = makeProjectTempDirectory("deferred-shutdown-reset-second");
  const statusUpdates: StatusUpdate[] = [];
  const notices: string[] = [];
  const resetStarted = deferred<void>();
  const resetFinished = deferred<void>();
  let resetCalls = 0;
  let initializeCalls = 0;
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    initializeCalls += 1;
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resetCalls += 1;
    if (resetCalls === 1) {
      resetStarted.resolve(undefined);
      await resetFinished.promise;
    }
  });

  try {
    const { pi, handlers } = makePi();
    extension(pi);
    const firstContext = makeContext(firstRoot, notices, statusUpdates);
    const secondContext = makeContext(secondRoot, notices, statusUpdates);
    await handlers.get("session_start")?.({}, firstContext);

    const shutdown = handlers.get("session_shutdown");
    const start = handlers.get("session_start");
    assert.ok(shutdown);
    assert.ok(start);
    const shutdownPromise = shutdown({}, firstContext);
    await resetStarted.promise;

    // Replacement initialization waits for the old shutdown reset. Starting
    // it concurrently must not allow the deferred reset to tear it down.
    const replacementStart = start({}, secondContext);
    assert.equal(initializeCalls, 1);
    assert.equal(resetCalls, 1);

    resetFinished.resolve(undefined);
    await shutdownPromise;
    await replacementStart;
    const statusAfterReplacement = [...statusUpdates];
    assert.equal(initializeCalls, 2);
    assert.equal(resetCalls, 2);

    assert.deepEqual(statusUpdates, statusAfterReplacement);

    await shutdown({}, secondContext);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resetCalls, 3);
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("a stale session_start success cannot overwrite a replacement runtime", async () => {
  const firstRoot = makeProjectTempDirectory("stale-start-replacement-success-first");
  const secondRoot = makeProjectTempDirectory("stale-start-replacement-success-second");
  for (const root of [firstRoot, secondRoot]) {
    mkdirSync(join(root, ".pi"));
    writeFileSync(
      join(root, ".pi", "sandbox.json"),
      JSON.stringify({ network: { allowedDomains: ["*"] } }),
    );
  }
  const statusUpdates: StatusUpdate[] = [];
  const notices: string[] = [];
  const initializeStarted = [deferred<void>(), deferred<void>()];
  const initializeFinished = [deferred<void>(), deferred<void>()];
  let initializeCalls = 0;
  const resetCalls: string[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    const index = initializeCalls;
    initializeCalls += 1;
    initializeStarted[index]?.resolve(undefined);
    if (initializeFinished[index]) await initializeFinished[index].promise;
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resetCalls.push("reset");
  });
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => "printf replacement");

  try {
    const { pi, handlers, tools, sentMessages } = makePi();
    extension(pi);
    const firstContext = makeContext(firstRoot, notices, statusUpdates);
    const secondContext = makeContext(secondRoot, notices, statusUpdates);
    const startHandler = handlers.get("session_start");
    assert.ok(startHandler);

    const staleStart = startHandler({}, firstContext);
    await initializeStarted[0].promise;
    const replacementStart = startHandler({}, secondContext);

    // The replacement is queued behind the stale manager operation. Its
    // completion must be ignored before the replacement can claim readiness.
    initializeFinished[0].resolve(undefined);
    await staleStart;
    await initializeStarted[1].promise;
    initializeFinished[1].resolve(undefined);
    await replacementStart;
    const statusAfterReplacement = [...statusUpdates];
    const noticesAfterReplacement = [...notices];
    const messagesAfterReplacement = [...sentMessages];

    // This calls the registered extension handler with the old context after
    // the replacement has claimed ownership; it must be a no-op.
    await startHandler({}, makeStaleContext());
    assert.deepEqual(statusUpdates, statusAfterReplacement);
    assert.deepEqual(notices, noticesAfterReplacement);
    assert.deepEqual(sentMessages, messagesAfterReplacement);

    assert.deepEqual(statusUpdates, statusAfterReplacement);
    assert.deepEqual(notices, noticesAfterReplacement);
    assert.deepEqual(sentMessages, messagesAfterReplacement);

    const bash = tools.get("bash");
    assert.ok(bash);
    const result = await bash.execute(
      "replacement-cwd",
      { command: "printf replacement" },
      undefined,
      undefined,
      secondContext,
    );
    assert.equal(initializeCalls, 2);
    assert.equal(wrapMock.mock.callCount(), 1);
    assert.equal((result.content[0] as { text: string }).text, "replacement");
    assert.equal(resetCalls.length, 1);

    await handlers.get("session_shutdown")?.({}, secondContext);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resetCalls.length, 2);
  } finally {
    wrapMock.mock.restore();
    managerMock.mock.restore();
    resetMock.mock.restore();
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("a stale session_start failure cannot overwrite a replacement runtime", async () => {
  const firstRoot = makeProjectTempDirectory("stale-start-replacement-failure-first");
  const secondRoot = makeProjectTempDirectory("stale-start-replacement-failure-second");
  for (const root of [firstRoot, secondRoot]) {
    mkdirSync(join(root, ".pi"));
    writeFileSync(
      join(root, ".pi", "sandbox.json"),
      JSON.stringify({ network: { allowedDomains: ["*"] } }),
    );
  }
  const statusUpdates: StatusUpdate[] = [];
  const notices: string[] = [];
  const initializeStarted = [deferred<void>(), deferred<void>()];
  const initializeFinished = [deferred<void>(), deferred<void>()];
  let initializeCalls = 0;
  const resetCalls: string[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    const index = initializeCalls;
    initializeCalls += 1;
    initializeStarted[index]?.resolve(undefined);
    if (initializeFinished[index]) await initializeFinished[index].promise;
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resetCalls.push("reset");
  });

  try {
    const { pi, handlers, sentMessages } = makePi();
    extension(pi);
    const firstContext = makeContext(firstRoot, notices, statusUpdates);
    const secondContext = makeContext(secondRoot, notices, statusUpdates);
    const startHandler = handlers.get("session_start");
    assert.ok(startHandler);

    const staleStart = startHandler({}, firstContext);
    await initializeStarted[0].promise;
    const replacementStart = startHandler({}, secondContext);

    initializeFinished[0].reject(new Error("stale replacement failure"));
    await staleStart;
    await initializeStarted[1].promise;
    initializeFinished[1].resolve(undefined);
    await replacementStart;
    const statusAfterReplacement = [...statusUpdates];
    const noticesAfterReplacement = [...notices];
    const messagesAfterReplacement = [...sentMessages];

    await startHandler({}, makeStaleContext());
    assert.deepEqual(statusUpdates, statusAfterReplacement);
    assert.deepEqual(notices, noticesAfterReplacement);
    assert.deepEqual(sentMessages, messagesAfterReplacement);

    assert.deepEqual(statusUpdates, statusAfterReplacement);
    assert.deepEqual(notices, noticesAfterReplacement);
    assert.deepEqual(sentMessages, messagesAfterReplacement);
    assert.equal(resetCalls.length, 1);
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("/sandbox is display-only and /sandbox-allow persists an edited, confirmed project rule", async () => {
  const root = makeProjectTempDirectory("sandbox-allow-command");
  const agentDir = join(root, "global-agent");
  const configPath = join(root, ".pi", "sandbox.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ enabled: false, network: { deniedDomains: ["blocked.example"] } }),
  );
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const initialised: string[] = [];
  const resets: string[] = [];
  const notices: string[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    initialised.push("initialize");
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resets.push("reset");
  });

  try {
    const { pi, commands, handlers } = makePi();
    extension(pi, { configLoader: () => makePromptTestConfig() });
    const ctx = makeContext(root, notices);
    let component: any;
    (ctx.ui as any).custom = <T>(factory: any): Promise<T> =>
      new Promise<T>((resolve) => {
        component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (value: T) => {
            component?.dispose?.();
            resolve(value);
          },
        );
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput("\t");
        for (let index = 0; index < 200; index += 1) component.handleInput("\x7f");
        component.handleInput("packages/widget");
        component.handleInput("\r");
        component.handleInput("\r");
      });

    assert.equal(commands.has("sandbox-allow"), true);
    await handlers.get("session_start")?.({}, ctx);

    await commands.get("sandbox")?.("allowRead ./must-not-be-written", ctx);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      enabled: false,
      network: { deniedDomains: ["blocked.example"] },
    });
    assert.equal(resets.length, 0);
    assert.match(notices.at(-1) ?? "", /Usage: \/sandbox$/);

    const target = join(root, "packages", "widget", "src", "index.ts");
    await commands.get("sandbox-allow")?.(`read ${target}`, ctx);

    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      enabled: false,
      network: { deniedDomains: ["blocked.example"] },
      filesystem: { allowRead: ["packages/widget"] },
    });
    assert.equal(existsSync(join(agentDir, "sandbox.json")), false);
    assert.equal(resets.length, 1);
    assert.equal(initialised.length, 2);
    assert.ok(component);

    await commands.get("sandbox")?.("", ctx);
    assert.match(notices.at(-1) ?? "", /Sandbox Configuration/);
    assert.equal(resets.length, 1);
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("/sandbox-allow uses session, project-relative, and canonical global persistence", async () => {
  const root = makeProjectTempDirectory("sandbox-allow-scopes");
  const globalTargetRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-allow-global-"));
  const agentDir = join(root, "global-agent");
  const projectPath = join(root, ".pi", "sandbox.json");
  const globalPath = join(agentDir, "sandbox.json");
  mkdirSync(dirname(projectPath), { recursive: true });
  mkdirSync(dirname(globalPath), { recursive: true });
  writeFileSync(
    projectPath,
    JSON.stringify({ enabled: false, network: { allowedDomains: ["existing.example"] } }),
  );
  writeFileSync(
    globalPath,
    JSON.stringify({ network: { deniedDomains: ["blocked.example"], allowLocalBinding: true } }),
  );
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const initialised: string[] = [];
  const resets: string[] = [];
  const notices: string[] = [];
  const initializeMock = mock.method(SandboxManager, "initialize", async () => {
    initialised.push("initialize");
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resets.push("reset");
  });

  try {
    const { pi, commands, handlers } = makePi();
    extension(pi, { configLoader: () => makePromptTestConfig() });
    const ctx = makeContext(root, notices);
    let nextScope: "session" | "project" | "global" = "session";
    (ctx.ui as any).custom = <T>(factory: any): Promise<T> =>
      new Promise<T>((resolve) => {
        let component: any;
        component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (value: T) => {
            component?.dispose?.();
            resolve(value);
          },
        );
        if (nextScope === "session") {
          component.handleInput("s");
          return;
        }
        if (nextScope === "project") {
          component.handleInput("\x1b[B");
          component.handleInput("\x1b[B");
          component.handleInput("\t");
          for (let index = 0; index < 200; index += 1) component.handleInput("\x7f");
          component.handleInput("packages/widget");
          component.handleInput("\r");
          component.handleInput("\r");
          return;
        }
        component.handleInput("A");
        component.handleInput("\r");
      });

    await handlers.get("session_start")?.({}, ctx);
    await commands.get("sandbox-allow")?.("domain api.example.test", ctx);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), true);
    assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")), {
      enabled: false,
      network: { allowedDomains: ["existing.example"] },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), {
      network: { deniedDomains: ["blocked.example"], allowLocalBinding: true },
    });
    await commands.get("sandbox")?.("", ctx);
    assert.match(notices.at(-1) ?? "", /Session allowed: api.example.test/);

    nextScope = "project";
    await commands.get("sandbox-allow")?.(
      `read ${join(root, "packages", "widget", "src", "index.ts")}`,
      ctx,
    );
    assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")), {
      enabled: false,
      network: { allowedDomains: ["existing.example"] },
      filesystem: { allowRead: ["packages/widget"] },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), {
      network: { deniedDomains: ["blocked.example"], allowLocalBinding: true },
    });

    nextScope = "global";
    const globalTarget = join(globalTargetRoot, "output.txt");
    await commands.get("sandbox-allow")?.(`write ${globalTarget}`, ctx);
    assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), {
      network: { deniedDomains: ["blocked.example"], allowLocalBinding: true },
      filesystem: { allowWrite: [join(realpathSync(globalTargetRoot), "output.txt")] },
    });
    assert.equal(resets.length, 3);
    assert.equal(initialised.length, 4);
  } finally {
    initializeMock.mock.restore();
    resetMock.mock.restore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
    rmSync(globalTargetRoot, { recursive: true, force: true });
  }
});

test("/sandbox-allow reports when a failed refresh rolls back a session grant", async () => {
  const root = makeProjectTempDirectory("sandbox-allow-session-refresh-failure");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "global-agent");
  const notices: string[] = [];
  let initializeCount = 0;
  const initializeMock = mock.method(SandboxManager, "initialize", async () => {
    initializeCount += 1;
    if (initializeCount === 2) throw new Error("test refresh failure");
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);

  try {
    const { pi, commands, handlers } = makePi();
    extension(pi, { configLoader: () => makePromptTestConfig() });
    const ctx = makeContext(root, notices);
    (ctx.ui as any).custom = <T>(factory: any): Promise<T> =>
      new Promise<T>((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          resolve,
        );
        component.handleInput("s");
      });

    await handlers.get("session_start")?.({}, ctx);
    await commands.get("sandbox-allow")?.("read /tmp/rolled-back", ctx);

    assert.equal(initializeCount, 3);
    assert.equal(resetMock.mock.callCount(), 1);
    assert.match(notices.at(-1) ?? "", /Session permission was rolled back/i);
    assert.doesNotMatch(notices.at(-1) ?? "", /permission was persisted/i);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);

    await commands.get("sandbox")?.("", ctx);
    assert.doesNotMatch(notices.at(-1) ?? "", /rolled-back/);
  } finally {
    initializeMock.mock.restore();
    resetMock.mock.restore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("/sandbox-allow validates kinds and targets and safely aborts without UI or on timeout", async () => {
  const root = makeProjectTempDirectory("sandbox-allow-abort");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "global-agent");
  const notices: string[] = [];
  let initializeCount = 0;
  let resetCount = 0;
  let customCount = 0;
  let promptBehavior: "abort" | "timeout" = "timeout";
  const initializeMock = mock.method(SandboxManager, "initialize", async () => {
    initializeCount += 1;
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resetCount += 1;
  });

  try {
    const { pi, commands, handlers } = makePi();
    const config = { ...makePromptTestConfig(), permissionPromptTimeoutSeconds: 0.01 };
    extension(pi, { configLoader: () => config });
    const ctx = makeContext(root, notices);
    (ctx.ui as any).custom = <T>(factory: any): Promise<T> =>
      new Promise<T>((resolve) => {
        customCount += 1;
        let component: any;
        component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (value: T) => {
            component?.dispose?.();
            resolve(value);
          },
        );
        if (promptBehavior === "abort") component.handleInput("\x1b");
      });
    await handlers.get("session_start")?.({}, ctx);
    const beforePrompt = { initializeCount, resetCount };

    await commands.get("sandbox-allow")?.("denyRead /tmp/blocked", ctx);
    await commands.get("sandbox-allow")?.("domain https://example.com/path", ctx);
    await commands.get("sandbox-allow")?.("read /tmp/*", ctx);
    assert.equal(customCount, 0);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);

    promptBehavior = "abort";
    await commands.get("sandbox-allow")?.("read /tmp/abort", ctx);
    assert.equal(customCount, 1);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);

    (ctx as any).hasUI = false;
    await commands.get("sandbox-allow")?.("read /tmp/no-ui", ctx);
    assert.equal(customCount, 1);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);
    (ctx as any).hasUI = true;

    promptBehavior = "timeout";
    await commands.get("sandbox-allow")?.("read /tmp/timeout", ctx);
    assert.equal(customCount, 2);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);
    assert.equal(existsSync(join(root, "global-agent", "sandbox.json")), false);
    assert.deepEqual({ initializeCount, resetCount }, beforePrompt);
    assert.equal(
      notices.some((message) => /Usage: \/sandbox-allow/.test(message)),
      true,
    );
  } finally {
    initializeMock.mock.restore();
    resetMock.mock.restore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("equivalent prior runtime restoration remains executable", async () => {
  const root = makeProjectTempDirectory("equivalent-restoration");
  const config = makePromptTestConfig();
  let initializeCount = 0;
  const initializeMock = mock.method(SandboxManager, "initialize", async () => {
    initializeCount += 1;
    if (initializeCount === 2) throw new Error("transient replacement failure");
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => "printf restored");

  try {
    const { pi, commands, handlers, tools } = makePi();
    extension(pi, { configLoader: () => config });
    const ctx = makeContext(root, []);
    (ctx.ui as any).custom = <T>(factory: any): Promise<T> =>
      new Promise<T>((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          resolve,
        );
        component.handleInput("P");
        component.handleInput("\r");
      });
    await handlers.get("session_start")?.({}, ctx);

    // The loader keeps the effective policy equivalent while the sanctioned
    // approval writer still exercises the replacement lifecycle.
    await commands.get("sandbox-allow")?.(`read ${join(root, "equivalent")}`, ctx);
    assert.equal(initializeCount, 3);
    assert.equal(resetMock.mock.callCount(), 1);

    const bash = tools.get("bash");
    assert.ok(bash);
    const result = await bash.execute(
      "equivalent-restored",
      { command: "printf local" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(wrapMock.mock.callCount(), 1);
    assert.match((result.content[0] as { text: string }).text, /restored/);
  } finally {
    wrapMock.mock.restore();
    initializeMock.mock.restore();
    resetMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy-different restoration stays unavailable until explicit recovery", async () => {
  const root = makeProjectTempDirectory("policy-different-restoration");
  const statusUpdates: StatusUpdate[] = [];
  const notices: string[] = [];
  let initializeCount = 0;
  const initializeMock = mock.method(SandboxManager, "initialize", async () => {
    initializeCount += 1;
    if (initializeCount === 2) throw new Error("replacement policy failure");
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => "printf recovered");

  try {
    const { pi, commands, handlers, tools } = makePi();
    extension(pi);
    const ctx = makeContext(root, notices, statusUpdates);
    (ctx.ui as any).custom = <T>(factory: any): Promise<T> =>
      new Promise<T>((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          resolve,
        );
        component.handleInput("P");
        component.handleInput("\r");
      });
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("sandbox-allow")?.(`read ${join(root, "new-policy")}`, ctx);

    assert.equal(initializeCount, 3); // desired failure, then prior restoration
    assert.equal(resetMock.mock.callCount(), 1);
    assert.equal(
      statusUpdates.some(({ value }) => value === "ꗃ"),
      true,
    );
    assert.match(notices.join("\\n"), /unavailable.*blocked/i);
    assert.match(
      notices.join("\\n"),
      /Permission was persisted, but the sandbox could not refresh/i,
    );
    const bash = tools.get("bash");
    assert.ok(bash);
    await assert.rejects(
      bash.execute("blocked-unavailable", { command: "printf local" }, undefined, undefined, ctx),
      /command execution remains blocked/,
    );
    const blocked = await handlers.get("user_bash")?.({ command: "printf local" }, ctx);
    assert.equal(blocked?.result?.exitCode, 1);
    assert.equal(wrapMock.mock.callCount(), 0);

    await commands.get("sandbox-enable")?.("", ctx);
    assert.equal(initializeCount, 4);
    assert.equal(resetMock.mock.callCount(), 2);
    assert.match(notices.at(-1) ?? "", /Sandbox enabled/);
    const ready = await bash.execute(
      "recovered-unavailable",
      { command: "printf local" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(wrapMock.mock.callCount(), 1);
    assert.match((ready.content[0] as { text: string }).text, /recovered/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".pi", "sandbox.json"), "utf8")), {
      filesystem: { allowRead: ["new-policy"] },
    });
  } finally {
    wrapMock.mock.restore();
    initializeMock.mock.restore();
    resetMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale recovery completion cannot replace a newer session lifecycle", async () => {
  const firstRoot = makeProjectTempDirectory("stale-recovery-first");
  const secondRoot = makeProjectTempDirectory("stale-recovery-second");
  const statusUpdates: StatusUpdate[] = [];
  const notices: string[] = [];
  const recoveryStarted = deferred<void>();
  const recoveryFinished = deferred<void>();
  let initializeCount = 0;
  const initializeMock = mock.method(SandboxManager, "initialize", async () => {
    initializeCount += 1;
    if (initializeCount === 1) throw new Error("initial failure");
    if (initializeCount === 2) {
      recoveryStarted.resolve(undefined);
      await recoveryFinished.promise;
    }
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => "printf replacement");

  try {
    const { pi, commands, handlers, tools } = makePi();
    extension(pi);
    const firstContext = makeContext(firstRoot, notices, statusUpdates);
    const secondContext = makeContext(secondRoot, notices, statusUpdates);
    await handlers.get("session_start")?.({}, firstContext);

    const recovery = commands.get("sandbox-enable")?.("", firstContext);
    await recoveryStarted.promise;
    const replacement = handlers.get("session_start")?.({}, secondContext);
    recoveryFinished.resolve(undefined);
    await recovery;
    await replacement;

    assert.equal(initializeCount, 3);
    assert.equal(resetMock.mock.callCount(), 2);
    assert.deepEqual(statusUpdates.at(-1), { key: "sandbox", value: "🔒" });
    const bash = tools.get("bash");
    assert.ok(bash);
    const result = await bash.execute(
      "stale-recovery-replacement",
      { command: "printf replacement" },
      undefined,
      undefined,
      secondContext,
    );
    assert.equal(wrapMock.mock.callCount(), 1);
    assert.match((result.content[0] as { text: string }).text, /replacement/);
  } finally {
    wrapMock.mock.restore();
    initializeMock.mock.restore();
    resetMock.mock.restore();
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("permission prompts persist confirmed scopes without serializing session grants", async () => {
  const root = makeProjectTempDirectory("permission-scope");
  const sessionTargetRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-permission-session-"));
  const globalTargetRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-permission-global-"));
  const writeTargetRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-permission-write-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "global-agent");
  const initializeMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);

  try {
    const { pi, handlers } = makePi();
    const config = makePromptTestConfig();
    extension(pi, { configLoader: () => config });
    const notices: string[] = [];
    const ctx = makeContext(root, notices);
    (ctx.ui as any).custom = <T>(factory: any): Promise<T> =>
      new Promise<T>((resolve) => {
        let component: any;
        component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (value: T) => {
            component?.dispose?.();
            resolve(value);
          },
        );
        const action = (ctx as any).__nextPermissionAction as string;
        for (const key of action === "session"
          ? ["s"]
          : action === "project"
            ? ["P", "\r"]
            : ["A", "\r"]) {
          component.handleInput(key);
        }
      });

    await handlers.get("session_start")?.({}, ctx);
    const targetFor = (directory: string) => join(directory, "blocked.txt");
    const checkRead = async (target: string, action: "session" | "project" | "global") => {
      (ctx as any).__nextPermissionAction = action;
      return handlers.get("tool_call")?.({ toolName: "read", input: { path: target } }, ctx);
    };

    const sessionTarget = targetFor(sessionTargetRoot);
    assert.equal(await checkRead(sessionTarget, "session"), undefined);
    // A second access is allowed by the in-memory grant, not by either config file.
    assert.equal(await checkRead(sessionTarget, "session"), undefined);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);
    assert.equal(existsSync(join(root, "global-agent", "sandbox.json")), false);

    const projectTarget = join(root, "packages", "widget", "src", "index.ts");
    assert.equal(await checkRead(projectTarget, "project"), undefined);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".pi", "sandbox.json"), "utf8")), {
      filesystem: { allowRead: ["packages/widget/src/index.ts"] },
    });
    assert.equal(existsSync(join(root, "global-agent", "sandbox.json")), false);

    const globalTarget = targetFor(globalTargetRoot);
    assert.equal(await checkRead(globalTarget, "global"), undefined);
    const globalPath = join(root, "global-agent", "sandbox.json");
    assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), {
      filesystem: { allowRead: [join(realpathSync(globalTargetRoot), "blocked.txt")] },
    });

    (ctx as any).__nextPermissionAction = "project";
    assert.equal(
      await handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "curl https://blocked.example.test" } },
        ctx,
      ),
      undefined,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".pi", "sandbox.json"), "utf8")), {
      filesystem: { allowRead: ["packages/widget/src/index.ts"] },
      network: { allowedDomains: ["blocked.example.test"] },
    });

    (ctx as any).__nextPermissionAction = "global";
    const writeTarget = targetFor(writeTargetRoot);
    assert.equal(
      await handlers.get("tool_call")?.({ toolName: "write", input: { path: writeTarget } }, ctx),
      undefined,
    );
    assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), {
      filesystem: {
        allowRead: [join(realpathSync(globalTargetRoot), "blocked.txt")],
        allowWrite: [join(realpathSync(writeTargetRoot), "blocked.txt")],
      },
    });
  } finally {
    initializeMock.mock.restore();
    resetMock.mock.restore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
    rmSync(sessionTargetRoot, { recursive: true, force: true });
    rmSync(globalTargetRoot, { recursive: true, force: true });
    rmSync(writeTargetRoot, { recursive: true, force: true });
  }
});

test("direct reads inherit configured and session allowWrite with denyRead specificity", async () => {
  const root = makeProjectTempDirectory("direct-read-write-allowance");
  const configuredRoot = join(root, "configured");
  const sessionRoot = join(root, "session");
  mkdirSync(configuredRoot, { recursive: true });
  mkdirSync(sessionRoot, { recursive: true });
  const configuredTarget = join(configuredRoot, "configured.txt");
  const sessionTarget = join(sessionRoot, "session.txt");
  const config = makePromptTestConfig();
  config.filesystem = {
    ...config.filesystem!,
    allowRead: [],
    allowWrite: [configuredRoot],
    denyRead: [root],
  };
  const initializeMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);

  try {
    const { pi, handlers } = makePi();
    extension(pi, { configLoader: () => config });
    const ctx = makeContext(root, []);
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          resolve,
        );
        component.handleInput("s");
      });

    await handlers.get("session_start")?.({}, ctx);

    // A more-specific configured allowWrite overrides a broad denyRead for
    // direct reads, but an equal-specificity denyRead still wins.
    assert.equal(
      await handlers.get("tool_call")?.(
        { toolName: "read", input: { path: configuredTarget } },
        ctx,
      ),
      undefined,
    );
    config.filesystem.denyRead = [configuredRoot];
    const configuredDenied = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: configuredTarget } },
      ctx,
    );
    assert.equal(configuredDenied?.block, true);
    assert.match(configuredDenied?.reason ?? "", /denyRead/);

    // The same direct-read contract applies to a session-only write grant.
    config.filesystem.denyRead = [];
    assert.equal(
      await handlers.get("tool_call")?.({ toolName: "write", input: { path: sessionTarget } }, ctx),
      undefined,
    );
    config.filesystem.denyRead = [root];
    assert.equal(
      await handlers.get("tool_call")?.({ toolName: "read", input: { path: sessionTarget } }, ctx),
      undefined,
    );
    config.filesystem.denyRead = [sessionTarget];
    const sessionDenied = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: sessionTarget } },
      ctx,
    );
    assert.equal(sessionDenied?.block, true);
    assert.match(sessionDenied?.reason ?? "", /denyRead/);
  } finally {
    initializeMock.mock.restore();
    resetMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission prompt timeout aborts without persistence, refresh, or session allowance", async () => {
  const root = makeProjectTempDirectory("permission-timeout");
  const targetRoot = mkdtempSync(join(tmpdir(), "pi-sandbox-permission-timeout-target-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "global-agent");
  let initializeCount = 0;
  let resetCount = 0;
  let promptCount = 0;
  const initializeMock = mock.method(SandboxManager, "initialize", async () => {
    initializeCount += 1;
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resetCount += 1;
  });

  try {
    const { pi, handlers } = makePi();
    const config = { ...makePromptTestConfig(), permissionPromptTimeoutSeconds: 0.01 };
    extension(pi, { configLoader: () => config });
    const ctx = makeContext(root, []);
    (ctx.ui as any).custom = async <T>(factory: any): Promise<T> => {
      promptCount += 1;
      return new Promise<T>((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          resolve,
        );
        void component;
      });
    };
    await handlers.get("session_start")?.({}, ctx);
    const beforeRefresh = { initializeCount, resetCount };
    const target = join(targetRoot, "blocked.txt");
    const firstResult = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: target } },
      ctx,
    );
    const secondResult = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: target } },
      ctx,
    );
    assert.equal(firstResult?.block, true);
    assert.equal(secondResult?.block, true);
    assert.equal(promptCount, 2);
    assert.deepEqual({ initializeCount, resetCount }, beforeRefresh);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);
    assert.equal(existsSync(join(root, "global-agent", "sandbox.json")), false);
  } finally {
    initializeMock.mock.restore();
    resetMock.mock.restore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("replaces linked-worktree runtime allowances from the active cwd", async () => {
  const fixture = makeLinkedWorktreeFixture();
  const initialised: unknown[] = [];
  const resets: string[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async (config: unknown) => {
    initialised.push(config);
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resets.push("reset");
  });

  try {
    const { pi, commands, handlers } = makePi();
    extension(pi);
    const notices: string[] = [];
    const ctx = makeContext(fixture.first, notices);

    await handlers.get("session_start")?.({}, ctx);
    const firstConfig = initialised[0] as any;
    assert.equal(firstConfig.filesystem.allowRead.includes(fixture.firstCommonDir), true);
    assert.equal(firstConfig.filesystem.allowWrite.includes(fixture.firstCommonDir), false);
    assert.equal(
      firstConfig.filesystem.allowWrite.includes(join(fixture.firstCommonDir, "objects")),
      true,
    );
    assert.equal(
      firstConfig.filesystem.allowWrite.includes(join(fixture.firstCommonDir, "hooks")),
      false,
    );
    assert.equal(firstConfig.filesystem.allowWrite.includes(fixture.secondCommonDir), false);
    assert.equal(firstConfig.filesystem.allowRead.includes(fixture.secondCommonDir), false);

    ctx.cwd = fixture.second;
    await handlers.get("session_start")?.({}, ctx);
    const secondConfig = initialised[1] as any;
    assert.equal(secondConfig.filesystem.allowRead.includes(fixture.secondCommonDir), true);
    assert.equal(secondConfig.filesystem.allowWrite.includes(fixture.secondCommonDir), false);
    assert.equal(
      secondConfig.filesystem.allowWrite.includes(join(fixture.secondCommonDir, "refs")),
      true,
    );
    assert.equal(
      secondConfig.filesystem.allowWrite.includes(join(fixture.secondCommonDir, "config")),
      false,
    );
    assert.equal(secondConfig.filesystem.allowRead.includes(fixture.firstCommonDir), false);
    assert.equal(secondConfig.filesystem.allowWrite.includes(fixture.firstCommonDir), false);
    assert.equal(resets.length, 1);

    await commands.get("sandbox")?.("", ctx);
    assert.match(notices.at(-1) ?? "", /Linked Git metadata writes:/);
    assert.ok((notices.at(-1) ?? "").includes(join(fixture.secondCommonDir, "objects")));

    // A broader deny still permits the more-specific derived metadata write
    // paths, while common metadata outside those paths and checked-out files
    // remain outside the derived write allowance.
    mkdirSync(join(fixture.second, ".pi"));
    writeFileSync(
      join(fixture.second, ".pi", "sandbox.json"),
      JSON.stringify({
        filesystem: {
          denyRead: [fixture.firstRepository, fixture.secondRepository],
          denyWrite: [fixture.firstRepository, fixture.secondRepository],
        },
      }),
    );

    ctx.hasUI = false;
    const ordinaryPaths = [
      join(fixture.first, "old-worktree.txt"),
      join(fixture.secondRepository, "original-checkout.txt"),
      join(fixture.sibling, "sibling-worktree.txt"),
    ];
    for (const path of ordinaryPaths) {
      const read = await handlers.get("tool_call")?.({ toolName: "read", input: { path } }, ctx);
      const write = await handlers.get("tool_call")?.({ toolName: "write", input: { path } }, ctx);
      const edit = await handlers.get("tool_call")?.({ toolName: "edit", input: { path } }, ctx);
      assert.equal(read?.block, true);
      assert.equal(write?.block, true);
      assert.equal(edit?.block, true);
    }

    const commonMetadataPath = join(fixture.secondCommonDir, "HEAD");
    const allowedMetadataWritePath = join(fixture.secondCommonDir, "objects", "policy-test-object");
    const commonRead = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: commonMetadataPath } },
      ctx,
    );
    const commonWrite = await handlers.get("tool_call")?.(
      { toolName: "write", input: { path: commonMetadataPath } },
      ctx,
    );
    const commonEdit = await handlers.get("tool_call")?.(
      { toolName: "edit", input: { path: commonMetadataPath } },
      ctx,
    );
    assert.equal(commonRead, undefined);
    assert.equal(commonWrite?.block, true);
    assert.equal(commonEdit?.block, true);
    assert.match(commonWrite?.reason ?? "", /denyWrite/);
    assert.match(commonEdit?.reason ?? "", /denyWrite/);
    assert.equal(
      await handlers.get("tool_call")?.(
        { toolName: "write", input: { path: allowedMetadataWritePath } },
        ctx,
      ),
      undefined,
    );
    assert.equal(
      await handlers.get("tool_call")?.(
        { toolName: "edit", input: { path: allowedMetadataWritePath } },
        ctx,
      ),
      undefined,
    );

    // Equal-specificity explicit denies retain precedence over the derived
    // allowance for both direct read and write/edit hooks.
    writeFileSync(
      join(fixture.second, ".pi", "sandbox.json"),
      JSON.stringify({
        filesystem: {
          denyRead: [fixture.secondCommonDir],
          denyWrite: [fixture.secondCommonDir],
        },
      }),
    );
    const deniedCommonRead = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: commonMetadataPath } },
      ctx,
    );
    const deniedCommonWrite = await handlers.get("tool_call")?.(
      { toolName: "write", input: { path: commonMetadataPath } },
      ctx,
    );
    const deniedCommonEdit = await handlers.get("tool_call")?.(
      { toolName: "edit", input: { path: commonMetadataPath } },
      ctx,
    );
    assert.equal(deniedCommonRead?.block, true);
    assert.equal(deniedCommonWrite?.block, true);
    assert.equal(deniedCommonEdit?.block, true);
    assert.match(deniedCommonRead?.reason ?? "", /denyRead/);
    assert.match(deniedCommonWrite?.reason ?? "", /denyWrite/);
    assert.match(deniedCommonEdit?.reason ?? "", /denyWrite/);
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    rmSync(fixture.firstRepository, { recursive: true, force: true });
    rmSync(fixture.secondRepository, { recursive: true, force: true });
  }
});

test("mandatory Git and project paths cannot be explicitly allowed for direct write or edit", async () => {
  const fixture = makeLinkedWorktreeFixture();
  const worktreeGitDir = realpathSync(
    join(fixture.secondCommonDir, "worktrees", basename(fixture.second)),
  );
  const protectedTargets = [
    join(fixture.second, ".git"),
    join(fixture.secondCommonDir, "config"),
    join(fixture.secondCommonDir, "hooks", "pre-commit"),
    join(worktreeGitDir, "config.worktree"),
    join(worktreeGitDir, "gitdir"),
    join(fixture.second, ".gitmodules"),
    join(fixture.second, ".pi", "extensions", "unsafe.ts"),
    join(fixture.second, ".pi", "cache", "unsafe"),
    join(fixture.second, ".envrc"),
    join(fixture.second, ".vscode", "settings.json"),
    join(fixture.second, ".idea", "workspace.xml"),
    join(fixture.second, "nested", "repo", ".git", "config"),
    join(fixture.second, "nested", "repo", ".git", "hooks", "pre-commit"),
    join(fixture.second, "nested", "repo", ".gitmodules"),
    join(fixture.second, "nested", ".pi", "extensions", "unsafe.ts"),
    join(homedir(), ".gitconfig"),
    join(homedir(), ".config", "git", "config"),
  ];
  const config = {
    ...makePromptTestConfig(),
    filesystem: {
      ...makePromptTestConfig().filesystem!,
      allowWrite: [fixture.second, ...protectedTargets],
    },
  };
  const initializeMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);

  try {
    const { pi, handlers } = makePi();
    extension(pi, { configLoader: () => config });
    const ctx = makeContext(fixture.second, []);
    await handlers.get("session_start")?.({}, ctx);

    for (const path of protectedTargets) {
      for (const toolName of ["write", "edit"]) {
        const blocked = await handlers.get("tool_call")?.({ toolName, input: { path } }, ctx);
        assert.equal(blocked?.block, true, `${toolName}: ${path}`);
        assert.match(blocked?.reason ?? "", /mandatory protection; cannot be granted/i);
      }
    }
  } finally {
    initializeMock.mock.restore();
    resetMock.mock.restore();
    rmSync(fixture.firstRepository, { recursive: true, force: true });
    rmSync(fixture.secondRepository, { recursive: true, force: true });
  }
});

test(
  "case-variant missing project/global config and .pi writes block before approval on macOS",
  {
    skip:
      process.platform !== "darwin"
        ? "requires macOS"
        : getVolumeCaseSensitivity(process.cwd()) === "sensitive"
          ? "workspace volume is detected as case-sensitive"
          : false,
  },
  async () => {
    const root = makeProjectTempDirectory("case-variant-protected-write");
    const agentDir = join(root, "global-agent");
    mkdirSync(agentDir);
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let initializeCount = 0;
    let resetCount = 0;
    let promptCount = 0;
    const initializeMock = mock.method(SandboxManager, "initialize", async () => {
      initializeCount += 1;
    });
    const resetMock = mock.method(SandboxManager, "reset", async () => {
      resetCount += 1;
    });

    try {
      const { pi, handlers } = makePi();
      const config = {
        ...makePromptTestConfig(),
        enabled: true,
        filesystem: { ...makePromptTestConfig().filesystem!, allowWrite: [root] },
      };
      extension(pi, { configLoader: () => config });
      const ctx = makeContext(root, []);
      (ctx.ui as any).custom = async () => {
        promptCount += 1;
        throw new Error("protected writes must not prompt");
      };
      await handlers.get("session_start")?.({}, ctx);
      const beforeAttempts = { initializeCount, resetCount };
      const protectedTargets = [
        join(root, ".PI", "Sandbox.json"),
        join(root, ".PI", "extensions", "unsafe.ts"),
        join(root, "GLOBAL-AGENT", "Sandbox.json"),
        join(root, "nested", ".PI", "extensions", "unsafe.ts"),
      ];

      for (const path of protectedTargets) {
        for (const toolName of ["write", "edit"]) {
          const blocked = await handlers.get("tool_call")?.({ toolName, input: { path } }, ctx);
          assert.equal(blocked?.block, true, `${toolName}: ${path}`);
          assert.match(blocked?.reason ?? "", /protected|mandatory protection/i);
        }
      }

      assert.equal(promptCount, 0);
      assert.deepEqual({ initializeCount, resetCount }, beforeAttempts);
      assert.equal(existsSync(join(root, ".pi")), false);
      assert.equal(existsSync(join(root, "nested", ".pi")), false);
      assert.equal(existsSync(join(agentDir, "sandbox.json")), false);
    } finally {
      initializeMock.mock.restore();
      resetMock.mock.restore();
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("/sandbox-allow cannot disable protected config checks with a broad edited write allowance", async () => {
  const root = makeProjectTempDirectory("broad-write-config-protection");
  const agentDir = join(root, "custom-agent");
  const projectPath = join(root, ".pi", "sandbox.json");
  const globalPath = join(agentDir, "sandbox.json");
  mkdirSync(dirname(projectPath), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const originalProject = JSON.stringify({ enabled: true, filesystem: { allowWrite: [] } });
  const originalGlobal = JSON.stringify({ network: { deniedDomains: ["blocked.example"] } });
  writeFileSync(projectPath, originalProject);
  writeFileSync(globalPath, originalGlobal);
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const notices: string[] = [];
  const initializeMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);

  try {
    const { pi, commands, handlers } = makePi();
    extension(pi);
    const ctx = makeContext(root, notices);
    (ctx.ui as any).custom = <T>(factory: any): Promise<T> =>
      new Promise<T>((resolve) => {
        let component: any;
        component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (value: T) => {
            component?.dispose?.();
            resolve(value);
          },
        );
        // Select global scope, edit the concrete proposal to the broad root,
        // then explicitly confirm the persistent grant.
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput("\t");
        for (let index = 0; index < 200; index += 1) component.handleInput("\x7f");
        component.handleInput("/");
        component.handleInput("\r");
        component.handleInput("\r");
      });

    await handlers.get("session_start")?.({}, ctx);
    await commands.get("sandbox-allow")?.("write /tmp/ordinary-output.txt", ctx);
    assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), {
      network: { deniedDomains: ["blocked.example"] },
      filesystem: { allowWrite: ["/"] },
    });

    for (const path of [projectPath, globalPath]) {
      for (const toolName of ["write", "edit"]) {
        const blocked = await handlers.get("tool_call")?.({ toolName, input: { path } }, ctx);
        assert.equal(blocked?.block, true);
        assert.match(blocked?.reason ?? "", /sandbox configuration files are protected/i);
      }
      const bash = await handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: `echo changed > ${path}` } },
        ctx,
      );
      const userBash = await handlers.get("user_bash")?.(
        { command: `echo changed > ${path}` },
        ctx,
      );
      assert.equal(bash?.block, true);
      assert.equal(userBash?.result?.exitCode, 1);
      assert.match(bash?.reason ?? "", /\/sandbox-allow cannot override/i);
      assert.match(userBash?.result?.output ?? "", /\/sandbox-allow cannot override/i);
    }
    assert.equal(readFileSync(projectPath, "utf8"), originalProject);
    assert.notEqual(readFileSync(globalPath, "utf8"), originalGlobal);
  } finally {
    initializeMock.mock.restore();
    resetMock.mock.restore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected write, edit, Bash, and user Bash mutations are blocked before sandbox state checks", async () => {
  const root = makeProjectTempDirectory("extension-protection");
  const agentDir = join(root, "custom-agent");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const notices: string[] = [];
  try {
    const { pi, handlers } = makePi();
    extension(pi);
    const ctx = makeContext(root, notices);
    const globalPath = join(agentDir, "sandbox.json");
    const directWrite = await handlers.get("tool_call")?.(
      { toolName: "write", input: { path: globalPath } },
      ctx,
    );
    const directEdit = await handlers.get("tool_call")?.(
      { toolName: "edit", input: { path: globalPath } },
      ctx,
    );
    const bash = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: `echo x > ${globalPath}` } },
      ctx,
    );
    const userBash = await handlers.get("user_bash")?.({ command: `echo x > ${globalPath}` }, ctx);

    assert.equal(directWrite?.block, true);
    assert.equal(directEdit?.block, true);
    assert.equal(bash?.block, true);
    assert.equal(userBash?.result?.exitCode, 1);
    assert.match(directWrite?.reason ?? "", /protected/);
    assert.match(directEdit?.reason ?? "", /protected/);
    assert.match(bash?.reason ?? "", /\/sandbox-allow/i);
    assert.match(userBash?.result?.output ?? "", /\/sandbox-allow/i);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers set_git_upstream with the exact narrow schema and routes through ctx.cwd", async () => {
  const repository = makeGitUpstreamFixture();
  const notices: string[] = [];
  try {
    const { pi, tools } = makePi();
    extension(pi);
    const tool = tools.get("set_git_upstream");
    assert.ok(tool);
    assert.deepEqual(tool.parameters, {
      type: "object",
      properties: {
        localBranch: {
          type: "string",
          description: "The existing local branch name",
        },
        remote: {
          type: "string",
          const: "origin",
          description: 'The only permitted remote; must be "origin"',
        },
        remoteBranch: {
          type: "string",
          description: "The existing remote branch name",
        },
      },
      required: ["localBranch", "remote", "remoteBranch"],
      additionalProperties: false,
    });

    const ctx = makeContext(repository, notices);
    const result = await tool.execute(
      "set-upstream",
      { localBranch: "main", remote: "origin", remoteBranch: "main" },
      undefined,
      undefined,
      ctx,
    );
    assert.match((result.content[0] as { text: string }).text, /now tracks/);
    assert.equal(
      git(repository, ["config", "--local", "--get", "branch.main.remote"]).trim(),
      "origin",
    );

    await assert.rejects(
      tool.execute(
        "bad-remote",
        { localBranch: "main", remote: "upstream", remoteBranch: "main" },
        undefined,
        undefined,
        ctx,
      ),
      /origin/i,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      tool.execute(
        "cancelled",
        { localBranch: "main", remote: "origin", remoteBranch: "main" },
        controller.signal,
        undefined,
        ctx,
      ),
      /aborted/i,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("blocks every positive Git tracking mutation before Bash execution and passes negatives", async () => {
  const root = makeProjectTempDirectory("git-upstream-preflight");
  const marker = join(root, "must-not-run");
  try {
    const { pi, handlers, tools } = makePi();
    extension(pi);
    const ctx = makeContext(root, []);
    const handler = handlers.get("tool_call");
    assert.ok(handler);

    for (const command of gitUpstreamMutationCommands) {
      const blocked = await handler({ toolName: "bash", input: { command } }, ctx);
      assert.equal(blocked?.block, true, command);
    }
    for (const command of nonGitUpstreamMutationCommands) {
      assert.equal(
        await handler({ toolName: "bash", input: { command } }, ctx),
        undefined,
        command,
      );
    }

    const bash = tools.get("bash");
    assert.ok(bash);
    const result = await bash.execute(
      "blocked-direct",
      { command: `git branch -u origin/main main; touch ${marker}` },
      undefined,
      undefined,
      ctx,
    );
    assert.match((result.content[0] as { text: string }).text, /set_git_upstream/);
    assert.equal(existsSync(marker), false);

    const userBash = await handlers.get("user_bash")?.(
      { command: gitUpstreamMutationCommands[0] },
      ctx,
    );
    assert.equal(userBash?.result?.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool_result keeps raw diagnostic context while attaching compact presentation details", async () => {
  const { pi, handlers } = makePi();
  extension(pi);
  const diagnostic: SandboxDiagnosticBlockData = {
    type: "write",
    target: "/project/output.txt",
    rule: "allowWrite",
    prompted: true,
    choice: "session",
    retried: true,
    finalOutcome: "success",
    otherViolations: 1,
    action: "allow and retry",
  };
  const rawText = `normal output\n${renderDiagnosticBlockData(diagnostic)}`;
  const event = {
    toolName: "bash",
    content: [{ type: "text", text: rawText }],
    details: { truncation: { truncated: true }, fullOutputPath: "/tmp/full-output" },
  };

  const result = await handlers.get("tool_result")?.(event, {} as ExtensionContext);
  assert.equal(event.content[0]?.text, rawText);
  assert.deepEqual(result, {
    details: {
      truncation: { truncated: true },
      fullOutputPath: "/tmp/full-output",
      sandboxDiagnostic: diagnostic,
      sandboxVisibleText: "normal output",
    },
  });

  assert.equal(
    await handlers.get("tool_result")?.(
      { toolName: "bash", content: [{ type: "text", text: "normal output" }], details: {} },
      {} as ExtensionContext,
    ),
    undefined,
  );
});

test("bash rendering hides raw metadata and reveals output and truncation only when expanded", () => {
  const { pi, tools } = makePi();
  extension(pi);
  const bash = tools.get("bash");
  const diagnostic: SandboxDiagnosticBlockData = {
    type: "network",
    target: "api.example.com",
    rule: "allowedDomains",
    prompted: false,
    choice: "none",
    retried: false,
    finalOutcome: "failure",
    otherViolations: 0,
    action: "host not allowed; approve network access",
  };
  const rawBlock = renderDiagnosticBlockData(diagnostic);
  const result = {
    content: [{ type: "text", text: `normal output\n${rawBlock}` }],
    details: {
      sandboxDiagnostic: diagnostic,
      sandboxVisibleText: "normal output",
      truncation: { truncated: true },
      fullOutputPath: "/tmp/full-output",
    },
  };
  const theme = {
    fg: (_colour: string, text: string) => text,
    bold: (text: string) => text,
  };

  const collapsed = bash
    .renderResult(result, { expanded: false }, theme, {})
    .render(100)
    .join("\n");
  assert.match(collapsed, /Sandbox intervention/);
  assert.doesNotMatch(collapsed, /normal output|<sandbox_diagnostic>|api\.example\.com/);

  const expanded = bash.renderResult(result, { expanded: true }, theme, {}).render(100).join("\n");
  assert.match(expanded, /normal output/);
  assert.match(expanded, /Output truncated/);
  assert.match(expanded, /Full output: \/tmp\/full-output/);
  assert.doesNotMatch(expanded, /<sandbox_diagnostic>/);
});

test("user_bash streams normal output once without diagnostic metadata", async () => {
  const root = makeProjectTempDirectory("user-bash-normal");
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const wrapMock = mock.method(
    SandboxManager,
    "wrapWithSandbox",
    async () => "printf normal-output",
  );

  try {
    const { pi, handlers, sentMessages } = makePi();
    extension(pi);
    const ctx = makeContext(root, []);
    await handlers.get("session_start")?.({}, ctx);
    const response = await handlers.get("user_bash")?.(
      { command: "printf normal-output", excludeFromContext: false },
      ctx,
    );
    let output = "";
    const result = await response.operations.exec("printf normal-output", root, {
      onData: (data: Buffer) => {
        output += data.toString();
      },
      timeout: 5,
      env: process.env,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(output, "normal-output");
    assert.deepEqual(sentMessages, []);
  } finally {
    wrapMock.mock.restore();
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git push refspec does not prompt model Bash or user shell for a head domain", async () => {
  const root = makeProjectTempDirectory("git-push-refspec-domain");
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "sandbox.json"),
    JSON.stringify({ network: { allowedDomains: ["127.0.0.1"] } }),
  );
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);

  try {
    const { pi, handlers } = makePi();
    extension(pi, { platform: "linux" });
    const ctx = makeContext(root, []);
    let promptCount = 0;
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("esc");
      });

    await handlers.get("session_start")?.({}, ctx);
    const command =
      "git push ssh://ehensleigh@127.0.0.1:49274/tmp/pi-ssh-accept.UKY3UM/remote.git HEAD:refs/heads/main";
    const modelBash = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command } },
      ctx,
    );
    assert.equal(modelBash, undefined);
    assert.equal(promptCount, 0);

    const userBash = await handlers.get("user_bash")?.({ command, excludeFromContext: false }, ctx);
    assert.ok(userBash?.operations);
    assert.equal(userBash.result, undefined);
    assert.equal(promptCount, 0);
  } finally {
    resetMock.mock.restore();
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("denied Git remotes in model Bash and user shell block before SSH-agent approval", async () => {
  const root = makeProjectTempDirectory("ssh-domain-policy");
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "sandbox.json"),
    JSON.stringify({
      network: {
        allowedDomains: ["approved.example"],
        deniedDomains: ["denied.example"],
      },
    }),
  );
  const socketPath = join(root, "agent.sock");
  const originalSocket = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = socketPath;
  const initialized: unknown[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async (config: unknown) => {
    initialized.push(config);
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
    throw new Error("domain policy should block before wrapped execution");
  });

  try {
    const { pi, handlers, sentMessages } = makePi();
    extension(pi, { platform: "darwin" });
    const ctx = makeContext(root, []);
    let promptCount = 0;
    (ctx.ui as any).custom = () => {
      promptCount += 1;
      throw new Error("denied SSH domain must not prompt for SSH-agent access");
    };

    await handlers.get("session_start")?.({}, ctx);
    const command = "git clone -b main git@denied.example:repo.git checkout";
    const modelBash = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command } },
      ctx,
    );
    assert.equal(modelBash?.block, true);
    assert.match(modelBash?.reason ?? "", /denied\.example/);
    assert.equal(promptCount, 0);

    const response = await handlers.get("user_bash")?.({ command, excludeFromContext: false }, ctx);

    assert.ok(response?.result);
    assert.equal(response.result.exitCode, 1);
    assert.equal(response.operations, undefined);
    assert.match(response.result.output, /denied\.example/);
    assert.match(response.result.output, /deniedDomains/);

    const globalOptionCommand = "git -C push clone git@denied.example:team/repo.git";
    const globalOptionModelBash = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: globalOptionCommand } },
      ctx,
    );
    assert.equal(globalOptionModelBash?.block, true);
    assert.match(globalOptionModelBash?.reason ?? "", /denied\.example/);
    const globalOptionUserBash = await handlers.get("user_bash")?.(
      { command: globalOptionCommand, excludeFromContext: false },
      ctx,
    );
    assert.equal(globalOptionUserBash?.result?.exitCode, 1);
    assert.match(globalOptionUserBash?.result?.output ?? "", /denied\.example/);

    const pushResponse = await handlers.get("user_bash")?.(
      {
        command: "git push git@denied.example:repo; printf should-not-run",
        excludeFromContext: false,
      },
      ctx,
    );
    assert.equal(pushResponse?.result?.exitCode, 1);
    assert.match(pushResponse?.result?.output ?? "", /denied\.example/);
    assert.equal(promptCount, 0);
    assert.equal(resetMock.mock.callCount(), 0);
    assert.equal(wrapMock.mock.callCount(), 0);
    assert.equal(initialized.length, 1);
    assert.equal(
      (
        (initialized[0] as { network?: { allowUnixSockets?: string[] } }).network
          ?.allowUnixSockets ?? []
      ).includes(socketPath),
      false,
    );
    assert.equal(sentMessages.length, 3);
  } finally {
    wrapMock.mock.restore();
    resetMock.mock.restore();
    managerMock.mock.restore();
    if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = originalSocket;
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS Git SSH preflight grants session access only during diagnostic execution", async () => {
  const root = makeProjectTempDirectory("ssh-preflight-grant");
  allowSshTestDomain(root);
  const socketPath = join(root, "agent.sock");
  const originalSocket = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = socketPath;
  const initialized: unknown[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async (config: unknown) => {
    initialized.push(config);
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => "printf granted");

  try {
    const { pi, handlers } = makePi();
    extension(pi, { platform: "darwin" });
    const ctx = makeContext(root, []);
    let promptCount = 0;
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("s");
      });

    await handlers.get("session_start")?.({}, ctx);
    const response = await handlers.get("user_bash")?.(
      { command: "git push git@host:repo; printf done", excludeFromContext: true },
      ctx,
    );
    assert.ok(response?.operations);
    const result = await response.operations.exec("git push git@host:repo; printf done", root, {
      onData: () => undefined,
      timeout: 5,
      env: process.env,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(promptCount, 1);
    assert.equal(resetMock.mock.callCount(), 1);
    assert.equal(initialized.length, 2);
    assert.deepEqual(
      (initialized[1] as { network?: { allowUnixSockets?: string[] } }).network?.allowUnixSockets,
      [socketPath],
    );
    const persisted = JSON.parse(readFileSync(join(root, ".pi", "sandbox.json"), "utf8"));
    assert.equal(persisted.network?.allowUnixSockets, undefined);
    assert.equal(persisted.network?.allowAllUnixSockets, undefined);
  } finally {
    wrapMock.mock.restore();
    managerMock.mock.restore();
    resetMock.mock.restore();
    if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = originalSocket;
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS Git SSH preflight records one clean denied incident", async () => {
  const root = makeProjectTempDirectory("ssh-preflight-deny");
  allowSshTestDomain(root);
  const originalSocket = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = join(root, "agent.sock");
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
    throw new Error("SSH preflight should block before execution");
  });

  try {
    const { pi, handlers, sentMessages, commands } = makePi();
    extension(pi, { platform: "darwin" });
    const notices: string[] = [];
    const ctx = makeContext(root, notices);
    let promptCount = 0;
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("esc");
      });

    await handlers.get("session_start")?.({}, ctx);
    const response = await handlers.get("user_bash")?.(
      { command: "git push git@host:repo; printf done", excludeFromContext: false },
      ctx,
    );
    assert.ok(response?.operations);
    let output = "";
    const result = await response.operations.exec("git push git@host:repo; printf done", root, {
      onData: (data: Buffer) => {
        output += data.toString();
      },
      timeout: 5,
      env: process.env,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(promptCount, 1);
    assert.equal(wrapMock.mock.callCount(), 0);
    assert.match(output, /SSH auth; left blocked/);
    assert.doesNotMatch(output, /<sandbox_diagnostic>/);
    assert.equal(sentMessages.length, 1);
    await commands.get("sandbox-debug")?.("", ctx);
    assert.match(notices.at(-1) ?? "", /ssh-preflight-deny/);
    assert.match(notices.at(-1) ?? "", /prompted: yes/);
  } finally {
    wrapMock.mock.restore();
    managerMock.mock.restore();
    if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = originalSocket;
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent Bash retains a blocked SSH preflight for sandbox-debug", async () => {
  const root = makeProjectTempDirectory("ssh-preflight-bash");
  allowSshTestDomain(root);
  const originalSocket = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = join(root, "agent.sock");
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
    throw new Error("SSH preflight should block before execution");
  });

  try {
    const { pi, tools, commands, handlers, sentMessages } = makePi();
    extension(pi, { platform: "darwin" });
    const notices: string[] = [];
    const ctx = makeContext(root, notices);
    let promptCount = 0;
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("esc");
      });

    await handlers.get("session_start")?.({}, ctx);

    const bash = tools.get("bash");
    assert.ok(bash);
    await assert.rejects(
      bash.execute(
        "blocked-ssh",
        { command: "ssh host; printf done", timeout: 5 },
        undefined,
        undefined,
        ctx,
      ),
      /<sandbox_diagnostic>/,
    );
    assert.equal(promptCount, 1);
    assert.equal(wrapMock.mock.callCount(), 0);
    assert.deepEqual(sentMessages, []);

    await commands.get("sandbox-debug")?.("", ctx);
    const debug = notices.at(-1) ?? "";
    assert.match(debug, /ssh host; printf done/);
    assert.match(debug, /prompted: yes/);
    assert.match(debug, /choice: abort/);
  } finally {
    wrapMock.mock.restore();
    managerMock.mock.restore();
    if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = originalSocket;
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS Git SSH preflight rolls back a failed grant before retrying", async () => {
  const root = makeProjectTempDirectory("ssh-preflight-rollback");
  allowSshTestDomain(root);
  const originalSocket = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = join(root, "agent.sock");
  let initializeCount = 0;
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    initializeCount += 1;
    if (initializeCount === 2) throw new Error("test refresh failure");
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => "printf recovered");

  try {
    const { pi, handlers } = makePi();
    extension(pi, { platform: "darwin" });
    const ctx = makeContext(root, []);
    let promptCount = 0;
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("s");
      });

    await handlers.get("session_start")?.({}, ctx);
    const first = await handlers.get("user_bash")?.(
      { command: "git push git@host:repo; printf done", excludeFromContext: true },
      ctx,
    );
    assert.ok(first?.operations);
    const denied = await first.operations.exec("git push git@host:repo; printf done", root, {
      onData: () => undefined,
      timeout: 5,
      env: process.env,
    });
    assert.equal(denied.exitCode, 1);

    const second = await handlers.get("user_bash")?.(
      { command: "git push git@host:repo; printf done", excludeFromContext: true },
      ctx,
    );
    assert.equal(second?.result?.exitCode, 1);
    assert.equal(second?.operations, undefined);
    assert.equal(promptCount, 1);
    assert.equal(initializeCount, 3);
    assert.equal(resetMock.mock.callCount(), 1);
  } finally {
    wrapMock.mock.restore();
    managerMock.mock.restore();
    resetMock.mock.restore();
    if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = originalSocket;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux SSH preflight and lone-command fallback never prompt", async () => {
  const root = makeProjectTempDirectory("ssh-preflight-linux");
  allowSshTestDomain(root);
  const originalSocket = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = join(root, "agent.sock");
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  let wrapped = 0;
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
    wrapped += 1;
    return "printf 'Permission denied (publickey).\\n' >&2; exit 1";
  });

  try {
    const { pi, handlers, sentMessages, commands } = makePi();
    extension(pi, { platform: "linux" });
    const notices: string[] = [];
    const ctx = makeContext(root, notices);
    let promptCount = 0;
    (ctx.ui as any).custom = () => {
      promptCount += 1;
      throw new Error("Linux SSH auth must not prompt");
    };
    await handlers.get("session_start")?.({}, ctx);

    const compound = await handlers.get("user_bash")?.(
      { command: "ssh host; printf done", excludeFromContext: true },
      ctx,
    );
    assert.ok(compound?.operations);
    const preflightBlocked = await compound.operations.exec("ssh host; printf done", root, {
      onData: () => undefined,
      timeout: 5,
      env: process.env,
    });
    assert.equal(preflightBlocked.exitCode, 1);
    assert.equal(wrapped, 0);

    const lone = await handlers.get("user_bash")?.(
      { command: "ssh host", excludeFromContext: true },
      ctx,
    );
    assert.ok(lone?.operations);
    let output = "";
    const fallbackBlocked = await lone.operations.exec("ssh host", root, {
      onData: (data: Buffer) => {
        output += data.toString();
      },
      timeout: 5,
      env: process.env,
    });
    assert.equal(fallbackBlocked.exitCode, 1);
    assert.equal(wrapped, 1);
    assert.equal(promptCount, 0);
    assert.match(output, /SSH auth; blocked or failed/);
    assert.equal(output.match(/\[sandbox:/g)?.length, 1);
    assert.doesNotMatch(output, /allowAllUnixSockets|<sandbox_diagnostic>/);
    assert.equal(sentMessages.length, 0);

    await commands.get("sandbox-debug")?.("", ctx);
    const debug = notices.at(-1) ?? "";
    assert.equal(debug.includes("prompted: no"), true);
    assert.match(debug, /path-scoped SSH-agent access is unavailable on Linux/);
  } finally {
    wrapMock.mock.restore();
    managerMock.mock.restore();
    if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = originalSocket;
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox-debug retains five incidents in memory and resets on a new session", async () => {
  const root = makeProjectTempDirectory("sandbox-debug-history");
  const agentDir = join(root, "global-agent");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
    return "printf 'cat: /outside/debug-secret: Operation not permitted\\n' >&2; exit 1";
  });

  try {
    const { pi, commands, handlers } = makePi();
    extension(pi);
    const notices: string[] = [];
    const ctx = makeContext(root, notices);
    ctx.hasUI = false;
    await handlers.get("session_start")?.({}, ctx);

    for (let index = 0; index < 6; index += 1) {
      const response = await handlers.get("user_bash")?.(
        { command: `cat /outside/debug-secret-${index}`, excludeFromContext: true },
        ctx,
      );
      assert.ok(response?.operations);
      await response.operations.exec(`cat /outside/debug-secret-${index}`, root, {
        onData: () => undefined,
        timeout: 5,
        env: process.env,
      });
    }

    await commands.get("sandbox-debug")?.("", ctx);
    const debug = notices.at(-1) ?? "";
    assert.match(debug, /Sandbox Debug/);
    assert.match(debug, /debug-secret-5/);
    assert.doesNotMatch(debug, /debug-secret-0/);
    assert.match(debug, /Session-local/);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);
    assert.equal(existsSync(join(agentDir, "sandbox.json")), false);

    // A replacement session clears incident history without reading or writing
    // a history file; session allowances remain until shutdown.
    await handlers.get("session_start")?.({}, ctx);
    await commands.get("sandbox-debug")?.("", ctx);
    assert.match(notices.at(-1) ?? "", /no attributed incidents/i);
  } finally {
    wrapMock.mock.restore();
    managerMock.mock.restore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("session starts retain allowances until shutdown clears them", async () => {
  const root = makeProjectTempDirectory("session-allowances-lifecycle");
  const initialized: string[] = [];
  const resets: string[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    initialized.push("initialize");
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resets.push("reset");
  });

  try {
    const { pi, handlers } = makePi();
    extension(pi);
    const ctx = makeContext(root, []);
    let promptCount = 0;
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("s");
      });

    await handlers.get("session_start")?.({}, ctx);
    const first = await handlers.get("user_bash")?.(
      { command: "curl https://session-only.example", excludeFromContext: true },
      ctx,
    );
    assert.ok(first?.operations);
    assert.equal(promptCount, 1);
    assert.equal(initialized.length, 2);
    assert.equal(resets.length, 1);

    await handlers.get("session_start")?.({}, ctx);
    const sameSession = await handlers.get("user_bash")?.(
      { command: "curl https://session-only.example", excludeFromContext: true },
      ctx,
    );
    assert.ok(sameSession?.operations);
    assert.equal(promptCount, 1);
    assert.equal(initialized.length, 2);

    await handlers.get("session_shutdown")?.({}, ctx);
    const freshContext = makeContext(root, []);
    (freshContext.ui as any).custom = (ctx.ui as any).custom;
    await handlers.get("session_start")?.({}, freshContext);
    const freshSession = await handlers.get("user_bash")?.(
      { command: "curl https://session-only.example", excludeFromContext: true },
      freshContext,
    );
    assert.ok(freshSession?.operations);
    assert.equal(promptCount, 2);
    assert.equal(initialized.length, 4);
    assert.equal(resets.length, 4);
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bash write diagnostics apply shared specificity to direct and nested commands", async () => {
  const root = makeProjectTempDirectory("write-policy-matrix");
  const outsideBase = join(dirname(root), basename(root));
  const defaultTarget = join(root, "default", "output.txt");
  const hardDeniedTarget = join(`${outsideBase}-hard`, "secret.txt");
  const equalDeniedTarget = join(root, "equal", "output.txt");
  const specificAllowedTarget = join(root, "specific", "output.txt");
  const unmatchedTarget = join(`${outsideBase}-unmatched`, "nested", "output.txt");
  const nestedCommand = `bash -c ${shellQuote(`printf x > ${unmatchedTarget}`)}`;
  const outcomes = new Map<string, string[]>();
  const attempts = new Map<string, number>();
  const events: string[] = [];
  const initializedAllowWrites: string[][] = [];
  const managerMock = mock.method(
    SandboxManager,
    "initialize",
    async (config: Parameters<typeof SandboxManager.initialize>[0]) => {
      events.push("initialize");
      initializedAllowWrites.push(config.filesystem?.allowWrite ?? []);
    },
  );
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    events.push("reset");
  });
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async (command: string) => {
    const fixtureCommand = stripOrdinarySshEnvironmentPrefix(command);
    events.push(`wrap:${fixtureCommand}`);
    const attempt = attempts.get(fixtureCommand) ?? 0;
    attempts.set(fixtureCommand, attempt + 1);
    const commandOutcomes = outcomes.get(fixtureCommand);
    assert.ok(commandOutcomes, `missing deterministic runtime fixture for ${fixtureCommand}`);
    return commandOutcomes[Math.min(attempt, commandOutcomes.length - 1)]!;
  });

  async function runUserBash(
    handlers: ReturnType<typeof makePi>["handlers"],
    command: string,
    ctx: ExtensionContext,
  ): Promise<{ result: { exitCode: number | null }; output: string }> {
    const response = await handlers.get("user_bash")?.({ command, excludeFromContext: false }, ctx);
    assert.ok(response?.operations);
    let output = "";
    const result = await response.operations.exec(command, root, {
      onData: (data: Buffer) => {
        output += data.toString();
      },
      timeout: 5,
      env: process.env,
    });
    return { result, output };
  }

  try {
    const { pi, handlers, sentMessages } = makePi();
    extension(pi);
    const ctx = makeContext(root, []);
    await handlers.get("session_start")?.({}, ctx);
    let promptCount = 0;
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("s");
      });

    const defaultCommand = `printf x > ${defaultTarget}`;
    outcomes.set(defaultCommand, [blockedWriteCommand(defaultTarget)]);
    const defaultResult = await runUserBash(handlers, defaultCommand, ctx);
    assert.equal(defaultResult.result.exitCode, 1);
    assert.equal(promptCount, 0);
    assert.equal(attempts.get(defaultCommand), 1);
    assert.match(sentMessages.at(-1)?.content ?? "", /type: write/);
    assert.equal(sentMessages.at(-1)?.content.includes(`target: ${defaultTarget}`), true);
    assert.match(sentMessages.at(-1)?.content ?? "", /rule: allowWrite/);
    assert.match(sentMessages.at(-1)?.content ?? "", /prompted: no/);
    assert.match(sentMessages.at(-1)?.content ?? "", /retried: no/);
    assert.match(sentMessages.at(-1)?.content ?? "", /final_outcome: failure/);
    assert.match(sentMessages.at(-1)?.content ?? "", /action: write access allowed/);

    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "sandbox.json"),
      JSON.stringify({
        filesystem: {
          allowWrite: ["./specific", join(root, "*", "output.txt")],
          denyWrite: [".", hardDeniedTarget, join(root, "equal", "*")],
        },
      }),
    );

    const policyCases = [
      {
        target: hardDeniedTarget,
        rule: "denyWrite",
        action: "blocked by denyWrite; change policy",
      },
      {
        target: equalDeniedTarget,
        rule: "denyWrite",
        action: "blocked by denyWrite; change policy",
      },
      {
        target: specificAllowedTarget,
        rule: "allowWrite",
        action: "write access allowed",
      },
    ] as const;

    for (const policyCase of policyCases) {
      for (const nested of [false, true]) {
        const command = `printf x > ${policyCase.target}`;
        const executedCommand = nested ? `bash -c ${shellQuote(command)}` : command;
        outcomes.set(executedCommand, [blockedWriteCommand(policyCase.target, nested)]);
        const promptCountBefore: number = promptCount;
        assert.equal(promptCountBefore, 0);
        const response = await runUserBash(handlers, executedCommand, ctx);
        assert.equal(response.result.exitCode, 1);
        assert.equal(promptCount, promptCountBefore);
        assert.equal(attempts.get(executedCommand), 1);
        assert.equal(response.output.includes("retrying"), false);

        const diagnostic = sentMessages.at(-1)?.content ?? "";
        assert.match(diagnostic, /type: write/);
        assert.equal(diagnostic.includes(`target: ${policyCase.target}`), true);
        assert.equal(diagnostic.includes(`rule: ${policyCase.rule}`), true);
        assert.match(diagnostic, /prompted: no/);
        assert.match(diagnostic, /choice: none/);
        assert.match(diagnostic, /retried: no/);
        assert.match(diagnostic, /final_outcome: failure/);
        assert.equal(diagnostic.includes(`action: ${policyCase.action}`), true);
      }
    }

    const retryEventsStart = events.length;
    const retryInitializationsStart = initializedAllowWrites.length;
    outcomes.set(nestedCommand, [
      blockedWriteCommand(unmatchedTarget, true),
      "printf nested-success",
    ]);
    const nestedResult = await runUserBash(handlers, nestedCommand, ctx);
    assert.equal(nestedResult.result.exitCode, 0);
    assert.equal(promptCount, 1);
    assert.match(nestedResult.output, /retried successfully/);
    assert.match(sentMessages.at(-1)?.content ?? "", /final_outcome: success/);
    assert.match(sentMessages.at(-1)?.content ?? "", /retried: yes/);
    assert.match(sentMessages.at(-1)?.content ?? "", /choice: session/);
    assert.deepEqual(events.slice(retryEventsStart), [
      `wrap:${nestedCommand}`,
      "reset",
      "initialize",
      `wrap:${nestedCommand}`,
    ]);
    assert.equal(initializedAllowWrites.length, retryInitializationsStart + 1);
    assert.equal(initializedAllowWrites.at(-1)?.includes(unmatchedTarget), true);

    const persisted = JSON.parse(readFileSync(join(root, ".pi", "sandbox.json"), "utf8"));
    assert.equal(persisted.filesystem.allowWrite.includes(unmatchedTarget), false);
  } finally {
    wrapMock.mock.restore();
    resetMock.mock.restore();
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("write approval does not retry after sandbox reinitialization fails", async () => {
  const root = makeProjectTempDirectory("write-refresh-failure");
  const target = join(`${root}-outside`, "output.txt");
  let initializeCount = 0;
  let wrapCount = 0;
  let promptCount = 0;
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    initializeCount += 1;
    if (initializeCount > 1) throw new Error("test refresh failure");
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
    wrapCount += 1;
    return blockedWriteCommand(target);
  });

  try {
    const { pi, handlers, sentMessages } = makePi();
    extension(pi);
    const ctx = makeContext(root, []);
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("s");
      });
    await handlers.get("session_start")?.({}, ctx);

    const response = await handlers.get("user_bash")?.(
      { command: `printf x > ${target}`, excludeFromContext: false },
      ctx,
    );
    assert.ok(response?.operations);
    let output = "";
    const result = await response.operations.exec(`printf x > ${target}`, root, {
      onData: (data: Buffer) => {
        output += data.toString();
      },
      timeout: 5,
      env: process.env,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(promptCount, 1);
    assert.equal(wrapCount, 1);
    assert.equal(initializeCount, 3);
    assert.equal(resetMock.mock.callCount(), 1);
    assert.match(output, /blocked or failed/);
    assert.doesNotMatch(output, /retried successfully/);
    assert.match(sentMessages.at(-1)?.content ?? "", /retried: no/);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);

    // A failed refresh must not leave the rejected session allowance active.
    const secondResponse = await handlers.get("user_bash")?.(
      { command: `printf x > ${target}`, excludeFromContext: false },
      ctx,
    );
    assert.equal(secondResponse?.result?.exitCode, 1);
    assert.equal(secondResponse?.operations, undefined);
    assert.equal(promptCount, 1);
    assert.equal(wrapCount, 1);
    assert.equal(resetMock.mock.callCount(), 1);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);
  } finally {
    wrapMock.mock.restore();
    resetMock.mock.restore();
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered Bash attributes successful and failed write retries in final results", async () => {
  const root = makeProjectTempDirectory("agent-write-diagnostics");
  const processOutsideBase = join(dirname(process.cwd()), basename(process.cwd()));
  const successfulTarget = join(`${processOutsideBase}-success`, "output.txt");
  const failedTarget = join(`${processOutsideBase}-failure`, "output.txt");
  const successfulCommand = `printf x > ${successfulTarget}`;
  const failedCommand = `printf x > ${failedTarget}`;
  const outcomes = new Map<string, string[]>([
    [successfulCommand, [blockedWriteCommand(successfulTarget), "printf agent-success"]],
    [failedCommand, [blockedWriteCommand(failedTarget), blockedWriteCommand(failedTarget)]],
  ]);
  const attempts = new Map<string, number>();
  let promptCount = 0;
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async (command: string) => {
    const fixtureCommand = stripOrdinarySshEnvironmentPrefix(command);
    const attempt = attempts.get(fixtureCommand) ?? 0;
    attempts.set(fixtureCommand, attempt + 1);
    const commandOutcomes = outcomes.get(fixtureCommand);
    assert.ok(commandOutcomes, `missing deterministic runtime fixture for ${fixtureCommand}`);
    return commandOutcomes[Math.min(attempt, commandOutcomes.length - 1)]!;
  });

  try {
    const { pi, handlers, tools, sentMessages } = makePi();
    extension(pi);
    const ctx = makeContext(root, []);
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("s");
      });
    await handlers.get("session_start")?.({}, ctx);

    const bash = tools.get("bash");
    assert.ok(bash);
    const successful = await bash.execute(
      "successful-write",
      { command: successfulCommand, timeout: 5 },
      undefined,
      undefined,
      ctx,
    );
    const successfulText = (successful.content[0] as { text: string }).text;
    assert.match(successfulText, /agent-success/);
    assert.match(successfulText, /<sandbox_diagnostic>/);
    assert.deepEqual(successful.details?.sandboxDiagnostic, {
      type: "write",
      target: successfulTarget,
      rule: "allowWrite",
      prompted: true,
      choice: "session",
      retried: true,
      finalOutcome: "success",
      otherViolations: 0,
      action: "allow and retry",
    });

    await assert.rejects(
      bash.execute(
        "failed-write",
        { command: failedCommand, timeout: 5 },
        undefined,
        undefined,
        ctx,
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /<sandbox_diagnostic>/);
        assert.equal(error.message.includes(`target: ${failedTarget}`), true);
        assert.match(error.message, /retried: yes/);
        assert.match(error.message, /final_outcome: failure/);
        return true;
      },
    );
    assert.equal(promptCount, 2);
    assert.equal(attempts.get(successfulCommand), 2);
    assert.equal(attempts.get(failedCommand), 2);
    assert.equal(resetMock.mock.callCount(), 2);
    assert.deepEqual(sentMessages, []);
  } finally {
    wrapMock.mock.restore();
    resetMock.mock.restore();
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("aborting a Bash write prompt keeps the target blocked without retry", async () => {
  const root = makeProjectTempDirectory("write-prompt-abort");
  const target = join(`${root}-outside`, "output.txt");
  let promptCount = 0;
  let wrapCount = 0;
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
    wrapCount += 1;
    return blockedWriteCommand(target);
  });

  try {
    const { pi, handlers, sentMessages } = makePi();
    extension(pi);
    const ctx = makeContext(root, []);
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("esc");
      });
    await handlers.get("session_start")?.({}, ctx);

    const response = await handlers.get("user_bash")?.(
      { command: `printf x > ${target}`, excludeFromContext: false },
      ctx,
    );
    assert.ok(response?.operations);
    let output = "";
    const result = await response.operations.exec(`printf x > ${target}`, root, {
      onData: (data: Buffer) => {
        output += data.toString();
      },
      timeout: 5,
      env: process.env,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(promptCount, 1);
    assert.equal(wrapCount, 1);
    assert.equal(resetMock.mock.callCount(), 0);
    assert.match(output, /left blocked/);
    assert.match(sentMessages.at(-1)?.content ?? "", /choice: abort/);
    assert.match(sentMessages.at(-1)?.content ?? "", /retried: no/);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);
  } finally {
    wrapMock.mock.restore();
    resetMock.mock.restore();
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("no-UI Bash write failures stay blocked without retry or allowance", async () => {
  const root = makeProjectTempDirectory("write-prompt-no-ui");
  const target = join(`${root}-outside`, "output.txt");
  let wrapCount = 0;
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
    wrapCount += 1;
    return blockedWriteCommand(target);
  });

  try {
    const { pi, handlers, sentMessages } = makePi();
    extension(pi);
    const ctx = makeContext(root, []);
    await handlers.get("session_start")?.({}, ctx);
    ctx.hasUI = false;

    const response = await handlers.get("user_bash")?.(
      { command: `printf x > ${target}`, excludeFromContext: false },
      ctx,
    );
    assert.ok(response?.operations);
    let output = "";
    const result = await response.operations.exec(`printf x > ${target}`, root, {
      onData: (data: Buffer) => {
        output += data.toString();
      },
      timeout: 5,
      env: process.env,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(wrapCount, 1);
    assert.equal(resetMock.mock.callCount(), 0);
    assert.match(output, /blocked or failed/);
    assert.doesNotMatch(output, /retried successfully/);
    assert.match(sentMessages.at(-1)?.content ?? "", /prompted: no/);
    assert.match(sentMessages.at(-1)?.content ?? "", /retried: no/);
    assert.equal(existsSync(join(root, ".pi", "sandbox.json")), false);
  } finally {
    wrapMock.mock.restore();
    resetMock.mock.restore();
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("user_bash shows a compact notice and sends raw diagnostic metadata invisibly", async () => {
  const root = makeProjectTempDirectory("user-bash-diagnostic");
  let wrapCount = 0;
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
    wrapCount += 1;
    return "printf 'cat: /outside/secret: Operation not permitted\\n' >&2; exit 1";
  });

  try {
    const { pi, handlers, sentMessages } = makePi();
    extension(pi);
    const ctx = makeContext(root, []);
    ctx.hasUI = false;
    await handlers.get("session_start")?.({}, ctx);

    const response = await handlers.get("user_bash")?.(
      { command: "cat /outside/secret", excludeFromContext: false },
      ctx,
    );
    assert.ok(response?.operations);
    let output = "";
    const result = await response.operations.exec("cat /outside/secret", root, {
      onData: (data: Buffer) => {
        output += data.toString();
      },
      timeout: 5,
      env: process.env,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(wrapCount, 1);
    assert.equal(resetMock.mock.callCount(), 0);
    assert.match(output, /\[sandbox: read access; blocked or failed/);
    assert.doesNotMatch(output, /<sandbox_diagnostic>/);
    assert.equal(sentMessages.length, 1);
    assert.deepEqual(
      {
        customType: sentMessages[0]?.customType,
        display: sentMessages[0]?.display,
      },
      { customType: "sandbox-diagnostic", display: false },
    );
    assert.match(sentMessages[0]?.content ?? "", /<sandbox_diagnostic>/);
    assert.match(sentMessages[0]?.content ?? "", /final_outcome: failure/);
  } finally {
    wrapMock.mock.restore();
    resetMock.mock.restore();
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic retries prompt once per materially changed violation", async () => {
  const root = makeProjectTempDirectory("diagnostic-retries");
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  let attempt = 0;
  const outputs = [
    "printf 'touch: /outside/first: Operation not permitted\\n' >&2; exit 1",
    "printf 'touch: /outside/second: Operation not permitted\\n' >&2; exit 1",
    "printf success",
  ];
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
    const command = outputs[attempt] ?? outputs.at(-1)!;
    attempt += 1;
    return command;
  });

  try {
    const { pi, handlers, sentMessages } = makePi();
    extension(pi);
    const ctx = makeContext(root, []);
    let promptCount = 0;
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        let component: any;
        component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("s");
      });
    await handlers.get("session_start")?.({}, ctx);

    const response = await handlers.get("user_bash")?.(
      { command: "touch /outside/first /outside/second", excludeFromContext: false },
      ctx,
    );
    let output = "";
    const result = await response.operations.exec("touch /outside/first /outside/second", root, {
      onData: (data: Buffer) => {
        output += data.toString();
      },
      timeout: 5,
      env: process.env,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(promptCount, 2);
    assert.equal(attempt, 3);
    assert.match(output, /retried successfully/);
    assert.match(sentMessages[0]?.content ?? "", /other_violations: 1/);
    assert.match(sentMessages[0]?.content ?? "", /final_outcome: success/);
  } finally {
    wrapMock.mock.restore();
    resetMock.mock.restore();
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic retries do not prompt twice for the same violation", async () => {
  const root = makeProjectTempDirectory("diagnostic-duplicate");
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const resetMock = mock.method(SandboxManager, "reset", async () => undefined);
  let attempt = 0;
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
    attempt += 1;
    return "printf 'touch: /outside/repeated: Operation not permitted\\n' >&2; exit 1";
  });

  try {
    const { pi, handlers, sentMessages } = makePi();
    extension(pi);
    const ctx = makeContext(root, []);
    let promptCount = 0;
    (ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        let component: any;
        component = factory(
          { requestRender: () => undefined },
          { fg: (_colour: string, text: string) => text },
          {},
          (result: unknown) => resolve(result),
        );
        promptCount += 1;
        component.handleInput("s");
      });
    await handlers.get("session_start")?.({}, ctx);

    const response = await handlers.get("user_bash")?.(
      { command: "touch /outside/repeated", excludeFromContext: false },
      ctx,
    );
    let output = "";
    const result = await response.operations.exec("touch /outside/repeated", root, {
      onData: (data: Buffer) => {
        output += data.toString();
      },
      timeout: 5,
      env: process.env,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(promptCount, 1);
    assert.equal(attempt, 2);
    assert.match(output, /retried but still failed/);
    assert.match(sentMessages.at(-1)?.content ?? "", /final_outcome: failure/);
  } finally {
    wrapMock.mock.restore();
    resetMock.mock.restore();
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});
