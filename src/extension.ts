import { isAbsolute, relative } from "node:path";

import { SandboxManager } from "@carderne/sandbox-runtime";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  isBashToolResult,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";

import { getConfigPaths, loadConfig } from "./config.ts";
import {
  addUniqueDiagnostics,
  finalizeDiagnostic,
  formatCommandPreview,
  getDiagnosticBlockData,
  isGitUpstreamMutationCommand,
  isMateriallyDifferent,
  parseDiagnosticBlock,
  parseFallbackDiagnosticFromOutput,
  parseViolationEvent,
  recordIncident,
  renderDiagnosticBlock,
  renderDiagnosticNotice,
  selectPrimaryViolation,
  type SandboxDiagnostic,
  type SandboxIncident,
} from "./diagnostics.ts";
import { runGitCommand, setGitUpstream } from "./git-upstream.ts";
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
import { resolveDerivedFilesystemAllowances } from "./sandbox-filesystem.ts";
import {
  createSandboxedBashOps,
  initializeSandbox,
  reinitializeSandbox,
  resolveAllowances,
  type SessionAllowances,
  supportsNodeEnvProxy,
} from "./sandbox-runtime.ts";
import {
  formatSandboxDebug,
  renderSandboxDiagnosticResult,
  setSandboxStatus,
  type DiagnosticResultDetails,
  type SandboxStatusState,
} from "./status.ts";
import {
  formatSandboxConfiguration,
  type PermissionPromptResult,
  promptDomainBlock,
  promptReadBlock,
  promptWriteBlock,
  warnIfAllDomainsAllowed,
} from "./ui.ts";

interface SetGitUpstreamParameters {
  localBranch: string;
  remote: "origin";
  remoteBranch: string;
}

const setGitUpstreamParameters = {
  type: "object",
  properties: {
    localBranch: {
      type: "string",
      description: "The existing local branch name",
    },
    remote: {
      type: "string",
      const: "origin",
      description: 'The only permitted remote; must be "origin"',
    },
    remoteBranch: {
      type: "string",
      description: "The existing remote branch name",
    },
  },
  required: ["localBranch", "remote", "remoteBranch"],
  additionalProperties: false,
} as const;

function gitUpstreamRedirectMessage(): string {
  return (
    "Use the set_git_upstream tool for Git branch tracking instead of Bash. " +
    "If git push -u is needed to publish the branch, push without -u first, then call set_git_upstream."
  );
}

function gitUpstreamBlockedResult() {
  return {
    result: {
      output: gitUpstreamRedirectMessage(),
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  };
}

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
  let sandboxCwd: string | null = null;
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };
  // Session history intentionally lives in this extension closure. It is never
  // serialized with either the project or global sandbox configuration.
  const sandboxIncidents: SandboxIncident[] = [];

  const effectiveAllowances = (cwd: string) => resolveAllowances(loadConfig(cwd), allowances, cwd);
  const effectiveDomains = (cwd: string) => effectiveAllowances(cwd).domains;
  const effectiveReadPaths = (cwd: string) => effectiveAllowances(cwd).readPaths;
  const effectiveWritePaths = (cwd: string) => effectiveAllowances(cwd).writePaths;

  async function refreshSandbox(cwd: string): Promise<boolean> {
    if (!sandboxInitialized) return true;
    try {
      await reinitializeSandbox(loadConfig(cwd), allowances, cwd);
      sandboxCwd = cwd;
      return true;
    } catch (error) {
      // Keep the sandbox state enabled so execution cannot fall back to local Bash.
      console.error(`Warning: Failed to reinitialize sandbox: ${error}`);
      return false;
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

  function diagnosticPolicy(cwd: string) {
    const config = loadConfig(cwd);
    const effective = effectiveAllowances(cwd);
    return {
      cwd,
      allowRead: effective.readPaths,
      denyRead: config.filesystem?.denyRead ?? [],
      allowWrite: effective.writePaths,
      denyWrite: config.filesystem?.denyWrite ?? [],
      allowedDomains: effective.domains,
      deniedDomains: config.network?.deniedDomains ?? [],
    };
  }

  function incidentFor(source: "bash" | "user_bash", command: string): SandboxIncident {
    return {
      id: `${source}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
      source,
      commandPreview: formatCommandPreview(command),
      commandKey: command,
      attributed: false,
      violations: [],
      primaryViolation: undefined,
      promptShown: false,
      promptChoice: "none",
      promptCount: 0,
      retried: false,
      finalOutcome: "failure",
      configMutation: "none",
    };
  }

  function mutationForChoice(
    choice: Exclude<PermissionPromptResult["action"], "abort"> | "abort" | "none",
  ): SandboxIncident["configMutation"] {
    if (choice === "project") return ".pi/sandbox.json";
    if (choice === "global") return "~/.pi/agent/sandbox.json";
    return "none";
  }

  function storeIncident(incident: SandboxIncident): void {
    recordIncident(sandboxIncidents, incident);
  }

  function resetIncidentHistory(): void {
    sandboxIncidents.length = 0;
  }

  function resetSessionMemory(): void {
    allowances.domains.length = 0;
    allowances.readPaths.length = 0;
    allowances.writePaths.length = 0;
    resetIncidentHistory();
  }

  async function promptForDiagnostic(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    diagnostic: SandboxDiagnostic,
    incident: SandboxIncident,
  ): Promise<"abort" | "session" | "project" | "global" | "none"> {
    if (
      !ctx.hasUI ||
      !diagnostic.promptable ||
      incident.promptCount >= 2 ||
      (diagnostic.type !== "network" && diagnostic.type !== "read" && diagnostic.type !== "write")
    ) {
      return "none";
    }

    incident.promptShown = true;
    incident.promptCount += 1;
    const timeout = loadConfig(ctx.cwd).permissionPromptTimeoutSeconds;
    const target = diagnostic.rawTarget ?? diagnostic.target;
    const choice =
      diagnostic.type === "network"
        ? await promptDomainBlock(pi, ctx, target, timeout)
        : diagnostic.type === "read"
          ? await promptReadBlock(pi, ctx, target, timeout)
          : await promptWriteBlock(pi, ctx, target, timeout);

    incident.promptChoice = choice.action;
    incident.configMutation = mutationForChoice(choice.action);
    if (choice.action === "abort") return "abort";
    await applyChoice(
      choice.action,
      diagnostic.type === "network" ? "domain" : diagnostic.type,
      choice.value,
      ctx.cwd,
    );
    return choice.action;
  }

  function createDiagnosticOperations(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    source: "bash" | "user_bash",
    shellPath: string | undefined,
    recordDiagnosticInContext: boolean,
    onDetails?: (details: DiagnosticResultDetails | undefined) => void,
    initialIncident?: SandboxIncident,
  ): ReturnType<typeof createSandboxedBashOps> {
    const baseOperations = createSandboxedBashOps(
      shellPath,
      loadConfig(ctx.cwd).network?.sshProxy !== false,
    );
    return {
      async exec(command, cwd, execOptions) {
        const incident = initialIncident ?? incidentFor(source, command);
        let lastPrompted: SandboxDiagnostic | undefined;
        let lastResult: { exitCode: number | null } = { exitCode: 1 };
        let visibleOutput = "";

        for (;;) {
          let output = "";
          const store = SandboxManager.getSandboxViolationStore();
          const beforeCount = store.getViolationsForCommand(command).length;
          lastResult = await baseOperations.exec(command, cwd, {
            ...execOptions,
            onData: (data) => {
              output += data.toString();
              visibleOutput += data.toString();
              execOptions.onData(data);
            },
          });

          let annotatedOutput = output;
          try {
            annotatedOutput = SandboxManager.annotateStderrWithSandboxFailures(command, output);
          } catch {
            // Some runtime versions do not annotate until a log monitor is active.
          }

          const events = store
            .getViolationsForCommand(command)
            .slice(beforeCount)
            .map((event) => parseViolationEvent(event, process.env.SSH_AUTH_SOCK))
            .map((diagnostic) => finalizeDiagnostic(diagnostic, diagnosticPolicy(cwd)));
          const diagnostics = events.length
            ? events
            : [parseFallbackDiagnosticFromOutput(command, annotatedOutput)]
                .filter((diagnostic): diagnostic is SandboxDiagnostic => diagnostic !== null)
                .map((diagnostic) => finalizeDiagnostic(diagnostic, diagnosticPolicy(cwd)));

          incident.violations = addUniqueDiagnostics(incident.violations, diagnostics);
          incident.primaryViolation = selectPrimaryViolation(incident.violations);
          incident.attributed = incident.violations.length > 0;
          incident.finalOutcome = lastResult.exitCode === 0 ? "success" : "failure";

          const primary = selectPrimaryViolation(diagnostics);
          const canRetry =
            lastResult.exitCode !== 0 &&
            primary?.promptable === true &&
            (lastPrompted === undefined || isMateriallyDifferent(lastPrompted, primary)) &&
            incident.promptCount < 2;
          if (canRetry) {
            const choice = await promptForDiagnostic(ctx, primary, incident);
            lastPrompted = primary;
            if (choice !== "abort" && choice !== "none") {
              incident.retried = true;
              const retryNotice = "\n--- Sandbox permission granted, retrying ---\n";
              visibleOutput += retryNotice;
              execOptions.onData(Buffer.from(retryNotice));
              continue;
            }
          }
          break;
        }

        const block = renderDiagnosticBlock(incident);
        const blockData = getDiagnosticBlockData(incident);
        const visibleText = blockData
          ? visibleOutput
              .replace(/\n*<sandbox_diagnostic>[\s\S]*?<\/sandbox_diagnostic>\s*$/, "")
              .trimEnd()
          : visibleOutput;
        onDetails?.(
          blockData ? { sandboxDiagnostic: blockData, sandboxVisibleText: visibleText } : undefined,
        );

        if (block && blockData) {
          if (source === "user_bash") {
            if (recordDiagnosticInContext) {
              pi.sendMessage({
                customType: "sandbox-diagnostic",
                content: block,
                display: false,
              });
            }
            execOptions.onData(Buffer.from(`\n${renderDiagnosticNotice(blockData)}\n`));
          } else {
            execOptions.onData(Buffer.from(`\n${block}\n`));
          }
        }
        storeIncident(incident);
        return lastResult;
      },
    };
  }

  function updateStatus(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    state: SandboxStatusState,
  ): void {
    setSandboxStatus(ctx, state);
  }

  async function enableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    setProxyEnvironment: boolean,
  ): Promise<boolean> {
    if (sandboxEnabled) {
      if (sandboxInitialized && sandboxCwd !== ctx.cwd) {
        const refreshed = await refreshSandbox(ctx.cwd);
        if (refreshed) updateStatus(ctx, "enabled");
        return refreshed;
      }
      ctx.ui.notify("Sandbox is already enabled", "info");
      updateStatus(ctx, "enabled");
      return false;
    }

    const config = loadConfig(ctx.cwd);
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      updateStatus(ctx, "unsupported");
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
      sandboxCwd = ctx.cwd;
      warnIfAllDomainsAllowed(ctx, config);
      updateStatus(ctx, "enabled");
      return true;
    } catch (error) {
      sandboxEnabled = false;
      sandboxInitialized = false;
      sandboxCwd = null;
      updateStatus(ctx, "error");
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
      updateStatus(ctx, "disabled");
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
    sandboxCwd = null;
    updateStatus(ctx, "disabled");
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
    name: "set_git_upstream",
    label: "Set Git upstream",
    description:
      "Set a local branch to track an existing branch on the origin remote. " +
      "This tool accepts branch names only and cannot run arbitrary Git commands or modify other config.",
    promptSnippet: "Set a local branch to track an existing origin branch",
    parameters: setGitUpstreamParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const input = params as unknown as SetGitUpstreamParameters;
      await setGitUpstream(
        {
          cwd: ctx.cwd,
          localBranch: input.localBranch,
          remote: input.remote,
          remoteBranch: input.remoteBranch,
        },
        runGitCommand,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: `Local branch "${input.localBranch}" now tracks "${input.remote}/${input.remoteBranch}".`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (isGitUpstreamMutationCommand(params.command)) {
        return {
          content: [{ type: "text", text: gitUpstreamRedirectMessage() }],
          details: {},
        };
      }

      if (!sandboxEnabled || !sandboxInitialized) {
        return localBash.execute(id, params, signal, onUpdate, ctx);
      }
      if (sandboxCwd !== ctx.cwd) await refreshSandbox(ctx.cwd);

      let diagnosticDetails: DiagnosticResultDetails | undefined;
      const sandboxedBash = createBashToolDefinition(localCwd, {
        operations: createDiagnosticOperations(ctx, "bash", userShellPath, false, (details) => {
          diagnosticDetails = details;
        }),
        shellPath: userShellPath,
      });
      const result = await sandboxedBash.execute(id, params, signal, onUpdate, ctx);
      if (diagnosticDetails) {
        result.details = {
          ...result.details,
          ...diagnosticDetails,
        } as typeof result.details;
      }
      return result;
    },
    renderResult(result, options, theme, context) {
      const details = (result.details ?? {}) as DiagnosticResultDetails;
      if (!details.sandboxDiagnostic) {
        return localBash.renderResult
          ? localBash.renderResult(result as never, options as never, theme, context)
          : new Text("", 0, 0);
      }
      return renderSandboxDiagnosticResult(result, options.expanded, theme);
    },
  });

  pi.on("user_bash", async (event, ctx) => {
    if (isGitUpstreamMutationCommand(event.command)) return gitUpstreamBlockedResult();
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
    if (sandboxCwd !== ctx.cwd) await refreshSandbox(ctx.cwd);

    const config = loadConfig(ctx.cwd);
    if (config.sandboxUserShell === false) return;
    const incident = incidentFor("user_bash", event.command);
    const recordDiagnosticInContext = !event.excludeFromContext;
    for (const domain of extractDomainsFromCommand(event.command)) {
      const domainPolicy = decideDomainPolicy(
        domain,
        effectiveDomains(ctx.cwd),
        config.network?.deniedDomains ?? [],
      );
      if (domainPolicy === "deny") {
        const diagnostic: SandboxDiagnostic = {
          type: "network",
          target: domain,
          rawTarget: domain,
          rule: "deniedDomains",
          promptable: false,
          action: "blocked by deniedDomains; change policy",
        };
        incident.violations = addUniqueDiagnostics(incident.violations, [diagnostic]);
        incident.primaryViolation = selectPrimaryViolation(incident.violations);
        incident.attributed = true;
        incident.finalOutcome = "failure";
        const block = renderDiagnosticBlock(incident);
        const data = getDiagnosticBlockData(incident);
        if (recordDiagnosticInContext && block) {
          pi.sendMessage({ customType: "sandbox-diagnostic", content: block, display: false });
        }
        storeIncident(incident);
        return {
          result: {
            output: `Blocked: "${domain}" is denied by deniedDomains.${data ? `\n${renderDiagnosticNotice(data)}` : ""}`,
            exitCode: 1,
            cancelled: false,
            truncated: false,
          },
        };
      }
      if (domainPolicy === "prompt") {
        const diagnostic: SandboxDiagnostic = {
          type: "network",
          target: domain,
          rawTarget: domain,
          rule: "allowedDomains",
          promptable: true,
          action: "host not allowed; approve network access",
        };
        incident.violations = addUniqueDiagnostics(incident.violations, [diagnostic]);
        incident.primaryViolation = selectPrimaryViolation(incident.violations);
        incident.attributed = true;
        const choice = await promptForDiagnostic(ctx, diagnostic, incident);
        if (choice === "abort" || choice === "none") {
          incident.finalOutcome = "failure";
          const block = renderDiagnosticBlock(incident);
          const data = getDiagnosticBlockData(incident);
          if (recordDiagnosticInContext && block) {
            pi.sendMessage({ customType: "sandbox-diagnostic", content: block, display: false });
          }
          storeIncident(incident);
          return {
            result: {
              output: `Blocked: "${domain}" is not in allowedDomains. Use /sandbox to review your config.${data ? `\n${renderDiagnosticNotice(data)}` : ""}`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
      }
    }
    return {
      operations: createDiagnosticOperations(
        ctx,
        "user_bash",
        userShellPath,
        recordDiagnosticInContext,
        undefined,
        incident,
      ),
    };
  });

  pi.on("tool_result", async (event) => {
    if (!isBashToolResult(event)) return;
    const textContent = event.content.find((content) => content.type === "text");
    if (!textContent || textContent.type !== "text") return;

    const parsed = parseDiagnosticBlock(textContent.text);
    if (!parsed) return;
    return {
      details: {
        ...(event.details as Record<string, unknown> | undefined),
        sandboxDiagnostic: parsed.data,
        sandboxVisibleText: parsed.visibleText,
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event) && isGitUpstreamMutationCommand(event.input.command)) {
      return { block: true, reason: gitUpstreamRedirectMessage() };
    }
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
    // Incident history is scoped to the replacement session. Session allowances
    // remain with the active runtime until session_shutdown tears it down.
    resetIncidentHistory();
    updateStatus(ctx, "pending");

    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxEnabled = false;
      sandboxInitialized = false;
      sandboxCwd = null;
      updateStatus(ctx, "disabled");
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }
    if (!loadConfig(ctx.cwd).enabled) {
      sandboxEnabled = false;
      sandboxInitialized = false;
      sandboxCwd = null;
      updateStatus(ctx, "disabled");
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }
    await enableSandbox(ctx, true);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (sandboxInitialized) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    }
    sandboxEnabled = false;
    sandboxInitialized = false;
    sandboxCwd = null;
    resetSessionMemory();
    // session_shutdown receives the active context in normal extension
    // lifecycles. The pure status contract remains usable when it does not.
    if (ctx) updateStatus(ctx, "shutdown");
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

  pi.registerCommand("sandbox-debug", {
    description: "Show recent sandbox incidents for bash and !cmd",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatSandboxDebug(sandboxIncidents, { enabled: sandboxEnabled }), "info");
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
        const runtimeRefreshed =
          !result.changed || !sandboxEnabled || !sandboxInitialized
            ? true
            : await refreshSandbox(ctx.cwd);
        ctx.ui.notify(`${describeSandboxCommandResult(result)}\nUpdated: ${projectPath}`, "info");
        if (!runtimeRefreshed) {
          ctx.ui.notify(
            "Warning: The project configuration was persisted, but the active sandbox runtime was not refreshed.",
            "warning",
          );
        }
        return;
      }

      ctx.ui.notify(
        formatSandboxConfiguration(
          loadConfig(ctx.cwd),
          getConfigPaths(ctx.cwd),
          allowances,
          resolveDerivedFilesystemAllowances(ctx.cwd).linkedGitMetadata,
        ),
        "info",
      );
    },
  });
}
