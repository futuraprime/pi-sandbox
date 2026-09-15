import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Container, Text } from "@earendil-works/pi-tui";

import {
  parseDiagnosticBlock,
  renderDiagnosticNotice,
  renderDiagnosticSummaryLines,
  type SandboxDiagnosticBlockData,
  type SandboxIncident,
} from "./diagnostics.ts";

export type SandboxStatusState =
  | "enabled"
  | "disabled"
  | "pending"
  | "unsupported"
  | "error"
  | "shutdown";

type SandboxInterventionState = "collapsed" | "expanded";

type ThemeColor = Parameters<ExtensionContext["ui"]["theme"]["fg"]>[0];
type DiagnosticTheme = {
  fg: (color: ThemeColor, text: string) => string;
  bold: (text: string) => string;
};
type StatusTheme = Pick<DiagnosticTheme, "fg">;
type StatusTone = "accent" | "error";

interface SandboxStatusPresentation {
  state: SandboxStatusState;
  text: string | undefined;
  tone: StatusTone;
  description: string;
}

const STATUS_PRESENTATIONS: Record<SandboxStatusState, SandboxStatusPresentation> = {
  enabled: {
    state: "enabled",
    text: "🔒",
    tone: "accent",
    description: "Sandbox enabled",
  },
  disabled: {
    state: "disabled",
    text: "ꗃ",
    tone: "error",
    description: "Sandbox disabled",
  },
  pending: {
    state: "pending",
    text: "ꗃ",
    tone: "error",
    description: "Sandbox initialization pending",
  },
  unsupported: {
    state: "unsupported",
    text: "ꗃ",
    tone: "error",
    description: "Sandbox unsupported on this platform",
  },
  error: {
    state: "error",
    text: "ꗃ",
    tone: "error",
    description: "Sandbox initialization failed",
  },
  shutdown: {
    state: "shutdown",
    text: undefined,
    tone: "error",
    description: "Sandbox shut down",
  },
};

export function getSandboxStatusPresentation(state: SandboxStatusState): SandboxStatusPresentation {
  return { ...STATUS_PRESENTATIONS[state] };
}

export function formatSandboxStatus(
  state: SandboxStatusState,
  theme: StatusTheme,
): string | undefined {
  const presentation = getSandboxStatusPresentation(state);
  return presentation.text === undefined
    ? undefined
    : theme.fg(presentation.tone, presentation.text);
}

export function setSandboxStatus(
  ctx: Pick<ExtensionContext, "ui">,
  state: SandboxStatusState,
): void {
  ctx.ui.setStatus("sandbox", formatSandboxStatus(state, ctx.ui.theme));
}

export interface DiagnosticResultDetails {
  sandboxDiagnostic?: SandboxDiagnosticBlockData;
  sandboxVisibleText?: string;
  truncation?: {
    truncated: boolean;
    totalLines?: number;
    outputLines?: number;
    outputBytes?: number;
    truncatedBy?: "lines" | "bytes";
    maxBytes?: number;
  };
  fullOutputPath?: string;
}

function removeRawDiagnosticBlocks(text: string): string {
  const parsed = parseDiagnosticBlock(text);
  if (parsed) return parsed.visibleText;
  return text.replace(/\n*<sandbox_diagnostic>[\s\S]*?<\/sandbox_diagnostic>/g, "").trimEnd();
}

function cleanDiagnosticVisibleText(text: string): string {
  return removeRawDiagnosticBlocks(text);
}

export function renderSandboxDiagnosticResult(
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
  presentation: SandboxInterventionState | boolean,
  theme: DiagnosticTheme,
): Container {
  const expanded = presentation === true || presentation === "expanded";
  const details = (result.details ?? {}) as DiagnosticResultDetails;
  const diagnostic = details.sandboxDiagnostic;
  if (!diagnostic) return new Container();

  const text = result.content?.find((content) => content.type === "text")?.text ?? "";
  const visibleText = cleanDiagnosticVisibleText(details.sandboxVisibleText ?? text);
  const container = new Container();
  container.addChild(
    new Text(
      `${theme.fg("warning", theme.bold("Sandbox intervention"))} ${theme.fg("muted", renderDiagnosticNotice(diagnostic))}`,
      0,
      0,
    ),
  );

  if (!expanded) {
    container.addChild(
      new Text(theme.fg("dim", "Expand to view command output and full diagnostic details."), 0, 0),
    );
    return container;
  }

  const summary = renderDiagnosticSummaryLines(diagnostic)
    .map((line) => theme.fg("dim", line))
    .join("\n");
  container.addChild(new Text(`\n${summary}`, 0, 0));
  if (visibleText.trim()) {
    container.addChild(new Text(`\n${theme.fg("toolOutput", visibleText.trim())}`, 0, 0));
  }
  const warnings: string[] = [];
  if (details.fullOutputPath) warnings.push(`Full output: ${details.fullOutputPath}`);
  if (details.truncation?.truncated) warnings.push("Output truncated");
  if (warnings.length > 0) {
    container.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
  }
  return container;
}

export function formatSandboxDebug(
  incidents: readonly SandboxIncident[],
  options: { enabled?: boolean } | boolean = {},
): string {
  const enabled = typeof options === "boolean" ? options : (options.enabled ?? true);
  if (!enabled) {
    return [
      "Sandbox is disabled",
      "Sandbox debug history is session-local and is unavailable while disabled.",
    ].join("\n");
  }

  if (incidents.length === 0) {
    return [
      "Sandbox debug: no attributed incidents in this session.",
      "Session-local, last 5 incidents. History is not persisted.",
    ].join("\n");
  }

  const lines = ["Sandbox Debug", "Session-local, last 5 incidents. History is not persisted.", ""];
  for (const incident of [...incidents].reverse()) {
    lines.push(`${incident.timestamp.toISOString()}  ${incident.commandPreview}`);
    lines.push(`  outcome: ${incident.finalOutcome}`);
    if (incident.primaryViolation) {
      lines.push(
        `  primary: ${incident.primaryViolation.type} ${incident.primaryViolation.target} (${incident.primaryViolation.rule})`,
      );
    } else {
      lines.push("  primary: none");
    }
    lines.push(`  other violations: ${Math.max(0, incident.violations.length - 1)}`);
    lines.push(`  prompted: ${incident.promptShown ? "yes" : "no"}`);
    lines.push(`  choice: ${incident.promptChoice}`);
    lines.push(`  config mutation: ${incident.configMutation}`);
    lines.push(`  retried: ${incident.retried ? "yes" : "no"}`);
    for (const violation of incident.violations) {
      const target = violation.rawTarget ?? violation.target;
      lines.push(
        `    - ${violation.type}: ${target} [rule=${violation.rule}, promptable=${violation.promptable ? "yes" : "no"}, action=${violation.action}]`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
