# Browser compatibility permission boundary

- **Created:** 2026-10-15
- **Status:** draft
- **Updated:** 2026-10-16

## Summary

Capture [S-7 in the security review](../reviews/upstream-0.6.6-conformance-security-review.md) for later consideration. The user deferred this work to move forward with the upstream integration. This stub records the problem without selecting a solution or authorizing implementation.

On macOS, enabling `allowBrowserProcess` adds Chromium compatibility permissions to the sandbox profile used by all sandboxed Bash commands, not only Chromium. The current adapter permits localhost outbound connections, wildcard network bind/inbound access, and filesystem and Unix-socket access under the per-user Darwin temporary directory. These grants can expose local services, listening interfaces, other applications' temporary files, and local proxies that could undermine destination filtering.

The setting is opt-in, not enabled in built-in defaults. The review's globally enabled configuration describes a particular setup, not every installation.

Local downstream `main` (`757f058`) already relied on browser permissions from its runtime dependency; its tests expect wildcard binding and per-user-temp access. The integration supplies permissions through a consumer-side adapter. The risk is at least partly inherited, and no regression has been established. Complete permission equivalence has not been verified against `main`'s pinned runtime dependency. This comparison used source/tests as evidence, not fresh browser or OS enforcement testing.

## Goals

- Establish the acceptable scope of browser compatibility permissions across processes, network interfaces, local services, and temporary files.
- Preserve useful Chromium workflows while making their authority and residual risks explicit.

## Proposed approach

Undecided. No permission changes, process-isolation design, or implementation plan is proposed in this stub. Future evaluation should distinguish bounded exposure reductions from a complete browser-specific authority boundary.

## Decisions

- **2026-10-16:** the user rules out `allowBrowserProcess` as a route for Chromium support because its grants are too broad for every sandboxed command. Its `(allow mach*)` grant may also permit a LaunchServices escape ([GHSA-5263-whxq-77hp](https://github.com/Homebrew/brew/security/advisories/GHSA-5263-whxq-77hp)); this is untested. It cannot enable own-sandbox Chromium anyway because macOS refuses nested Seatbelt application ([diagnosis](../integration/upstream-0.6.6-chromium-acceptance-harness.md#2026-10-16-nesting-diagnosis)). Whether to remove or restrict the setting is not yet decided. See also the [browser test broker proposal](proposal-sandboxed-browser-test-broker.md).

## Open questions

- Which permissions are actually required by supported Chromium workflows?
- What isolation between browser processes and other sandboxed commands is expected and enforceable?
- What localhost and temporary-directory access is acceptable when browser support is enabled?
- What compatibility and real macOS enforcement evidence is required before changing these permissions?
