# Proposal: Support linked Git worktrees

- **Status:** Proposed
- **Date:** 2026-09-09

## Context

A Git linked worktree keeps its checked-out files in one directory while storing its Git metadata under the common repository. The worktree root contains a `.git` file rather than a `.git` directory:

```text
gitdir: /path/to/repository/.git/worktrees/<worktree-id>
```

The per-worktree Git directory then contains:

- `gitdir`, which points back to the worktree's `.git` file; and
- `commondir`, which resolves to the common repository's `.git` directory.

Tools such as Orca use this standard layout. For example, an Orca workspace may be under `~/orca/workspaces/...` while its Git metadata remains under the original checkout in `/Users/Shared/.../.git`.

pi-sandbox normally allows the session working directory through a `.` filesystem rule. That rule covers the linked worktree's checked-out files but not the external per-worktree or common Git directories. Consequently, ordinary commands such as `git status` fail when Git follows the `.git` pointer across the sandbox boundary.

Manually allowing the original repository path is both inconvenient and broader than necessary. The sandbox can instead recognise a valid linked worktree and grant repository-metadata access automatically.

## Decision

Detect standard Git linked worktrees and add their validated common Git metadata directory to the effective read and write allowances for the session.

This behaviour is based on Git's metadata structure, not on Orca paths or naming conventions. It should therefore work with worktrees created by `git worktree add` and with other tools that use the standard linked-worktree representation.

The derived allowance is in-memory only. Do not write it to project or global `sandbox.json`.

## Discovery and validation

Starting at the Pi session working directory, walk towards the filesystem root and locate the nearest `.git` entry.

If `.git` is a directory, retain the existing ordinary-repository behaviour and add no derived allowance.

If `.git` is a regular file:

1. parse exactly one `gitdir: <path>` entry;
2. resolve a relative target against the directory containing `.git`;
3. canonicalise the target and require it to be a directory;
4. read the target's `gitdir` file and require it to resolve back to the exact discovered `.git` file;
5. read the target's `commondir` file and resolve it relative to the per-worktree Git directory;
6. canonicalise the common directory and require it to be a directory; and
7. require the per-worktree Git directory to be a direct child of `<common-directory>/worktrees`.

Only after all checks pass may the common Git directory be added to the effective policy.

Use direct filesystem parsing rather than invoking Git. Discovery occurs while sandbox configuration is being assembled, so launching an unsandboxed Git subprocess would create an unnecessarily broad capability.

Treat malformed, missing, oversized, or ambiguous metadata as no match. Failure to recognise a worktree must not prevent sandbox initialisation; Git commands will remain subject to the existing policy and permission flow.

## Effective filesystem policy

For a validated linked worktree, append the canonical common Git directory to both `allowRead` and `allowWrite` before initialising or reinitialising the OS sandbox.

Apply the same derived paths when evaluating direct `read`, `write`, and `edit` tool calls so filesystem policy remains consistent across tools and Bash commands.

Given:

```text
worktree:  /workspace/project/task
.git:      /repository/project/.git/worktrees/task-id
commondir: /repository/project/.git
```

the effective additions are conceptually:

```json
{
  "filesystem": {
    "allowRead": ["/repository/project/.git"],
    "allowWrite": ["/repository/project/.git"]
  }
}
```

Grant the common `.git` directory rather than attempting to enumerate individual files. Git may need shared configuration, objects, refs, packed refs, logs, locks, and current-worktree metadata, and that set varies by command and Git version.

Normal path precedence remains authoritative. A derived allowance can provide the more-specific exception needed to cross a broad deny such as `/Users`, but it must not disable a more-specific or equal explicit deny.

The allowance covers repository metadata only. It does not grant access to:

- the original checkout's working files;
- files in other linked worktrees; or
- the parent directories containing the common repository.

If Pi starts below the linked worktree root, discovery should still find and validate the worktree metadata. Access to checked-out files outside the configured filesystem allowances remains unchanged; discovery must not silently widen access to the entire working tree.

## Security considerations

A `.git` pointer supplied by the working directory must not be trusted by itself. Without validation, a workspace could point `.git` at an arbitrary protected directory and use the derived allowance to escape the filesystem policy.

The reciprocal `gitdir` check requires the external metadata to identify this exact worktree. Requiring the per-worktree directory to be under the resolved common directory's `worktrees` directory further constrains accepted layouts to Git's standard linked-worktree structure.

Validation requires bounded reads of the candidate `gitdir` and `commondir` files before the path is trusted. Do not expose their contents to the model, and impose small size limits appropriate for path files.

Once validated, sandboxed commands can read and modify all metadata in the common repository, including shared refs and objects. This is necessary for normal Git behaviour and is equivalent to the metadata access already available when Pi runs in an ordinary checkout whose `.git` directory is beneath the allowed working directory. It does not confer access to working files elsewhere.

Git hooks in the common metadata directory become readable and executable just as hooks in an ordinary in-tree `.git` directory are today. Hook processes remain subject to the same filesystem, network, and socket sandbox.

## User visibility

Show the derived linked-worktree metadata path in `/sandbox` output, separately from configured and session-approved paths, for example:

```text
Linked Git metadata: /repository/project/.git
```

This makes the automatic capability visible without implying that it was persisted to configuration.

Do not prompt for the validated metadata path. Prompting on every new Orca worktree would preserve the usability problem this proposal is intended to solve, while a permanent prompt choice would write transient worktree identifiers or overly broad repository paths into configuration.

## Scope

- Standard linked worktrees represented by a `.git` file.
- Absolute and relative `gitdir` paths.
- Sessions started at the worktree root or a descendant directory.
- Initial sandbox setup and all later reinitialisation paths.
- Consistent effective policy for Bash and direct filesystem tools.
- Visibility through `/sandbox`.

## Non-goals

- Hard-coded support for Orca directories or identifiers.
- Access to another worktree's checked-out files.
- Automatically widening working-tree access when Pi starts in a subdirectory.
- Repositories selected only through `GIT_DIR`, `GIT_WORK_TREE`, or command-line options.
- Git alternates whose object directories lie outside the validated common directory.
- Arbitrary proprietary worktree formats that do not use Git's reciprocal metadata.
- Changes to `@carderne/sandbox-runtime`.

## Implementation outline

1. Add a small, independently testable resolver that accepts a session working directory and returns a validated linked-worktree common Git directory or no result.
2. Bound metadata-file reads, canonicalise every compared path, and fail closed on malformed or incomplete structures.
3. Include the derived directory in effective read and write paths used by initialisation, reinitialisation, diagnostics, and direct-tool policy checks.
4. Display derived Git metadata allowances in `/sandbox` output without persisting them.
5. Document linked-worktree support and its repository-metadata trust boundary in the main README.

## Luna-executor delivery plan

The implementation is small enough for one long Luna session, but use **two sessions** so the security-sensitive resolver can be reviewed and stabilised before its result changes the effective sandbox policy. Implement these sessions against the upstream-style `src/` architecture described in the 0.6.6 integration proposal; do not first add the feature to the downstream monolith merely to port it later.

### Session 1: Linked-worktree resolver

**Outcome:** an isolated, fail-closed resolver that recognises standard linked worktrees without changing sandbox permissions.

Tasks:

1. Add a dedicated module, such as `src/git-worktree.ts`, with a typed result containing the canonical worktree root, per-worktree Git directory, and common Git directory.
2. Walk from the session working directory to the nearest `.git` entry and distinguish ordinary repositories from linked worktrees.
3. Implement bounded parsing and canonical validation of `.git`, reciprocal `gitdir`, and `commondir`, including the `<common-directory>/worktrees/<id>` constraint.
4. Add focused unit tests for valid absolute and relative layouts, descendant-directory discovery, malformed metadata, reciprocal-link failures, path traversal, symlinks, oversized files, and ordinary repositories.

Acceptance criteria:

- no runtime, extension, policy, UI, or configuration behaviour changes;
- malformed or suspicious layouts return no derived allowance without throwing;
- the Orca layout and a temporary worktree created by `git worktree add` resolve to the expected common directory; and
- formatting, linting, type-checking, and focused tests pass.

### Session 2: Policy integration and user visibility

**Outcome:** validated linked-worktree metadata works transparently across the sandbox while remaining visible and non-persistent.

Tasks:

1. Introduce a typed derived-allowance category distinct from configured rules and user-approved session allowances.
2. Resolve linked-worktree metadata from the active session directory and include its common Git directory in effective read and write paths used by initialisation, reinitialisation, diagnostics, and direct-tool checks.
3. Preserve specificity-aware deny precedence and ensure session replacement or reload cannot retain a previous worktree's derived path.
4. Show the derived path separately in `/sandbox` output and update the README with behaviour, scope, and security boundaries.
5. Add integration tests covering initialisation, reinitialisation, direct tools, deny precedence, lifecycle changes, non-persistence, and successful Git operations in a real linked worktree.

Acceptance criteria:

- normal Git status and mutation commands work in a validated linked worktree;
- the original checkout and other worktrees' checked-out files receive no derived access;
- `/sandbox` identifies the automatic metadata allowance without calling it a session approval;
- no sandbox configuration file is modified;
- invalid worktree metadata produces no effective allowance; and
- formatting, linting, type-checking, the complete test suite, and available macOS/Linux integration checks pass.

Do not split out documentation or final testing as a separate Luna session. If Session 2 exceeds one context window, stop after effective-policy integration and leave UI, README, and end-to-end validation as a clearly recorded continuation rather than weakening test coverage.

## Verification

Add focused tests for:

- the absolute-path layout produced by Orca;
- a normal worktree created with `git worktree add`;
- relative `gitdir` and `commondir` paths;
- discovery when the session starts below the worktree root;
- an ordinary repository with a `.git` directory;
- a `.git` pointer to an arbitrary directory;
- a missing or mismatched reciprocal `gitdir`;
- a per-worktree directory outside `<common-directory>/worktrees`;
- missing, malformed, ambiguous, and oversized metadata files;
- canonical path comparison through symlinks and `..` components;
- inclusion during initialisation and reinitialisation;
- effective direct-tool permission checks;
- explicit deny precedence; and
- `/sandbox` visibility without configuration mutation.

Run formatting, linting, TypeScript checking, and the complete test suite.
