import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { decideWritePolicy, resolveWritePermission } from "../src/policy.ts";
import {
  getEffectiveFilesystemPolicy,
  getMandatoryWriteDenyPaths,
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

  const metadataWrites = [
    join(commonDir, "objects"),
    join(commonDir, "refs"),
    join(commonDir, "logs"),
    join(commonDir, "packed-refs"),
    join(commonDir, "packed-refs.lock"),
    realpathSync(join(commonDir, "worktrees", worktree.split("/").at(-1)!)),
  ];
  assert.deepEqual(policy.derived.linkedGitMetadataRead, [commonDir]);
  assert.deepEqual(policy.derived.linkedGitMetadataWrite, metadataWrites);
  assert.deepEqual(policy.allowRead, [
    "configured-read",
    "session-read",
    commonDir,
    ...metadataWrites,
  ]);
  assert.deepEqual(policy.allowWrite, ["configured-write", "session-write", ...metadataWrites]);
  assert.equal(policy.allowRead.includes(repository), false);
  assert.equal(policy.allowRead.includes(sibling), false);
  assert.equal(policy.allowWrite.includes(commonDir), false);
  assert.equal(policy.allowWrite.includes(join(commonDir, "hooks")), false);
  assert.equal(policy.allowWrite.includes(join(commonDir, "config")), false);
  assert.equal(
    policy.allowWrite.some((path) => path.startsWith(join(commonDir, "worktrees"))),
    true,
  );
  assert.equal(policy.allowWrite.includes(sibling), false);
});

test("supports Git status and ref metadata without granting checkout files", () => {
  const repository = makeRepository();
  const worktree = join(repository, "linked-worktree");
  git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);

  const commonDir = realpathSync(join(repository, ".git"));
  const policy = getEffectiveFilesystemPolicy(worktree, {}, {});
  const mandatory = getMandatoryWriteDenyPaths(worktree);
  assert.equal(policy.allowRead.includes(commonDir), true);
  assert.equal(policy.allowWrite.includes(commonDir), false);

  assert.equal(git(worktree, ["status", "--porcelain"]), "");
  writeFileSync(join(worktree, "tracked.txt"), "worktree content\n");
  git(worktree, ["add", "tracked.txt"]);
  git(worktree, ["commit", "-m", "add tracked file"]);
  git(worktree, ["branch", "worktree-policy-branch"]);
  assert.equal(git(worktree, ["status", "--porcelain"]), "");
  assert.match(
    git(worktree, ["branch", "--list", "worktree-policy-branch"]),
    /worktree-policy-branch/,
  );

  for (const target of [
    join(commonDir, "objects", "new-object"),
    join(commonDir, "refs", "heads", "new-branch"),
    join(commonDir, "logs", "refs", "heads", "new-branch"),
    join(commonDir, "packed-refs.lock"),
    join(policy.derived.linkedGitMetadataWrite.at(-1)!, "index.lock"),
  ]) {
    assert.equal(
      decideWritePolicy(target, policy.allowWrite, [], worktree, mandatory),
      "allow",
      target,
    );
  }
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
  const firstDerived = resolveDerivedFilesystemAllowances(firstWorktree);
  const secondDerived = resolveDerivedFilesystemAllowances(secondWorktree);
  assert.equal(firstDerived.linkedGitMetadataRead[0], firstCommon);
  assert.equal(secondDerived.linkedGitMetadataRead[0], secondCommon);
  assert.equal(firstDerived.linkedGitMetadataWrite.includes(firstCommon), false);
  assert.equal(secondDerived.linkedGitMetadataWrite.includes(secondCommon), false);
  assert.deepEqual(resolveDerivedFilesystemAllowances(first), {
    linkedGitMetadataRead: [],
    linkedGitMetadataWrite: [],
  });

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
  assert.equal(firstRuntime.filesystem?.allowWrite?.includes(firstCommon), false);
  assert.equal(firstRuntime.filesystem?.allowWrite?.includes(join(firstCommon, "objects")), true);
  assert.equal(firstRuntime.filesystem?.allowWrite?.includes(secondCommon), false);
  assert.equal(secondRuntime.filesystem?.allowRead?.includes(secondCommon), true);
  assert.equal(secondRuntime.filesystem?.allowRead?.includes(firstCommon), false);
  assert.equal(secondRuntime.filesystem?.allowWrite?.includes(secondCommon), false);
  assert.equal(secondRuntime.filesystem?.allowWrite?.includes(join(secondCommon, "objects")), true);
  assert.equal(secondRuntime.filesystem?.allowWrite?.includes(firstCommon), false);
  assert.deepEqual(configured, { allowRead: ["."], allowWrite: ["."] });
  assert.deepEqual(sessionApproved, { allowRead: ["session"], allowWrite: ["session"] });

  writeFileSync(join(firstWorktree, ".git"), "gitdir: /arbitrary/protected/path\n");
  assert.deepEqual(resolveDerivedFilesystemAllowances(firstWorktree), {
    linkedGitMetadataRead: [],
    linkedGitMetadataWrite: [],
  });
});

test("mandatory write paths cannot be overridden by configured or explicit allow rules", async () => {
  const repository = makeRepository();
  const worktree = join(repository, "linked-worktree");
  git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const targets = [
    join(worktree, ".git"),
    join(realpathSync(join(repository, ".git")), "config"),
    join(realpathSync(join(repository, ".git")), "hooks", "pre-commit"),
    join(worktree, ".gitmodules"),
    join(worktree, ".pi", "extensions", "unsafe.ts"),
    join(worktree, ".pi", "cache", "unsafe"),
    join(worktree, ".envrc"),
    join(worktree, ".vscode", "settings.json"),
    join(worktree, ".idea", "workspace.xml"),
    join(
      realpathSync(join(repository, ".git")),
      "worktrees",
      worktree.split("/").at(-1)!,
      "config.worktree",
    ),
    join(worktree, "nested", "repo", ".git", "config"),
    join(worktree, "nested", "repo", ".git", "hooks", "pre-commit"),
    join(worktree, "nested", "repo", ".gitmodules"),
    join(worktree, "nested", ".pi", "settings.json"),
    join(worktree, "nested", ".pi", "extensions", "unsafe.ts"),
    join(homedir(), ".gitconfig"),
    join(homedir(), ".config", "git", "config"),
  ];
  const mandatory = getMandatoryWriteDenyPaths(worktree);
  const prompt = async () => {
    assert.fail("mandatory writes must be blocked before prompting");
    return { action: "abort" as const, value: "" };
  };

  for (const target of targets) {
    const permission = await resolveWritePermission({
      path: target,
      allowWrite: [worktree, target],
      denyWrite: [],
      mandatoryDenyWrite: mandatory,
      cwd: worktree,
      prompt,
      saveWritePermission: async () => assert.fail("mandatory writes must not be granted"),
    });
    assert.deepEqual(permission, { action: "deny" }, target);
  }
});
