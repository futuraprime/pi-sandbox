import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
import { buildRuntimeConfig, createSandboxedBashOps } from "../src/sandbox-runtime.ts";

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

test("macOS C-2 write precedence follows path specificity through the OS sandbox", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS-only OS enforcement regression test");
    return;
  }

  const scratch = mkdtempSync(join(process.cwd(), ".pi-sandbox-c2-"));
  try {
    const paths = {
      created: join(scratch, "area", "grant", "created.txt"),
      overwritten: join(scratch, "area", "grant", "overwritten.txt"),
      deleted: join(scratch, "area", "grant", "deleted.txt"),
      renameSource: join(scratch, "area", "grant", "rename-source.txt"),
      renameTarget: join(scratch, "area", "grant", "rename-target.txt"),
      atomicTemp: join(scratch, "area", "grant", "atomic-temp.txt"),
      atomicTarget: join(scratch, "area", "grant", "atomic-target.txt"),
      globDenyLiteralGrant: join(scratch, "glob-block", "literal-grant", "created.txt"),
      literalDenyGlobGrant: join(scratch, "literal-block", "glob-grant", "created.txt"),
      globGrant: join(scratch, "area", "glob-grant", "created.txt"),
      nestedAllowed: join(scratch, "nested", "public", "created.txt"),
      sibling: join(scratch, "area", "sibling", "untouched.txt"),
      equalSpecificity: join(scratch, "tie", "untouched.txt"),
      nestedDenied: join(scratch, "nested", "private", "untouched.txt"),
      gitConfig: join(scratch, ".git", "config"),
      gitHook: join(scratch, ".git", "hooks", "pre-commit"),
      piSettings: join(scratch, ".pi", "settings.json"),
      sandboxConfig: join(scratch, ".pi", "sandbox.json"),
      runtimeGitConfig: join(scratch, ".gitconfig"),
      runtimeShellConfig: join(scratch, ".bashrc"),
      protectedAncestor: join(scratch, "move-zone", "protected", "deeper"),
      movedAncestor: join(scratch, "move-zone", "moved-deeper"),
      protectedLink: join(scratch, "move-zone", "protected", "deeper", "existing-link"),
      missingProtectedLink: join(scratch, "move-zone", "protected", "deeper", "not-created-link"),
      missingProtectedRenameLink: join(scratch, "move-zone", "protected", "deeper", "renamed-link"),
      attackerLink: join(scratch, "move-zone", "attacker-link"),
      attackerSymlink: join(scratch, "move-zone", "attacker-symlink"),
    };

    const baselineFiles = new Map<string, string>([
      [paths.overwritten, "original overwrite\n"],
      [paths.deleted, "original delete\n"],
      [paths.renameSource, "rename source\n"],
      [paths.atomicTarget, "original atomic target\n"],
      [paths.sibling, "sibling baseline\n"],
      [paths.equalSpecificity, "tie baseline\n"],
      [paths.nestedDenied, "nested deny baseline\n"],
      [paths.gitConfig, "fixture git config\n"],
      [paths.gitHook, "fixture git hook\n"],
      [paths.piSettings, "fixture pi settings\n"],
      [paths.sandboxConfig, "fixture sandbox config\n"],
      [paths.runtimeGitConfig, "fixture runtime git config\n"],
      [paths.runtimeShellConfig, "fixture runtime shell config\n"],
    ]);
    const deniedOperationFiles = new Map<string, string>([
      [paths.sibling, "sibling baseline\n"],
      [paths.equalSpecificity, "tie baseline\n"],
      [paths.nestedDenied, "nested deny baseline\n"],
      [paths.gitConfig, "fixture git config\n"],
      [paths.gitHook, "fixture git hook\n"],
      [paths.piSettings, "fixture pi settings\n"],
      [paths.sandboxConfig, "fixture sandbox config\n"],
      [paths.runtimeGitConfig, "fixture runtime git config\n"],
      [paths.runtimeShellConfig, "fixture runtime shell config\n"],
    ]);
    for (const [path, contents] of baselineFiles) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    for (const target of [
      paths.globDenyLiteralGrant,
      paths.literalDenyGlobGrant,
      paths.globGrant,
      paths.nestedAllowed,
    ]) {
      mkdirSync(dirname(target), { recursive: true });
    }
    mkdirSync(paths.protectedAncestor, { recursive: true });
    writeFileSync(paths.attackerLink, "attacker replacement\n");
    symlinkSync("attacker-controlled-target", paths.attackerSymlink);
    symlinkSync("original-link-target", paths.protectedLink);

    const allowWrite = [
      join(scratch, "area", "grant"),
      join(scratch, "area", "glob-grant", "*"),
      join(scratch, "glob-block", "literal-grant"),
      join(scratch, "literal-block", "glob-grant", "*"),
      join(scratch, "tie", "*"),
      join(scratch, "nested"),
      join(scratch, "move-zone"),
      paths.gitConfig,
      paths.gitHook,
      paths.piSettings,
      paths.sandboxConfig,
      paths.runtimeGitConfig,
      paths.runtimeShellConfig,
    ];
    const denyWrite = [
      scratch,
      join(scratch, "area", "**"),
      join(scratch, "glob-block", "**"),
      join(scratch, "literal-block"),
      join(scratch, "tie", "*"),
      join(scratch, "nested", "private"),
      join(scratch, "move-zone", "protected", "deeper", "existing-link"),
      join(scratch, "move-zone", "protected", "deeper", "not-created-link"),
      join(scratch, "move-zone", "protected", "deeper", "renamed-link"),
    ];
    const runtimeConfig = buildRuntimeConfig(
      {
        ...DEFAULT_CONFIG,
        network: { ...DEFAULT_CONFIG.network!, allowedDomains: [], deniedDomains: [] },
        filesystem: {
          denyRead: [],
          allowRead: [scratch],
          allowWrite,
          denyWrite,
        },
      },
      undefined,
      "darwin",
      scratch,
    );
    await SandboxManager.initialize(runtimeConfig, async () => false);

    const operations = [
      ["create-in-narrow-grant", `fs.writeFileSync(paths.created, "created\\n")`],
      ["overwrite-in-narrow-grant", `fs.writeFileSync(paths.overwritten, "overwritten\\n")`],
      ["delete-in-narrow-grant", `fs.unlinkSync(paths.deleted)`],
      ["rename-in-narrow-grant", `fs.renameSync(paths.renameSource, paths.renameTarget)`],
      [
        "atomic-replace-in-narrow-grant",
        `fs.writeFileSync(paths.atomicTemp, "atomic replacement\\n"); fs.renameSync(paths.atomicTemp, paths.atomicTarget)`,
      ],
      [
        "glob-deny-overridden-by-literal-grant",
        `fs.writeFileSync(paths.globDenyLiteralGrant, "literal grant\\n")`,
      ],
      [
        "literal-deny-overridden-by-more-specific-glob-grant",
        `fs.writeFileSync(paths.literalDenyGlobGrant, "glob grant\\n")`,
      ],
      ["glob-narrow-grant", `fs.writeFileSync(paths.globGrant, "glob path grant\\n")`],
      ["nested-sibling-of-deny", `fs.writeFileSync(paths.nestedAllowed, "nested allowed\\n")`],
      ["deny-sibling", `fs.writeFileSync(paths.sibling, "changed\\n")`],
      ["deny-equal-specificity-tie", `fs.writeFileSync(paths.equalSpecificity, "changed\\n")`],
      ["deny-more-specific-nested-rule", `fs.writeFileSync(paths.nestedDenied, "changed\\n")`],
      ["mandatory-git-config-deny", `fs.writeFileSync(paths.gitConfig, "changed\\n")`],
      ["mandatory-git-hook-deny", `fs.writeFileSync(paths.gitHook, "changed\\n")`],
      ["mandatory-pi-settings-deny", `fs.writeFileSync(paths.piSettings, "changed\\n")`],
      ["mandatory-sandbox-config-deny", `fs.writeFileSync(paths.sandboxConfig, "changed\\n")`],
      ["runtime-built-in-gitconfig-deny", `fs.writeFileSync(paths.runtimeGitConfig, "changed\\n")`],
      ["runtime-built-in-bashrc-deny", `fs.writeFileSync(paths.runtimeShellConfig, "changed\\n")`],
      ["deny-symlink-replacement", `fs.renameSync(paths.attackerLink, paths.protectedLink)`],
      [
        "deny-symlink-at-nonexistent-protected-target",
        `fs.symlinkSync("attacker-target", paths.missingProtectedLink)`,
      ],
      [
        "deny-symlink-rename-to-nonexistent-protected-target",
        `fs.renameSync(paths.attackerSymlink, paths.missingProtectedRenameLink)`,
      ],
      [
        "deny-ancestor-directory-rename",
        `fs.renameSync(paths.protectedAncestor, paths.movedAncestor)`,
      ],
    ] as const;
    const marker = "__PI_SANDBOX_C2_RESULT__";
    const probeSource = [
      'const fs = require("node:fs");',
      `const paths = ${JSON.stringify(paths)};`,
      `const operations = ${JSON.stringify(operations)};`,
      "const results = operations.map(([name, source]) => {",
      '  try { Function("fs", "paths", source)(fs, paths); return { name, status: "ok" }; }',
      '  catch (error) { return { name, status: "denied", code: error.code }; }',
      "});",
      `process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(results));`,
    ].join("\n");
    const output: Buffer[] = [];
    const originalWrapWithSandbox = SandboxManager.wrapWithSandbox;
    let observedSandboxExecWrapper = false;
    SandboxManager.wrapWithSandbox = async (...args) => {
      const wrapped = await originalWrapWithSandbox.apply(SandboxManager, args);
      assert.match(wrapped, /\/usr\/bin\/sandbox-exec/, "production path must use sandbox-exec");
      observedSandboxExecWrapper = true;
      return wrapped;
    };
    let exitCode: number | null;
    try {
      ({ exitCode } = await createSandboxedBashOps().exec(
        `${shellQuote(process.execPath)} -e ${shellQuote(probeSource)}`,
        scratch,
        {
          onData: (data) => output.push(Buffer.from(data)),
          env: { PATH: process.env.PATH, HOME: join(scratch, "home") },
        },
      ));
    } finally {
      SandboxManager.wrapWithSandbox = originalWrapWithSandbox;
    }
    assert.equal(
      observedSandboxExecWrapper,
      true,
      "production exec must invoke sandbox-exec wrapper",
    );
    assert.equal(exitCode, 0, `sandbox probe exited nonzero:\n${Buffer.concat(output)}`);
    const probeOutput = Buffer.concat(output).toString("utf8");
    const markerIndex = probeOutput.lastIndexOf(marker);
    assert.notEqual(markerIndex, -1, `sandbox probe emitted no results:\n${probeOutput}`);
    const results = JSON.parse(probeOutput.slice(markerIndex + marker.length)) as Array<{
      name: string;
      status: "denied" | "ok";
      code?: string;
    }>;
    assert.deepEqual(
      results.map(({ name }) => name),
      operations.map(([name]) => name),
    );

    const resultFor = (name: string) => results.find((result) => result.name === name);
    for (const name of [
      "create-in-narrow-grant",
      "overwrite-in-narrow-grant",
      "delete-in-narrow-grant",
      "rename-in-narrow-grant",
      "atomic-replace-in-narrow-grant",
      "glob-deny-overridden-by-literal-grant",
      "literal-deny-overridden-by-more-specific-glob-grant",
      "glob-narrow-grant",
      "nested-sibling-of-deny",
    ]) {
      assert.equal(resultFor(name)?.status, "ok", `narrower grant did not complete: ${name}`);
    }
    for (const name of [
      "deny-sibling",
      "deny-equal-specificity-tie",
      "deny-more-specific-nested-rule",
      "mandatory-git-config-deny",
      "mandatory-git-hook-deny",
      "mandatory-pi-settings-deny",
      "mandatory-sandbox-config-deny",
      "runtime-built-in-gitconfig-deny",
      "runtime-built-in-bashrc-deny",
      "deny-symlink-replacement",
      "deny-symlink-at-nonexistent-protected-target",
      "deny-symlink-rename-to-nonexistent-protected-target",
      "deny-ancestor-directory-rename",
    ]) {
      const result = resultFor(name);
      assert.equal(result?.status, "denied", `OS sandbox allowed protected write: ${name}`);
      assert.ok(
        result?.code === "EPERM" || result?.code === "EACCES",
        `expected an OS permission denial for ${name}, received ${result?.code}`,
      );
    }

    assert.equal(readFileSync(paths.created, "utf8"), "created\n");
    assert.equal(readFileSync(paths.overwritten, "utf8"), "overwritten\n");
    assert.equal(existsSync(paths.deleted), false);
    assert.equal(existsSync(paths.renameSource), false);
    assert.equal(readFileSync(paths.renameTarget, "utf8"), "rename source\n");
    assert.equal(existsSync(paths.atomicTemp), false);
    assert.equal(readFileSync(paths.atomicTarget, "utf8"), "atomic replacement\n");
    assert.equal(readFileSync(paths.globDenyLiteralGrant, "utf8"), "literal grant\n");
    assert.equal(readFileSync(paths.literalDenyGlobGrant, "utf8"), "glob grant\n");
    assert.equal(readFileSync(paths.globGrant, "utf8"), "glob path grant\n");
    assert.equal(readFileSync(paths.nestedAllowed, "utf8"), "nested allowed\n");
    for (const [path, contents] of deniedOperationFiles) {
      assert.equal(readFileSync(path, "utf8"), contents, `denied operation changed ${path}`);
    }
    assert.equal(readFileSync(paths.attackerLink, "utf8"), "attacker replacement\n");
    assert.equal(readlinkSync(paths.attackerSymlink), "attacker-controlled-target");
    assert.equal(readlinkSync(paths.protectedLink), "original-link-target");
    assert.throws(() => lstatSync(paths.missingProtectedLink), { code: "ENOENT" });
    assert.throws(() => lstatSync(paths.missingProtectedRenameLink), { code: "ENOENT" });
    assert.equal(existsSync(paths.protectedAncestor), true);
    assert.equal(existsSync(paths.movedAncestor), false);
  } finally {
    try {
      await SandboxManager.reset();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});
