import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  DEFAULT_CONFIG,
  DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  getConfigPaths,
  loadConfig,
  mergeConfigLayers,
  type SandboxConfig,
} from "../src/config.ts";

test("omitted settings use their defaults", () => {
  const merged = mergeConfigLayers(DEFAULT_CONFIG, {}, {});

  assert.equal(DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS, 600);
  assert.equal(merged.permissionPromptTimeoutSeconds, DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS);
  assert.equal(merged.sandboxUserShell, true);
});

test("mergeConfigLayers combines configured arrays and deduplicates entries", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    {
      network: {
        allowedDomains: ["global.example.com", "shared.example.com"],
        deniedDomains: ["blocked.example.com"],
        allowUnixSockets: ["/global.sock"],
      },
      filesystem: {
        allowRead: ["/global", "/shared"],
        denyWrite: ["global.key"],
      },
    },
    {
      network: {
        allowedDomains: ["project.example.com", "shared.example.com"],
        deniedDomains: ["project-blocked.example.com"],
        allowUnixSockets: ["/project.sock"],
      },
      filesystem: {
        allowRead: ["/project", "/shared"],
        denyWrite: ["project.key"],
      },
    },
  );

  assert.deepEqual(merged.network?.allowedDomains, [
    "global.example.com",
    "shared.example.com",
    "project.example.com",
  ]);
  assert.deepEqual(merged.network?.deniedDomains, [
    "blocked.example.com",
    "project-blocked.example.com",
  ]);
  assert.deepEqual(merged.network?.allowUnixSockets, ["/global.sock", "/project.sock"]);
  assert.deepEqual(merged.filesystem?.allowRead, ["/global", "/shared", "/project"]);
  assert.deepEqual(merged.filesystem?.denyWrite, ["global.key", "project.key"]);
});

test("mergeConfigLayers ignores malformed permission arrays", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    { filesystem: { denyWrite: "*.key" as unknown as string[] } },
    {},
  );

  assert.deepEqual(merged.filesystem?.denyWrite, DEFAULT_CONFIG.filesystem?.denyWrite);
});

test("characterizes upstream replacement semantics for configured arrays", () => {
  const defaults: SandboxConfig = {
    ...DEFAULT_CONFIG,
    network: { ...DEFAULT_CONFIG.network!, allowedDomains: ["default.example.com"] },
    filesystem: { ...DEFAULT_CONFIG.filesystem!, allowWrite: ["default-write"] },
  };
  const merged = mergeConfigLayers(
    defaults,
    {
      network: { allowedDomains: ["global.example.com"] },
      filesystem: { allowWrite: ["global-write"] },
    },
    {
      network: { allowedDomains: ["project.example.com"] },
      filesystem: { allowWrite: ["project-write"] },
    },
  );

  // This records the upstream baseline. C-02/C-03 require downstream's
  // cumulative defaults → global → project result in a later slice.
  assert.deepEqual(merged.network?.allowedDomains, ["global.example.com", "project.example.com"]);
  assert.deepEqual(merged.filesystem?.allowWrite, ["global-write", "project-write"]);
});

test("mergeConfigLayers uses defaults only for arrays not configured by either file", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    {
      enabled: false,
      sandboxUserShell: false,
      permissionPromptTimeoutSeconds: 30,
      filesystem: { allowWrite: [] },
    },
    {
      enabled: true,
      sandboxUserShell: true,
      permissionPromptTimeoutSeconds: 0,
      allowBrowserProcess: true,
    },
  );

  assert.equal(merged.enabled, true);
  assert.equal(merged.sandboxUserShell, true);
  assert.equal(merged.permissionPromptTimeoutSeconds, 0);
  assert.equal(merged.allowBrowserProcess, true);
  assert.deepEqual(merged.filesystem?.allowWrite, []);
  assert.deepEqual(merged.filesystem?.allowRead, DEFAULT_CONFIG.filesystem?.allowRead);
  assert.deepEqual(merged.network?.allowedDomains, DEFAULT_CONFIG.network?.allowedDomains);
});

test.todo("C-02/C-03: configured arrays accumulate defaults, global, and project values");
test.todo("C-04: explicit empty arrays do not clear defaults or inherited restrictions");
test.todo("C-03: ignoreViolations arrays compose and deduplicate per key");

test("characterizes malformed config values without throwing or iterating strings", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    {
      network: { allowedDomains: "not-an-array" as unknown as string[] },
      filesystem: { denyWrite: ["valid.key", 42] as unknown as string[] },
    },
    {
      filesystem: { allowRead: "also-not-an-array" as unknown as string[] },
    },
  );

  assert.deepEqual(merged.network?.allowedDomains, DEFAULT_CONFIG.network?.allowedDomains);
  assert.deepEqual(merged.filesystem?.denyWrite, DEFAULT_CONFIG.filesystem?.denyWrite);
  assert.deepEqual(merged.filesystem?.allowRead, DEFAULT_CONFIG.filesystem?.allowRead);
});

test("loadConfig warns and ignores malformed and non-object JSON values", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-malformed-config-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalError = console.error;
  const warnings: unknown[][] = [];
  process.env.PI_CODING_AGENT_DIR = join(root, "global");
  const cwd = join(root, "project");
  try {
    mkdirSync(join(root, "global"), { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(root, "global", "sandbox.json"), "{", "utf8");
    writeFileSync(join(cwd, ".pi", "sandbox.json"), "[]", "utf8");
    console.error = (...args: unknown[]) => warnings.push(args);

    assert.doesNotThrow(() => loadConfig(cwd));
    writeFileSync(join(root, "global", "sandbox.json"), "null", "utf8");
    writeFileSync(join(cwd, ".pi", "sandbox.json"), "{not-json", "utf8");
    assert.doesNotThrow(() => loadConfig(cwd));
    assert.equal(warnings.length, 4);
    assert.ok(warnings.every((args) => String(args[0]).startsWith("Warning: Could not parse")));
  } finally {
    console.error = originalError;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("getConfigPaths uses Pi's configured agent directory", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-agent";
  try {
    assert.deepEqual(getConfigPaths("/workspace"), {
      globalPath: "/tmp/custom-pi-agent/sandbox.json",
      projectPath: "/workspace/.pi/sandbox.json",
    });
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

test("permission writers only persist the property being changed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-config-"));
  const configPath = join(root, "sandbox.json");

  addReadPathToConfig(configPath, "/read");
  addWritePathToConfig(configPath, "/write");
  addDomainToConfig(configPath, "example.com");

  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(written, {
    network: { allowedDomains: ["example.com"] },
    filesystem: {
      allowRead: ["/read"],
      allowWrite: ["/write"],
    },
  });
});

test("ported persistence seam preserves unrelated config and project-relative values", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-persistence-"));
  const configPath = join(root, "project", ".pi", "sandbox.json");
  try {
    mkdirSync(join(root, "project", ".pi"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ enabled: false, filesystem: { denyRead: ["/Users"] } }),
      "utf8",
    );

    addReadPathToConfig(configPath, "./docs");

    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      enabled: false,
      filesystem: { denyRead: ["/Users"], allowRead: ["./docs"] },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ported persistence seam updates only the selected config path", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-persistence-scope-"));
  const projectPath = join(root, "project", ".pi", "sandbox.json");
  const globalPath = join(root, "global", "sandbox.json");
  try {
    mkdirSync(join(root, "global"), { recursive: true });
    writeFileSync(globalPath, '{"filesystem":{"allowWrite":["/existing"]}}\n', "utf8");

    addWritePathToConfig(projectPath, "./tmp");

    assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")), {
      filesystem: { allowWrite: ["./tmp"] },
    });
    assert.equal(readFileSync(globalPath, "utf8"), '{"filesystem":{"allowWrite":["/existing"]}}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.todo(
  "C-07/D-02: equivalent canonical path spellings deduplicate without rewriting project values",
);
test.todo("D-01/D-04: the sanctioned persistence seam supports all six /sandbox rule types");
