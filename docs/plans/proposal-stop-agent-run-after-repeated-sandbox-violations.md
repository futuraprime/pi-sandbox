# Proposal: Stop an agent run after repeated sandbox violations

- **Status:** Proposed
- **Date:** 2026-09-02

## Context

A sandbox block normally gives the model enough information to choose a permitted approach or ask the user for access. If the model continues making blocked calls, further turns consume time and tokens and may indicate persistent probing of the boundary.

Repeated blocks do not prove malicious intent. They can also result from an incorrect path assumption, a command touching several protected resources, or the model failing to follow a diagnostic. The sandbox must therefore remain the security boundary; this feature is a circuit breaker for agent behaviour, not an intrusion detector.

pi-sandbox currently limits permission prompts within one Bash incident with `MAX_PROMPT_ATTEMPTS` and retains recent incidents for `/sandbox-debug`. It does not limit separate blocked tool calls across one agent run.

## Decision

Add a session-local circuit breaker that aborts the current agent run after **three clearly attributed, unapproved sandbox violations** during one user-initiated agent activity window.

Aborting the run must leave the Pi session usable. The user can inspect the incidents, adjust permissions, and send another prompt. The breaker must not shut down Pi, create a new session, or permanently disable tools.

Use a fixed threshold initially. Do not add a configuration option until there is evidence that users need to tune it.

## Counting model

Count one strike for each independently initiated agent tool call that finishes blocked because of an enforced sandbox rule.

Count:

- blocked agent `read`, `write`, and `edit` calls;
- clearly attributed sandbox failures from the agent `bash` tool;
- network preflight blocks for agent Bash commands;
- hard-denied filesystem or network accesses;
- promptable accesses that remain blocked because permission was declined, unavailable, or not granted; and
- blocked attempts to write the project or global sandbox configuration directly.

Do not count:

- interactive `!cmd` / `user_bash` commands initiated by the user;
- internal retries of the same Bash command as additional strikes;
- a violation for which the user grants permission;
- a command that succeeds after an approved retry;
- ambiguous or unattributed command failures;
- ordinary non-sandbox command failures; or
- Git upstream redirections to `set_git_upstream`, which are tool-routing policy rather than sandbox violations.

A Bash command may report several violations. It contributes at most one strike, based on the completed incident, so one process cannot exhaust the threshold merely by touching several resources at once.

If the user approves one resource but the retried command is blocked on a materially different, unapproved resource, the completed incident contributes one strike.

## Activity-window lifecycle

The strike count applies across the complete processing of one user prompt, including automatic model turns, tool calls, retries, and compaction recovery.

Reset the count when a new user prompt starts after the previous agent activity has settled. Do not reset it merely because Pi starts another low-level agent run as part of automatic recovery or continuation.

Session reload, replacement, fork, and shutdown naturally discard the in-memory state.

Extension-generated diagnostic messages and permission retries must not start a new counting window.

## Trip behaviour

When the third strike is recorded:

1. record which incident tripped the breaker;
2. abort the active agent run through Pi's run-abort API;
3. cancel outstanding work through the active abort signal where supported;
4. preserve all sandbox blocks and tool results already recorded; and
5. notify the user:

```text
Agent stopped after 3 blocked sandbox operations. Review /sandbox-debug, adjust permissions if appropriate, then send a new prompt.
```

Where a tool call is blocked before execution, return a terminating blocked result as well as aborting the run. This gives the model and session history an explicit reason. Run abortion remains authoritative because Pi only honours per-result termination for a parallel batch when every finalised result in that batch is terminating.

The breaker should stop sibling tool executions where Pi's cancellation model permits it. Any sibling operation that has already completed remains recorded normally.

## Diagnostics

Extend `/sandbox-debug` to show the current activity-window strike count and identify a breaker trip. Keep this state in memory only.

Each counted incident should expose:

- whether it counted as a strike;
- the strike number;
- whether it tripped the breaker; and
- the existing violation identity, command preview, prompt choice, and final outcome where applicable.

The user-facing notification should describe repeated blocked operations, not claim that the agent attempted evasion.

## Implementation outline

1. Add a small circuit-breaker state object with a threshold, current count, tripped state, and the triggering incident identifier.
2. Reset that state at the boundary of a new user-initiated activity window, while preserving it across low-level retries and compaction recovery.
3. Route direct-tool blocks and completed agent Bash incidents through one `recordSandboxStrike` helper.
4. Record a Bash strike only when the incident's final disposition is known, preventing retries and multiple diagnostics from being double-counted.
5. On threshold crossing, mark the incident, abort the active run, return terminating block metadata where available, and notify the user once.
6. Include breaker state in `/sandbox-debug` output without persisting it to the session or configuration.

The counting and threshold logic should remain separate from diagnostic parsing so it can be tested without invoking the OS sandbox.

## Parallel tool calls

Pi preflights sibling tool calls sequentially but may execute them concurrently. The implementation must make strike recording synchronous and idempotent so parallel completions cannot:

- lose increments;
- trip the breaker more than once;
- display duplicate notifications; or
- count the same tool call or Bash incident twice.

Use the tool call or incident identifier as the deduplication key for the current activity window.

## Non-goals

- Inferring whether the model has malicious intent.
- Detecting semantically equivalent evasion attempts across different commands or paths.
- Strengthening or replacing OS-level sandbox enforcement.
- Stopping the Pi process or closing the current session.
- Persisting a reputation or strike count across prompts or sessions.
- Counting user-entered shell commands.
- Adding configurable thresholds, weighted violations, or time-based decay in the first implementation.

## Verification

Add focused tests for:

- three distinct attributed blocks trip the breaker;
- fewer than three blocks do not trip it;
- the same incident cannot be counted twice;
- multiple violations and retries within one Bash incident count once;
- approved and successfully retried incidents do not count;
- hard denies and declined promptable accesses do count;
- ambiguous failures and `user_bash` incidents do not count;
- direct sandbox-config writes count, while Git upstream redirects do not;
- a new user activity window resets the count;
- low-level retries and compaction recovery do not reset the count;
- concurrent strike recording trips and notifies only once; and
- `/sandbox-debug` reports strike and trip state accurately.

Run formatting, linting, TypeScript checking, and the complete test suite.

## Open implementation question

Confirm the most reliable Pi lifecycle hook for distinguishing a genuinely new user prompt from automatic retry, compaction recovery, steering, and follow-up processing. The required behaviour is defined above; the implementation should not approximate it by resetting on every `agent_start` event.
