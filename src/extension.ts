import { isAbsolute, relative } from "node:path";

import { SandboxManager } from "@carderne/sandbox-runtime";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  isBashToolResult,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { getConfigPaths, loadConfig, type SandboxConfig } from "./config.ts";
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
  runSshAuthPreflight,
  grantSshSessionAccess,
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
  formatSandboxAllowUsage,
  getProtectedSandboxConfigPaths,
  isSandboxConfigPath,
  parseSandboxAllowCommand,
  updateSandboxConfigFile,
} from "./sandbox-command.ts";
import {
  getMandatoryWriteDenyPaths,
  isMandatoryWritePath,
  resolveDerivedFilesystemAllowances,
} from "./sandbox-filesystem.ts";
import {
  createSandboxedBashOps,
  initializeSandbox,
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
  type SshPermissionChoice,
  promptDomainBlock,
  promptReadBlock,
  promptSshAuthBlock,
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
    "Sandbox configuration files are protected; /sandbox-allow cannot override this protection. " +
    `Protected paths are:\n  ${projectPath}\n  ${globalPath}`
  );
}

export interface SandboxExtensionOptions {
  /** Injectable platform seam for portable SSH preflight contracts. */
  platform?: NodeJS.Platform;
  /** Injectable configuration seam for isolated policy and prompt contracts. */
  configLoader?: (cwd: string) => SandboxConfig;
}

export default function (pi: ExtensionAPI, options: SandboxExtensionOptions = {}) {
  const platform = options.platform ?? process.platform;
  const readConfig = options.configLoader ?? loadConfig;
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const userShellPath = SettingsManager.create(localCwd).getShellPath();
  const localBash = createBashToolDefinition(localCwd, { shellPath: userShellPath });

  type SandboxContext = Parameters<typeof warnIfAllDomainsAllowed>[0];
  type SandboxPolicySnapshot = {
    config: SandboxConfig;
    allowances: SessionAllowances;
    cwd: string;
    fingerprint: string;
  };
  type SandboxLifecycle =
    | { state: "disabled" }
    | { state: "unsupported" }
    | { state: "initializing"; generation: number; desired: SandboxPolicySnapshot }
    | { state: "shutting-down"; generation: number }
    | { state: "shutdown" }
    | { state: "ready"; generation: number; policy: SandboxPolicySnapshot }
    | { state: "unavailable"; generation: number; desired: SandboxPolicySnapshot };

  let sandboxLifecycle: SandboxLifecycle = { state: "disabled" };
  // Generation/context ownership remains separate from the lifecycle state. A
  // failed replacement must not let a stale async operation claim readiness.
  let sessionGeneration = 0;
  let currentSessionContext: SandboxContext | undefined;
  // This records ownership of an actual manager runtime, including a prior
  // runtime restored while the desired replacement remains unavailable.
  let sandboxRuntimeOwnerGeneration: number | null = null;
  let sandboxRuntimeCwd: string | null = null;
  // SandboxManager owns process-global runtime state. Serialize every reset /
  // initialize transaction so an obsolete completion cannot reset or overwrite
  // a replacement lifecycle that started while the old operation was pending.
  let sandboxManagerTransition: Promise<void> = Promise.resolve();
  const allowances: SessionAllowances = {
    domains: [],
    readPaths: [],
    writePaths: [],
    unixSockets: [],
  };
  // Session history intentionally lives in this extension closure. It is never
  // serialized with either the project or global sandbox configuration.
  const sandboxIncidents: SandboxIncident[] = [];

  const effectiveAllowances = (cwd: string) => resolveAllowances(readConfig(cwd), allowances, cwd);
  const effectiveDomains = (cwd: string) => effectiveAllowances(cwd).domains;
  const effectiveReadPaths = (cwd: string) => effectiveAllowances(cwd).readPaths;
  const effectiveWritePaths = (cwd: string) => effectiveAllowances(cwd).writePaths;
  const effectiveUnixSockets = (cwd: string) => effectiveAllowances(cwd).unixSockets;

  function cloneAllowances(source: SessionAllowances): SessionAllowances {
    return {
      domains: [...source.domains],
      readPaths: [...source.readPaths],
      writePaths: [...source.writePaths],
      unixSockets: [...source.unixSockets],
    };
  }

  function sandboxPolicySnapshot(
    config: SandboxConfig,
    sourceAllowances: SessionAllowances,
    cwd: string,
  ): SandboxPolicySnapshot {
    const snapshot = {
      config: structuredClone(config),
      allowances: cloneAllowances(sourceAllowances),
      cwd,
    };
    return { ...snapshot, fingerprint: JSON.stringify(snapshot) };
  }

  function sandboxRequested(): boolean {
    return (
      sandboxLifecycle.state === "initializing" ||
      sandboxLifecycle.state === "ready" ||
      sandboxLifecycle.state === "unavailable"
    );
  }

  function sandboxReady(): boolean {
    return sandboxLifecycle.state === "ready";
  }

  function sandboxExecutionBlocked(): boolean {
    return (
      sandboxLifecycle.state === "initializing" ||
      sandboxLifecycle.state === "unavailable" ||
      sandboxLifecycle.state === "shutting-down" ||
      sandboxLifecycle.state === "shutdown"
    );
  }

  async function withSandboxManagerTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = sandboxManagerTransition;
    let release!: () => void;
    sandboxManagerTransition = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function refreshSandbox(
    cwd: string,
    expectedGeneration = sessionGeneration,
  ): Promise<boolean> {
    if (sandboxLifecycle.state !== "ready" || sessionGeneration !== expectedGeneration)
      return false;
    const prior = sandboxLifecycle.policy;
    const desired = sandboxPolicySnapshot(readConfig(cwd), allowances, cwd);
    sandboxLifecycle = { state: "initializing", generation: expectedGeneration, desired };
    if (currentSessionContext) updateStatus(currentSessionContext, "pending");

    return withSandboxManagerTransition(async () => {
      if (sessionGeneration !== expectedGeneration) return false;
      let resetCompleted = false;

      try {
        await SandboxManager.reset();
        resetCompleted = true;
        if (sessionGeneration !== expectedGeneration) return false;
        await initializeSandbox(desired.config, desired.allowances, desired.cwd);
        if (sessionGeneration !== expectedGeneration) return false;
        sandboxRuntimeCwd = desired.cwd;
        sandboxRuntimeOwnerGeneration = expectedGeneration;
        sandboxLifecycle = { state: "ready", generation: expectedGeneration, policy: desired };
        return true;
      } catch (error) {
        if (sessionGeneration !== expectedGeneration) return false;

        // The reset has made the prior manager unusable in the general case. A
        // best-effort restoration is only executable when it exactly matches the
        // desired policy; a restored but stale policy remains unavailable.
        let restored = false;
        try {
          if (!resetCompleted) throw new Error("sandbox reset did not complete");
          await initializeSandbox(prior.config, prior.allowances, prior.cwd);
          restored = true;
        } catch (restoreError) {
          console.error(`Warning: Failed to restore the prior sandbox runtime: ${restoreError}`);
        }
        if (sessionGeneration !== expectedGeneration) return false;

        if (restored) {
          sandboxRuntimeCwd = prior.cwd;
          sandboxRuntimeOwnerGeneration = expectedGeneration;
        } else {
          sandboxRuntimeCwd = null;
          sandboxRuntimeOwnerGeneration = null;
        }

        const policyEquivalent = restored && prior.fingerprint === desired.fingerprint;
        if (policyEquivalent) {
          sandboxLifecycle = { state: "ready", generation: expectedGeneration, policy: prior };
          console.error(
            "Warning: Sandbox replacement failed; restored the equivalent prior runtime.",
          );
          if (currentSessionContext) updateStatus(currentSessionContext, "enabled");
          return true;
        }

        sandboxLifecycle = { state: "unavailable", generation: expectedGeneration, desired };
        console.error(`Warning: Sandbox is unavailable after reinitialization failure: ${error}`);
        if (currentSessionContext) {
          updateStatus(currentSessionContext, "unavailable");
          currentSessionContext.ui.notify(
            "Sandbox is unavailable; command execution remains blocked until recovery.",
            "error",
          );
        }
        return false;
      }
    });
  }

  function ownsSessionStart(ownership: {
    generation: number;
    context: Parameters<typeof warnIfAllDomainsAllowed>[0];
  }): boolean {
    return (
      ownership.generation === sessionGeneration && currentSessionContext === ownership.context
    );
  }

  function sandboxExecutionBlockedResult() {
    return {
      result: {
        output: "Sandbox is not ready; command execution remains blocked.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  }

  async function applyChoice(
    choice: Exclude<PermissionPromptResult["action"], "abort">,
    kind: "domain" | "read" | "write",
    value: string,
    cwd: string,
  ): Promise<boolean> {
    const commandKey =
      kind === "domain" ? "allowedDomains" : kind === "read" ? "allowRead" : "allowWrite";
    const storedValue =
      kind === "domain"
        ? value
        : choice === "project"
          ? projectRuleValue(value, cwd)
          : canonicalizePathPattern(value, cwd);
    const sessionAllowanceValues =
      kind === "domain"
        ? allowances.domains
        : kind === "read"
          ? allowances.readPaths
          : allowances.writePaths;
    const sessionAllowanceValue = kind === "domain" ? value : canonicalizePathPattern(value, cwd);

    let persistedChange = false;
    if (choice !== "session") {
      const { globalPath, projectPath } = getConfigPaths(cwd);
      const target = choice === "project" ? projectPath : globalPath;
      const result = updateSandboxConfigFile(target, { key: commandKey, value: storedValue }, cwd);
      persistedChange = result.changed;
    }

    const addedSessionAllowance =
      choice === "session" && addSessionAllowance(sessionAllowanceValues, sessionAllowanceValue);
    const changed = persistedChange || addedSessionAllowance;
    const runtimeIsActive =
      sandboxLifecycle.state === "ready" ||
      sandboxLifecycle.state === "initializing" ||
      sandboxLifecycle.state === "unavailable";
    let refreshed = true;
    try {
      if (changed && runtimeIsActive) refreshed = await refreshSandbox(cwd);
    } catch (error) {
      if (addedSessionAllowance) {
        const index = sessionAllowanceValues.indexOf(sessionAllowanceValue);
        if (index >= 0) sessionAllowanceValues.splice(index, 1);
      }
      throw error;
    }
    if (!refreshed && addedSessionAllowance) {
      const index = sessionAllowanceValues.indexOf(sessionAllowanceValue);
      if (index >= 0) sessionAllowanceValues.splice(index, 1);
    }
    return refreshed;
  }

  function addSessionAllowance(values: string[], value: string): boolean {
    if (values.includes(value)) return false;
    values.push(value);
    return true;
  }

  function sessionUnixSockets(): string[] {
    return allowances.unixSockets;
  }

  function projectRuleValue(value: string, cwd: string): string {
    if (!isAbsolute(value) && !value.startsWith("~")) return value;
    const canonicalCwd = canonicalizePath(cwd, cwd);
    const canonical = canonicalizePathPattern(value, cwd);
    const relativePath = relative(canonicalCwd, canonical);
    if (relativePath === "") return ".";
    if (relativePath.startsWith("..")) return canonical;
    return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  }

  function diagnosticPolicy(cwd: string) {
    const config = readConfig(cwd);
    const effective = effectiveAllowances(cwd);
    return {
      cwd,
      allowRead: effective.readPaths,
      denyRead: config.filesystem?.denyRead ?? [],
      allowWrite: effective.writePaths,
      denyWrite: config.filesystem?.denyWrite ?? [],
      mandatoryDenyWrite: getMandatoryWriteDenyPaths(cwd),
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
    choice:
      | Exclude<PermissionPromptResult["action"], "abort">
      | SshPermissionChoice
      | "abort"
      | "none",
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
    allowances.unixSockets.splice(0, allowances.unixSockets.length);
    resetIncidentHistory();
  }

  async function applySshAuthChoice(socketPath: string, cwd: string): Promise<boolean> {
    return grantSshSessionAccess({
      socketPath,
      allowedSockets: sessionUnixSockets(),
      reinitialize: async () => refreshSandbox(cwd),
      platform,
      cwd,
    });
  }

  async function requestSshAuthAccess(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    socketPath: string,
  ): Promise<"abort" | "ssh-session" | "none"> {
    if (platform === "linux") return "none";
    const choice = await promptSshAuthBlock(
      pi,
      ctx,
      readConfig(ctx.cwd).permissionPromptTimeoutSeconds,
    );
    if (choice.action !== "ssh-session") {
      return choice.action === "abort" ? "abort" : "none";
    }
    if (await applySshAuthChoice(socketPath, ctx.cwd)) return "ssh-session";
    ctx.ui.notify("Failed to reinitialise the sandbox; SSH-agent access was not granted.", "error");
    return "none";
  }

  function sshDiagnostic(socketPath: string, promptable = platform !== "linux"): SandboxDiagnostic {
    return {
      type: "ssh-auth",
      target: "current SSH agent",
      rawTarget: socketPath,
      rule: "ssh agent socket blocked",
      promptable,
      action:
        platform === "linux"
          ? "path-scoped SSH-agent access is unavailable on Linux; agent remains blocked"
          : "allow SSH use for this session",
    };
  }

  async function runSshPreflight(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    command: string,
    incident: SandboxIncident,
  ): Promise<"not-needed" | "allowed" | "blocked"> {
    const config = readConfig(ctx.cwd);
    const sshAuthSock = process.env.SSH_AUTH_SOCK;
    const result = await runSshAuthPreflight({
      command,
      sshAuthSock,
      allowedSockets: effectiveUnixSockets(ctx.cwd),
      allowAllSockets: config.network?.allowAllUnixSockets === true,
      platform,
      requestAccess: async (socketPath) => {
        const diagnostic = sshDiagnostic(socketPath);
        incident.violations = addUniqueDiagnostics(incident.violations, [diagnostic]);
        incident.primaryViolation = selectPrimaryViolation(incident.violations);
        incident.attributed = true;
        const choice = await promptForDiagnostic(ctx, diagnostic, incident);
        return choice === "ssh-session";
      },
    });
    if (result === "blocked" && sshAuthSock) {
      const diagnostic = sshDiagnostic(sshAuthSock, platform !== "linux");
      incident.violations = addUniqueDiagnostics(incident.violations, [diagnostic]);
      incident.primaryViolation = selectPrimaryViolation(incident.violations);
      incident.attributed = true;
    }
    return result;
  }

  async function promptForDiagnostic(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    diagnostic: SandboxDiagnostic,
    incident: SandboxIncident,
  ): Promise<"abort" | "session" | "project" | "global" | "ssh-session" | "none"> {
    if (
      !ctx.hasUI ||
      !diagnostic.promptable ||
      incident.promptCount >= 2 ||
      (diagnostic.type !== "network" &&
        diagnostic.type !== "read" &&
        diagnostic.type !== "write" &&
        diagnostic.type !== "ssh-auth")
    ) {
      return "none";
    }

    incident.promptShown = true;
    incident.promptCount += 1;
    const timeout = readConfig(ctx.cwd).permissionPromptTimeoutSeconds;
    const target = diagnostic.rawTarget ?? diagnostic.target;
    if (diagnostic.type === "ssh-auth") {
      const choice = await requestSshAuthAccess(ctx, target);
      incident.promptChoice = choice;
      incident.configMutation = mutationForChoice(choice);
      return choice;
    }

    const choice =
      diagnostic.type === "network"
        ? await promptDomainBlock(pi, ctx, target, timeout)
        : diagnostic.type === "read"
          ? await promptReadBlock(pi, ctx, target, timeout)
          : await promptWriteBlock(pi, ctx, target, timeout);

    incident.promptChoice = choice.action;
    incident.configMutation = mutationForChoice(choice.action);
    if (choice.action === "abort") return "abort";
    const refreshed = await applyChoice(
      choice.action,
      diagnostic.type === "network" ? "domain" : diagnostic.type,
      choice.value,
      ctx.cwd,
    );
    return refreshed ? choice.action : "none";
  }

  function createDiagnosticOperations(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    source: "bash" | "user_bash",
    shellPath: string | undefined,
    recordDiagnosticInContext: boolean,
    onDetails?: (details: DiagnosticResultDetails | undefined) => void,
    initialIncident?: SandboxIncident,
    expectedGeneration = sessionGeneration,
  ): ReturnType<typeof createSandboxedBashOps> {
    const baseOperations = createSandboxedBashOps(shellPath);
    return {
      async exec(command, cwd, execOptions) {
        if (
          sandboxExecutionBlocked() ||
          !sandboxReady() ||
          sessionGeneration !== expectedGeneration
        ) {
          throw new Error("Sandbox is not ready; command execution remains blocked.");
        }
        const incident = initialIncident ?? incidentFor(source, command);
        let lastPrompted: SandboxDiagnostic | undefined;
        let lastResult: { exitCode: number | null } = { exitCode: 1 };
        let visibleOutput = "";

        const sshPreflight = await runSshPreflight(ctx, command, incident);
        if (sshPreflight === "blocked") {
          incident.finalOutcome = "failure";
          const reason =
            platform === "linux"
              ? "Blocked: path-specific SSH-agent access is unavailable on Linux; agent access remains blocked."
              : "Blocked: SSH agent access is not allowed.";
          const block = renderDiagnosticBlock(incident);
          const blockData = getDiagnosticBlockData(incident);
          const visibleText = blockData
            ? `${reason}\n${renderDiagnosticNotice(blockData)}`
            : reason;
          onDetails?.(
            blockData
              ? { sandboxDiagnostic: blockData, sandboxVisibleText: visibleText }
              : undefined,
          );
          if (source === "user_bash" && blockData) {
            if (recordDiagnosticInContext && block) {
              pi.sendMessage({ customType: "sandbox-diagnostic", content: block, display: false });
            }
            execOptions.onData(Buffer.from(`\n${renderDiagnosticNotice(blockData)}\n`));
          } else {
            execOptions.onData(Buffer.from(`\n${reason}\n${block ?? ""}\n`));
          }
          storeIncident(incident);
          return { exitCode: 1 };
        }

        if (
          sandboxExecutionBlocked() ||
          !sandboxReady() ||
          sessionGeneration !== expectedGeneration
        ) {
          throw new Error("Sandbox is not ready; command execution remains blocked.");
        }

        for (;;) {
          if (
            sandboxExecutionBlocked() ||
            !sandboxReady() ||
            sessionGeneration !== expectedGeneration
          ) {
            throw new Error("Sandbox is not ready; command execution remains blocked.");
          }
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
            .map((event) => parseViolationEvent(event, process.env.SSH_AUTH_SOCK, platform))
            .map((diagnostic) => finalizeDiagnostic(diagnostic, diagnosticPolicy(cwd)));
          const diagnostics = events.length
            ? events
            : [
                parseFallbackDiagnosticFromOutput(
                  command,
                  annotatedOutput,
                  process.env.SSH_AUTH_SOCK,
                  platform,
                ),
              ]
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
    ctx: SandboxContext,
    setProxyEnvironment: boolean,
    ownership?: { generation: number; context: SandboxContext },
    _blockOnFailure = false,
  ): Promise<boolean> {
    const expectedGeneration = ownership?.generation ?? sessionGeneration;
    if (
      sessionGeneration !== expectedGeneration ||
      (ownership !== undefined && !ownsSessionStart(ownership))
    ) {
      return false;
    }

    const config = readConfig(ctx.cwd);
    if (platform !== "darwin" && platform !== "linux") {
      sandboxLifecycle = { state: "unsupported" };
      updateStatus(ctx, "unsupported");
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return false;
    }

    if (sandboxLifecycle.state === "ready") {
      const desired = sandboxPolicySnapshot(config, allowances, ctx.cwd);
      if (
        sandboxRuntimeCwd !== ctx.cwd ||
        sandboxLifecycle.policy.fingerprint !== desired.fingerprint
      ) {
        const refreshed = await refreshSandbox(ctx.cwd, expectedGeneration);
        if (
          sessionGeneration !== expectedGeneration ||
          (ownership !== undefined && !ownsSessionStart(ownership))
        ) {
          return false;
        }
        if (refreshed) updateStatus(ctx, "enabled");
        else updateStatus(ctx, "unavailable");
        return refreshed;
      }
      if (ownership !== undefined) {
        sandboxRuntimeOwnerGeneration = expectedGeneration;
        sandboxLifecycle = {
          state: "ready",
          generation: expectedGeneration,
          policy: sandboxLifecycle.policy,
        };
      }
      ctx.ui.notify("Sandbox is already enabled", "info");
      updateStatus(ctx, "enabled");
      return false;
    }

    // A concurrent command/recovery owns the transition. Session replacement
    // is allowed to queue behind it; the manager transition below serializes
    // the actual global reset/initialize calls.
    if (
      (sandboxLifecycle.state === "initializing" || sandboxLifecycle.state === "shutting-down") &&
      ownership === undefined
    ) {
      return false;
    }

    const previousState = sandboxLifecycle.state;
    const desired = sandboxPolicySnapshot(config, allowances, ctx.cwd);
    const needsReset =
      previousState === "initializing" ||
      previousState === "shutting-down" ||
      previousState === "shutdown" ||
      previousState === "unavailable" ||
      sandboxRuntimeOwnerGeneration !== null;
    sandboxLifecycle = { state: "initializing", generation: expectedGeneration, desired };
    if (ownership === undefined) updateStatus(ctx, "pending");

    return withSandboxManagerTransition(async () => {
      if (
        sessionGeneration !== expectedGeneration ||
        (ownership !== undefined && !ownsSessionStart(ownership))
      ) {
        return false;
      }
      try {
        // Recovery starts with a reset even when the failed initialization did
        // not establish an owned runtime, preventing a partially initialized
        // manager from being mistaken for a ready one.
        if (needsReset) {
          await SandboxManager.reset();
          if (sessionGeneration !== expectedGeneration) return false;
        }
        await initializeSandbox(desired.config, desired.allowances, desired.cwd);
        if (
          sessionGeneration !== expectedGeneration ||
          (ownership !== undefined && !ownsSessionStart(ownership))
        ) {
          // The manager operation remains serialized. A replacement lifecycle
          // will reset this unowned result before it can execute anything.
          return false;
        }
        if (setProxyEnvironment && supportsNodeEnvProxy(process.versions.node)) {
          process.env.NODE_USE_ENV_PROXY ??= "1";
        }
        sandboxRuntimeCwd = desired.cwd;
        sandboxRuntimeOwnerGeneration = expectedGeneration;
        sandboxLifecycle = { state: "ready", generation: expectedGeneration, policy: desired };
        warnIfAllDomainsAllowed(ctx, config);
        updateStatus(ctx, "enabled");
        return true;
      } catch (error) {
        if (
          sessionGeneration !== expectedGeneration ||
          (ownership !== undefined && !ownsSessionStart(ownership))
        ) {
          return false;
        }
        sandboxRuntimeCwd = null;
        sandboxRuntimeOwnerGeneration = null;
        sandboxLifecycle = { state: "unavailable", generation: expectedGeneration, desired };
        updateStatus(ctx, "unavailable");
        ctx.ui.notify(
          `Sandbox initialization failed; execution remains blocked: ${error instanceof Error ? error.message : error}`,
          "error",
        );
        return false;
      }
    });
  }

  async function disableSandbox(ctx: SandboxContext): Promise<boolean> {
    const shutdownGeneration = sessionGeneration;
    const wasRequested =
      sandboxRequested() ||
      sandboxLifecycle.state === "shutting-down" ||
      sandboxLifecycle.state === "shutdown" ||
      sandboxRuntimeOwnerGeneration !== null;
    sessionGeneration += 1;
    sandboxLifecycle = { state: "shutting-down", generation: shutdownGeneration };
    if (wasRequested) updateStatus(ctx, "pending");
    if (!wasRequested) {
      sandboxLifecycle = { state: "disabled" };
      updateStatus(ctx, "disabled");
      ctx.ui.notify("Sandbox is already disabled", "info");
      return false;
    }

    await withSandboxManagerTransition(async () => {
      try {
        // Reset even when initialize did not finish: a queued late start may
        // have created a manager runtime without ever acquiring ownership.
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors.
      }
    });
    if (sessionGeneration !== shutdownGeneration + 1) return false;
    sandboxRuntimeCwd = null;
    sandboxRuntimeOwnerGeneration = null;
    sandboxLifecycle = { state: "disabled" };
    updateStatus(ctx, "disabled");
    return true;
  }

  async function disableForSessionStart(ctx: SandboxContext, notice: string): Promise<boolean> {
    const expectedGeneration = sessionGeneration;
    const needsReset =
      sandboxLifecycle.state !== "disabled" && sandboxLifecycle.state !== "unsupported";
    if (!needsReset && sandboxRuntimeOwnerGeneration === null) {
      sandboxLifecycle = { state: "disabled" };
      updateStatus(ctx, "disabled");
      ctx.ui.notify(notice, "info");
      return true;
    }

    sandboxLifecycle = { state: "shutting-down", generation: expectedGeneration - 1 };
    await withSandboxManagerTransition(async () => {
      try {
        await SandboxManager.reset();
      } catch {
        // A replacement session still starts fail-closed and may retry reset
        // during recovery; cleanup errors are not user-executable fallbacks.
      }
    });
    if (sessionGeneration !== expectedGeneration) return false;
    sandboxRuntimeCwd = null;
    sandboxRuntimeOwnerGeneration = null;
    sandboxLifecycle = { state: "disabled" };
    updateStatus(ctx, "disabled");
    ctx.ui.notify(notice, "info");
    return true;
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

      if (sandboxExecutionBlocked()) {
        throw new Error("Sandbox is not ready; command execution remains blocked.");
      }
      if (!sandboxRequested() || !sandboxReady()) {
        return localBash.execute(id, params, signal, onUpdate, ctx);
      }
      const expectedGeneration = sessionGeneration;
      if (sandboxRuntimeCwd !== ctx.cwd) {
        const refreshed = await refreshSandbox(ctx.cwd, expectedGeneration);
        if (!refreshed || sessionGeneration !== expectedGeneration || sandboxExecutionBlocked()) {
          throw new Error("Sandbox is not ready; command execution remains blocked.");
        }
      }

      let diagnosticDetails: DiagnosticResultDetails | undefined;
      const sandboxedBash = createBashToolDefinition(localCwd, {
        operations: createDiagnosticOperations(
          ctx,
          "bash",
          userShellPath,
          false,
          (details) => {
            diagnosticDetails = details;
          },
          undefined,
          expectedGeneration,
        ),
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
    if (sandboxExecutionBlocked()) return sandboxExecutionBlockedResult();
    if (!sandboxRequested() || !sandboxReady()) return;
    const expectedGeneration = sessionGeneration;
    if (sandboxRuntimeCwd !== ctx.cwd) {
      const refreshed = await refreshSandbox(ctx.cwd, expectedGeneration);
      if (!refreshed || sessionGeneration !== expectedGeneration || sandboxExecutionBlocked()) {
        return sandboxExecutionBlockedResult();
      }
    }

    const config = readConfig(ctx.cwd);
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
        expectedGeneration,
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
    if (sandboxExecutionBlocked()) {
      return { block: true, reason: "Sandbox is not ready; command execution remains blocked." };
    }
    if (!sandboxRequested()) return;
    const config = readConfig(ctx.cwd);
    if (!config.enabled) return;
    const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

    if (sandboxReady() && isToolCallEventType("bash", event)) {
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
          if (!(await applyChoice(choice.action, "domain", choice.value, ctx.cwd))) {
            return {
              block: true,
              reason: "Sandbox is not ready; command execution remains blocked.",
            };
          }
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
        if (!(await applyChoice(choice.action, "read", choice.value, ctx.cwd))) {
          return {
            block: true,
            reason: "Sandbox is not ready; command execution remains blocked.",
          };
        }
        return;
      }
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const inputPath = (event.input as { path: string }).path;
      const path = canonicalizePath(inputPath, ctx.cwd);
      if (isMandatoryWritePath(inputPath, ctx.cwd)) {
        return {
          block: true,
          reason: `Sandbox: write access denied for "${path}" (mandatory protection; cannot be granted).`,
        };
      }
      const writePermission = await resolveWritePermission({
        path,
        allowWrite: effectiveWritePaths(ctx.cwd),
        denyWrite: config.filesystem?.denyWrite ?? [],
        mandatoryDenyWrite: getMandatoryWriteDenyPaths(ctx.cwd),
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
      if (writePermission.action === "blocked") {
        return {
          block: true,
          reason: "Sandbox is not ready; command execution remains blocked.",
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
    // Pi contexts expose lifecycle-guarded getters. Probe the values before
    // claiming ownership so a context invalidated by replacement/reload is a
    // no-op, while a still-valid context may legitimately be reused.
    try {
      void ctx.cwd;
      void ctx.ui;
    } catch {
      return;
    }
    currentSessionContext = ctx;
    const ownership = { generation: ++sessionGeneration, context: ctx };

    // Incident history is scoped to the replacement session. Session allowances
    // remain with the active runtime until session_shutdown tears it down.
    resetIncidentHistory();
    updateStatus(ctx, "pending");

    if (pi.getFlag("no-sandbox") as boolean) {
      await disableForSessionStart(ctx, "Sandbox disabled via --no-sandbox");
      return;
    }
    if (!readConfig(ctx.cwd).enabled) {
      await disableForSessionStart(ctx, "Sandbox disabled via config");
      return;
    }
    await enableSandbox(ctx, true, ownership, true);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (currentSessionContext && currentSessionContext !== ctx) return;
    const shutdownGeneration = sessionGeneration;
    const wasRequested =
      sandboxRequested() ||
      sandboxLifecycle.state === "shutting-down" ||
      sandboxLifecycle.state === "shutdown" ||
      sandboxRuntimeOwnerGeneration !== null;
    sessionGeneration += 1;
    currentSessionContext = undefined;
    sandboxLifecycle = { state: "shutting-down", generation: shutdownGeneration };

    if (wasRequested) {
      // Keep this reset in the manager transition queue. Do not await it here:
      // an initial initialize may still be pending, and shutdown must invalidate
      // that start immediately rather than deadlock behind it. A replacement
      // session queues after this cleanup boundary.
      void withSandboxManagerTransition(async () => {
        try {
          await SandboxManager.reset();
        } catch {
          // Ignore cleanup errors.
        }
      });
    }
    sandboxRuntimeCwd = null;
    sandboxRuntimeOwnerGeneration = null;
    sandboxLifecycle = { state: "shutdown" };
    resetSessionMemory();
    if (ctx) updateStatus(ctx, "shutdown");
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
      ctx.ui.notify(formatSandboxDebug(sandboxIncidents, { enabled: sandboxRequested() }), "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show effective sandbox configuration",
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        ctx.ui.notify("Usage: /sandbox", "error");
        return;
      }

      ctx.ui.notify(
        formatSandboxConfiguration(
          readConfig(ctx.cwd),
          getConfigPaths(ctx.cwd),
          allowances,
          resolveDerivedFilesystemAllowances(ctx.cwd).linkedGitMetadataWrite,
        ),
        "info",
      );
    },
  });

  pi.registerCommand("sandbox-allow", {
    description: "Approve a sandbox domain, read, or write target",
    handler: async (args, ctx) => {
      let command;
      try {
        command = parseSandboxAllowCommand(args, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : formatSandboxAllowUsage(), "error");
        return;
      }

      const config = readConfig(ctx.cwd);
      const choice =
        command.kind === "domain"
          ? await promptDomainBlock(pi, ctx, command.value, config.permissionPromptTimeoutSeconds)
          : command.kind === "read"
            ? await promptReadBlock(pi, ctx, command.value, config.permissionPromptTimeoutSeconds)
            : await promptWriteBlock(pi, ctx, command.value, config.permissionPromptTimeoutSeconds);
      if (choice.action === "abort") {
        ctx.ui.notify("Permission request aborted; no rule was added.", "info");
        return;
      }

      try {
        const refreshed = await applyChoice(choice.action, command.kind, choice.value, ctx.cwd);
        if (!refreshed) {
          const message =
            choice.action === "session"
              ? "Session permission was rolled back because the sandbox could not refresh; execution remains blocked."
              : "Permission was persisted, but the sandbox could not refresh; execution remains blocked.";
          ctx.ui.notify(message, "error");
          return;
        }
        ctx.ui.notify(
          `Approved ${command.kind} target: ${choice.value} (${choice.action})`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Permission was not applied: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
