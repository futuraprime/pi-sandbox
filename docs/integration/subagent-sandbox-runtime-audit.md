# Subagent sandbox runtime audit (Unit 1)

- **Scope:** audit only; no production ownership changes.
- **Audited dependency:** `@carderne/sandbox-runtime` 0.0.72 (exact package pin).
- **Subagent verification host:** macOS 15.7.9, Node 22.22.2, pnpm 12.11.2. The coordinator's shell uses Node 26.11.1.
- **Evidence limit:** source review and non-proxy factory tests; no real proxy startup, concurrent OS enforcement, or OS-level cleanup claim.

## Factory and configuration contract

The package root exports `createSandboxManager()` and `SandboxManager` (`node_modules/@carderne/sandbox-runtime/dist/index.js:1-3`); declarations describe the factory as an independent macOS/Linux manager and direct Windows callers to the singleton (`dist/sandbox/sandbox-manager.d.ts`). The factory creates a fresh `createManager(false)` closure (`dist/sandbox/sandbox-manager.js:55-103,1623-1628`). Each closure holds its own runtime config, proxy servers/context, initialization/reset promises, parent proxy, proxy token, platform monitor handles, credentials state, and `SandboxViolationStore`/sentinel/file-store instances. Its proxy setup creates manager-local HTTP/SOCKS/mux servers and Linux bridges (`:488-547`); unique proxy tokens and bridge socket paths are generated per setup.

Important config ownership distinction:

- `initialize(runtimeConfig, ...)` assigns `config = runtimeConfig` without cloning (`:286-302`). `getConfig()` returns that same internal reference (`:1244-1245`). A successful initialize therefore preserves config identity, but also leaves the manager aliased to caller mutations. Two managers passed the *same mutable config object* do not get independent policy values merely by using the factory.
- `updateConfig(newConfig)` does deep-clone the configuration (preserving the `filterRequest` function separately; `:1267-1286`). That is a different identity/mutation contract from initialize.
- `resetSession()` clears owner resource references, proxy context, sentinel registry, and masked-file store, but does not set `config` to `undefined` or clear the manager's violation store (`:1423-1463,1504-1540`). After reset, `getConfig()` and `isSandboxingEnabled()` can still report the old policy, and diagnostics can retain prior violations. Lifecycle code must not equate reset with an uninitialized manager.

The new `test/sandbox-manager-factory.test.ts` uses the real pinned factory/API (no runtime mock). It checks two managers' distinct config/store state, `updateConfig` input-clone behavior, one-manager reset isolation and retained local state, plus exact config identity and state after a deliberately pre-proxy initialization failure. The failure case sets mutually exclusive TLS/MITM options, which throws at `:308-310` before CA creation, dependency checks, cleanup registration, or proxy/socket setup. It does **not** test successful initialization config identity or general partial-init cleanup.

## State boundaries and shared process effects

| Area | Observed ownership / effect |
| --- | --- |
| Policy, proxy listeners, auth token, per-manager proxy ports, credentials, sentinels, violation store | Manager closure state. These values are not the exported singleton when using a factory instance. |
| Parent proxy | Resolved at initialization per manager, from explicit config or process environment (`dist/sandbox/parent-proxy.js:41-54`). It is stored in that manager, but the source environment is shared. |
| Environment | Runtime source reads host `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, `NODE_EXTRA_CA_CERTS`, and other host env values; it does not generally rewrite the host environment. The extension itself sets `process.env.NODE_USE_ENV_PROXY ??= "1"` on supported Node versions and never restores it (`src/extension.ts:1132-1134`), a persistent process-global mutation inherited by later child processes. Proxy/env overlays in wrapped commands are child-side. |
| Cleanup registration | Package-level `cleanupHandlers` and process `exit`/`SIGINT`/`SIGTERM` listeners are shared (`dist/sandbox/sandbox-manager.js:24-53`). Signal cleanup invokes each registered manager's own cleanup function; this is global lifecycle coordination, not a shared runtime config. |
| Linux bwrap mount cleanup | `bwrapMountPoints` and `activeSandboxCount` are module-global (`dist/sandbox/linux-sandbox-utils.js:236-243`). The shared count intentionally prevents deletion while *any* bwrap command remains active; manager reset calls shared cleanup with `completed:false` (`sandbox-manager.js:1461-1463`). This is not owner-local state and needs overlap verification before claiming all cleanup effects are independent. |
| Violation monitoring | Violation stores and monitor handles are per manager when monitoring is enabled. Linux monitor sockets are unique per monitor (`dist/sandbox/linux-violation-monitor.js:30-35`) and passed through manager state. **macOS attribution is not isolated:** `macos-sandbox-utils.js:26,31-33` defines one module-level `sessionSuffix`, and every monitor filters the same suffix (`:701-718`). If multiple factory managers enable monitoring, each stream can observe the other's tagged denials and write them into its own store. In the current integration, `initializeSandbox()` passes only config and callback (`src/sandbox-runtime.ts:254-265`), so runtime 0.0.72's third `enableLogMonitor` argument defaults to `false` (`sandbox-manager.js:286`); OS violation monitors are not started by that path. |
| macOS specificity adapters | `src/macos-write-specificity.ts:28-29` has module-level `WeakMap`s keyed by the exact `SandboxRuntimeConfig` object; registration copies policy arrays (`:38-57`). `buildRuntimeConfig()` registers the new object before returning it (`src/sandbox-runtime.ts:249-251`). The adapters are config/provenance keyed, not manager keyed; initialize's reference-preserving identity retains the key. A manager `updateConfig()` clone does not transfer the WeakMap provenance (read adaptation can fail closed when policy requires provenance; write adaptation can leave the profile unchanged). The adapter also imports pinned-runtime `dist/` profile helpers directly (`:3-10`), so it is version-sensitive. |

## Current integration ownership

`src/extension.ts` keeps lifecycle/policy allowances in its extension closure, but serializes all managers through a `Symbol.for(...)`/`globalThis` queue (`:138-156`) and uses the process-wide `SandboxManager` for refresh, startup, failure recovery, disable, and shutdown (`:275-300,1115-1124,1178-1210,1643-1654`). Bash violation collection/annotation also reads that singleton (`:893-906`). `src/sandbox-runtime.ts` builds fresh runtime configs, but `initializeSandbox`, `reinitializeSandbox`, and every `createSandboxedBashOps` path route initialize/reset/proxy queries/wrapping/config/cleanup through the singleton (`:254-274,486-517,568-570`). Thus the current extension's local lifecycle state does not provide independent runtime ownership.

## Partial initialization and reset findings

Initialization sets the config and resolves environment-derived parent proxy before validation (`sandbox-manager.js:286-310`). It may create the MITM CA and start an optional monitor before cleanup registration (`:311-342`); dependency errors occur before registration. These early failures are not automatically rolled back at the throw site. Network-infrastructure failure later clears `initializationPromise` and invokes `reset().catch(...)` without awaiting cleanup before rethrowing (`:488-554`). Routine `reset()` waits for a pending initialization, then cleans resources held by that manager (`:1411-1423`), but retains config and violation records. The factory test only covers a mutually-exclusive-config error before any resource is created; it deliberately does not trigger runtime proxy/socket initialization.

## Unit 2 handoff blockers / cautions

1. Do not claim factory-backed concurrent safety for monitor-based diagnostics until macOS runtime violation tags are owner-scoped or otherwise proven not to cross-feed stores. The pinned implementation's shared module suffix defeats attribution if managers enable monitoring. Separately verify whether Unit 2 should enable monitoring; the current integration leaves it disabled, so runtime-observed violation events may be absent.
2. Route all runtime operations through the same manager owner, including manager diagnostics and command cleanup; do not mix singleton and factory calls. Ensure each owner constructs/retains a distinct mutable runtime config rather than relying on factory identity alone.
3. Preserve fail-closed lifecycle guards around reset, since reset retains config and stale violations. Characterize startup failures beyond the safe early-validation case, including cleanup completion after mid-init failure, without running proxy/socket initialization until permissions are resolved.
4. Account for the shared Linux bwrap cleanup counter/set and process-global `NODE_USE_ENV_PROXY` mutation. Neither demonstrates a test failure here, but both are process-wide coordination/effect boundaries that must be considered in ownership design.
5. Factory support is macOS/Linux only; no Windows inference follows.

## Verification record

- Added `test/sandbox-manager-factory.test.ts`; it exercises actual pinned manager methods only. No mocks establish the manager contract.
- `pnpm exec tsx --test test/sandbox-manager-factory.test.ts`: passed, 2/2 tests, 0 skipped.
- `pnpm exec tsx --test test/sandbox-runtime.test.ts`: passed, 39/39 tests, 0 skipped. Its runtime calls use existing manager mocks and ordinary shell fixtures; it did not start the runtime's network proxies.
- `pnpm run ci:fmt`, `pnpm run check`, and `pnpm run lint`: passed.
- The test results above were observed by the implementing subagent. The coordinator inspected the actual tests and cited runtime source, and independently passed `pnpm run ci:fmt`, `pnpm run lint`, and `pnpm run check`.
- The coordinator's rerun of `pnpm exec tsx --test test/sandbox-manager-factory.test.ts` failed before test execution with Unix-socket `EPERM` at tsx's IPC socket. The failure persists with a project-local temporary directory. No alternate runner was used to bypass the restriction. Independent test reruns and the full `pnpm test` regression suite remain pending permission/environment resolution.
- `pnpm install --frozen-lockfile` reached an up-to-date lockfile but failed with `ERR_PNPM_IGNORED_BUILDS` for `@google/genai`/esbuild/protobufjs; the subagent did not rerun installation because the pinned package was present. No build scripts were approved. A separately approved prerequisite moved existing overrides to `pnpm-workspace.yaml` in commit `5860b35`; the lockfile and dependency versions were unchanged.
- No runtime proxy or socket initialization was attempted. No real macOS enforcement, concurrent manager execution, or Linux behavior was tested. Source review and contract tests are not OS-level concurrency evidence.
