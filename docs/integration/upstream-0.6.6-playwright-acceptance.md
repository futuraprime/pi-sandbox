# Upstream 0.6.6: Playwright acceptance evidence

This records a focused Playwright test pass separately from the nested-sandbox failures. It is **not** a full browser acceptance pass or a closed merge gate.

## User-run focused test — passed

- **Host baseline:** In a normal macOS Terminal, the user ran `DEBUG=pw:browser pnpm exec vitest run --project=unit src/page/Dateline.test.js` from `/Users/Shared/economist/article-components` on branch `marber`. The `@economist/article-components` checkout was `6.0.0-beta.45`, with Playwright `1.59.1` and Vitest `4.1.6`. At 21:57 local time on 2026-09-30, the test passed **2/2** with a clean exit.
- **Pi nested run:** The user then launched `pi --no-extensions --extension /Users/ehensleigh/orca/workspaces/pi-sandbox/feature-upstream-merge/index.ts` and ran the same command with Pi's `!` prefix. The first attempt (22:00 local) failed: Chromium could not find `icudtl.dat` (invalid file descriptor), and cleanup reported `kill EPERM`. The user approved session-only read access to `/Users/ehensleigh/Library/Caches/ms-playwright/chromium_headless_shell-1217` using `/sandbox-allow read /Users/ehensleigh/Library/Caches/ms-playwright/chromium_headless_shell-1217`.
- At 22:03 local (21:03:37 UTC), the rerun passed **1 file / 2 tests in 1.49s**. Browser PID `60735` exited 0 and cleanup succeeded; the completion marker was `[sandbox:sandbox intervention; completed]`. Playwright used `--no-sandbox --password-store=basic --use-mock-keychain --remote-debugging-pipe`, a temporary profile, and loopback base `127.0.0.1:63316`. The `--no-sandbox` argument was present in the test browser launch; the extension did not inject it. The user's shell-hook markers evidenced the outer runtime was active. No production policy change was made.

The extension path was loaded from the integration checkout; `c049b1035a43dda60bace58b248824bc490120c5` is the observed checkout HEAD reference from the last host harness, **not** a commit pinned to the Pi test run. Thus this is evidence of the reported test outcome, not exact per-run source provenance or proof of complete process isolation.

## Separate Chromium harness result — still failed

The earlier host harness report `tmp/chromium-acceptance-20260930-205628.json` is under ignored `tmp/` and is not durable checked-in evidence. It records a direct-host `sandbox_init(kSBXProfilePureComputation, SANDBOX_NAMED, ...)` probe succeeding (exit 0), while the same API in enabled and disabled workers returned `EPERM` (86). Application Chromium 152 with its own sandbox enabled reached DevTools but failed to render the DOM and exited 133. This supports nested sandbox initialization refusal as a possible explanation; it does not establish Chromium's cause or prove behavior across all Chromium internals. The harness acceptance remains **failed**; see the [harness instructions and scope](upstream-0.6.6-chromium-acceptance-harness.md).

## User-run focused Storybook test — passed

In the same Pi session, retaining the browser-revision session read grant, the user ran:

```sh
!DEBUG=pw:browser pnpm exec vitest run --project=storybook src/stories/Dateline.stories.js
```

At 22:14 local (21:14:53 UTC) on 2026-09-30, this passed **1 file / 5 tests in 2.27s**. The same bundled headless shell and existing Playwright launch flags were used. Browser PID `65834` exited 0, and Playwright reported temporary-directory cleanup completed. Browser logs showed Vite connections to `127.0.0.1:63315`; the extension completion marker was `[sandbox: network access; completed — /sandbox-debug for details]`. No additional allowance approval was reported.

Storybook's attempt to create `/Users/ehensleigh/.storybook` for its global settings failed with `EPERM`, but the tests passed. No home-directory write grant was added; this nonfatal denial is retained rather than treated as a reason to expand access. The completion marker does not by itself establish which network requests were made or that an external-domain denial gate was tested.

## Additional user-run full-suite and downstream comparison

- **Integration full suite:** At 22:52:39 local on 2026-09-30, the user ran `!pnpm exec vitest run` in Pi. Vitest reported **81 files / 281 tests passed** in **11.29s**, but also **17 unhandled `Failed to fetch` errors** and exit 1. The affected stories call `cp.fetchSection`; the default `RelatedArticles` request is `https://cp-bridge.api.economistdatateam.com/v1/section/graphic-detail/6`. This is not a clean full-suite pass. The user separately reported that the full suite passes in a normal terminal, but did not provide its full output.
- **Integration network check:** After requesting a session grant for that exact hostname, the selected `RelatedArticles` run at 22:55:39 local on 2026-09-30 reported **3 assertions passed**, **3 fetch errors**, exit 1, in **2.16s**. The grant notice itself was not pasted. Pi subsequently ran the following exact-endpoint check and received HTTP 200:

  ```sh
  !curl --max-time 15 --silent --show-error --output /dev/null --write-out 'HTTP %{http_code}\n' https://cp-bridge.api.economistdatateam.com/v1/section/graphic-detail/6
  ```

  This supports authorized runtime-proxy transport reachability to the endpoint; it does **not** show that Chromium used that proxy or explain all fetch errors.
- **Downstream comparison:** The user then switched Pi to the explicit extension `/Users/Shared/projects/pi-sandbox/index.ts`. The initial downstream attempt at 21:02:31 local on 2026-10-01 was blocked reading `icudtl.dat` and ran no tests; the earlier integration session grant had expired. The legacy `/sandbox` read allowance for `/Users/ehensleigh/Library/Caches/ms-playwright/chromium_headless_shell-1217` persisted in the project directly (it was not an offered scope); the user confirmed keeping this path read-only for the workflow and confirmed the API hostname was allowed downstream. The matched downstream `RelatedArticles` run at 21:06:27 took **2.10s**, with **3 assertions passed**, the same **3 fetch errors**, and exit 1.

  This matched result does not demonstrate an integration-specific network regression; it indicates the same fetch limitation was present downstream in this comparison. The assistant observed the downstream main checkout ref `757f0586fc7d9877a37901e6976830672bc93ed8` via `git worktree list` before testing, but it was not pinned as per-run provenance. Complete effective configurations were not captured, so this is contextual same-user evidence, not exact reproducibility across all versions or configurations.

Earlier Playwright debug output showed default Chromium arguments including `--no-sandbox` and no explicit proxy flag. Together with curl's HTTP 200, this is consistent with—but does not prove—the hypothesis that the browser is not using the runtime HTTP proxy. It does not establish the cause of every fetch failure. Storybook's `~/.storybook` settings write still failed nonfatally with `EPERM`; no home-directory write grant was added.

## Separate follow-up: browser-proxy support — not implemented

Automatic browser-proxy support is a separate security-reviewed follow-up, not part of this acceptance evidence or an approved production change. Any review must retain hostname allow/deny and authentication policy at the runtime, avoid weakening outer filesystem or network controls, avoid automatic `--no-sandbox` injection or running browsers outside the wrapper, and preserve existing project test configuration. It must examine coverage of Vitest/Playwright launches versus arbitrary browser execution, opt-in and fail-closed behavior, and keeping credentials in memory without leaking them to stdout or artifacts. Proposed evidence should include successful requests to a granted API domain, denials for unapproved and explicitly denied hosts, and working local test servers, plus the unchanged full-suite command passing inside Pi. No implementation approach or transparent-browser behavior is established here; production changes require separate approval.

## Remaining scope

The focused unit/browser and Storybook tests passed, but the Pi integration full suite exited 1 with unhandled fetch errors, and the separate Chromium harness still fails. The matched downstream fetch errors do not waive either failure or automatically satisfy formal merge-gate criteria. These results do not establish full-suite compatibility in Pi, general Chromium isolation acceptance, or closure of the nested-sandbox gate.
