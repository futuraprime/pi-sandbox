# Upstream 0.6.6 Slice 6b checkpoint

## Scope

Slice 6b closes R-02 for Bash write policy, prompting, retry, and output attribution. It does not change the locked `@carderne/sandbox-runtime` 0.0.70 dependency, C-13 read/write meaning, SSH policy, reset/recovery, or macOS acceptance behaviour.

## Evidence

- Direct Bash redirection and nested `bash -c` failure fixtures are attributed through `parseFallbackDiagnosticFromOutput()` and reclassified by `finalizeDiagnostic()` using the shared specificity-aware path policy.
- Extension contracts use the actual `user_bash` hook, with a default-allowed target and a shared direct/nested matrix for hard denies, equal-specificity deny precedence, and strictly more-specific allow exceptions. Each classification asserts the write diagnostic, no prompt, and no retry; unmatched nested writes remain promptable.
- A session write approval refreshes the runtime (`reset` then replacement `initialize` with the approved target) before the retry. The focused contract asserts the exact `wrap -> reset -> initialize -> wrap` event order. A failed refresh does not retry and rolls back the newly added session allowance. Abort and no-UI paths add no allowance, do not refresh, and do not retry.
- Session write allowances remain in the extension closure only; the focused contract checks that the project configuration does not receive the session target. A failed refresh is retried as a fresh approval on the next operation, and duplicate-violation coverage confirms the same violation prompts only once after a retry.
- Registered agent Bash coverage verifies successful retry results retain raw diagnostic attribution and final success details. Failed retries retain the final failure block in the tool error. `user_bash` coverage verifies compact visible notices, invisible metadata, successful retries, failed retries, and duplicate-prompt suppression.
- The R-02 TODO in `test/sandbox-runtime.test.ts` is replaced with direct and nested Bash redirection execution fixtures. These use harmless local shell output and mocked runtime wrapping; they are not evidence of real OS sandbox enforcement.
- `extractBlockedWritePath()` remains a limited, test-only runtime helper and is not used by the extension diagnostic flow; no parser broadening was needed.
- Focused affected suites (`test/extension.test.ts`, `test/diagnostics.test.ts`, `test/policy.test.ts`, and `test/sandbox-runtime.test.ts`) report 80 passing tests, 1 TODO, and 0 failures. The full direct Node suite reports 125 passing tests, 3 TODOs, and 0 failures.
- `pnpm run check`, `pnpm run lint`, `pnpm run ci:fmt`, and `git diff --check` pass. Formatting and lint output may include the repository's existing pnpm override warning; no dependency or lockfile changes were made.

## Deferred gates

- **6c / R-06 and D-06:** comparison with sandbox-runtime 0.0.72, changed defaults, and reset/initialisation-failure recovery assessment. Runtime dependencies remain at the locked 0.0.70 baseline.
- **6d / R-07–R-09:** real macOS scoped Chromium and Git-over-SSH acceptance, including unauthenticated SOCKS compatibility, domain filtering, and separate SSH-agent approval.
- **C-13** and the two prompt/UI TODOs remain deferred. Slice 6b closes only R-02; mocked runtime tests do not replace platform acceptance.
