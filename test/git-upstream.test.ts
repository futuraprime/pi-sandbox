import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  runGitCommand,
  setGitUpstream,
  type GitCommand,
  type GitCommandResult,
  type GitUpstreamInput,
} from "../src/git-upstream.ts";

const temporaryDirectories: string[] = [];

test.afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepository(): string {
  const directory = mkdtempSync(join(process.cwd(), ".pi-sandbox-git-upstream-"));
  temporaryDirectories.push(directory);
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, ["config", "user.name", "Test User"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  git(directory, ["commit", "--allow-empty", "-m", "initial"]);
  git(directory, ["remote", "add", "origin", join(directory, "remote")]);
  git(directory, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return directory;
}

function input(cwd: string, overrides: Partial<GitUpstreamInput> = {}): GitUpstreamInput {
  return {
    cwd,
    localBranch: "main",
    remote: "origin",
    remoteBranch: "main",
    ...overrides,
  };
}

function fakeRunner(
  commands: GitCommand[],
  remoteOutput = "origin\n",
): (command: GitCommand, signal?: AbortSignal) => Promise<GitCommandResult> {
  return async (command) => {
    commands.push(command);
    if (command.args.includes("check-ref-format")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.args.includes("show-ref")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.args.includes("remote")) {
      return { exitCode: 0, stdout: remoteOutput, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

async function waitForFileContent(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(expected)) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${path} to contain ${expected}`);
}

test("sets tracking for an existing origin remote", async () => {
  const directory = makeRepository();
  git(directory, ["config", "--local", "branch.main.remote", "old-origin"]);
  git(directory, ["config", "--local", "branch.main.merge", "refs/heads/old-main"]);
  git(directory, ["config", "--local", "branch.main.rebase", "true"]);
  const remoteAliasMarker = join(directory, "remote-alias-ran");
  const branchAliasMarker = join(directory, "branch-alias-ran");
  git(directory, ["config", "--local", "alias.remote", `!touch ${remoteAliasMarker}`]);
  git(directory, ["config", "--local", "alias.branch", `!touch ${branchAliasMarker}`]);
  git(directory, ["config", "--local", "branch.other.remote", "backup"]);
  git(directory, ["config", "--local", "branch.other.merge", "refs/heads/other"]);
  git(directory, ["config", "--local", "unrelated.keep", "preserved"]);

  await setGitUpstream(input(directory));

  assert.equal(
    git(directory, ["config", "--local", "--get", "branch.main.remote"]).trim(),
    "origin",
  );
  assert.equal(
    git(directory, ["config", "--local", "--get", "branch.main.merge"]).trim(),
    "refs/heads/main",
  );
  assert.equal(git(directory, ["config", "--local", "--get", "branch.main.rebase"]).trim(), "true");
  assert.equal(existsSync(remoteAliasMarker), false);
  assert.equal(existsSync(branchAliasMarker), false);
  assert.equal(
    git(directory, ["config", "--local", "--get", "branch.other.remote"]).trim(),
    "backup",
  );
  assert.equal(
    git(directory, ["config", "--local", "--get", "branch.other.merge"]).trim(),
    "refs/heads/other",
  );
  assert.equal(
    git(directory, ["config", "--local", "--get", "unrelated.keep"]).trim(),
    "preserved",
  );
});

test("uses fixed non-shell arguments and validates existing refs", async () => {
  const commands: GitCommand[] = [];

  await setGitUpstream(
    input("/tmp/repository", { remoteBranch: "feature/topic" }),
    fakeRunner(commands),
  );

  assert.deepEqual(commands, [
    {
      cwd: "/tmp/repository",
      args: ["-c", "alias.check-ref-format=", "check-ref-format", "--branch", "main"],
    },
    {
      cwd: "/tmp/repository",
      args: ["-c", "alias.show-ref=", "show-ref", "--verify", "--quiet", "refs/heads/main"],
    },
    {
      cwd: "/tmp/repository",
      args: ["-c", "alias.check-ref-format=", "check-ref-format", "--branch", "feature/topic"],
    },
    {
      cwd: "/tmp/repository",
      args: [
        "-c",
        "alias.show-ref=",
        "show-ref",
        "--verify",
        "--quiet",
        "refs/remotes/origin/feature/topic",
      ],
    },
    { cwd: "/tmp/repository", args: ["-c", "alias.remote=", "remote"] },
    {
      cwd: "/tmp/repository",
      args: [
        "-c",
        "alias.branch=",
        "branch",
        "--set-upstream-to=origin/feature/topic",
        "--",
        "main",
      ],
    },
  ]);
});

test("rejects invalid input, non-origin remotes, and missing refs", async () => {
  const directory = makeRepository();
  const invalidInputs: unknown[] = [
    { ...input(directory), localBranch: "main; touch escaped" },
    { ...input(directory), localBranch: "--config=core.editor=escaped" },
    { ...input(directory), remote: "upstream" },
    { ...input(directory), remoteBranch: "../main" },
    { ...input(directory), remoteBranch: "main; touch escaped" },
    { ...input(directory), extra: true },
    { ...input(directory), cwd: "relative/repository" },
  ];

  for (const value of invalidInputs)
    await assert.rejects(setGitUpstream(value as GitUpstreamInput), /invalid/i);
  await assert.rejects(
    setGitUpstream(input(directory, { remoteBranch: "missing" })),
    /existing remote branch/i,
  );

  const commands: GitCommand[] = [];
  await assert.rejects(
    setGitUpstream(input("/tmp/repository"), fakeRunner(commands, "backup\n")),
    /origin/i,
  );
});

test("sanitizes repository and config redirection variables while preserving local config", async () => {
  const directory = makeRepository();
  const external = mkdtempSync(join(process.cwd(), ".pi-sandbox-git-environment-"));
  temporaryDirectories.push(external);
  const marker = join(external, "should-not-exist");
  writeFileSync(join(external, "global.gitconfig"), `[alias]\nremote = !touch ${marker}\n`);
  const oldEnvironment = { ...process.env };
  Object.assign(process.env, {
    GIT_DIR: join(external, ".git"),
    GIT_COMMON_DIR: external,
    GIT_CONFIG: join(external, "config"),
    GIT_CONFIG_GLOBAL: join(external, "global.gitconfig"),
    GIT_CONFIG_SYSTEM: join(external, "global.gitconfig"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: external,
    GIT_INDEX_FILE: join(external, "index"),
    GIT_OBJECT_DIRECTORY: external,
    GIT_WORK_TREE: external,
  });

  try {
    await setGitUpstream(input(directory));
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in oldEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, oldEnvironment);
  }

  assert.equal(existsSync(marker), false);
  assert.equal(
    git(directory, ["config", "--local", "--get", "branch.main.remote"]).trim(),
    "origin",
  );
  assert.equal(
    readFileSync(join(directory, ".git", "config"), "utf8").includes("unrelated"),
    false,
  );
});

test("cancels before any Git subprocess starts", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runGitCommand({ cwd: "/tmp/repository", args: ["version"] }, controller.signal),
    /aborted/i,
  );

  const commands: GitCommand[] = [];
  await assert.rejects(
    setGitUpstream(input("/tmp/repository"), fakeRunner(commands), controller.signal),
    /aborted/i,
  );
  assert.deepEqual(commands, []);
});

test("terminates an in-flight Git subprocess when cancelled", { timeout: 5_000 }, async () => {
  const directory = mkdtempSync(join(process.cwd(), ".pi-sandbox-git-cancellation-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "git");
  const marker = join(directory, "process-state");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const marker = process.env.PI_SANDBOX_GIT_TEST_MARKER;
if (!marker) process.exit(2);
writeFileSync(marker, "started");
process.on("SIGTERM", () => {
  appendFileSync(marker, ":terminated");
  process.exit(0);
});
setInterval(() => {}, 1_000);
`,
  );
  chmodSync(executable, 0o755);

  const oldPath = process.env.PATH;
  const oldMarker = process.env.PI_SANDBOX_GIT_TEST_MARKER;
  process.env.PATH = `${directory}${delimiter}${oldPath ?? ""}`;
  process.env.PI_SANDBOX_GIT_TEST_MARKER = marker;

  const controller = new AbortController();
  let commandPromise: ReturnType<typeof runGitCommand> | undefined;
  try {
    commandPromise = runGitCommand({ cwd: directory, args: ["version"] }, controller.signal);
    await waitForFileContent(marker, "started");
    controller.abort();
    await assert.rejects(commandPromise, /aborted/i);
    await waitForFileContent(marker, "terminated");
  } finally {
    controller.abort();
    await commandPromise?.catch(() => undefined);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldMarker === undefined) delete process.env.PI_SANDBOX_GIT_TEST_MARKER;
    else process.env.PI_SANDBOX_GIT_TEST_MARKER = oldMarker;
  }
});
