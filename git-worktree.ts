import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The validated Git metadata associated with a linked worktree. */
export interface GitWorktreeResolution {
  /** The canonical directory containing the worktree's .git file. */
  worktreeRoot: string;
  /** The canonical external Git directory for this worktree. */
  gitDir: string;
  /** The canonical shared Git directory for the repository. */
  commonDir: string;
}

/**
 * Keep metadata reads small. Git's path files are normally only a few hundred
 * bytes long, and there is no reason to read arbitrary data while discovering
 * a worktree.
 */
const MAX_METADATA_FILE_BYTES = 4096;

function canonicalPath(path: string): string | null {
  try {
    // native preserves the platform's normal path spelling and follows all
    // symlinks, which is what is needed for path comparisons below.
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function readBoundedFile(path: string): string | null {
  let descriptor: number | undefined;
  try {
    // Metadata files are regular files in a standard worktree. Rejecting
    // symlinks here also avoids following a changed path after validation.
    if (!lstatSync(path).isFile()) return null;
    descriptor = openSync(path, "r");
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_METADATA_FILE_BYTES) return null;

    const buffer = Buffer.allocUnsafe(MAX_METADATA_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_METADATA_FILE_BYTES) return null;

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The resolver is deliberately fail-closed and non-throwing.
      }
    }
  }
}

function removeSingleLineEnding(value: string): string | null {
  let line = value;
  if (line.endsWith("\n")) {
    line = line.slice(0, -1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
  }
  if (line.includes("\r") || line.includes("\n") || line.includes("\0")) return null;
  return line;
}

function parseGitFile(value: string): string | null {
  const line = removeSingleLineEnding(value);
  if (line === null || !line.startsWith("gitdir: ")) return null;
  const target = line.slice("gitdir: ".length);
  return target.length > 0 ? target : null;
}

function parsePathFile(value: string): string | null {
  const line = removeSingleLineEnding(value);
  return line !== null && line.length > 0 ? line : null;
}

function resolvePathFrom(base: string, target: string): string | null {
  if (target.includes("\0")) return null;
  // resolve normalises dot-dot components before realpath, including when an
  // absolute target contains an alias through a path that no longer exists.
  return canonicalPath(resolve(base, target));
}

function findGitEntry(sessionCwd: string): { root: string; gitFile: string } | null {
  const canonicalCwd = canonicalPath(sessionCwd);
  if (canonicalCwd === null) return null;
  try {
    if (!lstatSync(canonicalCwd).isDirectory()) return null;
  } catch {
    return null;
  }

  let current = canonicalCwd;
  while (true) {
    const gitEntry = join(current, ".git");
    try {
      const stats = lstatSync(gitEntry);
      if (!stats.isFile()) return null;
      const gitFile = canonicalPath(gitEntry);
      return gitFile === null ? null : { root: current, gitFile };
    } catch (error) {
      // A missing .git entry means that discovery should continue upward. Any
      // other filesystem failure is indistinguishable from an unsafe layout.
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        )
      ) {
        return null;
      }
    }

    const parent = dirname(current);
    if (samePath(parent, current)) return null;
    current = parent;
  }
}

function isDirectChild(child: string, parent: string): boolean {
  return samePath(dirname(child), parent);
}

/**
 * Resolve standard linked-worktree metadata for a session directory.
 *
 * Ordinary repositories, malformed metadata, and any filesystem error return
 * null. This function never exposes metadata contents and never throws.
 */
export function resolveGitWorktree(sessionCwd: string): GitWorktreeResolution | null {
  if (typeof sessionCwd !== "string" || sessionCwd.length === 0 || !isAbsolute(sessionCwd)) {
    return null;
  }

  try {
    const entry = findGitEntry(sessionCwd);
    if (entry === null) return null;

    const pointer = readBoundedFile(entry.gitFile);
    if (pointer === null) return null;
    const perWorktreeGitDir = resolvePathFrom(entry.root, parseGitFile(pointer) ?? "\0");
    if (perWorktreeGitDir === null) return null;

    const perWorktreeGitdirFile = join(perWorktreeGitDir, "gitdir");
    const reciprocalContents = readBoundedFile(perWorktreeGitdirFile);
    if (reciprocalContents === null) return null;
    const reciprocalTarget = parsePathFile(reciprocalContents);
    if (reciprocalTarget === null) return null;
    const reciprocalGitFile = resolvePathFrom(perWorktreeGitDir, reciprocalTarget);
    if (reciprocalGitFile === null || !samePath(reciprocalGitFile, entry.gitFile)) return null;

    const commondirContents = readBoundedFile(join(perWorktreeGitDir, "commondir"));
    if (commondirContents === null) return null;
    const commondirTarget = parsePathFile(commondirContents);
    if (commondirTarget === null) return null;
    const commonDir = resolvePathFrom(perWorktreeGitDir, commondirTarget);
    if (commonDir === null) return null;

    const worktreesDir = canonicalPath(join(commonDir, "worktrees"));
    if (worktreesDir === null || !isDirectChild(perWorktreeGitDir, worktreesDir)) return null;

    return {
      worktreeRoot: entry.root,
      gitDir: perWorktreeGitDir,
      commonDir,
    };
  } catch {
    return null;
  }
}

/** Alias emphasizing that ordinary repositories are intentionally excluded. */
export const resolveLinkedGitWorktree = resolveGitWorktree;
