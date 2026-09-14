import { resolveLinkedGitWorktree } from "./git-worktree.ts";

/** Keep derived access separate from configured and session-approved access. */
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

/** The filesystem paths used by runtime and direct-tool policy checks. */
export interface EffectiveFilesystemPolicy extends FilesystemAllowanceCategories {
  allowRead: string[];
  allowWrite: string[];
}

function dedup(paths: string[]): string[] {
  return [...new Set(paths)];
}

/**
 * Resolve only the validated common Git directory for the active cwd. This is
 * recalculated on every call and is never persisted as a user allowance.
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
 * Compose filesystem allowances without mutating configuration or session
 * state. Derived linked-worktree access is intentionally limited to the
 * validated common Git directory.
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
