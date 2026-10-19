# Sandbox protection for subagent sessions

- **Created:** 2026-10-15
- **Updated:** 2026-10-19
- **Status:** accepted

## Summary

Protect the standard tool paths of configured `@tintinweb/pi-subagents` children. Require successful sandbox extension loading and binding before those children execute, and replace the sandbox extension's process-wide runtime dependency with independently owned runtime managers. Prefer generic upstream support for required extensions, trusted child initialisation, and extension completion metadata rather than maintaining a runner fork or local package patch.

This is a cooperative integration for configured agents, not unconditional containment of every possible child session or arbitrary extension code. Source inspection supports the approach; concurrent execution and end-to-end protection have not yet been tested. Acceptance and the execution-unit breakdown do not authorise implementation or changes to personal agent configuration.

## Goals

- Apply the existing filesystem and network policy to child `read`, `write`, `edit`, and sandboxed `bash` calls.
- Keep parent and child runtime ownership, proxy state, and mutable grant state separate during concurrent execution, while giving newly spawned children a snapshot of approved parent session grants.
- Reject permission requests in headless children rather than granting access or waiting for unavailable UI; allow completion reports to surface specific access requests for approval and a later retry.
- Refuse to start configured protected children when the required sandbox extension is missing, fails to load, or fails to bind.
- Preserve the subagent package's orchestration features, preferring an upstream required-extension feature over a maintained fork or local package patch.
- State and test the boundary, including extension-load failures and tools outside the current sandbox coverage.

## Current evidence

The inspected installation uses `@tintinweb/pi-subagents` 0.22.0. Its `src/agent-runner.ts` creates child sessions in the parent Node.js process, gives each child a resource loader, and binds extensions before running the child. The loader supports extension allowlists by name or path.

The personal agent definitions `~/.pi/agent/agents/Explore.md`, `implementer.md`, and `plan-executor.md` all specify `isolated: true`. In this package that disables extensions; it does not create OS isolation. The runner resolves isolation as `agentConfig?.isolated ?? options.isolated`, so an explicit agent-file setting takes precedence over the call argument. Nested children resolve their own configuration rather than inheriting an unconditional sandbox requirement.

`src/extension.ts` keeps lifecycle state inside each extension instance and serialises manager transitions through a process-global queue using `Symbol.for(...)` and `globalThis`. It still imports the process-wide `SandboxManager`: serialising transitions does not give sessions independent policy or runtime ownership. The runtime's initialisation can reuse an existing initialisation without applying another caller's policy, and resetting the singleton can disrupt another session.

The pinned `@carderne/sandbox-runtime` 0.0.72 already exports `createSandboxManager()`, documented as providing independent macOS/Linux sessions with their own policies and proxies. No dependency upgrade is proposed.

`src/ui.ts` already aborts permission prompts when `ctx.hasUI` is false. The child runner binds extensions without interactive UI bindings; verify this behaviour through actual child sessions rather than relying only on source inspection.

Runner source inspection identifies these integration boundaries:

- `RunOptions.onSessionCreated` fires after extension binding, too late to supply grants needed during sandbox initialisation. Each child's resource loader has its own event bus; the existing async-local child-context marker carries only a boolean, not trusted parent ownership.
- The runner retains model-authored structured output separately from normal response text, but this does not establish sandbox provenance. Its completion events and normal result-fetch path do not currently expose a dedicated extension completion-metadata channel.
- `src/extension.ts` already provides `/sandbox-allow`, which prompts the user and can create a parent session grant. No dedicated approval tool is necessary for the initial workflow.
- The subagent manager aborts children on parent shutdown and emits child extension shutdown events. Child shutdown handlers have a three-second timeout before session disposal; disposal alone does not prove sandboxed subprocesses have stopped.

These are source-inspection findings, not end-to-end verification.

## Proposed approach

### Session-owned runtimes

Give each active sandbox extension/session lifecycle an independent runtime manager. Route every manager-dependent operation through that owner, including initialisation, policy replacement, command wrapping, proxy queries, diagnostics, reset, and command cleanup. Remove singleton use from these paths rather than mixing independent and global managers.

Retain lifecycle serialisation within an owner. A child's initialisation, permission refresh, failure, or shutdown must not replace or reset the parent's or a sibling's runtime. Each Bash execution attempt holds ownership of its runtime from command wrapping through process completion and cleanup. Never reset that runtime while an attempt owns it.

For policy refresh, block new attempts, drain active commands in that session, then replace its runtime. Failed replacement leaves execution blocked. For shutdown or session replacement, block new attempts, cancel active commands, await completion and cleanup, then destroy the runtime. Release command ownership before permission prompting or permission-triggered refresh; a retry acquires ownership of the refreshed runtime. This avoids waiting on the very attempt requesting the refresh.

Draining waits for active Bash commands, not the entire subagent task or commands in other sessions. Long-running commands can delay policy refresh, so this is not immediate revocation. Account for session reloads and managers left partially initialised after failure.

Audit remaining process-global state, environment changes, platform adapters, and runtime cleanup before claiming concurrency safety. Per-command configuration overrides on the singleton are not an adequate alternative: network proxy decisions also use manager-held policy.

### Explicit child configuration

After runtime isolation and required-extension enforcement are verified, configure the three personal agents with explicit `isolated: false`, an extension allowlist containing only the sandbox extension, and a requirement that it load and bind successfully. Use a stable installation path or verified loader identity, not a transient checkout path.

Confirm actual dispatch and tool scoping: the child's `bash` must resolve to the sandboxed implementation, and direct-tool policy handlers must remain bound. Reconcile extension-contributed tools with each agent's intended tool scope; loading the extension must not inadvertently grant extra capabilities.

Personal configuration changes are a separate opt-in rollout, not edits to be made silently while implementing this repository. Retain each agent's other settings and apply the same requirements to any subsequently enabled nested agents.

### Permissions and failure behaviour

Headless children use configured policy plus a snapshot of approved parent session grants taken at spawn. Copy grant values into independently owned child state; do not share a mutable allowance collection or runtime manager. Inheritance transfers approved allowances, not a sandbox-disable state or a one-command unsandboxed bypass. Inherited allowances use the existing specificity-aware policy rules without extra precedence: a strictly more-specific allow may override a broader ordinary deny, denies win ties, and mandatory protections always win.

Later parent approvals do not update running children. A newly spawned child, including a retry after approval, receives a fresh snapshot. Nested children follow the same snapshot rule from their spawning session. Inherited grants remain in memory and are never persisted automatically. Ending the originating main session invalidates inherited grant state for further child execution; surviving subprocess descendants are subject to the lifetime limitation below.

Prefer a generic upstream trusted child-initialisation hook at session construction, before extension binding. The sandbox integration supplies a by-value snapshot from the actual spawning session's approved allowance state and associates it with the originating main session's lifetime. Do not take authority from model-call arguments, prompt text, child-asserted parent identifiers, or persisted conversation history. Handle nested spawns, queued starts, and resumed children explicitly; existing callbacks do not yet establish this contract.

Children still reject new permission requests promptly; they do not wait for a parent UI response. Additional access may also be pre-approved through existing trusted configuration. Live permission forwarding is outside this proposal.

Once loaded and enabled on a supported platform, sandbox initialisation or policy-refresh failure must keep covered tool execution blocked. Preserve existing explicit sandbox-disable behaviour rather than presenting this as mandatory enforcement.

### Completion-time access requests

Use a report → approve → retry workflow rather than live child-to-parent permission forwarding. When a child finishes, its result may include blocked or incomplete work and structured requests for specific additional paths or domains, the requested access kind, and a reason. Preserve the normal result even when requests are present.

Label each report's evidence source: direct policy denial, runtime-observed violation, output-inferred diagnostic, or agent suggestion. An extension-produced report establishes its producer, not that a denial necessarily occurred; command-controlled output must not be promoted to an observed block. All categories are untrusted request data, not authorisation or instructions to grant access. Completion reporting must not grant access, persist configuration, or automatically retry work.

Agent-suggested requests can initially travel in the normal completion text without new runner transport. Reliably recorded blocks need a separate generic extension completion-metadata channel, preferably contributed upstream, carried alongside the normal result through foreground completion, background completion, and result retrieval. Capture records from the sandbox integration rather than treating model-authored structured output as proof of a recorded block. The sandbox must record direct-tool denials as well as relevant Bash denials, retaining evidence-source labels through collection and every result path. Existing diagnostics inferred from command output remain labelled inferences even when collected by the extension.

For initial approval, the main agent explains the requests and the user invokes `/sandbox-allow` for the specific target, choosing session scope when temporary access is wanted. Only explicit user approval creates a grant. A session approval updates the main session's allowances; a newly spawned child can then inherit the updated snapshot and retry. Other active children remain unchanged. No dedicated approval tool or automatic popup is required initially; verify this manual flow end to end.

### Upstream integration and session lifetime

Prefer three generic upstream capabilities: required-extension enforcement, trusted child initialisation, and extension completion metadata. The [local upstream design request](../integration/subagent-runner-upstream-request.md) records the proposed contracts and acceptance evidence; it has not been submitted. Keep sandbox policy, grant validation, block recording, and user approval in this repository's integration rather than adding sandbox-specific runner behaviour. Exact APIs and upstream acceptance remain dependencies; no installed-package changes are authorised.

Reuse the runner's existing parent-shutdown cancellation and child extension teardown where verified. Ending or replacing the originating main session cancels its child tasks, invalidates inherited grant state for further tool execution, and prevents stale queued or nested launches. Resuming an old child never restores grants from its transcript; it receives a fresh snapshot from the current spawning session before execution. In-memory resume must also replace stale inherited grant state. Verify cancellation and completion of tracked sandboxed commands, with resources remaining owned until their cleanup completes, including when the runner's three-second child-shutdown timeout expires. Do not equate session disposal with tracked-command completion. The exact lifetime association and timeout handling remain implementation questions requiring behavioural verification.

The lifetime guarantee covers tracked command attempts, not every subprocess descendant. The current Bash wrapper can finish after its shell exits while descendants remain alive. Cancellation of tracked commands must attempt process-group termination, but does not guarantee termination of detached or otherwise surviving descendants. Such descendants may retain filesystem access or other authority acquired under inherited grants after the originating session ends; invalidating in-memory grant state does not revoke that authority. Complete descendant termination is not a rollout prerequisite. Tests must demonstrate and document this limitation rather than claim that all inherited authority expires at shutdown.

### Required-extension startup gate

The installed runner warns about missing extensions and reports binding errors without a general required-extension guarantee. Its existing extension allowlist is therefore insufficient for protected rollout. Generic required-extension support in the runner is a prerequisite, preferably contributed upstream; the exact configuration API remains to be designed.

For a child configured to require the sandbox extension, the runner must:

- Reject contradictory configuration such as `isolated: true` or an allowlist that excludes the required extension.
- Resolve the required extension to the actual loaded identity and abort when it is absent or fails to load, rather than accepting a matching name alone as proof of successful loading.
- Treat binding failures affecting required protection as fatal. If errors cannot reliably be attributed, fail the protected child's startup conservatively rather than continuing.
- Complete the gate before prompting the child or permitting any child tool execution, with deterministic cleanup of partially created sessions and extension resources on failure.
- Report an actionable startup error to the caller instead of returning an apparently successful unprotected child.

This gate establishes successful loading and binding, not the health of arbitrary extension code. Once sandbox handlers are installed, the sandbox owns fail-closed initialisation and policy-refresh behaviour. Verify the handoff end to end, including `session_start` errors: there must be no startup path where a failed handler leaves ordinary covered tools executable. Add a readiness contract only if inspection and tests show that loading/binding plus the existing lifecycle guards cannot establish that boundary.

There is no verified existing runner configuration or public hook that provides this guarantee. Keep the change generic rather than adding sandbox-specific runner integration. If upstream support is unavailable, rollout remains blocked; adopting a temporary local patch or fork requires separate approval. This proposal does not authorise changes to the installed package.

### Verification

Establish protection through behavioural tests, not merely successful extension discovery:

- Parent and concurrent children use different filesystem/domain policies without unintended cross-session access or mutable grant leakage.
- Newly spawned children receive approved parent session grants by value; later grants affect only later spawns, child-local mutations do not affect parents or siblings, and nested snapshots preserve the same isolation.
- Inherited grants preserve existing specificity-aware precedence: strictly more-specific allows may override broader ordinary denies, denies win ties, and mandatory protections always win. They cannot transfer a disable/bypass approval or persist automatically; originating-session shutdown invalidates inherited grant state for further tool execution, subject to the documented descendant limitation.
- Completion reports preserve normal results and distinguish direct policy denials, runtime-observed violations, output-inferred diagnostics, and agent suggestions; command-controlled diagnostic output is never relabelled as an observed block. Missing, malformed, or malicious requests never grant access. User approval followed by a new spawn enables the specific approved operation without changing existing children.
- Allowed standard-tool operations succeed; denied reads, writes, edits, and Bash filesystem/network operations fail in actual child sessions.
- The dispatched Bash tool is sandboxed even after the runner applies its tool scope.
- Headless permission requests abort promptly without granting or persisting access.
- Policy refresh blocks new attempts and drains active commands only in the affected session; shutdown or replacement cancels and awaits its commands before runtime reset. Permission-triggered retries cannot deadlock on command ownership.
- Child shutdown, reload, failed initialisation, and policy refresh do not disrupt a parent or sibling, including overlapping commands.
- Parent shutdown or replacement invalidates inherited grant state for further execution, prevents stale queued/nested starts, and cancels and awaits tracked sandboxed commands and their cleanup even across the runner's child-shutdown timeout; session disposal alone is not a passing result. Backgrounded and detached-process tests demonstrate the distinction between tracked-command completion and surviving descendants, including authority that may remain after shutdown.
- Trusted snapshots arrive before child sandbox initialisation; model-supplied grant data and persisted session history cannot manufacture authority. Extension-recorded completion metadata survives foreground/background result paths separately from model suggestions.
- The manual `/sandbox-allow` session-approval flow followed by a fresh child spawn grants only approved access, without a dedicated approval tool.
- Independent proxies and temporary runtime resources are cleaned up by their owner.
- Required-extension startup fails before any child prompt or tool execution for missing paths/packages, loader failures, binding failures, conflicting `isolated: true`, and allowlist conflicts; partially created sessions and resources are cleaned up.
- Sandbox initialisation and `session_start` failure tests establish the handoff from runner startup gating to sandbox lifecycle blocking, including errors reported through callbacks rather than thrown directly.
- Configuration omission and explicit sandbox-disable behaviour are demonstrated as boundary cases, not counted as protected execution. Children without a required-extension declaration remain outside the startup guarantee.

Use focused lifecycle tests plus end-to-end tests against the installed runner, with real OS-level tests on supported platforms. Distinguish macOS verification from Linux verification; passing one does not establish the other.

## Implementation units

Each unchecked unit is a separate execution request, not permission to start it. Units 1–9 are repository-owned work that can proceed without runner changes. Units 10–17 depend on available, verified upstream capabilities; they do not authorise implementing those capabilities in an installed package, submitting the upstream request, or adopting a patch/fork. Unit 18 prepares rollout instructions only; applying personal configuration remains separately opt-in.

For code units, use red/green focused tests, then `pnpm run ci:fmt`, `pnpm run lint`, `pnpm run check`, and `pnpm test`. Run individual existing test files with `pnpm exec tsx --test test/<file>.test.ts`; new integration fixtures belong under `test/`, not alongside proposals. Record OS, dependency versions, commands, skips, and results in normal integration documentation. Mocks establish lifecycle contracts, not OS protection.

Assumptions still requiring evidence: the pinned runtime factory isolates relevant platform state and cleanup; upstream APIs can supply the specified startup, trusted-initialisation, resume/lifetime, and metadata contracts; and supported macOS/Linux hosts are available for verification. No exact upstream API, version upgrade, stable installation identity, or readiness signal is assumed. If these assumptions fail, record the blocker and seek approval rather than introducing compatibility scaffolding or weakening the agreed boundary.

- [ ] **Unit 1: Establish the independent-runtime contract**
  - **Deliverable:** a bounded audit of `createSandboxManager()` in pinned runtime 0.0.72 and its use by `src/extension.ts`, `src/sandbox-runtime.ts`, and `src/macos-write-specificity.ts`.
  - **Dependencies:** accessible pinned dependency sources; no runner capability required.
  - **Acceptance:** identify manager-owned versus process-global policy, proxies, monitoring, environment changes, adapter provenance, and cleanup; establish factory/config identity and partial-initialisation reset semantics. Record any blocker to safe concurrent owners before changing production ownership.
  - **Verification:** source references and focused factory-contract tests using two managers with distinct configurations. Run `test/sandbox-runtime.test.ts`; record what remains OS-dependent. See Session-owned runtimes.
  - **Progress:** [audit and verification record](../integration/subagent-sandbox-runtime-audit.md) and `test/sandbox-manager-factory.test.ts` added. Subagent observed 2 factory and 39 runtime tests passing; coordinator verified source/tests and passed formatting, lint, and type checks. After user configuration and restart resolved tsx IPC permissions, the coordinator independently passed both factory tests and 38/39 runtime tests. One existing fixture is blocked during `git init` by the outer sandbox's mandatory `.git` write protection; full regression verification remains pending an authorised test environment. Shared macOS monitoring tags, retained reset state, Linux mount cleanup, and config/provenance identity require care in Unit 2; real OS concurrency remains unverified.

- [ ] **Unit 2: Give sandbox lifecycles independent managers**
  - **Deliverable:** owner-local lifecycle serialisation and manager routing in the extension and Bash/runtime helpers, replacing the singleton and process-global transition queue together.
  - **Dependencies:** Unit 1 establishes a usable factory contract.
  - **Acceptance:** initialisation, policy replacement, wrapping, proxy queries, diagnostics, reset, and command cleanup use the same owning manager. A failed or reset owner cannot reset a parent/sibling; existing disable/unsupported behaviour and fail-closed failure states remain. Active-command overlap is addressed by Units 3–4, not claimed complete here.
  - **Verification:** owner-aware cases in `test/extension.test.ts` and `test/sandbox-runtime.test.ts` cover two instances, failed initialisation, partial cleanup, and replacement. Inspect production paths for remaining singleton operations; retain existing macOS profile-adapter regressions.

- [ ] **Unit 3: Drain owned Bash attempts before policy refresh**
  - **Deliverable:** per-owner command leases from wrapping through execution and cleanup, integrated with policy refresh.
  - **Dependencies:** Unit 2.
  - **Acceptance:** refresh blocks new attempts and drains only its owner's active attempts before replacement; failed replacement stays blocked. Permission prompting occurs after release, and retries reacquire the refreshed runtime without deadlock. Cleanup releases ownership on wrapping, spawn, execution, and cleanup failures.
  - **Verification:** deterministic barriers in `test/extension.test.ts` and `test/sandbox-runtime.test.ts` prove refresh ordering, unaffected sibling progress, and permission-triggered retry. Do not use elapsed time alone as proof of draining.

- [ ] **Unit 4: Cancel and await tracked commands on teardown**
  - **Deliverable:** owner-local cancellation and awaited command cleanup before runtime destruction on shutdown, session replacement, or reload.
  - **Dependencies:** Unit 3.
  - **Acceptance:** prevent new attempts immediately; cancel tracked attempts, attempt process-group termination, await completion/cleanup, and only then reset. Handle cancellation while wrapping, before spawn, during execution, and during pending initialisation. Stale generations cannot regain readiness or release a replacement's resources. No guarantee of complete descendant termination is added.
  - **Verification:** lifecycle overlap tests in `test/extension.test.ts`; abort, timeout, failed-spawn, cleanup, and descendant/output-drain cases in `test/sandbox-runtime.test.ts`. Assert reset ordering and absence of leaked tracked attempts, while preserving the documented surviving-descendant limitation.

- [ ] **Unit 5: Preserve evidence sources in Bash diagnostics**
  - **Deliverable:** explicit evidence-source classification for runtime-observed violations and output-inferred Bash diagnostics, with bounded per-run collection.
  - **Dependencies:** Unit 2 for owner-local violation stores.
  - **Acceptance:** `createDiagnosticOperations()` and diagnostic parsing retain source labels; command-controlled output never becomes a runtime-observed block. Existing visible diagnostics and ordinary tool results remain usable. Collection is request data only and never creates grants or retries; model suggestions are not extension-observed evidence.
  - **Verification:** `test/diagnostics.test.ts` and `test/extension.test.ts` cover runtime events, forged diagnostic-looking output, malformed records, limits/truncation, and record reset. See Completion-time access requests.

- [ ] **Unit 6: Record direct-tool and pre-execution denials**
  - **Deliverable:** direct policy-denial records from covered tool handlers and Bash preflight paths, using Unit 5's collection and evidence labels.
  - **Dependencies:** Unit 5.
  - **Acceptance:** denied reads, writes, edits, literal-domain preflight, mandatory protections, and headless permission aborts retain specific target/access context when known. Unavailable-runtime errors do not invent path/domain denials. Records cannot authorise access, erase ordinary results, or persist grants.
  - **Verification:** focused `test/extension.test.ts` cases exercise each denial path; `test/ui.test.ts` establishes prompt-free headless rejection. Verify output-inferred diagnostics stay distinguishable from direct policy denials.

- [ ] **Unit 7: Define by-value grant snapshot semantics**
  - **Deliverable:** validated, independently owned snapshots of approved allowance values, without runner transport yet.
  - **Dependencies:** Unit 2; existing `SessionAllowances`, `cloneAllowances()`, `resolveAllowances()`, and policy helpers are the starting points, not a new parallel policy engine.
  - **Acceptance:** snapshots copy approved domains, canonical path patterns, and supported socket allowances, never managers, disable state, bypass approvals, credentials, or transcript authority. Parent/sibling mutation is isolated; relative grants retain their approved target across different working directories. Existing specificity rules and mandatory protections remain unchanged. No untrusted public grant-injection interface is added.
  - **Verification:** `test/policy.test.ts`, `test/sandbox-runtime.test.ts`, and focused snapshot tests cover mutation isolation, different working directories, more-specific allows, deny ties, mandatory protection, malformed input, and excluded authority. Trusted delivery remains unimplemented until Unit 11.

- [ ] **Unit 8: Verify independent runtimes on macOS**
  - **Deliverable:** real macOS multi-owner enforcement and resource-lifecycle evidence without the child runner.
  - **Dependencies:** Units 3–4; supported macOS host and runtime facilities.
  - **Acceptance:** overlapping owners retain distinct filesystem/domain policies and proxies; refresh, failure, and teardown of one do not disrupt another. Test tracked cancellation/cleanup and demonstrate surviving backgrounded/detached descendants as a limitation, cleaning up test descendants explicitly.
  - **Verification:** extend appropriate cases in `test/sandbox-macos-filesystem.test.ts`, `test/sandbox-protection.test.ts`, and `test/sandbox-runtime.test.ts`; use local network fixtures for distinct allow/deny checks. Record real enforcement and resource-cleanup results separately from profile-generation tests.

- [ ] **Unit 9: Verify independent runtimes on Linux**
  - **Deliverable:** Linux counterpart to Unit 8, including platform-specific isolation and cleanup evidence.
  - **Dependencies:** Units 3–4; supported Linux host with the required sandbox facilities. Unit 8 is not Linux evidence.
  - **Acceptance:** distinct filesystem/domain policies, independent proxies, owner-local refresh/failure/teardown, and tracked cancellation behave under real overlap. Record Linux-specific unsupported features and descendant limitations without silently counting skips as passing protection.
  - **Verification:** real Linux cases in `test/sandbox-protection.test.ts` and `test/sandbox-runtime.test.ts`, with local network fixtures and explicit descendant cleanup. Record host prerequisites, enforcement outcomes, and released resources.

- [ ] **Unit 10: Establish the runner startup-gate handoff**
  - **Deliverable:** a repository integration fixture and compatibility evidence for an available upstream required-extension contract; add only the sandbox lifecycle adaptation proven necessary by that contract.
  - **Dependencies:** Units 2–4; upstream required-extension support with canonical loader identity, fatal startup errors, and partial-startup cleanup. Availability and any required installation/version change need separate approval; the current allowlist is insufficient.
  - **Acceptance:** required sandbox loading/binding finishes before prompts/tools, and sandbox initialisation failures leave covered tools blocked. Callback-reported errors are handled, not just thrown exceptions. Decide whether readiness acknowledgement is necessary from evidence, not speculation; unavailable upstream support leaves this unit blocked.
  - **Verification:** deterministic fixture sessions exercise missing, load-failing, bind-failing, and `session_start`-failing extensions; assert no first prompt/tool call and cleanup of partial resources. Record exact runner/Pi versions and contract references. See Required-extension startup gate and the linked upstream request.

- [ ] **Unit 11: Deliver trusted snapshots before child initialisation**
  - **Deliverable:** sandbox consumer integration with the available upstream trusted child-initialisation hook.
  - **Dependencies:** Units 7 and 10; upstream supplies actual spawning-session association, pre-binding delivery, queued-spawn snapshots, and nested/root lifetime association.
  - **Acceptance:** capture approved values at the spawn request, including queued requests; install them before sandbox initialisation. Nested spawns derive from their immediate parent, not model-claimed identifiers. Missing required participants, malformed payloads, hook errors, or cancellation fail closed without falling back to an uninitialised child.
  - **Verification:** deterministic parent/child fixture tests cover concurrent and queued starts, late parent approvals, nested copies, mutation isolation, and attempts to inject authority through model arguments or persisted history. No personal agent configuration changes.

- [ ] **Unit 12: Invalidate inherited state across shutdown and resume**
  - **Deliverable:** consumer lifetime handling for root shutdown/replacement and both persisted and in-memory child resume.
  - **Dependencies:** Units 4 and 11; upstream must expose trustworthy lifetime invalidation and pre-execution resume refresh, including cooperation beyond its bounded shutdown wait.
  - **Acceptance:** stale queued/nested starts cannot execute; further covered tool execution cannot use expired inherited state. Resume replaces stale grants with a fresh current-spawner snapshot before execution. Tracked commands remain owned through cancellation/cleanup after runner timeout; surviving descendants remain the explicit exception, not a claimed termination guarantee.
  - **Verification:** fixture tests use barriers around queue admission, initialisation, resume, root replacement, and delayed cleanup exceeding the runner timeout. Check fresh grants, stale-start rejection, reset ordering, and unaffected siblings; do not accept `dispose()` calls alone as evidence.

- [ ] **Unit 13: Export completion records through upstream metadata**
  - **Deliverable:** sandbox consumer adapter for the available generic extension completion-metadata channel.
  - **Dependencies:** Units 5–6 and 10; upstream provides producer-associated metadata, collection before disposal, and foreground/background/retrieval transport with limits and per-run reset.
  - **Acceptance:** normal results and model structured output remain intact; evidence-source labels and producer association survive each path. Bounded/truncated, malformed, cancellation, and partial-failure records cannot grant access or erase results. Resume cannot expose stale records; agent suggestions remain suggestions even if collected.
  - **Verification:** deterministic fixture tests for foreground completion, background events/result retrieval, nested ownership scoping, cancellation, malformed payloads, limits, and resume reset. No model-authored JSON is accepted as proof of extension provenance.

- [ ] **Unit 14: Verify startup failures through real runner entry points**
  - **Deliverable:** behavioural startup-gate acceptance against the actual supported runner, beyond local mocks.
  - **Dependencies:** Unit 10; approved access to a supported runner installation or isolated verification environment.
  - **Acceptance:** missing paths/packages, loader/binding/startup failures, conflicting `isolated: true`, and allowlist conflicts fail before prompts or tools with actionable errors and partial-resource cleanup. Exercise foreground, background, RPC, and nested entry points exposed by that runner; optional-extension behaviour remains compatible.
  - **Verification:** fixture extensions and deterministic prompt/tool sentinels through actual runner APIs; collect error and cleanup evidence for every entry point. Configuration omission and explicit disable are documented boundary cases, not passing protected execution.

- [ ] **Unit 15: Verify actual child tool dispatch and headless policy**
  - **Deliverable:** end-to-end standard-tool enforcement and tool-scope evidence in actual configured test children.
  - **Dependencies:** Units 8–10 and 14 for protected claims on both platforms; each platform's acceptance may be recorded independently while the other remains blocked.
  - **Acceptance:** allowed operations succeed and denied read/write/edit/Bash filesystem/network operations fail. The selected Bash implementation is sandboxed after tool scoping; direct handlers remain bound, and extension-contributed tools do not widen the intended agent scope. Permission requests reject promptly without UI, grants, or persistence.
  - **Verification:** runner-driven fixture commands/tool calls on macOS and Linux with distinct parent/child policies and explicit dispatch checks. Exercise sandbox initialisation/refresh failure and confirm parent/sibling continuity. Search, MCP, web, and arbitrary extension code remain outside the protection claim.

- [ ] **Unit 16: Verify trusted child lifetime and grant isolation end to end**
  - **Deliverable:** actual-runner acceptance for spawn snapshots, nested/queued launches, resume, and originating-session lifetime.
  - **Dependencies:** Units 11–12 and 15.
  - **Acceptance:** approved grants arrive before initialisation by value; later approvals affect only later spawn requests. Nested snapshots preserve isolation; model/history data cannot create authority. Root replacement blocks stale launches and invalidates state; persisted and in-memory resume use current authority. Tracked cancellation/cleanup survives the runner timeout without disrupting other owners.
  - **Verification:** barrier-controlled runner scenarios for each transition, including a queued spawn before approval and a delayed teardown. Repeat relevant OS-sensitive cases on both platforms and explicitly demonstrate the surviving-descendant limitation with fixture cleanup.

- [ ] **Unit 17: Verify report → approve → retry end to end**
  - **Deliverable:** actual-runner evidence for provenance-labelled completion reports and the existing manual approval workflow.
  - **Dependencies:** Units 13, 15, and 16; interactive parent UI available for the manual `/sandbox-allow` check.
  - **Acceptance:** direct and runtime-observed blocks, forged output inferences, and agent suggestions remain distinct through foreground/background/retrieval paths. Normal results survive. A user-approved session allowance followed by a fresh spawn enables only the approved operation; existing children remain unchanged. Reports alone never approve, persist, or retry work.
  - **Verification:** deterministic report fixtures plus a recorded manual `/sandbox-allow` session-approval check; inspect grant/config state before reporting, after reporting, after approval, and after retry. Include malformed requests and cancelled/partial results.

- [ ] **Unit 18: Prepare the opt-in rollout handoff**
  - **Deliverable:** installation/configuration instructions and an evidence checklist for Explore, implementer, plan-executor, and subsequently enabled nested agents.
  - **Dependencies:** Units 8–9 and 14–17 verified; stable installed sandbox identity and actual runner configuration syntax established.
  - **Acceptance:** document explicit `isolated: false`, sandbox-only extension allowlisting, required-extension enforcement, preserved agent settings/tool scopes, manual approval/retry, and rollback to the prior configuration. State uncovered custom-tool and surviving-descendant limitations. No personal configuration is edited; applying rollout requires separate user approval.
  - **Verification:** validate example configuration with the verified loader/config parser and repeat startup/tool-scope checks in isolated fixtures. Cross-check instructions against recorded versions and macOS/Linux evidence; leave rollout blocked if any prerequisite is unverified.

## Non-goals

- Maintaining a fork or local patch of `@tintinweb/pi-subagents` without separate approval, replacing its orchestration, or moving its children into separate processes. Generic upstream required-extension, child-initialisation, and completion-metadata capabilities are the proposed integration route.
- Sandboxing the parent Node.js process or arbitrary trusted extension code.
- Extending filesystem policy to `grep`, `find`, `ls`, MCP, web tools, or other custom tools as an incidental change. These remain outside the current standard-tool boundary; see [Extension-tool policy boundary](proposal-extension-tool-policy-boundary.md).
- Treating worktree isolation as a security boundary.
- Live grant synchronisation to running children, interactive permission forwarding, or automatic approval/retry based on child completion requests.
- Guaranteed termination of every subprocess descendant or revocation of authority retained by surviving descendants after a tracked command or originating session ends.

## Risks and open questions

- Do independent runtime managers isolate all relevant state under real concurrent macOS/Linux execution, including monitoring and cleanup?
- How should command ownership and cancellation be implemented so draining, permission-triggered retries, and teardown remain deadlock-free, including the runner's bounded shutdown? Tracked-command completion does not establish descendant termination; surviving descendants may retain inherited access after shutdown.
- Which stable sandbox extension identity/path should personal agent configuration use, and does the runner preserve the intended built-in overrides and tool restrictions?
- What generic required-extension API and error-attribution rules should be contributed upstream, and does the startup handoff need an explicit readiness signal? Rollout requires verified fail-closed loading and binding; best-effort loading is not an accepted substitute.
- What exact generic APIs should carry trusted initialisation snapshots and extension completion metadata? Verify nested, queued, and resumed execution plus originating-session lifetime handling; source inspection identifies the required seams but does not establish their behaviour. Upstream acceptance remains a rollout dependency unless a separately approved patch/fork is adopted.
- The Explore agent exposes search/discovery tools beyond the sandbox's present coverage. This proposal must not be described as fully sandboxing Explore while that separate boundary remains unresolved.
