# Sandboxed browser test broker

- **Created:** 2026-10-16
- **Status:** draft

## Summary

On macOS, Pi's Bash commands run beneath `sandbox-exec`. Every child process inherits that Seatbelt policy, and macOS refuses to apply a second sandbox inside it. Chromium's helper processes must apply their own Seatbelt profile at startup. They therefore abort inside the Pi sandbox, even when the outer profile is `(allow default)`. Evidence is in the [2026-10-16 nesting diagnosis](../integration/upstream-0.6.6-chromium-acceptance-harness.md#2026-10-16-nesting-diagnosis).

The user has rejected the alternatives:

- `--no-sandbox`: the outer sandbox does not replace renderer/GPU isolation.
- A VM: too heavy for routine local tests.
- `allowBrowserProcess`: its grants apply to every sandboxed command.

This proposal considers a trusted broker outside the agent sandbox. The broker launches Chromium with its own sandbox fully enabled. Agent-authored test code continues to run under the outer sandbox.

## Goals

- Run real Chromium tests from Pi with Chromium's own sandbox enabled for every helper process.
- Keep agent-authored code, including test files, inside the existing outer Seatbelt policy without browser-specific grants.
- Make the browser main process's host authority explicit, bounded, and reviewable.
- Leave nothing running: the broker owns the browser process group, disposable profiles, and artifacts, and cleans them up.

## Proposed approach

- **Broker:** a component outside the agent sandbox, started by the Pi extension (which already runs outside the sandbox). It launches Chromium only with explicit user approval per session or per run. Launch inputs are fixed:
  - the validated browser executable;
  - an argument allowlist that forbids `--no-sandbox` and other sandbox-weakening switches;
  - a disposable `--user-data-dir` and home;
  - a sanitized environment with no credentials or SSH agent.
- **Test process:** stays an ordinary sandboxed Bash command. It connects to the broker's browser over one narrow channel rather than launching the browser itself. The leading candidate is a Playwright browser server (`launchServer`/`connect`) bound to one loopback port with a per-run secret; the agent profile would gain outbound access to that single port only. A broker-mediated `--remote-debugging-pipe` relay is the alternative.
- **Browser network:** route browser traffic through the existing sandbox proxy (`--proxy-server`) so the configured domain allowlist still applies. Loopback development servers need an explicit allowlist.
- **Browser filesystem and protocol surface:** the browser main process is not under the outer Seatbelt policy. The broker blocks `file:` and other local-resource schemes, fixes download and upload directories to disposable paths, and refuses or filters protocol commands that reach host resources.

## Non-goals

- `--no-sandbox`, `allowBrowserProcess`, or any new grant in the shared agent profile beyond the single connection channel.
- A general-purpose browser for agent web browsing.
- Firefox/WebKit, Linux, or VM/container-based runners.
- Weakening or waiving the existing Chromium acceptance gate.

## Risks

- The browser main process runs with the user's host authority. A compromised browser main process can escape, as with desktop Chrome.
- Browser protocols (CDP, Playwright) are powerful. Mapping and filtering their host-reaching commands is security-sensitive and may be incomplete.
- A connection port reachable from the agent profile is reachable by every sandboxed command, not only the test process. The per-run secret and broker lifetime limit this but do not remove it.
- Seatbelt and `sandbox-exec` are deprecated and undocumented. Nesting behavior may change across macOS releases.

## Open questions

- Is the Playwright server protocol narrow enough to filter, or must the broker relay a restricted command set?
- How should the browser main process's filesystem reach be constrained? Candidates are a browser-specific outer Seatbelt profile that exempts only helper binaries via `(with no-sandbox)` (undocumented), a separate macOS user, or scheme/protocol filtering alone.
- What approval granularity is appropriate: per session, per run, or per test suite?
- How should the acceptance gate be reworded so it tests this architecture rather than in-sandbox launch?
