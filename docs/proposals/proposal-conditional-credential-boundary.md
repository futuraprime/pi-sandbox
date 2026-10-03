# Conditional credential use

- **Created:** 2026-10-03
- **Status:** draft

## Summary

Address [S-4 in the security review](../reviews/upstream-0.6.6-conformance-security-review.md) by allowing useful authenticated CLI and provider workflows without exposing reusable credentials to model-visible tools or ordinary agent-controlled commands. Credentials should be released only for narrowly scoped, bounded operations, under user-owned policy. This proposal records evidence and unresolved trade-offs; it does not select an architecture or authorize implementation.

## Goals

- Keep useful `gh`, npm, Wrangler, AWS CLI, and Terraform AWS-provider authentication workflows available where a trustworthy boundary can support them.
- Prevent model-visible tools and ordinary agent-controlled commands from obtaining original credentials; do not treat masking alone as isolation.
- Make access conditional on identity, destination, operation, and request-payload scope, with bounded grant lifetime and use count.
- Fail closed on absent UI/approval, timeout, unsupported requests, broker or policy errors, shutdown, revocation, and policy changes.
- Keep policy global/user-owned, with no plaintext credentials in configuration, and avoid reusable ambient authenticated sessions by default.
- State explicitly which trusted components, provider/plugin code, and arbitrary child code are inside or outside the boundary.

## Proposed approach

Treat credential access as a separate authority boundary, not as a side effect of network permission or header substitution. First state the threat model and identify every source and route: environment, CLI/provider configuration, helpers, caches and keyrings, plus direct tools such as Bash and in-process extensions. Read isolation and direct access to those sources matter as much as outbound filtering.

Preserve a useful workflow only through a boundary that can make a fresh, explicit, narrowly scoped decision for each operation (or a demonstrably bounded grant). Scope must account for caller identity, exact destination, operation, and request payload—not a host-only allow rule or command-string allowlist. Do not infer safe permissions from command names or arguments alone. No reusable ambient session should be the default. Shutdown, policy changes, or revocation must invalidate outstanding authority.

For AWS signing, a trusted signer/request broker is a candidate because masking the secret before SigV4 signing breaks authentication; isolated execution is an alternative, and the choice remains unresolved. An AWS `credential_process` returns real credentials to its caller and is not, by itself, an isolation boundary. Isolation alone also does not prevent an authorized CLI, debug mode, plugin, or credential-output command from disclosing real credentials. A narrow request broker may not cover all AWS operations. SigV4a, streaming/chunked signing, pre-signed URLs, query/body constraints, retries, redirects, and content validation are open compatibility and security questions, not assumed capabilities. Conditional gates do not fix the signing incompatibility.

Token injection can preserve some CLI flows, but does not prove that an approved service response cannot reflect or otherwise expose a credential. No guarantee against a hostile approved upstream is claimed. A credential non-disclosure threat model, including response/output trust and data flow, must be resolved before claiming such protection. Distinguish credential non-disclosure from authority misuse and data exfiltration: an agent might misuse delegated authority without learning the credential.

Do not claim model-wide protection while S-3 remains unresolved: in-process extension tools can bypass credential denies and access sources. This proposal neither authorizes S-3 work nor proposes blanket tool blocking. Useful tools must remain usable, and a cooperating tool boundary or another exclusion mechanism must protect credential sources before a model-wide guarantee is made.

### Current evidence

See the [local credential CLI compatibility evidence](../integration/credential-cli-compatibility.md) for probe details and verification limits.

- The user-verified local probes passed with fake-token fixtures for `gh`, npm, and Wrangler **4.147.0**. They demonstrate the exercised token-auth flows, proxy substitution, and denial of an unapproved destination—not production authentication, source isolation, or general-version compatibility.
- User-verified AWS CLI acceptance passed **2/2**: the control signed request works, a masked-secret signature is rejected, and an exact unapproved proxy destination is denied. Header substitution is not re-signing; AWS SigV4's secret is needed before the request reaches the proxy.
- The latest full-repository result was **190 passed, 0 failed, 3 deliberate skips (193 total)**. These results do not establish conditional authorization or production credential isolation.
- Terraform is not installed or tested; AWS-provider signing behavior is inferred, not runtime-verified. Terraform S3 backend and Cloudflare provider support are out of scope for this proposal.

## Non-goals

- Terraform S3 backend or Cloudflare provider support; expanding the supported provider/CLI list beyond the workflows above.
- Implementing a broker, signer, execution isolation, approval UI, policy changes, or live-credential probes in this proposal.
- Treating proxy host filtering, environment masking, command allowlists, or output scrubbing alone as credential isolation.
- Authorizing S-3 remediation or blanket blocking useful tools.
- Claiming protection from a hostile approved service, trusted-component compromise, or arbitrary child/plugin code absent an explicit enforceable boundary.

## Security limits

- Existing source isolation is not established. Denials must cover reads from environment/configuration, helpers, caches/keyrings and other credential stores, including direct in-process tools, not just sandboxed child processes.
- Token injection compatibility is not evidence that every request or response is safe. Do not promise non-disclosure for malicious approved upstreams or arbitrary trusted extensions.
- A broker may restrict credential disclosure while delegated authority still permits damaging operations or exfiltration through legitimate responses. These are separate risks requiring explicit scope and review.
- Synthetic fixtures are the first proof stage. Any testing against live credential sources requires distinct user approval; this draft does not authorize it.

## Open questions

- Can a trusted signer/request broker preserve required AWS workflows with an enforceable operation and payload policy, or is appropriately isolated execution necessary? Which AWS signing/transport features must be supported or rejected?
- What counts as caller identity when tools, subprocesses, plugins, retries, redirects, and response handlers are involved? How are bounded grants consumed and invalidated?
- How will ordinary commands and in-process tools be prevented from reading every relevant source, given the open S-3 boundary?
- What response/output data-flow threat model is needed to distinguish credential disclosure, authority misuse, and exfiltration? What claims remain valid for approved but hostile upstreams?
- Which supported CLI workflows can be preserved without reusable ambient sessions, and what compatibility failures should fail closed?
