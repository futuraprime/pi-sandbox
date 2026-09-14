import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  applySandboxCommand,
  describeSandboxCommandResult,
  formatSandboxCommandUsage,
  parseSandboxCommand,
  updateSandboxConfigFile,
  type SandboxCommandKey,
  type SandboxConfigForCommand,
} from "../src/sandbox-command.ts";

function makeProjectTempDirectory(prefix: string): string {
  return mkdtempSync(join(process.cwd(), `.pi-sandbox-${prefix}-`));
}

const commandCases: Array<{
  key: SandboxCommandKey;
  section: "filesystem" | "network";
  value: string;
}> = [
  { key: "allowRead", section: "filesystem", value: "./docs" },
  { key: "denyRead", section: "filesystem", value: "/Users" },
  { key: "allowWrite", section: "filesystem", value: "./tmp" },
  { key: "denyWrite", section: "filesystem", value: "*.key" },
  { key: "allowedDomains", section: "network", value: "example.com" },
  { key: "deniedDomains", section: "network", value: "bad.example" },
];

test("parseSandboxCommand supports exactly the six policy rule types", () => {
  for (const { key, value } of commandCases) {
    assert.deepEqual(parseSandboxCommand([key, value]), { key, value });
  }
  assert.equal(parseSandboxCommand(""), null);
  assert.equal(parseSandboxCommand([]), null);
});

test("parseSandboxCommand rejects invalid syntax and policy-incompatible values", () => {
  assert.throws(() => parseSandboxCommand(["allowRead"]), /Usage:.*allowRead <path>/s);
  assert.throws(() => parseSandboxCommand(["nope", "value"]), /deniedDomains <domain>/s);
  assert.throws(
    () => parseSandboxCommand(["allowedDomains", "https://example.com"]),
    /Invalid domain/,
  );
  assert.throws(
    () => parseSandboxCommand(["deniedDomains", "*.example.com/path"]),
    /Invalid domain/,
  );
  assert.throws(() => parseSandboxCommand(["allowWrite", "\u0000"]), /control characters/);
  assert.match(formatSandboxCommandUsage(), /\/sandbox denyWrite <path>/);
});

test("applySandboxCommand adds each rule to only its selected array", () => {
  const original: SandboxConfigForCommand = {
    enabled: false,
    allowBrowserProcess: true,
    network: { allowLocalBinding: true, deniedDomains: ["existing.test"] },
    filesystem: { denyWrite: [".env"], allowRead: ["."] },
  };

  for (const { key, section, value } of commandCases) {
    const result = applySandboxCommand(original, { key, value });
    assert.equal(result.changed, true);
    const selected = (result.config[section] as Record<string, unknown>)[key] as string[];
    assert.equal(selected.includes(value), true);
    assert.equal(result.config.enabled, false);
    assert.equal(result.config.allowBrowserProcess, true);
    if (key !== "deniedDomains") {
      assert.deepEqual(result.config.network?.deniedDomains, ["existing.test"]);
    }
    if (key !== "denyWrite") {
      assert.deepEqual(result.config.filesystem?.denyWrite, [".env"]);
    }
  }
});

test("canonical filesystem duplicates retain the existing project spelling", () => {
  const root = makeProjectTempDirectory("command-canonical");
  try {
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(join(real, "docs"), { recursive: true });
    symlinkSync(real, link);

    const duplicate = applySandboxCommand(
      { filesystem: { allowRead: ["./real/../real/docs"] } },
      { key: "allowRead", value: "./link/docs" },
      root,
    );
    assert.equal(duplicate.changed, false);
    assert.deepEqual(duplicate.config.filesystem?.allowRead, ["./real/../real/docs"]);

    const added = applySandboxCommand(
      { filesystem: { allowRead: ["./real/docs"] } },
      { key: "allowRead", value: "./new/../new-output" },
      root,
    );
    assert.equal(added.changed, true);
    assert.deepEqual(added.config.filesystem?.allowRead, ["./real/docs", "./new/../new-output"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistence preserves unrelated fields and updates only the selected array", () => {
  const root = makeProjectTempDirectory("command-persistence");
  const configPath = join(root, ".pi", "sandbox.json");
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        enabled: false,
        allowBrowserProcess: true,
        network: { deniedDomains: ["blocked.test"], allowLocalBinding: true },
        filesystem: { allowRead: ["./docs"], denyWrite: [".env"] },
      }),
      "utf8",
    );

    const result = updateSandboxConfigFile(
      configPath,
      { key: "allowWrite", value: "./generated" },
      root,
    );

    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      enabled: false,
      allowBrowserProcess: true,
      network: { deniedDomains: ["blocked.test"], allowLocalBinding: true },
      filesystem: { allowRead: ["./docs"], denyWrite: [".env"], allowWrite: ["./generated"] },
    });
    const beforeDuplicate = readFileSync(configPath, "utf8");
    const duplicate = updateSandboxConfigFile(
      configPath,
      { key: "allowWrite", value: "./generated" },
      root,
    );
    assert.equal(duplicate.changed, false);
    assert.equal(readFileSync(configPath, "utf8"), beforeDuplicate);
    assert.match(describeSandboxCommandResult(duplicate), /^Already present:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistence supports all six arrays and does not touch a separate config path", () => {
  const root = makeProjectTempDirectory("command-six");
  const projectPath = join(root, "project", ".pi", "sandbox.json");
  const globalPath = join(root, "global", "sandbox.json");
  try {
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(globalPath, '{"filesystem":{"allowWrite":["/existing"]}}\n', "utf8");
    for (const { key, value } of commandCases) {
      updateSandboxConfigFile(projectPath, { key, value }, join(root, "project"));
    }

    assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")), {
      filesystem: {
        allowRead: ["./docs"],
        denyRead: ["/Users"],
        allowWrite: ["./tmp"],
        denyWrite: ["*.key"],
      },
      network: { allowedDomains: ["example.com"], deniedDomains: ["bad.example"] },
    });
    assert.equal(readFileSync(globalPath, "utf8"), '{"filesystem":{"allowWrite":["/existing"]}}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
