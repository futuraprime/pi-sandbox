# Upstream 0.6.6 Slice 6a checkpoint

## Scope

Slice 6a closes runtime execution contracts only. It does not change the locked `@carderne/sandbox-runtime` 0.0.70 dependency, policy meanings, Bash prompting, reset/recovery, or macOS acceptance behaviour.

## Evidence

- `createSandboxedBashOps().exec` now scopes `SandboxManager.cleanupAfterCommand()` to a successful runtime wrapper and invokes it from the guarded `finally` path for normal exit, nonzero exit, timeout, abort, and process-creation failures after wrapping.
- A rejected wrapper and an unchanged command skip caller cleanup so the runtime does not decrement another command's active cleanup state. Original execution failures remain the reported failures if cleanup also fails.
- `initializeSandbox()` preserves `allowPty` as `true`, `false`, or omitted through the manager initialization seam.
- Existing inherited-pipe coverage retains early completion for idle descendants and drains active post-exit output; cleanup assertions cover both paths.
- The focused runtime suite reports 23 passing tests, 2 TODOs, and 0 failures. The full direct Node suite reports 119 passing tests, 4 TODOs, and 0 failures.
- The focused tests run on the Darwin host with mocked runtime-manager methods and a project-local non-executable shell fixture for the asynchronous spawn error. They are not macOS Chromium or Git-over-SSH platform-parity evidence.
- TypeScript checking, linting, formatting, and `git diff --check` pass for the current checkout.

## Deferred gates

- **6b / R-02:** Bash write prompting, retry, and output attribution.
- **6c / R-06 and D-06:** sandbox-runtime 0.0.72 comparison, changed defaults, and reset/initialisation-failure recovery assessment.
- **6d / R-07–R-09:** real macOS Chromium and Git-over-SSH acceptance and parity/adaptation decisions.
- C-13 and the two prompt/UI TODOs remain deferred. Mocked runtime tests are not macOS platform-parity evidence.
