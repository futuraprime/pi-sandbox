# Slice 2 upstream baseline and downstream parity checklist

This checklist records the test-led boundary for slice 2. It is intentionally separate from the feature ledger: the ledger owns the migration contract, while this document records which downstream tests are runnable against the upstream 0.6.6 seams and which remain blocked until a later slice adds their owner module.

## Baseline established

- `feature/upstream-merge` starts at upstream `d76ad64` (`v0.6.6`) and retains the two documentation commits on top.
- `index.ts` remains the thin entry point and re-exports the upstream extension.
- The upstream five-module architecture is retained unchanged: `src/config.ts`, `src/extension.ts`, `src/policy.ts`, `src/sandbox-runtime.ts`, and `src/ui.ts`.
- `package.json` retains the pnpm and `tsx --test` node:test harness. No Vitest dependency or downstream package-manager changes were introduced.
- `origin/main` at `757f058` remains the behavioural reference. No ref was merged, rewritten, or changed.

## Runnable imported and characterisation coverage

The existing upstream tests remain in place and continue to use `node:test`, `node:assert/strict`, and the five module boundaries. The following downstream assertions or slice-2 characterisations were added to those suites where an upstream seam already exists:

| Test location | Imported/characterised coverage | Status |
| --- | --- | --- |
| `test/config.test.ts` | Existing-config preservation, project-relative value preservation, selected-path-only writes, malformed array handling, malformed top-level JSON warnings, and the upstream configured-array replacement result. | Compiles and runs. The cumulative downstream result is explicitly todo until C-02–C-05. |
| `test/policy.test.ts` | Existing hard-deny write decision, upstream deny-first result when a more-specific allow is present, and current URL-only command extraction. | Compiles and runs. Specificity, deny/domain composition, and SSH/SCP extraction remain todo. |
| `test/sandbox-runtime.test.ts` | Existing session/effective allowance and Bash restriction seams, `allowPty` propagation, output-handle cleanup, and Bash restriction output variants. | Compiles and runs. Full Bash preflight/retry attribution remains todo. |
| `test/ui.test.ts` | Existing upstream timeout, configured path, remaining-time, and safe-abort coverage. | Compiles and runs. Downstream persistence integration for prompt results remains todo. |

The characterisation assertions that describe upstream-vs-downstream differences are not parity claims. They preserve the current baseline while making the later replacement work visible. `test.todo` entries remain green under the normal node:test command and are tracked below.

## Explicit unresolved checklist

A downstream test is not copied into the normal suite when its import would require a production module or integration seam that upstream 0.6.6 does not provide. These are the expected blocked seams, not silently omitted requirements.

| Downstream source at `origin/main` | Missing seam/module on this branch | Preserved assertions to import later | Owner / later slice |
| --- | --- | --- | --- |
| `sandbox-command.test.ts` | `src/sandbox-command.ts` and extension command/persistence integration | All six `/sandbox` rule types, validation, idempotence by canonical path, formatted protected writes, unrelated-field preservation, and reinitialisation. The existing config writer tests cover only the upstream writer seam. | CP, `src/sandbox-command.ts`; slice 4 |
| `sandbox-protection.test.ts` | Extension-level protected-path predicate and direct tool/Bash mutation hook | Project/global path recognition, `getAgentDir()` awareness, redirects, and proof that direct writes remain blocked. | PF/CP, `src/extension.ts`; slice 4 |
| `git-upstream.test.ts` | `src/git-upstream.ts` secure fixed-argument tool | Existing-origin-only tracking changes, ref validation, alias/shell injection resistance, preservation of unrelated Git config, and cancellation/registration integration. | PF, `src/git-upstream.ts`; slice 5 |
| `git-worktree.test.ts` | `src/git-worktree.ts` linked-worktree metadata resolver | Reciprocal metadata, bounded reads, direct `worktrees/<name>` validation, canonical paths, traversal rejection, and invalid-session fail-closed behavior. | EP, `src/git-worktree.ts`; slice 5 |
| `sandbox-filesystem.test.ts` | `src/sandbox-filesystem.ts` derived linked-Git allowance owner | Common Git metadata read/write allowance, no checkout/sibling broadening, replacement worktree recomputation, non-mutation, and runtime integration. | EP, `src/sandbox-filesystem.ts`; slice 5 |
| `diagnostics.test.ts` | `src/diagnostics.ts` and status/extension diagnostic seam | Violation identity and priority, fallback attribution, retry guards, raw diagnostic blocks, compact notices, incident history, Git-upstream detection, SSH preflight, browser attribution, and SSH rollback. | RD/PF, `src/diagnostics.ts` and planned status owner; slices 5–6 and 9 |
| `lifecycle.test.ts` | Downstream extension lifecycle state/context and derived filesystem integration | Stale session-start success/failure suppression, active `ctx.cwd`, reset/reinitialisation ordering, session allowance clearing, and status cleanup. | RD/EP, `src/extension.ts`; slices 5 and 9 |
| `browser-process.test.ts` | The installed 0.0.70 runtime does not export the downstream test's `generateSandboxProfile` helper; 0.0.72/profile parity is a later runtime gate | Scoped Chromium process/sysctl, loopback, Darwin temp, and path-scoped Unix-socket permissions without broad `allowAllUnixSockets`. | EP, runtime comparison; slices 6–7 |

## Slice 3 completion

Slice 3 replaced the configuration and policy TODO gates with executable contract coverage. `src/config.ts` now composes validated defaults, global, and project arrays cumulatively (including per-key `ignoreViolations`) while retaining local scalar precedence. `src/policy.ts` now shares canonical path and domain specificity decisions, including deny precedence, more-specific allow exceptions, hard denies, and HTTP(S)/SSH/SCP command extraction. Direct read/write and network preflight callers consume those decisions.

## Slice 4 completion

Slice 4 replaced the C-07/D-02 and D-01/D-04 TODO gates with executable node:test contracts. The new `src/sandbox-command.ts` owns parsing, validation, canonical filesystem duplicate detection, project-relative persistence, and all six rule arrays. `src/extension.ts` now exposes only `/sandbox` (no `/sandbox-allow`), writes project scope, and refreshes an active runtime only after a changed command. Direct write/edit calls and Bash mentions of the project or `getAgentDir()` global config are blocked before sandbox state checks; both canonical paths are also in runtime `denyWrite`.

Focused Slice 4 coverage passes in `test/sandbox-command.test.ts`, `test/sandbox-protection.test.ts`, and `test/extension.test.ts`. Remaining TODOs are unrelated later-slice gates: C-13 direct-tool versus runtime `allowWrite` meaning and R-02 Bash preflight classification, retry, and attribution. UI timeout persistence remains P-03/D-03 work for slice 9.

No TODO weakens an existing assertion, changes runtime/security behavior, or substitutes for the blocked-module checklist above.
