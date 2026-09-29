# pi-sandbox

Sandbox for [pi](https://pi.dev/).

Sandboxes pi like this:
- read/write/edit: direct control using allow/deny lists
- bash: uses [`@carderne/sandbox-runtime`](https://www.npmjs.com/package/@carderne/sandbox-runtime) to control network and file system access

When a blocked action is attempted, the user is
prompted to allow it temporarily or permanently rather than silently failing.

![demo](./demo/demo.gif)

## Notes
The [sandbox.json](./sandbox.json) in this repository is a **development example**, not a secure default or an automatically loaded config. It contains broad filesystem, localhost, browser, and proxy grants for tools such as [agent-browser](https://agent-browser.dev/). Do not copy it wholesale into a sensitive project or grant those capabilities unless needed; start with the built-in defaults and add narrowly scoped rules.

## Quickstart

#### Prerequisites

`pi-sandbox` delegates the OS-level bash sandbox to
[`@carderne/sandbox-runtime`](https://www.npmjs.com/package/@carderne/sandbox-runtime),
published from the fork at <https://github.com/carderne/sandbox-runtime>,
which is forked from Anthropic's
[`anthropic-experimental/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).
The sandbox runtime checks for [`ripgrep`](https://github.com/BurntSushi/ripgrep) (the
`rg` binary) on **both macOS and Linux** at sandbox-init time. If `rg`
is not on the `PATH` that pi was launched with, sandbox initialization
fails with:

```
Sandbox initialization failed: Sandbox dependencies not available: ripgrep (rg) not found
```

Install ripgrep before enabling the extension:

| Platform | Install |
|---|---|
| macOS (Homebrew) | `brew install ripgrep` |
| macOS (MacPorts) | `sudo port install ripgrep` |
| Linux (Debian/Ubuntu) | `sudo apt install ripgrep` |
| Linux (Fedora/RHEL) | `sudo dnf install ripgrep` |
| Linux (Arch) | `sudo pacman -S ripgrep` |
| From source / other | <https://github.com/BurntSushi/ripgrep#installation> |

If `which rg` succeeds in your shell but pi still reports `rg not
found`, pi is being launched from a parent process whose `PATH` does
not include the directory containing `rg` (common when GUI launchers
inherit a minimal non-login `PATH`). On macOS, `/opt/homebrew/bin` and
`/usr/local/bin` are the usual culprits — make sure your launcher's
environment includes whichever one your install uses.

#### Install
This fork is distributed only through the private repository at
<https://github.com/futuraprime/pi-sandbox>. Clone it with access to that
repository, install dependencies with `pnpm install --frozen-lockfile`, and load
`index.ts` as a local Pi extension. It is not available as `npm:pi-sandbox`.

#### Configure
Add a config like this either to Pi's global agent directory (by default, `~/.pi/agent/sandbox.json`; respects `PI_CODING_AGENT_DIR`) or to `.pi/sandbox.json` (local).
Scalar settings in the project config take precedence over global settings.
Policy arrays accumulate and deduplicate across built-in defaults, global, and
project configuration; `[]` does not remove inherited rules. `ignoreViolations`
arrays accumulate per key. Credential declarations are an exception: only the
global file may declare them; project declarations are ignored with a warning.
Allow and deny rules use the same specificity-aware precedence for read, write,
and domains (see below). The annotated example below is illustrative; remove
comments before saving it as JSON. The repository's root example is similarly
for development, not a recommended security policy.

```jsonc
{
  "enabled": true,
  "permissionPromptTimeoutSeconds": 600, // Defaults to 10 minutes; 0 waits indefinitely
  "allowBrowserProcess": true,     // Chrome setup; macOS adds scoped loopback/temp access
  "network": {
    "allowUnauthenticatedSocksProxy": true, // macOS Git SSH compatibility; default on macOS
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    // Read and write use the same allow/deny specificity rules.
    // A deny wins a tie; only a strictly more-specific allow overrides it.
    "denyRead": ["/Users", "/home"],
    "allowRead": [".", "~/.config", "~/.local", "Library"],

    // Current runtime expands allowWrite paths into effective read paths.
    // An empty array cannot remove built-in write allowances.
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

#### Usage (current implementation)

```
pi --no-sandbox                           disable sandboxing for the session
/sandbox                                  show effective configuration and session allowances
/sandbox-allow domain|read|write <target> open an editable permission prompt
/sandbox-enable                           enable the sandbox for this session
/sandbox-disable                          disable the sandbox for this session
/sandbox-debug                            show recent sandbox incidents
```

`/sandbox` is display-only. `/sandbox-allow` accepts one concrete hostname or
filesystem target and opens the existing editable permission prompt, including
session, project, and global grant choices. Editing the proposed rule remains
subject to validation and the prompt's confirmation for persistent grants.
Deny rules and credentials are not command-editable. Project and global sandbox
configuration files remain protected from direct tool and Bash mutation even
when an approved write rule is broad. `Alt+S` is still registered in this
integration branch but is rejected for release and remains pending removal in
Slice 10b.

## What it does

**Bash commands** are wrapped with `sandbox-exec` (macOS) or `bubblewrap`
(Linux) to enforce network and filesystem restrictions at the OS level. Commands
entered with `!` are sandboxed by default. The current implementation accepts
`sandboxUserShell: false` to bypass sandboxing for `!` commands, but its trust
model remains under review; do not use it in untrusted projects.

**Read, write, and edit tool calls** are intercepted before execution and
checked against the same filesystem policy. The OS-level sandbox cannot cover
these tools because they run directly in the Node.js process rather than in a
subprocess.

When a block is triggered, a prompt appears with four options. Permission prompts
automatically select **Abort (keep blocked)** after 10 minutes by default. Set
`permissionPromptTimeoutSeconds` to a positive number to use a different timeout,
or set it to `0` to wait indefinitely. A timeout never grants permission.

- Abort (keep blocked)
- Allow for this session only
- Allow for this project — written to `.pi/sandbox.json`
- Allow for all projects — written to Pi's global agent directory (by default, `~/.pi/agent/sandbox.json`; respects `PI_CODING_AGENT_DIR`)

**Session allowances** are held in memory only. They are never written to disk
and the agent has no way to read or modify them. They are reset when the
extension reloads or pi restarts.

### Policy and prompts

Read, write, and domain checks compare the most-specific matching allow and deny
rules. A deny wins on equal specificity; a strictly more-specific allow wins
over a broader deny. An unmatched target is prompted where the operation supports
permission prompts. A matching deny blocks without a grant prompt, including
protected sandbox config paths. Relative project paths are resolved against the
project directory; project-scoped permissions retain their relative spelling.
The runtime currently treats write allowances as effective read allowances too;
formal product approval of that C-13 behavior is still pending.

`allowedDomains` supports `*.example.com` and `"*"`; `"*"` removes per-domain
prompts and triggers a warning. Filesystem allow rules may cover a directory,
so `allowWrite: ["."]` grants writes throughout the project (subject to
more-specific denies). Defaults remain in force when an array is configured or
set to `[]`; an empty project array cannot revoke a global or built-in grant.

### Git over SSH on macOS

The macOS unauthenticated SOCKS compatibility mode is enabled by default.
Only Git `clone`, `fetch`, `pull`, `push`, and `ls-remote` with SSH remotes get
the scoped transport; ordinary `ssh` is not proxied by this extension. Domain
policy still applies. Host keys must already be trusted in the user's standard
`known_hosts`; strict checking rejects mismatches, never auto-accepts keys, and
may require a narrow read allowance for that file. SSH authentication uses the
exact `SSH_AUTH_SOCK` approved by a **session-only** prompt, not identity files
or a broad Unix-socket grant. Fresh sessions require fresh approval. Another
local process that discovers the temporary SOCKS proxy port can use it while
this compatibility mode runs; disable it if you do not need Git-over-SSH.

### Credential policy (global config only)

Declare **policy metadata, never secret values**, in the global agent
`sandbox.json`. For example, if `PI_EXAMPLE_TOKEN` already exists in the
launch environment, this global declaration masks it in sandboxed processes
and permits substitution only for the named host:

```json
{
  "credentials": {
    "envVars": [
      { "name": "PI_EXAMPLE_TOKEN", "mode": "mask", "injectHosts": ["api.example.com"] }
    ]
  }
}
```

Project credential declarations are ignored. Masking requires an explicit,
nonempty host list (not `"*"`); unknown or value-bearing fields and plaintext
injection are rejected. Structured extraction requires fail-closed `deny` or
`error` mismatch handling; environment JWT decode is not supported by the
pinned runtime. On macOS, file-mask declarations degrade to read denial, not
file masking. Do not put tokens in configuration or permission prompts.

The footer shows a lock indicator while the sandbox is active.

## Acknowledgements
This private fork integrates work from
[carderne/pi-sandbox](https://github.com/carderne/pi-sandbox) by Chris Arderne.
It is maintained independently and is not published to a package registry.

Based on code from
[badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
by Mario Zechner, used under the
[MIT License](https://github.com/badlogic/pi-mono/blob/main/LICENSE).
