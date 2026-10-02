import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { SandboxManager } from "@carderne/sandbox-runtime";
import { wrapCommandWithSandboxMacOS } from "@carderne/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { removeTrailingGlobSuffix } from "@carderne/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { getMandatoryWriteDenyPaths } from "../src/sandbox-filesystem.ts";
import { buildRuntimeConfig } from "../src/sandbox-runtime.ts";

function isolatedGitEnvironment(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: join(root, "empty-template"),
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function makeTargets(cwd: string, commonGitDir: string, linkedGitDir?: string): string[] {
  const targets = [
    join(commonGitDir, "config"),
    join(commonGitDir, "config.worktree"),
    join(commonGitDir, "hooks", "pre-commit"),
    join(commonGitDir, "hooks", "nested", "unsafe-hook"),
    join(cwd, ".gitmodules"),
    join(cwd, ".pi", "settings.json"),
    join(cwd, ".pi", "extensions", "unsafe.ts"),
    join(cwd, ".envrc"),
    join(cwd, ".vscode", "settings.json"),
    join(cwd, ".idea", "workspace.xml"),
    join(cwd, "nested", "repo", ".git", "config"),
    join(cwd, "nested", "repo", ".git", "hooks", "pre-commit"),
    join(cwd, "nested", ".gitmodules"),
    join(cwd, "nested", ".pi", "settings.json"),
    join(cwd, "nested", ".pi", "extensions", "unsafe.ts"),
    join(cwd, "nested", ".envrc"),
    join(cwd, "nested", ".vscode", "settings.json"),
    join(cwd, "nested", ".idea", "workspace.xml"),
  ];

  if (linkedGitDir) {
    targets.push(
      join(cwd, ".git"),
      join(linkedGitDir, "config.worktree"),
      join(linkedGitDir, "hooks", "pre-commit"),
    );
  }
  return [...new Set(targets)];
}

function prepareTargets(targets: string[], linkedGitPointer: string | undefined): void {
  for (const target of targets) {
    if (target === linkedGitPointer) continue;
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, "fixture baseline\n");
  }
}

async function runSandboxed(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const wrapped = await SandboxManager.wrapWithSandbox(command, "sh");
  assert.match(wrapped, /\/usr\/bin\/sandbox-exec/, "must execute the generated macOS profile");
  try {
    const result = spawnSync("/bin/sh", ["-c", wrapped], {
      cwd,
      encoding: "utf8",
      env,
    });
    assert.equal(result.error, undefined, `could not spawn sandboxed command: ${result.error}`);
    assert.equal(result.status, 0, `sandboxed command failed:\n${result.stderr}`);
    return result.stdout;
  } finally {
    SandboxManager.cleanupAfterCommand();
  }
}

async function exerciseRepository(
  cwd: string,
  targets: string[],
  env: NodeJS.ProcessEnv,
  verifyGitWrites: boolean,
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        allowRead: [cwd],
        allowWrite: [cwd, ...targets],
        denyWrite: [],
      },
    },
    {
      domains: [],
      readPaths: [cwd],
      writePaths: [cwd, ...targets],
      unixSockets: [],
    },
    "darwin",
    cwd,
  );
  for (const target of targets) {
    assert.ok(
      runtimeConfig.filesystem?.allowWrite?.includes(target),
      `fixture must grant ${target}`,
    );
  }
  await SandboxManager.initialize(runtimeConfig, async () => false);
  try {
    const originalFiles = new Map(targets.map((target) => [target, readFileSync(target)]));
    const probeSource = [
      'const fs = require("node:fs");',
      `const paths = ${JSON.stringify(targets)};`,
      "const results = paths.map((path) => {",
      '  try { fs.writeFileSync(path, "sandbox-escaped-write"); return { path, status: "written" }; }',
      '  catch (error) { return { path, status: "denied", code: error.code }; }',
      "});",
      "process.stdout.write(JSON.stringify(results));",
    ].join("\n");
    let probeOutput = "";
    try {
      probeOutput = await runSandboxed(
        `${shellQuote(process.execPath)} -e ${shellQuote(probeSource)}`,
        cwd,
        env,
      );
    } finally {
      for (const [path, contents] of originalFiles) writeFileSync(path, contents);
    }

    const results = JSON.parse(probeOutput) as Array<{
      path: string;
      status: "denied" | "written";
      code?: string;
    }>;
    assert.equal(results.length, targets.length);
    for (const [index, result] of results.entries()) {
      assert.equal(result.path, targets[index]);
      assert.equal(result.status, "denied", `OS sandbox allowed protected write ${result.path}`);
      assert.ok(
        result.code === "EPERM" || result.code === "EACCES",
        `expected an OS permission denial for ${result.path}, received ${result.code}`,
      );
      assert.deepEqual(readFileSync(result.path), originalFiles.get(result.path));
    }

    if (verifyGitWrites) {
      const gitCommand = [
        "git status --porcelain >/dev/null",
        "printf 'status-ok\\n'",
        "git add sandbox-tracked.txt",
        "git commit -q -m sandbox-enforcement",
        "printf 'add-commit-ok\\n'",
        "git branch sandbox-enforcement-branch",
        "printf 'branch-ok\\n'",
      ].join(" && ");
      const output = await runSandboxed(gitCommand, cwd, env);
      assert.equal(output, "status-ok\nadd-commit-ok\nbranch-ok\n");
    }
  } finally {
    await SandboxManager.reset();
  }
}

test("generated macOS profile denies deep descendants after runtime glob normalization", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS profile regression test");
    return;
  }

  const project = realpathSync(process.cwd());
  const mandatory = getMandatoryWriteDenyPaths(project);
  for (const directory of [".pi", ".vscode", ".idea"]) {
    assert.ok(mandatory.includes(join(project, directory)));
    assert.ok(mandatory.includes(join(project, directory, "**", "*")));
  }

  // SandboxManager applies this runtime normalization before generating the macOS profile.
  const denyWithinAllow = mandatory.map(removeTrailingGlobSuffix);
  const wrapped = wrapCommandWithSandboxMacOS({
    command: "printf profile-test",
    binShell: "/bin/bash",
    needsNetworkRestriction: true,
    allowBrowserProcess: false,
    readConfig: undefined,
    writeConfig: { allowOnly: [project], denyWithinAllow },
  });
  const profileStart = wrapped.indexOf(" -p '");
  assert.notEqual(profileStart, -1, "runtime should generate a sandbox profile");
  const contentStart = profileStart + " -p '".length;
  const contentEnd = wrapped.indexOf("' /bin/bash -c '", contentStart);
  assert.notEqual(contentEnd, -1, "runtime should quote its sandbox profile");
  const profile = wrapped.slice(contentStart, contentEnd);
  const denyRegexes = [
    ...profile.matchAll(/\(deny file-write\*\s+\(regex ("(?:\\.|[^"])*")\)/g),
  ].map((match) => new RegExp(JSON.parse(match[1]!)));
  const deepTargets = [
    join(project, ".pi", "nested", "deep", "extension.ts"),
    join(project, ".vscode", "nested", "deep", "settings.json"),
    join(project, ".idea", "nested", "deep", "workspace.xml"),
    join(project, "nested", "repo", ".git", "hooks", "pre-commit"),
    join(project, "nested", "repo", ".git", "hooks", "nested", "pre-commit"),
  ];
  for (const target of deepTargets) {
    assert.ok(
      denyRegexes.some((matcher) => matcher.test(target)),
      `profile does not deny ${target}`,
    );
  }
});

test("macOS OS sandbox enforces protected project and Git writes despite explicit grants", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS-only OS enforcement regression test");
    return;
  }

  const scratch = mkdtempSync(join(process.cwd(), ".pi-sandbox-macos-enforcement-"));
  try {
    const env = isolatedGitEnvironment(scratch);
    mkdirSync(env.GIT_TEMPLATE_DIR!, { recursive: true });
    const emptyHooks = join(scratch, "empty-hooks");
    mkdirSync(emptyHooks);

    const repository = join(scratch, "ordinary");
    mkdirSync(repository);
    git(repository, ["init", "-q", "-b", "main"], env);
    git(repository, ["config", "user.name", "Sandbox Test"], env);
    git(repository, ["config", "user.email", "sandbox-test@example.invalid"], env);
    git(repository, ["config", "core.hooksPath", emptyHooks], env);
    writeFileSync(join(repository, "initial.txt"), "initial\n");
    git(repository, ["add", "initial.txt"], env);
    git(repository, ["commit", "-q", "-m", "initial"], env);

    const linkedWorktree = join(scratch, "linked-worktree");
    git(repository, ["worktree", "add", "--detach", linkedWorktree, "HEAD"], env);
    writeFileSync(join(linkedWorktree, "sandbox-tracked.txt"), "legitimate worktree write\n");

    const commonGitDir = realpathSync(join(repository, ".git"));
    const linkedGitDir = realpathSync(join(commonGitDir, "worktrees", "linked-worktree"));
    const pointerFile = join(linkedWorktree, ".git");
    const ordinaryTargets = makeTargets(repository, commonGitDir);
    const linkedTargets = makeTargets(linkedWorktree, commonGitDir, linkedGitDir);
    prepareTargets(ordinaryTargets, undefined);
    prepareTargets(linkedTargets, pointerFile);

    await exerciseRepository(repository, ordinaryTargets, env, false);
    await exerciseRepository(linkedWorktree, linkedTargets, env, true);
  } finally {
    await SandboxManager.reset();
    rmSync(scratch, { recursive: true, force: true });
  }
});
