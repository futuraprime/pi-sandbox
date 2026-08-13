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

## macOS Chromium browser policy

Changed:
- Updated `@carderne/sandbox-runtime` to a pinned fix that makes `allowBrowserProcess` supply Chromium's required macOS policy as one browser-mode contract.
- Browser mode now allows `sysctl-read` for `kern.hv_vmm_present`, loopback binding, and read/write plus AF_UNIX bind/connect access scoped to the canonical `getconf DARWIN_USER_TEMP_DIR`.
- Added generated-policy regression coverage and documented the minimum Chromium/Playwright configuration.

Why:
- Chromium 147 aborts when `kern.hv_vmm_present` is denied and creates `ProcessSingleton` beneath Darwin's per-user temp directory regardless of project-local `TMPDIR`.
- These are browser implementation requirements, so users should not need undocumented filesystem entries, `network.allowLocalBinding`, or the broad `network.allowAllUnixSockets` escape hatch.

Security boundary:
- The browser additions apply only when `allowBrowserProcess` is true.
- Unix socket bind/connect access is limited to the current user's canonical Darwin temp directory; browser mode does not emit the all-path Unix socket rule.
- Filesystem and remote-network restrictions remain in force.
