# Upstream 0.6.6 Slice 5 handoff

## Branches and baseline

- Integration branch: `feature/upstream-merge`
- Slice branch: `feature/upstream-merge-slice-5`
- Continue all remaining Slice 5 work on the existing Slice branch. Use focused checkpoint commits; do not create sibling mini-slice branches.
- `upstream/main` is the upstream 0.6.6 baseline (`d76ad64a42532f83639f934019aabdeb8c20f4fa`, tag `v0.6.6`). Never push to `upstream` or open a pull request against it.
- `origin/main` (`757f0586fc7d9877a37901e6976830672bc93ed8`, downstream 0.4.4) is a read-only behavioural reference.
- The integration and Slice branches contain Slice 5 through commit `8595b33` before this handoff note.

After transferring to another checkout:

```bash
git fetch origin
git switch feature/upstream-merge-slice-5
node --import tsx --test test/**/*.test.ts
pnpm run check
pnpm run lint
pnpm run ci:fmt
```

`pnpm test` may fail in the agent sandbox because the `tsx` CLI cannot create its IPC socket. The direct Node command above is the known-good replacement. Warnings about unreadable user-level pnpm/npm or sandbox configuration are expected in a restricted sandbox.

## Completed work

Slices 2–4 are integrated, including configuration composition, specificity-aware policy, the six-rule `/sandbox` command, protected project/global persistence, and direct/Bash/runtime protection of sandbox configuration.

Completed Slice 5 areas:

- **H-04/H-05 and the main L-02 work:** validated linked-worktree metadata, derived common-Git metadata allowances, descendant-cwd handling, replacement-cwd behavior, exclusions, and direct/runtime integration (`21ab398`, `f09f25e`).
- **H-01/H-02:** secure `set_git_upstream`, origin-only existing-ref validation, fixed non-shell Git arguments, Git environment sanitization, cancellation, and pre-sandbox redirection of Bash tracking mutations (`8595b33`).
- Shared positive and negative Git command fixtures are exercised at both classifier and extension-hook seams. Cancellation is covered before process creation and while a Git subprocess is running.

Current verification at the handoff point:

- Full suite: 74 passed, 4 TODO, 0 failed.
- TypeScript, oxlint, oxfmt check, and `git diff --check` pass.
- The remaining TODO gates include C-13 and R-02 and must stay deferred to their planned slices.

## Remaining Slice 5 work

Use `docs/integration/upstream-0.6.6-feature-ledger.md` as the contract and `origin/main` as the behavioural source. Keep `index.ts` as the thin export `export { default } from "./src/extension.ts";` and retain the split module architecture.

### 1. Slice 5c — core diagnostics and violation presentation

Implement the shared foundation before status, debug history, or SSH-specific integration:

1. Extend `src/diagnostics.ts` with structured runtime-event parsing and fallback attribution for read, write, network, SSH-agent, browser, and ambiguous violations (G-01).
2. Port diagnostic identity, primary-violation priority, promptability ordering, material-difference retry guards, final-state fields, and other-violation counts (G-02).
3. Preserve raw `<sandbox_diagnostic>` metadata for the agent while producing compact user-visible notices and optional expanded output (G-03).
4. Wire the minimum `tool_result` and `user_bash` seams in `src/extension.ts` without pulling in debug history, status state, or SSH preflight yet.
5. Add runtime-event contract fixtures and integration tests for normal output, hidden raw metadata, visible notices, truncation, final outcomes, changed second violations, and duplicate-prompt prevention.

Expected focused tests: `test/diagnostics.test.ts` plus extension integration tests. Reuse shared policy classification from `src/policy.ts`; do not create a second precedence implementation.

### 2. Slice 5d — incident history and downstream status

After the core diagnostic seam is stable:

1. Add memory-only incident retention for the newest five attributed or prompted incidents, including command preview, outcome, primary/other violations, prompt choice, config mutation, retry, and rule details (G-04).
2. Add `/sandbox-debug` rendering and command-handler coverage. Prove history is not written to either sandbox configuration and does not survive a fresh extension/session.
3. Add `src/status.ts` and restore downstream enabled, disabled, pending, unsupported, intervention, expanded/collapsed, and shutdown presentation contracts (G-06).
4. Ensure the default TUI never displays raw `<sandbox_diagnostic>` blocks.

Final shutdown/replacement-state guarantees shared with Slice 9 should remain explicitly bounded rather than being partially improvised here.

### 3. Slice 5e — SSH, browser, and auth-adjacent diagnostics

Build on the diagnostic and status seams:

1. Port compound SSH command detection and preflight, exact/path-scoped SSH-agent approval on macOS, Linux fail-closed behavior, successful/denied retry handling, and rollback after failed reinitialisation (H-03).
2. Never grant broad `allowAllUnixSockets`; SSH-agent access remains separate from network-domain approval.
3. Port SSH fallback classification, browser Mach/bootstrap diagnostics, and safer guidance for SSH keys and Git credentials (G-05).
4. Add compound-command integration tests with domain filtering, `SSH_AUTH_SOCK`, successful and denied retries, and Linux no-prompt behavior.

The sandbox-runtime 0.0.72 comparison, macOS Git-over-SSH acceptance, scoped Chromium runtime behavior, and reset/recovery policy belong to Slice 6. Do not change dependencies or lockfiles during Slice 5.

### 4. Slice 5f — stale lifecycle protection

Port the Slice 5 portion of L-01 after status and diagnostics exist:

1. Characterize obsolete `session_start` success and failure after shutdown or replacement.
2. Ensure stale initialization cannot update status, notify, re-enable a replacement session, emit stale diagnostics, or prompt.
3. Keep shutdown reset behavior explicit and test current-context identity/generation checks.

Reset-on-error recovery and complete lifecycle state transitions continue in Slices 6 and 9. Do not invent an unsafe local Bash fallback when runtime replacement fails.

## Working rules

- Preserve downstream security policy while adapting upstream behavior.
- Use TypeScript and pnpm; do not change dependencies, package metadata, or lockfiles in Slice 5.
- Prefer project-local temporary directories and remove every fixture.
- Use red/green TDD where practical and independently review each checkpoint before committing corrections.
- Before delegating an executor, require `git status --porcelain --untracked-files=all` to be completely empty.
- For an execution cycle, use one fresh foreground ordinary `plan-executor` routed to the active Codex/GPT-5.6 Luna profile, then perform a separate review-only pass.
- Never change upstream history, push to `upstream`, or modify `origin/main`.
