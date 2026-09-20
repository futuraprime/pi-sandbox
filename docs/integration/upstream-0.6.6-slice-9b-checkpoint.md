# Upstream 0.6.6 Slice 9b checkpoint: lifecycle recovery

- **Proposal:** [`proposal-integrate-upstream-0.6.6.md`](../proposals/proposal-integrate-upstream-0.6.6.md)
- **Feature ledger:** [`upstream-0.6.6-feature-ledger.md`](upstream-0.6.6-feature-ledger.md)
- **Slice:** 9b — lifecycle recovery
- **Baseline:** Slice 9a, `@carderne/sandbox-runtime@0.0.72`
- **Decision:** complete the bounded extension lifecycle recovery seam; leave Slice 10 parity/cleanup and C-13 open

## Lifecycle boundary

`src/extension.ts` now represents disabled, unsupported, initializing, ready, unavailable, shutting-down, and shutdown states explicitly. A ready runtime records its exact configuration, session allowances, and cwd snapshot. Refresh performs reset then initialization under a serialized `SandboxManager` transition. A failed replacement may restore the prior runtime only when its exact policy snapshot is equivalent to the desired snapshot. A restored runtime with a different policy remains unavailable rather than becoming an unsandboxed or stale-policy fallback.

Unavailable and transitional states fail closed for registered Bash, `user_bash`, direct tool preflight, and runtime diagnostic operations. Persisted project policy is not discarded when refresh fails, but it does not unlock execution. Explicit `sandbox-enable` recovery resets the manager, initializes the desired persisted policy, and returns to ready status only after the new initialization succeeds. Session allowances added for a failed refresh are rolled back; persisted project/global policy remains persisted.

Generation and context ownership checks cover stale initial starts, recovery, replacement starts, and shutdown. Reset and initialization operations share a FIFO transition boundary, so a deferred shutdown reset completes before a replacement initialization and cannot tear down the replacement runtime. Shutdown cleanup is queued even when initialization was still pending, while stale completions cannot update status or claim runtime ownership.

## Executable evidence

The focused extension suite covers:

- reset-success/replacement-initialization-failure with no local Bash fallback;
- exact policy-equivalent prior-runtime restoration and executable wrapped Bash;
- policy-different restoration staying unavailable, with persisted policy retained and Bash/read/user-Bash blocked;
- explicit recovery initializing the desired policy and reaching ready status;
- failed refresh rollback of newly added session allowances, including direct tool paths;
- stale start success/failure, stale recovery, and stale shutdown/replacement completion protection;
- serialized reset ordering and queued cleanup ownership; and
- pending/initializing, ready/enabled, disabled, unsupported, unavailable, and shutdown presentation.

`src/status.ts` has an explicit unavailable presentation (`Sandbox unavailable; command execution blocked`) while preserving the compact disabled/pending/unsupported/error indicator and cleared shutdown status. The status tests also retain collapsed diagnostic presentation coverage.

## Verification record

| Command | Result |
| --- | --- |
| `pnpm exec tsx --test test/extension.test.ts test/status.test.ts test/sandbox-runtime.test.ts test/policy.test.ts` | Passed: 82 tests (83 total), 1 explicit C-13 TODO, 0 failures. |
| `pnpm test` | Passed: 159 tests (160 total), 1 explicit C-13 TODO, 0 failures. |
| `pnpm run check` | Passed: TypeScript `tsc --noEmit`. |
| `pnpm run lint` | Passed: `oxlint index.ts src test`. |
| `pnpm run ci:fmt` | Passed: `oxfmt --check index.ts src test`. |
| `git diff --check` | Passed. |
| `python3` repository-local Markdown-link validation | Passed: 45 repository-relative Markdown links across 14 repository Markdown files; all targets exist. |

Tests use bounded `SandboxManager` mocks and component seams for lifecycle orchestration. Full nested manager orchestration was not broadened because the active outer sandbox correctly denies the nested mux socket; this checkpoint claims no real nested-manager enforcement beyond the separately documented runtime/platform checkpoints.

## Scope boundaries

No `/sandbox-allow`, SSH proxy, `sandboxUserShell` bypass, keyboard/toggle change, credential expansion, dependency or lockfile change, broad permission, C-13 decision, or unrelated refactor is included. Slice 10 parity review, cleanup, synthetic upstream update rehearsal, and final downstream integration remain open. Deferred product and security decisions in the feature ledger remain deferred.
