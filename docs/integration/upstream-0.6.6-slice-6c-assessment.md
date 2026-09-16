# Upstream 0.6.6 runtime assessment (Slice 6c)

- **Proposal:** [`proposal-integrate-upstream-0.6.6.md`](../proposals/proposal-integrate-upstream-0.6.6.md)
- **Feature ledger:** [`upstream-0.6.6-feature-ledger.md`](upstream-0.6.6-feature-ledger.md)
- **Slice:** 6c — sandbox-runtime 0.0.70/0.0.72 comparison and lifecycle assessment
- **Status:** assessment complete; the 0.0.72 upgrade is **not approved**
- **Acceptance platform:** macOS

## Decision

Slice 6c does not approve replacing the currently resolved sandbox-runtime 0.0.70 with 0.0.72. The source comparison finds that the downstream Chromium policy is not present in stock 0.0.72. The 0.0.72 API and credential capability are useful follow-up inputs, but they do not establish compatibility with this extension's scoped Chromium policy or macOS Git-over-SSH workflow.

Slice 6d remains outstanding. It must provide real macOS acceptance evidence for scoped Chromium and Git-over-SSH, plus a safe reset/reinitialisation failure probe where the environment permits. Conditional Slice 7 adaptation is therefore recommended if those gates confirm that the missing Chromium policy must be ported or the existing runtime must be retained. Any changed 0.0.72 defaults or API behaviour must be reviewed explicitly rather than inherited incidentally. No dependency or lockfile change is part of this assessment.

This is a source and safe-probe assessment, not a claim of real platform parity. Passing source checks or mocked/runtime-fixture tests cannot substitute for the macOS gates in [the 6d checklist](#slice-6d-acceptance-checklist).

## Evidence classes and reproducibility

The conclusions below separate three evidence classes:

1. **Immutable source/package evidence** — pinned commits, package metadata, lock entries, npm integrity values, and source diffs.
2. **Safe configuration/state probes** — read-only or non-destructive manager/configuration observations on macOS.
3. **Unverified real macOS acceptance** — Chromium process/sysctl/loopback/temp-resource enforcement and Git-over-SSH proxy behaviour. These remain 6d work and are not claimed here.

The commands and locations below avoid recording ephemeral install or temporary-directory paths.

| Evidence | Reproducible method | Class | Result |
| --- | --- | --- | --- |
| Declared runtime range and resolution | Inspect `package.json`, `pnpm-lock.yaml`, and the installed package metadata under `node_modules/@carderne/sandbox-runtime` | Immutable package evidence | The package declares `@carderne/sandbox-runtime` `^0.0.70`; the lock and installed tree resolve stock npm `0.0.70`, not the historical Git fork. |
| Historical downstream runtime | Inspect the dependency reference and lock metadata for `github:futuraprime/sandbox-runtime#ff3accf118d91af1c6880738a22f226422a6b15f` | Immutable package evidence | This is the historical downstream origin dependency, not the currently resolved package. |
| Historical archive | Recreate the codeload archive for commit `ff3accf118d91af1c6880738a22f226422a6b15f` and hash the archive using the recorded archive method | Immutable package evidence | `sha512-DwCsU5D616vmo+uW/AhlcLka6e2uA2Jf5CAZ7HWUtnCj3RF4pruis6FjHR4wslaq0L1mfScoIxOvpG11cu//Dg==` |
| Historical npm Git lock | Inspect the historical npm Git-lock integrity field for the same fork ref | Immutable package evidence | `sha512-TfLa7/3NUptpEqVFw2wfhffhhhXYXgWmOiQu2xGYCLWrY73RtmSlnivkIDFBLKkujS0mxVrpEya1Y9jP6CsAIg==` |
| Upstream runtime refs | Compare sandbox-runtime commits [`476bf986ef63410b61febf879a6f1a46b7898d5f`](https://github.com/carderne/sandbox-runtime/commit/476bf986ef63410b61febf879a6f1a46b7898d5f) and [`dea3f1a241c189f0f954ac989dfc2c2a95b64c39`](https://github.com/carderne/sandbox-runtime/commit/dea3f1a241c189f0f954ac989dfc2c2a95b64c39) | Immutable source/package evidence | These are the upstream 0.0.70 and 0.0.72 commits. The npm 0.0.72 integrity is `sha512-7GI5hDQ7vUHdkVsHHZ76kbVTzy2Wt0twcQhUDVpGG5mgn5vENpWXImU8kKFf+YifDHn7nSoltCqa1RAqZZbVtw==`. |
| Manager state | Run the installed manager's support/configuration/readiness probe on Darwin without changing the project configuration | Safe configuration/state probe | Darwin is supported, but the initially created manager is uninitialised: `enabled` is false, config/proxy ports are undefined, and network initialisation is false. |

The two historical fork hashes are intentionally both retained for provenance. The codeload value is an archive checksum, while the npm Git-lock value is a Git-package lock serialization integrity. They come from different serialization methods and are not expected to equal; neither value is presented as verifying the other.

## Runtime provenance and source comparison

### Current versus historical dependency

The current package and lock state resolve stock npm 0.0.70. The historical downstream fork was pinned to the immutable Git commit `ff3accf118d91af1c6880738a22f226422a6b15f`, whose Chromium changes are the downstream compatibility baseline. The current resolution must not be described as preserving those fork patches merely because its semver range begins at 0.0.70.

The upstream 0.0.72 package is independently identified by its npm integrity above and by commit `dea3f1a241c189f0f954ac989dfc2c2a95b64c39`. These identifiers establish provenance; they do not establish behavioural parity.

### Scoped Chromium policy

The source diff for the historical fork is limited to macOS Chromium profile permissions; it does not establish parity for the other runtime products below. Its fork-only changes are narrowly scoped to the following capabilities:

- `kern.hv_vmm_present` sysctl access;
- loopback binding initiated by the browser process;
- Darwin per-user-temporary-directory Unix-socket access; and
- Darwin per-user-temporary-directory file access.

The exact local evidence anchors are the downstream [`8766244dd52655903671fc8e9bec25417a33d883`](https://github.com/futuraprime/pi-sandbox/commit/8766244dd52655903671fc8e9bec25417a33d883) regression fixture at `browser-process.test.ts`, which calls `generateSandboxProfile` from `@carderne/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js`, and the pinned runtime source symbol [`src/sandbox/macos-sandbox-utils.ts:generateSandboxProfile`](https://github.com/futuraprime/sandbox-runtime/blob/ff3accf118d91af1c6880738a22f226422a6b15f/src/sandbox/macos-sandbox-utils.ts). Its positive profile assertions include `(sysctl-name "kern.hv_vmm_present")`, loopback `network-bind`, AF_UNIX system sockets, and `DARWIN_USER_TEMP_DIR`-scoped bind/read/write rules; its negative assertion rejects an all-path Unix-socket rule. The extension-side config seam is [`src/sandbox-runtime.ts`](../../src/sandbox-runtime.ts), `buildRuntimeConfig()`, where browser mode is passed as `allowBrowserProcess` and configured Unix sockets remain an explicit list.

The fork avoids broad `allowAllUnixSockets`. Stock sandbox-runtime 0.0.70 and 0.0.72 `src/sandbox/macos-sandbox-utils.ts:generateSandboxProfile` source profiles both lack these fork Chromium markers. Therefore source evidence indicates that stock 0.0.72 does **not** preserve scoped Chromium parity. This is not a claim that either profile was successfully enforced by a real Chromium launch on this host; that is a 6d gate.

The historical dependency itself is pinned by [`ff3accf118d91af1c6880738a22f226422a6b15f`](https://github.com/futuraprime/sandbox-runtime/commit/ff3accf118d91af1c6880738a22f226422a6b15f). Slice 7 must port only the minimum scoped policy required by the 6d failures, or explicitly retain/defer the runtime upgrade if that policy cannot be reproduced safely.

### 0.0.70 to 0.0.72 changes

The tag comparison shows these material runtime changes:

- public API additions `createSandboxManager` and `ISandboxManager`;
- lifecycle/reset changes; and
- Linux mount-point cleanup changes.

The named source anchors for the compared areas are [`src/sandbox/macos-sandbox-utils.ts`](https://github.com/carderne/sandbox-runtime/blob/dea3f1a241c189f0f954ac989dfc2c2a95b64c39/src/sandbox/macos-sandbox-utils.ts) (`generateSandboxProfile`), `src/sandbox/sandbox-config.ts` (network and credential schemas), `src/sandbox/sandbox-manager.ts` (`initialize`, `reset`, and proxy startup), `src/sandbox/credential-extract.ts`, `src/sandbox/credential-mask-env.ts`, and `src/sandbox/credential-mask-files.ts`. These named macOS, proxy, credential, and configuration source files were unchanged in this exact tag diff. This statement is limited to those named files and this exact diff; it does not claim that the complete runtime artifacts or platform behaviour are identical.

The current extension already passes `allowPty`, and Slice 6a covers that integration. The runtime comparison does not alter the completed 6a/6b conclusions, and it does not resolve C-13 or the two remaining prompt/UI TODOs.

## SSH, proxy, and domain controls

The relevant behaviours must remain distinct:

- pi-sandbox's macOS shell `ProxyCommand` uses `/usr/bin/ssh` and `/usr/bin/nc` to connect through the local SOCKS proxy;
- the runtime's unauthenticated SOCKS compatibility mode supports BSD `nc`, which cannot authenticate to the runtime SOCKS5 proxy;
- HTTP proxy authentication is a separate capability and must remain intact;
- domain allow/deny filtering is a separate policy decision; and
- `SSH_AUTH_SOCK` uses separate path-scoped approval rather than a broad socket grant.

Stock 0.0.72 retains the optional `allowUnauthenticatedSocksProxy` field in `src/sandbox/sandbox-config.ts:NetworkConfigSchema`; `src/sandbox/sandbox-manager.ts:startMuxProxyServer` uses the authenticated token unless that field is explicitly true, so omission remains disabled. The pi-sandbox default in [`src/config.ts`](../../src/config.ts), `DEFAULT_CONFIG.network`, explicitly sets it true on Darwin. The extension's [`buildRuntimeConfig()`](../../src/sandbox-runtime.ts) spreads `config.network` into the runtime network config, so the configured compatibility flag can reach the runtime seam. These are source facts, not Git-over-SSH acceptance evidence: 6d must exercise BSD `nc`, proxy negotiation, allowed and denied domains, HTTP proxy authentication, and SSH-agent approval on macOS.

Upstream's optional SSH proxy product remains unresolved under O-03. This assessment neither adopts nor rejects that separate proxy design and does not treat it as a substitute for the downstream unauthenticated-SOCKS compatibility path.

## Credentials: capability present, not exposed

Sandbox-runtime 0.0.72 provides capability for:

- environment-variable `deny` and `mask` modes in `src/sandbox/sandbox-config.ts:CredentialEnvVarConfigSchema` and `src/sandbox/credential-mask-env.ts`;
- `injectHosts` scoping for proxy-mediated substitution;
- structured extraction and `onExtractNoMatch` handling in `src/sandbox/sandbox-config.ts:CredentialFileConfigSchema` / `CredentialEnvVarConfigSchema` and `src/sandbox/credential-extract.ts`; the schema accepts `"warn"`, `"deny"`, and `"error"`, with fail-open `"warn"` as the default, so the downstream target must select `"deny"` or `"error"`; and
- platform-specific credential-file handling in `src/sandbox/credential-mask-files.ts`, where macOS file masking degrades to deny.

The current extension's [`buildRuntimeConfig()`](../../src/sandbox-runtime.ts) omits `credentials`, so the extension does not expose this capability. Slice 8 remains required. No credential values should enter pi-sandbox configuration, ordinary permission prompts, or `/sandbox` persistence.

The eventual macOS target remains fail-closed: environment masking must use explicit host-scoped injection, structured extraction must use `onExtractNoMatch: "deny"` or `"error"`, and credential files must degrade to deny on macOS because file masking is Linux-only in 0.0.72. These are target requirements, not implemented or accepted behaviour in Slice 6c. Exact 0.0.72 extraction and file semantics must be verified before Slice 8 makes more detailed claims.

## Reset and readiness assessment

Safe manager probes and source/runtime fixtures establish the following bounded facts:

- `reset()` leaves manager configuration and enabled state in place while clearing operational network readiness;
- a failed replacement initialisation leaves network readiness unavailable; and
- `createSandboxManager`/`ISandboxManager` can provide instance isolation, but a separate manager instance does not by itself make swapping the extension's active manager atomic.

These observations do not define a complete manager state machine, nor do they prove that a prior live manager can be restored through a public API. The extension's `sandboxInitialized` flag must not be treated as runtime readiness.

Slice 9 should provide the fail-closed lifecycle seam: represent explicit ready/unavailable state after reset-success/init-failure, prevent Bash/local unsandboxed fallback, surface the unavailable status, roll back new session grants, and restore the prior manager only if the public lifecycle contract is validated. This assessment does not implement that seam.

## Slice 6d acceptance checklist

Run these gates on a macOS acceptance host with the exact runtime package under evaluation, the extension build from this branch, a disposable project/worktree, and disposable credentials/SSH material. Record commands, runtime version/integrity, configuration, and observable pass/fail evidence. Do not use broad permissions to make a failing scoped test pass.

| Gate | Prerequisites | Pass evidence | Fail evidence / required disposition |
| --- | --- | --- | --- |
| Scoped Chromium launch | macOS; Chromium/Chromium-compatible browser; `allowBrowserProcess: true`; no broad Unix-socket allowance; disposable temp paths | Browser process launches and performs required `kern.hv_vmm_present` sysctl, loopback bind, Darwin per-user-temp file access, and per-user-temp Unix-socket access. Runtime profile contains only the scoped grants and no `allowAllUnixSockets`. | Any required operation is denied, profile widens Unix-socket access, or browser mode is not actually scoped. Record the diagnostic and run conditional Slice 7 adaptation; otherwise retain/defer the upgrade. |
| Browser disabled-path | Same host with `allowBrowserProcess: false` | Chromium-specific permissions are absent; a browser attempt fails closed with useful attribution/status. | Browser permissions remain enabled outside browser mode or failure is silently misclassified. Fix before approval. |
| Git over SSH / SOCKS | BSD `/usr/bin/ssh` and `/usr/bin/nc`; disposable Git SSH endpoint or controlled fixture; runtime SOCKS proxy; `allowUnauthenticatedSocksProxy` enabled only for this test | Git-over-SSH completes through the local SOCKS path; unauthenticated SOCKS negotiation works for BSD `nc`; denied domains remain denied; allowed domains work; no broad Unix-socket grant is added. | SOCKS negotiation requires unsupported authentication, domain filtering is bypassed, or broad sockets are needed. Keep the current runtime and route the minimum needed adaptation through Slice 7. |
| HTTP proxy separation | Controlled HTTP proxy requiring authentication and a separate allowed-domain case | HTTP proxy authentication remains functional and independent of the unauthenticated SOCKS compatibility setting. | SOCKS compatibility disables or bypasses HTTP authentication. Do not approve the upgrade. |
| SSH-agent approval | Disposable `SSH_AUTH_SOCK` and a denied-by-default session | Agent access is denied before approval; exact socket path approval permits the intended retry; no broad socket grant is issued. | Agent is reachable without approval, approval is broader than the exact path, or retry bypasses domain/policy checks. Do not approve. |
| Reset/init failure | Safe disposable manager/runtime fixture or non-destructive platform probe capable of reset followed by forced replacement-init failure | After reset-success/init-failure the extension reports unavailable/not-ready, does not run local unsandboxed Bash, rolls back new session grants, and restores the old manager only if that public lifecycle operation was demonstrated safe. | Stale `sandboxInitialized` permits execution, the old manager is assumed restored without evidence, or a failed refresh leaves a session allowance behind. Keep lifecycle work in Slice 9 and do not approve runtime replacement. |

6d is complete only when each applicable gate has reproducible observable evidence and the result is recorded as pass, fail, or explicitly unavailable with its security disposition. “Source marker present” and mocked/runtime-fixture success are useful supporting evidence but do not satisfy the real macOS gates.

## Conditional Slice 7 recommendation

Run Slice 7 only after 6d identifies a concrete compatibility failure or confirms that stock 0.0.72 lacks a required downstream policy. The source comparison makes scoped Chromium adaptation likely, but 6d must determine the minimum real-world patch. Slice 7 should then either:

1. port the minimum scoped Chromium and/or macOS Git-over-SSH behaviour, review changed defaults, repeat the 6d gates, and upgrade only after all required checks pass; or
2. retain the known-compatible runtime and explicitly defer 0.0.72 rather than shipping a broad permission or proxy workaround.

Do not use Slice 7 to expose credentials, resolve O-03, decide C-13, or close the prompt/UI TODOs. Credential plumbing remains Slice 8, and reset/readiness handling remains Slice 9.

## Remaining gates and scope boundary

- 6d macOS Chromium, Git-over-SSH, proxy, domain, SSH-agent, and safe lifecycle evidence remains outstanding.
- Slice 7 is conditional and expected if the source-based Chromium gap is confirmed; no package, lockfile, or runtime change is made here.
- Slice 8 remains required for credential configuration and fail-closed macOS environment masking/file-deny behaviour.
- Slice 9 remains required for prompt/UI TODOs and explicit lifecycle readiness handling.
- C-13 remains a deferred runtime-meaning decision.
- No code, tests, package metadata, lockfile, or installed dependency changes are part of Slice 6c.
