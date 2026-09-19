# Upstream 0.6.6 Slice 9a checkpoint: permission prompts

- **Proposal:** [`proposal-integrate-upstream-0.6.6.md`](../proposals/proposal-integrate-upstream-0.6.6.md)
- **Feature ledger:** [`upstream-0.6.6-feature-ledger.md`](upstream-0.6.6-feature-ledger.md)
- **Slice:** 9a — permission-prompt/UI contracts
- **Baseline:** Slice 8, `@carderne/sandbox-runtime@0.0.72`
- **Decision:** complete the prompt editing, scope, confirmation, attention, and timeout seams; keep Slice 9b lifecycle recovery open

## Prompt and validation seam

`showPermissionPrompt()` now separates the original blocked value from the value shown in the editable input. Filesystem prompts present a target relative to `ctx.cwd` when it is inside that directory and retain an absolute presentation outside it. An abort, explicit cancellation, or timeout always returns the original blocked value rather than an edited or partially edited value.

Edited domains, reads, and writes are first checked with the same operation-specific `validateSandboxCommandValue()` used by `/sandbox`. The accepted rule must then match the original blocked domain or path. Path matching passes `ctx.cwd` explicitly; it does not depend on the extension process cwd. A matching broad rule remains subject to the existing scope and confirmation choices.

Project and global options require a second explicit confirmation for all entry paths: exact key, navigation followed by Enter, and Enter after editing. Session and SSH-session choices remain one-step. Esc while editing resets the uncommitted value; Ctrl-C and timeout abort with the original blocked value.

## Scope and persistence evidence

The executable contracts confirm that:

- a session read choice updates only in-memory allowances, a second access uses that grant, and neither project nor global configuration is created;
- a confirmed in-project project read retains `packages/widget/src/index.ts`, while an outside-project global read is stored canonically and only in the selected file;
- confirmed project domain and global write choices persist to their selected arrays without changing the other config file; and
- the UI presents in-project filesystem targets project-relatively, while the shared writer tests preserve project-relative values and unrelated configuration.

The existing protected configuration writer and hard-deny policy paths remain unchanged. Hard denies do not open a prompt, and no-UI paths return an abort without invoking the UI or persistence seam.

## Timeout and attention evidence

The default timeout remains 600 seconds. Only positive finite values schedule a bounded timer. UI component tests cover countdown expiry, explicit abort, reset, session-only flows, and a custom UI seam that waits past its deadline without opening a component; that no-open path emits no attention. The extension timeout test makes two timed accesses and verifies both remain blocked, no config is written, and initialization/reset counts do not change. `request-attention` is emitted once from the actual custom-prompt component callback, and is not emitted for no-UI or no-open returns. Existing policy/extension hard-deny tests continue to exercise no-prompt behavior.

## Boundaries

The no-open attention contract is intentionally tested at the `ctx.ui.custom` seam: attention is emitted only when the custom component callback is invoked, so this slice does not invent a separate pre-open timer/event lifecycle. This checkpoint does not implement Slice 9b reset-success/initialisation-failure recovery, an explicit unavailable runtime state, replacement recovery, or any other lifecycle redesign. It does not add `/sandbox-allow`, SSH proxy behavior, `sandboxUserShell` bypass, broad sandbox permissions, credential expansion, or the deferred C-13 policy decision.

## Verification record

| Command | Result |
| --- | --- |
| `pnpm exec tsx --test test/ui.test.ts test/config.test.ts test/sandbox-command.test.ts test/policy.test.ts test/extension.test.ts` | Passed: 83 tests, 0 TODOs |
| `TMPDIR=/tmp pnpm exec tsx --test test/ui.test.ts test/config.test.ts test/sandbox-command.test.ts test/policy.test.ts test/extension.test.ts` | Passed: 83 tests, 0 TODOs |
| `pnpm test` | Passed: 156 tests, 155 pass, 1 deferred C-13 TODO |
| `pnpm run check` | Passed |
| `pnpm run lint` | Passed |
| `pnpm run ci:fmt` | Passed |
| `git diff --check` | Passed |
| Local Markdown-link validation for changed docs | Passed: all repository-relative links valid |

No configuration outside disposable project/system temporary directories was changed by the tests; test-created directories were removed by their cleanup paths.
