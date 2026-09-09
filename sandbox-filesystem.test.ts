import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getEffectiveFilesystemPolicy,
  resolveDerivedFilesystemAllowances,
} from "./sandbox-filesystem";

const temporaryDirectories: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "pi-sandbox-policy-repo-"));
  temporaryDirectories.push(repository);
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "Test User"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["commit", "--allow-empty", "-m", "initial"]);
  return repository;
}

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

describe("linked-worktree filesystem policy", () => {
  it("adds only common Git metadata as a derived read/write allowance", () => {
    const repository = makeRepository();
    const worktree = join(repository, "linked-worktree");
    const sibling = join(repository, "sibling-worktree");
    git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
    git(repository, ["worktree", "add", "--detach", sibling, "HEAD"]);

    const commonDir = realpathSync(join(repository, ".git"));
    mkdirSync(join(worktree, "nested"));
    const policy = getEffectiveFilesystemPolicy(
      join(worktree, "nested"),
      { allowRead: ["configured-read"], allowWrite: ["configured-write"] },
      { allowRead: ["session-read"], allowWrite: ["session-write"] },
    );

    expect(policy.derived.linkedGitMetadata).toEqual([commonDir]);
    expect(policy.allowRead).toEqual(["configured-read", "session-read", commonDir]);
    expect(policy.allowWrite).toEqual(["configured-write", "session-write", commonDir]);
    expect(policy.allowRead).not.toContain(repository);
    expect(policy.allowRead).not.toContain(sibling);
    expect(policy.allowWrite).not.toContain(worktree);
    expect(policy.allowWrite).not.toContain(sibling);
  });

  it("supports real Git reads and metadata writes without granting worktree files", () => {
    const repository = makeRepository();
    const worktree = join(repository, "linked-worktree");
    git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);

    const policy = getEffectiveFilesystemPolicy(worktree, {}, {});
    const commonDir = realpathSync(join(repository, ".git"));
    expect(policy.allowRead).toContain(commonDir);
    expect(policy.allowWrite).toContain(commonDir);

    expect(git(worktree, ["status", "--porcelain"])).toBe("");
    git(worktree, ["update-ref", "refs/worktree-policy-test", "HEAD"]);
    expect(readFileSync(join(commonDir, "HEAD"), "utf8")).toContain("ref:");
    expect(readFileSync(join(commonDir, "refs", "worktree-policy-test"), "utf8")).toMatch(
      /^[0-9a-f]+\n$/,
    );
    expect(policy.allowWrite).not.toContain(repository);
    expect(policy.allowWrite).not.toContain(worktree);
  });

  it("recomputes replacement paths and fails closed for invalid metadata", () => {
    const first = makeRepository();
    const second = makeRepository();
    const firstWorktree = join(first, "linked-worktree");
    const secondWorktree = join(second, "linked-worktree");
    git(first, ["worktree", "add", "--detach", firstWorktree, "HEAD"]);
    git(second, ["worktree", "add", "--detach", secondWorktree, "HEAD"]);

    const firstCommon = realpathSync(join(first, ".git"));
    const secondCommon = realpathSync(join(second, ".git"));
    expect(resolveDerivedFilesystemAllowances(firstWorktree)).toEqual({
      linkedGitMetadata: [firstCommon],
    });
    expect(resolveDerivedFilesystemAllowances(secondWorktree)).toEqual({
      linkedGitMetadata: [secondCommon],
    });
    expect(resolveDerivedFilesystemAllowances(first)).toEqual({ linkedGitMetadata: [] });

    const pointer = join(firstWorktree, ".git");
    writeFileSync(pointer, "gitdir: /arbitrary/protected/path\n");
    expect(resolveDerivedFilesystemAllowances(firstWorktree)).toEqual({ linkedGitMetadata: [] });
  });

  it("does not mutate configured or session-approved allowance arrays", () => {
    const repository = makeRepository();
    const worktree = join(repository, "linked-worktree");
    git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
    const configured = { allowRead: ["."], allowWrite: ["."] };
    const sessionApproved = { allowRead: ["session"], allowWrite: ["session"] };

    getEffectiveFilesystemPolicy(worktree, configured, sessionApproved);

    expect(configured).toEqual({ allowRead: ["."], allowWrite: ["."] });
    expect(sessionApproved).toEqual({ allowRead: ["session"], allowWrite: ["session"] });
  });
});
