import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";

export type SandboxDiagnosticType =
  | "ssh-auth"
  | "browser-process"
  | "read"
  | "write"
  | "network"
  | "ambiguous";

export type SandboxPromptChoice =
  | "abort"
  | "session"
  | "project"
  | "global"
  | "ssh-session"
  | "none";

export interface SandboxDiagnostic {
  type: SandboxDiagnosticType;
  target: string;
  rule: string;
  promptable: boolean;
  action: string;
  rawTarget?: string;
}

export interface SandboxIncident {
  id: string;
  timestamp: Date;
  source: "bash" | "user_bash";
  commandPreview: string;
  commandKey: string;
  attributed: boolean;
  violations: SandboxDiagnostic[];
  primaryViolation?: SandboxDiagnostic;
  promptShown: boolean;
  promptChoice: SandboxPromptChoice;
  promptCount: number;
  retried: boolean;
  finalOutcome: "success" | "failure";
  configMutation: "none" | ".pi/sandbox.json" | "~/.pi/agent/sandbox.json";
}

export interface SandboxDiagnosticBlockData {
  type: SandboxDiagnosticType;
  target: string;
  rule: string;
  prompted: boolean;
  choice: SandboxPromptChoice;
  retried: boolean;
  finalOutcome: "success" | "failure";
  otherViolations: number;
  action: string;
}

export interface ParsedSandboxDiagnosticBlock {
  data: SandboxDiagnosticBlockData;
  block: string;
  visibleText: string;
}

const PRIMARY_PRIORITY: Record<SandboxDiagnosticType, number> = {
  "ssh-auth": 0,
  "browser-process": 1,
  read: 2,
  write: 3,
  network: 4,
  ambiguous: 5,
};

export function selectPrimaryViolation(
  violations: SandboxDiagnostic[],
): SandboxDiagnostic | undefined {
  if (violations.length === 0) return undefined;
  return [...violations].sort((a, b) => {
    const priorityDiff = PRIMARY_PRIORITY[a.type] - PRIMARY_PRIORITY[b.type];
    if (priorityDiff !== 0) return priorityDiff;
    if (a.promptable !== b.promptable) return a.promptable ? -1 : 1;
    return a.target.localeCompare(b.target);
  })[0];
}

export function diagnosticIdentity(diagnostic: SandboxDiagnostic): string {
  return `${diagnostic.type}::${diagnostic.target}::${diagnostic.rule}`;
}

export function isMateriallyDifferent(
  a: SandboxDiagnostic | undefined,
  b: SandboxDiagnostic | undefined,
): boolean {
  if (!a || !b) return false;
  return diagnosticIdentity(a) !== diagnosticIdentity(b);
}

export function getDiagnosticBlockData(
  incident: SandboxIncident,
): SandboxDiagnosticBlockData | null {
  if (!incident.attributed || !incident.primaryViolation) return null;
  const primary = incident.primaryViolation;
  return {
    type: primary.type,
    target: primary.target,
    rule: primary.rule,
    prompted: incident.promptShown,
    choice: incident.promptChoice,
    retried: incident.retried,
    finalOutcome: incident.finalOutcome,
    otherViolations: Math.max(0, incident.violations.length - 1),
    action: primary.action,
  };
}

export function renderDiagnosticBlockData(data: SandboxDiagnosticBlockData): string {
  return [
    "<sandbox_diagnostic>",
    `type: ${data.type}`,
    `target: ${data.target}`,
    `rule: ${data.rule}`,
    `prompted: ${data.prompted ? "yes" : "no"}`,
    `choice: ${data.choice}`,
    `retried: ${data.retried ? "yes" : "no"}`,
    `final_outcome: ${data.finalOutcome}`,
    `other_violations: ${data.otherViolations}`,
    `action: ${data.action}`,
    "</sandbox_diagnostic>",
  ].join("\n");
}

export function renderDiagnosticBlock(incident: SandboxIncident): string | null {
  const data = getDiagnosticBlockData(incident);
  return data ? renderDiagnosticBlockData(data) : null;
}

export function parseDiagnosticBlock(text: string): ParsedSandboxDiagnosticBlock | null {
  const match = text.match(/\n*<sandbox_diagnostic>\n([\s\S]*?)\n<\/sandbox_diagnostic>\s*$/);
  if (!match) return null;

  const body = match[1] ?? "";
  const fields = new Map<string, string>();
  for (const line of body.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    fields.set(key, value);
  }

  const type = fields.get("type");
  const target = fields.get("target");
  const rule = fields.get("rule");
  const choice = fields.get("choice") as SandboxPromptChoice | undefined;
  const finalOutcome = fields.get("final_outcome") as "success" | "failure" | undefined;
  const action = fields.get("action");
  if (!type || !target || !rule || !choice || !finalOutcome || !action) return null;

  const data: SandboxDiagnosticBlockData = {
    type: type as SandboxDiagnosticType,
    target,
    rule,
    prompted: fields.get("prompted") === "yes",
    choice,
    retried: fields.get("retried") === "yes",
    finalOutcome,
    otherViolations: Number.parseInt(fields.get("other_violations") ?? "0", 10) || 0,
    action,
  };

  return {
    data,
    block: match[0].trim(),
    visibleText: text.slice(0, match.index).replace(/\s+$/, ""),
  };
}

function diagnosticTypeLabel(type: SandboxDiagnosticType): string {
  switch (type) {
    case "ssh-auth":
      return "SSH auth";
    case "browser-process":
      return "browser process";
    case "read":
      return "read access";
    case "write":
      return "write access";
    case "network":
      return "network access";
    case "ambiguous":
      return "sandbox intervention";
  }
}

function diagnosticChoiceLabel(choice: SandboxPromptChoice): string {
  switch (choice) {
    case "ssh-session":
      return "allowed for this session";
    case "session":
      return "allowed for this session";
    case "project":
      return "allowed for this project";
    case "global":
      return "allowed for all projects";
    case "abort":
      return "left blocked";
    case "none":
      return "not approved";
  }
}

export function renderDiagnosticNotice(data: SandboxDiagnosticBlockData): string {
  const parts = [diagnosticTypeLabel(data.type)];
  if (data.prompted) {
    parts.push(diagnosticChoiceLabel(data.choice));
  }
  if (data.retried) {
    parts.push(
      data.finalOutcome === "success" ? "retried successfully" : "retried but still failed",
    );
  } else {
    parts.push(data.finalOutcome === "success" ? "completed" : "blocked or failed");
  }
  return `[sandbox: ${parts.join("; ")} — /sandbox-debug for details]`;
}

export function retainIncident(incident: SandboxIncident): boolean {
  return incident.attributed || incident.promptShown;
}

export function trimIncidents<T>(incidents: T[], max: number): T[] {
  if (incidents.length <= max) return incidents;
  return incidents.slice(incidents.length - max);
}

export function summarizePromptChoice(choice: SandboxPromptChoice): string {
  switch (choice) {
    case "session":
      return "session";
    case "project":
      return "project";
    case "global":
      return "global";
    case "ssh-session":
      return "ssh-session";
    case "abort":
      return "abort";
    case "none":
      return "none";
  }
}

export function renderDiagnosticSummaryLines(data: SandboxDiagnosticBlockData): string[] {
  return [
    `Type: ${diagnosticTypeLabel(data.type)}`,
    `Target: ${data.target}`,
    `Rule: ${data.rule}`,
    `Prompted: ${data.prompted ? "yes" : "no"}`,
    `Choice: ${data.choice}`,
    `Retried: ${data.retried ? "yes" : "no"}`,
    `Final outcome: ${data.finalOutcome}`,
    `Other violations: ${data.otherViolations}`,
    `Action: ${data.action}`,
  ];
}

export function formatCommandPreview(command: string): string {
  const squashed = command.replace(/\s+/g, " ").trim();
  if (squashed.length <= 80) return squashed;
  return `${squashed.slice(0, 77)}...`;
}

function shellCommandWords(command: string): string[][] {
  const segments: string[][] = [[]];
  let word = "";
  let quote = "";
  let escaped = false;

  const finishWord = (): void => {
    if (word) segments.at(-1)?.push(word);
    word = "";
  };
  const finishSegment = (): void => {
    finishWord();
    segments.push([]);
  };

  for (let i = 0; i < command.length; i++) {
    const character = command[i];
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = "";
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character) && character !== "\n") {
      finishWord();
    } else if (
      character === ";" ||
      character === "\n" ||
      (character === "|" && command[i - 1] !== ">")
    ) {
      finishSegment();
      if ((character === "|" && command[i + 1] === "|") || command[i + 1] === "&") i++;
    } else if (
      character === "&" &&
      command[i - 1] !== ">" &&
      command[i - 1] !== "<" &&
      command[i + 1] !== ">"
    ) {
      finishSegment();
      if (command[i + 1] === "&") i++;
    } else {
      word += character;
    }
  }

  if (escaped) word += "\\";
  finishWord();
  return segments;
}

interface GitOperation {
  name: string;
  arguments: string[];
}

function trimShellGrouping(word: string): string {
  return word.replace(/^[({]+/, "").replace(/[)}]+$/, "");
}

function commandExecutableIndex(words: string[]): number {
  let index = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  if (index < 0) return index;

  while (index < words.length) {
    const executable = trimShellGrouping(words[index]).split("/").pop();
    if (executable === "command") {
      index++;
      while (words[index]?.startsWith("-")) {
        if (words[index] === "-v" || words[index] === "-V") return -1;
        index++;
      }
    } else if (executable === "env") {
      index++;
      while (index < words.length) {
        const word = words[index];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index++;
        else if (/^(?:-u|--unset|-C|--chdir|-S|--split-string)$/.test(word)) index += 2;
        else if (word.startsWith("-") && word !== "--") index++;
        else {
          if (word === "--") index++;
          break;
        }
      }
    } else if (executable === "!") {
      index++;
    } else {
      break;
    }
  }
  return index;
}

function gitOperation(words: string[]): GitOperation | null {
  const executableIndex = commandExecutableIndex(words);
  const executable = trimShellGrouping(words[executableIndex] ?? "")
    .split("/")
    .pop();
  if (executable !== "git") return null;

  let operationIndex = executableIndex + 1;
  const optionsWithValues = new Set([
    "-C",
    "-c",
    "--config-env",
    "--exec-path",
    "--git-dir",
    "--namespace",
    "--super-prefix",
    "--work-tree",
  ]);
  while (words[operationIndex]?.startsWith("-")) {
    if (words[operationIndex] === "--") return null;
    operationIndex += optionsWithValues.has(words[operationIndex]) ? 2 : 1;
  }
  const name = words[operationIndex];
  if (!name) return null;
  return { name, arguments: words.slice(operationIndex + 1) };
}

function isGitUpstreamOption(word: string): boolean {
  if (
    word === "--set-upstream" ||
    word.startsWith("--set-upstream=") ||
    word === "--set-upstream-to" ||
    word.startsWith("--set-upstream-to=")
  ) {
    return true;
  }

  // Git accepts short-option clusters, for example `git push -vu`.
  return /^-[^-]*u/.test(word);
}

function isTrackingConfigKey(word: string): boolean {
  return /^branch\..+\.(?:remote|merge)$/i.test(word);
}

function isTrackingConfigMutation(arguments_: string[]): boolean {
  const keyIndex = arguments_.findIndex(isTrackingConfigKey);
  if (keyIndex < 0) return false;

  const readOptions = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch"]);
  if (arguments_.some((word) => readOptions.has(word))) return false;

  const mutationOptions = new Set([
    "--add",
    "--replace-all",
    "--unset",
    "--unset-all",
    "set",
    "unset",
  ]);
  return (
    arguments_.some((word) => mutationOptions.has(word)) ||
    arguments_.slice(keyIndex + 1).some((word) => word !== "--")
  );
}

function isGitUpstreamMutationSegment(words: string[]): boolean {
  const operation = gitOperation(words);
  if (!operation) return false;
  if (
    (operation.name === "branch" || operation.name === "push") &&
    operation.arguments.some((word) => isGitUpstreamOption(word) || word === "--unset-upstream")
  ) {
    return true;
  }
  return operation.name === "config" && isTrackingConfigMutation(operation.arguments);
}

function nestedShellCommand(words: string[]): string | null {
  const executableIndex = commandExecutableIndex(words);
  const executable = trimShellGrouping(words[executableIndex] ?? "")
    .split("/")
    .pop();
  if (!/^(?:ba|da|k|z)?sh$/.test(executable ?? "")) return null;
  const commandOptionIndex = words.findIndex(
    (word, index) => index > executableIndex && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word),
  );
  return commandOptionIndex < 0 ? null : (words[commandOptionIndex + 1] ?? null);
}

export function isGitUpstreamMutationCommand(command: string): boolean {
  return shellCommandWords(command).some((words) => {
    if (isGitUpstreamMutationSegment(words)) return true;
    const nested = nestedShellCommand(words);
    return nested ? isGitUpstreamMutationCommand(nested) : false;
  });
}

function isSshCommandSegment(words: string[]): boolean {
  const executableIndex = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const executable = words[executableIndex]?.split("/").pop();
  if (executable === "ssh" || executable === "ssh-add") return true;
  if (executable !== "git") return false;

  let operationIndex = executableIndex + 1;
  const optionsWithValues = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
  while (words[operationIndex]?.startsWith("-")) {
    operationIndex += optionsWithValues.has(words[operationIndex]) ? 2 : 1;
  }
  if (!/^(clone|fetch|pull|push|ls-remote)$/.test(words[operationIndex] ?? "")) return false;

  const operationArguments = words.slice(operationIndex + 1);
  if (operationArguments.some((word) => /^(?:ssh|git\+ssh):\/\//i.test(word))) return true;
  if (operationArguments.some((word) => /^[^@\s]+@[^\s:]+:/.test(word))) return true;
  if (operationArguments.some((word) => /^https?:\/\//i.test(word))) return false;
  return true;
}

function isClearlySshTargetedCommand(command: string): boolean {
  return shellCommandWords(command).some(isSshCommandSegment);
}

export function shouldPreflightSshAuth(command: string): boolean {
  const segments = shellCommandWords(command);
  return segments.length > 1 && segments.some(isSshCommandSegment);
}

export function normaliseSocketPath(socketPath: string): string {
  const expanded =
    socketPath === "~"
      ? homedir()
      : socketPath.startsWith("~/")
        ? `${homedir()}${socketPath.slice(1)}`
        : socketPath;
  const normalised = resolve(expanded);
  try {
    return realpathSync(normalised);
  } catch {
    return normalised;
  }
}

export function socketPathMatches(allowedSocket: string, socketPath: string): boolean {
  const relativePath = relative(
    normaliseSocketPath(allowedSocket),
    normaliseSocketPath(socketPath),
  );
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/"));
}

export async function grantSshSessionAccess(options: {
  socketPath: string;
  allowedSockets: string[];
  reinitialize: () => Promise<boolean>;
  platform?: NodeJS.Platform;
}): Promise<boolean> {
  const { socketPath, allowedSockets, reinitialize, platform = process.platform } = options;
  if (platform === "linux") return false;

  const added = !allowedSockets.some((allowedSocket) =>
    socketPathMatches(allowedSocket, socketPath),
  );
  if (added) allowedSockets.push(socketPath);
  try {
    if (await reinitialize()) return true;
  } catch {
    // Treat reset/initialisation errors as a denied grant and restore session state.
  }
  if (added) allowedSockets.splice(allowedSockets.indexOf(socketPath), 1);
  return false;
}

export async function runSshAuthPreflight(options: {
  command: string;
  sshAuthSock?: string;
  allowedSockets: string[];
  allowAllSockets: boolean;
  requestAccess: (socketPath: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
}): Promise<"not-needed" | "allowed" | "blocked"> {
  const {
    command,
    sshAuthSock,
    allowedSockets,
    allowAllSockets,
    requestAccess,
    platform = process.platform,
  } = options;
  if (!sshAuthSock || !shouldPreflightSshAuth(command) || allowAllSockets) return "not-needed";
  if (platform === "linux") return "blocked";
  if (allowedSockets.some((allowedSocket) => socketPathMatches(allowedSocket, sshAuthSock))) {
    return "not-needed";
  }
  return (await requestAccess(sshAuthSock)) ? "allowed" : "blocked";
}

const CHROMIUM_MACH_SERVICE = "org.chromium.Chromium.MachPortRendezvousServer";

function makeBrowserProcessDiagnostic(service: string): SandboxDiagnostic {
  return {
    type: "browser-process",
    target: "Chromium Mach service",
    rawTarget: service,
    rule: "allowBrowserProcess",
    promptable: false,
    action: "enable allowBrowserProcess in trusted global config and restart Pi",
  };
}

export function makeBrowserProcessViolationDiagnostic(line: string): SandboxDiagnostic | null {
  const operation = line.match(/\bmach-(?:register|lookup)\s+(?:"([^"]+)"|([^\s)]+))/);
  const service = operation?.[1] ?? operation?.[2];
  if (!service?.startsWith(CHROMIUM_MACH_SERVICE)) return null;
  return makeBrowserProcessDiagnostic(service);
}

export function makeBrowserProcessFallbackDiagnostic(output: string): SandboxDiagnostic | null {
  const hasRendezvousService = output.includes("MachPortRendezvousServer");
  const hasBootstrapDenial =
    output.includes("BOOTSTRAP_NOT_PRIVILEGED") ||
    /(?:bootstrap_check_in|bootstrap).*\b(?:error\s*)?1100\b/i.test(output);
  if (!hasRendezvousService || !hasBootstrapDenial) return null;

  const service = output.match(/org\.chromium\.Chromium\.MachPortRendezvousServer\.\d+/)?.[0];
  return makeBrowserProcessDiagnostic(service ?? CHROMIUM_MACH_SERVICE);
}

export function makeSshAgentFallbackDiagnostic(
  sshAuthSock: string | undefined,
  command: string,
  output: string,
): SandboxDiagnostic | null {
  if (!sshAuthSock) return null;

  const explicitAgentFailure = output.includes(
    "Error connecting to agent: Operation not permitted",
  );
  const publicKeyFailure =
    output.includes("Permission denied (publickey)") && isClearlySshTargetedCommand(command);

  if (!explicitAgentFailure && !publicKeyFailure) {
    return null;
  }

  return {
    type: "ssh-auth",
    target: "current SSH agent",
    rawTarget: sshAuthSock,
    rule: "ssh agent socket blocked",
    promptable: true,
    action: "allow SSH use for this session",
  };
}
