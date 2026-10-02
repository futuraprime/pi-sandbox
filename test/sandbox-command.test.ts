import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  getVolumeCaseSensitivity,
  traversesProtectedProjectPiDirectory,
  traversesProtectedProjectPiDirectoryWithProbe,
  pathsEqualConsideringVolumeCaseWithProbe,
} from "../src/path-security.ts";
import {
  formatSandboxAllowUsage,
  isSandboxConfigPath,
  parseSandboxAllowCommand,
  updateSandboxConfigFile,
} from "../src/sandbox-command.ts";

function makeProjectTempDirectory(prefix: string): string {
  return mkdtempSync(join(process.cwd(), `.pi-sandbox-${prefix}-`));
}

test("parseSandboxAllowCommand accepts only concrete domain, read, and write targets", () => {
  const root = makeProjectTempDirectory("allow-parser");
  try {
    assert.deepEqual(parseSandboxAllowCommand("domain api.example.com", root), {
      kind: "domain",
      key: "allowedDomains",
      value: "api.example.com",
    });
    assert.deepEqual(parseSandboxAllowCommand("read packages/widget/src/index.ts", root), {
      kind: "read",
      key: "allowRead",
      value: "packages/widget/src/index.ts",
    });
    assert.deepEqual(parseSandboxAllowCommand("write /tmp/generated output.txt", root), {
      kind: "write",
      key: "allowWrite",
      value: "/tmp/generated output.txt",
    });
    assert.throws(() => parseSandboxAllowCommand("denyRead /tmp/file", root), /Usage:/);
    assert.throws(
      () => parseSandboxAllowCommand("domain https://example.com/path", root),
      /Invalid domain/,
    );
    assert.throws(() => parseSandboxAllowCommand("domain *.example.com", root), /single hostname/);
    assert.throws(() => parseSandboxAllowCommand("read /tmp/*", root), /concrete path/);
    assert.throws(
      () => parseSandboxAllowCommand("write .pi/sandbox.json", root),
      /cannot receive write allowances/,
    );
    assert.throws(
      () => parseSandboxAllowCommand("read " + String.fromCharCode(0), root),
      /control characters/,
    );
    assert.throws(() => parseSandboxAllowCommand("read", root), /Usage:/);
    assert.ok(formatSandboxAllowUsage().includes("domain|read|write <target>"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox config protection follows volume case behavior for missing and aliased paths", () => {
  const root = makeProjectTempDirectory("case-aware-config");
  const agentDir = join(root, "global-agent");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(agentDir);
  const sensitivity = getVolumeCaseSensitivity(root);
  const expectedVariantMatch = sensitivity !== "sensitive";
  const linkedProject = join(root, "linked-project");
  const externalDirectory = join(root, "external-project-files");
  mkdirSync(linkedProject);
  mkdirSync(externalDirectory);
  symlinkSync(externalDirectory, join(linkedProject, ".pi"));

  try {
    assert.equal(
      traversesProtectedProjectPiDirectory(
        join(linkedProject, ".pi", "extensions", "unsafe.ts"),
        linkedProject,
      ),
      true,
    );
    assert.equal(
      traversesProtectedProjectPiDirectory(join(root, ".PI", "extensions", "unsafe.ts"), root),
      expectedVariantMatch,
      `volume sensitivity: ${sensitivity}`,
    );
    assert.equal(
      isSandboxConfigPath(join(root, ".PI", "Sandbox.json"), root),
      expectedVariantMatch,
      `volume sensitivity: ${sensitivity}`,
    );
    assert.equal(
      isSandboxConfigPath(join(agentDir, "Sandbox.json"), root),
      expectedVariantMatch,
      `volume sensitivity: ${sensitivity}`,
    );

    mkdirSync(join(root, ".pi", "nested"), { recursive: true });
    symlinkSync(join(root, ".pi"), join(root, "project-config-link"));
    symlinkSync(join(root, ".pi", "nested"), join(root, "project-dot-link"));
    assert.equal(
      isSandboxConfigPath(join(root, "project-config-link", "SANDBOX.JSON"), root),
      expectedVariantMatch,
      `volume sensitivity: ${sensitivity}`,
    );
    assert.equal(
      isSandboxConfigPath(`${join(root, "project-dot-link")}/../Sandbox.json`, root),
      expectedVariantMatch,
      `volume sensitivity: ${sensitivity}`,
    );
    assert.equal(
      isSandboxConfigPath(join(root, "missing", "..", ".PI", "Sandbox.json"), root),
      expectedVariantMatch,
      `volume sensitivity: ${sensitivity}`,
    );

    const homeAgentDir = join(homedir(), ".pi", "agent");
    process.env.PI_CODING_AGENT_DIR = homeAgentDir;
    const homeSensitivity = getVolumeCaseSensitivity(homeAgentDir);
    const expectedHomeVariantMatch = homeSensitivity !== "sensitive";
    assert.equal(isSandboxConfigPath("~/.pi/agent/Sandbox.json", root), expectedHomeVariantMatch);
    assert.equal(
      isSandboxConfigPath(join(homeAgentDir, "Sandbox.json"), root),
      expectedHomeVariantMatch,
    );
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown volume case behavior fails closed for case-equivalent protected paths", () => {
  const root = makeProjectTempDirectory("unknown-case-config");
  const unknownFileSystem = {
    readdir: () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    },
    realpath: (path: string) => path,
    stat: () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    },
  };
  try {
    assert.equal(getVolumeCaseSensitivity(root, unknownFileSystem), "unknown");
    assert.equal(
      pathsEqualConsideringVolumeCaseWithProbe(
        join(root, ".PI", "Sandbox.json"),
        join(root, ".pi", "sandbox.json"),
        unknownFileSystem,
      ),
      true,
    );
    assert.equal(
      traversesProtectedProjectPiDirectoryWithProbe(
        join(root, ".PI", "extensions", "unsafe.ts"),
        root,
        unknownFileSystem,
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved persistence updates only positive grant arrays and preserves canonical duplicates", () => {
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
        filesystem: { allowRead: ["./real/../real/docs"], denyWrite: [".env"] },
      }),
      "utf8",
    );
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(join(real, "docs"), { recursive: true });
    symlinkSync(real, link);

    const readDuplicate = updateSandboxConfigFile(
      configPath,
      { key: "allowRead", value: "./link/docs" },
      root,
    );
    assert.equal(readDuplicate.changed, false);
    assert.deepEqual(readDuplicate.config.filesystem?.allowRead, ["./real/../real/docs"]);

    assert.equal(
      updateSandboxConfigFile(configPath, { key: "allowWrite", value: "./generated" }, root)
        .changed,
      true,
    );
    assert.equal(
      updateSandboxConfigFile(configPath, { key: "allowedDomains", value: "api.example.com" }, root)
        .changed,
      true,
    );
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      enabled: false,
      allowBrowserProcess: true,
      network: {
        deniedDomains: ["blocked.test"],
        allowLocalBinding: true,
        allowedDomains: ["api.example.com"],
      },
      filesystem: {
        allowRead: ["./real/../real/docs"],
        denyWrite: [".env"],
        allowWrite: ["./generated"],
      },
    });
    // Bypass the narrowed API only to exercise its runtime guard.
    const unsupportedDenyRule = { key: "denyWrite", value: "*" };
    assert.throws(
      () =>
        updateSandboxConfigFile(
          configPath,
          unsupportedDenyRule as unknown as Parameters<typeof updateSandboxConfigFile>[1],
          root,
        ),
      /Usage: \/sandbox-allow/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
