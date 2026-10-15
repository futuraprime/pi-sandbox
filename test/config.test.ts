import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  getConfigPaths,
  loadConfig,
  mergeConfigLayers,
  type SandboxConfig,
  type SandboxConfigFile,
  validateCredentials,
} from "../src/config.ts";
import { matchesPattern } from "../src/policy.ts";
import { updateSandboxConfigFile } from "../src/sandbox-command.ts";

test("built-in PEM and key write denies remain recursive under runtime-compatible globs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-default-key-deny-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const denyWrite = DEFAULT_CONFIG.filesystem?.denyWrite ?? [];

  assert.deepEqual(denyWrite.slice(-2), ["**/*.pem", "**/*.key"]);
  for (const extension of ["pem", "key"]) {
    for (const target of [
      join(root, `root.${extension}`),
      join(root, "nested", "deep", `private.${extension}`),
    ]) {
      assert.equal(matchesPattern(target, denyWrite, root), true, target);
    }
  }
  assert.equal(matchesPattern(join(root, "nested", "public.txt"), denyWrite, root), false);
});

test("omitted settings use their defaults without enabling generic SSH proxying", () => {
  const merged = mergeConfigLayers(DEFAULT_CONFIG, {}, {});

  assert.equal(DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS, 600);
  assert.equal(merged.permissionPromptTimeoutSeconds, DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS);
  assert.equal(merged.sandboxUserShell, true);
  assert.equal("sshProxy" in (merged.network ?? {}), false);

  const legacyConfig = JSON.parse('{"network":{"sshProxy":true}}') as SandboxConfigFile;
  const migrated = mergeConfigLayers(DEFAULT_CONFIG, legacyConfig, {});
  assert.equal("sshProxy" in (migrated.network ?? {}), false);
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
    ...DEFAULT_CONFIG.network!.allowedDomains!,
    "global.example.com",
    "shared.example.com",
    "project.example.com",
  ]);
  assert.deepEqual(merged.network?.deniedDomains, [
    ...DEFAULT_CONFIG.network!.deniedDomains!,
    "blocked.example.com",
    "project-blocked.example.com",
  ]);
  assert.deepEqual(merged.network?.allowUnixSockets, ["/global.sock", "/project.sock"]);
  assert.deepEqual(merged.filesystem?.allowRead, [
    ...DEFAULT_CONFIG.filesystem!.allowRead!,
    "/global",
    "/shared",
    "/project",
  ]);
  assert.deepEqual(merged.filesystem?.denyWrite, [
    ...DEFAULT_CONFIG.filesystem!.denyWrite!,
    "global.key",
    "project.key",
  ]);
});

test("mergeConfigLayers ignores malformed permission arrays", () => {
  const merged = mergeConfigLayers(
    DEFAULT_CONFIG,
    { filesystem: { denyWrite: "*.key" as unknown as string[] } },
    {},
  );

  assert.deepEqual(merged.filesystem?.denyWrite, DEFAULT_CONFIG.filesystem?.denyWrite);
});

test("characterizes cumulative defaults, global, and project array semantics", () => {
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

  assert.deepEqual(merged.network?.allowedDomains, [
    "default.example.com",
    "global.example.com",
    "project.example.com",
  ]);
  assert.deepEqual(merged.filesystem?.allowWrite, [
    "default-write",
    "global-write",
    "project-write",
  ]);
});

test("mergeConfigLayers applies local scalar precedence and cumulative empty arrays", () => {
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
  assert.deepEqual(merged.filesystem?.allowWrite, DEFAULT_CONFIG.filesystem?.allowWrite);
  assert.deepEqual(merged.filesystem?.allowRead, DEFAULT_CONFIG.filesystem?.allowRead);
  assert.deepEqual(merged.network?.allowedDomains, DEFAULT_CONFIG.network?.allowedDomains);
});

test("mergeConfigLayers ignores invalid scalar overrides and retains inherited settings", () => {
  const defaults: SandboxConfig = {
    ...DEFAULT_CONFIG,
    enabled: false,
    sandboxUserShell: false,
    permissionPromptTimeoutSeconds: 45,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    mandatoryDenySearchDepth: 3,
    allowPty: false,
    allowBrowserProcess: false,
    bwrapPath: "/usr/bin/bwrap",
    socatPath: "/usr/bin/socat",
    ripgrep: { command: "rg", argv0: "rg" },
    seccomp: { applyPath: "/usr/bin/apply-seccomp", argv0: "seccomp" },
    windows: {
      sandboxUser: "sandbox-user",
      sublayerGuid: "00000000-0000-4000-8000-000000000001",
      proxyPortRange: [60080, 60089],
      srtWin: { path: "/usr/bin/srt-win" },
    },
    network: {
      ...DEFAULT_CONFIG.network!,
      filterRequest: async () => ({ action: "allow" }),
      strictAllowlist: true,
      allowAllUnixSockets: true,
      allowLocalBinding: true,
      httpProxyPort: 8080,
      socksProxyPort: 1080,
      allowUnauthenticatedSocksProxy: true,
      mitmProxy: { socketPath: "/tmp/mitm.sock", domains: ["example.com"] },
      tlsTerminate: { caCertPath: "/tmp/ca.pem", caKeyPath: "/tmp/ca.key" },
      parentProxy: { http: "https://proxy.example.com", noProxy: "localhost" },
    },
    filesystem: { ...DEFAULT_CONFIG.filesystem!, disabled: true },
  };
  const cases: Array<{
    name: string;
    override: unknown;
    select: (config: SandboxConfig) => unknown;
    inherited: unknown;
  }> = [
    {
      name: "enabled",
      override: { enabled: "false" },
      select: (config) => config.enabled,
      inherited: false,
    },
    {
      name: "enabled",
      override: { enabled: null },
      select: (config) => config.enabled,
      inherited: false,
    },
    {
      name: "sandboxUserShell",
      override: { sandboxUserShell: [] },
      select: (config) => config.sandboxUserShell,
      inherited: false,
    },
    {
      name: "sandboxUserShell",
      override: { sandboxUserShell: 0 },
      select: (config) => config.sandboxUserShell,
      inherited: false,
    },
    {
      name: "permissionPromptTimeoutSeconds",
      override: { permissionPromptTimeoutSeconds: "0" },
      select: (config) => config.permissionPromptTimeoutSeconds,
      inherited: 45,
    },
    {
      name: "permissionPromptTimeoutSeconds",
      override: { permissionPromptTimeoutSeconds: Number.POSITIVE_INFINITY },
      select: (config) => config.permissionPromptTimeoutSeconds,
      inherited: 45,
    },
    {
      name: "permissionPromptTimeoutSeconds",
      override: { permissionPromptTimeoutSeconds: Number.NaN },
      select: (config) => config.permissionPromptTimeoutSeconds,
      inherited: 45,
    },
    {
      name: "enableWeakerNestedSandbox",
      override: { enableWeakerNestedSandbox: "false" },
      select: (config) => config.enableWeakerNestedSandbox,
      inherited: false,
    },
    {
      name: "enableWeakerNetworkIsolation",
      override: { enableWeakerNetworkIsolation: 1 },
      select: (config) => config.enableWeakerNetworkIsolation,
      inherited: false,
    },
    {
      name: "allowAppleEvents",
      override: { allowAppleEvents: "true" },
      select: (config) => config.allowAppleEvents,
      inherited: false,
    },
    {
      name: "allowAppleEvents",
      override: { allowAppleEvents: {} },
      select: (config) => config.allowAppleEvents,
      inherited: false,
    },
    {
      name: "mandatoryDenySearchDepth",
      override: { mandatoryDenySearchDepth: 11 },
      select: (config) => config.mandatoryDenySearchDepth,
      inherited: 3,
    },
    {
      name: "allowPty",
      override: { allowPty: "false" },
      select: (config) => config.allowPty,
      inherited: false,
    },
    {
      name: "allowBrowserProcess",
      override: { allowBrowserProcess: "false" },
      select: (config) => config.allowBrowserProcess,
      inherited: false,
    },
    {
      name: "bwrapPath",
      override: { bwrapPath: "bwrap" },
      select: (config) => config.bwrapPath,
      inherited: "/usr/bin/bwrap",
    },
    {
      name: "socatPath",
      override: { socatPath: false },
      select: (config) => config.socatPath,
      inherited: "/usr/bin/socat",
    },
    {
      name: "network.strictAllowlist",
      override: { network: { strictAllowlist: "false" } },
      select: (config) => config.network?.strictAllowlist,
      inherited: true,
    },
    {
      name: "network.allowAllUnixSockets",
      override: { network: { allowAllUnixSockets: 0 } },
      select: (config) => config.network?.allowAllUnixSockets,
      inherited: true,
    },
    {
      name: "network.allowLocalBinding",
      override: { network: { allowLocalBinding: "false" } },
      select: (config) => config.network?.allowLocalBinding,
      inherited: true,
    },
    {
      name: "network.httpProxyPort",
      override: { network: { httpProxyPort: "8081" } },
      select: (config) => config.network?.httpProxyPort,
      inherited: 8080,
    },
    {
      name: "network.httpProxyPort",
      override: { network: { httpProxyPort: 0 } },
      select: (config) => config.network?.httpProxyPort,
      inherited: 8080,
    },
    {
      name: "network.httpProxyPort",
      override: { network: { httpProxyPort: 8080.5 } },
      select: (config) => config.network?.httpProxyPort,
      inherited: 8080,
    },
    {
      name: "network.socksProxyPort",
      override: { network: { socksProxyPort: 65536 } },
      select: (config) => config.network?.socksProxyPort,
      inherited: 1080,
    },
    {
      name: "network.allowUnauthenticatedSocksProxy",
      override: { network: { allowUnauthenticatedSocksProxy: "true" } },
      select: (config) => config.network?.allowUnauthenticatedSocksProxy,
      inherited: true,
    },
    {
      name: "network.filterRequest",
      override: { network: { filterRequest: "allow all" } },
      select: (config) => config.network?.filterRequest,
      inherited: defaults.network?.filterRequest,
    },
    {
      name: "filesystem.disabled",
      override: { filesystem: { disabled: "false" } },
      select: (config) => config.filesystem?.disabled,
      inherited: true,
    },
    {
      name: "network.mitmProxy",
      override: { network: { mitmProxy: { socketPath: "", domains: ["example.com"] } } },
      select: (config) => config.network?.mitmProxy,
      inherited: defaults.network?.mitmProxy,
    },
    {
      name: "network.tlsTerminate",
      override: { network: { tlsTerminate: { caCertPath: "" } } },
      select: (config) => config.network?.tlsTerminate,
      inherited: defaults.network?.tlsTerminate,
    },
    {
      name: "network.parentProxy",
      override: { network: { parentProxy: { http: "not a URL" } } },
      select: (config) => config.network?.parentProxy,
      inherited: defaults.network?.parentProxy,
    },
    {
      name: "ripgrep",
      override: { ripgrep: { command: 42 } },
      select: (config) => config.ripgrep,
      inherited: defaults.ripgrep,
    },
    {
      name: "seccomp",
      override: { seccomp: { argv0: false } },
      select: (config) => config.seccomp,
      inherited: defaults.seccomp,
    },
    {
      name: "windows",
      override: { windows: { sandboxUser: "a-username-that-is-longer-than-twenty" } },
      select: (config) => config.windows,
      inherited: defaults.windows,
    },
    {
      name: "windows.proxyPortRange",
      override: { windows: { proxyPortRange: [1, 100] } },
      select: (config) => config.windows,
      inherited: defaults.windows,
    },
  ];

  const snapshotDefaults = () => ({
    ...defaults,
    network: { ...defaults.network!, filterRequest: undefined },
  });
  for (const { name, override, select, inherited } of cases) {
    const originalDefaults = structuredClone(snapshotDefaults());
    const invalidConfig = override as SandboxConfigFile;
    const originalInvalidConfig = structuredClone(invalidConfig);
    const originalError = console.error;

    for (const scope of ["global", "project"] as const) {
      const warnings: string[] = [];
      console.error = (...args: unknown[]) => warnings.push(String(args[0]));
      try {
        const merged =
          scope === "global"
            ? mergeConfigLayers(defaults, invalidConfig, {})
            : mergeConfigLayers(defaults, defaults, invalidConfig);
        assert.deepEqual(select(merged), inherited, `${scope}: ${name}`);
        assert.equal(warnings.length, 1, `${scope}: ${name}`);
        const warningPath = name === "windows.proxyPortRange" ? "windows" : name;
        assert.match(warnings[0]!, new RegExp(warningPath.replaceAll(".", "\\.")));
        assert.deepEqual(snapshotDefaults(), originalDefaults, `${name}: defaults mutated`);
        assert.deepEqual(invalidConfig, originalInvalidConfig, `${name}: override mutated`);
      } finally {
        console.error = originalError;
      }
    }
  }
});

test("mergeConfigLayers preserves valid scalar precedence, false and finite timeout values", () => {
  const defaults: SandboxConfig = {
    ...DEFAULT_CONFIG,
    enabled: true,
    permissionPromptTimeoutSeconds: 30,
    network: { ...DEFAULT_CONFIG.network!, allowLocalBinding: true },
    filesystem: { ...DEFAULT_CONFIG.filesystem!, disabled: true },
  };
  const globalConfig: SandboxConfigFile = {
    enabled: false,
    permissionPromptTimeoutSeconds: 10,
    mandatoryDenySearchDepth: 10,
    allowBrowserProcess: true,
    network: { allowLocalBinding: false, httpProxyPort: 8081 },
    filesystem: { disabled: false },
  };
  const projectConfig: SandboxConfigFile = {
    enabled: true,
    sandboxUserShell: false,
    permissionPromptTimeoutSeconds: -2,
    mandatoryDenySearchDepth: 1,
    allowBrowserProcess: false,
    network: { strictAllowlist: false, allowLocalBinding: false, httpProxyPort: 8082 },
    filesystem: { disabled: false },
  };
  const snapshots = [defaults, globalConfig, projectConfig].map((value) => structuredClone(value));

  const merged = mergeConfigLayers(defaults, globalConfig, projectConfig);

  assert.equal(merged.enabled, true);
  assert.equal(merged.sandboxUserShell, false);
  assert.equal(merged.permissionPromptTimeoutSeconds, -2);
  assert.equal(
    mergeConfigLayers(defaults, {}, { permissionPromptTimeoutSeconds: 0 })
      .permissionPromptTimeoutSeconds,
    0,
  );
  assert.equal(merged.mandatoryDenySearchDepth, 1);
  assert.equal(merged.allowBrowserProcess, false);
  assert.equal(merged.network?.strictAllowlist, false);
  assert.equal(merged.network?.allowLocalBinding, false);
  assert.equal(merged.network?.httpProxyPort, 8082);
  assert.equal(merged.filesystem?.disabled, false);
  assert.deepEqual(defaults, snapshots[0]);
  assert.deepEqual(globalConfig, snapshots[1]);
  assert.deepEqual(projectConfig, snapshots[2]);
});

test("mergeConfigLayers omits undefined overrides and atomically replaces valid nested values", () => {
  const defaultFilterRequest = async () => ({ action: "allow" as const });
  const filterRequest = async () => ({ action: "deny" as const, reason: "blocked" });
  const defaults: SandboxConfig = {
    ...DEFAULT_CONFIG,
    ripgrep: { command: "rg", args: ["--default"], argv0: "default-rg" },
    seccomp: { applyPath: "/default/seccomp", argv0: "default-seccomp" },
    network: {
      ...DEFAULT_CONFIG.network!,
      strictAllowlist: false,
      filterRequest: defaultFilterRequest,
      mitmProxy: { socketPath: "/tmp/default-mitm.sock", domains: ["default.example.com"] },
    },
  };
  const globalConfig: SandboxConfigFile = {
    enabled: false,
    network: { strictAllowlist: true },
  };
  const projectConfig: SandboxConfigFile = {
    enabled: undefined,
    ripgrep: { command: "custom-rg" },
    seccomp: { applyPath: "/custom/seccomp" },
    network: {
      strictAllowlist: undefined,
      filterRequest,
      mitmProxy: { socketPath: "/tmp/project-mitm.sock", domains: ["project.example.com"] },
    },
  };
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => warnings.push(String(args[0]));
  try {
    const merged = mergeConfigLayers(defaults, globalConfig, projectConfig);

    assert.equal(merged.enabled, false);
    assert.equal(merged.network?.strictAllowlist, true);
    assert.equal(merged.network?.filterRequest, filterRequest);
    assert.deepEqual(merged.network?.mitmProxy, projectConfig.network?.mitmProxy);
    assert.deepEqual(merged.ripgrep, { command: "custom-rg" });
    assert.deepEqual(merged.seccomp, { applyPath: "/custom/seccomp" });
    assert.deepEqual(warnings, []);
  } finally {
    console.error = originalError;
  }
});

test("loadConfig warns and ignores malformed scalar JSON overrides", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-invalid-scalars-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalError = console.error;
  const warnings: string[] = [];
  process.env.PI_CODING_AGENT_DIR = join(root, "global");
  const cwd = join(root, "project");
  try {
    mkdirSync(join(root, "global"), { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(root, "global", "sandbox.json"),
      JSON.stringify({
        enabled: false,
        permissionPromptTimeoutSeconds: 20,
        network: { allowLocalBinding: true },
        filesystem: { disabled: true },
      }),
      "utf8",
    );
    writeFileSync(
      join(cwd, ".pi", "sandbox.json"),
      JSON.stringify({
        enabled: "false",
        permissionPromptTimeoutSeconds: "0",
        network: { allowLocalBinding: "false" },
        filesystem: { disabled: "false" },
      }),
      "utf8",
    );
    console.error = (...args: unknown[]) => warnings.push(String(args[0]));

    const config = loadConfig(cwd);

    assert.equal(config.enabled, false);
    assert.equal(config.permissionPromptTimeoutSeconds, 20);
    assert.equal(config.network?.allowLocalBinding, true);
    assert.equal(config.filesystem?.disabled, true);
    assert.equal(warnings.length, 4);
    assert.ok(warnings.every((warning) => warning.startsWith("Warning: Ignoring invalid")));
  } finally {
    console.error = originalError;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

test("mergeConfigLayers composes every supported array and ignoreViolations key", () => {
  const defaults: SandboxConfig = {
    ...DEFAULT_CONFIG,
    network: {
      ...DEFAULT_CONFIG.network!,
      allowedDomains: ["default-domain"],
      deniedDomains: ["default-deny"],
      allowUnixSockets: ["default.sock"],
      allowMachLookup: ["default.service"],
    },
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      allowRead: ["default-read"],
      denyRead: ["default-deny-read"],
      allowWrite: ["default-write"],
      denyWrite: ["default-deny-write"],
    },
    ignoreViolations: { "read /default": ["default-path"], shared: ["default-shared"] },
  };
  const merged = mergeConfigLayers(
    defaults,
    {
      network: {
        allowedDomains: ["global-domain", "shared"],
        deniedDomains: ["global-deny"],
        allowUnixSockets: ["global.sock"],
        allowMachLookup: ["global.service"],
      },
      filesystem: {
        allowRead: ["global-read"],
        denyRead: ["global-deny-read"],
        allowWrite: ["global-write"],
        denyWrite: ["global-deny-write"],
      },
      ignoreViolations: { "read /default": ["global-path"], shared: ["global-shared"] },
    },
    {
      network: {
        allowedDomains: ["shared", "project-domain"],
        deniedDomains: ["project-deny"],
        allowUnixSockets: ["global.sock", "project.sock"],
        allowMachLookup: ["project.service"],
      },
      filesystem: {
        allowRead: ["project-read"],
        denyRead: ["project-deny-read"],
        allowWrite: ["project-write"],
        denyWrite: ["project-deny-write"],
      },
      ignoreViolations: {
        "read /default": ["global-path", "project-path"],
        project: ["project"],
      },
    },
  );

  assert.deepEqual(merged.network?.allowedDomains, [
    "default-domain",
    "global-domain",
    "shared",
    "project-domain",
  ]);
  assert.deepEqual(merged.network?.deniedDomains, ["default-deny", "global-deny", "project-deny"]);
  assert.deepEqual(merged.network?.allowUnixSockets, [
    "default.sock",
    "global.sock",
    "project.sock",
  ]);
  assert.deepEqual(merged.network?.allowMachLookup, [
    "default.service",
    "global.service",
    "project.service",
  ]);
  assert.deepEqual(merged.filesystem?.allowRead, ["default-read", "global-read", "project-read"]);
  assert.deepEqual(merged.filesystem?.denyRead, [
    "default-deny-read",
    "global-deny-read",
    "project-deny-read",
  ]);
  assert.deepEqual(merged.filesystem?.allowWrite, [
    "default-write",
    "global-write",
    "project-write",
  ]);
  assert.deepEqual(merged.filesystem?.denyWrite, [
    "default-deny-write",
    "global-deny-write",
    "project-deny-write",
  ]);
  assert.deepEqual(merged.ignoreViolations, {
    "read /default": ["default-path", "global-path", "project-path"],
    shared: ["default-shared", "global-shared"],
    project: ["project"],
  });
});

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
  assert.deepEqual(merged.filesystem?.denyWrite, [
    ...DEFAULT_CONFIG.filesystem!.denyWrite!,
    "valid.key",
  ]);
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

test("credentials accept only global policy metadata and ignore project declarations", () => {
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => warnings.push(String(args[0]));
  try {
    const merged = mergeConfigLayers(
      DEFAULT_CONFIG,
      {
        credentials: {
          envVars: [
            {
              name: "PI_SYNTHETIC_TOKEN",
              mode: "mask",
              injectHosts: ["api.example.com"],
            },
          ],
        },
      },
      {
        credentials: {
          envVars: [
            {
              name: "PROJECT_TOKEN",
              mode: "deny",
            },
          ],
        },
      },
    );

    assert.deepEqual(merged.credentials, {
      envVars: [
        {
          name: "PI_SYNTHETIC_TOKEN",
          mode: "mask",
          injectHosts: ["api.example.com"],
        },
      ],
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /project credentials.*global-only/);
  } finally {
    console.error = originalError;
  }
});

test("credentials reject values and fail-open extraction policies without exposing input", () => {
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => warnings.push(String(args[0]));
  try {
    const credentials = validateCredentials({
      envVars: [
        {
          name: "PI_SYNTHETIC_TOKEN",
          mode: "mask",
          value: "synthetic-secret-must-not-be-accepted",
          injectHosts: ["api.example.com"],
        },
        {
          name: "PI_STRUCTURED_TOKEN",
          mode: "mask",
          extract: "token=(\\\\S+)",
          injectHosts: ["api.example.com"],
        },
        {
          name: "PI_VALID_TOKEN",
          mode: "mask",
          injectHosts: ["api.example.com"],
        },
      ],
    });

    assert.deepEqual(credentials, {
      envVars: [
        {
          name: "PI_VALID_TOKEN",
          mode: "mask",
          injectHosts: ["api.example.com"],
        },
      ],
    });
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((warning) => !warning.includes("synthetic-secret")));
  } finally {
    console.error = originalError;
  }
});

test("structured extraction accepts only fail-closed runtime choices", () => {
  for (const onExtractNoMatch of ["deny", "error"] as const) {
    assert.deepEqual(
      validateCredentials({
        envVars: [
          {
            name: "PI_STRUCTURED_TOKEN",
            mode: "mask",
            extract: "token=(\\\\S+)",
            onExtractNoMatch,
            injectHosts: ["api.example.com"],
          },
        ],
      }),
      {
        envVars: [
          {
            name: "PI_STRUCTURED_TOKEN",
            mode: "mask",
            extract: "token=(\\\\S+)",
            onExtractNoMatch,
            injectHosts: ["api.example.com"],
          },
        ],
      },
    );
  }
});

test("rejects every environment decode policy regardless of its mismatch choice", () => {
  const syntheticPlaintext = "synthetic-env-decode-value-must-not-be-logged";
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => warnings.push(String(args[0]));
  try {
    const credentials = {
      envVars: [
        {
          name: "PI_INVALID_JWT",
          mode: "mask",
          decode: "jwt",
          onExtractNoMatch: "deny",
          injectHosts: ["api.example.com"],
        },
        {
          name: "PI_MISSING_CLAIM",
          mode: "mask",
          decode: "jwt",
          maskClaims: ["access_token"],
          onExtractNoMatch: "error",
          injectHosts: ["api.example.com"],
        },
      ],
    };
    const merged = mergeConfigLayers(DEFAULT_CONFIG, { credentials }, {});

    assert.equal(merged.credentials, undefined);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((warning) => warning.includes("decode policies are not supported")));
    assert.ok(warnings.every((warning) => !warning.includes(syntheticPlaintext)));
  } finally {
    console.error = originalError;
  }
});

test("mask credentials require a nonempty explicit host scope", () => {
  for (const injectHosts of [undefined, []]) {
    assert.deepEqual(
      validateCredentials({
        envVars: [{ name: "PI_SYNTHETIC_TOKEN", mode: "mask", injectHosts }],
      }),
      undefined,
    );
  }
});

test("credential policy is not editable through permission persistence", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-credential-persistence-"));
  const configPath = join(root, "sandbox.json");
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        credentials: {
          envVars: [{ name: "PI_SYNTHETIC_TOKEN", mode: "deny" }],
        },
      }),
      "utf8",
    );
    updateSandboxConfigFile(configPath, { key: "allowRead", value: "./docs" }, root);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      credentials: {
        envVars: [{ name: "PI_SYNTHETIC_TOKEN", mode: "deny" }],
      },
      filesystem: { allowRead: ["./docs"] },
    });
  } finally {
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

  updateSandboxConfigFile(configPath, { key: "allowRead", value: "/read" });
  updateSandboxConfigFile(configPath, { key: "allowWrite", value: "/write" });
  updateSandboxConfigFile(configPath, { key: "allowedDomains", value: "example.com" });

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

    updateSandboxConfigFile(
      configPath,
      { key: "allowRead", value: "./docs" },
      join(root, "project"),
    );

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

    updateSandboxConfigFile(
      projectPath,
      { key: "allowWrite", value: "./tmp" },
      join(root, "project"),
    );

    assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")), {
      filesystem: { allowWrite: ["./tmp"] },
    });
    assert.equal(readFileSync(globalPath, "utf8"), '{"filesystem":{"allowWrite":["/existing"]}}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
