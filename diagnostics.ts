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

export function renderDiagnosticBlock(incident: SandboxIncident): string | null {
  if (!incident.attributed || !incident.primaryViolation) return null;
  const primary = incident.primaryViolation;
  return [
    "<sandbox_diagnostic>",
    `type: ${primary.type}`,
    `target: ${primary.target}`,
    `rule: ${primary.rule}`,
    `prompted: ${incident.promptShown ? "yes" : "no"}`,
    `choice: ${incident.promptChoice}`,
    `retried: ${incident.retried ? "yes" : "no"}`,
    `final_outcome: ${incident.finalOutcome}`,
    `other_violations: ${Math.max(0, incident.violations.length - 1)}`,
    `action: ${primary.action}`,
    "</sandbox_diagnostic>",
  ].join("\n");
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
