# Upstream 0.6.6: Playwright acceptance evidence

This records a focused Playwright test pass separately from the nested-sandbox failures. It is **not** a full browser acceptance pass or a closed merge gate.

## User-run focused test — passed

- **Host baseline:** In a normal macOS Terminal, the user ran `DEBUG=pw:browser pnpm exec vitest run --project=unit src/page/Dateline.test.js` from `/Users/Shared/economist/article-components` on branch `marber`. The `@economist/article-components` checkout was `6.0.0-beta.45`, with Playwright `1.59.1` and Vitest `4.1.6`. At 21:57 local time on 2026-09-30, the test passed **2/2** with a clean exit.
- **Pi nested run:** The user then launched `pi --no-extensions --extension /Users/ehensleigh/orca/workspaces/pi-sandbox/feature-upstream-merge/index.ts` and ran the same command with Pi's `!` prefix. The first attempt (22:00 local) failed: Chromium could not find `icudtl.dat` (invalid file descriptor), and cleanup reported `kill EPERM`. The user approved session-only read access to `/Users/ehensleigh/Library/Caches/ms-playwright/chromium_headless_shell-1217` using `/sandbox-allow read /Users/ehensleigh/Library/Caches/ms-playwright/chromium_headless_shell-1217`.
- At 22:03 local (21:03:37 UTC), the rerun passed **1 file / 2 tests in 1.49s**. Browser PID `60735` exited 0 and cleanup succeeded; the completion marker was `[sandbox:sandbox intervention; completed]`. Playwright used `--no-sandbox --password-store=basic --use-mock-keychain --remote-debugging-pipe`, a temporary profile, and loopback base `127.0.0.1:63316`. The `--no-sandbox` argument was present in the test browser launch; the extension did not inject it. The user's shell-hook markers evidenced the outer runtime was active. No production policy change was made.

The extension path was loaded from the integration checkout; `c049b1035a43dda60bace58b248824bc490120c5` is the observed checkout HEAD reference from the last host harness, **not** a commit pinned to the Pi test run. Thus this is evidence of the reported test outcome, not exact per-run source provenance or proof of complete process isolation.

## Separate Chromium harness result — still failed

The earlier host harness report `tmp/chromium-acceptance-20260930-205628.json` is under ignored `tmp/` and is not durable checked-in evidence. It records a direct-host `sandbox_init(kSBXProfilePureComputation, SANDBOX_NAMED, ...)` probe succeeding (exit 0), while the same API in enabled and disabled workers returned `EPERM` (86). Application Chromium 152 with its own sandbox enabled reached DevTools but failed to render the DOM and exited 133. This supports nested sandbox initialization refusal as a possible explanation; it does not establish Chromium's cause or prove behavior across all Chromium internals. The harness acceptance remains **failed**; see the [harness instructions and scope](upstream-0.6.6-chromium-acceptance-harness.md).

## Remaining scope

The focused Dateline unit/browser test does not establish full-suite, Storybook, or general Chromium isolation acceptance. The selected Storybook test remains pending:

```sh
!DEBUG=pw:browser pnpm exec vitest run --project=storybook src/stories/Dateline.stories.js
```
