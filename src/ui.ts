import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  getConfigPaths,
  type SandboxConfig,
} from "./config.ts";
import { allowsAllDomains, domainIsAllowed, matchesPattern } from "./policy.ts";
import { type SessionAllowances } from "./sandbox-runtime.ts";

export type PermissionChoice = "abort" | "session" | "project" | "global";
export type SshPermissionChoice = "abort" | "ssh-session";
type PromptAction = PermissionChoice | SshPermissionChoice;

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
): Promise<PermissionPromptResult<Action>> {
  if (!ctx.hasUI) return { action: "abort" as Action, value: originalValue };

  pi.events.emit("request-attention", { message: "Sandbox permission required" });

  const timeoutMs = permissionPromptTimeoutMs(timeoutSeconds);
  const options = promptOptions;
  const result = await ctx.ui.custom<PermissionPromptResult<Action>>((tui, theme, _kb, done) => {
    const input = new Input();
    let selectedIndex = 0;
    let pendingAction: Action | null = null;
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
      option.action !== "abort" && option.action !== "ssh-session";
    const updateFocus = (): void => {
      input.focused = componentFocused && editing;
    };
    const beginEditing = (): void => {
      input.setValue(originalValue);
      input.handleInput("\x05");
      editing = true;
      error = null;
      pendingAction = null;
      updateFocus();
    };
    const stopEditing = (): void => {
      editing = false;
      error = null;
      updateFocus();
    };
    const resolve = (action: Action): void => {
      if (action === "abort") {
        finish({ action, value: originalValue });
        return;
      }

      const value = editing ? input.getValue().trim() : originalValue;
      const validationError = validateValue(value);
      if (validationError) {
        error = validationError;
        editing = true;
        updateFocus();
        tui.requestRender();
        return;
      }
      finish({ action, value });
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
          if (editing && isSelected && error) {
            lines.push(truncateToWidth(theme.fg("error", `   ✗ ${error}`), width));
          }
        }
        lines.push("");
        const footer = editing
          ? "↑↓ navigate, enter confirm, esc reset, ctrl+c cancel"
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
          if (data === option.key) {
            resolve(option.action);
            return;
          }
          if (data.toLowerCase() === option.key.toLowerCase()) {
            if (option.confirm) {
              pendingAction = option.action;
              selectedIndex = i;
            } else {
              resolve(option.action);
            }
            tui.requestRender();
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

const validRule = (value: string, matches: boolean, target: string): string | null => {
  if (value.length === 0) return "Rule cannot be empty.";
  return matches ? null : `Rule must match the blocked ${target}.`;
};

export function promptDomainBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  domain: string,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    `🌐 Network blocked: "${domain}" is not in allowedDomains`,
    domain,
    (value) => validRule(value, domainIsAllowed(domain, [value]), `domain "${domain}"`),
    timeoutSeconds,
  );
}

export function promptReadBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    `📖 Read blocked: "${path}" is not in allowRead`,
    path,
    (value) => validRule(value, matchesPattern(path, [value]), `path "${path}"`),
    timeoutSeconds,
  );
}

export function promptWriteBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  path: string,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult> {
  return showPermissionPrompt(
    pi,
    ctx,
    `📝 Write blocked: "${path}" is not in allowWrite`,
    path,
    (value) => validRule(value, matchesPattern(path, [value]), `path "${path}"`),
    timeoutSeconds,
  );
}

export function promptSshAuthBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  timeoutSeconds?: number,
): Promise<PermissionPromptResult<SshPermissionChoice>> {
  return showPermissionPrompt<SshPermissionChoice>(
    pi,
    ctx,
    "🔐 SSH auth blocked: allow SSH use for this session?",
    "SSH agent",
    () => null,
    timeoutSeconds,
    [
      { label: "Allow SSH use for this session", key: "s", action: "ssh-session" },
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
    `  Linked Git metadata: ${linkedGitMetadata.join(", ") || "(none)"}`,
    ...(allowances.readPaths.length ? [`  Session read:  ${allowances.readPaths.join(", ")}`] : []),
    ...(allowances.writePaths.length
      ? [`  Session write: ${allowances.writePaths.join(", ")}`]
      : []),
    "",
    "Note: ALL reads are prompted unless the path is in allowRead or allowWrite.",
    "Note: allowWrite also grants read access to the same path.",
    "Note: denyRead is a hard-block unless a more-specific allowRead rule matches.",
    "Note: denyWrite is a hard-block unless a more-specific allowWrite rule matches.",
  ].join("\n");
}
