# Review: upstream 0.6.6 integration — proposal conformance and sandbox security

- **Branch reviewed:** `feature/upstream-merge` at `7afdef5`
- **Proposal:** [Integrate upstream 0.6.6 without losing downstream policy](../proposals/proposal-integrate-upstream-0.6.6.md)
- **Date:** 2026-09-30
- **Scope:** (1) whether the implementation conforms to the proposal; (2) whether the sandbox leaves holes through which an agent controlling pi could act without authorisation or widen its blast radius, particularly in combination with Git.
- **Verification at review time:** `node --import tsx --test test/*.test.ts` — 173 tests, 171 pass, 0 fail, 2 skipped. No repository files were changed during the review; probes used scratch files under `tmp/` and were removed.

Live observations were made in a session running the *installed* pi-sandbox (its messages differ from this branch). Every finding below was also traced to the code on this branch, and the policy findings were reproduced by calling this branch's modules directly.

## Verdict

The branch substantially implements the proposal, but it should not be treated as release-ready. Three findings (S-1 to S-3) allow code execution outside the sandbox, or bypass of the policy, without any user prompt.

### Remediation status

- **S-1 — addressed for the agreed macOS scope.** Shared mandatory write protections now block direct `write`/`edit` and sandboxed Bash writes to standard Git hooks/configuration, linked-worktree pointer/configuration files, `.gitmodules`, `.pi/**` (no cache exceptions), `.envrc`, `.vscode/**`, and `.idea/**`, even with explicit write grants. Derived linked-worktree writes are narrowed to shared objects, refs, logs, packed-refs/locks, and the active worktree's operational metadata; the common Git directory remains readable.
- **Verification:** user-run `pnpm run all` passed formatting, lint, TypeScript, and all **186 tests**. Real macOS Seatbelt regression tests verified protected-write denials, including nested paths and explicit grants, and successful linked-worktree Git status/add/commit/branch operations. The initial OS test exposed a trailing-glob normalization gap; the mandatory patterns were corrected and the rerun passed.
- **Remaining S-1 limits:** the pinned Linux runtime ignores write-deny globs, so nested paths without concrete runtime denies remain unprotected there. Arbitrary `core.hooksPath` destinations are not automatically protected. This is not a cross-platform or all-configurations closeout of S-1.
- **S-2 — addressed and validated.** Security-specific path checks detect volume case sensitivity using read-only existing-ancestor probes, protect missing project/global configuration files and case variants of project/nested `.pi/` paths, and block direct `write`/`edit` before approval. Indeterminate sensitivity fails closed; known case-sensitive volumes retain case-distinct paths. General path/glob matching is unchanged. User-run `pnpm run all` passed formatting, lint, TypeScript, and all **189 tests**, with no skips, including the macOS missing-target write/edit regression and unknown-sensitivity fallback tests.
- **S-3 remains open.** The original findings below describe the reviewed baseline. S-1 was committed as `22aab0b`; S-2 is recorded in the commit containing this status update.

## 1. Proposal conformance

### Conforming

- Cumulative defaults → global → project composition with first-occurrence deduplication for all listed arrays and per-key `ignoreViolations` (`src/config.ts` `mergeConfigLayers`).
- Specificity-aware path and domain precedence: equal-specificity deny wins, strictly more-specific allow overrides, unmatched targets prompt, relative paths are resolved first (`src/policy.ts` `decidePathPolicy`, `decideDomainPolicy`).
- Project-relative persistence; canonical absolute session and global grants; canonical duplicate detection (`src/extension.ts` `applyChoice`/`projectRuleValue`; `src/sandbox-command.ts` `updateSandboxConfigFile`).
- `/sandbox` is display-only; `/sandbox-allow domain|read|write <target>` uses the editable prompt; the six-rule editor is removed; `updateSandboxConfigFile` is the single persistence route.
- Edited rules must match the blocked target, persistent grants require a second confirmation, timeouts abort without persistence, and attention events are emitted (`src/ui.ts`).
- Credentials are global-only and validated; environment `decode` is rejected; extraction requires `onExtractNoMatch` `deny`/`error`; plaintext injection is refused; credentials are passed through `buildRuntimeConfig`.
- Runtime pinned at 0.0.72 with the scoped Chromium profile adapter, without `allowAllUnixSockets`; the generic `sshProxy` is stripped; `Alt+S` is removed; the upstream subprocess, `allowPty`, and Bash write-prompting fixes are present.

### Deviations

| ID | Finding | Evidence |
| --- | --- | --- |
| C-1 | **Glob semantics differ between direct-tool preflight and the runtime.** The proposal requires one policy across preflight and runtime configuration. In `matchesPattern`, `*` also matches across `/` (it becomes `.*`) and `!` is treated as a wildcard. In the runtime's `globToRegex`, `*` stops at `/` (`[^/]*`) and `[`/`]` are glob syntax. Consequences: default `denyWrite: "*.pem"` blocks `certs/a.pem` for `write`/`edit`, but Bash can write it; the global `allowRead: "~/.pi/*"` lets the Read tool read `~/.pi/agent/auth.json`, while Bash cannot. The runtime also does not re-emit glob `denyRead` rules nested inside literal `allowRead` subpaths, so those denies are enforced only by preflight. | `src/policy.ts` `matchesPattern`; `@carderne/sandbox-runtime` `sandbox-utils.js` `globToRegex`, `macos-sandbox-utils.js` `generateReadRules`; reproduced by probe. |
| C-2 | **More-specific allow over a broader `denyWrite` works only for direct tools.** The macOS profile emits `denyWithinAllow` after allow rules, so the deny always wins in Bash. This is stricter, not weaker, but the policy is not consistent. | `macos-sandbox-utils.js` `generateWriteRules`. |
| C-3 | **Scalars are not validated.** Only arrays and credentials are validated; for example `"enabled": "false"` (a string) is truthy. The proposal requires malformed values to be ignored with a warning. | `src/config.ts` `mergeObjects`. |
| C-4 | **`sandboxUserShell` has shipped and can be set from project config**, although the proposal lists it for separate review and it remains an open question. | `src/config.ts`; `src/extension.ts` `user_bash` handler. |
| C-5 | **Parts of the proposal are stale.** The Verification section still lists "all six `/sandbox` rule types"; the Slice 4 text says `/sandbox-allow` was removed. | Proposal. |
| C-6 | **Release gates remain open** by the proposal's own status: GitHub Actions, fresh bare-macOS acceptance, and integration into downstream `main`. | Proposal status. |

## 2. Sandbox holes

Severity reflects an agent-controlled pi session on macOS with the current default and global configuration.

### Critical — code execution outside the sandbox, or policy bypass

**S-1. Files that later execute outside the sandbox are writable.** The default `allowWrite: "."` covers:

- `.git/hooks/*` and `.git/config` (`core.fsmonitor`, `core.hooksPath`, aliases, `url.*.insteadOf`), which run code the next time the user uses Git outside the sandbox;
- `.pi/extensions/*.ts` and `.pi/settings.json` packages, which pi loads for a trusted project, outside the sandbox, on the next start or `/reload`.

The pinned runtime fork has an empty `DANGEROUS_DIRECTORIES` list and no `.git/hooks` or `.git/config` mandatory denies. The global configuration also explicitly allows `./.git/config`, and its `filesystem.allowGitConfig` option is not part of the runtime schema, so it is silently ignored. A probe on this branch returned `allow` for `.git/hooks/pre-commit`.

The problem is larger in linked worktrees: `src/sandbox-filesystem.ts` grants read and write access to the whole common Git directory (here `/Users/Shared/projects/pi-sandbox/.git`), so the hooks, config and refs of every checkout are exposed.

*Remediation:* add mandatory write denies, enforced in both preflight and the runtime profile, for `.git/hooks`, `.git/config`, `.gitmodules`, `.pi/**` (other than known cache directories), `.envrc`, `.vscode` and `.idea`. For linked worktrees, grant only the refs, objects and `worktrees/<name>` entries Git needs, not hooks or config.

**S-2. Direct-tool config protection can be bypassed by changing case.** If `.pi/sandbox.json` does not exist, `canonicalizePath` cannot resolve the missing basename, so `.pi/Sandbox.json` keeps its typed case. `isSandboxConfigPath` then returns `false` (verified), and `allowWrite: "."` allows the write with no prompt. On case-insensitive APFS that file *is* the project configuration. It can set `filesystem.allowWrite: ["~"]` (effective immediately for `write`/`edit`, because `readConfig` is called on every tool call), `filesystem.disabled: true`, `network.allowAllUnixSockets`, `network.allowMachLookup: ["*"]`, or `enabled: false`. The same applies to a missing global configuration file whenever the agent directory is writable.

The Bash-side runtime protection is not affected: a test creating `.BASHRC` against the lowercase mandatory deny was blocked, so Seatbelt matching is case-insensitive.

*Remediation:* compare protected paths case-insensitively on case-insensitive volumes, and protect the whole `.pi/` directory from direct `write`/`edit`.

**S-3. Tools other than `read`/`write`/`edit`/`bash` bypass the policy entirely.** `tool_call` enforces only those four. pi's built-in `grep`/`find`/`ls` and every extension tool run in the pi process without checks. In the review session, Bash `ls ~/.ssh` was denied, but the extension `find` tool listed `~/.ssh/known_hosts`. Extension web or fetch tools likewise give network egress with no domain filtering.

*Remediation:* while the sandbox is enabled, block tools that are not known to be safe by default, or apply path and domain policy to them. Document the boundary.

### High

**S-4. Credentials are readable by default and can be sent out.** The default `allowRead` includes `~/.config` (for example `~/.config/gh`, `~/.config/gcloud`). `src/diagnostics.ts` itself classifies `~/.config/gh` as auth-adjacent. Sandboxed commands also inherit the whole pi environment (API keys, `GH_TOKEN`, …) unless variables are declared under `credentials`. With GitHub domains allowed, a readable token is enough to write data to GitHub and so exfiltrate it.

*Remediation:* deny known credential stores by default, and deny or mask sensitive environment variables by default (or pass an explicit environment allowlist).

**S-5. Project configuration can weaken policy, and is loaded regardless of project trust.** Most-local-wins scalars, and `network: { ...config.network }` in `buildRuntimeConfig`, let a project `.pi/sandbox.json` set:

- `filesystem.disabled`, `enabled: false` or `sandboxUserShell: false`;
- `network.allowAllUnixSockets`;
- `httpProxyPort`/`socksProxyPort` (an external proxy, which bypasses runtime domain filtering);
- `mitmProxy`, `parentProxy` or `tlsTerminate`;
- additive `allowMachLookup: ["*"]`.

This contradicts the "project configuration is untrusted" rationale applied to credentials, voids the "an empty array cannot weaken policy" guarantee, and makes S-2 much more severe. pi-sandbox reads `.pi/sandbox.json` whether or not the user trusted the project.

*Remediation:* allow project configuration to set only keys that add to or narrow policy, or require project trust before honouring weakening keys.

### Medium — Git blast radius

**S-6. One SSH-agent approval covers every command for the session, and local Git history is fully writable.** Once the agent socket is added to `allowUnixSockets`, every later command can push, force-push or delete branches on any repository the key can reach, and can sign as the user. Pushing secrets to a public repository the user owns is an exfiltration path. Locally, `.git` is writable, so `git reset --hard`, `git reflog expire --expire=now` followed by `git gc --prune=now`, or `rm -rf .git` can destroy unpushed work. In a linked worktree this includes other worktrees' refs and stashes.

*Remediation:* block or separately prompt for `--force*`, `--delete`, `--mirror`, `+refspec` and `:ref` pushes; consider confirming each push rather than granting the agent socket for the whole session; rely on server-side branch protection.

**S-7. The Chromium adapter grants network access to all commands, not only the browser.** With `allowBrowserProcess: true` (set globally), the adapter adds `network-outbound (remote ip "localhost:*")`, `network-bind`/`network-inbound (local ip "*:*")`, and full read/write of the per-user temp directory (`DARWIN_USER_TEMP_DIR`) for every sandboxed command. That gives access to any localhost service: databases, development servers, the user's Chrome debugging port, or a local proxy that bypasses domain filtering. It also allows listening on all interfaces, and reading or writing other applications' temporary files. The global configuration also sets `allowLocalBinding: true`.

*Remediation:* narrow inbound and bind rules to loopback, document that the grant applies to every command, and enable it per session rather than globally.

### Low

- **`set_git_upstream` runs Git outside the sandbox** against an agent-writable `.git/config` and `.git` pointer file. The pointer can redirect it to another repository. The current subcommands do not appear to run programs from configuration, but this is fragile if more commands are added.
- **Direct `write`/`edit` do not mirror the runtime's mandatory denies** (`.bashrc`, `.zshrc`, `.gitconfig`, `.mcp.json`, …).
- **`enableWeakerNetworkIsolation: true` is hard-coded** (trustd and configd mach lookups). The runtime documents trustd as a possible exfiltration vector. Both upstream and the downstream baseline already set it.
- **Writable `/tmp` and `~/.cache` allow cache poisoning** (pre-commit environments, uv, downloaded browser binaries) that is later executed outside the sandbox.
- **The unauthenticated SOCKS proxy is usable by other local processes.** It is still domain-filtered; this was an accepted trade-off.
- **The Bash config-path check is string-based**, so it can also block harmless reads. Actual protection comes from the runtime's case-insensitive Seatbelt deny, which held in testing.

## Recommended order

1. Fix S-1, S-2 and S-3 before treating the branch as release-ready.
2. Unify glob matching (C-1) by using a single matcher for preflight and runtime configuration.
3. Tighten defaults and configuration trust (S-4, S-5, S-7); these give the largest reduction in blast radius.
4. Add push restrictions (S-6), then update the stale proposal sections (C-5).
