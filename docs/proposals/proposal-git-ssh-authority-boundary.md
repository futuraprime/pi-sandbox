# Git and SSH authority boundary

- **Created:** 2026-10-15
- **Status:** draft

## Summary

Capture [S-6 in the security review](../reviews/upstream-0.6.6-conformance-security-review.md) for future consideration. SSH-agent approval and writable Git metadata give an agent broader authority than the individual operation that prompted approval. This stub records the problem, not a selected solution or implementation authorization.

The core risks are inherited from downstream `main` (`757f058`), not introduced by the upstream 0.6.6 integration. Local source comparison found:

- **Remote authority:** SSH-agent approval lasts for the session rather than one Git operation. Later commands with access to the approved socket can request authentication using loaded keys, potentially reaching other repositories or performing pushes, force-pushes, and branch deletions where server permissions allow. Possession of the private key material is not required to misuse this authority.
- **Local history:** writable Git metadata permits destructive operations on unpushed work, refs, and recovery history. Linked worktrees share refs and other repository state, so consequences can extend beyond the active checkout.

The integration narrows linked-worktree write allowances and protects sensitive hooks/configuration under S-1, but shared refs/logs remain writable. Its constrained Git-over-SSH transport adds destination and host-key controls; those are not authorization for individual Git actions. These observations come from source inspection, not live SSH testing or exhaustive platform verification.

## Goals

- Establish the intended authority boundary for agent use of SSH credentials and remote Git mutations.
- Establish acceptable local Git operations and the required protection for unpushed work, recovery history, and shared worktree state.
- Preserve useful authenticated Git workflows while making remaining risks and user expectations explicit.

## Proposed approach

Undecided. No mechanism, approval model, or implementation plan is proposed in this stub. Remote credential authority and local history protection are separate concerns and need separate evaluation.

## Open questions

- What should an SSH-agent approval authorize, and for how long?
- Which remote and local operations should be unrestricted, require approval, or be unavailable?
- What protection is expected for other worktrees and repositories accessible through the same credentials?
- What enforceable guarantees are feasible when agent-controlled scripts can invoke Git or manipulate writable metadata directly?
