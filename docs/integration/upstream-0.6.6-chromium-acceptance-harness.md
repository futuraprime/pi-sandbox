# Fresh Chromium acceptance harness

From a normal macOS host Terminal, in the repository root, run:

```sh
pnpm exec tsx scripts/chromium-acceptance.ts
```

The harness refuses non-Darwin hosts and any environment where `SANDBOX_RUNTIME` is set. **Do not unset or bypass `SANDBOX_RUNTIME` to force a run from a sandboxed agent; run this only from a normal host Terminal.** The repository root is resolved from the script location, not the caller's working directory. It runs the actual `initializeSandbox()` and `createSandboxedBashOps()` seams with `SandboxManager`, in fresh enabled and disabled worker processes. Each worker receives a disposable `HOME` and `PI_CODING_AGENT_DIR`, a narrow explicit credential-free config, and no inherited SSH agent or ambient credential variables. Chromium defaults to `/Applications/Chromium.app/Contents/MacOS/Chromium`; use `--chromium /validated/path/to/Chromium` for another executable. To preserve a report under the existing ignored `tmp/` directory, choose a new path, for example:

```sh
pnpm exec tsx scripts/chromium-acceptance.ts --report "tmp/chromium-acceptance-$(date +%Y%m%d-%H%M%S).json"
```

The enabled run requires Chromium's DevTools launch marker and `about:blank` DOM, plus allowed canonical Darwin user-temp file, ephemeral loopback-bind, and scoped user-temp AF_UNIX probes. The disabled run requires Chromium to fail for a recognizable sandbox/resource reason and all three resource probes to report `EPERM`/`EACCES`; timeouts and unrelated startup errors fail. No external URL is contacted. Per-command output is bounded and truncation is reported. Only unique harness-owned fixture/probe paths and Chromium PIDs bearing the disposable profile argument are cleaned; surviving browser processes or cleanup failures fail acceptance.

The harness also needs the host's existing `/usr/bin/clang`, macOS SDK headers, and system `libsandbox` linker stub; it does not install dependencies. On the guarded normal host it compiles one fixed, fixture-only C probe that calls `sandbox_init(kSBXProfilePureComputation, SANDBOX_NAMED, &errorbuf)`. The exact same executable is run once directly on the host and once through each enabled/disabled worker's real `createSandboxedBashOps()` path. Workers receive read access only to that exact fixture executable—no broader fixture-root or SDK/compiler grant. The probe immediately `_exit(0)` on successful initialization without stdio/allocation; failures capture `errno` immediately and report the return value, errno, and sandbox error text before freeing it, then use a dedicated nonzero exit status. The report records the fixed compiler command, profile, API, compilation result, host result, and each worker result/classification. Missing/failed compilation is explicitly `diagnostic-unavailable`; execution failures and timeouts are not mistaken for an initialization refusal. This additional diagnostic does not affect the browser/resource acceptance verdict. Host success paired with worker `EPERM` is evidence that the worker context refuses nested `sandbox_init` and a possible explanation for Chromium sandbox-init failures, not proof of Chromium's cause. No sandbox flags are weakened and Chromium's own sandbox remains enabled.

All three Chromium launches (enabled worker, disabled worker, and direct-host diagnostic) receive the test-only `--use-mock-keychain` argument. Chromium's own sandbox remains enabled; the harness never passes `--no-sandbox`. This is an isolation attempt, not a guarantee that macOS keychain prompts are suppressed: the Chromium documentation lookup available for this harness returned 404, so behavior is unverified and may vary by Chromium build/platform.

Each worker report includes `generatedSeatbeltProfile` with the inline SBPL content, SHA-256, and capture method. A worker-local observer awaits the original `SandboxManager.wrapWithSandbox()` with its original receiver and arguments, derives the active adapter-augmented profile using the same `augmentMacosBrowserProfile()` function as BashOperations, and returns the original wrapper output unchanged. The regular BashOperations adapter therefore still constructs and executes the command. The report keeps the SBPL after disposable fixture cleanup, but does not retain wrapped commands or proxy environment values. This is a profile derivation from the real wrapper return, not interception of the final `sandbox-exec` argv or independent proof that Seatbelt loaded/enforced that profile.

After the enabled and disabled workers, the harness also makes one **diagnostic-only direct host Chromium launch** using the same binary and launch arguments, sanitized allowlist environment, and a separate disposable home/profile. The parent has already refused `SANDBOX_RUNTIME`, and this launch bypasses only the harness's outer runtime wrapper: Chromium's own sandbox remains enabled (no `--no-sandbox` or weakened sandbox flags). Its version, launch result, DevTools/DOM interpretation, and method are recorded under `hostBaseline`. This result never changes the acceptance verdict: a passing baseline cannot turn a failed enabled/disabled sandbox gate into PASS, and a failing baseline alone does not fail otherwise-passing sandbox gates. Baseline process/profile cleanup failures do fail the overall run.

Workers return structured results through mode-0600 fixture files independently of bounded stdout/stderr diagnostics. Result files are limited to 8 MiB and validated before use; missing, malformed, oversized, or wrong-mode results fail acceptance. Process-list inspection has a separate bounded 8 MiB capture budget; overflow still fails cleanup verification rather than implying no browser processes remain.

The report records commands, outputs/results, platform/runtime versions, git commit/status, probe distinctions, and cleanup. It explicitly represents **model-free real-runtime browser/resource evidence only**, not full extension UI, interactive permission, model, Git, or other subsystem acceptance. This command must be run from a normal host Terminal; no fresh acceptance pass is claimed until a user-run report establishes it.

## 2026-10-15 attempt and harness correction

The user-run report `tmp/chromium-acceptance-20261015-235728.json` at `c5e7031392dc2c5d19fb8dc513de8a80c48f4b89` recorded **FAIL** on Darwin/arm64 (Node 22.22.2, runtime 0.0.72, Chromium 154.0.8037.97). Both worker results were malformed, so no browser/resource probes were available. Cleanup inspections failed with `/bin/ps ENOBUFS`; empty PID arrays do not establish cleanup. Fixture and temporary probe artifact removal were reported successful. The diagnostic direct-host launch produced DOM and DevTools markers but timed out; its exit code 0 does not override that timeout.

Source inspection found structured results (including full generated SBPL) shared a 256 KiB stdout capture budget and process inspection also used a 256 KiB limit. The report does not retain enough worker output to prove the precise malformed-result cause. The harness now separates result transport from diagnostic capture and increases the bounded process-inspection budget without changing sandbox permissions, ownership matching, acceptance gates, or timeout semantics.

Implementation-agent verification after the correction: focused harness tests passed 20/20; TypeScript, lint, and formatting checks passed. Regressions cover large generated profiles alongside truncated diagnostics, invalid/oversized/mismatched/symlink results, mode-0600 files, and actual bounded subprocess capture above 256 KiB with explicit overflow failure. The coordinating session's focused verification attempt was blocked before execution by `ERR_PNPM_LOCKFILE_READ_FILE` / `Operation not permitted`; its `git diff --check` passed. Subsequent user-run `pnpm run ci:fmt && pnpm run ci:lint && pnpm run ci:check && pnpm run ci:test` from this checkout with the uncommitted harness correction passed: formatting, lint (0 warnings/errors), TypeScript, and 225 tests total, 222 passed, 0 failed, 3 intentional credential-CLI skips; test duration was 20.294 seconds.

The fresh rerun `tmp/chromium-acceptance-20261016-003849.json` (23:38:49–23:39:27 UTC on 2026-10-15; same host/runtime/browser, base commit `c5e7031` plus uncommitted harness/docs changes) still records **FAIL**, now with valid worker results and no cleanup failures. Both workers initialized/reset and captured generated profiles. All three enabled resource probes succeeded; disabled probes were explicitly denied, and disabled Chromium failed with a socket-directory denial as expected. Enabled Chromium exited 133 without DOM, repeatedly reporting `sandbox initialization failed: Operation not permitted` and GPU/network child crashes. The nested diagnostic succeeded on the host but returned `init-refused-EPERM` in both workers; that supports nested sandbox initialization refusal as a possible explanation, not proof of Chromium's cause. The diagnostic host baseline produced DOM/DevTools but again timed out. Browser acceptance remains blocked; the harness capture/inspection errors did not recur. No sandbox permission changes or timeout relaxation were made.

### Host nesting diagnostic

The user subsequently ran the following from a normal macOS Terminal, without changing project policy:

```sh
/usr/bin/sandbox-exec -p '(version 1) (allow default)' /usr/bin/true
/usr/bin/sandbox-exec -p '(version 1) (allow default)' /usr/bin/sandbox-exec -p '(version 1) (allow default)' /usr/bin/true
```

The single wrapper exited 0. The nested wrappers printed `sandbox-exec: sandbox_apply: Operation not permitted` and exited 71. Thus even permissive nested Seatbelt wrappers fail on this host, independently of this fork's generated filesystem/network rules. Alongside the harness's nested-init EPERM results, this strengthens the nesting-incompatibility explanation; it does not prove every Chromium failure path or universal macOS behavior.

Historical evidence also limits the earlier success claim: Slice 7 established DevTools startup and resource access, not DOM rendering with Chromium's own sandbox. The [Playwright evidence](upstream-0.6.6-playwright-acceptance.md) records an earlier own-sandbox Chromium 152 exit 133 and passing Playwright launches with explicit `--no-sandbox`. The current Chromium 154 failure is therefore not newly observed, but a matched live comparison against downstream `main` has not established complete parity. No automatic browser flag injection, outer-sandbox bypass, or acceptance-gate waiver is authorized.

## 2026-10-16 nesting diagnosis

### Version-matched Chromium source

Inspected at Chromium tag `154.0.8037.97`, matching the installed browser:

- `chrome/app/chrome_exe_main_mac.cc` (helper `main`, lines 164–174): when `--seatbelt-client=<fd>` is present, the helper calls `SeatbeltExecServer::InitializeSandbox()` before Chromium startup and otherwise calls `FatalError("Failed to initialize sandbox.")`, which aborts.
- `sandbox/mac/seatbelt_exec.cc` / `sandbox/mac/sandbox_serializer.cc` (`ApplySerializedPolicy`, lines 194–225): the policy received from the browser is applied with `sandbox_apply` (compiled mode) or `sandbox_init_with_parameters` (source mode).
- `content/app/content_main_runner_impl.cc` (lines 1098–1101): sandboxed process types then `CHECK(sandbox::Seatbelt::IsSandboxed())`.
- No flag or fallback skips self-application for sandboxed helper types other than `--no-sandbox`, which remains rejected.

Apple DTS forum guidance gathered by a separate research pass ([706390](https://developer.apple.com/forums/thread/706390), [112800](https://developer.apple.com/forums/thread/112800)) states that children inherit their parent's sandbox and a process cannot change its sandbox. Homebrew ([homebrew-core#153931](https://github.com/Homebrew/homebrew-core/pull/153931)) and Codex ([openai/codex#26262](https://github.com/openai/codex/issues/26262)) report the same nested `sandbox_apply: Operation not permitted`. Apple does not specify this behavior; no supported SBPL rule, API, flag, or entitlement permitting a second sandbox was found.

### User-run diagnostics

Run from a normal macOS Terminal on the same host and Chromium. Disposable homes and profiles were created under ignored `tmp/chromium-diag.vFJ2iX/`, the environment was reduced with `env -i`, and no external URL was contacted. Launch arguments were `--headless=new --disable-gpu --use-mock-keychain --no-first-run --no-default-browser-check --enable-logging=stderr --dump-dom about:blank` with a disposable `--user-data-dir`; neither `--remote-debugging-port` nor `--no-sandbox` was passed.

| Probe | Result |
|---|---|
| `sandbox-exec -n no-internet /usr/bin/true` | exit 0 |
| same, nested under `sandbox-exec -p '(version 1) (allow default)'` | `sandbox-exec: sandbox_apply: Operation not permitted`, exit 71 |
| Chromium directly on host | Printed `<html><head></head><body></body></html>`; did not exit until interrupted (Ctrl-C), then exit 0 |
| Chromium under `sandbox-exec -p '(version 1) (allow default)'` | No DOM; repeated `sandbox initialization failed: Operation not permitted` and `Failed to initialize sandbox.`; `GPU process exited unexpectedly: exit_code=6` three times, network service crashes; `FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:417 GPU process isn't usable. Goodbye.`; trace trap, exit 133 |

### Conclusions

- Nesting is refused for inline and named profiles even when the outer profile is `(allow default)`. Chromium under a fully permissive outer profile reproduces the acceptance failure exactly (helper aborts, GPU exit 6, browser `FATAL`/SIGTRAP 133). The failure is therefore independent of this fork's filesystem, network, Mach, or browser-mode grants, and no outer-profile grant can fix it.
- The enabled-mode acceptance gate (own-sandbox Chromium DOM inside the Pi sandbox) cannot be met by the current architecture on this host. This is recorded as a blocker, not waived or passed.
- Direct-host non-exit: version 154 keeps headless browsers alive when `--remote-debugging-port` is present (`chrome/browser/devtools/chrome_devtools_manager_delegate.cc`, lines 194–204), but the browser also failed to exit without that switch. The direct-host timeout cause therefore remains unexplained, and the harness baseline is unchanged.
- Which of the two Chromium apply paths produced the EPERM was not confirmed.

### Comparison with downstream `main`

Downstream `main` (`757f058`) pins `@carderne/sandbox-runtime` at `github:futuraprime/sandbox-runtime#ff3accf118d91af1c6880738a22f226422a6b15f`.

- **Source check (user-run).** A normal-Terminal `grep` of that fork's installed `dist/sandbox/macos-sandbox-utils.js` found no `no-sandbox` exemption. The only exec rule is an unconditional `(allow process-exec)`, so every child inherits the outer profile. Browser mode in the fork grants the same kinds of resources as this branch's consumer adapter: `kern.hv_vmm_present`, loopback binding, and a browser temp directory.
- **Live launch (user-run).** Chromium was launched as a sandboxed `!` command in a Pi session using `main`'s extension with `allowBrowserProcess` enabled. Arguments were the same as the diagnostics above, with a disposable `$TMPDIR` profile that was removed afterwards, a 30-second kill, no `--no-sandbox`, and no external URL. Result: `Trace/BPT trap: 5`, exit 133, no DOM, 17 `Failed to initialize sandbox` lines, and the GPU `Goodbye` fatal.

The failure on `main` is the same, so the Chromium blocker is **not a regression** from `main`.

### Decisions (2026-10-16)

- The user rules out `allowBrowserProcess` as a route for Chromium support because its grants are too broad for every sandboxed command. The [browser permission boundary](../proposals/proposal-browser-permission-boundary.md) stub records this decision; no code change is authorized by it.
- A planned LaunchServices/Mach escape probe for browser mode was dropped as a consequence.
- A draft [sandboxed browser test broker proposal](../proposals/proposal-sandboxed-browser-test-broker.md) records the candidate architecture. It authorizes no implementation.
