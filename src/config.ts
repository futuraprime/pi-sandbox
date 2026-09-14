import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SandboxConfig = Omit<SandboxRuntimeConfig, "network"> & {
  enabled?: boolean;
  sandboxUserShell?: boolean;
  permissionPromptTimeoutSeconds?: number;
  network?: NonNullable<SandboxRuntimeConfig["network"]> & {
    allowUnauthenticatedSocksProxy?: boolean;
    /** Route ordinary `ssh` commands through the sandbox SOCKS proxy. */
    sshProxy?: boolean;
  };
};

type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;

export type SandboxConfigFile = Omit<Partial<SandboxConfig>, "network" | "filesystem"> & {
  network?: Partial<NetworkConfig>;
  filesystem?: Partial<FilesystemConfig>;
};

export const DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS = 10 * 60;

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  sandboxUserShell: true,
  permissionPromptTimeoutSeconds: DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  network: {
    allowUnauthenticatedSocksProxy: process.platform === "darwin",
    sshProxy: true,
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["/Users", "/home"],
    allowRead: [".", "~/.config", "~/.local", "Library"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnInvalidArray(label: string, value: unknown): void {
  if (value !== undefined) {
    console.error(`Warning: Ignoring invalid ${label}; expected an array of strings`);
  }
}

function stringArray(value: unknown, label = "configuration array"): string[] | undefined {
  if (!Array.isArray(value)) {
    warnInvalidArray(label, value);
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === "string");
  if (strings.length !== value.length) {
    console.error(`Warning: Ignoring non-string entries in ${label}`);
  }
  return strings;
}

function configuredSection(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function mergeObjects(base: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
  const network = configuredSection(overrides.network);
  const filesystem = configuredSection(overrides.filesystem);

  return {
    ...base,
    ...overrides,
    network: { ...base.network, ...network } as NetworkConfig,
    filesystem: { ...base.filesystem, ...filesystem } as FilesystemConfig,
  };
}

function mergeConfiguredArray(
  defaultsValue: unknown,
  globalValue: unknown,
  projectValue: unknown,
  label: string,
): string[] | undefined {
  const values = [
    stringArray(defaultsValue, `${label} defaults`),
    stringArray(globalValue, `${label} global configuration`),
    stringArray(projectValue, `${label} project configuration`),
  ];
  if (values.every((entries) => entries === undefined)) return undefined;
  return [...new Set(values.flatMap((entries) => entries ?? []))];
}

function mergeIgnoreViolations(
  defaultsValue: unknown,
  globalValue: unknown,
  projectValue: unknown,
): Record<string, string[]> | undefined {
  const result: Record<string, string[]> = {};
  let foundObject = false;

  for (const [scope, value] of [
    ["defaults", defaultsValue],
    ["global configuration", globalValue],
    ["project configuration", projectValue],
  ] as const) {
    if (value === undefined) continue;
    if (!isRecord(value)) {
      console.error(`Warning: Ignoring invalid ignoreViolations in ${scope}; expected an object`);
      continue;
    }
    foundObject = true;
    for (const [key, entries] of Object.entries(value)) {
      const strings = stringArray(entries, `ignoreViolations[${key}] in ${scope}`);
      if (strings === undefined) continue;
      result[key] = [...new Set([...(result[key] ?? []), ...strings])];
    }
  }

  return foundObject ? result : undefined;
}

export function mergeConfigLayers(
  defaults: SandboxConfig,
  globalConfig: SandboxConfigFile,
  projectConfig: SandboxConfigFile,
): SandboxConfig {
  const merged = mergeObjects(mergeObjects(defaults, globalConfig), projectConfig);
  const defaultsNetwork = configuredSection(defaults.network);
  const globalNetwork = configuredSection(globalConfig.network);
  const projectNetwork = configuredSection(projectConfig.network);
  const defaultsFilesystem = configuredSection(defaults.filesystem);
  const globalFilesystem = configuredSection(globalConfig.filesystem);
  const projectFilesystem = configuredSection(projectConfig.filesystem);

  return {
    ...merged,
    ignoreViolations: mergeIgnoreViolations(
      defaults.ignoreViolations,
      globalConfig.ignoreViolations,
      projectConfig.ignoreViolations,
    ),
    network: {
      ...merged.network,
      allowedDomains:
        mergeConfiguredArray(
          defaultsNetwork.allowedDomains,
          globalNetwork.allowedDomains,
          projectNetwork.allowedDomains,
          "network.allowedDomains",
        ) ?? [],
      deniedDomains:
        mergeConfiguredArray(
          defaultsNetwork.deniedDomains,
          globalNetwork.deniedDomains,
          projectNetwork.deniedDomains,
          "network.deniedDomains",
        ) ?? [],
      allowUnixSockets: mergeConfiguredArray(
        defaultsNetwork.allowUnixSockets,
        globalNetwork.allowUnixSockets,
        projectNetwork.allowUnixSockets,
        "network.allowUnixSockets",
      ),
      allowMachLookup: mergeConfiguredArray(
        defaultsNetwork.allowMachLookup,
        globalNetwork.allowMachLookup,
        projectNetwork.allowMachLookup,
        "network.allowMachLookup",
      ),
    },
    filesystem: {
      ...merged.filesystem,
      denyRead:
        mergeConfiguredArray(
          defaultsFilesystem.denyRead,
          globalFilesystem.denyRead,
          projectFilesystem.denyRead,
          "filesystem.denyRead",
        ) ?? [],
      allowRead: mergeConfiguredArray(
        defaultsFilesystem.allowRead,
        globalFilesystem.allowRead,
        projectFilesystem.allowRead,
        "filesystem.allowRead",
      ),
      allowWrite:
        mergeConfiguredArray(
          defaultsFilesystem.allowWrite,
          globalFilesystem.allowWrite,
          projectFilesystem.allowWrite,
          "filesystem.allowWrite",
        ) ?? [],
      denyWrite:
        mergeConfiguredArray(
          defaultsFilesystem.denyWrite,
          globalFilesystem.denyWrite,
          projectFilesystem.denyWrite,
          "filesystem.denyWrite",
        ) ?? [],
    },
  };
}

function readJsonConfig(configPath: string, warn: boolean): SandboxConfigFile {
  if (!existsSync(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("configuration must be a JSON object");
    }
    return parsed as SandboxConfigFile;
  } catch (error) {
    if (warn) console.error(`Warning: Could not parse ${configPath}: ${error}`);
    return {};
  }
}

export function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
  return {
    globalPath: join(getAgentDir(), "sandbox.json"),
    projectPath: join(cwd, ".pi", "sandbox.json"),
  };
}

export function loadConfig(cwd: string): SandboxConfig {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  const globalConfig = readJsonConfig(globalPath, true);
  const projectConfig = readJsonConfig(projectPath, true);
  return mergeConfigLayers(DEFAULT_CONFIG, globalConfig, projectConfig);
}

function writeConfigFile(configPath: string, config: SandboxConfigFile): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function addDomainToConfig(configPath: string, domain: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.network?.allowedDomains) ?? [];
  if (existing.includes(domain)) return;

  config.network = {
    ...config.network,
    allowedDomains: [...existing, domain],
  };
  writeConfigFile(configPath, config);
}

export function addReadPathToConfig(configPath: string, pathToAdd: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.filesystem?.allowRead) ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowRead: [...existing, pathToAdd],
  };
  writeConfigFile(configPath, config);
}

export function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readJsonConfig(configPath, false);
  const existing = stringArray(config.filesystem?.allowWrite) ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowWrite: [...existing, pathToAdd],
  };
  writeConfigFile(configPath, config);
}
