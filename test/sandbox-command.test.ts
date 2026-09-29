import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  formatSandboxAllowUsage,
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
