import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SandboxManager } from "@carderne/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import sandboxExtension from "./index";

type Handler = (event: unknown, ctx: any) => unknown;
type Command = { handler: (args: string, ctx: any) => unknown };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const pi = {
    registerFlag: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: Command) => commands.set(name, command)),
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    getFlag: vi.fn(() => false),
  };
  sandboxExtension(pi as any);

  const ui = {
    custom: vi.fn(),
    notify: vi.fn(),
    setStatus: vi.fn(),
    theme: { fg: (_colour: string, text: string) => text },
  };
  const ctx = { cwd: process.cwd(), hasUI: false, ui };

  return { commands, ctx, handlers, ui };
}

const temporaryDirectories: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeLinkedWorktree(): {
  repository: string;
  worktree: string;
  sibling: string;
  commonDir: string;
} {
  const repository = mkdtempSync(join(tmpdir(), "pi-sandbox-lifecycle-repo-"));
  temporaryDirectories.push(repository);
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "Test User"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["commit", "--allow-empty", "-m", "initial"]);
  const worktree = join(repository, "linked-worktree");
  const sibling = join(repository, "sibling-worktree");
  git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
  git(repository, ["worktree", "add", "--detach", sibling, "HEAD"]);
  writeFileSync(join(repository, "original-checkout.txt"), "original");
  writeFileSync(join(sibling, "sibling-worktree.txt"), "sibling");
  return { repository, worktree, sibling, commonDir: realpathSync(join(repository, ".git")) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

describe("sandbox lifecycle", () => {
  it("ignores successful initialisation after session shutdown", async () => {
    const initialisation = deferred<void>();
    vi.spyOn(SandboxManager, "initialize").mockImplementation(() => initialisation.promise);
    vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined);
    const { commands, ctx, handlers, ui } = createHarness();

    const start = handlers.get("session_start")?.({}, ctx);
    await Promise.resolve();
    await handlers.get("session_shutdown")?.({}, ctx);
    ui.setStatus.mockClear();
    ui.notify.mockClear();

    initialisation.resolve();
    await start;

    expect(ui.setStatus).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
    await commands.get("sandbox")?.handler("", ctx);
    expect(ui.notify).toHaveBeenCalledWith("Sandbox is disabled", "info");
  });

  it("ignores an obsolete initialisation failure after replacement", async () => {
    const firstInitialisation = deferred<void>();
    vi.spyOn(SandboxManager, "initialize")
      .mockImplementationOnce(() => firstInitialisation.promise)
      .mockResolvedValueOnce(undefined);
    const { ctx, handlers, ui } = createHarness();

    const obsoleteStart = handlers.get("session_start")?.({}, ctx);
    await Promise.resolve();
    await handlers.get("session_start")?.({}, ctx);
    ui.setStatus.mockClear();
    ui.notify.mockClear();

    firstInitialisation.reject(new Error("obsolete failure"));
    await obsoleteStart;

    expect(ui.setStatus).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("uses the active worktree for initialization, reinitialization, and visibility", async () => {
    vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
    vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined);
    const first = makeLinkedWorktree();
    const second = makeLinkedWorktree();
    const { commands, ctx, handlers, ui } = createHarness();

    ctx.cwd = first.worktree;
    await handlers.get("session_start")?.({}, ctx);
    const firstConfig = vi.mocked(SandboxManager.initialize).mock.calls[0][0] as any;
    expect(firstConfig.filesystem.allowRead).toContain(first.commonDir);
    expect(firstConfig.filesystem.allowWrite).toContain(first.commonDir);
    expect(firstConfig.filesystem.allowRead).not.toContain(second.commonDir);

    ctx.cwd = second.worktree;
    await handlers.get("session_start")?.({}, ctx);
    const secondConfig = vi.mocked(SandboxManager.initialize).mock.calls[1][0] as any;
    const readCommonMetadata = await handlers.get("tool_call")?.(
      {
        type: "tool_call",
        toolCallId: "read-common",
        toolName: "read",
        input: { path: join(second.commonDir, "HEAD") },
      },
      ctx,
    );
    expect(readCommonMetadata).toBeUndefined();

    const readOriginalCheckout = await handlers.get("tool_call")?.(
      {
        type: "tool_call",
        toolCallId: "read-original",
        toolName: "read",
        input: { path: join(second.repository, "original-checkout.txt") },
      },
      ctx,
    );
    const readSiblingWorktree = await handlers.get("tool_call")?.(
      {
        type: "tool_call",
        toolCallId: "read-sibling",
        toolName: "read",
        input: { path: join(second.sibling, "sibling-worktree.txt") },
      },
      ctx,
    );
    expect(readOriginalCheckout).toMatchObject({ block: true });
    expect(readSiblingWorktree).toMatchObject({ block: true });

    await commands.get("sandbox")?.handler("", ctx);
    expect(ui.notify.mock.lastCall?.[0]).toContain(`Linked Git metadata: ${second.commonDir}`);
    expect(existsSync(join(second.worktree, ".pi", "sandbox.json"))).toBe(false);

    mkdirSync(join(second.worktree, ".pi"));
    writeFileSync(
      join(second.worktree, ".pi", "sandbox.json"),
      JSON.stringify({ filesystem: { denyRead: [second.commonDir] } }),
    );
    const deniedCommonMetadata = await handlers.get("tool_call")?.(
      {
        type: "tool_call",
        toolCallId: "read-denied-common",
        toolName: "read",
        input: { path: join(second.commonDir, "HEAD") },
      },
      ctx,
    );
    expect(deniedCommonMetadata).toMatchObject({ block: true });
    expect(secondConfig.filesystem.allowRead).toContain(second.commonDir);
    expect(secondConfig.filesystem.allowWrite).toContain(second.commonDir);
    expect(secondConfig.filesystem.allowRead).not.toContain(first.commonDir);

    await commands.get("sandbox")?.handler("allowRead /tmp/lifecycle-policy", ctx);
    const reinitializedConfig = vi.mocked(SandboxManager.initialize).mock.calls[2][0] as any;
    expect(reinitializedConfig.filesystem.allowRead).toContain(second.commonDir);
    expect(reinitializedConfig.filesystem.allowRead).not.toContain(first.commonDir);

    await handlers.get("session_shutdown")?.({}, ctx);
  });

  it("preserves the existing runtime lifecycle for session-approved paths", async () => {
    vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
    vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined);
    const first = makeLinkedWorktree();
    const second = makeLinkedWorktree();
    const { ctx, handlers, ui } = createHarness();
    ctx.hasUI = true;
    ui.custom.mockResolvedValue("session");

    ctx.cwd = first.worktree;
    await handlers.get("session_start")?.({}, ctx);
    const approvedPath = realpathSync(join(first.repository, "original-checkout.txt"));
    await handlers.get("tool_call")?.(
      {
        type: "tool_call",
        toolCallId: "approve-read",
        toolName: "read",
        input: { path: approvedPath },
      },
      ctx,
    );
    const reinitialisedConfig = vi.mocked(SandboxManager.initialize).mock.calls[1][0] as any;
    expect(reinitialisedConfig.filesystem.allowRead).toContain(approvedPath);

    await handlers.get("session_shutdown")?.({}, ctx);
    ctx.cwd = second.worktree;
    await handlers.get("session_start")?.({}, ctx);

    const replacementConfig = vi.mocked(SandboxManager.initialize).mock.calls[2][0] as any;
    expect(replacementConfig.filesystem.allowRead).not.toContain(approvedPath);
    expect(replacementConfig.filesystem.allowRead).toContain(second.commonDir);
  });

  it("ignores session_start when its context is already stale", async () => {
    const initialize = vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
    const { handlers } = createHarness();
    const staleCtx = {
      get cwd(): string {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
      get ui(): never {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    };

    await expect(handlers.get("session_start")?.({}, staleCtx)).resolves.toBeUndefined();
    expect(initialize).not.toHaveBeenCalled();
  });
});
