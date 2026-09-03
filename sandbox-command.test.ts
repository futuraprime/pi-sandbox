import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applySandboxCommand,
  formatSandboxCommandUsage,
  parseSandboxCommand,
  updateSandboxConfigFile,
  type SandboxCommandKey,
  type SandboxConfigForCommand,
} from "./sandbox-command";

const commandCases: Array<{
  key: SandboxCommandKey;
  section: "filesystem" | "network";
  arrayName: string;
  value: string;
}> = [
  { key: "allowRead", section: "filesystem", arrayName: "allowRead", value: "./docs" },
  { key: "denyRead", section: "filesystem", arrayName: "denyRead", value: "/Users" },
  { key: "allowWrite", section: "filesystem", arrayName: "allowWrite", value: "./tmp" },
  { key: "denyWrite", section: "filesystem", arrayName: "denyWrite", value: "*.key" },
  { key: "allowedDomains", section: "network", arrayName: "allowedDomains", value: "example.com" },
  { key: "deniedDomains", section: "network", arrayName: "deniedDomains", value: "bad.example" },
];

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("parseSandboxCommand", () => {
  it.each(commandCases)("parses $key", ({ key, value }) => {
    expect(parseSandboxCommand([key, value])).toEqual({ key, value });
  });

  it("returns null for no args so /sandbox can show configuration", () => {
    expect(parseSandboxCommand([])).toBeNull();
    expect(parseSandboxCommand("")).toBeNull();
  });

  it("rejects invalid or missing args with usage text", () => {
    expect(() => parseSandboxCommand(["allowRead"])).toThrow("/sandbox allowRead <path>");
    expect(() => parseSandboxCommand(["nope", "value"])).toThrow("/sandbox deniedDomains <domain>");
    expect(formatSandboxCommandUsage()).toContain("/sandbox allowWrite <path>");
  });
});

describe("applySandboxCommand", () => {
  it.each(commandCases)(
    "adds $key to the right config array",
    ({ key, section, arrayName, value }) => {
      const result = applySandboxCommand({ enabled: true }, { key, value });

      expect(result.changed).toBe(true);
      expect(result.config[section]?.[arrayName]).toEqual([value]);
      expect(result.config.enabled).toBe(true);
    },
  );

  it("preserves unrelated config fields", () => {
    const config: SandboxConfigForCommand = {
      enabled: false,
      allowBrowserProcess: true,
      network: { allowLocalBinding: true, deniedDomains: ["existing.test"] },
      filesystem: { denyWrite: [".env"], allowRead: ["."] },
    };

    const result = applySandboxCommand(config, { key: "allowWrite", value: "./generated" });

    expect(result.config).toMatchObject({
      enabled: false,
      allowBrowserProcess: true,
      network: { allowLocalBinding: true, deniedDomains: ["existing.test"] },
      filesystem: { denyWrite: [".env"], allowRead: ["."], allowWrite: ["./generated"] },
    });
  });

  it("is idempotent and does not duplicate existing values", () => {
    const result = applySandboxCommand(
      { filesystem: { allowRead: [".", "./docs"] } },
      { key: "allowRead", value: "./docs" },
    );

    expect(result.changed).toBe(false);
    expect(result.config.filesystem?.allowRead).toEqual([".", "./docs"]);
  });
});

describe("updateSandboxConfigFile", () => {
  it("writes formatted JSON to a temporary fixture path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-command-"));
    tempDirs.push(dir);
    const configPath = join(dir, ".pi", "sandbox.json");

    const result = updateSandboxConfigFile(configPath, {
      key: "deniedDomains",
      value: "blocked.test",
    });

    expect(result.changed).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toBe(
      '{\n  "network": {\n    "deniedDomains": [\n      "blocked.test"\n    ]\n  }\n}\n',
    );
  });

  it("preserves existing fixture config when updating", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-command-"));
    tempDirs.push(dir);
    const configPath = join(dir, ".pi", "sandbox.json");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ enabled: true, filesystem: { denyRead: ["/Users"] } }),
      "utf-8",
    );

    updateSandboxConfigFile(configPath, { key: "denyWrite", value: "*.pem" });

    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
      enabled: true,
      filesystem: { denyRead: ["/Users"], denyWrite: ["*.pem"] },
    });
  });

  it("updates only the explicitly selected project config", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-command-"));
    tempDirs.push(dir);
    const projectPath = join(dir, "project", ".pi", "sandbox.json");
    const globalPath = join(dir, "home", ".pi", "agent", "sandbox.json");
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(globalPath, '{"filesystem":{"allowWrite":["/existing"]}}\n', "utf-8");

    updateSandboxConfigFile(projectPath, { key: "allowWrite", value: "./tmp" });

    expect(JSON.parse(readFileSync(projectPath, "utf-8"))).toEqual({
      filesystem: { allowWrite: ["./tmp"] },
    });
    expect(readFileSync(globalPath, "utf-8")).toBe('{"filesystem":{"allowWrite":["/existing"]}}\n');
  });
});
