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
    notify: vi.fn(),
    setStatus: vi.fn(),
    theme: { fg: (_colour: string, text: string) => text },
  };
  const ctx = { cwd: process.cwd(), ui };

  return { commands, ctx, handlers, ui };
}

afterEach(() => {
  vi.restoreAllMocks();
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
