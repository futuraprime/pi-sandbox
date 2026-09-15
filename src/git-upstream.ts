import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

export interface GitUpstreamInput {
  cwd: string;
  localBranch: string;
  remote: string;
  remoteBranch: string;
}

export interface GitCommand {
  cwd: string;
  args: readonly string[];
}

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (
  command: GitCommand,
  signal?: AbortSignal,
) => Promise<GitCommandResult>;

export class GitUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitUpstreamError";
  }
}

/** Environment variables that can change which repository or config Git uses. */
const REDIRECTING_GIT_ENVIRONMENT = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_TEMPLATE_DIR",
  "GIT_WORK_TREE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRefInput(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const disallowed = " \\\"'`;|&$()<>!{}[]\\\\" + String.fromCharCode(0, 9, 10, 11, 12, 13);
  return ![...value].some((character) => disallowed.includes(character)) && !value.startsWith("-");
}

function isValidCwd(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\u0000") &&
    !value.includes("\r") &&
    !value.includes("\n") &&
    isAbsolute(value)
  );
}

export function validateGitUpstreamInput(input: unknown): asserts input is GitUpstreamInput {
  if (!isRecord(input)) throw new GitUpstreamError("Invalid Git upstream input.");

  const allowedKeys = new Set(["cwd", "localBranch", "remote", "remoteBranch"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new GitUpstreamError("Invalid Git upstream input.");
  }

  if (!isValidCwd(input.cwd)) {
    throw new GitUpstreamError("Invalid repository working directory.");
  }
  if (!isRefInput(input.localBranch)) {
    throw new GitUpstreamError("Invalid local branch name.");
  }
  if (input.remote !== "origin") {
    throw new GitUpstreamError('Invalid remote: only the existing "origin" remote is permitted.');
  }
  if (!isRefInput(input.remoteBranch)) {
    throw new GitUpstreamError("Invalid remote branch name.");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GitUpstreamError("Git upstream operation aborted.");
}

async function validateGitRef(
  cwd: string,
  branch: string,
  label: "local" | "remote",
  ref: string,
  runGit: GitCommandRunner,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const formatResult = await runGit(
    {
      cwd,
      args: ["-c", "alias.check-ref-format=", "check-ref-format", "--branch", branch],
    },
    signal,
  );
  throwIfAborted(signal);
  if (formatResult.exitCode !== 0) {
    throw new GitUpstreamError(`Invalid ${label} branch name.`);
  }

  // check-ref-format only checks syntax. Verify the exact ref separately so
  // this tool cannot create tracking metadata for a missing branch.
  const refResult = await runGit(
    {
      cwd,
      args: ["-c", "alias.show-ref=", "show-ref", "--verify", "--quiet", ref],
    },
    signal,
  );
  throwIfAborted(signal);
  if (refResult.exitCode !== 0) {
    throw new GitUpstreamError(`The existing ${label} branch "${branch}" could not be found.`);
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      REDIRECTING_GIT_ENVIRONMENT.has(key) ||
      key === "GIT_CONFIG_GLOBAL" ||
      key === "GIT_CONFIG_SYSTEM" ||
      key.startsWith("GIT_CONFIG_")
    ) {
      delete environment[key];
    }
  }
  return environment;
}

/**
 * Run one fixed-argv Git subprocess. This is a testable subprocess seam; the
 * setGitUpstream operation below is the only production caller and supplies
 * only its fixed, non-shell argument lists.
 */
export function runGitCommand(
  command: GitCommand,
  signal?: AbortSignal,
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GitUpstreamError("Git upstream operation aborted."));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn("git", [...command.args], {
        cwd: command.cwd,
        env: gitEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new GitUpstreamError(
          `Unable to start Git: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = () => {
      if (settled) return;
      child.kill("SIGTERM");
      // Git normally exits promptly, but cancellation must not wait forever for
      // a process that is stuck in a hook or has inherited a pipe.
      settle(() => {
        reject(new GitUpstreamError("Git upstream operation aborted."));
        killTimer = setTimeout(() => child.kill("SIGKILL"), 100);
      });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      settle(() => reject(new GitUpstreamError(`Unable to run Git: ${error.message}`)));
    });
    child.once("close", (code) => {
      settle(() => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function setGitUpstream(
  input: GitUpstreamInput,
  runGit: GitCommandRunner = runGitCommand,
  signal?: AbortSignal,
): Promise<void> {
  validateGitUpstreamInput(input);
  throwIfAborted(signal);

  await validateGitRef(
    input.cwd,
    input.localBranch,
    "local",
    `refs/heads/${input.localBranch}`,
    runGit,
    signal,
  );
  await validateGitRef(
    input.cwd,
    input.remoteBranch,
    "remote",
    `refs/remotes/origin/${input.remoteBranch}`,
    runGit,
    signal,
  );

  throwIfAborted(signal);
  const remoteResult = await runGit(
    {
      cwd: input.cwd,
      args: ["-c", "alias.remote=", "remote"],
    },
    signal,
  );
  throwIfAborted(signal);
  if (remoteResult.exitCode !== 0) {
    throw new GitUpstreamError("Unable to verify the Git repository and its remotes.");
  }

  const remotes = new Set(
    remoteResult.stdout
      .split(/\r?\n/)
      .map((remote) => remote.trim())
      .filter((remote) => remote.length > 0),
  );
  if (!remotes.has("origin")) {
    throw new GitUpstreamError('The repository does not have an existing "origin" remote.');
  }

  const upstream = `origin/${input.remoteBranch}`;
  const branchResult = await runGit(
    {
      cwd: input.cwd,
      args: [
        "-c",
        "alias.branch=",
        "branch",
        `--set-upstream-to=${upstream}`,
        "--",
        input.localBranch,
      ],
    },
    signal,
  );
  throwIfAborted(signal);
  if (branchResult.exitCode !== 0) {
    throw new GitUpstreamError(
      `Git could not set the upstream for local branch "${input.localBranch}" to "${upstream}".`,
    );
  }
}
