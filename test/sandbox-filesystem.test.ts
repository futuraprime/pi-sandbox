import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  getEffectiveFilesystemPolicy,
  resolveDerivedFilesystemAllowances,
} from "../src/sandbox-filesystem.ts";
import { buildRuntimeConfig } from "../src/sandbox-runtime.ts";

const temporaryDirectories: string[] = [];

test.afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepository(): string {
  const repository = mkdtempSync(join(process.cwd(), ".pi-sandbox-filesystem-repository-"));
  temporaryDirectories.push(repository);
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "Test User"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["commit", "--allow-empty", "-m", "initial"]);
  return repository;
}

test("derives only common Git metadata for descendant cwds", () => {
  const repository = makeRepository();
  const worktree = join(repository, "linked-worktree");
  const sibling = join(repository, "sibling-worktree");
  git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
  git(repository, ["worktree", "add", "--detach", sibling, "HEAD"]);
  mkdirSync(join(worktree, "nested", "deep"), { recursive: true });

  const commonDir = realpathSync(join(repository, ".git"));
  const policy = getEffectiveFilesystemPolicy(
    join(worktree, "nested", "deep"),
    { allowRead: ["configured-read"], allowWrite: ["configured-write"] },
    { allowRead: ["session-read"], allowWrite: ["session-write"] },
  );

  assert.deepEqual(policy.derived.linkedGitMetadata, [commonDir]);
  assert.deepEqual(policy.allowRead, ["configured-read", "session-read", commonDir]);
  assert.deepEqual(policy.allowWrite, ["configured-write", "session-write", commonDir]);
  assert.equal(policy.allowRead.includes(repository), false);
  assert.equal(policy.allowRead.includes(sibling), false);
  assert.equal(policy.allowWrite.includes(worktree), false);
  assert.equal(policy.allowWrite.includes(sibling), false);
});

test("supports Git status and ref metadata without granting checkout files", () => {
  const repository = makeRepository();
  const worktree = join(repository, "linked-worktree");
  git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);

  const commonDir = realpathSync(join(repository, ".git"));
  const policy = getEffectiveFilesystemPolicy(worktree, {}, {});
  assert.equal(policy.allowRead.includes(commonDir), true);
  assert.equal(policy.allowWrite.includes(commonDir), true);

  assert.equal(git(worktree, ["status", "--porcelain"]), "");
  git(worktree, ["update-ref", "refs/worktree-policy-test", "HEAD"]);
  assert.match(
    readFileSync(join(commonDir, "refs", "worktree-policy-test"), "utf8"),
    /^[0-9a-f]+\n$/,
  );
  assert.equal(policy.allowWrite.includes(repository), false);
  assert.equal(policy.allowWrite.includes(worktree), false);
});

test("recomputes replacement paths, fails closed, and does not mutate arrays", () => {
  const first = makeRepository();
  const second = makeRepository();
  const firstWorktree = join(first, "linked-worktree");
  const secondWorktree = join(second, "linked-worktree");
  git(first, ["worktree", "add", "--detach", firstWorktree, "HEAD"]);
  git(second, ["worktree", "add", "--detach", secondWorktree, "HEAD"]);

  const firstCommon = realpathSync(join(first, ".git"));
  const secondCommon = realpathSync(join(second, ".git"));
  assert.deepEqual(resolveDerivedFilesystemAllowances(firstWorktree), {
    linkedGitMetadata: [firstCommon],
  });
  assert.deepEqual(resolveDerivedFilesystemAllowances(secondWorktree), {
    linkedGitMetadata: [secondCommon],
  });
  assert.deepEqual(resolveDerivedFilesystemAllowances(first), { linkedGitMetadata: [] });

  const configured = { allowRead: ["."], allowWrite: ["."] };
  const sessionApproved = { allowRead: ["session"], allowWrite: ["session"] };
  getEffectiveFilesystemPolicy(firstWorktree, configured, sessionApproved);

  const runtimeConfig = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      allowRead: configured.allowRead,
      allowWrite: configured.allowWrite,
    },
  };
  const firstRuntime = buildRuntimeConfig(
    runtimeConfig,
    {
      domains: [],
      readPaths: sessionApproved.allowRead,
      writePaths: sessionApproved.allowWrite,
      unixSockets: [],
    },
    process.platform,
    firstWorktree,
  );
  const secondRuntime = buildRuntimeConfig(
    runtimeConfig,
    {
      domains: [],
      readPaths: sessionApproved.allowRead,
      writePaths: sessionApproved.allowWrite,
      unixSockets: [],
    },
    process.platform,
    secondWorktree,
  );
  assert.equal(firstRuntime.filesystem?.allowRead?.includes(firstCommon), true);
  assert.equal(firstRuntime.filesystem?.allowRead?.includes(secondCommon), false);
  assert.equal(firstRuntime.filesystem?.allowWrite?.includes(firstCommon), true);
  assert.equal(firstRuntime.filesystem?.allowWrite?.includes(secondCommon), false);
  assert.equal(secondRuntime.filesystem?.allowRead?.includes(secondCommon), true);
  assert.equal(secondRuntime.filesystem?.allowRead?.includes(firstCommon), false);
  assert.equal(secondRuntime.filesystem?.allowWrite?.includes(secondCommon), true);
  assert.equal(secondRuntime.filesystem?.allowWrite?.includes(firstCommon), false);
  assert.deepEqual(configured, { allowRead: ["."], allowWrite: ["."] });
  assert.deepEqual(sessionApproved, { allowRead: ["session"], allowWrite: ["session"] });

  writeFileSync(join(firstWorktree, ".git"), "gitdir: /arbitrary/protected/path\n");
  assert.deepEqual(resolveDerivedFilesystemAllowances(firstWorktree), { linkedGitMetadata: [] });
});
