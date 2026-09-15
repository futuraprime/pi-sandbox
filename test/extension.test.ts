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

import { renderDiagnosticBlockData, type SandboxDiagnosticBlockData } from "../src/diagnostics.ts";
import extension from "../src/extension.ts";
import {
  gitUpstreamMutationCommands,
  nonGitUpstreamMutationCommands,
} from "./git-upstream-command-fixtures.ts";

type StatusUpdate = { key: string; value: string | undefined };

function makePi(options: { noSandbox?: boolean } = {}) {
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any>>();
  const tools = new Map<string, any>();
  const sentMessages: Array<{ customType: string; content: string; display: boolean }> = [];
  const pi = {
    registerFlag: () => undefined,
    getFlag: (name: string) => name === "no-sandbox" && options.noSandbox === true,
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
    sendMessage: (message: { customType: string; content: string; display: boolean }) => {
      sentMessages.push(message);
    },
    events: { emit: () => undefined },
  } as unknown as ExtensionAPI;
  return { pi, commands, handlers, tools, sentMessages };
}

function makeProjectTempDirectory(prefix: string): string {
  return mkdtempSync(join(process.cwd(), `.pi-sandbox-${prefix}-`));
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
    assert.equal(firstConfig.filesystem.allowWrite.includes(fixture.firstCommonDir), true);
    assert.equal(firstConfig.filesystem.allowRead.includes(fixture.secondCommonDir), false);
    assert.equal(firstConfig.filesystem.allowWrite.includes(fixture.secondCommonDir), false);

    ctx.cwd = fixture.second;
    await handlers.get("session_start")?.({}, ctx);
    const secondConfig = initialised[1] as any;
    assert.equal(secondConfig.filesystem.allowRead.includes(fixture.secondCommonDir), true);
    assert.equal(secondConfig.filesystem.allowWrite.includes(fixture.secondCommonDir), true);
    assert.equal(secondConfig.filesystem.allowRead.includes(fixture.firstCommonDir), false);
    assert.equal(secondConfig.filesystem.allowWrite.includes(fixture.firstCommonDir), false);
    assert.equal(resets.length, 1);

    await commands.get("sandbox")?.("", ctx);
    assert.match(
      notices.at(-1) ?? "",
      new RegExp(`Linked Git metadata: ${fixture.secondCommonDir}`),
    );

    // A broader deny still permits the more-specific derived common Git path,
    // while checked-out files in the original and sibling worktrees remain
    // outside the derived allowance.
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
    assert.equal(commonWrite, undefined);
    assert.equal(commonEdit, undefined);

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

test("macOS SSH preflight grants session access only during diagnostic execution", async () => {
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
      { command: "ssh host; printf done", excludeFromContext: true },
      ctx,
    );
    assert.ok(response?.operations);
    const result = await response.operations.exec("ssh host; printf done", root, {
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

test("macOS SSH preflight records one clean denied incident", async () => {
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
      { command: "ssh host; printf done", excludeFromContext: false },
      ctx,
    );
    assert.ok(response?.operations);
    let output = "";
    const result = await response.operations.exec("ssh host; printf done", root, {
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

test("macOS SSH preflight rolls back a failed grant before retrying", async () => {
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
      { command: "ssh host; printf done", excludeFromContext: true },
      ctx,
    );
    assert.ok(first?.operations);
    const denied = await first.operations.exec("ssh host; printf done", root, {
      onData: () => undefined,
      timeout: 5,
      env: process.env,
    });
    assert.equal(denied.exitCode, 1);

    const second = await handlers.get("user_bash")?.(
      { command: "ssh host; printf done", excludeFromContext: true },
      ctx,
    );
    assert.ok(second?.operations);
    const recovered = await second.operations.exec("ssh host; printf done", root, {
      onData: () => undefined,
      timeout: 5,
      env: process.env,
    });
    assert.equal(recovered.exitCode, 0);
    assert.equal(promptCount, 2);
    assert.equal(resetMock.mock.callCount(), 2);
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
    await handlers.get("session_start")?.({}, ctx);
    const freshSession = await handlers.get("user_bash")?.(
      { command: "curl https://session-only.example", excludeFromContext: true },
      ctx,
    );
    assert.ok(freshSession?.operations);
    assert.equal(promptCount, 2);
    assert.equal(initialized.length, 4);
    assert.equal(resets.length, 3);
  } finally {
    managerMock.mock.restore();
    resetMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("user_bash shows a compact notice and sends raw diagnostic metadata invisibly", async () => {
  const root = makeProjectTempDirectory("user-bash-diagnostic");
  const managerMock = mock.method(SandboxManager, "initialize", async () => undefined);
  const wrapMock = mock.method(SandboxManager, "wrapWithSandbox", async () => {
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
    const { pi, handlers } = makePi();
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
      { command: "touch /outside/repeated", excludeFromContext: true },
      ctx,
    );
    const result = await response.operations.exec("touch /outside/repeated", root, {
      onData: () => undefined,
      timeout: 5,
      env: process.env,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(promptCount, 1);
    assert.equal(attempt, 2);
  } finally {
    wrapMock.mock.restore();
    resetMock.mock.restore();
    managerMock.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

function requireNotice(notices: string[], expected: string): boolean {
  return notices.some((notice) => notice.includes(expected));
}
