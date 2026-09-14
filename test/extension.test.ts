import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import { SandboxManager } from "@carderne/sandbox-runtime";
import assert from "node:assert/strict";

import extension from "../src/extension.ts";

function makePi() {
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any>>();
  const pi = {
    registerFlag: () => undefined,
    getFlag: () => false,
    registerTool: () => undefined,
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
  return { pi, commands, handlers };
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

test("/sandbox supports project-only mutations and refreshes an active sandbox only after changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-extension-"));
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

    await commands.get("sandbox")?.("allowWrite ./generated", ctx);
    assert.equal(resets.length, 1);
    assert.equal(initialised.length, 2);
    assert.match(notices.at(-1) ?? "", /Added: \.,?\/generated|Added: \.\/generated/);

    const projectConfig = JSON.parse(readFileSync(join(root, ".pi", "sandbox.json"), "utf8"));
    assert.deepEqual(projectConfig, { filesystem: { allowWrite: ["./generated"] } });
    assert.equal(requireNotice(notices, "Updated: " + join(root, ".pi", "sandbox.json")), true);

    const resetCount = resets.length;
    await commands.get("sandbox")?.("allowWrite ./generated", ctx);
    assert.equal(resets.length, resetCount);
    assert.match(notices.at(-1) ?? "", /^Already present:/);

    await commands.get("sandbox")?.("", ctx);
    assert.match(notices.at(-1) ?? "", /Sandbox Configuration/);
    assert.equal(initialised.length, 2);
    assert.equal(resets.length, 1);
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected direct writes and Bash mentions are blocked before sandbox state checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-extension-protection-"));
  const notices: string[] = [];
  try {
    const { pi, handlers } = makePi();
    extension(pi);
    const ctx = makeContext(root, notices);
    const direct = await handlers.get("tool_call")?.(
      { toolName: "write", input: { path: join(root, ".pi", "sandbox.json") } },
      ctx,
    );
    const bash = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: "echo x > .pi/sandbox.json" } },
      ctx,
    );

    assert.equal(direct?.block, true);
    assert.equal(bash?.block, true);
    assert.match(direct?.reason ?? "", /protected/);
    assert.match(bash?.reason ?? "", /use \/sandbox/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function requireNotice(notices: string[], expected: string): boolean {
  return notices.some((notice) => notice.includes(expected));
}
