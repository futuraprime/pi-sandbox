import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import { getConfigPaths } from "../src/config.ts";
import {
  bashCommandMentionsSandboxConfig,
  getProtectedSandboxConfigPaths,
  isSandboxConfigPath,
} from "../src/sandbox-command.ts";

test("recognises project and getAgentDir-resolved global config paths canonically", () => {
  const cwd = join(homedir(), "pi-session-cwd", "project");
  const { globalPath, projectPath } = getConfigPaths(cwd);
  const protectedPaths = getProtectedSandboxConfigPaths(cwd);

  assert.equal(isSandboxConfigPath(".pi/sandbox.json", cwd), true);
  assert.equal(isSandboxConfigPath(projectPath, cwd), true);
  assert.equal(isSandboxConfigPath(globalPath, cwd), true);
  assert.equal(protectedPaths.projectPath.endsWith("/.pi/sandbox.json"), true);
  assert.equal(protectedPaths.globalPath.endsWith("/sandbox.json"), true);
});

test("recognises tilde global paths and symlink/dot path spellings", () => {
  const cwd = join(homedir(), "pi-session-cwd", "project");
  const { projectPath } = getConfigPaths(cwd);

  assert.equal(isSandboxConfigPath("~/.pi/agent/sandbox.json", cwd), true);
  assert.equal(isSandboxConfigPath(join(cwd, ".pi", "..", ".pi", "sandbox.json"), cwd), true);
  assert.equal(isSandboxConfigPath(projectPath.replace("/.pi/", "/other/../.pi/"), cwd), true);
});

test("does not protect unrelated sandbox.json files", () => {
  const cwd = join(homedir(), "pi-session-cwd", "project");

  assert.equal(isSandboxConfigPath("sandbox.json", cwd), false);
  assert.equal(isSandboxConfigPath("nested/.pi/sandbox.json", cwd), false);
  assert.equal(bashCommandMentionsSandboxConfig("cat ./sandbox.json", cwd), false);
});

test("conservatively detects Bash mentions of project and global config files", () => {
  const cwd = join(homedir(), "pi-session-cwd", "project");
  const { globalPath, projectPath } = getConfigPaths(cwd);

  for (const command of [
    "printf x > .pi/sandbox.json",
    `python -c 'open(${JSON.stringify(projectPath)}, "w")'`,
    `cp input ${globalPath}`,
    "cat ~/.pi/agent/sandbox.json > /tmp/copy",
  ]) {
    assert.equal(bashCommandMentionsSandboxConfig(command, cwd), true, command);
  }

  assert.equal(bashCommandMentionsSandboxConfig("echo 'sandbox.json'", cwd), false);
});
