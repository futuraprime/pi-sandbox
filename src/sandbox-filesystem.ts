import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { resolveLinkedGitWorktree } from "./git-worktree.ts";
import { traversesProtectedProjectPiDirectory } from "./path-security.ts";
import { matchesPattern } from "./policy.ts";

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
    linkedGitMetadataRead: string[];
    linkedGitMetadataWrite: string[];
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
 * Resolve Git metadata needed by the active linked worktree. Shared metadata is
 * readable, while writes are limited to shared Git state and this worktree's
 * operational directory.
 */
export function resolveDerivedFilesystemAllowances(cwd: string): {
  linkedGitMetadataRead: string[];
  linkedGitMetadataWrite: string[];
} {
  const worktree = resolveLinkedGitWorktree(cwd);
  if (worktree === null) {
    return { linkedGitMetadataRead: [], linkedGitMetadataWrite: [] };
  }

  return {
    linkedGitMetadataRead: [worktree.commonDir],
    linkedGitMetadataWrite: [
      join(worktree.commonDir, "objects"),
      join(worktree.commonDir, "refs"),
      join(worktree.commonDir, "logs"),
      join(worktree.commonDir, "packed-refs"),
      join(worktree.commonDir, "packed-refs.lock"),
      worktree.gitDir,
    ],
  };
}

function repositoryEntryPath(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const entry = join(current, ".git");
    if (existsSync(entry)) return entry;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function nestedPath(cwd: string, ...segments: string[]): string {
  return join(cwd, "**", ...segments);
}

/**
 * Return mandatory write denies shared by direct write/edit preflight and the
 * OS sandbox. Wildcard entries cover nested project paths on runtimes that
 * support globs; concrete project and linked-worktree entries cover the
 * current repository without relying on glob support.
 */
export function getMandatoryWriteDenyPaths(cwd: string): string[] {
  const project = resolve(cwd);
  const mandatory = new Set<string>();
  const addNestedFile = (name: string) => {
    mandatory.add(join(project, name));
    mandatory.add(nestedPath(project, name));
  };
  const addNestedDirectory = (name: string) => {
    mandatory.add(join(project, name));
    mandatory.add(nestedPath(project, name));
    mandatory.add(nestedPath(project, name, "*"));
    mandatory.add(join(project, name, "**", "*"));
    mandatory.add(nestedPath(project, name, "**", "*"));
  };

  for (const directory of [".pi", ".vscode", ".idea"]) addNestedDirectory(directory);
  for (const file of [".gitmodules", ".envrc"]) addNestedFile(file);

  const addRepositoryProtection = (gitEntry: string) => {
    if (isRegularFile(gitEntry)) mandatory.add(gitEntry);
    const gitDirectory = isRegularFile(gitEntry) ? null : gitEntry;
    if (gitDirectory) {
      mandatory.add(join(gitDirectory, "config"));
      mandatory.add(join(gitDirectory, "config.worktree"));
      mandatory.add(join(gitDirectory, "hooks"));
    }
  };

  const projectGitEntry = join(project, ".git");
  // Prevent creating a new repository in the project, and protect linked
  // worktree pointer files. An ordinary .git directory remains operational.
  if (!existsSync(projectGitEntry) || isRegularFile(projectGitEntry))
    mandatory.add(projectGitEntry);
  const rootGitEntry = repositoryEntryPath(project) ?? projectGitEntry;
  addRepositoryProtection(rootGitEntry);
  mandatory.add(nestedPath(project, ".git"));
  for (const protectedGitPath of ["config", "config.worktree", "hooks"]) {
    mandatory.add(nestedPath(project, ".git", protectedGitPath));
    if (protectedGitPath === "hooks") {
      mandatory.add(nestedPath(project, ".git", "hooks", "*"));
      mandatory.add(nestedPath(project, ".git", "hooks", "**", "*"));
    }
  }

  const globalGitConfigs = [
    join(homedir(), ".gitconfig"),
    join(homedir(), ".config", "git", "config"),
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "git", "config") : "",
    process.env.GIT_CONFIG_GLOBAL ? resolve(project, process.env.GIT_CONFIG_GLOBAL) : "",
    process.env.GIT_CONFIG_SYSTEM ? resolve(project, process.env.GIT_CONFIG_SYSTEM) : "",
  ];
  for (const configPath of globalGitConfigs) {
    if (configPath) mandatory.add(configPath);
  }

  const worktree = resolveLinkedGitWorktree(project);
  if (worktree !== null) {
    for (const gitDirectory of [worktree.gitDir, worktree.commonDir]) {
      for (const name of ["config", "config.worktree", "hooks"]) {
        mandatory.add(join(gitDirectory, name));
      }
    }
    for (const name of ["gitdir", "commondir"]) {
      mandatory.add(join(worktree.gitDir, name));
    }
  }

  return [...mandatory];
}

export function isMandatoryWritePath(path: string, cwd = process.cwd()): boolean {
  return (
    matchesPattern(path, getMandatoryWriteDenyPaths(cwd), cwd) ||
    traversesProtectedProjectPiDirectory(path, cwd, cwd)
  );
}

/**
 * Compose filesystem allowances without mutating configuration or session
 * state. Linked-worktree metadata is derived per invocation and never stored
 * as a user allowance.
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

  const derivedWrite = categories.derived.linkedGitMetadataWrite;
  return {
    ...categories,
    allowRead: dedup([
      ...categories.configured.allowRead,
      ...categories.sessionApproved.allowRead,
      ...categories.derived.linkedGitMetadataRead,
      ...derivedWrite,
    ]),
    allowWrite: dedup([
      ...categories.configured.allowWrite,
      ...categories.sessionApproved.allowWrite,
      ...derivedWrite,
    ]),
  };
}
