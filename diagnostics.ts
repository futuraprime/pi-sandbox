export type SandboxDiagnosticType = "ssh-auth" | "read" | "write" | "network" | "ambiguous";

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
  read: 1,
  write: 2,
  network: 3,
  ambiguous: 4,
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

function isClearlySshTargetedCommand(command: string): boolean {
  return (
    /\bssh\b/.test(command) ||
    (/\bgit\b/.test(command) &&
      (/\b(?:ls-remote|fetch|pull|push|clone)\b/.test(command) ||
        /git@[^\s:]+:/.test(command) ||
        /ssh:\/\//.test(command)))
  );
}

export function shouldPreflightSshAuth(command: string): boolean {
  const hasMultipleShellSteps = /&&|\|\||;|\n/.test(command);
  return hasMultipleShellSteps && isClearlySshTargetedCommand(command);
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
