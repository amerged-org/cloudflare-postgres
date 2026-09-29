# Execution deadline guard

Linux PID1 wrapper for an operator-protected, finite execution window. This is the local expiry component; signed allowance issuance, renewal delivery, CNPG integration, retained-Pod termination receipts and final accounting remain required before runtime enforcement can be enabled.

The guard uses the original manager command, not a PostgreSQL implementation. A CNPG-I OperatorLifecycle adapter can inject a wrapper before Pod creation. CloudNativePG's PostgreSQL interface offers configuration enrichment rather than a per-start authorization hook. [Lifecycle interface](https://github.com/cloudnative-pg/cnpg-i/blob/v0.6.0/proto/operator_lifecycle.proto).

Run in a private container PID namespace with no host PID sharing, no privilege escalation and one fixed UID for all supervised processes. The guard must be PID1 before starting or signalling anything. The protected permit is read once; customer SQL access must not grant modification of the permit, epoch, command, executable or admission recipe.

```json
{"version":1,"bootId":"<kernel boot UUID>","runEpoch":"1","notBeforeBootNs":"<decimal CLOCK_BOOTTIME nanoseconds>","expiresAtBootNs":"<decimal CLOCK_BOOTTIME nanoseconds>"}
```

```text
/execution-guard --permit-file /etc/pgcf/permit.json --run-epoch 1 --grace 3s -- /controller/manager instance run <original arguments>
```

The window is at most 300 seconds. An absolute Linux timerfd uses CLOCK_BOOTTIME, including host suspend time. Wall-clock changes cannot renew a window; an expired permit or different boot/run cannot start a process. The `clock` subcommand reports the local boot identity and boot nanoseconds to trusted installation tooling. This unsigned operator configuration does not itself establish funded execution authority or authorize another environment.

Shutdown starts before expiry, using the configured grace (at most ten seconds). SIGTERM asks the original manager to shut down, followed by namespace-wide SIGINT for fast PostgreSQL shutdown and SIGKILL if necessary at the hard deadline. Every waitable child is reaped and `/proc` must contain no other processes before local quiescence is reported. Error exit also ends container PID1; unknown cleanup never becomes a success. Kernel scheduling and uninterruptible I/O prevent an exact-time guarantee; measured overshoot and recovery remain installation gates.

PostgreSQL uses a separate process group, so signalling only the manager's group is insufficient. Manager exit also occurs during online upgrades that deliberately retain PostgreSQL; this initial integration must disable that upgrade path until separately qualified. [Process groups](https://github.com/cloudnative-pg/machinery/blob/v0.6.0/pkg/fileutils/compatibility/unix.go), [manager shutdown](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/management/postgres/instance.go).

A valid window may still permit a container restart before expiry. A manual stop, future run handoff and physical completion therefore need retained kubelet termination evidence and controlled admission, not just this local receipt. Stopping PostgreSQL does not release scheduler allocations, stop a separately namespaced Pooler/backup sidecar, finalize usage or remove stored customer data. SIGKILL can require ordinary PostgreSQL WAL recovery and leaves uncertain writes uncertain; never replay them blindly.

Build/check with `pnpm check:execution-guard`. The Docker build uses an explicit public context. First-party tests have two bounded cases; a separate real Linux namespace qualification exercises a detached/adopted group and expired restart refusal. The default regional controller does not activate the guard or gain new privileges.
