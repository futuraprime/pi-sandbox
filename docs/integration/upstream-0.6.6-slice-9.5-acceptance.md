# Slice 9.5: Git-specific SSH transport acceptance

- **Status:** Implementation regressions are the local gate; bare-macOS push acceptance is **PENDING**.
- **Environment:** No disposable SSH remote or test credentials were used for this implementation. The delegated environment may be nested under `SANDBOX_RUNTIME=1`, so it is not evidence of bare-macOS SSH enforcement.
- **Required release evidence:** A successful Git push from a bare macOS Pi sandbox to a disposable SSH remote, with the checks below recorded. Read-only `ls-remote` is not a substitute.

## Transport contract

Only Git `clone`, `fetch`, `pull`, `push`, and `ls-remote` commands with an SSH remote receive the Git SSH transport. It uses the sandbox runtime's proxy and preserves runtime domain filtering. Ordinary `ssh` is not aliased or routed through that transport.

The transport invokes OpenSSH with user SSH configuration disabled, host-key checking forced to `yes`, DNS host-key trust disabled, host-key updates disabled, and only the standard user/system `known_hosts` files selected. It does not read SSH identity files: `IdentityFile=none` leaves authentication to the exact `SSH_AUTH_SOCK` supplied by the environment, and the existing path-scoped session prompt is the only way to grant that socket. A missing SOCKS proxy fails closed. Host keys must already be trusted; the transport neither accepts new keys nor modifies known-hosts files. A `known_hosts` file under a denied path must be explicitly approved by the existing narrow read policy/prompt; no `.ssh` directory or private-key access is added.

## Disposable bare-macOS acceptance checklist (not yet run)

Use a clean macOS host outside any outer sandbox. Do not use a real remote, a personal SSH key, the user's normal `HOME`, or the user's normal Pi agent directory. Use a temporary home, a temporary Pi agent directory, a loopback-only test `sshd`, a test-only client key held by a temporary `ssh-agent`, and a bare repository under a temporary directory. Confirm `/usr/bin/sshd`, `/usr/bin/ssh-keygen`, Git, and the extension's runtime dependencies are available before starting.

1. Create a temporary root and isolated home/project, with mode `0700` on private directories. Generate a disposable client key and disposable `sshd` host key with empty passphrases **only inside that temporary root**. Create a bare repository there.
2. Start a disposable `sshd` on `127.0.0.1` and a high, unused port. Configure it to accept only the generated client public key, disable passwords and forwarding, and force the authorized key through `git-shell`. Keep its PID/config/logs and repository inside the temporary root.
3. Verify the test host key fingerprint from the generated local host public key with `ssh-keygen -lf`. Pin that key (including `[127.0.0.1]:<port>`) into only the isolated `$HOME/.ssh/known_hosts`; do not use `ssh-keyscan` as a trust decision. Confirm the host-key file is readable by the sandbox policy without allowing `$HOME/.ssh`, private keys, or the whole home directory.
4. Start a temporary agent socket inside the temporary root, add only the disposable client key, and export that exact `SSH_AUTH_SOCK`. Launch Pi with `HOME` and `PI_CODING_AGENT_DIR` pointed at the isolated paths. In the test project, allow `127.0.0.1` and set a temporary deny rule for it for the negative check.
5. With the domain denied, attempt an SSH Git operation (for example `git ls-remote ssh://<user>@127.0.0.1:<port>/<tmp>/remote.git`). It must be blocked by domain policy before the SSH-agent prompt and must not run through an alternate/direct SSH path. Remove only the temporary deny rule, restart/reinitialize Pi, and repeat.
6. On the permitted attempt, approve **session-only** access to the displayed exact temporary agent socket. Push a test commit to the bare remote. Confirm the remote ref exists; confirm a subsequent fresh session requires a new approval; confirm neither `allowUnixSockets` nor `allowAllUnixSockets` was persisted in project/global config and that no broad Unix-socket grant was used.
7. Replace the temporary `known_hosts` entry with a different generated host key for the same host/port and retry. The operation must fail with a host-key mismatch; no acceptance prompt, key update, or write to the file is permitted. Restore the correct pinned entry and confirm the Git push succeeds again.
8. In the isolated Pi environment, try ordinary `ssh` to the same test endpoint. It must not inherit the Git transport's proxy command. Record the observed sandbox result and separately rely on the focused command-construction regression for proof that no ordinary-SSH wrapper is installed.
9. Stop `sshd` and the temporary agent, remove the temporary root, and record macOS version, runtime version/integrity, Pi version, test commands, denied-domain result, exact socket path and session choice, pinned host-key fingerprint/mismatch result, push/ref result, ordinary-SSH result, and confirmation that only temporary material was used.

**Acceptance record:** Pending all steps above on bare macOS. No real remote, host key, credential, or push result is claimed here.
