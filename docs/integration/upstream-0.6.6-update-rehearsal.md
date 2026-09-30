# Upstream 0.6.6 update rehearsal

- **Date:** 2026-09-30
- **Result:** Synthetic UI change cherry-picked onto a disposable downstream simulation; the protected downstream modules and tests remained byte-for-byte unchanged.
- **Boundary:** This is a seam/update-process rehearsal only. It does not change production source on `feature/upstream-merge`, establish compatibility with an actual later upstream release, close the proposal, or complete Slice 10b.

## Baseline selection and exact refs

The Slice 10a audit explicitly identifies the reviewed 0.6.6 baseline as local `upstream/main` at `d76ad64` (not merely an assumed current upstream head). I used that exact audited commit:

| Role | Exact ref | Object ID |
| --- | --- | --- |
| Reviewed upstream baseline branch | `refs/remotes/upstream/main` | `d76ad64a42532f83639f934019aabdeb8c20f4fa` |
| Upstream HEAD alias | `refs/remotes/upstream/HEAD` | `d76ad64a42532f83639f934019aabdeb8c20f4fa` |
| 0.6.6 release tag object | `refs/tags/v0.6.6` | `6cab7cc62192369572d1001c339e0113d2e3c3b7` (annotated tag) |
| 0.6.6 release tag target | `refs/tags/v0.6.6^{}` | `d76ad64a42532f83639f934019aabdeb8c20f4fa` |
| Downstream simulation baseline / integration HEAD | `refs/heads/feature/upstream-merge` | `eac51457f021a9914711463f537e9981f9b70f76` |
| Downstream `main` and `origin/main` (observed unchanged) | `refs/heads/main`, `refs/remotes/origin/main` | `757f0586fc7d9877a37901e6976830672bc93ed8` |

Selection was cross-checked against `docs/integration/upstream-0.6.6-slice-10a-audit.md`, the annotated `v0.6.6` tag target, the `0.6.6` commit/package metadata, and ancestry: the audited baseline is an ancestor of the integration HEAD. The tag object and tag target are recorded separately so the baseline is unambiguous. All refs were already local. No fetch, push, or edits to `main`, `origin/*`, or `upstream/*` refs occurred.

Repository guidance read: root `AGENTS.md` and the supplied coding skill at `/projects/pi-toolkit/skills/coding/SKILL.md`. Project instructions require pnpm/TypeScript.

## Disposable setup and synthetic commits

Created two worktrees and `spike/` branches under the ignored project-local `tmp/` directory. Each worktree used a symlink to the existing root `node_modules`; no install, dependency change, or lockfile edit was made.

```sh
git worktree add -b spike/upstream-0.6.6-rehearsal-upstream \
  tmp/upstream-0.6.6-rehearsal/upstream \
  d76ad64a42532f83639f934019aabdeb8c20f4fa
git worktree add -b spike/upstream-0.6.6-rehearsal-downstream \
  tmp/upstream-0.6.6-rehearsal/downstream \
  eac51457f021a9914711463f537e9981f9b70f76
ln -s "$PWD/node_modules" tmp/upstream-0.6.6-rehearsal/upstream/node_modules
ln -s "$PWD/node_modules" tmp/upstream-0.6.6-rehearsal/downstream/node_modules
```

The synthetic UI improvement displays the normalized permission-prompt timeout in the `/sandbox` configuration view, including `disabled` when the existing timeout helper disables a timer. It changes no permission or policy behavior.

The red/green run was performed in the upstream worktree. An initial unqualified `node --import tsx --test test/ui.test.ts` was accidentally run from the integration root: it passed 12/12 tests in the current checkout, but did **not** exercise the rehearsal worktree and is not counted as rehearsal evidence. The correctly scoped red run was:

```sh
cd tmp/upstream-0.6.6-rehearsal/upstream
node --import tsx --test test/ui.test.ts
```

It exited 1 as expected: 4 passed, 1 failed. The new assertion failed because the configuration display lacked `Permission prompt timeout: 30 seconds`. After the implementation, the same focused suite passed 5/5.

### Synthetic commit and replay identities

| Worktree | Commit | Parent | Result |
| --- | --- | --- | --- |
| Upstream fixture | `2f8796366cc752c0b038a65746997421fc6bcf20` (`Improve sandbox configuration prompt-timeout display`) | reviewed baseline `d76ad64a42532f83639f934019aabdeb8c20f4fa` | Synthetic patch committed on the disposable upstream branch. |
| Downstream simulation | `8a9d717ce7b2e1647e6fe051fe661e55f19af84d` (same subject) | integration baseline `eac51457f021a9914711463f537e9981f9b70f76` | Cherry-pick completed after a test-file conflict was resolved. |

The exact synthetic source/test patch is the full output of `git diff d76ad64a42532f83639f934019aabdeb8c20f4fa 2f8796366cc752c0b038a65746997421fc6bcf20 -- src/ui.ts test/ui.test.ts`, not an abbreviated illustration. A subsequent full TypeScript check identified that the upstream test fixture omitted required `SandboxConfig.filesystem` fields (TS2345). I corrected only that fixture in both temporary worktrees and reran typechecking and the focused suites successfully. The downstream fixture additionally requires `unixSockets`. These fixture completions were local rehearsal-worktree changes, not additional commits and not changes to the integration branch.

### Exact upstream synthetic commit patch

```diff
diff --git a/src/ui.ts b/src/ui.ts
index 3cebecc..8e7c27d 100644
--- a/src/ui.ts
+++ b/src/ui.ts
@@ -367,10 +367,14 @@ export function formatSandboxConfiguration(
   paths: { globalPath: string; projectPath: string },
   allowances: SessionAllowances,
 ): string {
+  const timeoutMs = permissionPromptTimeoutMs(config.permissionPromptTimeoutSeconds);
+  const timeoutDescription = timeoutMs === undefined ? "disabled" : `${timeoutMs / 1000} seconds`;
+
   return [
     "Sandbox Configuration",
     `  Project config: ${paths.projectPath}`,
     `  Global config:  ${paths.globalPath}`,
+    `  Permission prompt timeout: ${timeoutDescription}`,
     "",
     "Network (bash + !cmd):",
     `  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
diff --git a/test/ui.test.ts b/test/ui.test.ts
index 6617e36..0880f23 100644
--- a/test/ui.test.ts
+++ b/test/ui.test.ts
@@ -4,6 +4,7 @@ import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-cod
 import assert from "node:assert/strict";

 import {
+  formatSandboxConfiguration,
   permissionOptions,
   permissionPromptRemainingSeconds,
   permissionPromptTimeoutMs,
@@ -93,3 +94,13 @@ test(
     assert.deepEqual(result, { action: "abort", value: "example.test" });
   },
 );
+
+test("sandbox configuration displays the permission prompt timeout", () => {
+  const output = formatSandboxConfiguration(
+    { permissionPromptTimeoutSeconds: 30 },
+    { globalPath: "/home/user/.pi/sandbox.json", projectPath: "/workspace/.pi/sandbox.json" },
+    { domains: [], readPaths: [], writePaths: [] },
+  );
+
+  assert.ok(output.includes("  Permission prompt timeout: 30 seconds"));
+});
```

Blank context lines in the embedded patches omit the usual single diff-prefix space to avoid trailing Markdown whitespace; `git apply` accepts this representation.

### Exact upstream fixture completion

This separate local working-tree diff corrects the missing `filesystem` fixture fields after the synthetic commit patch above:

```diff
diff --git a/test/ui.test.ts b/test/ui.test.ts
index 0880f23..c9257fa 100644
--- a/test/ui.test.ts
+++ b/test/ui.test.ts
@@ -97,7 +97,10 @@ test(

 test("sandbox configuration displays the permission prompt timeout", () => {
   const output = formatSandboxConfiguration(
-    { permissionPromptTimeoutSeconds: 30 },
+    {
+      permissionPromptTimeoutSeconds: 30,
+      filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
+    },
     { globalPath: "/home/user/.pi/sandbox.json", projectPath: "/workspace/.pi/sandbox.json" },
     { domains: [], readPaths: [], writePaths: [] },
   );
```

### Exact final downstream resolved snapshot

The following is the complete tracked diff from downstream integration baseline `eac51457f021a9914711463f537e9981f9b70f76` to the final downstream rehearsal working tree. It includes the resolved test-file conflict and both downstream fixture type requirements (`filesystem` and `unixSockets`); apply it directly at that exact baseline to reproduce the final source/test snapshot without relying on deleted worktree branches:

```diff
diff --git a/src/ui.ts b/src/ui.ts
index 0e322db..01b4e54 100644
--- a/src/ui.ts
+++ b/src/ui.ts
@@ -454,10 +454,14 @@ export function formatSandboxConfiguration(
   allowances: SessionAllowances,
   linkedGitMetadata: string[] = [],
 ): string {
+  const timeoutMs = permissionPromptTimeoutMs(config.permissionPromptTimeoutSeconds);
+  const timeoutDescription = timeoutMs === undefined ? "disabled" : `${timeoutMs / 1000} seconds`;
+
   return [
     "Sandbox Configuration",
     `  Project config: ${paths.projectPath}`,
     `  Global config:  ${paths.globalPath}`,
+    `  Permission prompt timeout: ${timeoutDescription}`,
     "",
     "Network (bash + !cmd):",
     `  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
diff --git a/test/ui.test.ts b/test/ui.test.ts
index 3e694de..8d1d97d 100644
--- a/test/ui.test.ts
+++ b/test/ui.test.ts
@@ -4,6 +4,7 @@ import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-cod
 import assert from "node:assert/strict";

 import {
+  formatSandboxConfiguration,
   permissionOptions,
   permissionPromptRemainingSeconds,
   permissionPromptTimeoutMs,
@@ -335,3 +336,16 @@ test("attention is emitted once for a real prompt, while no-UI aborts without at
   assert.equal(attention, 0);
   assert.equal(customCalls, 0);
 });
+
+test("sandbox configuration displays the permission prompt timeout", () => {
+  const output = formatSandboxConfiguration(
+    {
+      permissionPromptTimeoutSeconds: 30,
+      filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
+    },
+    { globalPath: "/home/user/.pi/sandbox.json", projectPath: "/workspace/.pi/sandbox.json" },
+    { domains: [], readPaths: [], writePaths: [], unixSockets: [] },
+  );
+
+  assert.ok(output.includes("  Permission prompt timeout: 30 seconds"));
+});
```

### Reproduction

At the reviewed upstream baseline, apply the full synthetic patch above, commit it if a cherry-pickable object is desired, then apply the upstream fixture-completion diff and run the upstream focused UI test. At the downstream baseline, the complete resolved snapshot diff above is sufficient to reproduce the final replay/resolution state and is the durable replay patch. Alternatively, reconstruct the upstream commit and cherry-pick it onto a worktree at the downstream baseline, resolving `test/ui.test.ts` to the complete final test content shown above. Run the focused suites and type/format checks listed below; no dependency install is needed.

### Cherry-pick conflict and resolution

Command:

```sh
cd tmp/upstream-0.6.6-rehearsal/downstream
git cherry-pick 2f8796366cc752c0b038a65746997421fc6bcf20
```

Observed result: exit 1 with `CONFLICT (content): Merge conflict in test/ui.test.ts`; `src/ui.ts` auto-merged. The only conflict was in `test/ui.test.ts`, at end-of-file where the upstream test was appended but downstream had added prompt/validation tests. Resolution retained the entire downstream test block and appended the synthetic timeout assertion, preserving the downstream UI/prompt/policy assertions. The downstream `src/ui.ts` retains its existing editable prompt, project-relative display, SSH prompt, socket display, and specificity/policy notes; the cherry-picked hunk only adds the timeout row. No other file was resolved or edited. The post-resolution focused UI suite passed.

## Verification record

Commands below were run from the named worktree unless explicitly noted.

| Command | Observed result |
| --- | --- |
| `cd tmp/upstream-0.6.6-rehearsal/upstream && node --import tsx --test test/ui.test.ts` (red, before implementation) | Exit 1; 4 passed, 1 failed, expected missing-timeout assertion. |
| Same command after implementation and typed test-fixture correction | Exit 0; 5 passed, 0 failed/skipped/todo. |
| `cd tmp/upstream-0.6.6-rehearsal/downstream && node --import tsx --test test/ui.test.ts test/extension.test.ts test/policy.test.ts` | Exit 0; 71 passed, 0 failed/skipped/todo. Includes downstream prompt, extension lifecycle/command, and policy contracts. |
| `cd <each worktree> && pnpm exec oxfmt --check src/ui.ts test/ui.test.ts` | Both passed. |
| `cd <each worktree> && pnpm exec tsc --noEmit` | Both passed after test-fixture completion. First downstream attempt before that correction exited 2 with TS2345 because required `filesystem` was missing; fixture was corrected and both checks rerun successfully. |
| `git diff --check` in the upstream fixture and `git diff --check eac51457f021a9914711463f537e9981f9b70f76` in the downstream simulation | Passed. |
| Expected-scope assertion and protected-file hash loop described below | Passed; only `src/ui.ts` and `test/ui.test.ts` differ from downstream baseline. |
| Embedded synthetic upstream patch compared with the exact `git diff` between the recorded baseline and commit | Exact match. |
| Extracted full downstream snapshot patch checked with `git apply --check` at `eac51457f021a9914711463f537e9981f9b70f76` | Passed; final snapshot patch applies cleanly. |
| Final integration source/test equality check against `eac51457f021a9914711463f537e9981f9b70f76` | Passed after cleanup; no tracked `src/` or `test/` changes. |
| Final `git diff --check` after the documentation edits | Passed. |

The rehearsal did not run the full project test suite, CI, frozen install, or macOS sandbox/platform checks. The repository's `pnpm fmt` script targets only `index.ts`, `src`, and `test`; no documentation formatter is configured, so Markdown formatting was not run. The source/test suites were not rerun during the report/ledger/proposal documentation-only completion.

## Scope and downstream-owned module evidence

The before value is SHA-256 of each path read from downstream baseline `eac51457f021a9914711463f537e9981f9b70f76`; after is SHA-256 of the final downstream simulation working tree after replay/resolution. Both `src/git-worktree.ts` and its matching test are included in addition to the explicitly audited diagnostics/Git/command/filesystem modules.

| Downstream-owned file | Before SHA-256 | After SHA-256 | Result |
| --- | --- | --- | --- |
| `src/diagnostics.ts` | `4e0ec5a82341f96b810a304d875fd2b899c8d32c9fb1f71222b74b09e024e950` | `4e0ec5a82341f96b810a304d875fd2b899c8d32c9fb1f71222b74b09e024e950` | match |
| `src/git-upstream.ts` | `78827e5497cebbf9ba419a3edfcac91706f094585c03c49a12eb59e0158642de` | `78827e5497cebbf9ba419a3edfcac91706f094585c03c49a12eb59e0158642de` | match |
| `src/git-worktree.ts` | `a9e6db533fde8e09e7a2b7282e9dd04905470aa3b4bd6d58458a29bf36fec62e` | `a9e6db533fde8e09e7a2b7282e9dd04905470aa3b4bd6d58458a29bf36fec62e` | match |
| `src/sandbox-command.ts` | `51e95a621d4f863797414fde2f306e4c033cd43bb93ecfe6c59f63c2e020bb97` | `51e95a621d4f863797414fde2f306e4c033cd43bb93ecfe6c59f63c2e020bb97` | match |
| `src/sandbox-filesystem.ts` | `8f6751586f104e0b433f926c2d4f1621f9aa20d8dee1f582a9e495145ee1dc12` | `8f6751586f104e0b433f926c2d4f1621f9aa20d8dee1f582a9e495145ee1dc12` | match |
| `test/diagnostics.test.ts` | `f4e261b7b4a19a32612382cd0af9438514dfc0848df7a1735d1bf466e45e76c1` | `f4e261b7b4a19a32612382cd0af9438514dfc0848df7a1735d1bf466e45e76c1` | match |
| `test/git-upstream.test.ts` | `2360e7b619c9b88ed0b465164b0200c90e73c14e5f12fab8638ac048d14538f0` | `2360e7b619c9b88ed0b465164b0200c90e73c14e5f12fab8638ac048d14538f0` | match |
| `test/git-worktree.test.ts` | `dc21fdda971cbaf1348452e2aa435f888807f70eac23ad8e71e9f4a0e0bd3b1f` | `dc21fdda971cbaf1348452e2aa435f888807f70eac23ad8e71e9f4a0e0bd3b1f` | match |
| `test/sandbox-command.test.ts` | `6ef1ec50447ff10d654e48858452e22d1eb473c0bdb72fb0bc50ab41b1ff5577` | `6ef1ec50447ff10d654e48858452e22d1eb473c0bdb72fb0bc50ab41b1ff5577` | match |
| `test/sandbox-filesystem.test.ts` | `f315ad7323203eb2badefb80aecd5dc8accd3ab38921e097e44ebf1e144706f3` | `f315ad7323203eb2badefb80aecd5dc8accd3ab38921e097e44ebf1e144706f3` | match |

The tracked working-tree delta from the downstream simulation baseline was asserted to be exactly:

```text
M src/ui.ts
M test/ui.test.ts
```

`git diff --exit-code eac51457f021a9914711463f537e9981f9b70f76 -- . ':(exclude)src/ui.ts' ':(exclude)test/ui.test.ts'` exited 0. The non-UI code and tests were not changed.

## Cleanup and limits

After capturing the commits, exact patch text, hashes, test results, and file-scope assertion, removed only the two named rehearsal worktrees (including their `node_modules` symlinks), their local branches, and the now-empty `tmp/upstream-0.6.6-rehearsal/` directory. `tmp/` itself was not empty: it contains unrelated existing logs and a script, which were left untouched. No rehearsal refs, fixture worktrees, or temporary evidence files are retained; this report is the durable record.

Cleanup evidence:

```text
Final worktree list:
worktree /Users/Shared/projects/pi-sandbox
HEAD 757f0586fc7d9877a37901e6976830672bc93ed8
branch refs/heads/main

worktree /Users/ehensleigh/orca/workspaces/pi-sandbox/feature-upstream-merge
HEAD eac51457f021a9914711463f537e9981f9b70f76
branch refs/heads/feature/upstream-merge

worktree /Users/Shared/projects/pi-sandbox-ssh-test
HEAD edd6a7e42236e8ee5ce913f46b8379541485995b
branch refs/heads/chore/slice-9-5-acceptance

Remaining `spike/upstream-0.6.6-rehearsal-*` branches: none
Rehearsal directory: removed
`tmp/`: retained; unrelated contents: affected-tests.log, final-tests-retry.log, final-tests.log, launch-ssh-retest.sh
Unrelated acceptance worktree registration `/Users/Shared/projects/pi-sandbox-ssh-test`: retained at edd6a7e42236e8ee5ce913f46b8379541485995b (shown as prunable by `git worktree list`)

Post-cleanup ref assertions:
refs/heads/main                               757f0586fc7d9877a37901e6976830672bc93ed8
refs/remotes/origin/main                      757f0586fc7d9877a37901e6976830672bc93ed8
refs/heads/feature/upstream-merge             eac51457f021a9914711463f537e9981f9b70f76
refs/remotes/upstream/main                    d76ad64a42532f83639f934019aabdeb8c20f4fa
refs/tags/v0.6.6                              6cab7cc62192369572d1001c339e0113d2e3c3b7
```

The integration worktree's tracked `src/` and `test/` diff against `eac51457f021a9914711463f537e9981f9b70f76` was empty (`git diff --quiet` exit 0). Root status after cleanup showed only this untracked report. The pre-existing `pi-sandbox-ssh-test` acceptance worktree was left as found; no prune or cleanup was run on it.

This is a synthetic cherry-pick across the reviewed 0.6.6 baseline and this integration snapshot. It does not prove compatibility with any real unreconciled release, demonstrate macOS enforcement, constitute a fresh platform acceptance, or authorize merging/releasing. Frozen-install/CI verification and fresh bare-macOS acceptance remain pending; the proposal remains open and the rest of Slice 10b is not marked complete.
