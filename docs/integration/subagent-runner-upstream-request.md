# Draft upstream request: extension-aware child session lifecycle

- **Created:** 2026-10-18
- **Status:** local draft; not submitted
- **Related proposal:** [Sandbox protection for subagent sessions](../proposals/proposal-subagent-sandbox-sessions.md)

## Summary

Request three generic capabilities in `@tintinweb/pi-subagents`: required-extension enforcement, trusted child initialisation, and extension completion metadata. These let a policy extension protect configured child tool paths without a runner fork, live permission forwarding, or sandbox-specific runner code.

The motivating consumer is `pi-sandbox`, whose children need independent runtime managers and a spawn-time snapshot of approved parent session allowances. Policy evaluation, OS enforcement, grant validation, and user approval remain the consumer extension's responsibility. Extensions are trusted code; this is not isolation from malicious extensions.

This document proposes contracts, not an implemented or agreed upstream API. Names below are illustrative. No upstream submission, package change, or personal configuration change is authorised by this draft.

## Observed integration points

Inspection of the installed 0.22.0 sources found:

- `src/agent-runner.ts` constructs a child resource loader, creates the session, binds extensions, applies tool scope, then prompts the child. Missing requested extensions currently warn rather than abort; binding errors are reported through a callback.
- `RunOptions.onSessionCreated` runs after extension binding. It cannot initialise extension state needed during `session_start`.
- Child loaders have independent event buses. `src/child-context.ts` marks child construction with an async-local boolean but does not establish parent ownership or carry initialisation data.
- `src/agent-manager.ts` retains ordinary response text and model-authored `structuredJson` separately. `src/index.ts` emits completion events and renders result notifications/retrieval, but has no dedicated extension completion-metadata contract.
- Parent shutdown aborts children and disposes retained sessions. Child extension shutdown is bounded by a three-second timeout; disposal is not proof that extension-owned subprocesses have exited.

These are source observations, not behavioural verification. Integration must be tested against the actual supported Pi versions; no new Pi core API is assumed necessary yet.

## Requested capabilities

### 1. Required extensions

Allow trusted agent configuration to declare extensions that must load and bind before that child can execute. For example, an illustrative `required_extensions` list would supplement, not silently replace, the existing extension allowlist.

Required behaviour:

- Reject contradictions such as `isolated: true`, extensions disabled, or an allowlist/exclusion that removes a required extension.
- Resolve requirements to successfully loaded extension identities using canonical loader provenance, not merely a similarly named tool or a string in a discovery list.
- Reject missing extensions and loader failures before child execution. Treat binding/startup errors affecting required protection as fatal. If error attribution is unavailable, fail that protected child's startup conservatively.
- Finish the gate before the first child prompt or tool call. Clean up partially constructed sessions and extension resources on failure.
- Return an actionable startup failure through foreground, background, RPC, and nested invocation paths; a background identifier must not imply startup succeeded.
- Keep existing best-effort behaviour for agents that declare no required extensions.

Successful loading/binding does not prove arbitrary extension health. The consumer remains responsible for keeping its tools blocked if its runtime cannot initialise or refresh. Tests must establish the handoff between the runner gate and the consumer's fail-closed handlers. Add an explicit readiness acknowledgement only if that handoff cannot be established through existing startup/error contracts.

### 2. Trusted child initialisation

Provide a generic extension integration point at the real parent-to-child construction boundary, before child extension binding. It must let participating trusted extensions supply namespaced, per-child initialisation data and consume it in the corresponding child extension before `session_start` needs it.

Required behaviour:

- Runner-established parent/child association: callbacks receive the actual spawning session's context or an equivalent non-model-controlled capability. A child-supplied parent ID is not authority.
- Capture parent-approved state by value at the spawn request, retain that snapshot for a queued spawn, and check that its originating session is still active before starting. Later approvals apply to later spawn requests, not queued or running children.
- Transfer data only to the intended child's extension namespace; do not reuse a process-wide mutable current-parent slot. Concurrent and nested spawns must remain independent.
- Never source authoritative initialisation data from prompts, model-call arguments, transcript entries, or persisted session metadata. Do not automatically persist or display the payload.
- Support nested spawns from their actual immediate parent while retaining an association with the originating root session's lifetime.
- Define failure and cleanup for missing required participants, malformed payloads, callback errors, cancellation, and startup failure. Required initialisation failure must not silently fall back to an uninitialised protected child.

For the sandbox consumer, the payload is a snapshot of approved allowance values, not a manager reference, credential value, sandbox-disable setting, or one-command unsandboxed approval. The child validates the snapshot against its own policy; explicit denies and mandatory protections remain effective.

An API using runner lifecycle callbacks or scoped extension events is acceptable. The request is for the lifecycle contract, not a new general-purpose RPC framework. Existing public hooks do not yet establish this contract.

### 3. Extension completion metadata

Let a child extension attach bounded, namespaced completion metadata alongside the normal child result. Capture it independently of model-written final text or `StructuredOutput` calls.

Required behaviour:

- Preserve normal response text and existing structured-output semantics.
- Associate metadata with the actual child run and extension producer. Namespace labels alone are not authentication against arbitrary trusted extension code, but model-written JSON must not be relabelled as extension-produced evidence.
- Make metadata available through foreground results, background result retrieval, and completion events. Notifications may carry a bounded summary/reference rather than the complete payload.
- Preserve ownership scoping: nested results go to their owner, not indiscriminately into top-level notifications.
- Define size/schema validation, truncation reporting, per-run reset on resume, and collection on success, partial failure, or cancellation where records exist. A malformed optional report must not erase the normal result or create authority.
- Collect before disposing the extension state that owns the report. Do not require the child model to summarise or reproduce every record correctly.

For the sandbox consumer, records describe blocked operations: requested access kind, specific path/domain, and available diagnostic context. Agent-suggested requests may also travel as ordinary completion text but remain labelled suggestions. Neither kind of report grants access or triggers a retry.

## Session lifetime and resume

The originating main session is the lifetime boundary for inherited temporary authority:

- Shutdown or replacement stops owned children, prevents queued/nested starts from using stale initialisation data, and expires inherited grants.
- Resuming an old child must never restore temporary grants from its transcript. It receives a fresh snapshot from the current spawning session; an in-memory resume must replace stale inherited grant state before further execution as well.
- The runner owns cancellation and lifecycle delivery; the consumer owns stopping its subprocesses and cleaning its runtime. Specify how these cooperate when child shutdown exceeds the current timeout. A disposed session or an emitted abort signal is not, by itself, a successful termination guarantee.

This request does not prescribe unbounded waiting on shutdown. Timeout escalation and actual termination guarantees need an explicit implementation design and tests before claiming that grants cannot outlive the originating session.

## Consumer workflow and non-goals

The initial user workflow remains manual: child reports → main agent explains → user invokes `/sandbox-allow` for the target and chooses session scope → a fresh child inherits the approved snapshot and retries. No dedicated approval tool or automatic permission popup is required initially.

Out of scope:

- Sandbox policy evaluation or OS runtime management inside the runner.
- Live child-to-parent permission forwarding or live grant synchronisation.
- Automatically approving requests, persisting grants, or retrying work.
- Sandboxing arbitrary extension code or tools outside the consumer's coverage.
- Moving children into separate processes or replacing orchestration features.

## Acceptance evidence requested

Use deterministic runner tests with fixture extensions before LLM-based or OS-level acceptance:

- Missing, throwing, or binding-failing required extensions prevent the first prompt/tool call and clean up partial startup.
- Optional-extension behaviour stays compatible.
- Concurrent, queued, nested, foreground, background, and RPC spawns receive only their own trusted initialisation snapshots; parent shutdown invalidates queued work.
- Model arguments, persisted history, and claimed parent IDs cannot manufacture authoritative payloads.
- Resume receives current authority and does not revive old grants or old completion records.
- Completion metadata survives each result path separately from normal output and model-authored structured JSON, with limits and provenance preserved.
- Cancellation, startup failure, and parent replacement release integration state; timeout tests establish what actually stops rather than asserting only that `dispose()` was called.

The sandbox repository must separately verify tool dispatch, policy enforcement, permission approval/retry, and independent runtime safety on macOS and Linux. Runner fixture tests alone cannot prove OS containment.

## Questions for upstream

1. Which public extension lifecycle surface should own trusted initialisation and completion contributions, across supported Pi versions?
2. Can required-extension startup errors be attributed reliably, or should all binding errors fail startup when requirements are declared?
3. How should in-memory resume refresh extension initialisation before execution without rebuilding unrelated session state?
4. What cancellation/shutdown contract can the runner guarantee after its child-shutdown timeout?

Prefer upstream capabilities rather than a maintained local patch. Upstream API agreement and availability remain rollout dependencies; adopting a temporary fork or patch requires separate approval.
