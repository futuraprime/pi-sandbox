# Proposal: Integrate upstream 0.6.6 without losing downstream policy

- **Status:** Proposed
- **Date:** 2026-09-03

## Context

After fast-forwarding the local branch to `origin/main`, the fork and `upstream/main` have diverged substantially since their current merge base, upstream version commit `4c994c9`:

- the fork is 34 commits ahead of the merge base;
- upstream is 31 commits ahead;
- the fork identifies as version 0.4.4;
- upstream is version 0.6.6; and
- a trial merge reports conflicts in the extension entry point, documentation, package metadata, lockfiles, TypeScript configuration, and CI workflow.

Several upstream changes independently implement features that originally motivated the fork, particularly composed global and project configuration and commands for adding allowed paths. Their intent overlaps with the fork, but their policy and persistence semantics differ.

A mechanical merge would risk replacing deliberate downstream security behaviour while also making it difficult to adopt upstream's runtime fixes and modular `src/` architecture. Integration should therefore be treated as a migration. First refactor the working downstream implementation into module boundaries aligned with upstream while preserving behaviour and dependencies; then integrate upstream changes module by module.

## Goals

- Adopt worthwhile upstream runtime fixes, API compatibility changes, tests, and maintainability improvements.
- Preserve the fork's cumulative configuration and explicit permission-precedence model.
- Preserve sandbox diagnostics, protected configuration mutation, Git/SSH preflight, and downstream status behaviour.
- Remove duplicated implementations once their intended semantics have been reconciled.
- Keep project configuration portable between checkouts and machines.
- Leave a structure in which future upstream releases can be integrated without reopening unrelated downstream modules.

## Module boundaries and ownership

Use upstream's broad module boundaries, but do not treat every resulting file as wholly upstream-owned. Record ownership and intentional divergence at the level of behaviour and integration seams.

The expected split is:

- **upstream-aligned core:** configuration loading and validation, the runtime wrapper, base prompt UI, and extension lifecycle orchestration;
- **downstream-owned behaviour:** cumulative configuration semantics, specificity-aware policy, project-relative persistence, sandbox diagnostics, protected configuration mutation, Git/SSH preflight and fallback, secure Git upstream mutation, scoped Chromium policy, and downstream status presentation; and
- **shared integration seams:** effective-policy resolution, permission-prompt results, sanctioned configuration persistence, runtime diagnostic events, and command preflight hooks.

Keep these seams narrow, typed, and covered by contract tests. Prefer separate downstream modules over embedding downstream behaviour throughout upstream-aligned code. When a module necessarily contains both, identify the intentional behavioural differences in tests rather than relying on comments tied to one upstream commit.

## Configuration composition

Retain the fork's composition order:

```text
defaults → global configuration → project configuration
```

Configured policy arrays must concatenate and deduplicate across all three layers. In particular, project configuration must not silently discard global or default restrictions.

This intentionally differs from upstream `cfffa17`, where defaults are used only when neither global nor project configuration supplies the array. Under the upstream implementation, configuring `filesystem.allowWrite` globally replaces the default `"."` and `"/tmp"` entries. An explicit configured empty array can also remove defaults. The fork instead treats configuration layers as cumulative policy.

Retain cumulative handling for:

- `network.allowedDomains`;
- `network.deniedDomains`;
- `network.allowUnixSockets`;
- `network.allowMachLookup` where supported by the current runtime;
- `filesystem.allowRead`;
- `filesystem.denyRead`;
- `filesystem.allowWrite`;
- `filesystem.denyWrite`; and
- each entry in `ignoreViolations`.

Scalars continue to use ordinary most-local-wins precedence.

Adopt upstream's stronger input validation and focused configuration tests. Malformed configuration values must be ignored with a useful warning rather than spread as iterable values, cause an exception, or silently corrupt the effective policy.

An explicit mechanism for clearing inherited arrays is out of scope until there is a concrete use case. An empty array alone must not weaken inherited restrictions.

## Permission precedence

Retain the fork's common specificity-aware policy for paths and domains:

- a matching deny wins when allow and deny rules have equal specificity;
- a strictly more-specific allow may override a broader deny;
- unmatched targets remain promptable where the operation supports prompting; and
- relative paths are resolved before specificity is calculated.

Apply this policy consistently in direct tool preflight, Bash diagnostics, network checks, and runtime configuration. Do not replace it with upstream's mixed behaviour, where writes treat every matching deny as absolute while read and domain preflight primarily inspect allow lists and leave part of the reconciliation to the runtime.

Hard-denied operations must remain unprompted unless the user deliberately changes policy through a sanctioned configuration command.

## Project-relative paths

Retain project-relative filesystem rules in project configuration. Values such as `"."`, `"../shared"`, and `".pi/cache"` should not be rewritten to machine-specific absolute paths merely because they were added through a command or prompt.

Use scope-aware handling:

- **project rules:** preserve a project-relative representation;
- **global rules:** canonicalise to an absolute path;
- **session rules:** canonicalise to an absolute path; and
- **matching and duplicate detection:** canonicalise transiently without necessarily changing the stored representation.

Canonicalisation should expand `~`, resolve `.` and `..`, and resolve existing symlink components for comparison. It must not make project configuration unnecessarily dependent on one checkout location.

## Configuration commands

Retain the fork's sanctioned `/sandbox` project-policy editor and its support for all six rule types:

```text
/sandbox allowRead <path>
/sandbox denyRead <path>
/sandbox allowWrite <path>
/sandbox denyWrite <path>
/sandbox allowedDomains <domain>
/sandbox deniedDomains <domain>
```

The command must continue to preserve unrelated configuration, avoid duplicate rules, reinitialise the active sandbox, and bypass the prohibition on direct agent edits only through its explicit user-command path.

Do not replace this with upstream's positive-only `/sandbox-allow` command. The useful parts of upstream `28124dd` and later prompt work should instead be adapted:

- validate rule syntax and ensure an edited rule matches the operation being approved;
- use canonical comparison to detect equivalent path spellings;
- retain session, project, and global choices for interactive grants; and
- preserve project-relative storage for project choices.

Whether to retain `/sandbox-allow` as an interactive convenience command or fold that workflow into `/sandbox` remains an open interface question. Avoid two commands with overlapping behaviour unless each has a clear purpose.

## Editable permission prompts

Adopt upstream's editable permission rules from `fcabc75`.

When an operation is blocked, the user may change the proposed rule before granting it. This permits a single-file target to be broadened deliberately to a directory or pattern, for example:

```text
/project/packages/widget/src/index.ts
→ packages/widget
```

or:

```text
api.github.com
→ *.github.com
```

The edited rule must still match the originally blocked target. Validation is a correctness check, not a security-strength check: broad rules such as `"*"` may still match and therefore require the existing explicit confirmation appropriate to persistent grants.

Where possible, a project-scoped prompt should initially present a project-relative rule. If the user selects session or global scope, convert the accepted rule to an appropriate absolute representation before storing it.

Also adopt upstream's permission-prompt timeout from `4ca354c` so unattended runs cannot wait indefinitely. A timeout must abort safely and must not create a permission rule.

## Configuration protection

Retain downstream protection for project and global sandbox configuration files:

- direct agent `write` and `edit` calls must not modify them;
- Bash commands that directly mutate them remain blocked or redirected to the sanctioned approval path;
- `/sandbox` and approved permission-prompt persistence remain trusted mutation routes; and
- protection must use the same `getAgentDir()`-aware paths as configuration loading.

Upstream's configuration writers should be routed through this policy rather than introduced as an unreviewed second mutation path.

## Current downstream baseline

The fast-forwarded `origin/main` already contains upstream Bubblewrap cleanup commit `d14e15a`; the integration must preserve its `SandboxManager.cleanupAfterCommand()` behaviour rather than reimplement it. The downstream code also already uses `getAgentDir()` consistently for global configuration paths, satisfying the behavioural goal of upstream `87777d9` even though that later upstream commit is not in the fork's ancestry.

Two additional origin changes are part of the baseline and must not be lost during migration:

- `8766244` pins a downstream fork based on sandbox-runtime 0.0.70, adds `browser-process.test.ts`, and grants only the macOS process, loopback, Darwin temporary-directory, and path-scoped Unix-socket permissions Chromium requires when `allowBrowserProcess` is enabled. It deliberately avoids broad `allowAllUnixSockets` access.
- `3c7ffb2` enables and documents `network.allowUnauthenticatedSocksProxy` for Git-over-SSH on macOS, where BSD `nc` cannot authenticate to the runtime's SOCKS5 proxy. HTTP proxy authentication, domain filtering, and separate SSH-agent approval remain in force.

These changes are downstream compatibility and security work, not substitutes for all later upstream runtime fixes. Any move from the pinned runtime fork to an upstream release must first prove that its scoped Chromium policy and macOS Git-over-SSH behaviour are retained.

## Upstream changes to integrate

The first integration set should include these outstanding upstream fixes or their equivalent behaviour:

- `3fb50d6` — correct Bash write prompting;
- `79b592b` — pass `allowPty` through to the sandbox extension;
- `53bd1d6` — avoid hanging on inherited subprocess output handles;
- `9103b38` — expose the bundled Linux seccomp helper;
- `fcabc75` — editable and validated prompt rules;
- `4ca354c` — interactive permission-prompt timeout; and
- `d6f01db` — emit attention events for sandbox prompts.

Adopt upstream's modular split into `src/config.ts`, `src/extension.ts`, `src/policy.ts`, `src/sandbox-runtime.ts`, and `src/ui.ts`, subject to porting downstream behaviour and tests rather than discarding it.

The following require separate product or security review before inclusion:

- upstream SSH proxy behaviour, because it overlaps with downstream SSH/Git preflight and diagnostics;
- `sandboxUserShell`, because bypassing the sandbox for user shell input changes the trust model;
- the `Alt+S` toggle, including discoverability and accidental-disable risk;
- package-manager and test-runner changes; and
- any changed defaults introduced by newer sandbox-runtime versions.

Version-only commits should not be cherry-picked independently of the behaviour they describe.

## Migration approach

Treat this as a staged migration between two independently evolved implementations, not as one large merge-resolution exercise. Complete each phase with passing focused tests and a reviewable intermediate commit before beginning the next phase. These checkpoints should leave usable stopping points and make regressions attributable to one class of change.

1. **Feature and test mapping:** before implementation, classify every upstream and downstream behaviour as retain, adapt, replace, defer, or reject. Map each behaviour to existing or required tests and to its intended module owner.
2. **Downstream-first modularisation:** create an integration branch in the downstream repository and mechanically split the current working implementation into module boundaries aligned with upstream. Preserve current dependencies, runtime pin, behaviour, and test runner. Do not introduce upstream semantic changes in this phase. Never push to the upstream remote.
3. **Architecture comparison:** compare each newly separated downstream module with its upstream 0.6.6 counterpart. Reconcile public types and integration seams while keeping the downstream test suite green. This produces a reviewable structural baseline before behaviour changes begin.
4. **Configuration and policy integration:** adopt upstream validation and tests while retaining cumulative composition, specificity-aware precedence, project-relative persistence, and configuration protection.
5. **Runtime fixes:** integrate upstream's subprocess, seccomp-helper, Bash-prompting, and PTY fixes in dependency order without blindly replacing the pinned downstream runtime fork. Verify that the already-integrated Bubblewrap cleanup still runs on success, failure, timeout, and abort paths.
6. **Prompt improvements:** add editable and validated rules, prompt timeout, and attention events while retaining downstream persistence semantics.
7. **Downstream integration verification:** verify that diagnostics, Git/SSH preflight and fallback handling, secure Git upstream mutation, scoped Chromium behaviour, and status presentation remain connected through the new architecture. These features should not need to be restored from scratch because downstream-first modularisation preserves them throughout.
8. **Optional features:** decide separately whether to adopt SSH proxying, `sandboxUserShell`, the toggle shortcut, package/test-runner changes, and any command consolidation.
9. Remove superseded duplicate implementations only after their replacement behaviour has focused test coverage.
10. Review README and configuration examples against the final semantics rather than resolving documentation conflicts mechanically.

Prefer adaptation over isolated cherry-picks where commits depend on upstream's refactor.

## Ongoing upstream maintenance

After this migration, maintain a local branch that exactly mirrors `upstream/main` and contains no downstream commits. Update it on each upstream release, or more frequently when upstream changes affect runtime or security behaviour.

For each update:

1. create an origin-only integration branch;
2. compare the upstream mirror with the last integrated upstream version;
3. update the behavioural ledger with a retain, adapt, replace, defer, or reject disposition for every material change;
4. integrate through the documented module seams;
5. run downstream contract tests and platform checks; and
6. merge only into the downstream repository, never into or through the upstream remote.

Automate fetching and divergence reporting where practical, but do not automate semantic conflict resolution. Git `rerere` may be used locally to reuse recurring textual conflict resolutions; every reused resolution still requires review and tests.

Integration cadence is part of the maintenance contract: do not allow multiple upstream releases to accumulate without an explicit review. Keep upstream-aligned changes separate from downstream feature work in intermediate commits so future comparisons remain intelligible.

The migration is complete only when both the current release and the update workflow are demonstrated. Before closing the work, simulate a small upstream change in an upstream-aligned module and verify that it can be integrated without modifying unrelated downstream-owned modules.

## Verification

Add or retain focused tests for:

- defaults, global, and project arrays accumulating and deduplicating;
- empty arrays not weakening inherited policy;
- per-key `ignoreViolations` composition;
- malformed and non-string configuration values;
- relative-path specificity against broader absolute deny rules;
- equal-specificity deny precedence and more-specific allow exceptions;
- project-relative persistence and global/session absolute persistence;
- canonical duplicate detection without rewriting project-relative values;
- all six `/sandbox` rule types;
- edited prompt rules matching the blocked target;
- prompt timeout aborting without persistence;
- protected config files remaining inaccessible to direct tools and Bash mutation;
- successful sandbox reinitialisation after an approved change;
- Bubblewrap cleanup on success, failure, timeout, and abort paths;
- scoped macOS Chromium policy without broad Unix-socket access;
- macOS Git-over-SSH through the unauthenticated SOCKS compatibility mode while retaining domain and SSH-agent controls; and
- all retained diagnostics and Git/SSH workflows;
- module-level contract tests for each shared integration seam; and
- a synthetic upstream update integrating without changes to unrelated downstream-owned modules.

Run formatting, linting, TypeScript checking, unit tests, and platform-specific sandbox integration tests on macOS and Linux.

## Open questions

- Should an explicit `/sandbox-allow` command remain alongside `/sandbox`, or should `/sandbox` gain an optional interactive scope selector?
- Should users be able to remove inherited rules through a separate explicit command, while keeping empty-array composition cumulative?
- Which upstream SSH proxy behaviour complements the downstream preflight and existing macOS `allowUnauthenticatedSocksProxy` flow, and which parts duplicate or weaken them?
- Has the scoped Chromium policy from the pinned downstream sandbox-runtime fork reached an acceptable upstream release, or must the fork remain pinned during this migration?
- Should `sandboxUserShell` be accepted, rejected, or exposed only through explicit per-session confirmation?
- Should the pnpm and Node test-runner migration be adopted as part of this work or handled separately?
