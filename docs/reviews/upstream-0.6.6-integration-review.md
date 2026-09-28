# Review: upstream 0.6.6 integration branch (pre-Slice-10)

> Historical review of Slices 1–9. For the later Slice 9.5 SSH acceptance, Slice 10a reconciliation and private-fork ownership decision, see [the acceptance record](../integration/upstream-0.6.6-slice-9.5-acceptance.md) and [the 10a audit](../integration/upstream-0.6.6-slice-10a-audit.md). Its test counts, C-13 TODO, and metadata comments below are not current verification.

- **Branch reviewed:** `feature/upstream-merge`
- **Proposal:** [Integrate upstream 0.6.6 without losing downstream policy](../proposals/proposal-integrate-upstream-0.6.6.md)
- **Scope:** Assess whether upstream 0.6.6 and downstream features are correctly combined, and surface combination issues. Slice 10 (parity review, cleanup, doc reconciliation, update rehearsal) had **not** been run at review time, so stale documentation, metadata, and the `0.6.6` version string are expected and out of scope.

## Verdict

The combination succeeded as intended. Upstream 0.6.6's modular architecture, runtime fixes, and prompt work are integrated on top of the downstream security model, and downstream policy semantics are preserved rather than overwritten. Slices 1–9 objectives are met with test-backed evidence. Remaining work is Slice 10 only.

## Build state (preliminary — Slice 10 not run)

- `tsc --noEmit`: clean
- `oxlint`: clean
- `oxfmt --check`: clean
- Tests: **157 pass / 2 fail / 1 todo** (`node --import tsx --test 'test/**/*.test.ts'`)

The 2 failures are **environment artifacts, not defects**: the macOS credential wrapper tests in `test/credentials.test.ts` invoke `sandbox-exec`, which returns exit 71 (`sandbox_apply: Operation not permitted`) because the review session runs inside a sandbox (`SANDBOX_RUNTIME=1`) and nested `sandbox-exec` is blocked. Confirmed directly; they pass on a bare macOS host. This is the documented nested-manager harness limitation. The 1 `todo` is the intentionally-deferred C-13 decision (whether runtime `allowWrite` also grants direct-tool read).

## Feature combination — verified against the proposal

### Downstream security semantics preserved (not replaced by upstream)

- **Cumulative composition** (`defaults → global → project`) concatenates + dedups all policy arrays; an explicit `[]` does not weaken inherited restrictions; scalars stay most-local-wins. Upstream's replacing `cfffa17` behaviour is overridden. (`src/config.ts`)
- **Specificity-aware precedence** (equal-deny wins, more-specific-allow overrides, unmatched → prompt, relative paths resolved first) applied consistently across direct preflight, Bash diagnostics, network checks, and the runtime host callback — not upstream's mixed write-absolute/read-allow-only model. (`src/policy.ts`)
- **Project-relative persistence** preserved for project scope; global/session canonicalised to absolute; matching/dedup canonicalises transiently without changing stored spelling.
- **Six-rule `/sandbox` editor** retained through a single protected persistence seam; upstream's positive-only `/sandbox-allow` removed (only a negative test asserts its absence). (`src/sandbox-command.ts`)
- **Config protection** blocks direct write/edit and Bash mutation via `getAgentDir()`-aware paths, which are also injected into runtime `denyWrite`. One writer, not two parallel mutation paths.

### Upstream features adopted

- Runtime fixes: subprocess cleanup from the `finally` path, inherited-handle drain (`53bd1d6`), `allowPty` passthrough (`79b592b`), correct Bash write prompting (`3fb50d6` / R-02).
- Editable + validated prompts (`fcabc75`), prompt timeout that aborts without persisting (`4ca354c`), attention events (`d6f01db`) — all adapted to downstream scope, project-relative display, and the two-step confirmation for persistent grants.
- Modular `config` / `extension` / `policy` / `sandbox-runtime` / `ui` split with `index.ts` reduced to a 6-line re-export.

### Reconciled seams (the harder combinations)

- **sandbox-runtime pinned to exactly `0.0.72`** with a **consumer-side Chromium adapter** (`augmentMacosBrowserProfile`) that adds only Darwin browser sysctl, loopback, and user-temp file/AF_UNIX grants when `allowBrowserProcess` is on — never broad `allowAllUnixSockets`. This regains scoped Chromium parity without forking the runtime. (`src/sandbox-runtime.ts`)
- **macOS Git-over-SSH**: `allowUnauthenticatedSocksProxy` retained; domain filtering, HTTP proxy auth, and separate path-scoped SSH-agent approval intact.
- **Credentials (Slice 8)**: validated, policy-only, global-only section flowing through load → compose → `buildRuntimeConfig`; env JWT decode rejected at the boundary; structured extraction fails closed; macOS file-mask degrades to deny; no plaintext runner introduced.
- **Lifecycle recovery (Slice 9b)**: explicit state machine with fail-closed reset/init — restores the prior runtime only on exact policy-fingerprint match, otherwise blocks execution until explicit recovery and rolls back session-only allowances on refresh failure; stale completions guarded; reset/init serialized.

## Issues / caveats for Slice 10

None are combination defects, but each warrants attention before release:

1. **Nested-sandbox test failures** — the 2 credential wrapper tests cannot pass inside a sandbox. Consider a guard/skip that also detects `SANDBOX_RUNTIME` (alongside the existing `process.platform !== "darwin"` skip) so CI and dev-in-sandbox runs are green and the real gate stays explicit. Otherwise `pnpm test` looks red to anyone running it inside pi.
2. **Adapter fragility (intentional)** — `augmentMacosBrowserProfile` fails closed (no-op) if the runtime's generated profile shape changes. Safe, but a future runtime bump would *silently* drop Chromium grants; re-review the adapter on every runtime upgrade.
3. **In-repo platform evidence is mocked/fixture-based** — full nested `SandboxManager` orchestration was never run here (outer-sandbox mux-socket limit); Slices 6d/7 standalone runs remain the only live-enforcement record. Real macOS acceptance is still owed before release.
4. **Stale docs/metadata** — README, package metadata, upstream repo URLs/author, and the `0.6.6` version string are stale as expected. This is the Slice 10 reconciliation.
5. **C-13** remains an open decision (single `test.todo`), consistent with the ledger.

All deferred items (O-01…O-11: `/sandbox-allow` coexistence, SSH proxy, `sandboxUserShell`, `Alt+S`, pnpm migration, Linux file masking) are explicitly recorded as deferred product decisions, not gaps in the combination.
