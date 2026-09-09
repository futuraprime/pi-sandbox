import { resolveLinkedGitWorktree } from "./git-worktree.js";

/** Allowance categories kept separate so derived access is never treated as a user approval. */
export interface FilesystemAllowanceCategories {
  configured: {
    allowRead: string[];
    allowWrite: string[];
  };
  sessionApproved: {
    allowRead: string[];
    allowWrite: string[];
  };
  derived: {
    linkedGitMetadata: string[];
  };
}

/** The filesystem paths used by the runtime and direct-tool policy checks. */
export interface EffectiveFilesystemPolicy extends FilesystemAllowanceCategories {
  allowRead: string[];
  allowWrite: string[];
}

function dedup(paths: string[]): string[] {
  return [...new Set(paths)];
}

/**
 * Resolve only the validated common Git directory for the active session cwd.
 * The result is intentionally a separate category from configured and
 * session-approved allowances and is recalculated for every policy request.
 */
export function resolveDerivedFilesystemAllowances(cwd: string): {
  linkedGitMetadata: string[];
} {
  const worktree = resolveLinkedGitWorktree(cwd);
  return {
    linkedGitMetadata: worktree === null ? [] : [worktree.commonDir],
  };
}

/**
 * Compose the effective filesystem allowances without mutating configuration
 * or session state. Relative configured/session rules retain their existing
 * semantics; only the validated linked-worktree path is derived here.
 */
export function getEffectiveFilesystemPolicy(
  cwd: string,
  configured: {
    allowRead?: string[];
    allowWrite?: string[];
  },
  sessionApproved: {
    allowRead?: string[];
    allowWrite?: string[];
  } = {},
): EffectiveFilesystemPolicy {
  const categories: FilesystemAllowanceCategories = {
    configured: {
      allowRead: [...(configured.allowRead ?? [])],
      allowWrite: [...(configured.allowWrite ?? [])],
    },
    sessionApproved: {
      allowRead: [...(sessionApproved.allowRead ?? [])],
      allowWrite: [...(sessionApproved.allowWrite ?? [])],
    },
    derived: resolveDerivedFilesystemAllowances(cwd),
  };

  return {
    ...categories,
    allowRead: dedup([
      ...categories.configured.allowRead,
      ...categories.sessionApproved.allowRead,
      ...categories.derived.linkedGitMetadata,
    ]),
    allowWrite: dedup([
      ...categories.configured.allowWrite,
      ...categories.sessionApproved.allowWrite,
      ...categories.derived.linkedGitMetadata,
    ]),
  };
}
