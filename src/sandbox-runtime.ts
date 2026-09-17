import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SandboxManager,
  type CredentialsConfig,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@carderne/sandbox-runtime";
import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

import { type SandboxConfig, validateCredentials } from "./config.ts";
import { canonicalizePath, canonicalizePathPattern, decideDomainPolicy } from "./policy.ts";
import { getProtectedSandboxConfigPaths } from "./sandbox-command.ts";
import { getEffectiveFilesystemPolicy } from "./sandbox-filesystem.ts";

export interface SessionAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
  /** Session-only, path-scoped Unix-socket allowances (macOS only). */
  unixSockets: string[];
}

export interface EffectiveAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
  unixSockets: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const canonicalizeFilesystemPattern = (path: string, cwd: string) =>
  canonicalizePathPattern(path, cwd);

const canonicalizeFilesystemPatterns = (paths: string[], cwd = process.cwd()) =>
  unique(paths.map((path) => canonicalizeFilesystemPattern(path, cwd)));

const canonicalizeSocketPaths = (paths: string[], cwd = process.cwd()) =>
  unique(paths.map((path) => canonicalizePath(path, cwd)));

function canonicalizeCredentials(
  credentials: CredentialsConfig | undefined,
  cwd: string,
): CredentialsConfig | undefined {
  if (!credentials) return undefined;
  return {
    ...credentials,
    ...(credentials.files
      ? {
          files: credentials.files.map((file) => ({
            ...file,
            path: canonicalizePath(file.path, cwd),
            ...(file.injectHosts ? { injectHosts: [...file.injectHosts] } : {}),
            ...(file.maskClaims ? { maskClaims: [...file.maskClaims] } : {}),
          })),
        }
      : {}),
    ...(credentials.envVars
      ? {
          envVars: credentials.envVars.map((envVar) => ({
            ...envVar,
            ...(envVar.injectHosts ? { injectHosts: [...envVar.injectHosts] } : {}),
            ...(envVar.maskClaims ? { maskClaims: [...envVar.maskClaims] } : {}),
          })),
        }
      : {}),
  };
}

function sandboxRuntimeReadPaths(platform: NodeJS.Platform): string[] {
  if (platform !== "linux") return [];

  // apply-seccomp executes inside the Bubblewrap namespace, so broad rules
  // such as denyRead: ["/home"] must not hide the runtime's bundled helper.
  const runtimeEntryUrl = import.meta.resolve("@carderne/sandbox-runtime");
  return [fileURLToPath(new URL("../vendor/seccomp", runtimeEntryUrl))];
}

export function resolveAllowances(
  config: SandboxConfig,
  allowances?: SessionAllowances,
  cwd = process.cwd(),
): EffectiveAllowances {
  const filesystem = getEffectiveFilesystemPolicy(cwd, config.filesystem ?? {}, {
    allowRead: allowances?.readPaths,
    allowWrite: allowances?.writePaths,
  });
  const writePaths = unique(filesystem.allowWrite);
  const sessionSockets = allowances?.unixSockets ?? [];

  return {
    domains: unique([...(config.network?.allowedDomains ?? []), ...(allowances?.domains ?? [])]),
    // Preserve the existing runtime/direct-tool contract that write
    // allowances also expand reads, while keeping linked metadata derived.
    readPaths: unique([...filesystem.allowRead, ...writePaths]),
    writePaths,
    unixSockets: canonicalizeSocketPaths(
      [...(config.network?.allowUnixSockets ?? []), ...sessionSockets],
      cwd,
    ),
  };
}

export function createNetworkAskCallback(
  allowedDomains: string[],
  deniedDomains: string[] = [],
): SandboxAskCallback {
  return async ({ host }) => decideDomainPolicy(host, allowedDomains, deniedDomains) === "allow";
}

function getDarwinUserTempDir(): string | undefined {
  try {
    const tempDir = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf8",
    }).trim();
    return tempDir ? realpathSync(tempDir) : undefined;
  } catch {
    return undefined;
  }
}

function findShellQuotedTokenEnd(command: string, start: number): number {
  for (let index = start + 1; index < command.length; index += 1) {
    if (command.startsWith(`'"'"'`, index)) {
      index += 4;
    } else if (command[index] === "'") {
      return index;
    }
  }
  return -1;
}

function isStockBrowserProfile(profile: string): boolean {
  return (
    profile.startsWith("(version 1)\n(deny default ") &&
    profile.includes("\n; Network\n") &&
    profile.includes("\n; Browser process support (Chrome/Chromium)\n") &&
    profile.includes("\n(allow mach*)\n")
  );
}

function shellQuoteInlineFragment(fragment: string): string {
  return fragment.replaceAll("'", "'\"'\"'");
}

/**
 * Add the four downstream Chromium grants missing from stock sandbox-runtime.
 * The runtime owns profile generation; this only augments its generated macOS
 * profile and is therefore shipped with the consumer rather than a workspace
 * package-manager patch.
 */
export function augmentMacosBrowserProfile(
  wrappedCommand: string,
  allowBrowserProcess: boolean,
): string {
  if (process.platform !== "darwin" || !allowBrowserProcess) return wrappedCommand;

  const browserTempDir = getDarwinUserTempDir();
  if (!browserTempDir) return wrappedCommand;

  const profilePrefix = "/usr/bin/sandbox-exec -p '";
  const profilePrefixIndex = wrappedCommand.indexOf(profilePrefix);
  if (profilePrefixIndex === -1) return wrappedCommand;

  const profileStart = profilePrefixIndex + profilePrefix.length - 1;
  const profileEnd = findShellQuotedTokenEnd(wrappedCommand, profileStart);
  if (profileEnd === -1) return wrappedCommand;

  const profile = wrappedCommand.slice(profileStart + 1, profileEnd);
  const marker = "; pi-sandbox scoped Chromium resources";
  if (profile.includes(marker) || !isStockBrowserProfile(profile)) return wrappedCommand;

  const scopedRules = [
    marker,
    '(allow sysctl-read (sysctl-name "kern.hv_vmm_present"))',
    '(allow network-bind (local ip "*:*"))',
    '(allow network-inbound (local ip "*:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    "(allow system-socket (socket-domain AF_UNIX))",
    `(allow network-bind (local unix-socket (subpath ${JSON.stringify(browserTempDir)})))`,
    `(allow network-outbound (remote unix-socket (subpath ${JSON.stringify(browserTempDir)})))`,
    `(allow file-read* file-write* (subpath ${JSON.stringify(browserTempDir)}))`,
  ].join("\n");

  // The profile is already inside a shell single-quoted argument. Encode any
  // apostrophe from the system-provided temp path without changing the shell
  // quoting of the wrapped command or the generated profile.
  return `${wrappedCommand.slice(0, profileEnd)}\n${shellQuoteInlineFragment(scopedRules)}${wrappedCommand.slice(profileEnd)}`;
}

export function buildRuntimeConfig(
  config: SandboxConfig,
  allowances?: SessionAllowances,
  platform: NodeJS.Platform = process.platform,
  cwd = process.cwd(),
): SandboxRuntimeConfig {
  const effective = resolveAllowances(config, allowances, cwd);
  const protectedConfigPaths = getProtectedSandboxConfigPaths(cwd);
  const credentials = canonicalizeCredentials(validateCredentials(config.credentials), cwd);
  return {
    network: {
      ...config.network,
      // Runtime 0.0.70 evaluates deny rules before allow rules. Route every
      // request through the shared callback so specificity is applied once.
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: false,
      allowUnixSockets: effective.unixSockets,
    },
    filesystem: {
      disabled: config.filesystem?.disabled,
      denyRead: canonicalizeFilesystemPatterns(config.filesystem?.denyRead ?? [], cwd),
      allowRead: canonicalizeFilesystemPatterns(
        [...effective.readPaths, ...sandboxRuntimeReadPaths(platform)],
        cwd,
      ),
      allowWrite: canonicalizeFilesystemPatterns(effective.writePaths, cwd),
      denyWrite: canonicalizeFilesystemPatterns(
        [
          ...(config.filesystem?.denyWrite ?? []),
          protectedConfigPaths.projectPath,
          protectedConfigPaths.globalPath,
        ],
        cwd,
      ),
    },
    credentials,
    ignoreViolations: config.ignoreViolations,
    enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
    allowBrowserProcess: config.allowBrowserProcess,
    allowPty: config.allowPty,
    enableWeakerNetworkIsolation: true,
  };
}

export async function initializeSandbox(
  config: SandboxConfig,
  allowances?: SessionAllowances,
  cwd = process.cwd(),
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(config, allowances, process.platform, cwd);
  const effective = resolveAllowances(config, allowances, cwd);
  await SandboxManager.initialize(
    runtimeConfig,
    createNetworkAskCallback(effective.domains, config.network?.deniedDomains ?? []),
  );
}

export async function reinitializeSandbox(
  config: SandboxConfig,
  allowances: SessionAllowances,
  cwd = process.cwd(),
): Promise<void> {
  await SandboxManager.reset();
  await initializeSandbox(config, allowances, cwd);
}

export function supportsNodeEnvProxy(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 21) || major >= 24;
}

export function extractBlockedWritePath(output: string): string | null {
  const match = output.match(
    /(?:\/bin\/bash|bash|sh): (?:line \d: )?(\/[^\s:]+): Operation not permitted/,
  );
  return match ? match[1] : null;
}

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to exit without hanging on inherited stdio handles.
 *
 * After exit, keep reading while output is active. If a detached descendant
 * holds the pipes open but leaves them idle, release them after a short grace.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };

    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

export function createSandboxedBashOps(shellPath?: string, sshProxy = true): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

      const { shell, args } = getShellConfig(shellPath);

      // OpenSSH does not honor ALL_PROXY, unlike most of the tools that use
      // the sandbox network proxy. Install a shell function so ordinary
      // `ssh host` commands use the runtime's local SOCKS proxy too. This is
      // deliberately opt-in at the config layer, but enabled by default.
      const socksProxyPort = sshProxy ? SandboxManager.getSocksProxyPort() : undefined;
      const sshProxyCommand =
        process.platform === "darwin" && socksProxyPort !== undefined
          ? `ssh() { /usr/bin/ssh -o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${socksProxyPort} %h %p' "$@"; }; `
          : "";
      const commandToWrap = `${sshProxyCommand}${command}`;
      let cleanupRequired = false;
      let child: ChildProcess | undefined;
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let executionFailed = false;
      let executionError: unknown;
      let result: { exitCode: number | null } | undefined;

      const killProcessGroup = () => {
        if (!child?.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      try {
        const wrappedCommand = augmentMacosBrowserProfile(
          await SandboxManager.wrapWithSandbox(commandToWrap, shell),
          SandboxManager.getConfig()?.allowBrowserProcess === true,
        );
        // The runtime only acquires a command-scoped cleanup resource when it
        // returns an actual wrapper. Calling cleanup for an unchanged command
        // could decrement the active count belonging to another command.
        cleanupRequired = wrappedCommand !== commandToWrap;

        child = spawn(shell, [...args, wrappedCommand], {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killProcessGroup();
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        signal?.addEventListener("abort", killProcessGroup, { once: true });

        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        result = { exitCode };
      } catch (error) {
        executionFailed = true;
        executionError = error;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (child) signal?.removeEventListener("abort", killProcessGroup);
        if (cleanupRequired) {
          try {
            SandboxManager.cleanupAfterCommand();
          } catch (cleanupError) {
            // Never replace the command's original failure with cleanup noise.
            if (!executionFailed) {
              executionFailed = true;
              executionError = cleanupError;
            }
          }
        }
      }

      if (executionFailed) throw executionError;
      return result!;
    },
  };
}
