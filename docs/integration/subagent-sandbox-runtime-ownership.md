# Independent runtime ownership (Unit 2)

- **Date:** 2026-10-19
- **Implementation:** `b35e316`
- **Runtime:** `@carderne/sandbox-runtime` 0.0.72, unchanged.
- **Coordinator host:** macOS 15.7.9, Node 26.11.1, pnpm 12.11.2.

## Ownership changes

Each extension instance creates an independent manager and owns its transition queue. Initialisation, replacement, reset, Bash wrapping, proxy lookup, config/provenance lookup, violation-store access, annotation, and command cleanup use that same manager. There are no remaining `SandboxManager` singleton calls or process-global transition keys in `src/`.

Runtime helpers now require an explicit manager. Chromium acceptance workers create their own manager; existing OS regression fixtures pass the manager they initialise. Fresh runtime configs retain their identity for macOS specificity-adapter provenance. No monitoring, dependencies, mandatory protections, or personal configuration changed.

Initialisation failure awaits best-effort cleanup before propagating the original error. Restoration additionally requires a successful reset boundary: a failed cleanup cannot make an equivalent prior policy executable without a subsequent successful reset. Explicit recovery still resets before initialising.

## Contract tests and review

- Replaced the obsolete cross-extension singleton-queue regression with two-owner coverage: a pending/failing owner does not block a sibling, configs are distinct, and replacement/shutdown reset only the relevant owner.
- Added an awaited partial-cleanup regression and a two-manager wrapping/proxy/cleanup routing regression.
- Added failed-cleanup/restoration coverage: unsuccessful cleanup and restoration reset leave Bash blocked; explicit successful recovery restores execution. Original initialisation failure remains in diagnostics.
- Existing lifecycle tests retain stale-generation, fail-closed, equivalent restoration, disable, and unsupported assertions. Reset counts now include failure cleanup and the explicit restoration boundary.
- Implementing agents observed red/green for the factory-routing test and the failed-cleanup restoration guard. The final implementing agent reported extension 56/56 and runtime 41/41 passing. These are subagent observations, not coordinator full-suite results.
- Coordinator inspected the final production/test diff and helper consumers. Read-only review confirmed manager routing; its cleanup concern was addressed with the restoration reset boundary.

## Coordinator verification

All test commands used `TMPDIR="$PWD/tmp"`.

- `pnpm run ci:fmt`, `pnpm run lint`, and `pnpm run check`: passed after final formatting.
- `pnpm exec tsx --test --test-name-pattern='extension manager owners isolate|failed initialization cleanup|initializeSandbox awaits partial cleanup|Bash runtime queries, wrapping, and cleanup stay with their owner' test/extension.test.ts test/sandbox-runtime.test.ts`: 3/4 passed. The restoration regression did not reach its replacement call (initialise count 1 rather than 2). It selects project persistence, which is restricted by the outer sandbox; an external run is still required rather than treating the assertion as verified here.
- Before the final cleanup guard, the combined extension/runtime suites completed with 71/96 passing; failures included blocked `.pi`/`.git` fixture creation and restoration assertions. This is not a passing regression run.
- Final `pnpm test`: attempted and failed. Output includes mandatory `.pi`/`.git` fixture denials, runtime mux socket `listen EPERM`, and restoration assertions that did not reach replacement. No protections were relaxed. The full output was truncated by the tool; no reliable aggregate count is recorded here.
- `git diff --check`: passed.

## External-terminal regression result (2026-10-21)

The user supplied `tsx --test test/**/*.test.ts` output: 232 tests, 227 passed, 2 failed, 3 skipped. All 56 extension and 41 runtime tests passed, including owner isolation and failed-cleanup restoration. The skipped tests remain the three opt-in credential CLI acceptance probes.

Both failures are in unchanged `test/credentials.test.ts`: the JWT fallback deny-path assertion compares a `/projects/...` path with its `/Users/Shared/projects/...` realpath, and the masked-file OS probe unexpectedly reads the synthetic credential file successfully. Read-only inspection confirms `/projects` is a symlink to `/Users/Shared/projects`. The tests call dependency helpers directly with the alias path; `buildRuntimeConfig()` canonicalises credential paths before passing them to the runtime, whereas the dependency helper uses its own path normalisation. This supports an alias-sensitive test/dependency explanation, but the successful-read failure must not be dismissed as a harmless string mismatch or treated as passing denial evidence.

### Approved test-only follow-up

The user approved correcting credential-test path handling, with production/dependency changes requiring separate approval. Commit `a387f6a` passes canonical credential paths to dependency helpers, matching the extension's contract. The macOS probe now explicitly tests both canonical and symlink-alias command paths against the canonical deny; nonzero exit, denial stderr, empty stdout, and no synthetic plaintext assertions remain. Existing platform/nested-sandbox guards are unchanged. No production or dependency change was required.

The implementing agent reproduced the dependency's alias-preserving path behaviour and reported 6/6 credential tests passing with `TMPDIR` through `/projects`, including both real OS read-denial probes with no skips. Coordinator inspected the diff and ran `TMPDIR="$PWD/tmp" pnpm exec tsx --test test/credentials.test.ts`: 4 passed, 0 failed, 2 existing nested-sandbox skips. Coordinator formatting, lint, type checks, and `git diff --check` passed.

This is not a claim that direct noncanonical dependency input is safe; the integration canonicalises input. Unit 2 remains unchecked pending a final external full-suite result including this test correction. Unit 1's earlier external pass is not evidence for changed code.

## Evidence limits

These tests establish routing and lifecycle contracts using mocks, not successful concurrent OS enforcement. Monitoring remains disabled; macOS's shared monitoring tags, Linux's shared mount cleanup, and the process-wide `NODE_USE_ENV_PROXY` effect remain as recorded in the [Unit 1 audit](subagent-sandbox-runtime-audit.md). No successful concurrent real-manager proxy startup or Linux enforcement was verified.

Active-command leases, draining before policy refresh, and cancellation/awaited teardown are Units 3–4, not implemented or claimed here. No personal rollout or runner integration is authorised by this change.
