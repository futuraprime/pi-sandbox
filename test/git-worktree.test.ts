import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { resolveGitWorktree, type GitWorktreeResolution } from "../src/git-worktree.ts";

const temporaryDirectories: string[] = [];

test.afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

interface Layout {
  base: string;
  worktree: string;
  gitFile: string;
  commonDir: string;
  perWorktreeGitDir: string;
}

function makeLayout(
  perWorktreeDirectory = (commonDir: string) => join(commonDir, "worktrees", "task"),
): Layout {
  const base = mkdtempSync(join(process.cwd(), ".pi-sandbox-git-worktree-"));
  temporaryDirectories.push(base);
  const worktree = join(base, "workspace");
  const gitFile = join(worktree, ".git");
  const commonDir = join(base, "repository", ".git");
  const perWorktreeGitDir = perWorktreeDirectory(commonDir);

  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(commonDir, "worktrees"), { recursive: true });
  mkdirSync(perWorktreeGitDir, { recursive: true });
  writeFileSync(gitFile, `gitdir: ${perWorktreeGitDir}\n`);
  writeFileSync(join(perWorktreeGitDir, "gitdir"), `${gitFile}\n`);
  writeFileSync(
    join(perWorktreeGitDir, "commondir"),
    `${relative(perWorktreeGitDir, commonDir)}\n`,
  );
  return { base, worktree, gitFile, commonDir, perWorktreeGitDir };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepository(): string {
  const repository = mkdtempSync(join(process.cwd(), ".pi-sandbox-git-repository-"));
  temporaryDirectories.push(repository);
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "Test User"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["commit", "--allow-empty", "-m", "initial"]);
  return repository;
}

test("resolves reciprocal linked-worktree metadata and descendant cwds", () => {
  const layout = makeLayout();
  const nested = join(layout.worktree, "src", "deep");
  mkdirSync(nested, { recursive: true });
  writeFileSync(layout.gitFile, `gitdir: ${relative(layout.worktree, layout.perWorktreeGitDir)}\n`);
  writeFileSync(
    join(layout.perWorktreeGitDir, "gitdir"),
    `${relative(layout.perWorktreeGitDir, layout.gitFile)}\n`,
  );

  assert.deepEqual(resolveGitWorktree(nested), {
    worktreeRoot: realpathSync(layout.worktree),
    gitDir: realpathSync(layout.perWorktreeGitDir),
    commonDir: realpathSync(layout.commonDir),
  } satisfies GitWorktreeResolution);
});

test("resolves a worktree created by Git and excludes ordinary repositories", () => {
  const repository = makeRepository();
  const worktree = join(repository, "linked-worktree");
  git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);

  const gitFile = readFileSync(join(worktree, ".git"), "utf8")
    .replace(/^gitdir: /, "")
    .trim();
  assert.deepEqual(resolveGitWorktree(worktree), {
    worktreeRoot: realpathSync(worktree),
    gitDir: realpathSync(gitFile),
    commonDir: realpathSync(join(repository, ".git")),
  });
  assert.equal(resolveGitWorktree(repository), null);
});

test("canonicalizes symlinks and dot-dot metadata before comparing paths", () => {
  const layout = makeLayout();
  const linkedRoot = join(layout.base, "workspace-link");
  mkdirSync(join(layout.worktree, "child"));
  // Symlinks are only used to exercise canonical path comparison; the fixture
  // itself remains project-local and is removed by the test cleanup hook.
  symlinkSync(layout.worktree, linkedRoot, "dir");
  writeFileSync(layout.gitFile, `gitdir: ${layout.commonDir}/worktrees/task/../task\n`);
  writeFileSync(join(layout.perWorktreeGitDir, "commondir"), `${layout.commonDir}/worktrees/..\n`);

  assert.deepEqual(resolveGitWorktree(join(linkedRoot, "child")), {
    worktreeRoot: realpathSync(layout.worktree),
    gitDir: realpathSync(layout.perWorktreeGitDir),
    commonDir: realpathSync(layout.commonDir),
  });
});

test("fails closed for malformed, traversal, and oversized metadata", () => {
  const missing = makeLayout();
  unlinkSync(join(missing.perWorktreeGitDir, "gitdir"));
  assert.equal(resolveGitWorktree(missing.worktree), null);

  const mismatch = makeLayout();
  writeFileSync(join(mismatch.perWorktreeGitDir, "gitdir"), `${join(mismatch.base, "other")}\n`);
  assert.equal(resolveGitWorktree(mismatch.worktree), null);

  const traversal = makeLayout((commonDir) =>
    join(commonDir, "worktrees", "task", "..", "..", "outside"),
  );
  assert.equal(resolveGitWorktree(traversal.worktree), null);

  const oversized = makeLayout();
  writeFileSync(oversized.gitFile, `gitdir: ${"x".repeat(5000)}\n`);
  assert.equal(resolveGitWorktree(oversized.worktree), null);
});

test("requires a direct worktrees child and validates session paths", () => {
  const sibling = makeLayout((commonDir) => join(commonDir, "not-worktrees", "task"));
  assert.equal(resolveGitWorktree(sibling.worktree), null);
  assert.equal(resolveGitWorktree("relative/path"), null);
  assert.equal(resolveGitWorktree("/path/with\0null"), null);
});
