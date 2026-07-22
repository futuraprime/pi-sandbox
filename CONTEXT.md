# pi-sandbox context

## Sandbox config self-protection

Changed:
- Tool-driven `write`, `edit`, and direct bash attempts are checked before sandbox enablement/config state, so disabling the sandbox does not bypass config-file guards.
- Relative tool paths are resolved from Pi's session cwd, protecting `<cwd>/.pi/sandbox.json` when the extension process has a different cwd.
- The global path now follows `getAgentDir()/sandbox.json`, and both local and global config paths are forcibly included in the OS sandbox's `denyWrite` rules.
- Added path-protection regressions in `sandbox-protection.test.ts` and a local-only `/sandbox` mutation regression in `sandbox-command.test.ts`.

Why:
- A relative local config path could miss the dedicated guard and flow into generic permission handling, which could then update the global config.
- Sandbox configuration must remain writable through explicit user-controlled extension flows such as `/sandbox`, never directly through model tools.

Verification:
- `npm run all` passed: formatting, linting, type-checking, and 35 tests across 3 files.

Follow-ups:
- None known.

## Manual `/sandbox` config commands

Changed:
- Added `sandbox-command.ts` with pure parsing/config mutation helpers for manual `/sandbox` subcommands.
- Extended the existing `/sandbox` command in `index.ts` so user-invoked commands can update project-local `<cwd>/.pi/sandbox.json`:
  - `allowRead`, `denyRead`, `allowWrite`, `denyWrite`
  - `allowedDomains`, `deniedDomains`
- Added separate tests in `sandbox-command.test.ts`; diagnostics tests remain focused in `diagnostics.test.ts`.
- Updated `package.json` scripts and `tsconfig.json` so the new helper and tests participate in fmt/lint/typecheck/test workflows.
- Documented the new commands in `README.md`.

Why:
- Users need a manual slash-command path to update sandbox config without asking the model to directly edit `sandbox.json`.
- The write path is intentionally narrow: no model-callable config editing tool was added, and existing direct sandbox config protections remain in place.

Verification:
- `npm run all` passed.
- Test result: 2 files, 30 tests passing.
- Direct attempts by model/tool access to inspect sandbox config diff remain blocked by existing sandbox protection.

Follow-ups:
- None known.
