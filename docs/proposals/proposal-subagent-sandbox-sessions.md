# Sandbox protection for subagent sessions

- **Created:** 2026-10-15
- **Status:** draft

## Summary

Protect the standard tool paths of configured `@tintinweb/pi-subagents` children without maintaining a fork or patch of that package. Load `pi-sandbox` explicitly in each child and replace the sandbox extension's process-wide runtime dependency with independently owned runtime managers.

This is a cooperative integration for configured agents, not unconditional containment of every possible child session or arbitrary extension code. Source inspection supports the approach; concurrent execution and end-to-end protection have not yet been tested. This draft does not authorise implementation or changes to personal agent configuration.

## Goals

- Apply the existing filesystem and network policy to child `read`, `write`, `edit`, and sandboxed `bash` calls.
- Keep parent and child policies, session grants, proxy state, and runtime lifecycles separate during concurrent execution.
- Reject permission requests in headless children rather than granting access or waiting for unavailable UI.
- Preserve the installed subagent package and its orchestration features without a maintained fork or local package patch.
- State and test the boundary, including extension-load failures and tools outside the current sandbox coverage.

## Current evidence

The inspected installation uses `@tintinweb/pi-subagents` 0.22.0. Its `src/agent-runner.ts` creates child sessions in the parent Node.js process, gives each child a resource loader, and binds extensions before running the child. The loader supports extension allowlists by name or path.

The personal agent definitions `~/.pi/agent/agents/Explore.md`, `implementer.md`, and `plan-executor.md` all specify `isolated: true`. In this package that disables extensions; it does not create OS isolation. The runner resolves isolation as `agentConfig?.isolated ?? options.isolated`, so an explicit agent-file setting takes precedence over the call argument. Nested children resolve their own configuration rather than inheriting an unconditional sandbox requirement.

`src/extension.ts` currently keeps lifecycle state and a transition queue inside each extension instance but imports the process-wide `SandboxManager`. Those queues cannot coordinate separate extension instances. The runtime's initialisation can reuse an existing initialisation without applying another caller's policy, and resetting the singleton can disrupt another session.

The pinned `@carderne/sandbox-runtime` 0.0.72 already exports `createSandboxManager()`, documented as providing independent macOS/Linux sessions with their own policies and proxies. No dependency upgrade is proposed.

`src/ui.ts` already aborts permission prompts when `ctx.hasUI` is false. The child runner binds extensions without interactive UI bindings; verify this behaviour through actual child sessions rather than relying only on source inspection.

## Proposed approach

### Session-owned runtimes

Give each active sandbox extension/session lifecycle an independent runtime manager. Route every manager-dependent operation through that owner, including initialisation, policy replacement, command wrapping, proxy queries, diagnostics, reset, and command cleanup. Remove singleton use from these paths rather than mixing independent and global managers.

Retain lifecycle serialisation within an owner. A child's initialisation, permission refresh, failure, or shutdown must not replace or reset the parent's or a sibling's runtime. Account for commands still running during replacement or shutdown, session reloads, and managers left partially initialised after failure.

Audit remaining process-global state, environment changes, platform adapters, and runtime cleanup before claiming concurrency safety. Per-command configuration overrides on the singleton are not an adequate alternative: network proxy decisions also use manager-held policy.

### Explicit child configuration

After runtime isolation is verified, configure the three personal agents with explicit `isolated: false` and an extension allowlist containing only the sandbox extension. Use a stable installation path or verified loader identity, not a transient checkout path.

Confirm actual dispatch and tool scoping: the child's `bash` must resolve to the sandboxed implementation, and direct-tool policy handlers must remain bound. Reconcile extension-contributed tools with each agent's intended tool scope; loading the extension must not inadvertently grant extra capabilities.

Personal configuration changes are a separate opt-in rollout, not edits to be made silently while implementing this repository. Retain each agent's other settings and apply the same requirements to any subsequently enabled nested agents.

### Permissions and failure behaviour

Headless children use configured policy and reject new permission requests. Do not copy the parent's in-memory session grants into children implicitly. Additional access can be pre-approved through existing trusted configuration; forwarding permission prompts to the parent UI is outside this proposal.

Once loaded and enabled on a supported platform, sandbox initialisation or policy-refresh failure must keep covered tool execution blocked. Preserve existing explicit sandbox-disable behaviour rather than presenting this as mandatory enforcement.

The runner currently warns about missing extensions and reports binding errors without a general required-extension guarantee. Configuration alone therefore cannot ensure that a child never runs unprotected when the sandbox fails to load. Do not claim otherwise. Evaluate a generic upstream request for required extensions with spawn failure when unavailable; no custom sandbox integration, runner fork, or package patch is proposed here. Any demand for unconditional enforcement requires a further design decision before rollout.

### Verification

Establish protection through behavioural tests, not merely successful extension discovery:

- Parent and concurrent children use different filesystem/domain policies without cross-session access or grant leakage.
- Allowed standard-tool operations succeed; denied reads, writes, edits, and Bash filesystem/network operations fail in actual child sessions.
- The dispatched Bash tool is sandboxed even after the runner applies its tool scope.
- Headless permission requests abort promptly without granting or persisting access.
- Child shutdown, reload, failed initialisation, and policy refresh do not disrupt a parent or sibling, including overlapping commands.
- Independent proxies and temporary runtime resources are cleaned up by their owner.
- Configuration omission, `isolated: true`, extension-load failure, and explicit sandbox-disable behaviour are demonstrated as boundary cases, not counted as protected execution.

Use focused lifecycle tests plus end-to-end tests against the installed runner, with real OS-level tests on supported platforms. Distinguish macOS verification from Linux verification; passing one does not establish the other.

## Non-goals

- Forking, patching, or replacing `@tintinweb/pi-subagents`, or moving its children into separate processes.
- Sandboxing the parent Node.js process or arbitrary trusted extension code.
- Extending filesystem policy to `grep`, `find`, `ls`, MCP, web tools, or other custom tools as an incidental change. These remain outside the current standard-tool boundary; see [Extension-tool policy boundary](proposal-extension-tool-policy-boundary.md).
- Treating worktree isolation as a security boundary.
- Automatic parent-to-child grant inheritance or interactive permission forwarding.

## Risks and open questions

- Do independent runtime managers isolate all relevant state under real concurrent macOS/Linux execution, including monitoring and cleanup?
- What lifecycle ownership is needed when commands overlap a policy replacement or session teardown?
- Which stable sandbox extension identity/path should personal agent configuration use, and does the runner preserve the intended built-in overrides and tool restrictions?
- Is configured standard-tool protection acceptable while missing-extension failures can still permit an unprotected child, or is generic required-extension support a rollout prerequisite?
- The Explore agent exposes search/discovery tools beyond the sandbox's present coverage. This proposal must not be described as fully sandboxing Explore while that separate boundary remains unresolved.
