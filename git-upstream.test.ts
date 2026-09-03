import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runGitCommand,
  setGitUpstream,
  type GitCommand,
  type GitCommandResult,
  type GitUpstreamInput,
} from "./git-upstream";

const temporaryDirectories: string[] = [];

function makeRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-sandbox-git-upstream-"));
  temporaryDirectories.push(directory);
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, ["config", "user.name", "Test User"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  git(directory, ["commit", "--allow-empty", "-m", "initial"]);
  git(directory, ["remote", "add", "origin", join(directory, "remote")]);
  git(directory, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function fakeRunner(
  commands: GitCommand[],
  remoteOutput = "origin\n",
): (command: GitCommand) => Promise<GitCommandResult> {
  return async (command) => {
    commands.push(command);
    if (command.args[2] === "check-ref-format") {
      try {
        execFileSync("git", [...command.args], { stdio: "ignore" });
        return { exitCode: 0, stdout: "", stderr: "" };
      } catch {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
    }
    if (command.args[2] === "remote") {
      return { exitCode: 0, stdout: remoteOutput, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function input(overrides: Partial<GitUpstreamInput> = {}): GitUpstreamInput {
  return {
    cwd: "/tmp/repository",
    localBranch: "main",
    remote: "origin",
    remoteBranch: "main",
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

describe("setGitUpstream", () => {
  it("sets tracking for an existing origin remote", async () => {
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

    await setGitUpstream({ ...input(), cwd: directory }, runGitCommand);

    expect(git(directory, ["config", "--local", "--get", "branch.main.remote"]).trim()).toBe(
      "origin",
    );
    expect(git(directory, ["config", "--local", "--get", "branch.main.merge"]).trim()).toBe(
      "refs/heads/main",
    );
    expect(git(directory, ["config", "--local", "--get", "branch.main.rebase"]).trim()).toBe(
      "true",
    );
    expect(existsSync(remoteAliasMarker)).toBe(false);
    expect(existsSync(branchAliasMarker)).toBe(false);
    expect(git(directory, ["config", "--local", "--get", "branch.other.remote"]).trim()).toBe(
      "backup",
    );
    expect(git(directory, ["config", "--local", "--get", "branch.other.merge"]).trim()).toBe(
      "refs/heads/other",
    );
    expect(git(directory, ["config", "--local", "--get", "unrelated.keep"]).trim()).toBe(
      "preserved",
    );
  });

  it("uses only fixed non-shell Git arguments", async () => {
    const commands: GitCommand[] = [];

    await setGitUpstream(input({ remoteBranch: "feature/topic" }), fakeRunner(commands));

    expect(commands).toEqual([
      {
        cwd: "/tmp/repository",
        args: ["-c", "alias.check-ref-format=", "check-ref-format", "--branch", "main"],
      },
      {
        cwd: "/tmp/repository",
        args: ["-c", "alias.check-ref-format=", "check-ref-format", "--branch", "feature/topic"],
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

  it.each([
    ["local branch", { localBranch: "main; touch escaped" }],
    ["local option", { localBranch: "--config=core.editor=escaped" }],
    ["arbitrary config key", { configKey: "branch.main.remote" }],
    ["remote path", { remote: "../origin" }],
    ["remote name", { remote: "backup" }],
    ["remote command", { remote: "origin && touch escaped" }],
    ["remote-branch path", { remoteBranch: "../main" }],
    ["remote-branch command", { remoteBranch: "main; touch escaped" }],
    ["remote-branch option", { remoteBranch: "--upload-pack=escaped" }],
  ] as const)("rejects an invalid $0", async (_label, overrides) => {
    const commands: GitCommand[] = [];

    await expect(
      setGitUpstream(input(overrides as Partial<GitUpstreamInput>), fakeRunner(commands)),
    ).rejects.toThrow(/invalid/i);
  });

  it("refuses the upstream remote explicitly", async () => {
    const commands: GitCommand[] = [];

    await expect(
      setGitUpstream(input({ remote: "upstream" }), fakeRunner(commands)),
    ).rejects.toThrow(/origin/i);
    expect(commands).toEqual([]);
  });

  it("requires an existing origin remote", async () => {
    const commands: GitCommand[] = [];

    await expect(setGitUpstream(input(), fakeRunner(commands, "backup\n"))).rejects.toThrow(
      /origin/i,
    );
    expect(commands).toEqual([
      {
        cwd: "/tmp/repository",
        args: ["-c", "alias.check-ref-format=", "check-ref-format", "--branch", "main"],
      },
      {
        cwd: "/tmp/repository",
        args: ["-c", "alias.check-ref-format=", "check-ref-format", "--branch", "main"],
      },
      { cwd: "/tmp/repository", args: ["-c", "alias.remote=", "remote"] },
    ]);
  });

  it.each(["_foo", "foo_", "föo"])("accepts Git branch name %s", async (branch) => {
    const commands: GitCommand[] = [];

    await setGitUpstream(
      input({ localBranch: branch, remoteBranch: branch }),
      fakeRunner(commands),
    );

    expect(commands[0].args).toEqual([
      "-c",
      "alias.check-ref-format=",
      "check-ref-format",
      "--branch",
      branch,
    ]);
    expect(commands[1].args).toEqual([
      "-c",
      "alias.check-ref-format=",
      "check-ref-format",
      "--branch",
      branch,
    ]);
  });

  it("does not evaluate shell syntax in Git arguments", async () => {
    const directory = makeRepository();
    const marker = join(directory, "should-not-exist");
    const result = await runGitCommand({
      cwd: directory,
      args: [`version; touch ${marker}`],
    });

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(directory, ".git", "config"), "utf8")).not.toContain(
      "should-not-exist",
    );
  });
});
