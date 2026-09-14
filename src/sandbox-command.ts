import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getConfigPaths, readConfigFile } from "./config.ts";
import { canonicalizePath, canonicalizePathPattern } from "./policy.ts";

export type SandboxCommandKey =
  | "allowRead"
  | "denyRead"
  | "allowWrite"
  | "denyWrite"
  | "allowedDomains"
  | "deniedDomains";

export interface SandboxCommand {
  key: SandboxCommandKey;
  value: string;
}

export interface SandboxConfigForCommand {
  network?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
    [key: string]: unknown;
  };
  filesystem?: {
    allowRead?: string[];
    denyRead?: string[];
    allowWrite?: string[];
    denyWrite?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SandboxCommandResult {
  command: SandboxCommand;
  changed: boolean;
  config: SandboxConfigForCommand;
}

const COMMANDS: readonly SandboxCommandKey[] = [
  "allowRead",
  "denyRead",
  "allowWrite",
  "denyWrite",
  "allowedDomains",
  "deniedDomains",
];

const COMMAND_TO_SECTION = {
  allowRead: ["filesystem", "allowRead"],
  denyRead: ["filesystem", "denyRead"],
  allowWrite: ["filesystem", "allowWrite"],
  denyWrite: ["filesystem", "denyWrite"],
  allowedDomains: ["network", "allowedDomains"],
  deniedDomains: ["network", "deniedDomains"],
} as const satisfies Record<SandboxCommandKey, readonly ["filesystem" | "network", string]>;

const DOMAIN_LABEL = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)$/;

export function formatSandboxCommandUsage(): string {
  return [
    "Usage:",
    "  /sandbox",
    "  /sandbox allowRead <path>",
    "  /sandbox denyRead <path>",
    "  /sandbox allowWrite <path>",
    "  /sandbox denyWrite <path>",
    "  /sandbox allowedDomains <domain>",
    "  /sandbox deniedDomains <domain>",
  ].join("\n");
}

export function parseSandboxCommand(
  args: string | readonly string[],
  cwd = process.cwd(),
): SandboxCommand | null {
  const parts: string[] =
    typeof args === "string"
      ? args.trim().length === 0
        ? []
        : args.trim().split(/\s+/)
      : [...args];
  if (parts.length === 0) return null;

  const [key, ...valueParts] = parts;
  if (!isSandboxCommandKey(key) || valueParts.length === 0) {
    throw new Error(formatSandboxCommandUsage());
  }

  const value = valueParts.join(" ").trim();
  const validationError = validateSandboxCommandValue(key, value, cwd);
  if (validationError) {
    throw new Error(`${formatSandboxCommandUsage()}\nError: ${validationError}`);
  }
  return { key, value };
}

/**
 * Validate the values accepted by the policy matcher, without applying a rule.
 * The command intentionally accepts filesystem patterns (including globs) but
 * only hostname patterns for network rules.
 */
export function validateSandboxCommandValue(
  key: SandboxCommandKey,
  value: string,
  cwd = process.cwd(),
): string | null {
  if (value.length === 0 || value.trim().length === 0) return "Rule value cannot be empty.";
  if (value.includes("\u0000") || value.includes("\r") || value.includes("\n")) {
    return "Rule value cannot contain control characters.";
  }

  if (key === "allowedDomains" || key === "deniedDomains") {
    if (!isDomainPattern(value)) {
      return `Invalid domain pattern: ${value}`;
    }
    return null;
  }

  try {
    canonicalizePathPattern(value, cwd);
  } catch {
    return `Invalid path pattern: ${value}`;
  }
  return null;
}

export function applySandboxCommand(
  config: SandboxConfigForCommand,
  command: SandboxCommand,
  cwd = process.cwd(),
): SandboxCommandResult {
  if (!isSandboxCommandKey(command.key)) {
    throw new Error(formatSandboxCommandUsage());
  }
  const validationError = validateSandboxCommandValue(command.key, command.value, cwd);
  if (validationError) throw new Error(`${formatSandboxCommandUsage()}\nError: ${validationError}`);

  const [sectionName, arrayName] = COMMAND_TO_SECTION[command.key];
  const section =
    sectionName === "filesystem"
      ? getObjectSection(config.filesystem)
      : getObjectSection(config.network);
  const existingValue = section?.[arrayName];
  const existing = getStringArray(existingValue);
  const duplicate = existing.some((value) => valuesEqual(command.key, value, command.value, cwd));
  if (duplicate) return { command, changed: false, config };

  const nextConfig: SandboxConfigForCommand = { ...config };
  if (sectionName === "filesystem") {
    nextConfig.filesystem = {
      ...getObjectSection(config.filesystem),
      [arrayName]: [...existing, command.value],
    };
  } else {
    nextConfig.network = {
      ...getObjectSection(config.network),
      [arrayName]: [...existing, command.value],
    };
  }
  return { command, changed: true, config: nextConfig };
}

/** Update exactly one rule array in a JSON config file. */
export function updateSandboxConfigFile(
  configPath: string,
  command: SandboxCommand,
  cwd = process.cwd(),
): SandboxCommandResult {
  const config = readConfigFile(configPath, false) as SandboxConfigForCommand;
  const result = applySandboxCommand(config, command, cwd);
  if (result.changed) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(result.config, null, 2) + "\n", "utf-8");
  }
  return result;
}

export function describeSandboxCommandResult(result: SandboxCommandResult): string {
  const [sectionName, arrayName] = COMMAND_TO_SECTION[result.command.key];
  const target = `${sectionName}.${arrayName}`;
  const state = result.changed ? "Added" : "Already present";
  return `${state}: ${result.command.value} in ${target}`;
}

/** Canonical paths used by both policy checks and the OS-level runtime. */
export function getProtectedSandboxConfigPaths(cwd: string): {
  globalPath: string;
  projectPath: string;
} {
  const paths = getConfigPaths(cwd);
  return {
    globalPath: canonicalizePath(paths.globalPath, cwd),
    projectPath: canonicalizePath(paths.projectPath, cwd),
  };
}

export function isSandboxConfigPath(filePath: string, cwd: string): boolean {
  const protectedPaths = getProtectedSandboxConfigPaths(cwd);
  const canonical = canonicalizePath(filePath, cwd);
  return canonical === protectedPaths.projectPath || canonical === protectedPaths.globalPath;
}

/**
 * This check deliberately errs on the side of blocking. Shell syntax is not
 * interpreted here: a command containing a known project/global config
 * spelling is stopped before sandbox state or policy checks are consulted.
 */
export function bashCommandMentionsSandboxConfig(command: string, cwd: string): boolean {
  const paths = getConfigPaths(cwd);
  const protectedPaths = getProtectedSandboxConfigPaths(cwd);
  const mentions = [
    ".pi/sandbox.json",
    "~/.pi/agent/sandbox.json",
    paths.projectPath,
    paths.globalPath,
    protectedPaths.projectPath,
    protectedPaths.globalPath,
  ];
  return mentions.some((mention) => command.includes(mention));
}

function getObjectSection(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isSandboxCommandKey(value: string | undefined): value is SandboxCommandKey {
  return value !== undefined && COMMANDS.includes(value as SandboxCommandKey);
}

function isDomainPattern(value: string): boolean {
  const normalized = value.trim();
  if (normalized === "*") return true;
  const domain = normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
  if (domain.length === 0 || (domain.startsWith("*.") === false && domain.includes("*")))
    return false;
  const labels = domain.startsWith("*.") ? domain.slice(2).split(".") : domain.split(".");
  return labels.length > 0 && labels.every((label) => DOMAIN_LABEL.test(label));
}

function valuesEqual(key: SandboxCommandKey, first: string, second: string, cwd: string): boolean {
  if (key === "allowedDomains" || key === "deniedDomains") {
    return normalizeDomain(first) === normalizeDomain(second);
  }
  try {
    return canonicalizePathPattern(first, cwd) === canonicalizePathPattern(second, cwd);
  } catch {
    return first === second;
  }
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}
