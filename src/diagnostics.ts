/**
 * Identify Git commands that mutate branch tracking configuration.
 *
 * This parser is intentionally only a command classifier. It does not execute
 * shell input or attempt to turn Bash into a general Git interface.
 */

import {
  canonicalizePath,
  decideDomainPolicy,
  decidePathPolicy,
  type PolicyDecision,
} from "./policy.ts";

type ShellWords = string[];

function shellCommandWords(command: string): ShellWords[] {
  const segments: ShellWords[] = [[]];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const finishWord = (): void => {
    if (word.length > 0) segments.at(-1)?.push(word);
    word = "";
  };
  const finishSegment = (): void => {
    finishWord();
    if (segments.at(-1)?.length === 0 && segments.length > 1) segments.pop();
    segments.push([]);
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];

    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character === ";" || character === "\n") {
      finishSegment();
      continue;
    }
    if (character === "|" || character === "&") {
      // Redirections such as 2>&1 and >|file are not command separators.
      const previous = command[index - 1];
      if (
        (character === "&" && (previous === ">" || previous === "<" || next === ">")) ||
        (character === "|" && previous === ">")
      ) {
        word += character;
        continue;
      }
      finishSegment();
      if (next === character) index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      continue;
    }
    word += character;
  }

  if (escaped) word += "\\";
  finishWord();
  if (segments.at(-1)?.length === 0) segments.pop();
  return segments;
}

function trimShellGrouping(word: string): string {
  return word.replace(/^[({]+/, "").replace(/[)}]+$/, "");
}

function executableName(word: string | undefined): string {
  return (
    trimShellGrouping(word ?? "")
      .split("/")
      .pop()
      ?.toLowerCase() ?? ""
  );
}

function skipWrapper(words: ShellWords): number {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;

  while (index < words.length) {
    const executable = executableName(words[index]);
    if (executable === "command" || executable === "exec" || executable === "builtin") {
      index += 1;
      while (index < words.length && words[index]?.startsWith("-")) index += 1;
      continue;
    }
    if (executable === "env") {
      index += 1;
      while (index < words.length) {
        const word = words[index] ?? "";
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
          index += 1;
        } else if (word === "--") {
          index += 1;
          break;
        } else if (
          word === "-C" ||
          word === "--chdir" ||
          word === "-S" ||
          word === "--split-string"
        ) {
          index += 2;
        } else if (word.startsWith("-")) {
          index += 1;
        } else {
          break;
        }
      }
      continue;
    }
    if (executable === "sudo" || executable === "nice" || executable === "time") {
      index += 1;
      // These wrappers' options are not the command being classified. Their
      // common value-taking forms are skipped so a value named "git" cannot
      // be mistaken for the executable.
      while (index < words.length && words[index]?.startsWith("-")) {
        const option = words[index];
        index += 1;
        if (executable === "sudo" && ["-u", "-g", "-h", "-p", "-C"].includes(option)) index += 1;
      }
      continue;
    }
    if (executable === "!") {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

interface GitOperation {
  name: string;
  arguments: string[];
}

function gitOperation(words: ShellWords): GitOperation | null {
  const executableIndex = skipWrapper(words);
  if (executableName(words[executableIndex]) !== "git") return null;

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
    const option = words[operationIndex];
    if (option === "--") return null;
    operationIndex += optionsWithValues.has(option) ? 2 : 1;
  }

  const name = words[operationIndex];
  return name ? { name: name.toLowerCase(), arguments: words.slice(operationIndex + 1) } : null;
}

function isGitUpstreamOption(word: string): boolean {
  if (
    word === "--set-upstream" ||
    word.startsWith("--set-upstream=") ||
    word === "--set-upstream-to" ||
    word.startsWith("--set-upstream-to=") ||
    word === "--unset-upstream"
  ) {
    return true;
  }

  // Git accepts short-option clusters, for example `git push -vu` and
  // attached values such as `git branch -uorigin/main`.
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
    "--rename-section",
    "set",
    "unset",
  ]);
  if (arguments_.some((word) => mutationOptions.has(word))) return true;

  // `git config key value` is the shorthand for setting a key. A bare key is
  // the query form and must remain available.
  return arguments_.slice(keyIndex + 1).some((word) => word !== "--");
}

function isGitUpstreamMutationSegment(words: ShellWords): boolean {
  const operation = gitOperation(words);
  if (!operation) return false;
  if (operation.name === "branch" || operation.name === "push") {
    return operation.arguments.some(isGitUpstreamOption);
  }
  return operation.name === "config" && isTrackingConfigMutation(operation.arguments);
}

function nestedShellCommand(words: ShellWords): string | null {
  const executableIndex = skipWrapper(words);
  const executable = executableName(words[executableIndex]);
  if (!/^(?:ba|da|k|z)?sh$/.test(executable)) return null;

  for (let index = executableIndex + 1; index < words.length; index += 1) {
    const option = words[index] ?? "";
    if (!option.startsWith("-")) continue;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(option)) return words[index + 1] ?? null;
  }
  return null;
}

/**
 * Return true when command execution would change Git branch tracking. Quoted
 * prose is tokenized as an argument to its printing command and is therefore
 * not mistaken for an executable Git command.
 */
export function isGitUpstreamMutationCommand(command: string): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  return shellCommandWords(command).some((words) => {
    if (isGitUpstreamMutationSegment(words)) return true;
    const nested = nestedShellCommand(words);
    return nested !== null && isGitUpstreamMutationCommand(nested);
  });
}

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

export function addUniqueDiagnostics(
  existing: SandboxDiagnostic[],
  additions: SandboxDiagnostic[],
): SandboxDiagnostic[] {
  const seen = new Set(existing.map((item) => diagnosticIdentity(item)));
  const next = [...existing];
  for (const diagnostic of additions) {
    const identity = diagnosticIdentity(diagnostic);
    if (seen.has(identity)) continue;
    seen.add(identity);
    next.push(diagnostic);
  }
  return next;
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

const diagnosticTypes = new Set<SandboxDiagnosticType>([
  "ssh-auth",
  "browser-process",
  "read",
  "write",
  "network",
  "ambiguous",
]);
const promptChoices = new Set<SandboxPromptChoice>([
  "abort",
  "session",
  "project",
  "global",
  "ssh-session",
  "none",
]);

export function parseDiagnosticBlock(text: string): ParsedSandboxDiagnosticBlock | null {
  const match = text.match(/\n*<sandbox_diagnostic>\n([\s\S]*?)\n<\/sandbox_diagnostic>\s*$/);
  if (!match) return null;

  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  const type = fields.get("type") as SandboxDiagnosticType | undefined;
  const choice = fields.get("choice") as SandboxPromptChoice | undefined;
  const finalOutcome = fields.get("final_outcome") as "success" | "failure" | undefined;
  const target = fields.get("target");
  const rule = fields.get("rule");
  const action = fields.get("action");
  if (
    !type ||
    !diagnosticTypes.has(type) ||
    !target ||
    !rule ||
    !action ||
    !choice ||
    !promptChoices.has(choice) ||
    (finalOutcome !== "success" && finalOutcome !== "failure")
  ) {
    return null;
  }

  const prompted = fields.get("prompted");
  const retried = fields.get("retried");
  const otherViolationsText = fields.get("other_violations");
  if (
    (prompted !== "yes" && prompted !== "no") ||
    (retried !== "yes" && retried !== "no") ||
    !otherViolationsText ||
    !/^\d+$/.test(otherViolationsText)
  ) {
    return null;
  }

  const data: SandboxDiagnosticBlockData = {
    type,
    target,
    rule,
    prompted: prompted === "yes",
    choice,
    retried: retried === "yes",
    finalOutcome,
    otherViolations: Number.parseInt(otherViolationsText, 10),
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
  if (data.prompted) parts.push(diagnosticChoiceLabel(data.choice));
  parts.push(
    data.retried
      ? data.finalOutcome === "success"
        ? "retried successfully"
        : "retried but still failed"
      : data.finalOutcome === "success"
        ? "completed"
        : "blocked or failed",
  );
  return `[sandbox: ${parts.join("; ")} — /sandbox-debug for details]`;
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
  return squashed.length <= 80 ? squashed : `${squashed.slice(0, 77)}...`;
}

export function retainIncident(incident: SandboxIncident): boolean {
  return incident.attributed || incident.promptShown;
}

export function trimIncidents<T>(incidents: T[], max: number): T[] {
  return incidents.length <= max ? incidents : incidents.slice(incidents.length - max);
}

export interface DiagnosticPolicyContext {
  cwd: string;
  allowRead: string[];
  denyRead: string[];
  allowWrite: string[];
  denyWrite: string[];
  allowedDomains: string[];
  deniedDomains: string[];
}

function actionForRead(filePath: string, decision: PolicyDecision, rule: string): string {
  if (decision === "deny")
    return `${rule === "denyRead" ? "blocked by denyRead" : "read access blocked"}; change policy`;
  return decision === "prompt" ? "allow and retry" : "read access allowed";
}

function actionForWrite(decision: PolicyDecision, rule: string): string {
  if (decision === "deny")
    return `${rule === "denyWrite" ? "blocked by denyWrite" : "write access blocked"}; change policy`;
  return decision === "prompt" ? "allow and retry" : "write access allowed";
}

function actionForNetwork(decision: PolicyDecision, rule: string): string {
  if (decision === "deny")
    return `${rule === "deniedDomains" ? "blocked by deniedDomains" : "network access blocked"}; change policy`;
  return decision === "prompt"
    ? "host not allowed; approve network access"
    : "network access allowed";
}

/** Reclassify a runtime attribution using the shared policy precedence rules. */
export function finalizeDiagnostic(
  diagnostic: SandboxDiagnostic,
  policy: DiagnosticPolicyContext,
): SandboxDiagnostic {
  if (diagnostic.type === "read" && diagnostic.rawTarget) {
    const target = canonicalizePath(diagnostic.rawTarget, policy.cwd);
    const decision = decidePathPolicy(target, policy.allowRead, policy.denyRead, policy.cwd);
    return {
      ...diagnostic,
      target,
      rawTarget: target,
      rule: decision === "deny" ? "denyRead" : decision === "allow" ? "allowRead" : "allowRead",
      promptable: decision === "prompt",
      action: actionForRead(target, decision, decision === "deny" ? "denyRead" : "allowRead"),
    };
  }
  if (diagnostic.type === "write" && diagnostic.rawTarget) {
    const target = canonicalizePath(diagnostic.rawTarget, policy.cwd);
    const decision = decidePathPolicy(target, policy.allowWrite, policy.denyWrite, policy.cwd);
    return {
      ...diagnostic,
      target,
      rawTarget: target,
      rule: decision === "deny" ? "denyWrite" : "allowWrite",
      promptable: decision === "prompt",
      action: actionForWrite(decision, decision === "deny" ? "denyWrite" : "allowWrite"),
    };
  }
  if (diagnostic.type === "network" && diagnostic.rawTarget) {
    const decision = decideDomainPolicy(
      diagnostic.rawTarget,
      policy.allowedDomains,
      policy.deniedDomains,
    );
    return {
      ...diagnostic,
      target: diagnostic.rawTarget,
      rule: decision === "deny" ? "deniedDomains" : "allowedDomains",
      promptable: decision === "prompt",
      action: actionForNetwork(decision, decision === "deny" ? "deniedDomains" : "allowedDomains"),
    };
  }
  return diagnostic;
}

export interface RuntimeDiagnosticEvent {
  line: string;
  command?: string;
  encodedCommand?: string;
  timestamp?: Date;
}

function extractPathFromViolationRemainder(remainder: string): string | null {
  const quoted = remainder.match(/"([^"\n]+)"/);
  if (quoted?.[1]) return quoted[1];
  const absolute = remainder.match(/(\/(?:[A-Za-z0-9._~+@-]+\/)*[A-Za-z0-9._~+@-]+)/);
  return absolute?.[1] ?? null;
}

const CHROMIUM_MACH_SERVICE = "org.chromium.Chromium.MachPortRendezvousServer";

function makeBrowserProcessDiagnostic(service: string): SandboxDiagnostic {
  return {
    type: "browser-process",
    target: "Chromium Mach service",
    rawTarget: service,
    rule: "allowBrowserProcess",
    promptable: false,
    action:
      "Pi sandbox blocked Chromium; enable allowBrowserProcess in trusted global config and restart Pi",
  };
}

export function makeBrowserProcessViolationDiagnostic(line: string): SandboxDiagnostic | null {
  const operation = line.match(/\bmach-(?:register|lookup)\s+(?:"([^"]+)"|([^\s)]+))/);
  const service = operation?.[1] ?? operation?.[2];
  return service?.startsWith(CHROMIUM_MACH_SERVICE) ? makeBrowserProcessDiagnostic(service) : null;
}

export function makeBrowserProcessFallbackDiagnostic(output: string): SandboxDiagnostic | null {
  const hasService = output.includes("MachPortRendezvousServer");
  const hasBootstrapDenial =
    output.includes("BOOTSTRAP_NOT_PRIVILEGED") ||
    /(?:bootstrap_check_in|bootstrap).*\b(?:error\s*)?1100\b/i.test(output);
  if (!hasService || !hasBootstrapDenial) return null;
  const service = output.match(/org\.chromium\.Chromium\.MachPortRendezvousServer\.\d+/)?.[0];
  return makeBrowserProcessDiagnostic(service ?? CHROMIUM_MACH_SERVICE);
}

function clearlySshTargeted(command: string): boolean {
  return shellCommandWords(command).some((words) => {
    const index = skipWrapper(words);
    const executable = executableName(words[index]);
    if (executable === "ssh" || executable === "ssh-add") return true;
    if (executable !== "git") return false;
    let operation = index + 1;
    while (words[operation]?.startsWith("-")) operation += 1;
    if (!/^(clone|fetch|pull|push|ls-remote)$/.test(words[operation] ?? "")) return false;
    const args = words.slice(operation + 1);
    if (args.some((word) => /^(?:ssh|git\+ssh):\/\//i.test(word))) return true;
    if (args.some((word) => /^[^@\s]+@[^\s:]+:/.test(word))) return true;
    if (args.some((word) => /^https?:\/\//i.test(word))) return false;
    return true;
  });
}

export function makeSshAgentFallbackDiagnostic(
  sshAuthSock: string | undefined,
  command: string,
  output: string,
): SandboxDiagnostic | null {
  if (!sshAuthSock) return null;
  const isSshTargeted = clearlySshTargeted(command);
  const explicitFailure =
    /Error connecting to agent: Operation not permitted/i.test(output) && isSshTargeted;
  const publicKeyFailure = /Permission denied \(publickey\)/i.test(output) && isSshTargeted;
  if (!explicitFailure && !publicKeyFailure) return null;
  return {
    type: "ssh-auth",
    target: "current SSH agent",
    rawTarget: sshAuthSock,
    rule: "ssh agent socket blocked",
    promptable: true,
    action: "allow SSH use for this session",
  };
}

/** Parse one structured sandbox-runtime violation into a stable diagnostic. */
export function parseViolationEvent(
  violation: RuntimeDiagnosticEvent,
  sshAuthSock?: string,
): SandboxDiagnostic {
  const line = violation.line.trim();
  if (sshAuthSock && line.includes(sshAuthSock)) {
    return {
      type: "ssh-auth",
      target: "current SSH agent",
      rawTarget: sshAuthSock,
      rule: "ssh agent socket blocked",
      promptable: true,
      action: "allow SSH use for this session",
    };
  }

  const browser = makeBrowserProcessViolationDiagnostic(line);
  if (browser) return browser;

  const readMatch = line.match(/\bfile-read[^\s]*\s+(.+)$/i);
  if (readMatch?.[1]) {
    const target = extractPathFromViolationRemainder(readMatch[1]);
    if (target) {
      return {
        type: "read",
        target,
        rawTarget: target,
        rule: "allowRead",
        promptable: true,
        action: "allow and retry",
      };
    }
  }

  const writeMatch = line.match(/\bfile-write[^\s]*\s+(.+)$/i);
  if (writeMatch?.[1]) {
    const target = extractPathFromViolationRemainder(writeMatch[1]);
    if (target) {
      return {
        type: "write",
        target,
        rawTarget: target,
        rule: "allowWrite",
        promptable: true,
        action: "allow and retry",
      };
    }
  }

  const networkHost = line.match(/\b([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::\d+)?\b/);
  if (/\bnetwork(?:[-_ ]|$)/i.test(line) && networkHost?.[1]) {
    return {
      type: "network",
      target: networkHost[1].toLowerCase(),
      rawTarget: networkHost[1].toLowerCase(),
      rule: "allowedDomains",
      promptable: true,
      action: "host not allowed; approve network access",
    };
  }

  return {
    type: "ambiguous",
    target: "sandbox violation",
    rule: "runtime violation",
    promptable: false,
    action: "ambiguous; inspect /sandbox-debug",
  };
}

function extractOperationNotPermittedPath(output: string): string | null {
  const match = output.match(/(?:^|\s)(\/(?:[^\s:'"]+))(?:\s|:|$).*Operation not permitted/im);
  return match?.[1] ?? null;
}

/** Attribute a runtime failure when the platform did not provide an event. */
export function parseFallbackDiagnosticFromOutput(
  command: string,
  output: string,
  sshAuthSock = process.env.SSH_AUTH_SOCK,
): SandboxDiagnostic | null {
  const browser = makeBrowserProcessFallbackDiagnostic(output);
  if (browser) return browser;
  const ssh = makeSshAgentFallbackDiagnostic(sshAuthSock, command, output);
  if (ssh) return ssh;

  const host = output.match(
    /\b(?:network|connect(?:ion)?)\b[^\n]*?([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::\d+)?/i,
  );
  if (host?.[1] && /(denied|blocked|not permitted|operation not permitted)/i.test(output)) {
    return {
      type: "network",
      target: host[1].toLowerCase(),
      rawTarget: host[1].toLowerCase(),
      rule: "allowedDomains",
      promptable: true,
      action: "host not allowed; approve network access",
    };
  }

  const blockedPath = extractOperationNotPermittedPath(output);
  if (blockedPath) {
    const looksLikeRead = /Load key|Could not open|(?:^|\n)cat:/i.test(output);
    return {
      type: looksLikeRead ? "read" : "write",
      target: blockedPath,
      rawTarget: blockedPath,
      rule: looksLikeRead ? "allowRead" : "allowWrite",
      promptable: !looksLikeRead,
      action: looksLikeRead ? "read access blocked; change policy" : "allow and retry",
    };
  }

  if (/(?:sandbox|operation not permitted|not permitted)/i.test(output)) {
    return {
      type: "ambiguous",
      target: "sandbox violation",
      rule: "runtime violation",
      promptable: false,
      action: "ambiguous; inspect /sandbox-debug",
    };
  }
  return null;
}
