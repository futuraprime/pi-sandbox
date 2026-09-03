# Proposal: Focused command preflight and Git upstream fixes

- **Status:** Proposed
- **Date:** 2026-04-02

## Context

The `ssh-compound-preflight` branch adds convenience behaviour around the existing OS-level sandbox:

- direct Git branch-tracking mutations are redirected from Bash to `set_git_upstream`;
- compound commands that may use SSH are preflighted so the agent can approve SSH-agent access before retrying.

Review found that a small command scanner cannot reliably understand every shell construct, and that reproducing Git's complete alias/configuration behaviour would add substantial complexity.

These checks are **not** a security boundary. If detection misses a command, it still runs through the existing sandbox. The sandbox remains responsible for enforcing filesystem, network, and Unix-socket restrictions.

## Decision

Keep the implementation focused on common cases and fix only the two correctness issues that affect the supported paths:

1. use Git itself to validate branch names for `set_git_upstream`; and
2. make SSH socket approval agree with the sandbox's platform-specific path behaviour.

Retain direct command detection as best effort. Do not build a shell parser or a complete Git alias resolver.

## Scope

### Direct Git detection

Continue recognising ordinary direct commands such as:

```sh
git push -u origin main
git branch --set-upstream-to=origin/main main
git config branch.main.remote origin
git config --unset branch.main.merge
```

Recognise short-option clusters such as `git push -vu origin main`, since Git treats `-vu` as including `-u`.

The scanner does not need to understand command substitutions, every shell grammar feature, or context-dependent aliases. Commands using those forms may be missed by the redirect and will be handled by the sandbox as normal Bash commands.

### Git upstream tool

Replace the custom branch-name regular expression with fixed-argument calls to:

```text
git check-ref-format --branch <local-branch>
git check-ref-format --branch <remote-branch>
```

Keep the existing restrictions:

- only the literal `origin` remote is accepted;
- Git is spawned with `shell: false`;
- Git environment variables that redirect repository/configuration access are removed;
- Git aliases are disabled for the tool's own commands; and
- branch arguments remain separated with `--` where applicable.

This delegates branch-name grammar to Git and supports valid names such as `_foo`, `foo_`, and `föo` without weakening argument handling.

### SSH socket approval

Use normalised path matching for configured socket allowances. A configured path should match itself and descendants, but not a sibling sharing the same prefix; for example, `/tmp/ssh` matches `/tmp/ssh/agent.123` but not `/tmp/ssh-other/agent.123`.

On macOS, retain path-scoped SSH-agent approval.

On Linux, do not offer path-scoped session approval because the sandbox runtime cannot enforce `allowUnixSockets` by path there. Explain that explicit `network.allowAllUnixSockets=true` is required for broad Unix-socket access.

No default sandbox permissions are changed by this work.

## Non-goals

- A complete shell parser or shell interpreter.
- Complete Git alias/configuration resolution, including `-C`, `-c`, and `--config-env` contexts.
- Fail-closed handling for syntax the scanner does not understand.
- Changes to `@carderne/sandbox-runtime`.
- Changes to default filesystem or network restrictions.
- Automatic broad Unix-socket access on Linux.

## Verification

Add focused regression tests for:

- combined Git short options;
- valid and invalid Git branch names, including Unicode and boundary underscores;
- fixed, non-shell Git argument handling;
- exact, descendant, normalised, and sibling-prefix socket paths; and
- refusal of path-scoped SSH approval on Linux.

Run formatting, linting, TypeScript checking, and the complete test suite.
