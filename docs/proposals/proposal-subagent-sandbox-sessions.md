# Sandbox protection for subagent sessions

- **Created:** 2026-10-15
- **Updated:** 2026-10-18
- **Status:** draft

## Summary

Protect the standard tool paths of configured `@tintinweb/pi-subagents` children. Require successful sandbox extension loading and binding before those children execute, and replace the sandbox extension's process-wide runtime dependency with independently owned runtime managers. Prefer generic upstream support for required extensions, trusted child initialisation, and extension completion metadata rather than maintaining a runner fork or local package patch.

This is a cooperative integration for configured agents, not unconditional containment of every possible child session or arbitrary extension code. Source inspection supports the approach; concurrent execution and end-to-end protection have not yet been tested. This draft does not authorise implementation or changes to personal agent configuration.

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

Headless children use configured policy plus a snapshot of approved parent session grants taken at spawn. Copy grant values into independently owned child state; do not share a mutable allowance collection or runtime manager. Inheritance transfers approved allowances, not a sandbox-disable state or a one-command unsandboxed bypass, and does not override explicit denies or mandatory protections.

Later parent approvals do not update running children. A newly spawned child, including a retry after approval, receives a fresh snapshot. Nested children follow the same snapshot rule from their spawning session. Inherited grants remain in memory, are never persisted automatically, and must not survive the originating main session.

Prefer a generic upstream trusted child-initialisation hook at session construction, before extension binding. The sandbox integration supplies a by-value snapshot from the actual spawning session's approved allowance state and associates it with the originating main session's lifetime. Do not take authority from model-call arguments, prompt text, child-asserted parent identifiers, or persisted conversation history. Handle nested spawns, queued starts, and resumed children explicitly; existing callbacks do not yet establish this contract.

Children still reject new permission requests promptly; they do not wait for a parent UI response. Additional access may also be pre-approved through existing trusted configuration. Live permission forwarding is outside this proposal.

Once loaded and enabled on a supported platform, sandbox initialisation or policy-refresh failure must keep covered tool execution blocked. Preserve existing explicit sandbox-disable behaviour rather than presenting this as mandatory enforcement.

### Completion-time access requests

Use a report → approve → retry workflow rather than live child-to-parent permission forwarding. When a child finishes, its result may include blocked or incomplete work and structured requests for specific additional paths or domains, the requested access kind, and a reason. Preserve the normal result even when requests are present.

Distinguish sandbox-recorded blocks from agent-suggested access. Both are untrusted request data, not authorisation or instructions to grant access. Completion reporting must not grant access, persist configuration, or automatically retry work.

Agent-suggested requests can initially travel in the normal completion text without new runner transport. Reliably recorded blocks need a separate generic extension completion-metadata channel, preferably contributed upstream, carried alongside the normal result through foreground completion, background completion, and result retrieval. Capture records from the sandbox integration rather than treating model-authored structured output as proof of a recorded block. The sandbox must record direct-tool denials as well as relevant Bash denials.

For initial approval, the main agent explains the requests and the user invokes `/sandbox-allow` for the specific target, choosing session scope when temporary access is wanted. Only explicit user approval creates a grant. A session approval updates the main session's allowances; a newly spawned child can then inherit the updated snapshot and retry. Other active children remain unchanged. No dedicated approval tool or automatic popup is required initially; verify this manual flow end to end.

### Upstream integration and session lifetime

Prefer three generic upstream capabilities: required-extension enforcement, trusted child initialisation, and extension completion metadata. The [local upstream design request](../integration/subagent-runner-upstream-request.md) records the proposed contracts and acceptance evidence; it has not been submitted. Keep sandbox policy, grant validation, block recording, and user approval in this repository's integration rather than adding sandbox-specific runner behaviour. Exact APIs and upstream acceptance remain dependencies; no installed-package changes are authorised.

Reuse the runner's existing parent-shutdown cancellation and child extension teardown where verified. Ending or replacing the originating main session stops its children and expires inherited grants, including authority held by queued or nested launches. Resuming an old child never restores grants from its transcript; it receives a fresh snapshot from the current spawning session before execution. In-memory resume must also replace stale inherited grant state. Verify that active sandboxed commands actually stop and resources remain owned until cleanup completes, including when the runner's three-second child-shutdown timeout expires. Do not equate a disposed session with a terminated process. The exact lifetime association and timeout handling remain implementation questions requiring behavioural verification.

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
- Inherited grants cannot override explicit denies or mandatory protections, transfer a disable/bypass approval, persist automatically, or survive the originating main session.
- Completion reports preserve normal results and distinguish recorded blocks from suggested access; missing, malformed, or malicious requests never grant access. User approval followed by a new spawn enables the specific approved operation without changing existing children.
- Allowed standard-tool operations succeed; denied reads, writes, edits, and Bash filesystem/network operations fail in actual child sessions.
- The dispatched Bash tool is sandboxed even after the runner applies its tool scope.
- Headless permission requests abort promptly without granting or persisting access.
- Policy refresh blocks new attempts and drains active commands only in the affected session; shutdown or replacement cancels and awaits its commands before runtime reset. Permission-triggered retries cannot deadlock on command ownership.
- Child shutdown, reload, failed initialisation, and policy refresh do not disrupt a parent or sibling, including overlapping commands.
- Parent shutdown or replacement invalidates inherited authority, prevents stale queued/nested starts, and stops active sandboxed commands even across the runner's child-shutdown timeout; session disposal alone is not a passing result.
- Trusted snapshots arrive before child sandbox initialisation; model-supplied grant data and persisted session history cannot manufacture authority. Extension-recorded completion metadata survives foreground/background result paths separately from model suggestions.
- The manual `/sandbox-allow` session-approval flow followed by a fresh child spawn grants only approved access, without a dedicated approval tool.
- Independent proxies and temporary runtime resources are cleaned up by their owner.
- Required-extension startup fails before any child prompt or tool execution for missing paths/packages, loader failures, binding failures, conflicting `isolated: true`, and allowlist conflicts; partially created sessions and resources are cleaned up.
- Sandbox initialisation and `session_start` failure tests establish the handoff from runner startup gating to sandbox lifecycle blocking, including errors reported through callbacks rather than thrown directly.
- Configuration omission and explicit sandbox-disable behaviour are demonstrated as boundary cases, not counted as protected execution. Children without a required-extension declaration remain outside the startup guarantee.

Use focused lifecycle tests plus end-to-end tests against the installed runner, with real OS-level tests on supported platforms. Distinguish macOS verification from Linux verification; passing one does not establish the other.

## Non-goals

- Maintaining a fork or local patch of `@tintinweb/pi-subagents` without separate approval, replacing its orchestration, or moving its children into separate processes. Generic upstream required-extension, child-initialisation, and completion-metadata capabilities are the proposed integration route.
- Sandboxing the parent Node.js process or arbitrary trusted extension code.
- Extending filesystem policy to `grep`, `find`, `ls`, MCP, web tools, or other custom tools as an incidental change. These remain outside the current standard-tool boundary; see [Extension-tool policy boundary](proposal-extension-tool-policy-boundary.md).
- Treating worktree isolation as a security boundary.
- Live grant synchronisation to running children, interactive permission forwarding, or automatic approval/retry based on child completion requests.

## Risks and open questions

- Do independent runtime managers isolate all relevant state under real concurrent macOS/Linux execution, including monitoring and cleanup?
- How should command ownership and cancellation be implemented so draining, permission-triggered retries, and teardown remain deadlock-free, including the runner's bounded shutdown?
- Which stable sandbox extension identity/path should personal agent configuration use, and does the runner preserve the intended built-in overrides and tool restrictions?
- What generic required-extension API and error-attribution rules should be contributed upstream, and does the startup handoff need an explicit readiness signal? Rollout requires verified fail-closed loading and binding; best-effort loading is not an accepted substitute.
- What exact generic APIs should carry trusted initialisation snapshots and extension completion metadata? Verify nested, queued, and resumed execution plus originating-session lifetime handling; source inspection identifies the required seams but does not establish their behaviour. Upstream acceptance remains a rollout dependency unless a separately approved patch/fork is adopted.
- The Explore agent exposes search/discovery tools beyond the sandbox's present coverage. This proposal must not be described as fully sandboxing Explore while that separate boundary remains unresolved.
