import { isAbsolute, relative } from "node:path";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  getConfigPaths,
  type SandboxConfig,
} from "./config.ts";
import { allowsAllDomains, canonicalizePath, domainIsAllowed, matchesPattern } from "./policy.ts";
import { validateSandboxCommandValue } from "./sandbox-command.ts";
import { type SessionAllowances } from "./sandbox-runtime.ts";

export type PermissionChoice = "abort" | "session" | "project" | "global";
export type SshPermissionChoice = "abort" | "ssh-session";
export type ManualBypassChoice = "run-once-unsandboxed" | "retry-once-unsandboxed";
type PromptAction = PermissionChoice | SshPermissionChoice | ManualBypassChoice;

export interface PermissionPromptResult<Action extends PromptAction = PermissionChoice> {
  action: Action;
  value: string;
}

interface PromptOption<Action extends PromptAction = PromptAction> {
  label: string;
  key: string;
  action: Action;
  confirm?: boolean;
  hint?: string;
  warning?: string;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function permissionPromptTimeoutMs(timeoutSeconds: unknown): number | undefined {
  const resolvedTimeoutSeconds =
    timeoutSeconds === undefined ? DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS : timeoutSeconds;
  if (
    typeof resolvedTimeoutSeconds !== "number" ||
    !Number.isFinite(resolvedTimeoutSeconds) ||
    resolvedTimeoutSeconds <= 0
  ) {
    return undefined;
  }
  return Math.min(resolvedTimeoutSeconds * 1000, MAX_TIMER_DELAY_MS);
}

export function permissionPromptRemainingSeconds(deadlineMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

export function permissionOptions(cwd: string): PromptOption<PermissionChoice>[] {
  const { globalPath, projectPath } = getConfigPaths(cwd);
  return [
    { label: "Allow for this session only", key: "s", action: "session" },
    { label: "Abort (keep blocked)", key: "esc", action: "abort" },
    {
      label: "Allow for this project",
      key: "P",
      action: "project",
      confirm: true,
      hint: `→ ${projectPath}`,
    },
    {
      label: "Allow for all projects",
      key: "A",
      action: "global",
      confirm: true,
      hint: `→ ${globalPath}`,
    },
  ];
}

export async function showPermissionPrompt<Action extends PromptAction = PermissionChoice>(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string,
  originalValue: string,
  validateValue: (value: string) => string | null,
  timeoutSeconds?: number,
  promptOptions: PromptOption<Action>[] = permissionOptions(ctx.cwd) as PromptOption<Action>[],
  displayValue = originalValue,
): Promise<PermissionPromptResult<Action>> {
  if (!ctx.hasUI) return { action: "abort" as Action, value: originalValue };

  const timeoutMs = permissionPromptTimeoutMs(timeoutSeconds);
  const options = promptOptions;
  const result = await ctx.ui.custom<PermissionPromptResult<Action>>((tui, theme, _kb, done) => {
    // This callback is invoked only when the UI has actually opened a prompt.
    // Hard-deny and no-UI paths return before custom() is reached.
    pi.events.emit("request-attention", { message: "Sandbox permission required" });

    const input = new Input();
    let selectedIndex = 0;
    let pendingAction: Action | null = null;
    let currentValue = displayValue;
    let editing = false;
    let componentFocused = false;
    let error: string | null = null;
    let resolved = false;
    let remainingSeconds: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let countdown: ReturnType<typeof setInterval> | undefined;

    const clearPromptTimers = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (countdown !== undefined) {
        clearInterval(countdown);
        countdown = undefined;
      }
    };
    const finish = (result: PermissionPromptResult<Action>): void => {
      if (resolved) return;
      resolved = true;
      clearPromptTimers();
      done(result);
    };

    const selectedOption = (): PromptOption<Action> => options[selectedIndex] ?? options[0]!;
    const isAllowOption = (option: PromptOption<Action>): boolean =>
      option.action !== "abort" &&
      option.action !== "ssh-session" &&
      option.action !== "run-once-unsandboxed" &&
      option.action !== "retry-once-unsandboxed";
    const updateFocus = (): void => {
      input.focused = componentFocused && editing;
    };
    const beginEditing = (): void => {
      input.setValue(currentValue);
      input.handleInput("\x05");
      editing = true;
      error = null;
      pendingAction = null;
      updateFocus();
    };
    const stopEditing = (): void => {
      // Esc and navigation reset an uncommitted edit. It must not leak into a
      // later scope selection.
      input.setValue(currentValue);
      editing = false;
      error = null;
      updateFocus();
    };
    const validate = (value: string): boolean => {
      const validationError = validateValue(value);
      if (!validationError) return true;
      error = validationError;
      editing = true;
      updateFocus();
      tui.requestRender();
      return false;
    };
    const resolve = (action: Action): void => {
      if (
        action === "abort" ||
        action === "run-once-unsandboxed" ||
        action === "retry-once-unsandboxed"
      ) {
        finish({ action, value: originalValue });
        return;
      }

      if (editing) {
        const value = input.getValue().trim();
        if (!validate(value)) return;
        currentValue = value;
        stopEditing();
      } else if (!validate(currentValue)) {
        return;
      }

      const option = options.find((candidate) => candidate.action === action);
      if (option?.confirm && pendingAction !== action) {
        pendingAction = action;
        tui.requestRender();
        return;
      }
      pendingAction = null;
      finish({ action, value: currentValue });
    };

    if (timeoutMs !== undefined) {
      const deadlineMs = Date.now() + timeoutMs;
      remainingSeconds = permissionPromptRemainingSeconds(deadlineMs);
      timeout = setTimeout(() => resolve("abort" as Action), timeoutMs);
      countdown = setInterval(
        () => {
          const nextRemainingSeconds = permissionPromptRemainingSeconds(deadlineMs);
          if (nextRemainingSeconds === remainingSeconds) return;
          remainingSeconds = nextRemainingSeconds;
          tui.requestRender();
        },
        Math.min(1000, timeoutMs),
      );
    }

    return {
      get focused(): boolean {
        return componentFocused;
      },
      set focused(value: boolean) {
        componentFocused = value;
        updateFocus();
      },
      render(width: number): string[] {
        const lines = [truncateToWidth(theme.fg("warning", title), width)];
        if (remainingSeconds !== undefined) {
          lines.push(
            truncateToWidth(
              theme.fg(
                "warning",
                `⏳ Auto-abort in ${remainingSeconds}s (permission stays blocked)`,
              ),
              width,
            ),
          );
        }
        lines.push("");
        for (let i = 0; i < options.length; i++) {
          const option = options[i]!;
          const isSelected = i === selectedIndex;
          const prefix = isSelected ? " → " : "   ";
          const keyHint = theme.fg("accent", `[${option.key}]`);
          let label = option.label;

          if (editing && isSelected && isAllowOption(option)) {
            const separator = " ";
            const inputWidth = Math.max(
              1,
              width - visibleWidth(`${prefix}${keyHint} ${label}${separator}`),
            );
            label += `${separator}${theme.fg("accent", input.render(inputWidth)[0] ?? "")}`;
          } else if (option.hint) {
            label += `  ${theme.fg("dim", option.hint)}`;
          }
          if (pendingAction === option.action) {
            label += `  ${theme.fg("warning", "→ press Enter to confirm")}`;
          }
          lines.push(truncateToWidth(`${prefix}${keyHint} ${label}`, width));
          if (option.warning) {
            const warningPrefix = "      ⚠ ";
            const warningWidth = Math.max(1, width - visibleWidth(warningPrefix));
            let warningLine = "";
            for (const word of option.warning.split(/\s+/)) {
              const next = warningLine ? `${warningLine} ${word}` : word;
              if (warningLine && visibleWidth(next) > warningWidth) {
                lines.push(
                  truncateToWidth(
                    `${theme.fg("warning", warningPrefix)}${theme.fg("warning", warningLine)}`,
                    width,
                  ),
                );
                warningLine = word;
              } else {
                warningLine = next;
              }
            }
            if (warningLine) {
              lines.push(
                truncateToWidth(
                  `${theme.fg("warning", warningPrefix)}${theme.fg("warning", warningLine)}`,
                  width,
                ),
              );
            }
          }
          if (editing && isSelected && error) {
            lines.push(truncateToWidth(theme.fg("error", `   ✗ ${error}`), width));
          }
        }
        lines.push("");
        const footer = editing
          ? "↑↓ navigate, enter select/confirm, esc reset, ctrl+c cancel"
          : pendingAction
            ? "↑↓ navigate, tab edit, enter confirm, esc/ctrl+c cancel"
            : "↑↓ navigate, tab edit, enter select, esc/ctrl+c cancel";
        lines.push(truncateToWidth(theme.fg("dim", footer), width));
        return lines;
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.ctrl("c"))) {
          resolve("abort" as Action);
          return;
        }
        if (editing) {
          if (matchesKey(data, Key.escape)) {
            stopEditing();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            resolve(selectedOption().action);
            return;
          }
          if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
            const delta = matchesKey(data, Key.up) ? -1 : 1;
            selectedIndex = Math.max(0, Math.min(options.length - 1, selectedIndex + delta));
            pendingAction = null;
            stopEditing();
            tui.requestRender();
            return;
          }
          input.handleInput(data);
          error = null;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.escape)) {
          resolve("abort" as Action);
          return;
        }
        if (matchesKey(data, Key.tab) && isAllowOption(selectedOption())) {
          beginEditing();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          resolve(pendingAction ?? selectedOption().action);
          return;
        }
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          const delta = matchesKey(data, Key.up) ? -1 : 1;
          selectedIndex = Math.max(0, Math.min(options.length - 1, selectedIndex + delta));
          pendingAction = null;
          tui.requestRender();
          return;
        }
        for (let i = 0; i < options.length; i++) {
          const option = options[i]!;
          if (data.toLowerCase() === option.key.toLowerCase()) {
            selectedIndex = i;
            resolve(option.action);
            return;
          }
        }
      },
      invalidate(): void {
        input.invalidate();
      },
      dispose(): void {
        clearPromptTimers();
      },
    };
  });

  return result ?? ({ action: "abort", value: originalValue } as PermissionPromptResult<Action>);
}

export interface ManualBypassOption {
  action: ManualBypassChoice;
  label: string;
  warning?: string;
}

function permissionOptionsWithManualBypass(
  cwd: string,
  bypass: ManualBypassOption | undefined,
): PromptOption<PermissionChoice | ManualBypassChoice>[] {
  return [...permissionOptions(cwd), ...(bypass ? [{ ...bypass, key: "u" }] : [])];
}

const validRule = (value: string, matches: boolean, target: string): string | null => {
  if (value.length === 0) return "Rule cannot be empty.";
  return matches ? null : `Rule must match the blocked ${target}.`;
};

function projectRelativePromptValue(value: string, cwd: string): string {
  const canonicalCwd = canonicalizePath(cwd, cwd);
  const canonical = canonicalizePath(value, cwd);
  const relativePath = relative(canonicalCwd, canonical);
  if (relativePath === "") return ".";
  if (isAbsolute(relativePath) || relativePath.startsWith("..")) return canonical;
  return relativePath;
}

function validateRule(
  key: "allowRead" | "allowWrite" | "allowedDomains",
  value: string,
  cwd: string,
  matchesTarget: (value: string) => boolean,
  target: string,
): string | null {
  const syntaxError = validateSandboxCommandValue(key, value, cwd);
  if (syntaxError) return syntaxError;
  return validRule(value, matchesTarget(value), target);
}

export function promptDomainBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  domain: string,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult>;
export function promptDomainBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  domain: string,
  timeoutSeconds: number | undefined,
  bypass: ManualBypassOption,
): Promise<PermissionPromptResult<PermissionChoice | ManualBypassChoice>>;
export function promptDomainBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  domain: string,
  timeoutSeconds?: number,
  bypass?: ManualBypassOption,
): Promise<PermissionPromptResult<PermissionChoice | ManualBypassChoice>> {
  return showPermissionPrompt(
    pi,
    ctx,
    `🌐 Network blocked: "${domain}" is not in allowedDomains`,
    domain,
    (value) =>
      validateRule(
        "allowedDomains",
        value,
        ctx.cwd,
        (candidate) => domainIsAllowed(domain, [candidate]),
        `domain "${domain}"`,
      ),
    timeoutSeconds,
    permissionOptionsWithManualBypass(ctx.cwd, bypass),
  );
}

export function promptReadBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult>;
export function promptReadBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  timeoutSeconds: number | undefined,
  bypass: ManualBypassOption,
): Promise<PermissionPromptResult<PermissionChoice | ManualBypassChoice>>;
export function promptReadBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  timeoutSeconds?: number,
  bypass?: ManualBypassOption,
): Promise<PermissionPromptResult<PermissionChoice | ManualBypassChoice>> {
  return showPermissionPrompt(
    pi,
    ctx,
    `📖 Read blocked: "${path}" is not in allowRead`,
    path,
    (value) =>
      validateRule(
        "allowRead",
        value,
        ctx.cwd,
        (candidate) => matchesPattern(path, [candidate], ctx.cwd),
        `path "${path}"`,
      ),
    timeoutSeconds,
    permissionOptionsWithManualBypass(ctx.cwd, bypass),
    projectRelativePromptValue(path, ctx.cwd),
  );
}

export function promptWriteBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult>;
export function promptWriteBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  timeoutSeconds: number | undefined,
  bypass: ManualBypassOption,
): Promise<PermissionPromptResult<PermissionChoice | ManualBypassChoice>>;
export function promptWriteBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  timeoutSeconds?: number,
  bypass?: ManualBypassOption,
): Promise<PermissionPromptResult<PermissionChoice | ManualBypassChoice>> {
  return showPermissionPrompt(
    pi,
    ctx,
    `📝 Write blocked: "${path}" is not in allowWrite`,
    path,
    (value) =>
      validateRule(
        "allowWrite",
        value,
        ctx.cwd,
        (candidate) => matchesPattern(path, [candidate], ctx.cwd),
        `path "${path}"`,
      ),
    timeoutSeconds,
    permissionOptionsWithManualBypass(ctx.cwd, bypass),
    projectRelativePromptValue(path, ctx.cwd),
  );
}

export function promptSshAuthBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult<SshPermissionChoice>>;
export function promptSshAuthBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  timeoutSeconds: number | undefined,
  options: ManualBypassOption & { allowSession?: boolean },
): Promise<PermissionPromptResult<SshPermissionChoice | ManualBypassChoice>>;
export function promptSshAuthBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  timeoutSeconds?: number,
  options?: ManualBypassOption & { allowSession?: boolean },
): Promise<PermissionPromptResult<SshPermissionChoice | ManualBypassChoice>> {
  return showPermissionPrompt<SshPermissionChoice | ManualBypassChoice>(
    pi,
    ctx,
    options?.allowSession === false
      ? "🔐 SSH auth blocked: run this manual command once unsandboxed?"
      : options
        ? "🔐 SSH auth blocked: allow SSH use for this session or bypass once?"
        : "🔐 SSH auth blocked: allow SSH use for this session?",
    "SSH agent",
    () => null,
    timeoutSeconds,
    [
      ...(options?.allowSession === false
        ? []
        : [{ label: "Allow SSH use for this session", key: "s", action: "ssh-session" as const }]),
      ...(options ? [{ ...options, key: "u" }] : []),
      { label: "Abort (keep blocked)", key: "esc", action: "abort" },
    ],
  );
}

export function promptManualBypass(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string,
  target: string,
  timeoutSeconds: number | undefined,
  bypass: ManualBypassOption,
): Promise<PermissionPromptResult<ManualBypassChoice | "abort">> {
  return showPermissionPrompt<ManualBypassChoice | "abort">(
    pi,
    ctx,
    title,
    target,
    () => null,
    timeoutSeconds,
    [
      { ...bypass, key: "u" },
      { label: "Abort (keep blocked)", key: "esc", action: "abort" },
    ],
  );
}

export function warnIfAllDomainsAllowed(ctx: ExtensionContext, config: SandboxConfig): void {
  if (!allowsAllDomains(config.network?.allowedDomains)) return;
  ctx.ui.notify(
    '⚠️ Network sandbox allows all domains because network.allowedDomains contains "*". ' +
      'Only use this intentionally; remove "*" to restore per-domain prompts.',
    "warning",
  );
}

export function formatSandboxStatus(config: SandboxConfig): string {
  const networkLabel = allowsAllDomains(config.network?.allowedDomains)
    ? "all domains"
    : `${config.network?.allowedDomains?.length ?? 0} domains`;
  return `🔒 Sandbox: ${networkLabel}, ${config.filesystem?.allowWrite?.length ?? 0} write paths`;
}

export function formatSandboxConfiguration(
  config: SandboxConfig,
  paths: { globalPath: string; projectPath: string },
  allowances: SessionAllowances,
  linkedGitMetadata: string[] = [],
): string {
  return [
    "Sandbox Configuration",
    `  Project config: ${paths.projectPath}`,
    `  Global config:  ${paths.globalPath}`,
    "",
    "Network (bash + !cmd):",
    `  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
    ...(allowsAllDomains(config.network?.allowedDomains)
      ? ['  ⚠️ "*" allows all domains and disables per-domain prompts.']
      : []),
    `  Denied domains:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
    ...(allowances.domains.length ? [`  Session allowed: ${allowances.domains.join(", ")}`] : []),
    ...(config.network?.allowUnixSockets?.length
      ? [`  Allow sockets:   ${config.network.allowUnixSockets.join(", ")}`]
      : []),
    ...(allowances.unixSockets.length
      ? [`  Session sockets: ${allowances.unixSockets.join(", ")}`]
      : []),
    "",
    "Filesystem (bash + read/write/edit tools):",
    `  Deny Read:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
    `  Allow Read:  ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
    `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
    `  Deny Write:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
    `  Linked Git metadata writes: ${linkedGitMetadata.join(", ") || "(none)"}`,
    ...(allowances.readPaths.length ? [`  Session read:  ${allowances.readPaths.join(", ")}`] : []),
    ...(allowances.writePaths.length
      ? [`  Session write: ${allowances.writePaths.join(", ")}`]
      : []),
    "",
    "Note: ALL reads are prompted unless the path is in allowRead or allowWrite.",
    "Note: allowWrite also grants read access to the same path.",
    "Note: denyRead is a hard-block unless a more-specific allowRead rule matches.",
    "Note: denyWrite is a hard-block unless a more-specific allowWrite rule matches.",
    "Note: mandatory Git/config and project integration-path protections cannot be granted.",
  ].join("\n");
}
