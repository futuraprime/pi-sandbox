# Local credential CLI compatibility probes

`test/credential-cli-compatibility.test.ts` is opt-in. It runs the installed `gh` and `npm` executables against a local HTTPS fixture through the sandbox runtime's TLS-terminating proxy; it does not install tools or contact a public service.

Run only when you want to exercise the installed CLI versions:

```sh
PI_SANDBOX_CREDENTIAL_CLI_ACCEPTANCE=1 pnpm exec tsx --test test/credential-cli-compatibility.test.ts
```

Normal test runs skip these probes. The full repository checks are `pnpm run all` (format, lint, typecheck, and tests).

## Verified result

User-run acceptance passed the real `gh` and npm probe; Wrangler was explicitly skipped because its CLI was absent. The subsequent `pnpm run all` passed formatting, lint, and TypeScript checks, with **189 tests passed, 0 failed, and 2 opt-in tests skipped** (191 total). This establishes the exercised local HTTP-token flows only; Wrangler, AWS CLI, Terraform, conditional approvals, and production credential-source isolation remain unverified or unimplemented. No live credential policy was changed.

## What it checks

- A temporary `SentinelRegistry` and `buildMaskedEnvVars` generate fake `GH_ENTERPRISE_TOKEN` and `NPM_TOKEN` values. Only those fakes are placed in child environments or npm config; the corresponding synthetic plaintext values remain in the parent process.
- `gh api --hostname <private-interface-ip> https://<private-interface-ip>:<port>/api/v3/user` and `npm whoami --registry https://localhost:<port>/` make real CLI requests. CLI config, caches, state, HOME, XDG directories, and temporary files live in an owned project-local temporary directory. The runtime generates a separate ephemeral CA, disposed after the probe. The HTTPS fixture binds a private network interface (not just loopback), so run this on a trusted local network; it uses synthetic credentials only.
- The local proxy accepts CONNECT only for the exact GitHub private-interface fixture address/port and npm localhost fixture address/port. Separate matching certificates avoid npm's IP-address proxy TLS hostname edge case. It terminates client TLS, applies the runtime's real header-substitution method, and verifies the upstream TLS leg with the ephemeral CA. The approved CLI token reaches the fixture after substitution; a separate unapproved sentinel on the `gh` request remains fake.
- A request to `unapproved.invalid` must receive an explicit proxy denial without reaching the fixture. Captured child arguments, environments, output, and npm config are checked not to contain the synthetic plaintext values. The fixture never echoes request headers or credentials in responses.
- A private IPv4 interface is required because Go-based `gh` clients can bypass proxies for loopback destinations. Without one, the acceptance probe skips rather than making a direct or remote request.

This is evidence only for the installed CLI versions, their local API/auth-header behavior, and the exercised proxy path. It is not an OS sandbox/credential-store isolation test, a guarantee for other CLI versions or transports, nor protection against an approved upstream that deliberately exfiltrates a credential it is authorized to receive. The probe does not validate production GitHub or npm authentication.

Wrangler is optional. Its test reports an explicit unverified skip when absent; if installed, it still skips because this fixture does not have a controlled Wrangler API-base override. No Wrangler command is mocked or sent to a live service. In the authoring environment `gh` and `npm` were present and `wrangler` was absent.
