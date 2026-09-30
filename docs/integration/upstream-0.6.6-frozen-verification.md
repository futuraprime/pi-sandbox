# Frozen-install and CI-equivalent verification

- **Run:** 2026-09-30, in the actual `feature/upstream-merge` integration checkout.
- **Commit:** `499939e0bd8d23bb5814f90eb43d4e18062aa316` (`HEAD` and local `origin/feature/upstream-merge` matched before and after verification).
- **Environment:** macOS 15.7.9, Darwin arm64; Node `v22.22.2`; pnpm `10.34.3`.
- **Initial state:** clean tracked checkout; no source, test, or dependency edits were made for verification.

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Exit 0; lockfile up to date, resolution skipped, already up to date. pnpm warned that build scripts for `@google/genai@1.52.0`, `esbuild@0.28.1`, and `protobufjs@7.6.5` were ignored. No approval or bypass was applied. |
| `pnpm run ci:fmt` | Exit 0; all matched files formatted (27 files). |
| `pnpm run lint` | Exit 0; no diagnostics. |
| `pnpm run check` | Exit 0 (`tsc --noEmit`). |
| `pnpm test` | Exit 0; 165 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo. |
| `git diff --check` | Exit 0; no whitespace errors. |

There were no failed first attempts, retries, or observed flakes. Test output included expected fixture/runtime warnings and the PTY notice that stdin was not a terminal; the suite completed successfully.

## Integrity and CI boundary

SHA-256 for `package.json` was `bc82033373fd6c2c5e50ba11815cb3f533353dd94c6e02400281804bceef6665` both before and after. SHA-256 for `pnpm-lock.yaml` was `b154b4d5dc91b3b44a7a7dfea746090293380a682a9f6f0095ae13c15186c724` both before and after. Post-check inspection confirmed no tracked diff in `package.json`, `pnpm-lock.yaml`, `index.ts`, `src/`, or `test/`; `git diff --check` passed.

`.github/workflows/test.yml` defines one `test-ts` job on `ubuntu-latest`, Node 24, with frozen install, `ci:fmt`, `ci:lint`, `ci:check`, and `ci:test`. The local `lint`, `check`, and `test` scripts are the targets of those CI aliases; formatting and the frozen install were run with the CI commands. The workflow triggers on pushes to `main` and pull requests targeting `main`, not a direct push to `feature/upstream-merge`. This is local command-parity evidence only: GitHub Actions was not executed or checked, and local macOS/Node 22 does not verify the Ubuntu/Node 24 runner.

This run is not fresh bare-macOS release acceptance. The required fresh bare-macOS acceptance remains pending; historical platform evidence is not renewed by this check. No code, dependency, or schema change was made.