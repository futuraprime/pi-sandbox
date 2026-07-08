# pi-sandbox context

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
