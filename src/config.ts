import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CredentialsConfigSchema,
  FilesystemConfigSchema,
  NetworkConfigSchema,
  SandboxRuntimeConfigSchema,
  type CredentialEnvVarConfig,
  type CredentialFileConfig,
  type CredentialsConfig,
  type SandboxRuntimeConfig,
} from "@carderne/sandbox-runtime";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SandboxConfig = Omit<SandboxRuntimeConfig, "network" | "credentials"> & {
  enabled?: boolean;
  permissionPromptTimeoutSeconds?: number;
  credentials?: CredentialsConfig;
  network?: NonNullable<SandboxRuntimeConfig["network"]> & {
    allowUnauthenticatedSocksProxy?: boolean;
  };
};

type NetworkConfig = NonNullable<SandboxConfig["network"]>;
type FilesystemConfig = NonNullable<SandboxConfig["filesystem"]>;

export type SandboxConfigFile = Omit<
  Partial<SandboxConfig>,
  "network" | "filesystem" | "credentials"
> & {
  /** Raw here so loading can validate and reject untrusted credential entries. */
  credentials?: unknown;
  network?: Partial<NetworkConfig>;
  filesystem?: Partial<FilesystemConfig>;
};

export const DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS = 10 * 60;

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  permissionPromptTimeoutSeconds: DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  network: {
    allowUnauthenticatedSocksProxy: process.platform === "darwin",
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
    denyWrite: [".env", ".env.*", "**/*.pem", "**/*.key"],
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

type ConfigValueSchema = { safeParse(value: unknown): { success: boolean } };
type ScalarValidator = { schema: ConfigValueSchema; expected: string };

const runtimeConfigShape = SandboxRuntimeConfigSchema.innerType().shape;

const runtimeConfigScalarKeys = [
  "enableWeakerNestedSandbox",
  "enableWeakerNetworkIsolation",
  "allowAppleEvents",
  "ripgrep",
  "mandatoryDenySearchDepth",
  "allowPty",
  "allowBrowserProcess",
  "seccomp",
  "bwrapPath",
  "socatPath",
  "windows",
] as const;

const topLevelScalarValidators: Record<string, ScalarValidator> = {
  enabled: {
    schema: { safeParse: (value) => ({ success: typeof value === "boolean" }) },
    expected: "a boolean",
  },
  permissionPromptTimeoutSeconds: {
    schema: {
      safeParse: (value) => ({ success: typeof value === "number" && Number.isFinite(value) }),
    },
    expected: "a finite number",
  },
  ...Object.fromEntries(
    runtimeConfigScalarKeys.map((key) => [
      key,
      {
        schema: runtimeConfigShape[key],
        expected: "a valid sandbox-runtime value",
      },
    ]),
  ),
};

const networkScalarValidators: Record<string, ScalarValidator> = {
  strictAllowlist: { schema: NetworkConfigSchema.shape.strictAllowlist, expected: "a boolean" },
  allowAllUnixSockets: {
    schema: NetworkConfigSchema.shape.allowAllUnixSockets,
    expected: "a boolean",
  },
  allowLocalBinding: { schema: NetworkConfigSchema.shape.allowLocalBinding, expected: "a boolean" },
  httpProxyPort: {
    schema: NetworkConfigSchema.shape.httpProxyPort,
    expected: "an integer from 1 to 65535",
  },
  socksProxyPort: {
    schema: NetworkConfigSchema.shape.socksProxyPort,
    expected: "an integer from 1 to 65535",
  },
  allowUnauthenticatedSocksProxy: {
    schema: NetworkConfigSchema.shape.allowUnauthenticatedSocksProxy,
    expected: "a boolean",
  },
  mitmProxy: {
    schema: NetworkConfigSchema.shape.mitmProxy,
    expected: "a valid MITM proxy configuration",
  },
  tlsTerminate: {
    schema: NetworkConfigSchema.shape.tlsTerminate,
    expected: "a valid TLS termination configuration",
  },
  parentProxy: {
    schema: NetworkConfigSchema.shape.parentProxy,
    expected: "a valid parent proxy configuration",
  },
  filterRequest: {
    schema: NetworkConfigSchema.shape.filterRequest,
    expected: "a function",
  },
};

function validatedSection(
  value: unknown,
  label: string,
  validators: Record<string, ScalarValidator>,
): Record<string, unknown> {
  const result = { ...configuredSection(value) };
  for (const [key, { schema, expected }] of Object.entries(validators)) {
    if (!Object.hasOwn(result, key)) continue;
    if (result[key] === undefined) {
      delete result[key];
    } else if (!schema.safeParse(result[key]).success) {
      const path = label ? `${label}.${key}` : key;
      console.error(`Warning: Ignoring invalid ${path}; expected ${expected}`);
      delete result[key];
    }
  }
  return result;
}

function mergeObjects(base: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
  if (Object.hasOwn(overrides, "sandboxUserShell")) {
    console.error(
      "Warning: Ignoring deprecated sandboxUserShell; use explicit per-command approval to bypass manual !/!! sandboxing",
    );
  }
  const network = validatedSection(overrides.network, "network", networkScalarValidators);
  const { sshProxy: _ignoredSshProxy, ...safeNetwork } = network;
  const filesystem = validatedSection(overrides.filesystem, "filesystem", {
    disabled: { schema: FilesystemConfigSchema.shape.disabled, expected: "a boolean" },
  });
  const {
    credentials: _ignoredCredentials,
    sandboxUserShell: _ignoredSandboxUserShell,
    ...safeOverrides
  } = validatedSection(overrides, "", topLevelScalarValidators);

  return {
    ...base,
    ...safeOverrides,
    network: { ...base.network, ...safeNetwork } as NetworkConfig,
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

type CredentialEntry = CredentialEnvVarConfig | CredentialFileConfig;

const credentialConfigKeys = new Set(["files", "envVars", "allowPlaintextInject"]);
const credentialFileKeys = new Set([
  "path",
  "mode",
  "extract",
  "onExtractNoMatch",
  "decode",
  "maskClaims",
  "maskDuplicates",
  "injectHosts",
]);
const credentialEnvKeys = new Set([
  "name",
  "mode",
  "extract",
  "onExtractNoMatch",
  "decode",
  "maskClaims",
  "injectHosts",
]);

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function warnInvalidCredentials(scope: "global" | "project", detail: string): void {
  console.error(`Warning: Ignoring ${scope} credentials ${detail}`);
}

function validateCredentialEntry(
  value: unknown,
  kind: "file" | "env",
  scope: "global" | "project",
  index: number,
): CredentialEntry | undefined {
  if (!isRecord(value)) {
    warnInvalidCredentials(scope, `entry ${kind}[${index}]; expected policy metadata`);
    return undefined;
  }

  const keys = kind === "file" ? credentialFileKeys : credentialEnvKeys;
  if (!hasOnlyKeys(value, keys)) {
    warnInvalidCredentials(
      scope,
      `entry ${kind}[${index}]; unknown fields are not accepted (credential values are never configuration)`,
    );
    return undefined;
  }

  const parsed = CredentialsConfigSchema.safeParse(
    kind === "file" ? { files: [value] } : { envVars: [value] },
  );
  if (!parsed.success) {
    warnInvalidCredentials(scope, `entry ${kind}[${index}]; invalid runtime policy metadata`);
    return undefined;
  }

  const entry = kind === "file" ? parsed.data.files?.[0] : parsed.data.envVars?.[0];
  if (!entry) {
    warnInvalidCredentials(scope, `entry ${kind}[${index}]; invalid runtime policy metadata`);
    return undefined;
  }

  // sandbox-runtime 0.0.72 ignores onExtractNoMatch when JWT verification or
  // claim matching fails for environment variables. The inherited value then
  // remains visible in the sandbox, so no environment decode policy may cross
  // this validated boundary. Whole-value and regex extraction masking remain
  // supported because their fail-closed mismatch paths are handled below.
  if (kind === "env" && entry.decode !== undefined) {
    warnInvalidCredentials(
      scope,
      `entry ${kind}[${index}]; decode policies are not supported for environment variables with sandbox-runtime 0.0.72; use whole-value or regex extraction masking`,
    );
    return undefined;
  }

  if (entry.mode === "mask") {
    if (!entry.injectHosts || entry.injectHosts.length === 0) {
      warnInvalidCredentials(
        scope,
        `entry ${kind}[${index}]; mask mode requires a nonempty explicit injectHosts list`,
      );
      return undefined;
    }
    if (entry.injectHosts.some((host) => host === "*")) {
      warnInvalidCredentials(
        scope,
        `entry ${kind}[${index}]; mask mode does not accept the unscoped injectHosts wildcard`,
      );
      return undefined;
    }
  }

  if (
    (entry.extract !== undefined || entry.decode !== undefined) &&
    entry.onExtractNoMatch !== "deny" &&
    entry.onExtractNoMatch !== "error"
  ) {
    warnInvalidCredentials(
      scope,
      `entry ${kind}[${index}]; extract/decode requires onExtractNoMatch deny or error`,
    );
    return undefined;
  }

  if (entry.maskClaims !== undefined && entry.decode === undefined) {
    warnInvalidCredentials(scope, `entry ${kind}[${index}]; maskClaims requires decode`);
    return undefined;
  }
  if (entry.maskClaims !== undefined && entry.maskClaims.length === 0) {
    warnInvalidCredentials(scope, `entry ${kind}[${index}]; maskClaims must not be empty`);
    return undefined;
  }
  if (
    kind === "file" &&
    entry.mode === "mask" &&
    (entry as CredentialFileConfig).path.endsWith("/")
  ) {
    warnInvalidCredentials(
      scope,
      `entry ${kind}[${index}]; mask mode applies to a single file, not a directory`,
    );
    return undefined;
  }

  return entry;
}

/**
 * Validate the policy-only credentials boundary. Values and unknown fields are
 * rejected rather than copied into the runtime configuration.
 */
export function validateCredentials(
  value: unknown,
  scope: "global" | "project" = "global",
): CredentialsConfig | undefined {
  if (scope === "project") {
    if (value !== undefined) {
      console.error(
        "Warning: Ignoring project credentials; credential declarations are global-only and project configuration is untrusted",
      );
    }
    return undefined;
  }
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, credentialConfigKeys)) {
    warnInvalidCredentials("global", "; expected policy metadata only");
    return undefined;
  }

  const result: CredentialsConfig = {};
  if (value.allowPlaintextInject !== undefined) {
    if (typeof value.allowPlaintextInject !== "boolean") {
      warnInvalidCredentials("global", "; allowPlaintextInject must be a boolean");
    } else if (value.allowPlaintextInject) {
      warnInvalidCredentials(
        "global",
        "; plaintext credential injection is not permitted by the fail-closed policy",
      );
    } else {
      result.allowPlaintextInject = false;
    }
  }

  for (const [key, kind] of [
    ["files", "file"],
    ["envVars", "env"],
  ] as const) {
    const entries = value[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      warnInvalidCredentials("global", `${key}; expected an array of policy entries`);
      continue;
    }
    const validEntries = entries
      .map((entry, index) => validateCredentialEntry(entry, kind, "global", index))
      .filter((entry): entry is CredentialEntry => entry !== undefined);
    if (validEntries.length === 0 && entries.length > 0) continue;
    if (kind === "file") result.files = validEntries as CredentialFileConfig[];
    else result.envVars = validEntries as CredentialEnvVarConfig[];
  }

  if (
    result.files === undefined &&
    result.envVars === undefined &&
    result.allowPlaintextInject === undefined
  ) {
    return undefined;
  }
  return result;
}

export function mergeConfigLayers(
  defaults: SandboxConfig,
  globalConfig: SandboxConfigFile,
  projectConfig: SandboxConfigFile,
): SandboxConfig {
  const merged = mergeObjects(mergeObjects(defaults, globalConfig), projectConfig);
  const credentials =
    globalConfig.credentials === undefined
      ? defaults.credentials
      : validateCredentials(globalConfig.credentials, "global");
  validateCredentials(projectConfig.credentials, "project");
  const defaultsNetwork = configuredSection(defaults.network);
  const globalNetwork = configuredSection(globalConfig.network);
  const projectNetwork = configuredSection(projectConfig.network);
  const defaultsFilesystem = configuredSection(defaults.filesystem);
  const globalFilesystem = configuredSection(globalConfig.filesystem);
  const projectFilesystem = configuredSection(projectConfig.filesystem);

  return {
    ...merged,
    credentials,
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

export function readConfigFile(configPath: string, warn = true): SandboxConfigFile {
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
  const globalConfig = readConfigFile(globalPath, true);
  const projectConfig = readConfigFile(projectPath, true);
  return mergeConfigLayers(DEFAULT_CONFIG, globalConfig, projectConfig);
}
