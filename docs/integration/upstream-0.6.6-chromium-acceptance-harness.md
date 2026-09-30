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

After the enabled and disabled workers, the harness also makes one **diagnostic-only direct host Chromium launch** using the same binary and launch arguments, sanitized allowlist environment, and a separate disposable home/profile. The parent has already refused `SANDBOX_RUNTIME`, and this launch bypasses only the harness's outer runtime wrapper: Chromium's own sandbox remains enabled (no `--no-sandbox` or weakened sandbox flags). Its version, launch result, DevTools/DOM interpretation, and method are recorded under `hostBaseline`. This result never changes the acceptance verdict: a passing baseline cannot turn a failed enabled/disabled sandbox gate into PASS, and a failing baseline alone does not fail otherwise-passing sandbox gates. Baseline process/profile cleanup failures do fail the overall run.

The report records commands, outputs/results, platform/runtime versions, git commit/status, probe distinctions, and cleanup. It explicitly represents **model-free real-runtime browser/resource evidence only**, not full extension UI, interactive permission, model, Git, or other subsystem acceptance. This command has not been run from the current sandboxed agent; no fresh acceptance pass is claimed until a user runs it on a bare macOS host.
