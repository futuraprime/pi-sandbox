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
import { join } from "node:path";
import test, { mock } from "node:test";

import { SandboxManager } from "@carderne/sandbox-runtime";
import assert from "node:assert/strict";

import extension from "../src/extension.ts";

function makePi() {
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any>>();
  const tools = new Map<string, any>();
  const pi = {
    registerFlag: () => undefined,
    getFlag: () => false,
    registerTool: (definition: { name: string }) => {
      tools.set(definition.name, definition);
    },
    registerShortcut: () => undefined,
    registerCommand: (
      name: string,
      definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => {
      commands.set(name, definition.handler);
    },
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any>) => {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, handlers, tools };
}

function makeProjectTempDirectory(prefix: string): string {
  return mkdtempSync(join(process.cwd(), `.pi-sandbox-${prefix}-`));
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

function makeContext(cwd: string, notices: string[]): ExtensionContext {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: () => undefined,
      theme: { fg: (_colour: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
}

test("/sandbox exercises all six project-only rules and refreshes only after changes", async () => {
  const root = makeProjectTempDirectory("extension");
  const agentDir = join(root, "global-agent");
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
    extension(pi);
    const ctx = makeContext(root, notices);

    assert.equal(commands.has("sandbox-allow"), false);
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(initialised.length, 1);

    const rules = [
      "allowRead ./allowed-read",
      "denyRead ./denied-read",
      "allowWrite ./allowed-write",
      "denyWrite *.secret",
      "allowedDomains allowed.example",
      "deniedDomains denied.example",
    ];
    for (const rule of rules) await commands.get("sandbox")?.(rule, ctx);

    assert.equal(resets.length, rules.length);
    assert.equal(initialised.length, rules.length + 1);
    const projectConfig = JSON.parse(readFileSync(join(root, ".pi", "sandbox.json"), "utf8"));
    assert.deepEqual(projectConfig, {
      filesystem: {
        allowRead: ["./allowed-read"],
        denyRead: ["./denied-read"],
        allowWrite: ["./allowed-write"],
        denyWrite: ["*.secret"],
      },
      network: { allowedDomains: ["allowed.example"], deniedDomains: ["denied.example"] },
    });
    assert.equal(existsSync(join(agentDir, "sandbox.json")), false);
    assert.equal(requireNotice(notices, "Updated: " + join(root, ".pi", "sandbox.json")), true);

    const resetCount = resets.length;
    await commands.get("sandbox")?.(`allowRead ${join(root, "allowed-read")}`, ctx);
    assert.equal(resets.length, resetCount);
    assert.match(notices.at(-1) ?? "", /^Already present:/);

    await commands.get("sandbox")?.("", ctx);
    assert.match(notices.at(-1) ?? "", /Sandbox Configuration/);
    assert.equal(initialised.length, rules.length + 1);
    assert.equal(resets.length, rules.length);
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("/sandbox warns when persistence succeeds but active runtime refresh fails", async () => {
  const root = makeProjectTempDirectory("extension-refresh-failure");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "global-agent");
  const initialised: string[] = [];
  const resets: string[] = [];
  const notices: string[] = [];
  const managerMock = mock.method(SandboxManager, "initialize", async () => {
    initialised.push("initialize");
    if (initialised.length > 1) throw new Error("test refresh failure");
  });
  const resetMock = mock.method(SandboxManager, "reset", async () => {
    resets.push("reset");
  });
  let wrapMock: ReturnType<typeof mock.method> | undefined;

  try {
    const { pi, commands, handlers, tools } = makePi();
    extension(pi);
    const ctx = makeContext(root, notices);

    await handlers.get("session_start")?.({}, ctx);
    await commands.get("sandbox")?.("allowRead ./refresh-read", ctx);

    assert.equal(initialised.length, 2);
    assert.equal(resets.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".pi", "sandbox.json"), "utf8")), {
      filesystem: { allowRead: ["./refresh-read"] },
    });
    assert.match(notices.at(-1) ?? "", /active sandbox runtime was not refreshed/i);

    const wrappedCommands: string[] = [];
    wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async (command: string) => {
      wrappedCommands.push(command);
      return "printf sandboxed";
    });
    const bashTool = tools.get("bash");
    assert.ok(bashTool);
    const result = await bashTool.execute(
      "test",
      { command: "printf local" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(wrappedCommands.length, 1);
    assert.ok(result);
    assert.match((result.content[0] as { text: string }).text, /sandboxed/);
  } finally {
    wrapMock?.mock.restore();
    managerMock.mock.restore();
    resetMock.mock.restore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
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
    assert.equal(firstConfig.filesystem.allowRead.includes(fixture.secondCommonDir), false);

    ctx.cwd = fixture.second;
    await handlers.get("session_start")?.({}, ctx);
    const secondConfig = initialised[1] as any;
    assert.equal(secondConfig.filesystem.allowRead.includes(fixture.secondCommonDir), true);
    assert.equal(secondConfig.filesystem.allowRead.includes(fixture.firstCommonDir), false);
    assert.equal(resets.length, 1);

    await commands.get("sandbox")?.("", ctx);
    assert.match(
      notices.at(-1) ?? "",
      new RegExp(`Linked Git metadata: ${fixture.secondCommonDir}`),
    );

    ctx.hasUI = false;
    const firstCheckout = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: fixture.firstRepository } },
      ctx,
    );
    const sibling = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: join(fixture.sibling, "HEAD") } },
      ctx,
    );
    const commonMetadata = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: join(fixture.secondCommonDir, "HEAD") } },
      ctx,
    );
    assert.equal(firstCheckout?.block, true);
    assert.equal(sibling?.block, true);
    assert.equal(commonMetadata, undefined);

    mkdirSync(join(fixture.second, ".pi"));
    writeFileSync(
      join(fixture.second, ".pi", "sandbox.json"),
      JSON.stringify({ filesystem: { denyRead: [fixture.secondCommonDir] } }),
    );
    const deniedCommonMetadata = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: join(fixture.secondCommonDir, "HEAD") } },
      ctx,
    );
    assert.equal(deniedCommonMetadata?.block, true);
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    rmSync(fixture.firstRepository, { recursive: true, force: true });
    rmSync(fixture.secondRepository, { recursive: true, force: true });
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
    assert.match(bash?.reason ?? "", /use \/sandbox/i);
    assert.match(userBash?.result?.output ?? "", /use \/sandbox/i);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

function requireNotice(notices: string[], expected: string): boolean {
  return notices.some((notice) => notice.includes(expected));
}
