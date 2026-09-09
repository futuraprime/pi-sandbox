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
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveGitWorktree, type GitWorktreeResolution } from "./git-worktree";

const temporaryDirectories: string[] = [];

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
  const base = mkdtempSync(join(tmpdir(), "pi-sandbox-git-worktree-"));
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
  const directory = mkdtempSync(join(tmpdir(), "pi-sandbox-git-worktree-repo-"));
  temporaryDirectories.push(directory);
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, ["config", "user.name", "Test User"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  git(directory, ["commit", "--allow-empty", "-m", "initial"]);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

describe("resolveGitWorktree", () => {
  it("resolves an Orca-style absolute linked-worktree layout", () => {
    const layout = makeLayout();

    expect(resolveGitWorktree(layout.worktree)).toEqual({
      worktreeRoot: realpathSync(layout.worktree),
      gitDir: realpathSync(layout.perWorktreeGitDir),
      commonDir: realpathSync(layout.commonDir),
    } satisfies GitWorktreeResolution);
  });

  it("resolves a worktree created by git worktree add", () => {
    const repository = makeRepository();
    const worktree = join(repository, "linked-worktree");
    git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);

    const gitFile = readFileSync(join(worktree, ".git"), "utf8")
      .replace(/^gitdir: /, "")
      .trim();
    expect(resolveGitWorktree(worktree)).toEqual({
      worktreeRoot: realpathSync(worktree),
      gitDir: realpathSync(gitFile),
      commonDir: realpathSync(join(repository, ".git")),
    });
  });

  it("resolves relative pointers and discovers from a descendant cwd", () => {
    const layout = makeLayout();
    const nested = join(layout.worktree, "src", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      layout.gitFile,
      `gitdir: ${relative(layout.worktree, layout.perWorktreeGitDir)}\n`,
    );
    writeFileSync(
      join(layout.perWorktreeGitDir, "gitdir"),
      `${relative(layout.perWorktreeGitDir, layout.gitFile)}\n`,
    );

    expect(resolveGitWorktree(nested)).toEqual({
      worktreeRoot: realpathSync(layout.worktree),
      gitDir: realpathSync(layout.perWorktreeGitDir),
      commonDir: realpathSync(layout.commonDir),
    });
  });

  it("canonicalises symlinks and dot-dot components before comparing paths", () => {
    const layout = makeLayout();
    const linkedRoot = join(layout.base, "workspace-link");
    mkdirSync(join(layout.worktree, "child"));
    symlinkSync(layout.worktree, linkedRoot, "dir");
    writeFileSync(layout.gitFile, `gitdir: ${layout.commonDir}/worktrees/task/../task\n`);
    writeFileSync(
      join(layout.perWorktreeGitDir, "commondir"),
      `${layout.commonDir}/worktrees/..\n`,
    );

    expect(resolveGitWorktree(join(linkedRoot, "child"))).toEqual({
      worktreeRoot: realpathSync(layout.worktree),
      gitDir: realpathSync(layout.perWorktreeGitDir),
      commonDir: realpathSync(layout.commonDir),
    });
  });

  it("does not match an ordinary repository", () => {
    const repository = makeRepository();
    expect(resolveGitWorktree(repository)).toBeNull();
  });

  it.each([
    ["missing gitdir", (layout: Layout) => unlinkSync(join(layout.perWorktreeGitDir, "gitdir"))],
    [
      "missing commondir",
      (layout: Layout) => unlinkSync(join(layout.perWorktreeGitDir, "commondir")),
    ],
    [
      "mismatched reciprocal gitdir",
      (layout: Layout) =>
        writeFileSync(
          join(layout.perWorktreeGitDir, "gitdir"),
          `${join(layout.base, "other", ".git")}\n`,
        ),
    ],
    [
      "ambiguous .git metadata",
      (layout: Layout) =>
        writeFileSync(
          layout.gitFile,
          `gitdir: ${layout.perWorktreeGitDir}\ngitdir: ${layout.perWorktreeGitDir}\n`,
        ),
    ],
    [
      "malformed commondir metadata",
      (layout: Layout) =>
        writeFileSync(join(layout.perWorktreeGitDir, "commondir"), "../..\nextra\n"),
    ],
  ] as const)("rejects %s", (_name, mutate) => {
    const layout = makeLayout();
    mutate(layout);
    expect(() => resolveGitWorktree(layout.worktree)).not.toThrow();
    expect(resolveGitWorktree(layout.worktree)).toBeNull();
  });

  it("rejects an arbitrary target and a path traversal outside worktrees", () => {
    const arbitrary = makeLayout((commonDir) => join(dirname(commonDir), "arbitrary"));
    expect(resolveGitWorktree(arbitrary.worktree)).toBeNull();

    const traversal = makeLayout((commonDir) =>
      join(commonDir, "worktrees", "task", "..", "..", "outside"),
    );
    expect(resolveGitWorktree(traversal.worktree)).toBeNull();
  });

  it("requires the per-worktree directory to be a direct worktrees child", () => {
    const sibling = makeLayout((commonDir) => join(commonDir, "not-worktrees", "task"));
    expect(resolveGitWorktree(sibling.worktree)).toBeNull();

    const nested = makeLayout((commonDir) => join(commonDir, "worktrees", "nested", "task"));
    expect(resolveGitWorktree(nested.worktree)).toBeNull();
  });

  it("rejects oversized metadata files without reading them unboundedly", () => {
    const layout = makeLayout();
    writeFileSync(layout.gitFile, `gitdir: ${"x".repeat(5000)}\n`);
    expect(resolveGitWorktree(layout.worktree)).toBeNull();

    const reciprocal = makeLayout();
    writeFileSync(join(reciprocal.perWorktreeGitDir, "gitdir"), "x".repeat(5000));
    expect(resolveGitWorktree(reciprocal.worktree)).toBeNull();

    const common = makeLayout();
    writeFileSync(join(common.perWorktreeGitDir, "commondir"), "x".repeat(5000));
    expect(resolveGitWorktree(common.worktree)).toBeNull();
  });

  it("fails closed for invalid session paths", () => {
    expect(resolveGitWorktree("relative/path")).toBeNull();
    expect(resolveGitWorktree("/path/with\0null")).toBeNull();
  });
});
