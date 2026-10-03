# Local credential CLI compatibility probes

`test/credential-cli-compatibility.test.ts` is opt-in. It runs installed `gh`, `npm`, and optionally Wrangler executables against local HTTPS fixtures through the sandbox runtime's TLS-terminating proxy; it does not install tools or contact a public service. Wrangler is selected from `PATH` or the explicit `PI_SANDBOX_WRANGLER_BIN` executable path. Isolated CLI environments prefer the test runner's Node executable directory so Node-based tools do not accidentally switch architecture via another system installation.

Run only when you want to exercise the installed CLI versions:

```sh
PI_SANDBOX_CREDENTIAL_CLI_ACCEPTANCE=1 pnpm exec tsx --test test/credential-cli-compatibility.test.ts
# Optional, if Wrangler is not already on PATH:
PI_SANDBOX_CREDENTIAL_CLI_ACCEPTANCE=1 PI_SANDBOX_WRANGLER_BIN=/path/to/wrangler pnpm exec tsx --test test/credential-cli-compatibility.test.ts
```

Normal test runs skip these probes. The full repository checks are `pnpm run all` (format, lint, typecheck, and tests).

## Verification status

User-run opt-in acceptance passed both probes: real `gh`/npm and Wrangler **4.147.0**, with **2 passed, 0 failed, and 0 skipped**. The subsequent `pnpm run all` passed formatting, lint, and TypeScript, with **189 tests passed, 0 failed, and 2 opt-in skips** (191 total). The normal-suite skips are deliberate; the separate opt-in run exercised all three CLIs.

Wrangler remains optional and skips only when no executable is available; a configured but unsupported or failing executable fails with its CLI diagnostics. User-run AWS acceptance also passed: **2 passed, 0 failed, and 0 skipped**, covering the published signing example and real CLI control, masked-secret rejection, and unapproved-destination denial. Subsequent `pnpm run all` passed formatting, lint, and TypeScript, with **190 passed, 0 failed, and 3 deliberate opt-in skips** (193 total). No live credential policy was changed. Conditional approvals and production credential-source isolation remain unimplemented or unverified.

## What it checks

- A temporary `SentinelRegistry` and `buildMaskedEnvVars` generate fake `GH_ENTERPRISE_TOKEN` and `NPM_TOKEN` values. Only those fakes are placed in child environments or npm config; the corresponding synthetic plaintext values remain in the parent process.
- `gh api --hostname <private-interface-ip> https://<private-interface-ip>:<port>/api/v3/user` and `npm whoami --registry https://localhost:<port>/` make real CLI requests. CLI config, caches, state, HOME, XDG directories, and temporary files live in an owned project-local temporary directory. The runtime generates a separate ephemeral CA, disposed after the probe. The HTTPS fixture binds a private network interface (not just loopback), so run this on a trusted local network; it uses synthetic credentials only.
- The local proxy accepts CONNECT only for the exact GitHub private-interface fixture address/port and npm localhost fixture address/port. Separate matching certificates avoid npm's IP-address proxy TLS hostname edge case. It terminates client TLS, applies the runtime's real header-substitution method, and verifies the upstream TLS leg with the ephemeral CA. The approved CLI token reaches the fixture after substitution; a separate unapproved sentinel on the `gh` request remains fake.
- A request to `unapproved.invalid` must receive an explicit proxy denial without reaching the fixture. Captured child arguments, environments, output, and npm config are checked not to contain the synthetic plaintext values. The fixture never echoes request headers or credentials in responses.
- A private IPv4 interface is required because Go-based `gh` clients can bypass proxies for loopback destinations. Without one, the acceptance probe skips rather than making a direct or remote request.

This is evidence only for the installed CLI versions, their local API/auth-header behavior, and the exercised proxy path. It is not an OS sandbox/credential-store isolation test, a guarantee for other CLI versions or transports, nor protection against an approved upstream that deliberately exfiltrates a credential it is authorized to receive. The probe does not validate production GitHub or npm authentication.

- Wrangler is an independent optional probe, so it does not require the `gh` private-interface fixture. It runs the real `wrangler whoami --json` command with a synthetic `CLOUDFLARE_API_TOKEN`; the fixture handles the pinned CLI's `/user/tokens/verify`, `/user`, `/accounts`, and `/memberships` calls with controlled Cloudflare-style JSON responses and asserts the approved synthetic token arrives after substitution. A second invocation points the API base at `unapproved.invalid` and requires proxy denial without reaching the local upstream.
- Wrangler 4.147.0's compiled source names `CLOUDFLARE_API_BASE_URL` (deprecated alias `CF_API_BASE_URL`) as the API-base override, `WRANGLER_SEND_METRICS=false` as the telemetry setting, and `CLOUDFLARE_AUTH_USE_KEYRING=false` to opt out of keyring storage. The probe also sets `WRANGLER_NO_SKILLS_UPDATE_PROMPTS=true`, uses an empty isolated credential home plus the environment token, routes Node/Undici `HTTPS_PROXY`/`HTTP_PROXY` through the fixture (`no_proxy=unrelated.invalid` so localhost is not bypassed), and adds the fixture CA to the CLI's trust store through `NODE_EXTRA_CA_CERTS`. The successful JSON `whoami` path does not invoke Wrangler's version update check in this pinned build. A fresh, fixture-owned update-check cache under the isolated `TMPDIR` also prevents the error-path updater from making an HTTP request during the negative-host probe. This does not disable update checks for other commands or Wrangler versions.
- Wrangler uses a localhost-only fixture filter with no wildcard host/port grants. TLS verification remains enabled: the CLI trusts the ephemeral CA, and the proxy verifies its upstream TLS connection against that CA. The fixture never echoes credentials. The test inspects no real credential values and constructs child environments explicitly rather than inheriting Cloudflare credential variables.

The passing Wrangler result establishes the exercised local `whoami --json` token-authentication flow, including proxy substitution, captured-output non-disclosure, and unapproved-host denial. It does not validate deployment commands, other Cloudflare integrations, production Cloudflare authentication, or general credential-store isolation.

## AWS CLI SigV4 proof

`test/credential-aws-compatibility.test.ts` is separately opt-in and runs only an already-installed `aws` executable. An absent CLI skips; an installed CLI that fails the local proof fails the test. Run it explicitly with:

```sh
PI_SANDBOX_CREDENTIAL_CLI_ACCEPTANCE=1 pnpm exec tsx --test test/credential-aws-compatibility.test.ts
```

The test invokes `aws sts get-caller-identity --endpoint-url https://localhost:<port> --region us-east-1 --output json` against an exact localhost/port TLS fixture. The AWS CLI trusts the fixture CA through `AWS_CA_BUNDLE`; the proxy separately verifies its upstream TLS connection against that CA. The child receives an isolated HOME/XDG tree, empty explicit AWS config and shared-credentials files, only synthetic AWS credential values, disabled EC2 metadata, one bounded attempt, an empty pager, and auto-prompt off. Its environment does not inherit host credentials. The proxy denies other destinations, including `unapproved.invalid`, and the denied call must not reach the fixture.

A synthetic known-credential control must produce a valid SigV4 request at the fixture. The fixture independently reconstructs the canonical method, path, query, signed headers, and body hash, then checks the AWS4 HMAC key-derivation chain. A separate verifier test checks the published AWS IAM `ListUsers` known-answer signature so the verifier is not validated only against itself. For the negative case, all three credential environment variables are masked with `SentinelRegistry`/`buildMaskedEnvVars`; the access-key sentinel may be restored in the authorization header, while the session-token sentinel is not approved for localhost. The masked secret is never transmitted as a header, so header substitution cannot restore it. The fixture must reject the resulting signature with `SignatureDoesNotMatch`, even though it independently verifies that signature against the masked secret and signed token. Fixture headers remain parent-side and are never reflected; command outputs must contain none of the synthetic plaintext values. The successful baseline necessarily places synthetic plaintext credentials in its isolated child environment only.

The passing proof establishes the exercised **masking incompatibility**, not an AWS authentication solution: replacing `AWS_SECRET_ACCESS_KEY` before SigV4 signing changes the signature, and the secret cannot be restored by proxy header substitution because it is not on the wire. It is evidence only for the exercised local AWS CLI signing flow and is intended to inform the Terraform AWS provider case; Terraform/tofu is not installed here and is not exercised. The AWS S3 backend and Cloudflare are out of scope for this proof. The user-run local AWS CLI proof passed; Terraform provider behavior remains inferred from the signing mechanism, not independently runtime-verified. This is not a live AWS request, production auth validation, credential-store isolation test, or guarantee supplied by an OS sandbox.
