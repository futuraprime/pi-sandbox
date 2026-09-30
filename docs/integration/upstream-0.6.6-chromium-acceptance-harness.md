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

All three Chromium launches (enabled worker, disabled worker, and direct-host diagnostic) receive the test-only `--use-mock-keychain` argument. Chromium's own sandbox remains enabled; the harness never passes `--no-sandbox`. This is an isolation attempt, not a guarantee that macOS keychain prompts are suppressed: the Chromium documentation lookup available for this harness returned 404, so behavior is unverified and may vary by Chromium build/platform.

Each worker report includes `generatedSeatbeltProfile` with the inline SBPL content, SHA-256, and capture method. A worker-local observer awaits the original `SandboxManager.wrapWithSandbox()` with its original receiver and arguments, derives the active adapter-augmented profile using the same `augmentMacosBrowserProfile()` function as BashOperations, and returns the original wrapper output unchanged. The regular BashOperations adapter therefore still constructs and executes the command. The report keeps the SBPL after disposable fixture cleanup, but does not retain wrapped commands or proxy environment values. This is a profile derivation from the real wrapper return, not interception of the final `sandbox-exec` argv or independent proof that Seatbelt loaded/enforced that profile.

After the enabled and disabled workers, the harness also makes one **diagnostic-only direct host Chromium launch** using the same binary and launch arguments, sanitized allowlist environment, and a separate disposable home/profile. The parent has already refused `SANDBOX_RUNTIME`, and this launch bypasses only the harness's outer runtime wrapper: Chromium's own sandbox remains enabled (no `--no-sandbox` or weakened sandbox flags). Its version, launch result, DevTools/DOM interpretation, and method are recorded under `hostBaseline`. This result never changes the acceptance verdict: a passing baseline cannot turn a failed enabled/disabled sandbox gate into PASS, and a failing baseline alone does not fail otherwise-passing sandbox gates. Baseline process/profile cleanup failures do fail the overall run.

The report records commands, outputs/results, platform/runtime versions, git commit/status, probe distinctions, and cleanup. It explicitly represents **model-free real-runtime browser/resource evidence only**, not full extension UI, interactive permission, model, Git, or other subsystem acceptance. This command has not been run from the current sandboxed agent; no fresh acceptance pass is claimed until a user runs it on a bare macOS host.
