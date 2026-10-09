# Prepared node runtime primitive

This native Rust executable is the one-assignment namespace holder for the required shared
prestarted compute pool. It prepares real private Linux network, IPC and UTS namespaces before
any tenant request. It accepts one opened network-namespace descriptor from an authenticated
local runtime controller, moves the same PID to that namespace, assigns the hostname, drops its
privileges and closes the assignment channel. It never receives PostgreSQL data, passwords,
mount paths or executable commands.

**This is not a complete pool controller, CRI integration, CNPG adoption or database-readiness
implementation.** A prepared namespace holder alone does not establish the first-read target.
The external containerd sandbox controller, task endpoint association, cgroup accounting,
release/profile selection, refill, tenant-runtime destruction and actual database acceptance
remain required work. Existing servers do not execute this binary yet.

## Runtime boundary

The intended software-only integration retains normal CNPG-created database Pods and their
immutable PVC specifications. A containerd sandbox-controller proxy maps each real Pod sandbox
ID to one previously prepared slot and returns its existing runc TaskService endpoint. After
assignment, containerd's ordinary child OCI specifications select the namespace paths of the
returned PID. Each PostgreSQL/Barman child retains its own runc-enforced cgroup and actual mounts.
A slot is destroyed after tenant use; it never returns to unassigned inventory.

The pinned containerd 2.3.6 [external sandbox-controller API](https://github.com/containerd/containerd/blob/v2.3.6/api/services/sandbox/v1/sandbox.proto),
[multiple-task runc service](https://github.com/containerd/containerd/blob/v2.3.6/cmd/containerd-shim-runc-v2/task/service.go#L223-L255),
and [Pod namespace selection](https://github.com/containerd/containerd/blob/v2.3.6/internal/cri/opts/spec_opts.go#L347-L365)
provide this integration seam. The actual adapter and CRI/Cilium/CNPG conformance have not yet
been implemented or proved. Shared Pod PID/user namespace modes must be rejected until the
slot also provides their required isolation; ordinary CNPG separate-container PID mode is the
initial integration target. A controller must validate CNI namespace custody and operation,
Pod/Node identity and resource limits before allowing any tenant task. It must reconcile an
uncertain assignment by observation/destruction, never resend it to reuse a slot.

## Local invocation and authority

Run this as a dedicated single-threaded runtime process, with only the temporary capabilities
needed for its own namespace preparation/assignment (`CAP_SYS_ADMIN`, `CAP_SETPCAP`). It is not
an ordinary tenant Pod or an HTTP service. The local controller owns a unique directory with
mode 0700 and the same UID as the process; the socket is created mode 0600 and an existing socket
is never replaced.

```
pgcf-node-runtime /run/pgcf-slot/unique/control.sock SLOT_ID CONTROLLER_UID LIFETIME_MS
```

`SLOT_ID` is a nonzero 128-bit identifier written as 32 hexadecimal characters. Unassigned lifetime
is bounded to 1–300000 milliseconds. The supervisor destroys expired or failed slots and must
not advertise them as available. The `prepared` observation describes initialized namespaces
and a live holder only. Its PID is namespace-local; the supervisor independently binds the
host PID/pidfd and shim endpoint before assignment. It carries no tenant or database-ready assertion.

The connected controller must match kernel `SO_PEERCRED` UID. It sends exactly one
`SOCK_SEQPACKET` frame and one `SCM_RIGHTS` FD. The frame is the bounded versioned local format
in `src/protocol.rs`: slot ID, expected namespace device/inode and one RFC1123 hostname label.
The helper requires an NSFS network namespace, compares its opened FD identity and rejects the
original unassigned network namespace. No path from the message is opened. Unexpected/truncated
ancillary data, extra descriptors, mismatched identity, unauthorized peer or expired authority
terminate the process; none enables another assignment attempt.

After successful `setns` and hostname assignment, ambient, bounding, effective, permitted and
inheritable capabilities are removed and `NoNewPrivs` is observed. Only then is `assigned\n`
acknowledged. The listener and connection are closed. SIGTERM destroys the holder. Full tenant
Pod/task teardown remains the supervisor's responsibility; killing this holder alone does not
prove that all child tasks were removed.

## Verification

Pure protocol and real local FD/peer-credential tests run with `cargo test`. The two explicit
kernel integration tests need a disposable Linux environment with namespace capabilities and
BusyBox. They create only their own namespace holders, target namespace and temporary files:

```
cargo test --test kernel_assignment -- --ignored --test-threads=1 --nocapture
```

They prove a pre-request holder, same-PID network transition from an opened FD, unchanged private
IPC/UTS namespaces, zero capabilities/NoNewPrivs, rejection of a second claim, expiry, unauthorized
peer rejection and actual process destruction. They do not prove a Kubernetes Pod, database,
backup, storage assignment or subsecond first read. Record real deployment evidence in PLAN.md.
