# Proposal: Harden command preflight and Git upstream redirection

- **Status:** Proposed
- **Date:** 2026-04-02

## Context

The `ssh-compound-preflight` branch adds two related safeguards:

1. preflight SSH-agent access before compound shell commands run; and
2. redirect Git branch-tracking mutations from the general Bash tool to the narrowly scoped `set_git_upstream` tool.

The implementation currently uses a small custom shell tokenizer and partial Git argument parsing. Review found several cases where the preflight does not model the command that the shell or Git will actually execute. Some cases bypass the intended policy; others block valid operations or prompt when access is already allowed.

These checks form a security boundary. False negatives can allow a protected mutation through Bash, while false positives can leave users without a supported way to complete a valid operation.

## Decision drivers

- Git upstream mutations must not bypass `set_git_upstream` through ordinary shell syntax, Git option forms, or aliases.
- SSH preflight must inspect every command that the shell can execute before earlier parts of a compound command cause side effects.
- Detection should fail closed when syntax cannot be interpreted safely.
- The scoped tool should accept every valid Git branch name that can be passed safely as a fixed argument.
- SSH socket checks should match the sandbox runtime's effective path semantics.
- Tests should cover both accepted commands and bypass attempts.

## Findings and proposed fixes

### 1. Shell substitutions are not inspected

The tokenizer splits top-level separators but does not parse command substitutions such as `$()` or backticks. For example:

```sh
echo "$(git push -u origin main)"
echo "$(ssh host)"
```

The current checks see `echo` as the executable and do not inspect the nested command. The first example can mutate branch tracking through Bash; the second can run SSH without preflight.

#### Proposed fix

Replace the ad hoc tokenizer with a shell parser that produces an abstract syntax tree and recursively inspect:

- command substitutions;
- pipelines and logical lists;
- grouped commands and subshells;
- nested `sh -c` commands;
- process substitutions, if supported by the configured shell; and
- commands in assignments and redirections.

If the parser cannot represent syntax accepted by the configured shell, fail closed for commands that may contain Git or SSH execution rather than treating them as safe. Do not keep extending the current character scanner one construct at a time: partial shell parsing is difficult to make reliable as a security boundary.

Add tests for quoted and unquoted `$()`, backticks, nested substitutions, grouped commands, and malformed or unsupported syntax.

### 2. Combined Git short options bypass upstream detection

Git accepts short-option clusters. The current check recognises `-u` and options beginning with `-u`, but misses forms such as:

```sh
git push -vu origin main
```

Git interprets this as `-v -u`, so it sets the upstream even though the redirect does not trigger.

#### Proposed fix

Parse short-option clusters for the relevant Git subcommands and treat `u` as `--set-upstream` wherever Git permits it. Keep long-option handling explicit and account for `--`, options with attached values, and options with separate values.

Prefer a small Git-specific argument parser with per-subcommand option tables over string-prefix checks. Add positive tests for `-u`, `-uv`, `-vu`, and attached or separated values, plus negative tests for unrelated options.

### 3. Invocation-specific and repository-specific aliases are resolved incorrectly

Alias discovery runs `git config` in the tool context's working directory. It does not reproduce repository selection or temporary configuration from the original invocation. These examples can therefore evade detection:

```sh
git -c alias.publish='!git push -u origin main' publish
git -C /other/repository publish
```

The first defines the alias only for that invocation. The second may use a repository-local alias that is not present in the original working directory.

#### Proposed fix

Parse Git's global options before resolving the operation:

- apply each `-C` in order to determine the effective working directory;
- include supported `-c name=value` and `--config-env` settings when determining the effective alias;
- continue removing environment variables that can redirect Git to unrelated repositories or configuration; and
- resolve aliases recursively with cycle and depth limits.

Shell aliases beginning with `!` must be passed through the same shell-command inspection as the original command. If an alias cannot be resolved or parsed safely, block it and direct the caller to use `set_git_upstream` or a non-alias Git command.

Tests should create aliases in different repositories, supply aliases with `-c`, cover chained and cyclic aliases, and verify that alias shell bodies cannot hide an upstream mutation.

### 4. The scoped tool rejects valid Git branch names

`set_git_upstream` uses a custom ASCII-only regular expression for refs. Git permits names that this expression rejects, including `_foo`, `foo_`, and Unicode names such as `föo`.

Because Bash tracking mutations are redirected, users with these valid names have no supported fallback.

#### Proposed fix

Use Git itself for ref validation through fixed, non-shell arguments:

```text
git check-ref-format --branch <local-branch>
git check-ref-format refs/heads/<remote-branch>
```

Continue passing branch names after `--` to mutation commands and retain the literal `origin` restriction. Where practical, separately verify that the local branch and `refs/remotes/origin/<remote-branch>` exist so error messages distinguish invalid names from missing refs.

Tests should include underscores at component boundaries, Unicode, nested names, maximum lengths, and Git-invalid forms such as `..`, `@{`, control characters, and `.lock` suffixes.

### 5. SSH socket preflight does not match sandbox path semantics

The preflight checks configured sockets with exact string equality:

```text
allowedSockets.includes(SSH_AUTH_SOCK)
```

On macOS, the sandbox runtime normalises each configured socket path and grants it using `subpath` semantics. A configured `/tmp/ssh` can therefore permit `/tmp/ssh/agent.123` at runtime while the preflight still prompts or blocks it.

#### Proposed fix

Use one shared socket-path policy for both preflight and sandbox initialisation. Prefer exposing or importing a matching helper from the sandbox runtime. If that is not possible, implement a local helper that mirrors the runtime's:

- tilde and absolute-path normalisation;
- exact-path and descendant matching;
- path-boundary handling, so `/tmp/ssh` does not match `/tmp/ssh-other`; and
- platform-specific behaviour.

Document that `allowUnixSockets` is path-based on macOS but ignored by the Linux seccomp implementation. Ensure the preflight does not report a grant as effective on platforms where the runtime cannot apply that grant.

Add tests for exact paths, descendants, sibling prefixes, relative or tilde paths, normalised `.` and `..` components, and Linux/macOS behaviour.

## Proposed decision

Adopt a fail-closed, structured parsing approach:

1. replace the custom shell tokenizer with recursive shell syntax inspection;
2. introduce explicit Git global-option and subcommand-option parsing;
3. resolve aliases in the effective Git invocation context;
4. delegate ref validity to `git check-ref-format`; and
5. share socket normalisation and matching semantics with the sandbox runtime.

Until structured parsing is available, unsupported shell constructs that may execute Git or SSH should be blocked rather than allowed optimistically.

## Consequences

### Positive

- The documented Git redirection becomes difficult to bypass through normal shell or Git syntax.
- SSH preflight occurs before nested SSH commands can execute.
- Valid branch names remain usable through the scoped tool.
- Preflight prompts agree with effective sandbox permissions.
- Parsing responsibilities become explicit and independently testable.

### Negative

- A shell parser may add a dependency and must be checked against the shells pi supports.
- Fail-closed handling can reject unusual commands until their syntax is supported.
- Alias resolution requires careful handling of Git's ordered global options and configuration environment.
- Platform-specific socket behaviour adds test and maintenance cost.

## Rejected alternatives

### Continue extending regular expressions and the current tokenizer

Rejected because each added shell construct leaves other execution forms unmodelled. This is not a reliable security boundary.

### Remove Bash interception and rely only on instructions

Rejected because model instructions do not enforce the restriction and cannot prevent accidental or indirect upstream mutations.

### Reject all Git aliases

This is safe but unnecessarily disruptive. It may be used as a temporary fail-closed measure, but the target behaviour is to allow aliases that can be resolved and proven not to mutate tracking configuration.

### Keep custom ref validation

Rejected because duplicating Git's ref grammar is unnecessary and risks both false positives and false negatives.

## Verification plan

- Add table-driven unit tests for every command and ref form described above.
- Add integration tests that execute accepted Git forms in temporary repositories and assert whether tracking changed.
- Add regression tests proving every bypass is blocked before execution.
- Test alias resolution with `-C`, multiple ordered `-C` options, `-c`, repository-local config, and shell aliases.
- Test SSH path matching against representative sandbox-runtime profiles on macOS and the documented Linux behaviour.
- Run formatting, linting, TypeScript checking, and the complete test suite.
