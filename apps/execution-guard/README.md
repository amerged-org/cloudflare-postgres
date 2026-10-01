# Execution deadline guard

Linux PID1 wrapper for a finite execution window. The signed startup mode verifies an operation-bound allowance envelope before launching the original command. Continuous renewal, trusted CNPG injection, complete workload coverage, retained-Pod termination receipts and final accounting remain required before runtime enforcement can be enabled.

The guard uses the original manager command, not a PostgreSQL implementation. A CNPG-I OperatorLifecycle adapter can inject a wrapper before Pod creation. CloudNativePG's PostgreSQL interface offers configuration enrichment rather than a per-start authorization hook. [Lifecycle interface](https://github.com/cloudnative-pg/cnpg-i/blob/v0.6.0/proto/operator_lifecycle.proto).

Run in a private container PID namespace with no host PID sharing, no privilege escalation and one fixed UID for all supervised processes. The guard must be PID1 before starting or signalling anything. The protected permit is read once; customer SQL access must not grant modification of the permit, epoch, command, executable or admission recipe.

The explicit `operator-window` mode retains the unsigned, unfunded operator configuration:

```json
{
  "version": 1,
  "bootId": "<kernel boot UUID>",
  "runEpoch": "1",
  "notBeforeBootNs": "<decimal CLOCK_BOOTTIME nanoseconds>",
  "expiresAtBootNs": "<decimal CLOCK_BOOTTIME nanoseconds>"
}
```

```text
/execution-guard --mode operator-window --permit-file /etc/pgcf/permit.json --run-epoch 1 --grace 3s -- /controller/manager instance run <original arguments>
```

The window is at most 300 seconds. An absolute Linux timerfd uses CLOCK_BOOTTIME, including host suspend time. Wall-clock changes cannot renew a window; an expired permit or different boot/run cannot start a process. The `clock` subcommand reports the local boot identity and boot nanoseconds to trusted installation tooling. This unsigned operator configuration does not itself establish funded execution authority or authorize another environment.

The explicit `signed-window` mode requires a protected expected manifest and a single pinned Ed25519 public key. It also checks `PGCF_EXECUTION_POD_UID`, `PGCF_EXECUTION_NAMESPACE` and `PGCF_EXECUTION_NODE_NAME` from trusted Downward API configuration against the expected binding. The native kernel boot UUID must match. The full actual argument vector is hashed using the agreed domain and UTF-8 length framing; it must match the protected command and signed binding.

```text
/execution-guard --mode signed-window --expected-file /private/expected.json --public-key-file /private/key.json --ipc-directory /private/ipc --startup-timeout 15s --grace 3s -- /controller/manager instance run <original arguments>
```

Before requesting authorization, PID1 reads native CLOCK_BOOTTIME and creates a fresh random nonce held in memory. It creates an exclusive `attempt-<nonce>` directory and `request.json`, then emits one bounded challenge-ready event. A trusted external broker supplies `permit.json` in that same attempt; the guard contains no regional or provider credential. Existing attempts and malformed, foreign, unsigned or stale responses are refused. There is no fallback to the operator lane; that lane also refuses configured signed-context variables.

Protected input and response files must be regular, single-link, owned by the guard UID, and mode `0400` or `0600`. Their parent directories and the explicit IPC directory must be existing real directories owned by that UID with mode `0700`. Symlink parents/files are refused. Directory identity and file identity/content are checked through the exchange and immediately before launch; the native clock is checked again after those reads. Ancestor path checks are observations, not an atomic defense against concurrent administrator replacement. Installation tooling must preserve this custody boundary.

The guard strictly verifies the routing-bound signature over the original canonical payload bytes and every expected receipt/environment/spec/run/Pod/Node/command/resource identity. Signed duration is at most 15 seconds. Its deadline is the original local pre-transport boot time plus that duration, so waiting consumes the window. Receipt wall timestamps never supply a local clock mapping. A response received after expiry or without enough shutdown grace cannot start the manager. Restart generates a new nonce; an old envelope cannot move that anchor. See the [signed window contract](../../docs/contracts/signed-execution-window-v2.md) and the [synthetic cross-language byte fixture](testdata/signed-window-v2.json).

The protected Pod/Node/image/resource bindings are trusted installation assertions, not fresh hardware attestation or executable-byte measurement. This initial finite window is not activated for CNPG and does not renew itself. `runtimeEnforced` remains false; scheduler allocation release, retained-storage cost, Pooler/Barman coverage, final usage, settlement and measured overshoot remain separate gates.

Shutdown starts before expiry, using the configured grace (at most ten seconds). SIGTERM asks the original manager to shut down, followed by namespace-wide SIGINT for fast PostgreSQL shutdown and SIGKILL if necessary at the hard deadline. Every waitable child is reaped and `/proc` must contain no other processes before local quiescence is reported. Error exit also ends container PID1; unknown cleanup never becomes a success. Kernel scheduling and uninterruptible I/O prevent an exact-time guarantee; measured overshoot and recovery remain installation gates.

PostgreSQL uses a separate process group, so signalling only the manager's group is insufficient. Manager exit also occurs during online upgrades that deliberately retain PostgreSQL; this initial integration must disable that upgrade path until separately qualified. [Process groups](https://github.com/cloudnative-pg/machinery/blob/v0.6.0/pkg/fileutils/compatibility/unix.go), [manager shutdown](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/management/postgres/instance.go).

A valid window may still permit a container restart before expiry. A manual stop, future run handoff and physical completion therefore need retained kubelet termination evidence and controlled admission, not just this local receipt. Stopping PostgreSQL does not release scheduler allocations, stop a separately namespaced Pooler/backup sidecar, finalize usage or remove stored customer data. SIGKILL can require ordinary PostgreSQL WAL recovery and leaves uncertain writes uncertain; never replay them blindly.

Build/check with `pnpm check:execution-guard`. The Docker build uses an explicit public context. First-party tests have three bounded Go cases, including signed verification before the maintained supervisor and original-anchor refusal. A separate real Linux namespace qualification exercises actual PID1 behavior; the [standalone signed lifecycle case](../../docs/evidence/m6-signed-window-native-2026-10-01.md) passes with the unchanged binary. The [current source integration](../../docs/evidence/m6-signed-window-integration-2026-10-01.md) retains closed managed admission; this does not qualify CNPG activation. The default regional controller does not activate the guard or gain new privileges.

The Linux-only `prepare-inputs --input-directory <private-child> --ipc-directory <private-child>` command reads exactly `{expected,publicKeyPin}` from stdin with a 16 KiB byte limit and a 15-second read deadline. It validates the existing signed protocol, actual boot and Downward API identities before publishing any input file. It seals content hashes and both directory identities in an exclusive private capsule, then creates regular `0600` expected/key files. Matching replay preserves original files; conflicts, symlinks, orphaned files, wrong ownership/modes and input/IPC directory aliases fail closed. Existing directories are never repaired by changing ownership or permissions.

Compute must receive the prepared input tree read-only and its distinct IPC tree writable. Preparation trusts the installation's input/key provenance and is not a signed grant. The initializer does not deliver permits, start the manager or establish whole-Pod mount isolation. Native preparation evidence remains separate from node-agent, broker and CNPG lifecycle qualification.

## Bounded protected-input startup

The signed lane optionally accepts `--input-wait <duration>` from zero to 15 seconds. Zero preserves immediate input loading. A positive wait requires a readonly input volume and a distinct writable IPC volume; original root device/inode, mount identity, owner/mode and appearing private directories are pinned. Nested/aliased roots, symlinks, replacement and cancellation are refused. Final readiness rechecks the exact wait deadline before transferring original custody to the signed lane.

Only the guard waits; the manager cannot start before complete private inputs and a valid signed permit. The original boot sample is retained through input wait, challenge and signature validation. Waiting consumes both the original startup deadline and signed duration. Root descriptors remain held until return, with custody checks through handshake and immediately before process start. The running supervisor enforces expiry; it does not continually recheck input-root identity after manager startup.

This wait does not bound total Kubernetes allocation or repeated restarts. Admission/restart fencing and birth funding must cover allocated resources before quota opens, overlap the complete startup window and preserve authoritative stop/accounting evidence. Input/IPC volumes are disposable protocol state, distinct from persistent PostgreSQL data. Their loss blocks an attempt rather than reconstructing uncertain authority. Actual node publication, pre-birth readiness and complete lifecycle activation remain separate requirements.
