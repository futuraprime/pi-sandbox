import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@carderne/sandbox-runtime";
import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

import { type SandboxConfig } from "./config.ts";
import { canonicalizePathPattern, decideDomainPolicy } from "./policy.ts";
import { getProtectedSandboxConfigPaths } from "./sandbox-command.ts";
import { getEffectiveFilesystemPolicy } from "./sandbox-filesystem.ts";

export interface SessionAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

export interface EffectiveAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const canonicalizeFilesystemPattern = (path: string, cwd: string) =>
  canonicalizePathPattern(path, cwd);

const canonicalizeFilesystemPatterns = (paths: string[], cwd = process.cwd()) =>
  unique(paths.map((path) => canonicalizeFilesystemPattern(path, cwd)));

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

  return {
    domains: unique([...(config.network?.allowedDomains ?? []), ...(allowances?.domains ?? [])]),
    // Preserve the existing runtime/direct-tool contract that write
    // allowances also expand reads, while keeping linked metadata derived.
    readPaths: unique([...filesystem.allowRead, ...writePaths]),
    writePaths,
  };
}

export function createNetworkAskCallback(
  allowedDomains: string[],
  deniedDomains: string[] = [],
): SandboxAskCallback {
  return async ({ host }) => decideDomainPolicy(host, allowedDomains, deniedDomains) === "allow";
}

export function buildRuntimeConfig(
  config: SandboxConfig,
  allowances?: SessionAllowances,
  platform: NodeJS.Platform = process.platform,
  cwd = process.cwd(),
): SandboxRuntimeConfig {
  const effective = resolveAllowances(config, allowances, cwd);
  const protectedConfigPaths = getProtectedSandboxConfigPaths(cwd);
  return {
    network: {
      ...config.network,
      // Runtime 0.0.70 evaluates deny rules before allow rules. Route every
      // request through the shared callback so specificity is applied once.
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: false,
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
      const wrappedCommand = await SandboxManager.wrapWithSandbox(
        `${sshProxyCommand}${command}`,
        shell,
      );

      const child = spawn(shell, [...args, wrappedCommand], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const killProcessGroup = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killProcessGroup();
        }, timeout * 1000);
      }

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      signal?.addEventListener("abort", killProcessGroup, { once: true });

      try {
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", killProcessGroup);
        SandboxManager.cleanupAfterCommand();
      }
    },
  };
}
