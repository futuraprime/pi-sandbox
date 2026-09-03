import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getConfigPaths, isSandboxConfigPath } from "./index";

describe("sandbox config path protection", () => {
  it("resolves a relative project config path from the Pi session cwd", () => {
    const sessionCwd = join(tmpdir(), "pi-session-cwd", "project");

    expect(sessionCwd).not.toBe(process.cwd());
    expect(isSandboxConfigPath(".pi/sandbox.json", sessionCwd)).toBe(true);
  });

  it("recognizes absolute project and global config paths", () => {
    const sessionCwd = join(tmpdir(), "pi-session-cwd", "project");
    const { globalPath, projectPath } = getConfigPaths(sessionCwd);

    expect(isSandboxConfigPath(projectPath, sessionCwd)).toBe(true);
    expect(isSandboxConfigPath(globalPath, sessionCwd)).toBe(true);
  });

  it("recognizes the tilde-expanded global config path", () => {
    const sessionCwd = join(tmpdir(), "pi-session-cwd", "project");
    const { globalPath } = getConfigPaths(sessionCwd);

    expect(globalPath).toBe(join(homedir(), ".pi", "agent", "sandbox.json"));
    expect(isSandboxConfigPath("~/.pi/agent/sandbox.json", sessionCwd)).toBe(true);
  });

  it("does not protect unrelated sandbox.json files", () => {
    const sessionCwd = join(tmpdir(), "pi-session-cwd", "project");

    expect(isSandboxConfigPath("sandbox.json", sessionCwd)).toBe(false);
    expect(isSandboxConfigPath("nested/.pi/sandbox.json", sessionCwd)).toBe(false);
  });
});
