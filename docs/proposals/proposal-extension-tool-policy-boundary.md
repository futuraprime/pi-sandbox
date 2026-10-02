# Extension-tool policy boundary

- **Created:** 2026-10-02
- **Status:** draft

## Summary

Investigate selective filesystem and network policy enforcement for tools outside the current `read`/`write`/`edit`/sandboxed-Bash boundary. This follows finding **S-3** in the [upstream security review](../reviews/upstream-0.6.6-conformance-security-review.md).

**Deferred at the user's request. No implementation is authorized.** Preserving the harness's useful search and web capabilities is a prerequisite, not an optional trade-off. S-3 remains open while this proposal is deferred; existing tool behavior stays unchanged.

## Goals

- Preserve FFF search capabilities, including git-aware ranking, external-path searches, and pagination, within approved filesystem scopes.
- Apply existing effective read policy to filesystem discovery and content searches without blanket blocking useful tools.
- Apply effective domain policy to web requests, redirects, provider connections, and network-capable subprocesses where enforceable.
- Make enforced boundaries, trusted extension code, and remaining gaps explicit.
- Establish enforcement with behavioral tests rather than treating argument checks or output filtering as OS isolation.

## Current boundary and risk

The OS sandbox covers processes launched through the sandboxed Bash execution path, not the whole Pi process. FFF's native engine and in-process web requests run outside it. Subprocesses launched directly by other extensions do not automatically inherit its restrictions. Direct `read`/`write`/`edit` tools instead have application-level policy checks.

Leaving S-3 open can disclose filenames and directory structure through discovery tools, and actual protected contents through grep matches/context. Unrestricted web tools can provide an outbound channel for that content. Other custom tools may have write or execution capabilities too. Crossing this boundary requires a tool call, but an erroneous action or prompt injection can induce such calls without the intended policy approval.

## Proposed approach

Treat this as cooperative, tool-specific integration, not a blanket unknown-tool deny rule. Confirm the installed extension versions and actual dispatch behavior before selecting a design. Prefer narrowly scoped changes that preserve tool interfaces and normal permitted behavior.

### FFF `grep` / `find`

The inspected installation uses `@ff-labs/pi-fff` with `@ff-labs/fff-node`. Relevant sources include `src/index.ts`, `src/query.ts`, `src/aux-finders.ts`, and the native API declarations in `dist/fff-api.d.ts`.

Observed limitations:

- Query `exclude` parameters constrain searches; they are not a documented pre-read/indexing security boundary.
- File-specific grep's fuzzy fallback can discard both the path constraint and exclusions.
- External paths use auxiliary finders with separate roots and retained indexes.
- Directory symlink following is enabled by default in the inspected extension.
- The exposed native initialization/search API has no general read-policy callback or indexing deny list. It supports content indexing, mmap caching, and background watching; exclusions alone do not establish that protected content was never read.
- Pagination, aggregate counts, and cached content need consideration alongside displayed results.

Evaluate a sandboxed worker that owns the native engine, including indexing and subsequent searches, rather than loading it inside the unsandboxed Pi process. Preserve FFF's search semantics where possible. An alternative is cooperative native pre-read policy support if the engine can provide it. Neither option is yet proven feasible.

Any design must handle denied descendants beneath allowed roots, canonical symlink targets, external roots, cache isolation, and policy changes. Old cached content must not become an escape from updated policy. Worker replacement/invalidation and cursor lifetime must be assessed. Output filtering may supplement enforcement but is not a substitute for preventing protected reads.

### Built-in `ls`

Evaluate policy-aware directory operations that check the requested directory and suppress disallowed entries without unnecessarily blocking an otherwise allowed directory. Define whether filename discovery itself is protected. Verify the real implementation seam and symlink behavior before choosing an adapter.

### Web access

The inspected `pi-web-access` has static `fetchContent.domainPolicy` and URL/redirect validation in `ssrf-protection.ts`, but these do not cover every provider/request path. Some integrations use their own in-process requests; media extraction also invokes subprocesses. A single initial-URL check is insufficient.

Evaluate a shared policy decision hook covering actual request destinations and each redirect, including provider endpoints and subprocess transports. Consider sandboxed workers or a controlled transport when cooperative checks cannot cover every route. Account for per-request proxies and any route that bypasses the shared transport.

Hosted extraction services introduce a distinct boundary: local egress enforcement cannot control destinations fetched remotely by a third-party service. Explicitly document and decide how submitted target URLs and sensitive data are handled; do not claim that a local sandbox enforces remote-service behavior.

### Tool identity and compatibility

Pi's tool-call event identifies tools by name, not a trusted definition identity. Registered tool metadata is not itself proof of the executing implementation. Verify dispatch/override behavior and avoid assuming that an allowed name guarantees a safe adapter. Preserve explicit sandbox-disable behavior and the existing narrow `set_git_upstream` exception.

## Non-goals

- Implementing this proposal now, editing installed packages, or changing current tool availability.
- Blanket blocking all custom tools or replacing useful indexed search with a less capable interface without approval.
- Sandboxing the entire Pi process as an incidental change.
- Claiming universal containment of arbitrary extension code, background activity, or remote services through tool-call argument checks.
- Reopening S-1/S-2 or addressing unrelated review findings.

## Open questions

- Can a worker retain native-engine performance, ranking, pagination, and necessary database access under the existing sandbox runtime?
- How should adapters exchange effective policy and invalidate workers, indexes, and cursors after grants or lifecycle changes?
- Can deny semantics and more-specific read allowances be reproduced correctly without excessive exclusion rules?
- Which changes belong in this fork versus cooperating FFF/web extensions, and how will compatibility be maintained?
- What remaining exposure is acceptable when preserving an integration cannot provide complete enforcement?

Before implementation, review these feasibility and usability trade-offs with the user. No implementation units or execution plan are authorized by this draft.
