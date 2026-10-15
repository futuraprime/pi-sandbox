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
- **S-3 remains open and remediation is deferred at the user's request.** Selective enforcement that preserves search/web tool utility is captured in the [extension-tool policy boundary proposal](../proposals/proposal-extension-tool-policy-boundary.md); no implementation is authorized. The original findings below describe the reviewed baseline. S-1 was committed as `22aab0b`; S-2 is recorded in the commit containing this status update.
- **S-4 remains open.** Conditional credential-use trade-offs are captured in the [conditional credential boundary proposal](../proposals/proposal-conditional-credential-boundary.md); this draft does not authorize implementation or live-credential testing.

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
| C-1 | **Addressed for the guarded supported macOS Bash path; not a universal runtime-semantics fix.** The adapter re-emits ordinary read denies after grants, preserving shared specificity precedence while retaining directory metadata for traversal and denying file data/listings outside strictly more-specific grants. Equal-specificity denies remain denied; a narrower explicit grant may override `denyRead: ["/"]`; the pinned literal-root permission remains. Credential-file denies stay hard. Unsupported required profiles block Bash. | `src/macos-write-specificity.ts`, `src/sandbox-runtime.ts`; unit and real Seatbelt tests in `test/sandbox-runtime.test.ts` and `test/sandbox-macos-filesystem.test.ts`. The adapter compares the generated read section to pinned `@carderne/sandbox-runtime` 0.0.72 before modification. |
| C-2 | **Addressed for the guarded supported macOS Bash path; not a universal runtime-semantics fix.** The guarded profile adapter preserves specificity-aware precedence for eligible ordinary write denies while retaining equal-specificity deny precedence. Evidence and limits follow. | `src/macos-write-specificity.ts`; pinned `macos-sandbox-utils.js` `generateWriteRules`; macOS Seatbelt regression tests. |
| C-3 | **Addressed and verified.** Recognized scalar overrides are validated before each global/project merge; invalid values warn and are ignored, preserving inherited values. Valid `false` and finite nonpositive prompt timeouts remain supported. | `src/config.ts` `validatedSection` / `mergeObjects`; `test/config.test.ts`; inventory and evidence below. |
| C-4 | **Implementation prepared; verification pending.** The config-controlled user-shell bypass is removed. Manual `!`/`!!` commands can explicitly approve one unsandboxed run/retry through the existing prompt, without granting future access. | `src/config.ts`; `src/extension.ts` `user_bash` / diagnostic operations; `src/ui.ts`; evidence and limits below. |
| C-5 | **Parts of the proposal are stale.** The Verification section still lists "all six `/sandbox` rule types"; the Slice 4 text says `/sandbox-allow` was removed. | Proposal. |
| C-6 | **Release gates remain open** by the proposal's own status: GitHub Actions, fresh bare-macOS acceptance, and integration into downstream `main`. | Proposal status. |

### C-2 remediation evidence and limits

Implementation is committed as `ee02bfc` (Seatbelt regression `0d99286`; glob-semantics prerequisite `2a689fb`). `buildRuntimeConfig` records provenance for the exact runtime-config object and snapshots its write arrays. Before adapting a Bash profile, the adapter requires that same registered object, unchanged arrays, a recognized profile shape, and an exact match between the profile's write section and the section generated by the pinned `@carderne/sandbox-runtime` 0.0.72 generator. Unknown profile shapes, unregistered or cloned objects, and mutated arrays are left on the stock restrictive profile.

For an eligible profile, only strictly higher-specificity grants are excluded from ordinary configured write denies: both the general `file-write*` denial and path-scoped `file-write-create`/`file-write-unlink` denials. Equal-specificity denies still win. Mandatory write denies and runtime built-in denies are unchanged; literal-ancestor safeguards are unchanged and can still block creation or rename of a grant root or ancestor. The OS tests verified permitted operations within existing granted directories. The adapter changes no read or credential rules, does not close C-1, and does not establish a blanket proof for arbitrary glob combinations. Other platforms and dependencies are unchanged.

User-reported C-2 verification: `pnpm lint` completed with 0 warnings/errors; `pnpm check` succeeded; the previously failing focused adapter unit passed; full macOS `pnpm test` reported 200 total, 197 passed, 0 failed and 3 deliberate opt-in skips. Real Seatbelt tests passed for the covered narrower literal/glob grants, denied siblings, equal-specificity ties and nested denials, mandatory fixture paths and runtime built-ins, ancestor rename, and symlink create/rename replacements. Legitimate create, overwrite, delete, rename and atomic replacement within existing granted directories also passed.

### C-1 remediation evidence and limits

The C-1 correction is in the working tree and leaves the exact `@carderne/sandbox-runtime` 0.0.72 dependency unchanged. `buildRuntimeConfig()` snapshots read-policy provenance for its exact runtime-config object. Before modifying a macOS Bash wrapper, the adapter requires that object, unchanged policy arrays, the actual command and shell, and an exact generated read-section match against the pinned 0.0.72 generator. An unsupported required profile throws before Bash is spawned; wrapper cleanup still runs on this fail-closed path.

For ordinary `denyRead` patterns, the final Seatbelt rules deny `file-read*` on non-directories and deny `file-read-data` on the full denied matcher, with exclusions only for strictly more-specific configured allows. The second rule blocks both file contents and directory listings; the first preserves the pinned directory-metadata exemption needed for realpath/traversal. Equal-specificity denies are not excluded. A root deny's `file-read-data` guard retains an exact `(literal "/")` exception for the pinned root permission while denying descendants except under explicit narrower grants. Credential `deny` and `mask` source paths receive hard final `file-read*` denies with no specificity exclusions.

Focused real Seatbelt evidence on the current Darwin host: `test/sandbox-macos-filesystem.test.ts` verifies ordinary and literal/glob precedence, equal-specificity denials, denied file reads and directory listings, successful metadata/realpath traversal through a denied directory, masked-credential source denial, and `denyRead: ["/"]` with an allowed narrower file, denied sibling, and root realpath. `test/sandbox-runtime.test.ts` covers profile/provenance failure, idempotence, root matcher exceptions, hard credential rules, and the production Bash fail-closed path. The separate existing credential tests verify fake file-material non-disclosure and host-scoped masked environment substitution.

Limits: this is only for the verified generated macOS Bash profile; it does not alter direct-tool policy or add an adapter on other platforms. Runtime 0.0.72's whole-file `mode: "mask"` remains deny-only on macOS (fake file delivery is Linux-only), and no Linux file-mask substitute is introduced here. User-run verification from this checkout: `pnpm check` succeeded; `pnpm lint` reported 0 warnings/errors; `pnpm test` reported 206 total, 203 passed, 0 failed and 3 deliberate credential-CLI opt-in skips, including both real macOS C-1 Seatbelt regressions and the C-2 regression; `pnpm ci:fmt` passed. The parent session's earlier attempt was blocked before TypeScript ran by a lockfile-read permission error; the successful user-run checks provide the final verification evidence.

### C-3 remediation inventory and verification

Implementation: `dce9add`, isolated on `fix/c3-scalar-config-validation` from `dce9926`. Configuration flows through `readConfigFile` → `mergeConfigLayers` → `mergeObjects`; validation belongs before each override spread, not after inheritance has been lost. Defaults are trusted typed input. Recognized `undefined` overrides are treated as absent without warning.

The inventory follows `SandboxConfig` and the exported schemas in pinned `@carderne/sandbox-runtime` 0.0.72 (`dist/sandbox/sandbox-config.js`):

| Settings | Accepted values |
| --- | --- |
| `enabled`, `sandboxUserShell` | Booleans only. |
| `permissionPromptTimeoutSeconds` | Finite numbers; zero/negative values retain the existing timer-disabled meaning. |
| `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `allowPty`, `allowBrowserProcess` | Runtime-schema booleans. |
| `mandatoryDenySearchDepth` | Integer 1–10. |
| `bwrapPath`, `socatPath` | Nonempty absolute binary paths. |
| `network.strictAllowlist`, `allowAllUnixSockets`, `allowLocalBinding`, `allowUnauthenticatedSocksProxy` | Booleans. |
| `network.httpProxyPort`, `socksProxyPort` | Integers 1–65535. |
| `filesystem.disabled` | Boolean. |
| `network.filterRequest` | Function for programmatic callers; JSON values cannot supply a callback. |
| `network.mitmProxy` | Runtime object schema: nonempty `socketPath`, nonempty valid `domains` list. |
| `network.tlsTerminate` | Runtime object schema: optional paired nonempty `caCertPath`/`caKeyPath`, optional `excludeDomains` and `extraCaCertPaths` arrays. |
| `network.parentProxy` | Runtime object schema: optional URL strings `http`/`https`, optional string `noProxy`. |
| `ripgrep` | Runtime object schema: string `command`, optional string-array `args` and string `argv0`. |
| `seccomp` | Runtime object schema: optional strings `applyPath`/`argv0`. |
| `windows` | Runtime object schema: optional 1–20-character `sandboxUser`, UUID `sublayerGuid`/`wfpSublayerGuid`, ordered inclusive `proxyPortRange` within 1–65535 with width ≤64, and `srtWin.path` as an optional nonempty string. |

Nested runtime options retain their existing atomic replacement semantics: an invalid object override is ignored as a whole, while a valid object replaces its inherited object. Schema parsing is used for validation only, not coercion or rewriting. Existing cumulative policy arrays, `ignoreViolations`, credential validation, unknown-key behavior, and `sshProxy` stripping are unchanged. This inventories the declared configuration surface; it does not start forwarding currently unused runtime options or alter project trust, C-4, or other security findings.

Verification evidence: the implementation agent observed failing scalar regressions before the fix, then passed `pnpm exec tsx --test test/config.test.ts` (23/23), `pnpm check`, and the formatting check after the final refinements. Tests cover invalid global/default and project/inherited fallback, JSON loading, valid false/zero/negative timeout values, port bounds, callback preservation, atomic object replacement, and nonmutation. The agent's `pnpm test -- test/config.test.ts` attempt expanded to the full suite and failed in the existing runtime output-drain test (`missing stdout token 1`); no assertion was weakened. The coordinating session's required `pnpm check && pnpm lint && pnpm test && pnpm ci:fmt` attempt failed before execution with `ERR_PNPM_LOCKFILE_READ_FILE` / `Operation not permitted`. `git diff --check` passed. Subsequent user-run verification outside the sandbox from this checkout at `3d2aa4e` passed `pnpm check && pnpm lint && pnpm test && pnpm ci:fmt`: TypeScript succeeded, lint reported 0 warnings/errors, all matched files passed formatting, and the full suite reported 210 total, 207 passed, 0 failed, and 3 intentional credential-CLI opt-in skips. The output-drain test passed on this run, as did the real macOS C-1/C-2 Seatbelt regressions. This verifies C-3 without closing unrelated findings or the remaining release gates.

### C-4 per-command manual-shell approval (verification pending)

The user rejected project/global and session-wide user-shell bypass settings in favor of explicit per-command approval. `sandboxUserShell` is retired from types/defaults and warns/is ignored in both configuration layers; its historical entry in the C-3 inventory above describes the earlier verified snapshot. No toggle command is added.

Existing domain and SSH-agent preflight checks offer **Run once unsandboxed** for manual `!`/`!!` commands. Recognized failed runtime policy checks offer **Retry once unsandboxed**, with a wrapped warning that the entire command loses sandbox restrictions and may repeat earlier side effects. Promptable rules retain their existing grant choices; ordinary hard-deny rules offer only bypass/abort, never persistent grants. Approval uses pi's existing local Bash backend for the original command/cwd once, with readiness, generation, cancellation, and consumed-approval checks. Subsequent commands remain sandboxed; `!!` still suppresses model diagnostic messages. Agent Bash never receives the local bypass option.

Protected-config/Git-upstream command guards, attributed mandatory write/config denials, and unavailable lifecycle state remain hard blocks. This is not a general shell parser or a proof of side-effect-free retries. Browser and structured ambiguous sandbox violations may offer a manual retry; an ambiguous textual error alone, arbitrary nonzero exit, thrown wrapping/profile failure, timeout, or abort does not authorize bypass. As with any unsandboxed shell command, successful approval removes OS sandbox restrictions for the entire command; textual guards cannot prevent arbitrary scripts from performing equivalent operations.

Verification remains pending on `fix/c4-manual-shell-command-bypass`. The initial agent focused run timed out after obsolete manual denied-domain/Linux-SSH prompt expectations failed; those assertions were subsequently adapted and new regression tests added. An intermediate agent lint run passed, but typechecking exposed a stale `sandboxUserShell` entry in `scripts/chromium-acceptance.ts`; that unused fixture key was removed without changing acceptance behavior. The coordinating session's later focused command, `pnpm exec tsx --test test/config.test.ts test/ui.test.ts test/diagnostics.test.ts test/extension.test.ts`, was blocked before execution by `ERR_PNPM_LOCKFILE_READ_FILE` / `Operation not permitted`. No final test/type/lint/format pass or real interactive `!`/`!!` acceptance is claimed. User-run verification is required before marking C-4 addressed.

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
2. Glob-semantics slice 1 aligns direct matching and canonicalization with the pinned converter. C-1 and C-2 have guarded supported macOS Bash profile corrections documented above; neither is a universal runtime-semantics change.
3. Tighten defaults and configuration trust (S-4, S-5, S-7); these give the largest reduction in blast radius.
4. Add push restrictions (S-6), then update the stale proposal sections (C-5).
