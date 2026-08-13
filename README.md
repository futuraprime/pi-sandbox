# pi-sandbox

Sandbox for [pi](https://pi.dev/).

Sandboxes pi like this:

- read/write/edit: direct control using allow/deny lists
- bash: uses [`@carderne/sandbox-runtime`](https://www.npmjs.com/package/@carderne/sandbox-runtime) to control network and file system access

When a blocked action is attempted, the user is
prompted to allow it temporarily or permanently rather than silently failing.
Direct agent attempts to edit `.pi/sandbox.json` or `~/.pi/agent/sandbox.json`
are also blocked and redirected back through the same approval flow.

![demo](./demo/demo.gif)

## Notes

There is an example config at [sandbox.json](./sandbox.json). Browser mode grants the additional macOS process and IPC permissions Chromium needs, so only enable it when browser automation is required. Filesystem and remote-network restrictions remain enforced.

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

| Platform              | Install                                              |
| --------------------- | ---------------------------------------------------- |
| macOS (Homebrew)      | `brew install ripgrep`                               |
| macOS (MacPorts)      | `sudo port install ripgrep`                          |
| Linux (Debian/Ubuntu) | `sudo apt install ripgrep`                           |
| Linux (Fedora/RHEL)   | `sudo dnf install ripgrep`                           |
| Linux (Arch)          | `sudo pacman -S ripgrep`                             |
| From source / other   | <https://github.com/BurntSushi/ripgrep#installation> |

If `which rg` succeeds in your shell but pi still reports `rg not
found`, pi is being launched from a parent process whose `PATH` does
not include the directory containing `rg` (common when GUI launchers
inherit a minimal non-login `PATH`). On macOS, `/opt/homebrew/bin` and
`/usr/local/bin` are the usual culprits — make sure your launcher's
environment includes whichever one your install uses.

#### Install

```bash
pi install npm:pi-sandbox
```

#### Configure

Add a config like this either to `~/.pi/agent/sandbox.json` (global) or to `.pi/sandbox.json` (local).
Local config takes precedence over global.

Note below that pi-sandbox treats reads and writes differently.

```json
{
  "enabled": true,
  "allowBrowserProcess": true, // Chromium/Playwright; includes required macOS loopback and path-scoped ProcessSingleton permissions
  "network": {
    // macOS: needed for git-over-SSH — see "Git over SSH on macOS" below
    "allowUnauthenticatedSocksProxy": true,
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    // For READS in pi-sandbox:
    // - denyRead is a hard deny by default
    // - a more specific allowRead can punch through a broader denyRead
    // - paths matching neither side are promptable
    "denyRead": ["/Users", "/home"],
    "allowRead": [".", "~/.config", "~/.local", "Library"],

    // For WRITES:
    // - empty ALLOW means no write access at all
    // - DENY takes precedence and is never prompted
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

#### Usage

```
pi --no-sandbox                  disable sandboxing for the session
/sandbox                         show current configuration and session allowances
/sandbox allowRead <path>        add a project-local filesystem.allowRead entry
/sandbox denyRead <path>         add a project-local filesystem.denyRead entry
/sandbox allowWrite <path>       add a project-local filesystem.allowWrite entry
/sandbox denyWrite <path>        add a project-local filesystem.denyWrite entry
/sandbox allowedDomains <domain> add a project-local network.allowedDomains entry
/sandbox deniedDomains <domain>  add a project-local network.deniedDomains entry
/sandbox-debug                   show recent sandbox incidents for bash and !cmd
```

## What it does

**Bash commands** are wrapped with `sandbox-exec` (macOS) or `bubblewrap`
(Linux) to enforce network and filesystem restrictions at the OS level.

**Read, write, and edit tool calls** are intercepted before execution and
checked against the same filesystem policy. The OS-level sandbox cannot cover
these tools because they run directly in the Node.js process rather than in a
subprocess.

When a promptable block is triggered, pi-sandbox normally offers four options:

- Abort (keep blocked)
- Allow for this session only
- Allow for this project — written to `.pi/sandbox.json`
- Allow for all projects — written to `~/.pi/agent/sandbox.json`

For SSH agent access (`SSH_AUTH_SOCK`), pi-sandbox uses a narrower prompt:

- Allow SSH use for this session
- Abort

That SSH prompt grants auth capability for the current session without normalizing direct reads of private key files.

**Session allowances** are held in memory only. They are never written to disk
and the agent has no way to read or modify them. They are reset when the
extension reloads or pi restarts.

If the agent later tries to modify `.pi/sandbox.json` or
`~/.pi/agent/sandbox.json` directly, pi-sandbox blocks that write and reuses
the most recent blocked read/write/network request as the thing being approved.
The extension applies the approval itself; the original config-file write stays
blocked.

### What is prompted vs. hard-blocked

| Rule                                                  | Behaviour                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| Domain not in `allowedDomains`                        | Prompted (bash and `!cmd`)                                                 |
| Domain in `deniedDomains`                             | Hard-blocked at OS level, no prompt                                        |
| Read path matching neither `denyRead` nor `allowRead` | Prompted (read tool and bash diagnostics when attribution is clear)        |
| Read path in `denyRead`                               | Hard-blocked unless a more specific `allowRead` matches                    |
| Write path not in `allowWrite`                        | Prompted (write/edit tools and bash diagnostics when attribution is clear) |
| Write path in `denyWrite`                             | Hard-blocked, no prompt                                                    |
| Exact `SSH_AUTH_SOCK` access                          | Special session-only “Allow SSH use” prompt                                |

If a path is added to `allowWrite` via a prompt but is also present in
`denyWrite`, it remains blocked. A warning is shown explaining which config
files to check.

`allowedDomains` supports `*.example.com` wildcards. It also supports `"*"` to
allow all domains; pi-sandbox shows a warning when this is configured because it
removes per-domain prompts and can be easy to add accidentally. `allowWrite` uses prefix
matching, so `.` covers the entire current working directory.

> **⚠️ pi-sandbox read/write precedence:**
>
> - **Read:** `denyRead` is a hard deny by default. A more specific `allowRead`
>   can punch through it. Paths matching neither side are promptable.
> - **Write:** `denyWrite` takes precedence over `allowWrite` and is never
>   prompted. A path in `denyWrite` is always blocked, even if it matches
>   `allowWrite`.

### Bash diagnostics and `/sandbox-debug`

For clearly attributed sandboxed `bash` tool results, pi-sandbox now keeps the machine-readable `<sandbox_diagnostic>` block in the tool result content for the model, but hides that raw block in Pi's TUI. Users see a compact “Sandbox intervention” summary instead, with the normal command output available by expanding the tool result.

For interactive `!cmd` results, pi-sandbox shows a one-line sandbox notice such as:

```text
[sandbox: SSH auth; allowed for this session; retried successfully — /sandbox-debug for details]
```

When `!cmd` output is included in conversation context, pi-sandbox also records the raw `<sandbox_diagnostic>` block as a hidden session message so the agent can still inspect it later without showing it to the user by default.

pi-sandbox only emits these diagnostics when it can clearly attribute a sandbox intervention to the command. Normal command output remains unchanged otherwise.

`/sandbox-debug` shows the last 5 current-session bash/`!cmd` incidents, newest first, including:

- command preview
- final outcome
- primary violation and other violation count
- prompt choice
- whether config was mutated
- retry outcome
- per-violation details using real rule names

The history is in-memory only and is not persisted.

### Safe Git / SSH notes

If you want Git-over-SSH to work without making private keys directly readable, prefer SSH agent access over broad `allowRead` entries for `~/.ssh`.

Be careful with `allowAllUnixSockets: true`: it allows every Unix socket and is much broader than narrowly allowing the current SSH agent socket. Chromium/Playwright browser mode does not require it.

### Git over SSH on macOS

The sandbox routes git-over-SSH through a local SOCKS proxy by setting `GIT_SSH_COMMAND` to an `nc -X 5` ProxyCommand. Since sandbox-runtime 0.0.70 that proxy requires a per-session username/password token, but macOS BSD `nc` cannot send SOCKS5 credentials — so without the opt-out below, `git push`/`fetch`/`clone` over SSH fail at the handshake (`nc: authentication method negotiation failed`) _before_ the SSH-agent prompt can fire.

```json
{
  "network": { "allowUnauthenticatedSocksProxy": true }
}
```

This is the runtime's supported opt-out. It disables auth on the local SOCKS front-end only — the HTTP proxy (npm/curl and credential injection) stays authenticated, and `allowedDomains`/`deniedDomains` filtering still applies to every connect. The SSH-agent socket itself remains gated by the per-action approval prompt under `allowUnixSockets`/session allowance. Without this flag the token's job is to stop other local processes from using the SOCKS proxy while a session runs; on a single-user dev machine that risk is moot.

### Chromium and Playwright on macOS

The minimum sandbox-specific setting is:

```json
{
  "allowBrowserProcess": true
}
```

On macOS this automatically permits Chromium's required `kern.hv_vmm_present` sysctl, loopback binding, and read/write plus Unix-socket operations scoped to the current user's canonical `DARWIN_USER_TEMP_DIR`. Chromium uses that directory for `ProcessSingleton` even when `TMPDIR` points into the project. Do not add the Darwin temp directory to filesystem rules or enable `allowAllUnixSockets` for this purpose.

You still need normal read permission for the chosen Chromium application/executable and write permission for any explicit Playwright user-data directory outside the project. Remote browser traffic remains governed by `allowedDomains` and `deniedDomains`.

### Manual validation

Suggested manual checks:

1. **Blocked network precheck**
   - Run a command that hits a host outside `allowedDomains`.
   - Confirm the network prompt appears.
   - Confirm the TUI shows a compact sandbox summary instead of a raw diagnostic block.

2. **Blocked read diagnostic**
   - Run a command that tries to read a denied path such as `~/.ssh/...`.
   - Confirm the result identifies the read target and guidance is safer for auth-adjacent paths.

3. **SSH auth prompt flow**
   - With `SSH_AUTH_SOCK` set, run an SSH/Git command that needs the agent.
   - Confirm pi-sandbox offers the session-only “Allow SSH use” prompt.
   - Confirm a successful retry shows a compact sandbox summary in the UI while preserving the underlying diagnostic metadata.

4. **Debug incident history**
   - Run `/sandbox-debug`.
   - Confirm incidents are newest first and include prompt choice, config mutation, retry state, and violation details.

If neither file exists, built-in defaults apply (see above for the defaults).

> Side note: upstream/read-precedence wording across related sandbox docs still needs reconciliation later. This README documents pi-sandbox's actual behavior today.

The footer shows a lock indicator while the sandbox is active.

## Ackowledgements

Based on code from
[badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
by Mario Zechner, used under the
[MIT License](https://github.com/badlogic/pi-mono/blob/main/LICENSE).
