import { isAbsolute, relative } from "node:path";

import { SandboxManager } from "@carderne/sandbox-runtime";
import { type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import { getConfigPaths, loadConfig } from "./config.ts";
import {
  canonicalizePath,
  canonicalizePathPattern,
  decideDomainPolicy,
  decidePathPolicy,
  extractDomainsFromCommand,
  resolveWritePermission,
} from "./policy.ts";
import {
  bashCommandMentionsSandboxConfig,
  describeSandboxCommandResult,
  formatSandboxCommandUsage,
  getProtectedSandboxConfigPaths,
  isSandboxConfigPath,
  parseSandboxCommand,
  updateSandboxConfigFile,
} from "./sandbox-command.ts";
import {
  createSandboxedBashOps,
  extractBlockedWritePath,
  initializeSandbox,
  reinitializeSandbox,
  resolveAllowances,
  type SessionAllowances,
  supportsNodeEnvProxy,
} from "./sandbox-runtime.ts";
import {
  formatSandboxConfiguration,
  formatSandboxStatus,
  type PermissionPromptResult,
  promptDomainBlock,
  promptReadBlock,
  promptWriteBlock,
  warnIfAllDomainsAllowed,
} from "./ui.ts";

function sandboxConfigMutationMessage(cwd: string): string {
  const { projectPath, globalPath } = getProtectedSandboxConfigPaths(cwd);
  return (
    "Sandbox configuration files are protected. Use /sandbox to add rules; " +
    `protected paths are:\n  ${projectPath}\n  ${globalPath}`
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const userShellPath = SettingsManager.create(localCwd).getShellPath();
  const localBash = createBashToolDefinition(localCwd, { shellPath: userShellPath });

  let sandboxEnabled = false;
  let sandboxInitialized = false;
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };

  const effectiveAllowances = (cwd: string) => resolveAllowances(loadConfig(cwd), allowances);
  const effectiveDomains = (cwd: string) => effectiveAllowances(cwd).domains;
  const effectiveReadPaths = (cwd: string) => effectiveAllowances(cwd).readPaths;
  const effectiveWritePaths = (cwd: string) => effectiveAllowances(cwd).writePaths;

  async function refreshSandbox(cwd: string): Promise<void> {
    if (!sandboxInitialized) return;
    try {
      await reinitializeSandbox(loadConfig(cwd), allowances, cwd);
    } catch (error) {
      console.error(`Warning: Failed to reinitialize sandbox: ${error}`);
    }
  }

  async function applyChoice(
    choice: Exclude<PermissionPromptResult["action"], "abort">,
    kind: "domain" | "read" | "write",
    value: string,
    cwd: string,
  ): Promise<void> {
    const commandKey =
      kind === "domain" ? "allowedDomains" : kind === "read" ? "allowRead" : "allowWrite";
    const storedValue =
      kind === "domain"
        ? value
        : choice === "project"
          ? projectRuleValue(value, cwd)
          : canonicalizePathPattern(value, cwd);
    let changed = false;

    if (kind === "domain") {
      changed = addSessionAllowance(allowances.domains, value);
    } else {
      changed = addSessionAllowance(
        kind === "read" ? allowances.readPaths : allowances.writePaths,
        canonicalizePathPattern(value, cwd),
      );
    }

    if (choice !== "session") {
      const { globalPath, projectPath } = getConfigPaths(cwd);
      const target = choice === "project" ? projectPath : globalPath;
      const result = updateSandboxConfigFile(target, { key: commandKey, value: storedValue }, cwd);
      changed ||= result.changed;
    }

    if (changed) await refreshSandbox(cwd);
  }

  function addSessionAllowance(values: string[], value: string): boolean {
    if (values.includes(value)) return false;
    values.push(value);
    return true;
  }

  function projectRuleValue(value: string, cwd: string): string {
    if (!isAbsolute(value) && !value.startsWith("~")) return value;
    const canonical = canonicalizePathPattern(value, cwd);
    const relativePath = relative(cwd, canonical);
    if (relativePath === "") return ".";
    if (relativePath.startsWith("..")) return canonical;
    return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  }

  function updateStatus(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    config: ReturnType<typeof loadConfig>,
  ) {
    ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", formatSandboxStatus(config)));
  }

  async function enableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    setProxyEnvironment: boolean,
  ): Promise<boolean> {
    if (sandboxEnabled) {
      ctx.ui.notify("Sandbox is already enabled", "info");
      return false;
    }

    const config = loadConfig(ctx.cwd);
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return false;
    }

    try {
      await initializeSandbox(config, allowances, ctx.cwd);
      if (setProxyEnvironment && supportsNodeEnvProxy(process.versions.node)) {
        process.env.NODE_USE_ENV_PROXY ??= "1";
      }
      sandboxEnabled = true;
      sandboxInitialized = true;
      warnIfAllDomainsAllowed(ctx, config);
      updateStatus(ctx, config);
      return true;
    } catch (error) {
      sandboxEnabled = false;
      ctx.ui.notify(
        `Sandbox initialization failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
      return false;
    }
  }

  async function disableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
  ): Promise<boolean> {
    if (!sandboxEnabled) {
      ctx.ui.notify("Sandbox is already disabled", "info");
      return false;
    }

    if (sandboxInitialized) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    }
    sandboxEnabled = false;
    sandboxInitialized = false;
    ctx.ui.setStatus("sandbox", "");
    return true;
  }

  async function toggleSandbox(ctx: Parameters<typeof warnIfAllDomainsAllowed>[0]): Promise<void> {
    if (sandboxEnabled) {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
      return;
    }
    if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
  }

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      const runBash = () => {
        if (!sandboxEnabled || !sandboxInitialized) {
          return localBash.execute(id, params, signal, onUpdate, ctx);
        }
        return createBashToolDefinition(localCwd, {
          operations: createSandboxedBashOps(
            userShellPath,
            loadConfig(ctx.cwd).network?.sshProxy !== false,
          ),
          shellPath: userShellPath,
        }).execute(id, params, signal, onUpdate, ctx);
      };

      let result: AgentToolResult<any>;
      try {
        result = await runBash();
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Operation not permitted")) {
          throw error;
        }
        result = {
          content: [
            {
              type: "text",
              text: `Error: Command failed with OS-level sandbox restriction: ${error.message}`,
            },
          ],
          details: {},
        };
      }

      if (sandboxEnabled && sandboxInitialized && ctx?.hasUI) {
        const output = result.content
          .filter((content: any) => content.type === "text")
          .map((content: any) => content.text)
          .join("\n");
        const blockedPath = extractBlockedWritePath(output);

        if (blockedPath) {
          const path = canonicalizePath(blockedPath);
          const config = loadConfig(ctx.cwd);
          const writePermission = await resolveWritePermission({
            path,
            allowWrite: effectiveWritePaths(ctx.cwd),
            denyWrite: config.filesystem?.denyWrite ?? [],
            cwd: ctx.cwd,
            prompt: (path) =>
              promptWriteBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds),
            saveWritePermission: (choice, value) => applyChoice(choice, "write", value, ctx.cwd),
          });
          if (writePermission.action === "deny") {
            return result;
          }
          if (writePermission.action === "allow") {
            await refreshSandbox(ctx.cwd);
            return runBash();
          }
          if (writePermission.action === "granted") {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `\n--- Write access granted for "${writePermission.value}", retrying ---\n`,
                },
              ],
              details: {},
            });
            return runBash();
          }
        }
      }
      return result;
    },
  });

  pi.on("user_bash", async (event, ctx) => {
    if (bashCommandMentionsSandboxConfig(event.command, ctx.cwd)) {
      return {
        result: {
          output: sandboxConfigMutationMessage(ctx.cwd),
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    if (!sandboxEnabled || !sandboxInitialized) return;

    const config = loadConfig(ctx.cwd);
    if (config.sandboxUserShell === false) return;
    for (const domain of extractDomainsFromCommand(event.command)) {
      const domainPolicy = decideDomainPolicy(
        domain,
        effectiveDomains(ctx.cwd),
        config.network?.deniedDomains ?? [],
      );
      if (domainPolicy === "deny") {
        return {
          result: {
            output: `Blocked: "${domain}" is denied by deniedDomains.`,
            exitCode: 1,
            cancelled: false,
            truncated: false,
          },
        };
      }
      if (domainPolicy === "prompt") {
        const choice = await promptDomainBlock(
          pi,
          ctx,
          domain,
          config.permissionPromptTimeoutSeconds,
        );
        if (choice.action === "abort") {
          return {
            result: {
              output: `Blocked: "${domain}" is not in allowedDomains. Use /sandbox to review your config.`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
        await applyChoice(choice.action, "domain", choice.value, ctx.cwd);
      }
    }
    return {
      operations: createSandboxedBashOps(
        userShellPath,
        loadConfig(ctx.cwd).network?.sshProxy !== false,
      ),
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (
      (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) &&
      isSandboxConfigPath((event.input as { path: string }).path, ctx.cwd)
    ) {
      return { block: true, reason: sandboxConfigMutationMessage(ctx.cwd) };
    }
    if (
      isToolCallEventType("bash", event) &&
      bashCommandMentionsSandboxConfig(event.input.command, ctx.cwd)
    ) {
      return { block: true, reason: sandboxConfigMutationMessage(ctx.cwd) };
    }
    if (!sandboxEnabled) return;
    const config = loadConfig(ctx.cwd);
    if (!config.enabled) return;
    const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

    if (sandboxInitialized && isToolCallEventType("bash", event)) {
      for (const domain of extractDomainsFromCommand(event.input.command)) {
        const domainPolicy = decideDomainPolicy(
          domain,
          effectiveDomains(ctx.cwd),
          config.network?.deniedDomains ?? [],
        );
        if (domainPolicy === "deny") {
          return {
            block: true,
            reason: `Network access to "${domain}" is denied by deniedDomains.`,
          };
        }
        if (domainPolicy === "prompt") {
          const choice = await promptDomainBlock(
            pi,
            ctx,
            domain,
            config.permissionPromptTimeoutSeconds,
          );
          if (choice.action === "abort") {
            return {
              block: true,
              reason: `Network access to "${domain}" is blocked (not in allowedDomains).`,
            };
          }
          await applyChoice(choice.action, "domain", choice.value, ctx.cwd);
        }
      }
    }

    if (isToolCallEventType("read", event)) {
      const path = canonicalizePath(event.input.path, ctx.cwd);
      const readPolicy = decidePathPolicy(
        event.input.path,
        effectiveReadPaths(ctx.cwd),
        config.filesystem?.denyRead ?? [],
        ctx.cwd,
      );
      if (readPolicy === "deny") {
        return {
          block: true,
          reason: `Sandbox: read access denied for "${path}" (in denyRead)`,
        };
      }
      if (readPolicy === "prompt") {
        const choice = await promptReadBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds);
        if (choice.action === "abort") {
          return { block: true, reason: `Sandbox: read access denied for "${path}"` };
        }
        await applyChoice(choice.action, "read", choice.value, ctx.cwd);
        return;
      }
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const path = canonicalizePath((event.input as { path: string }).path, ctx.cwd);
      const writePermission = await resolveWritePermission({
        path,
        allowWrite: effectiveWritePaths(ctx.cwd),
        denyWrite: config.filesystem?.denyWrite ?? [],
        cwd: ctx.cwd,
        prompt: (path) => promptWriteBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds),
        saveWritePermission: (choice, value) => applyChoice(choice, "write", value, ctx.cwd),
      });
      if (writePermission.action === "deny") {
        return {
          block: true,
          reason:
            `Sandbox: write access denied for "${path}" (in denyWrite). ` +
            `To change this, edit denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
        };
      }
      if (writePermission.action === "abort") {
        return {
          block: true,
          reason: `Sandbox: write access denied for "${path}" (not in allowWrite)`,
        };
      }
      if (writePermission.action === "granted") {
        return;
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }
    if (!loadConfig(ctx.cwd).enabled) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }
    await enableSandbox(ctx, true);
  });

  pi.on("session_shutdown", async () => {
    if (!sandboxInitialized) return;
    try {
      await SandboxManager.reset();
    } catch {
      // Ignore cleanup errors.
    }
  });

  pi.registerShortcut(Key.alt("s"), {
    description: "Toggle sandbox on/off for this session",
    handler: toggleSandbox,
  });

  pi.registerCommand("sandbox-enable", {
    description: "Enable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show or update sandbox configuration",
    handler: async (args, ctx) => {
      let command;
      try {
        command = parseSandboxCommand(args, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : formatSandboxCommandUsage(),
          "error",
        );
        return;
      }

      if (command) {
        const { projectPath } = getConfigPaths(ctx.cwd);
        const result = updateSandboxConfigFile(projectPath, command, ctx.cwd);
        if (result.changed && sandboxEnabled && sandboxInitialized) {
          await refreshSandbox(ctx.cwd);
        }
        ctx.ui.notify(`${describeSandboxCommandResult(result)}\nUpdated: ${projectPath}`, "info");
        return;
      }

      ctx.ui.notify(
        formatSandboxConfiguration(loadConfig(ctx.cwd), getConfigPaths(ctx.cwd), allowances),
        "info",
      );
    },
  });
}
