# Upstream 0.6.6 Slice 7 checkpoint: scoped Chromium adaptation

- **Proposal:** [`proposal-integrate-upstream-0.6.6.md`](../proposals/proposal-integrate-upstream-0.6.6.md)
- **Feature ledger:** [`upstream-0.6.6-feature-ledger.md`](upstream-0.6.6-feature-ledger.md)
- **Slice:** 7 — scoped Chromium adaptation
- **Baseline:** Slice 6d acceptance, stock `@carderne/sandbox-runtime@0.0.72`
- **Decision:** bounded approval of the 0.0.72 dependency with a consumer-side macOS browser-profile adapter; fresh bounded network regressions passed

## Design and distribution strategy

Slice 6d established a concrete failure in stock 0.0.72: an enabled Chromium process could start but could not create its profile socket directory. Its generated macOS Seatbelt profile omitted the downstream browser capabilities for `kern.hv_vmm_present`, loopback binding/inbound traffic, and Darwin per-user-temporary resources. The disabled path remained narrow and failed closed.

The smallest adaptation is owned by this consumer in `src/sandbox-runtime.ts`, immediately after `SandboxManager.wrapWithSandbox()` returns its generated command. `augmentMacosBrowserProfile()` only recognizes the stock 0.0.72 generated inline macOS browser profile, only runs on Darwin with `allowBrowserProcess`, and is idempotent. It adds:

- `sysctl-read` for `kern.hv_vmm_present`;
- loopback `network-bind` and `network-inbound`;
- loopback-only `network-outbound` to `localhost:*`;
- `AF_UNIX` system-socket creation;
- bind and outbound access under the real Darwin user-temp directory; and
- file read/write under that same temp directory.

It does not add `allowAllUnixSockets`, a root-matching Unix-socket rule, unrestricted outbound access, or any network/proxy/SSH-agent implementation. Unrelated profiles are unchanged, and the existing wrapped command quoting is preserved. The adapter is consumer source, not a runtime package patch, vendored runtime, postinstall hook, or broad configuration workaround. The tracked `sandbox.json` and README no longer recommend local binding or all Unix sockets for browser use.

## Dependency provenance

`package.json` pins the exact upstream runtime version `0.0.72`; the importer and package entry in `pnpm-lock.yaml` resolve the same exact version with this npm base integrity:

```text
sha512-7GI5hDQ7vUHdkVsHHZ76kbVTzy2Wt0twcQhUDVpGG5mgn5vENpWXImU8kKFf+YifDHn7nSoltCqa1RAqZZbVtw==
```

The clean consumer-install proof used the packed pi-sandbox artifact, an isolated package-manager cache and consumer directory, and `--ignore-scripts`/no project mutation. It verified that the packed source carried the adapter, the clean consumer resolved `@carderne/sandbox-runtime@0.0.72` with the expected integrity, and the packed consumer had no broad Unix-socket grant. This proof was completed before this checkpoint and the implementation was not changed after packaging, so it was not needlessly repeated here. The final package/lock/installed-tree checks below independently verify the exact local resolution.

## Red/green evidence

The Slice 6d real enabled-browser gate was red against stock 0.0.72. With no broad Unix-socket allowance, Chromium exited `21` after reporting failure to create its ProcessSingleton/socket directory; direct runtime probes also received `EPERM` for temp-file access, loopback bind, and a Darwin user-temp Unix socket. The generated stock profile lacked the required scoped markers.

After the consumer adapter was applied, `node --import tsx --test test/browser-process.test.ts` passed all five tests. Those tests verify the exact sysctl, loopback, temp-file, and temp-socket grants; absence of root/broad Unix-socket access and literal escaped newlines; idempotence and command preservation; unrelated-profile no-op; disabled-mode absence; and runtime config propagation.

The real macOS enabled Chromium rerun then reached a live DevTools endpoint and created disposable profile state. Enabled canonical Darwin temp-file, loopback, and scoped AF_UNIX probes passed. The disabled Chromium rerun exited `21` with ProcessSingleton/socket-directory denial, and disabled probes returned `EPERM`. No broad Unix-socket grant was used. All browser processes, disposable profiles, probe files, and runtime artifacts were removed.

A compiled direct `sysctlbyname` probe also passed for `kern.hv_vmm_present` under the augmented profile; the same probe for `hw.ncpu` passed under the stock profile. The host command `/usr/sbin/sysctl -n kern.hv_vmm_present` succeeds. Running `/usr/sbin/sysctl` inside the sandbox reports `EPERM`, but that utility performs a different denied operation; this CLI result is therefore documented as unavailable for validating this grant, not as evidence that the direct `sysctlbyname` grant failed.

## Network rerun classification

The initial full-manager rerun was inconclusive because the candidate manager was launched inside the already-active outer sandbox. Its internal mux attempted to bind `/tmp/claude/srt-mux-*.sock`, and that nested Unix-socket bind was correctly denied by the outer policy. This was a harness limitation, not candidate egress evidence.

A fresh bounded rerun then exercised the installed 0.0.72 network components through the active parent proxy without broadening the outer sandbox:

- parent-proxy CONNECT, TLS, and an HTTP request to `example.com` completed with HTTP `200`;
- the authenticated runtime HTTP proxy returned `200`, while the same request without credentials was rejected with `407`;
- a denied HTTP domain was rejected with `403`;
- BSD `/usr/bin/nc` completed through unauthenticated SOCKS when compatibility was enabled;
- BSD `nc` failed authentication negotiation when SOCKS authentication was required;
- the SOCKS filter rejected a denied domain; and
- after exact SSH-agent approval, read-only `git ls-remote` through BSD `nc` completed and returned `HEAD` using disposable SSH configuration and known-hosts material.

These are fresh passes for the 0.0.72 parent-proxy, HTTP-proxy, SOCKS, domain-filtering, SSH-agent, and Git path components. Slice 6d remains the prior full standalone-manager acceptance record. The current extension wrapper's disposable-known-hosts limitation is unchanged: its generated wrapper still does not itself provide `UserKnownHostsFile`/`-F /dev/null`, so the fresh Git probe supplied those options through a disposable `GIT_SSH_COMMAND`. No remote write was attempted, and no user SSH configuration, known-hosts file, agent state, credentials, or proxy configuration was changed.

## Boundaries and cleanup

This slice does not implement credentials, C-13, upstream SSH proxy product behavior, lifecycle recovery, prompt/UI work, or any broad permission. Slice 8 owns credential masking. Slice 9 owns editable prompts, attention/timeout integration, extension lifecycle recovery, stale readiness handling, and the reset-success/replacement-init-failure boundary. The three existing TODO gates remain deferred. The SSH known-hosts limitation is retained rather than worked around.

The browser and network probes used disposable paths and bounded process groups. Final cleanup checks found no project-local slice directories, tarballs, browser or proxy processes, Darwin probe artifacts, modified user/agent state, or generated project artifacts.

## Final verdict

The conditional Slice 7 exit condition is met. The exact 0.0.72 runtime is approved for this bounded integration **with** the consumer-side scoped Chromium adapter. Approval is based on packed-consumer proof, exact profile contracts, real enabled/disabled Chromium and resource enforcement, direct `sysctlbyname` capability evidence, absence of broad grants, the fresh bounded network/SSH regressions above, and the full verification suite below. Slice 6d remains the prior full standalone-manager acceptance record.

Residual risks are the extension wrapper's disposable-known-hosts limitation and the already-deferred Slice 9 lifecycle recovery and Slice 8 credential work. The full-manager rerun cannot be nested under the active outer sandbox without granting its internal mux socket, but the fresh component checks and prior Slice 6d acceptance cover the unchanged network paths. The adapter's profile-shape recognition is deliberately narrow; a future runtime profile-format change should fail to adapt rather than widen permissions and must receive a new compatibility review.

## Verification record

The final commands and observed results are:

| Command | Result |
| --- | --- |
| `node --import tsx --test test/browser-process.test.ts` | 5 passing, 0 failing |
| `node --import tsx --test test/**/*.test.ts` | Full direct Node suite passed; 3 TODOs remain explicit |
| `pnpm run check` | Passed |
| `pnpm run lint` | Passed |
| `pnpm run ci:fmt` | Passed |
| `git diff --check` and explicit trailing-whitespace checks | Passed |
| Local Markdown link check | Passed for repository-relative Markdown links |
| Package/lock/installed metadata and integrity inspection | Exact `0.0.72` and the integrity above |
| Pack/clean-consumer inspection | Prior proof passed; no implementation changes occurred afterward |
| Bounded 0.0.72 network regressions | Parent CONNECT/TLS/HTTP, authenticated HTTP proxy separation, domain denial, BSD `nc` SOCKS compatibility, exact agent approval, and read-only Git-over-SSH passed |
| Process/artifact cleanup inspection | No project temp/tarball/browser/proxy process or Darwin probe artifact remained |
