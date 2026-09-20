# Proposal: Integrate upstream 0.6.6 without losing downstream policy

- **Status:** In progress — slices 1–5, 6a, 6b, 6c, 6d, 7, 8, 9a, and 9b complete; exact 0.0.72 approved with a bounded consumer-side Chromium adapter, fresh network regressions, a fail-closed credential consumer boundary, and tested permission-prompt/UI/lifecycle contracts; Slice 10 parity and cleanup remains open
- **Date:** 2026-09-03
- **Slice 1 ledger:** [feature ledger and test map](../integration/upstream-0.6.6-feature-ledger.md)
- **Slice 2 checkpoint:** [upstream baseline and downstream parity checklist](../integration/upstream-0.6.6-slice-2-checklist.md)
- **Slice 6c assessment:** [sandbox-runtime 0.0.70/0.0.72 assessment](../integration/upstream-0.6.6-slice-6c-assessment.md)
- **Slice 6d acceptance:** [macOS runtime acceptance](../integration/upstream-0.6.6-slice-6d-acceptance.md)
- **Slice 9a checkpoint:** [permission-prompt/UI contracts](../integration/upstream-0.6.6-slice-9a-checkpoint.md)
- **Slice 9b checkpoint:** [lifecycle recovery](../integration/upstream-0.6.6-slice-9b-checkpoint.md)

## Context

After fast-forwarding the local branch to `origin/main`, the fork and `upstream/main` have diverged substantially since their current merge base, upstream version commit `4c994c9`:

- the fork is 34 commits ahead of the merge base;
- upstream is 31 commits ahead;
- the fork identifies as version 0.4.4;
- upstream is version 0.6.6; and
- a trial merge reports conflicts in the extension entry point, documentation, package metadata, lockfiles, TypeScript configuration, and CI workflow.

Several upstream changes independently implement features that originally motivated the fork, particularly composed global and project configuration and commands for adding allowed paths. Their intent overlaps with the fork, but their policy and persistence semantics differ.

A mechanical merge would risk replacing deliberate downstream security behaviour while also making it difficult to adopt upstream's runtime fixes and modular `src/` architecture. Integration should therefore be treated as a migration. Keep the current downstream branch intact as the behavioural reference, build an integration branch from upstream's modular implementation, and port downstream tests and behaviour onto it deliberately.

## Goals

- Adopt worthwhile upstream runtime fixes, API compatibility changes, tests, and maintainability improvements.
- Evaluate sandbox-runtime 0.0.72 as an explicit integration target and expose its credential masking only after downstream compatibility and security checks pass.
- Preserve the fork's cumulative configuration and explicit permission-precedence model.
- Preserve sandbox diagnostics, protected configuration mutation, Git/SSH preflight, and downstream status behaviour.
- Remove duplicated implementations once their intended semantics have been reconciled.
- Keep project configuration portable between checkouts and machines.
- Leave a structure in which future upstream releases can be integrated without reopening unrelated downstream modules.

macOS is the downstream deployment and acceptance target. Preserve upstream Linux behaviour where it comes for free and keep platform-neutral unit tests portable, but Linux-specific integration work is not a release blocker.

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

The fast-forwarded `origin/main` already contains upstream Bubblewrap cleanup commit `d14e15a`; retain its `SandboxManager.cleanupAfterCommand()` path rather than reimplementing it, but do not make additional Linux-specific integration validation a release blocker. The downstream code also already uses `getAgentDir()` consistently for global configuration paths, satisfying the behavioural goal of upstream `87777d9` even though that later upstream commit is not in the fork's ancestry.

Two additional origin changes are part of the baseline and must not be lost during migration:

- `8766244` pins a downstream fork based on sandbox-runtime 0.0.70, adds `browser-process.test.ts`, and grants only the macOS process, loopback, Darwin temporary-directory, and path-scoped Unix-socket permissions Chromium requires when `allowBrowserProcess` is enabled. It deliberately avoids broad `allowAllUnixSockets` access.
- `3c7ffb2` enables and documents `network.allowUnauthenticatedSocksProxy` for Git-over-SSH on macOS, where BSD `nc` cannot authenticate to the runtime's SOCKS5 proxy. HTTP proxy authentication, domain filtering, and separate SSH-agent approval remain in force.

These changes are downstream compatibility and security work, not substitutes for all later upstream runtime fixes. Any move from the pinned runtime fork to an upstream release must first prove that its scoped Chromium policy and macOS Git-over-SSH behaviour are retained.

Upstream pi-sandbox 0.6.6 declares `@carderne/sandbox-runtime: ^0.0.70` but locks version 0.0.70. Merely integrating pi-sandbox 0.6.6 therefore does not adopt the credential support present in sandbox-runtime 0.0.72. In addition, upstream pi-sandbox's `buildRuntimeConfig()` currently omits the runtime's `credentials` section. The runtime upgrade and pi-sandbox configuration plumbing must be treated as explicit integration work rather than an incidental dependency refresh.

### Credential masking target

Evaluate sandbox-runtime 0.0.72's credential controls as part of runtime reconciliation:

- `credentials.envVars` and `credentials.files` support `mode: "deny"`, which withholds the declared source from sandboxed processes;
- supported `mode: "mask"` entries expose a per-session sentinel rather than plaintext and substitute the real credential only through the runtime proxy on egress to the entry's explicit `injectHosts`;
- per-entry `injectHosts` must be explicitly narrowed for credentials rather than implicitly accepting every reachable host;
- environment-variable `decode: "jwt"` is rejected at the downstream validated config boundary, even with `onExtractNoMatch: "deny"` or `"error"`, because runtime 0.0.72 ignores that option when JWT verification or requested claims fail and leaves the inherited plaintext value in the sandbox;
- whole-value environment masks and regex extraction remain supported, while accepted structured env extraction and file extraction/decode require `onExtractNoMatch: "deny"` or `"error"`; and
- file masking is Linux-only in 0.0.72 and degrades to deny on macOS. The initial downstream scope therefore supports the safe macOS deny fallback and does not add Linux file-mask delivery.

This is a capability for proxy-mediated network authentication, not a way to reveal plaintext to a trusted script inside the sandbox. The extension must not introduce a generic secret-bearing command runner. A sandboxed script may parse or pass a sentinel, while the proxy performs host-scoped substitution without exposing the real value to the process or agent.

Add a validated, typed `credentials` section to pi-sandbox configuration and preserve it through configuration loading, composition, and `buildRuntimeConfig()`. Credential entries contain policy metadata, not secret values: real values remain in their declared host environment or protected source files. Credential configuration must not be editable through ordinary permission prompts or the existing `/sandbox` allow/deny commands in the first implementation.

## Upstream changes to integrate

The first integration set should include these outstanding upstream fixes or their equivalent behaviour:

- `3fb50d6` — correct Bash write prompting;
- `79b592b` — pass `allowPty` through to the sandbox extension;
- `53bd1d6` — avoid hanging on inherited subprocess output handles;
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

The Linux-only bundled seccomp-helper change (`9103b38`) may remain as inherited upstream behaviour, but it does not require downstream-specific integration work or acceptance coverage.

Version-only commits should not be cherry-picked independently of the behaviour they describe.

## Migration approach

Treat this as a staged migration between two independently evolved implementations, not as one large merge-resolution exercise. Complete each phase with passing focused tests and a reviewable intermediate commit before beginning the next phase. These checkpoints should leave usable stopping points and make regressions attributable to one class of change.

1. **Feature and test mapping:** before implementation, classify every upstream and downstream behaviour as retain, adapt, replace, defer, or reject. Map each behaviour to existing or required tests and to its intended module owner.
2. **Upstream architecture baseline:** create an integration branch from `upstream/main` in the downstream repository. Keep the current downstream `main` unchanged as the behavioural reference. Never reset downstream `main`, force-push it, or push to the upstream remote.
3. **Downstream test import:** bring downstream tests onto the integration branch before their implementations. Adapt test imports to the upstream module boundaries and add missing characterisation tests for cumulative composition, specificity, persistence, and other behaviour currently embedded in `index.ts`. Expected failures form the implementation checklist.
4. **Independent downstream modules:** port diagnostics, `/sandbox` commands, configuration protection, Git/SSH handling, secure Git upstream mutation, scoped Chromium policy, and status presentation through narrow integration seams.
5. **Configuration and policy integration:** replace upstream's conflicting semantics with cumulative composition, specificity-aware precedence, project-relative persistence, and protected sanctioned writes while retaining upstream validation and useful tests.
6. **Runtime reconciliation:** retain upstream's subprocess, Bash-prompting, and PTY fixes while restoring the pinned downstream runtime behaviour where upstream does not yet provide equivalent scoped Chromium and macOS Git-over-SSH support. Compare the pinned downstream runtime with sandbox-runtime 0.0.72, and upgrade only after scoped Chromium and macOS Git-over-SSH parity is demonstrated.
7. **Credential integration:** expose a validated `credentials` configuration and pass it through the runtime seam. Implement and validate host-scoped environment-variable masking on macOS, including deny semantics and the macOS deny fallback for credential files. Do not add Linux-only file-masking work to the initial scope. Require fail-closed handling for structured secret extraction and verify that diagnostics, prompts, and command output never reveal registered plaintext credentials.
8. **Prompt adaptation:** retain upstream's editable and validated rules, prompt timeout, and attention events while applying downstream scope and project-relative persistence semantics.
9. **Behavioural parity review:** compare the completed branch with downstream `main` using the feature ledger, contract tests, and platform checks. Preserve both histories when integrating the completed work into downstream `main`.
10. **Optional features:** decide separately whether to adopt SSH proxying, `sandboxUserShell`, the toggle shortcut, package/test-runner changes, and any command consolidation.
11. Remove superseded duplicate implementations only after their replacement behaviour has focused test coverage, then reconcile README and configuration examples against the final semantics rather than resolving documentation conflicts mechanically.

Prefer adaptation over isolated cherry-picks where commits depend on upstream's refactor.

## Execution slices

Plan the migration as nine expected `/execute`-sized slices, plus one conditional runtime-adaptation slice. Keep each slice independently verifiable, reviewable, and committed before beginning the next. A slice may use parallel agents for bounded work, but it must finish with one coherent outcome and a green or explicitly characterised test state.

### Slice 1: Feature ledger and test map (complete)

- Classify each material upstream and downstream behaviour as retain, adapt, replace, defer, or reject.
- Assign an intended module owner and integration seam to each behaviour.
- Record existing coverage and missing characterisation, contract, and platform tests.
- Resolve only questions that block the following slice; leave optional product decisions explicitly deferred.

**Exit condition:** the ledger accounts for the proposal's required behaviours, named upstream commits, downstream baseline commits, optional features, and verification requirements.

### Slice 2: Upstream baseline and downstream test import (complete)

- Create the integration branch from the current `upstream/main`, leaving downstream `main` unchanged.
- Establish upstream's five-module architecture and test harness as the structural baseline.
- Import downstream tests before implementations, adapting imports without weakening assertions.
- Add the highest-priority missing characterisation tests for behaviour still embedded in downstream `index.ts`.

**Exit condition:** upstream tests pass, imported downstream tests compile where their seams exist, and expected behavioural failures form an explicit implementation checklist.

**Completed:** commit `51d1bab` retains the upstream five-module baseline, adds runnable characterisation coverage and 12 explicit TODO gates, and records tests blocked on later seams. Verification passed with 37 passing tests, 12 TODOs, and no failures using `node --import tsx --test test/**/*.test.ts`; `pnpm verify` is not defined, and the equivalent `pnpm test` command could not run inside the review sandbox because the `tsx` CLI could not create its IPC socket. TypeScript checking, linting, and formatting checks passed.

### Slice 3: Configuration composition and policy precedence (complete)

- Implemented cumulative defaults, global, and project configuration composition with validation and first-occurrence deduplication.
- Restored shared specificity-aware path and domain precedence for direct preflight, network checks, and runtime policy callbacks.
- Preserved project-relative values for persistence while resolving paths transiently for matching and specificity.
- Added executable configuration and policy contract tests for composition, malformed input, specificity, relative paths, domain precedence, and command extraction.

**Exit condition:** focused configuration and policy suites pass for composition, malformed input, specificity, relative paths, and domain extraction. Canonical persistence deduplication (C-07), `/sandbox` persistence/protection (D-01/D-04), full Bash preflight (R-02), and the deferred C-13 runtime-meaning decision remain later-slice work.

### Slice 4: `/sandbox`, protected persistence, and configuration protection

- Port the six-rule `/sandbox` editor and route all sanctioned writes through one protected persistence seam.
- Block direct tool and Bash mutation of project and global sandbox configuration through `getAgentDir()`-aware paths.
- Verify canonical duplicate detection, project-relative storage, unrelated configuration preservation, and sandbox reinitialisation.
- Avoid retaining upstream and downstream configuration writers as parallel mutation paths.

**Exit condition:** command, persistence, and protection tests pass through the upstream-shaped extension integration points.

**Slice 4 verified:** the six-rule `/sandbox` command and its single persistence adapter are implemented in `src/sandbox-command.ts`. Project mutations preserve unrelated JSON and relative spellings, deduplicate canonical filesystem paths, and refresh an active runtime only after a real change. Canonical project/global config paths are protected at direct write/edit and Bash preflight seams before sandbox-disabled checks and are included in runtime `denyWrite`; `/sandbox-allow` is removed. Focused node:test command, protection, and extension reinitialisation contracts pass. Remaining Bash diagnostic/preflight and runtime-meaning TODOs stay assigned to later slices.

### Slice 5: Diagnostics, Git/worktree, and status modules

- Port sandbox diagnostics and violation presentation through the runtime diagnostic seam.
- Port secure Git upstream mutation, Git/SSH preflight, linked-worktree handling, and filesystem allowances.
- Restore downstream status presentation and the associated extension hooks.
- Preserve narrow module boundaries instead of moving these behaviours into upstream-aligned core modules.

**Exit condition:** diagnostics, Git, worktree, filesystem, and status tests pass through their integration seams.

**Slice 5 verified:** diagnostics, status, Git/worktree, SSH-agent, and stale-lifecycle work is complete through the upstream-shaped seams. The full direct Node suite now covers 112 passing tests, 4 explicit TODO gates, and no failures at the Slice 5 baseline. Runtime execution contracts are recorded separately in the Slice 6a checkpoint; no runtime version, dependency, or lockfile changes were made.

### Slice 6: Runtime fixes and compatibility assessment

- Retain upstream subprocess cleanup, Bash write prompting, and `allowPty` fixes.
- Compare the pinned downstream runtime with sandbox-runtime 0.0.72 and record any changed defaults or missing patches.
- Assess reset-then-initialise failure semantics: determine whether the previous runtime can be restored or the unavailable manager can be detected and kept fail-closed.
- Test scoped Chromium behaviour without broad Unix-socket access.
- Test macOS Git-over-SSH behaviour with unauthenticated SOCKS compatibility, domain filtering, and separate SSH-agent approval.

**Slice 6a verified:** `src/sandbox-runtime.ts` now scopes `cleanupAfterCommand()` to successful runtime wrappers and runs it from the execution `finally` path for normal, nonzero, timeout, abort, and post-wrap process-creation failures. Original execution errors remain authoritative, and unchanged wrappers do not decrement another command's runtime cleanup state. `initializeSandbox()` preserves `allowPty` unchanged; inherited-pipe early completion, active post-exit draining, cleanup failures, asynchronous child-process errors, and exactly-once cleanup are covered in `test/sandbox-runtime.test.ts`. The fresh direct Node verification reports 119 passing tests, 4 TODOs, and no failures; the runtime-focused file reports 23 passing tests, 2 TODOs, and no failures. These mocked/runtime-fixture tests are not macOS Chromium or Git-over-SSH platform-parity evidence. See [`upstream-0.6.6-slice-6a-checkpoint.md`](../integration/upstream-0.6.6-slice-6a-checkpoint.md).

**Slice 6b verified:** R-02 now applies the shared specificity policy to direct Bash and nested `bash -c` write failures. Allowed and hard/equal-deny outcomes are classified without prompting; unmatched writes prompt, and a more-specific allow overrides a broader deny. The shared approval path refreshes the active runtime before a retry (the focused write-retry contract exercises session scope), while abort, no-UI, and failed-refresh paths do not retry. Failed refreshes also roll back a newly added session allowance. Registered Bash and `user_bash` retain final diagnostic attribution for successful and failed retries, and repeated identical violations are not prompted twice. The R-02 runtime TODO is replaced with harmless direct and nested redirection fixtures. Focused affected suites report 80 passing tests, 1 TODO, and no failures; the full direct Node suite reports 125 passing tests, 3 TODOs, and no failures. These mocked/runtime-fixture tests do not prove real OS enforcement.

**Slice 6b boundary:** C-13 and the two prompt/UI TODOs remain deferred. The sandbox-runtime 0.0.72 comparison, changed defaults, and reset/initialisation-failure recovery assessment were deferred to 6c. Real macOS scoped Chromium and Git-over-SSH acceptance remains deferred to 6d. No dependency, runtime-version, lockfile, SSH policy/proxy, credential, or platform-probe changes are part of 6b.

**Slice 6c assessment complete:** [the assessment](../integration/upstream-0.6.6-slice-6c-assessment.md) records stock 0.0.70 resolution, the historical fork provenance, the 0.0.72 source comparison, and the bounded reset/readiness findings. The 0.0.72 upgrade was not approved pending real macOS acceptance.

**Slice 6d acceptance complete:** [the acceptance record](../integration/upstream-0.6.6-slice-6d-acceptance.md) records the pinned npm integrity and host provenance, real scoped Chromium enabled/disabled launches, BSD `nc` SOCKS and Git-over-SSH gates, domain filtering, HTTP proxy authentication separation, exact SSH-agent approval, extension-seam limitations, cleanup, and the reset/replacement-init readiness probe. Standalone SOCKS, domain, HTTP-auth, SSH-agent, and Git protocol checks passed, but stock 0.0.72 failed the scoped Chromium gate because its generated profile omits the downstream sysctl, loopback-bind, and Darwin user-temp file/socket grants. The upgrade remains deferred; conditional Slice 7 is triggered for the minimum scoped browser adaptation. Full extension lifecycle acceptance remains assigned to Slice 9. No dependency, runtime-version, lockfile, or production code changes were made.

**Exit condition:** focused runtime tests and macOS checks either demonstrate parity on 0.0.72 or produce a bounded adaptation plan for the conditional slice. 6d produced that bounded adaptation plan; 0.0.72 was not approved at that checkpoint.

### Slice 7: Runtime adaptation, if required

Run this slice only if the outstanding 6d gates confirm that sandbox-runtime 0.0.72 fails a required parity check. The 6c source assessment makes scoped Chromium adaptation likely, but 6d real macOS evidence remains the trigger.

- Port or replace the minimum downstream runtime patches needed for scoped Chromium and macOS Git-over-SSH parity.
- Review any changed runtime defaults before enabling them.
- Repeat the focused runtime and macOS compatibility checks before upgrading the dependency.

**Slice 7 verified:** [`upstream-0.6.6-slice-7-checkpoint.md`](../integration/upstream-0.6.6-slice-7-checkpoint.md) records the exact `0.0.72` pin and integrity, the consumer-side adapter and its narrow profile contract, red stock-profile/green adapted-profile evidence, clean packed-consumer proof, real enabled/disabled Chromium and direct `sysctlbyname` results, and cleanup. The exact runtime is approved with the adapter: it adds only Darwin browser sysctl, loopback, and user-temp file/AF_UNIX grants when `allowBrowserProcess` is enabled, never broad Unix sockets. Fresh bounded 0.0.72 checks passed parent-proxy CONNECT/TLS/HTTP, authenticated HTTP separation, domain denial, BSD `nc` SOCKS compatibility, exact SSH-agent approval, and read-only Git-over-SSH. The full-manager rerun remained unsuitable inside the active outer sandbox because its nested mux socket was correctly denied; Slice 6d remains the prior full standalone-manager acceptance record. At that checkpoint, the extension known-hosts limitation and the then-open Slice 9 lifecycle boundary remained unchanged; Slice 8 followed for credentials.

**Exit condition:** runtime 0.0.72 meets the downstream compatibility and security gates, or the upgrade is explicitly deferred with the existing runtime retained. Slice 7 meets this condition through the bounded adapter; no credentials, upstream SSH proxy, prompt/UI, or lifecycle recovery work was pulled forward.

### Slice 8: Credential masking

- Add validated, typed credential policy configuration and preserve it through loading, composition, and runtime configuration.
- Implement host-scoped environment-variable deny and mask modes for macOS.
- Require fail-closed structured extraction and safe file-deny fallback on macOS.
- Verify that plaintext credentials cannot appear in sandboxed processes, diagnostics, prompts, or command output.

**Slice 8 closure verified:** [`upstream-0.6.6-slice-8-checkpoint.md`](../integration/upstream-0.6.6-slice-8-checkpoint.md) records the global-only trust decision, policy-only schema boundary, project warning/ignore behaviour, explicit host scopes, rejection of all environment JWT decode declarations due to runtime 0.0.72's fail-open mismatch path, supported fail-closed extraction, rejection of plaintext injection, canonicalized runtime plumbing, direct macOS sandbox-wrapper execution, host-scoped substitution, sentinel/file non-disclosure, and cleanup. File decode mismatch tests confirm that the narrower accepted file surface honors `deny`/`error`; the real macOS wrapper executes the denied `cat` and reports a nonzero read denial without plaintext or a fake bind. The direct runtime components and macOS wrapper passed; the full nested manager was not widened past the already-active outer sandbox's scoped mux-socket policy. Linux credential-file masking, project composition, generic secret-bearing runners, ordinary credential prompts, and unrelated lifecycle/prompt work remain deferred.

**Exit condition:** met for the bounded consumer/runtime seams: credential contract and direct macOS integration tests pass, including substitution only for explicitly configured hosts and direct denied-file-read evidence. Full manager orchestration remains a known harness limitation rather than a broadened permission or weakened assertion.

### Slice 9: Permission prompts and lifecycle integration

Slice 9 is complete and is divided into the prompt/UI contract work and the lifecycle recovery work.

#### Slice 9a: Permission-prompt/UI contracts (complete)

- Adapt editable and validated prompt rules to downstream scope and persistence semantics.
- Add timeout behaviour that aborts without persistence and emit attention events for prompts.
- Require explicit second confirmation for project/global grants across key, navigation, and edited flows while retaining one-step session grants.
- Preserve project-relative presentation and scope-aware canonical persistence without weakening configuration protection or policy precedence.

**Slice 9a verified:** [`upstream-0.6.6-slice-9a-checkpoint.md`](../integration/upstream-0.6.6-slice-9a-checkpoint.md) records executable UI and extension contracts for edited domain/read/write rules, reset/non-match/acceptance behavior, project-relative and scope-aware persistence, repeated timeout blocking without session allowance, attention emission, and no-UI/hard-deny boundaries.

#### Slice 9b: Lifecycle recovery (complete)

- Complete extension lifecycle wiring with explicit disabled, unsupported, initializing, ready, unavailable, shutting-down, and shutdown states.
- Handle reset-success/initialisation-failure explicitly: restore the prior runtime only on an exact policy snapshot match; otherwise block Bash and direct tool execution until explicit recovery, report the unavailable runtime, and roll back newly added session-only allowances when refresh fails.
- Serialize manager reset/initialize ownership and guard stale start, recovery, replacement, and shutdown completions from mutating a newer lifecycle.

**Slice 9b verified:** [`upstream-0.6.6-slice-9b-checkpoint.md`](../integration/upstream-0.6.6-slice-9b-checkpoint.md) records the focused extension/status/runtime evidence, including fail-closed replacement failure, exact-equivalence restoration, persisted-but-blocked policy, explicit recovery, stale completion protection, serialized cleanup, and status presentation. The full nested SandboxManager orchestration remains constrained by the active outer sandbox mux socket policy; no permission broadening was used.

Keep optional `/sandbox-allow`, SSH proxy, `sandboxUserShell`, and toggle decisions outside Slice 9 unless separately approved.

**Exit condition:** met for Slice 9. Prompt, UI, lifecycle, and extension-seam tests pass without weakening configuration protection or policy precedence. Slice 10 parity, cleanup, and update rehearsal remains open.

**Pre-Slice-10 review:** [upstream 0.6.6 integration review](../reviews/upstream-0.6.6-integration-review.md) confirms upstream and downstream features are correctly combined through Slice 9, records the clean typecheck/lint/format state and 157 pass / 2 environment-only fail / 1 deferred-todo test result, and lists the Slice 10 caveats (sandbox-nested test skips, adapter fragility, mocked platform evidence, stale docs).

### Slice 10: Parity, cleanup, and update rehearsal

- Review completed behaviour against the feature ledger and downstream `main`.
- Remove superseded duplicate implementations only after replacement coverage passes.
- Reconcile README, examples, package metadata, lockfiles, and CI with the final accepted semantics.
- Run formatting, linting, type checking, unit tests, and macOS platform checks.
- Simulate a small upstream-aligned change and verify that it integrates without modifying unrelated downstream-owned modules.
- Integrate the completed branch into the downstream repository while preserving both histories.

**Exit condition:** all required ledger entries and verification checks are complete, deferred items remain explicit, the update workflow is demonstrated, and downstream `main` can receive the integration without a history rewrite.

Expect nine execution runs when runtime 0.0.72 passes the slice 6 compatibility gates, and ten when slice 7 is required.

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
- successful sandbox reinitialisation after an approved change, plus fail-closed recovery when reset succeeds but replacement initialisation fails;
- scoped macOS Chromium policy without broad Unix-socket access;
- macOS Git-over-SSH through the unauthenticated SOCKS compatibility mode while retaining domain and SSH-agent controls;
- environment-variable deny and mask modes on macOS;
- sentinel values being substituted only for explicitly configured credential hosts and remaining fake for other reachable hosts;
- structured masking failing closed when extraction does not match;
- credential files degrading safely to deny on macOS;
- plaintext credentials remaining absent from sandboxed environment inspection, file reads, command output, diagnostics, and prompts;
- all retained diagnostics and Git/SSH workflows;
- module-level contract tests for each shared integration seam; and
- a synthetic upstream update integrating without changes to unrelated downstream-owned modules.

Run formatting, linting, TypeScript checking, and unit tests. Run platform-specific sandbox integration tests on macOS. Linux CI and platform-neutral coverage should remain healthy where practical, but Linux-specific integration failures do not block this downstream migration unless they reveal a shared correctness or security defect.

## Open questions

- Should an explicit `/sandbox-allow` command remain alongside `/sandbox`, or should `/sandbox` gain an optional interactive scope selector?
- Should users be able to remove inherited rules through a separate explicit command, while keeping empty-array composition cumulative?
- Which upstream SSH proxy behaviour complements the downstream preflight and existing macOS `allowUnauthenticatedSocksProxy` flow, and which parts duplicate or weaken them?
- **Resolved in Slices 6d–8:** stock sandbox-runtime 0.0.72 needed the bounded consumer-side Chromium adapter; the exact runtime is now approved with that adapter, while the extension known-hosts limitation remains conservatively unavailable for disposable isolation.
- Credential policy composition was resolved in Slice 8 as global-only initially; revisit only through an explicit trust review and composition contract.
- Should `sandboxUserShell` be accepted, rejected, or exposed only through explicit per-session confirmation?
- Should the pnpm and Node test-runner migration be adopted as part of this work or handled separately?

## Strategy decision: upstream-first, test-led port

The integration will use upstream as the architectural starting point rather than first refactoring the downstream monolith into the same shape.

This decision is based on the following considerations:

- upstream already contains the target five-module architecture and the later runtime and prompt work;
- mechanically reproducing that architecture from the downstream `index.ts` before integrating upstream would duplicate structural work;
- most substantial downstream additions already have focused tests or separable modules that can be ported onto explicit seams;
- importing downstream tests first turns behavioural parity into a visible checklist rather than relying on manual comparison;
- retaining the existing downstream branch as a reference prevents the upstream baseline from becoming an irreversible replacement; and
- making the final implementation upstream-shaped reduces the expected cost of subsequent upstream releases.

The trade-off is that an upstream-first branch will not preserve all downstream behaviour at every intermediate commit. It therefore depends on a complete feature ledger, additional characterisation tests for embedded policy, and explicit parity verification before integration. The current downstream `main` must remain intact until that verification passes.

This is a source-integration strategy, not a history rewrite. The completed work must be merged into the downstream repository in a way that preserves both upstream and downstream ancestry. No downstream branch should be reset to upstream, and nothing may be pushed to the upstream remote.
