import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
  enabled?: boolean;
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

const COMMANDS: SandboxCommandKey[] = [
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

export function parseSandboxCommand(args: string | string[]): SandboxCommand | null {
  const parts = Array.isArray(args) ? args : args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const [key, ...valueParts] = parts;
  if (!isSandboxCommandKey(key) || valueParts.length === 0) {
    throw new Error(formatSandboxCommandUsage());
  }

  return { key, value: valueParts.join(" ") };
}

export function applySandboxCommand(
  config: SandboxConfigForCommand,
  command: SandboxCommand,
): SandboxCommandResult {
  const [sectionName, arrayName] = COMMAND_TO_SECTION[command.key];
  const nextConfig: SandboxConfigForCommand = { ...config };

  if (sectionName === "filesystem") {
    const filesystem = { ...config.filesystem };
    const existing = getStringArray(filesystem[arrayName]);
    const changed = !existing.includes(command.value);
    filesystem[arrayName] = changed ? [...existing, command.value] : existing;
    nextConfig.filesystem = filesystem;
    return { command, changed, config: nextConfig };
  }

  const network = { ...config.network };
  const existing = getStringArray(network[arrayName]);
  const changed = !existing.includes(command.value);
  network[arrayName] = changed ? [...existing, command.value] : existing;
  nextConfig.network = network;
  return { command, changed, config: nextConfig };
}

export function updateSandboxConfigFile(
  configPath: string,
  command: SandboxCommand,
): SandboxCommandResult {
  const config = readSandboxCommandConfig(configPath);
  const result = applySandboxCommand(config, command);
  writeSandboxCommandConfig(configPath, result.config);
  return result;
}

function readSandboxCommandConfig(configPath: string): SandboxConfigForCommand {
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, "utf-8")) as SandboxConfigForCommand;
}

function writeSandboxCommandConfig(configPath: string, config: SandboxConfigForCommand): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function describeSandboxCommandResult(result: SandboxCommandResult): string {
  const [sectionName, arrayName] = COMMAND_TO_SECTION[result.command.key];
  const target = `${sectionName}.${arrayName}`;
  const state = result.changed ? "Added" : "Already present";
  return `${state}: ${result.command.value} in ${target}`;
}

function isSandboxCommandKey(value: string): value is SandboxCommandKey {
  return COMMANDS.includes(value as SandboxCommandKey);
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
