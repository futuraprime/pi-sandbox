import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getConfigPaths, readConfigFile } from "./config.ts";
import { pathsEqualConsideringVolumeCase } from "./path-security.ts";
import { canonicalizePath, canonicalizePathPattern } from "./policy.ts";

export type SandboxAllowKind = "domain" | "read" | "write";
type SandboxAllowRuleKey = "allowedDomains" | "allowRead" | "allowWrite";
type SandboxPolicyKey = SandboxAllowRuleKey | "denyRead" | "denyWrite" | "deniedDomains";

export interface SandboxAllowCommand {
  kind: SandboxAllowKind;
  key: SandboxAllowRuleKey;
  value: string;
}

interface SandboxRuleUpdate {
  key: SandboxAllowRuleKey;
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

export interface SandboxConfigUpdateResult {
  changed: boolean;
  config: SandboxConfigForCommand;
}

const KIND_TO_KEY = {
  domain: "allowedDomains",
  read: "allowRead",
  write: "allowWrite",
} as const satisfies Record<SandboxAllowKind, SandboxAllowRuleKey>;

const COMMAND_TO_SECTION = {
  allowRead: ["filesystem", "allowRead"],
  allowWrite: ["filesystem", "allowWrite"],
  allowedDomains: ["network", "allowedDomains"],
} as const satisfies Record<SandboxAllowRuleKey, readonly ["filesystem" | "network", string]>;

const DOMAIN_LABEL = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)$/;

export function formatSandboxAllowUsage(): string {
  return "Usage: /sandbox-allow domain|read|write <target>";
}

export function parseSandboxAllowCommand(args: string, cwd = process.cwd()): SandboxAllowCommand {
  const input = args.trim();
  const separator = input.search(/\s/);
  const kind = separator < 0 ? input : input.slice(0, separator);
  const value = separator < 0 ? "" : input.slice(separator).trim();
  if (!isSandboxAllowKind(kind) || value.length === 0) {
    throw new Error(formatSandboxAllowUsage());
  }

  const validationError = validateSandboxAllowTarget(kind, value, cwd);
  if (validationError) {
    throw new Error(`${formatSandboxAllowUsage()}\nError: ${validationError}`);
  }
  return { kind, key: KIND_TO_KEY[kind], value };
}

export function validateSandboxAllowTarget(
  kind: SandboxAllowKind,
  value: string,
  cwd = process.cwd(),
): string | null {
  if (value.length === 0 || value.trim().length === 0) return "Target cannot be empty.";
  if (value.includes("\u0000") || value.includes("\r") || value.includes("\n")) {
    return "Target cannot contain control characters.";
  }

  if (kind === "domain") {
    if (value.includes("*")) return "Domain target must be a single hostname, not a pattern.";
    return validateSandboxCommandValue("allowedDomains", value, cwd);
  }

  if (/[*!?]/.test(value)) return "Filesystem target must be a concrete path, not a pattern.";
  if (kind === "write" && isSandboxConfigPath(value, cwd)) {
    return "Sandbox configuration files cannot receive write allowances.";
  }
  try {
    canonicalizePath(value, cwd);
  } catch {
    return `Invalid path target: ${value}`;
  }
  return null;
}

/**
 * Validate policy values accepted by the matcher. Prompt editing deliberately
 * accepts filesystem patterns; the command parser separately requires a
 * concrete target before opening the editor.
 */
export function validateSandboxCommandValue(
  key: SandboxPolicyKey,
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

/**
 * The one sanctioned persistence path for approved positive grants. Deny rules
 * are intentionally not editable through the approval prompt.
 */
export function updateSandboxConfigFile(
  configPath: string,
  command: SandboxRuleUpdate,
  cwd = process.cwd(),
): SandboxConfigUpdateResult {
  if (!isSandboxAllowRuleKey(command.key)) {
    throw new Error(formatSandboxAllowUsage());
  }
  const validationError = validateSandboxCommandValue(command.key, command.value, cwd);
  if (validationError) throw new Error(`${formatSandboxAllowUsage()}\nError: ${validationError}`);

  const config = readConfigFile(configPath, false) as SandboxConfigForCommand;
  const [sectionName, arrayName] = COMMAND_TO_SECTION[command.key];
  const section =
    sectionName === "filesystem"
      ? getObjectSection(config.filesystem)
      : getObjectSection(config.network);
  const existing = getStringArray(section[arrayName]);
  const duplicate = existing.some((value) => valuesEqual(command.key, value, command.value, cwd));
  const nextConfig: SandboxConfigForCommand = config;
  if (!duplicate) {
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
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(nextConfig, null, 2) + "\n", "utf-8");
  }
  return { changed: !duplicate, config: nextConfig };
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
  return (
    pathsEqualConsideringVolumeCase(filePath, protectedPaths.projectPath, cwd) ||
    pathsEqualConsideringVolumeCase(filePath, protectedPaths.globalPath, cwd)
  );
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

function isSandboxAllowKind(value: string): value is SandboxAllowKind {
  return value === "domain" || value === "read" || value === "write";
}

function isSandboxAllowRuleKey(value: string): value is SandboxAllowRuleKey {
  return value === "allowedDomains" || value === "allowRead" || value === "allowWrite";
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

function valuesEqual(
  key: SandboxAllowRuleKey,
  first: string,
  second: string,
  cwd: string,
): boolean {
  if (key === "allowedDomains") {
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
