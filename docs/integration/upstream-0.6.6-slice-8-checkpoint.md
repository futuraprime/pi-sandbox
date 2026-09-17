# Upstream 0.6.6 Slice 8 checkpoint: credential masking

- **Proposal:** [`proposal-integrate-upstream-0.6.6.md`](../proposals/proposal-integrate-upstream-0.6.6.md)
- **Feature ledger:** [`upstream-0.6.6-feature-ledger.md`](upstream-0.6.6-feature-ledger.md)
- **Slice:** 8 — credential masking
- **Baseline:** Slice 7, `@carderne/sandbox-runtime@0.0.72`
- **Decision:** expose only validated global credential policy metadata; reject project-controlled declarations and fail-open masking choices

## Trust boundary

`credentials` is now a typed `SandboxConfig` field backed by sandbox-runtime's exported credential schema. The loader accepts declarations only from the Pi global configuration file. Project declarations are untrusted, ignored, and produce a warning. Ordinary permission persistence and `/sandbox` commands do not have a credential mutation path; existing writers preserve an unrelated credential section without editing it.

The consumer boundary accepts only runtime policy metadata: source names/paths, `mode`, structured extraction/decode policy, claim and duplicate options, and explicit host scopes. Unknown fields—including credential values—are rejected without copying or printing their contents. Every `mode: "mask"` entry requires a nonempty `injectHosts` list, and the unscoped `*` host is rejected. Any `extract` or `decode` declaration requires `onExtractNoMatch: "deny"` or `"error"`; the runtime's fail-open default is never accepted. Runtime schema validation remains the source of truth for the supported field shapes, while these downstream rules are stricter.

`buildRuntimeConfig()` revalidates the policy-only object, canonicalizes credential file paths against the active project cwd using the same path helper as filesystem rules, and deep-copies policy arrays. No secret value is added to the runtime configuration. The downstream boundary also rejects the runtime's plaintext-injection escape hatch. Runtime 0.0.72 remains responsible for the platform behaviour: environment masks become sentinels and are substituted only for their explicit host scopes, while macOS credential-file masks degrade to read denial. No Linux file-masking implementation was added.

## Red/green evidence

The focused configuration tests cover:

- valid global env/file policy preservation and project-level warning/ignore behaviour;
- rejection of unknown/value-bearing fields without including the synthetic value in warnings;
- explicit nonempty host scopes for masks;
- acceptance of both fail-closed extraction choices and rejection of the fail-open default; and
- preservation of credential declarations when an ordinary filesystem permission writer updates another setting.

The focused runtime/security tests use disposable synthetic values and project-local temporary paths. They directly exercise the runtime 0.0.72 credential components and macOS wrapper seam:

- denied environment variables are absent;
- masked environment values are sentinel-only in a real macOS sandboxed child;
- the configured host receives substitution, while another reachable but unlisted host retains the fake sentinel;
- structured extraction mismatch degrades to unset for `deny` and throws for `error`;
- masked file bytes are fake at the component seam; the real macOS wrapper denies the source path rather than delivering a fake bind; and
- captured child environment/output, unlisted-host output, fake file material, wrapper text, and validation warnings do not contain the synthetic plaintext.

A full nested `SandboxManager` acceptance run was not used: the already-active outer sandbox's scoped Unix-socket policy prevents the runtime's internal mux from binding its session socket. No socket permission was widened. The direct macOS wrapper execution and component-level sentinel/proxy/file tests are the direct evidence for this slice; manager/mux orchestration remains covered by the runtime's own 0.0.72 implementation and prior bounded acceptance records.

## Boundaries and deferred work

This slice does not add a generic secret-bearing command runner, credential prompts, `/sandbox` editing, project-controlled credential composition, Linux credential-file masking, C-13, upstream SSH proxy product behaviour, lifecycle recovery, or prompt/UI TODO work. The runtime's `allowPlaintextInject` escape hatch is rejected at the downstream boundary; masked production use therefore retains the runtime's verified TLS/host controls. The global-only choice resolves O-05 conservatively and can be revisited only with an explicit trust review and composition contract.

## Verification record

| Command | Result |
| --- | --- |
| `pnpm exec tsx --test test/config.test.ts test/sandbox-runtime.test.ts` | 43 passing, 1 explicit TODO, 0 failing |
| `pnpm exec tsx --test test/credentials.test.ts` | 4 passing, 0 failing on macOS; direct wrapper and component evidence |
| `pnpm run check` | Passed |
| `pnpm run lint` | Passed |
| `pnpm exec oxfmt --check src/config.ts src/sandbox-runtime.ts test/config.test.ts test/sandbox-runtime.test.ts test/credentials.test.ts` | Passed |
| `git diff --check` | Passed |
| `pnpm test` | 141 passing, 3 explicit TODOs, 0 failing |

No user credential, SSH configuration, agent value, or user file was read. Temporary files and runtime stores were created under project-local or system temporary directories and cleaned by the tests.
