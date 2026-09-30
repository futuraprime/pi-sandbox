---
name: upstream-update
description: Guides reviewed upstream updates for Futuraprime's downstream pi-sandbox fork, including baseline selection, ledger-based reconciliation, isolated rehearsal, verification, and safe cleanup. Use when planning or integrating changes from carderne/pi-sandbox.
---

# Upstream updates for pi-sandbox

Use this skill for a **real upstream update** or an explicitly requested **synthetic rehearsal**. They are different tasks: a rehearsal proves only that a fixture change can cross an integration seam; it does not establish compatibility with an unreconciled upstream release, complete the proposal, or authorize integration, merge, or push.

This repository is the downstream `futuraprime/pi-sandbox` fork of `carderne/pi-sandbox`. Never push to the upstream remote, never open a PR against upstream, and never rewrite downstream `main`. Only use downstream `origin` for a push, after explicit user approval.

## Resolve the repository location and protect existing state

Pi resolves skill links relative to this skill directory. Do not assume the shell starts in the repository. Set `SKILL_FILE` to the absolute path Pi used to load this file, then derive the root:

```sh
SKILL_FILE=/absolute/path/to/.pi/skills/upstream-update/SKILL.md
REPO_ROOT="$(git -C "$(dirname "$SKILL_FILE")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"
```

Before any operation, inspect current state and remotes:

```sh
git status --short --branch
git worktree list --porcelain
git remote -v
git remote get-url origin
git remote get-url --push origin
git remote get-url upstream
git remote get-url --push upstream
```

Confirm the remote URLs really identify the downstream `futuraprime/pi-sandbox` and upstream `carderne/pi-sandbox`; remote names alone do not prove this. Do not run fetch/network operations until the user approves the specific fetch. Preserve existing edits, untracked files, branches, worktrees, and unrelated contents under `tmp/`. Do not switch/reset the user's checkout, use `git clean`, prune worktrees, or delete anything broadly. If state is ambiguous or would be overwritten, stop and ask.

## Phase 1: Select and prove an upstream baseline

For a real update, first record the last **actually integrated** upstream commit and the proposed release/ref; do not use a remembered version or assume current `upstream/main` is the intended target. Inspect existing local refs and repository metadata without changing them. Ask for approval naming the exact upstream remote/ref before fetching it. Then fetch only that approved ref; for example:

```sh
git fetch --no-tags upstream refs/heads/main:refs/remotes/upstream/main
# For an approved release tag instead:
git fetch upstream refs/tags/<approved-tag>:refs/tags/<approved-tag>
```

Record the exact full commit ID. For an annotated release tag, record both tag-object ID and peeled target (`git rev-parse 'refs/tags/<approved-tag>^{}'`); verify the target against upstream version/package metadata and release evidence, then check ancestry and compare it with the last integrated upstream baseline. Do not silently retarget an existing local ref or treat a tag name, `HEAD`, or a short hash as sufficient evidence. If the intended release or local ref differs from expectations, stop for clarification.

For a synthetic rehearsal, state the precise upstream-shaped baseline fixture and downstream snapshot being simulated. Use existing reviewed local refs when possible; do not fetch simply to recreate a past example. The [0.6.6 rehearsal report](../../../docs/integration/upstream-0.6.6-update-rehearsal.md) is a worked example only: its exact SHAs, refs, and synthetic change are historical evidence, **not** future update targets.

## Phase 2: Review change meaning before applying it

Read the [feature ledger](../../../docs/integration/upstream-0.6.6-feature-ledger.md), [integration proposal](../../../docs/proposals/proposal-integrate-upstream-0.6.6.md), and relevant linked checkpoints/reviews for the behavior under consideration. Compare the last integrated upstream commit to the approved candidate (for example, `git log --oneline <old>..<candidate>` and `git diff --stat <old>...<candidate>`), then inspect the actual changes. Classify every material behavior as retain, adapt, replace, defer, or reject; update the ledger/evidence for a real integration. Review policy/default/config/runtime changes and their tests, not just filenames or upstream test results. Preserve downstream security and ownership contracts unless the user has approved a specific change and its replacement evidence. Never treat a broad upstream merge or cherry-pick as semantic review.

## Phase 3: Isolate integration and rehearsal work

Do not experiment in the user's checkout or on `main`. After confirming the exact downstream base (normally an approved `origin/main` commit) and branch name, make disposable **project-local** worktrees/branches under an ignored, project-local directory such as `tmp/upstream-update-<unique-id>/`, with `spike/upstream-update-*` branch names. Check `git check-ignore -v tmp` first; if the chosen location is not ignored, ask before creating files or choose another safe location. Create only named worktrees and branches, and check names/paths are unused first. For a real integration, keep upstream-only history separate from the downstream integration branch; the integration branch belongs to the downstream repo and must not include downstream work on an upstream mirror.

A rehearsal should use a small, explicitly synthetic upstream-aligned change, a disposable downstream simulation, and focused seam tests. Preserve downstream test content when resolving conflicts. Do not claim a rehearsal is a real release update or platform acceptance.

Before applying, derive the protected/downstream-owned modules and their contract tests from the current ledger (including the relevant diagnostics, Git/SSH, configuration-protection, filesystem, status, and policy owners). Save a before hash for each path at the exact downstream base. After applying, record after hashes and inspect both:

```sh
git diff --name-status <downstream-base> <integration-head>
git diff --check <downstream-base> <integration-head>
```

Hash file contents with `git show <commit>:<path> | shasum -a 256` (record missing/new/deleted paths explicitly). Classify every change against the approved scope. Downstream-owned modules may change intentionally when the ledger, user approval, and replacement coverage call for it; **do not impose a universal no-change rule**. Unexpected protected-module differences or unexplained scope expansion are blockers, not cleanup opportunities.

Record each conflict by path, the relevant before/after content, resolution rationale, and validation. Keep integration through the narrow behavior seams and retain security tests; do not “fix” failures by loosening policy or deleting assertions.

## Phase 4: Verify in layers and report limitations honestly

Run focused tests for changed seams first, then the repository's full frozen-install and CI-equivalent checks from the integration worktree:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run lint
pnpm run ci:fmt
pnpm test
```

Also run affected focused contract/platform-neutral tests and `git diff --check`. Record exact commands, worktree, commit, exit status, test counts, OS, and whether checks used real OS facilities or mocks. Do not count a command accidentally run from another checkout. Do not skip a failed check, weaken an assertion, widen sandbox permissions, or label an unavailable check as passed; preserve its output and state the blocker.

Mocked tests, fixtures, source inspection, and checks run inside an agent sandbox are not fresh bare-macOS acceptance. Run required OS enforcement, Chromium, Git-over-SSH, or other release gates on a **fresh bare macOS host** as called for by the ledger/proposal. If unavailable, record the exact external gate and leave acceptance pending. Historical acceptance is useful evidence but is not fresh verification of a new candidate.

## Phase 5: Leave durable evidence and clean up narrowly

Write or update a durable integration report before discarding temporary refs/worktrees. Record: downstream and upstream repository URLs; exact old/candidate/baseline refs and full object IDs (including annotated tag and peeled target); package/release version evidence; merge base; change dispositions; changed-file scope; protected-module before/after hashes; focused and full check results; conflicts and resolutions; platform context and outstanding gates; approvals; and exact cleanup performed.

If synthetic commits, temporary refs, or worktrees will be discarded, preserve the **complete reproducible patch**, not just a summary or abbreviated diff. Capture binary-safe patch evidence from the exact baseline (for example, `git diff --binary <fixture-base> <synthetic-commit> -- <paths>`), plus the exact downstream resolved snapshot/patch when it differs, and verify it applies at the recorded base with `git apply --check`. Include fixture IDs, test commands/results, and conflict-resolution details. A synthetic report without its patch is not durable replay evidence.

Before cleanup, inspect status in each named worktree and ensure all required report/patch evidence is saved. Remove only worktrees/branches/directories created for this task, by exact path/name, and only after confirming they contain no user or unrecorded data. Never prune, clean, or remove unrelated worktrees, branches, or files.

## Phase 6: Real integration requires explicit authorization

A green rehearsal or passing tests is not approval to merge. Present the baseline, reviewed diff, scope/hash results, checks, blockers, and proposed downstream target. Obtain explicit user approval before any real merge into downstream history. Obtain separate explicit approval before any push. If approved, verify the destination push URL again and use only the confirmed downstream `origin` and approved downstream branch; never push to `upstream`, never change the upstream mirror, and never open a PR against `carderne/pi-sandbox`. If approval is absent or any release gate remains blocked, stop with the work isolated and report the exact state.
