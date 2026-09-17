# Upstream 0.6.6 Slice 6d macOS acceptance

- **Proposal:** [`proposal-integrate-upstream-0.6.6.md`](../proposals/proposal-integrate-upstream-0.6.6.md)
- **Feature ledger:** [`upstream-0.6.6-feature-ledger.md`](upstream-0.6.6-feature-ledger.md)
- **Slice:** 6d — macOS runtime acceptance
- **Baseline:** `6c217958d2ec85078198cddd0e4ba204cd00f07e`
- **Candidate:** stock npm `@carderne/sandbox-runtime@0.0.72`
- **Decision:** acceptance complete; the candidate is **not approved for upgrade**. The scoped Chromium failure triggers conditional Slice 7. The locked project runtime remains unchanged.

## Host and provenance

The checks ran on the configured macOS acceptance host, with no branch or Git-history operation:

| Item | Observed value |
| --- | --- |
| OS | Darwin arm64, macOS `15.7.9` (`24G830`) |
| Kernel | Darwin `24.6.0` |
| Node/npm | Node `v22.22.2`, npm `10.9.7` |
| Git | `git version 2.44.0` |
| SSH | `/usr/bin/ssh`, OpenSSH `9.9p2`, LibreSSL `3.3.6` |
| BSD netcat | `/usr/bin/nc` (macOS BSD `nc`, SOCKS5 `-X 5` support) |
| Seatbelt | `/usr/bin/sandbox-exec` |
| Chromium | `/Applications/Chromium.app/Contents/MacOS/Chromium`, `147.0.7727.116` |
| Brave | `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`, `114.1.52.130` (available; Chromium was the exercised browser) |
| SSH agent | `SSH_AUTH_SOCK` was set to `/private/tmp/com.apple.launchd.Lroo2dgwCq/Listeners`; read-only `ssh-add -l` status was reachable. No key material was read or recorded. |
| Darwin user temp | `TMPDIR=/var/folders/8s/djzf949n40qbfv1cx585c1440000gn/T/`; per-run probe directories were disposable and removed. |

The candidate was created in an isolated project-local directory and removed with a shell `trap`:

```sh
ROOT=$(mktemp -d "$PWD/.slice-6d-XXXXXX")
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/npm-cache" "$ROOT/home" "$ROOT/env"
export HOME="$ROOT/home"
export npm_config_cache="$ROOT/npm-cache"
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
TARBALL=$(npm pack @carderne/sandbox-runtime@0.0.72 --pack-destination "$ROOT" | tail -1)
npm install --prefix "$ROOT/env" --no-save --ignore-scripts \
  --no-package-lock --no-audit --no-fund "$ROOT/$TARBALL"
```

The npm pack integrity printed by npm and independently computed from the tarball was:

```text
sha512-7GI5hDQ7vUHdkVsHHZ76kbVTzy2Wt0twcQhUDVpGG5mgn5vENpWXImU8kKFf+YifDHn7nSoltCqa1RAqZZbVtw==
```

The extracted package metadata reported version `0.0.72`, engine `node >=20.11.0`, and the expected runtime dependencies. This matches the 6c candidate integrity and upstream commit `dea3f1a241c189f0f954ac989dfc2c2a95b64c39`. The project `package.json`, `pnpm-lock.yaml`, project `node_modules`, project configuration, and user configuration were not modified.

## Test method and configuration

Every runtime test used `createSandboxManager()` or a separate candidate process. No test used the project's installed singleton. Child commands were wrapped by the candidate runtime, spawned in detached process groups, bounded by timeouts, and killed by process group plus unique disposable-profile matching when needed.

The scoped browser candidate configuration was:

```json
{
  "network": {
    "allowedDomains": [],
    "deniedDomains": [],
    "strictAllowlist": true,
    "allowUnauthenticatedSocksProxy": true
  },
  "filesystem": {
    "denyRead": ["/Users", "/home"],
    "allowRead": ["<candidate-root>"],
    "allowWrite": ["<candidate-root>"],
    "denyWrite": []
  },
  "allowBrowserProcess": true,
  "enableWeakerNetworkIsolation": true
}
```

The browser configuration intentionally had no `allowLocalBinding`, no `allowUnixSockets`, and no `allowAllUnixSockets`. The only browser-specific switch was `allowBrowserProcess`. The disposable browser profile was passed with `--user-data-dir=<candidate-root>/browser-{enabled|disabled}`. A second run used exactly the same configuration with `allowBrowserProcess: false`.

## Gate results

### R-07 — scoped Chromium launch: **FAIL; Slice 7 triggered**

The real command was run through the candidate's macOS `sandbox-exec` wrapper:

```sh
/Applications/Chromium.app/Contents/MacOS/Chromium \
  --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$ROOT/browser-enabled" \
  --remote-debugging-port=0 about:blank
```

The enabled command did launch a Chromium process (its disposable `--user-data-dir` was observed), then exited `21` with:

```text
Failed to create socket directory.
Failed to create a ProcessSingleton for your profile directory ... Aborting now to avoid profile corruption.
```

The same runtime profile was also exercised by a real Node resource probe, using a disposable directory under Darwin `$TMPDIR` and a TCP listener on `127.0.0.1`:

```text
temp-file:EPERM: operation not permitted
loopback-bind:EPERM: listen EPERM: operation not permitted 127.0.0.1
unix-bind:EPERM: listen EPERM: operation not permitted <Darwin-user-temp>/sixd-darwin-...-socket
```

The probe catches each error and exits only after reporting all three operations; these are runtime-enforced denials, not mocked results.

The generated enabled profile was inspected before launch. It contained the generic `allowBrowserProcess` permissions (`(allow mach*)`, unrestricted process-info, broad IOKit, and shared-memory permissions), but did **not** contain:

- `(sysctl-name "kern.hv_vmm_present")`;
- a scoped Darwin user-temp rule (`DARWIN_USER_TEMP_DIR` was absent);
- a browser loopback bind rule; or
- any scoped Unix-socket rule for the disposable temp path.

It also did not contain `allowAllUnixSockets` or a root-matching Unix-socket rule. The only observed `network-bind`/inbound/outbound rules were for the local runtime proxy port. Thus the profile stayed narrow, but it omitted the downstream policy rather than accidentally granting it. The real launch failure plus the source/profile absence is a concrete failure under the 6c checklist; no manual broad allowance was added to turn it into a pass.

### Browser disabled path: **PASS (negative-path gate)**

With `allowBrowserProcess: false`, the generated profile had no `(allow mach*)`, broad process-info, broad IOKit, or broad shared-memory browser block. The same disposable Chromium command exited `21` with the same useful ProcessSingleton/socket-directory classification, and no matching Chromium process remained after cleanup. Browser-specific permissions were therefore absent outside browser mode and the attempt failed closed. This does not rescue the enabled-path failure.

### R-08 — Git over SSH, SOCKS, domains, and HTTP proxy separation: **PASS for standalone candidate runtime**

The network checks used only public read-only targets (`example.com:443` and the public `carderne/pi-sandbox` Git repository), bounded timeouts, the candidate's local mux proxy, and `/usr/bin/nc`. No remote write was attempted.

| Check | Configuration/command | Observable result | Verdict |
| --- | --- | --- | --- |
| HTTP through authenticated runtime proxy | Allowed `example.com`; `curl --max-time 8 ... https://example.com/`; `allowUnauthenticatedSocksProxy: false` | HTTP status `200` | PASS |
| HTTP proxy without auth | Host-side `curl --noproxy '' --proxy http://127.0.0.1:<mux-port> ... https://example.com/` | CONNECT response `407`; curl status `000` | PASS — proxy auth is required |
| HTTP remains separate when SOCKS is unauthenticated | Same allowed host with `allowUnauthenticatedSocksProxy: true` | Wrapped curl status `200`; host-side unauthenticated HTTP request still received `407` | PASS |
| BSD `nc` SOCKS compatibility | `/usr/bin/nc -G 5 -w 8 -X 5 -x localhost:<mux-port> example.com 443` with unauthenticated SOCKS enabled | exit `0` | PASS |
| SOCKS authentication remains required when compatibility is off | Same BSD `nc` command with `allowUnauthenticatedSocksProxy: false` | exit `1` | PASS — expected denial |
| Explicit domain deny | allowed `example.com`, denied `example.com`; HTTPS curl | CONNECT response `403` | PASS |
| Unlisted domain deny | allowed `example.com`, no `example.org`; HTTPS curl | CONNECT response `403` | PASS |
| Allowed Git-over-SSH | allowed `github.com`; exact socket approval; `git ls-remote git@github.com:carderne/pi-sandbox.git HEAD` | actual Git protocol completed; `HEAD` returned `31fa5060689624467c1aeace2664ce91784522ff` | PASS |
| Denied Git domain | allowed and denied `github.com`; same read-only `git ls-remote` | `/usr/bin/nc` reported SOCKS error `2`; Git exited `128` before protocol completion | PASS — domain denial, not a false Git success |

The allowed Git command used a disposable known-hosts file and disabled user/system SSH configuration without changing either:

```sh
GIT_CONFIG_NOSYSTEM=1 \
GIT_SSH_COMMAND="/usr/bin/ssh -F /dev/null -o BatchMode=yes \
  -o ConnectTimeout=8 -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=<candidate-root>/known_hosts \
  -o ControlMaster=no -o ControlPath=none \
  -o ProxyCommand='/usr/bin/nc -G 8 -w 8 -X 5 -x localhost:<mux-port> %h %p'" \
git ls-remote git@github.com:carderne/pi-sandbox.git HEAD
```

The only SSH-agent test commands were status checks with output discarded:

```sh
/usr/bin/ssh-add -l >/dev/null 2>&1; echo "agent-status:$?"
```

Before approval, with no Unix-socket allowance, the status was `agent-status:2`. After reinitialising a separate candidate manager with exactly `allowUnixSockets: ["/private/tmp/com.apple.launchd.Lroo2dgwCq/Listeners"]`, the status was `agent-status:0`. No broad socket allowance was present and the active agent was not mutated. This proves the required denied-before/exact-path-approved distinction.

### Extension integration seam: **PARTIAL; Git gate unavailable under the current wrapper**

To separate extension integration from standalone runtime evidence, an isolated fixture copied this branch's `src/` and resolved `@carderne/sandbox-runtime` to the candidate package through a fixture-local symlink. It ran the actual `buildRuntimeConfig()`, `initializeSandbox()`, and `createSandboxedBashOps(undefined, true)` code; the project's package metadata and installed tree were not changed.

Observed runtime seam values were:

```text
allowBrowserProcess: true
allowUnauthenticatedSocksProxy: true
runtime allowedDomains: []
runtime deniedDomains: []
runtime strictAllowlist: false
allowUnixSockets: [exact SSH_AUTH_SOCK]
allowAllUnixSockets: undefined
```

Through `createSandboxedBashOps`, read-only HTTP returned `extension-http-status:200` and exact-path agent status returned `extension-agent-status:0`. The current extension wrapper's generated SSH command does not provide a disposable `UserKnownHostsFile`/`-F /dev/null`; OpenSSH consequently attempted the host default `/Users/ehensleigh/.ssh/known_hosts`, which the sandbox denied, and the exact wrapper Git attempt exited `128` with `Host key verification failed`. No user known-hosts file was read or changed. The standalone candidate Git gate above is the valid Git-over-SSH runtime result; the extension wrapper result is conservatively **unavailable/not approved**, not a fabricated pass.

### R-09 — upstream SSH proxy product: **DEFERRED / NOT ENABLED**

The candidate's optional upstream `network.sshProxy` product was not enabled. The exercised path remained the downstream BSD `nc -X 5 -x` compatibility path and the current extension's opt-in `sshProxy` shell seam. The candidate's generated `GIT_SSH_COMMAND` retained `ControlMaster=no`, `ControlPath=none`, and the BSD `nc` ProxyCommand. No broad proxy or Unix-socket behavior was adopted. A separate product/security decision remains required before considering upstream SSH proxying.

## Reset and replacement-initialisation failure: **UNAVAILABLE for full extension lifecycle; supporting standalone result recorded**

An isolated candidate manager was initialized with a valid network/filesystem configuration, then reset. The replacement initialization was forced to fail by supplying missing disposable TLS CA/key paths:

```text
before:       enabled=true, ready=true,  proxy=<set>, configPresent=true
after reset:  enabled=true, ready=false, proxy=undefined, configPresent=true
replacement:  failed as forced: tlsTerminate.caCertPath ... ENOENT
after failure: enabled=true, ready=false, proxy=undefined, configPresent=true,
              configHasTlsTerminate=true
post-failure: wrapWithSandbox refused with
              "Sandbox network proxy is not initialized. Initialize the sandbox before running commands."
after final reset: enabled=true, ready=false, proxy=undefined, configPresent=true
```

This is useful supporting evidence: the candidate's network execution seam fails closed when readiness is absent, but its public `isSandboxingEnabled()`/config state remains set after reset and failed replacement initialization. No prior manager restoration was demonstrated; reset destroys operational state and there is no acceptance evidence for an atomic old-manager swap. The branch's extension-level unavailable status, prevention of unsandboxed Bash, rollback of new session grants, and stale lifecycle handling remain Slice 9 work. Those full extension assertions were therefore classified unavailable rather than claimed as a runtime pass.

## Cleanup and scope checks

Each harness used `try/finally` or a shell `trap`; each candidate manager was reset. Browser children were terminated by process group and unique disposable-profile matching. Final checks returned no output for:

```sh
find "$PWD" -maxdepth 1 -name '.slice-6d-*' -print
find "${TMPDIR%/}" -maxdepth 1 -name 'sixd-darwin-*' -print
ps -axo pid=,ppid=,command= | grep -E '\.slice-6d-|--user-data-dir=.*slice-6d' | grep -v grep
```

No candidate browser process, project-local candidate directory, disposable Darwin probe directory, proxy process, project config, user SSH config, known-hosts file, active agent state, package file, lockfile, or installed project dependency remained changed.

## Decision and conditional Slice 7 minimum

6d is complete as an evidence decision, but stock 0.0.72 is not accepted for upgrade:

1. Standalone candidate SOCKS/BSD `nc`, domain filtering, HTTP proxy authentication separation, exact SSH-agent approval, and Git protocol completion passed.
2. The real enabled Chromium gate failed. Stock 0.0.72's profile lacks the downstream `kern.hv_vmm_present`, browser loopback-bind, and Darwin user-temp file/Unix-socket grants; Chromium then failed to create its profile socket directory. The disabled browser path stayed narrow and failed closed.
3. Full extension reset/replacement lifecycle acceptance remains unavailable and is explicitly deferred to Slice 9.
4. The extension integration fixture confirms the current config seam does not add broad Unix sockets, but its Git wrapper cannot be safely exercised with disposable known-hosts material without changing that separate seam.

Conditional Slice 7 should, and only should, port the minimum scoped macOS browser rules demonstrated by the failure: `kern.hv_vmm_present` read, loopback bind without broad outbound access, and Darwin per-user-temp scoped file and Unix-socket operations, only under `allowBrowserProcess`. It must preserve the absence of `allowAllUnixSockets`, keep browser-disabled profiles free of those grants, review the current SSH/known-host wrapper separately, and rerun every 6d gate before any dependency upgrade. Slice 7 must not implement credentials, C-13, upstream SSH proxying, or Slice 9 lifecycle behavior.

The three existing TODO gates, including C-13, remain deferred. This acceptance made no production runtime, dependency, package, lockfile, credential, or policy changes.
