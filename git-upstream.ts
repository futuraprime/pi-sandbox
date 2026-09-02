import { spawn } from "node:child_process";
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

const REDIRECTING_GIT_ENVIRONMENT = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
]);

function isRefInput(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isValidCwd(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value)
  );
}

export function validateGitUpstreamInput(input: unknown): asserts input is GitUpstreamInput {
  if (typeof input !== "object" || input === null) {
    throw new GitUpstreamError("Invalid Git upstream input.");
  }

  const candidate = input as Partial<GitUpstreamInput>;
  const allowedKeys = new Set(["cwd", "localBranch", "remote", "remoteBranch"]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    throw new GitUpstreamError("Invalid Git upstream input.");
  }
  if (!isValidCwd(candidate.cwd)) {
    throw new GitUpstreamError("Invalid repository working directory.");
  }
  if (!isRefInput(candidate.localBranch)) {
    throw new GitUpstreamError("Invalid local branch name.");
  }
  if (candidate.remote !== "origin") {
    throw new GitUpstreamError('Invalid remote: only the existing "origin" remote is permitted.');
  }
  if (!isRefInput(candidate.remoteBranch)) {
    throw new GitUpstreamError("Invalid remote branch name.");
  }
}

async function validateGitRef(
  cwd: string,
  branch: string,
  label: "local" | "remote",
  runGit: GitCommandRunner,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runGit(
    {
      cwd,
      args: ["-c", "alias.check-ref-format=", "check-ref-format", "--branch", branch],
    },
    signal,
  );
  if (result.exitCode !== 0) {
    throw new GitUpstreamError(`Invalid ${label} branch name.`);
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (REDIRECTING_GIT_ENVIRONMENT.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) {
      delete environment[key];
    }
  }
  return environment;
}

export function runGitCommand(
  command: GitCommand,
  signal?: AbortSignal,
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    let child;
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

    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      child.kill("SIGTERM");
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new GitUpstreamError(`Unable to run Git: ${error.message}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });
}

export async function setGitUpstream(
  input: GitUpstreamInput,
  runGit: GitCommandRunner = runGitCommand,
  signal?: AbortSignal,
): Promise<void> {
  validateGitUpstreamInput(input);
  await validateGitRef(input.cwd, input.localBranch, "local", runGit, signal);
  await validateGitRef(input.cwd, input.remoteBranch, "remote", runGit, signal);

  const remoteCommand: GitCommand = {
    cwd: input.cwd,
    args: ["-c", "alias.remote=", "remote"],
  };
  const remoteResult = await runGit(remoteCommand, signal);
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
  if (branchResult.exitCode !== 0) {
    throw new GitUpstreamError(
      `Git could not set the upstream for local branch "${input.localBranch}" to "${upstream}".`,
    );
  }
}
