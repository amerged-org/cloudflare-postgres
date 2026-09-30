# PostgreSQL WAL qualification — authorized observer attempt

Status: **held; the single additional authorized attempt has finished**.
The independent filesystem observation and complete WAL incident/recovery remain
unqualified. Cleanup and full original-state preservation pass.

Subsequent user-directed work removes the fixed correction cap and qualifies
the same selected case using the existing CSI mount. The
[complete recovery result](m4-postgres-wal-recovery-2026-09-30.md) records the
retained parser stop and successful fresh sixth invocation. This historical
record's failed result is unchanged.

## Scope and review

The human explicitly continued the proposed single observer attempt after the
[two corrective attempts](m4-postgres-wal-preparation-stop-2026-09-30.md).
The original failures remain retained. This is native invocation four of the
same qualification case, with two earlier implementation corrections and one
explicit exception; counters are not reset and a fifth invocation is not
permitted automatically.

Root implemented and froze the private driver. A narrowly scoped Astra Ultra
consultation identified mount ownership, network policy, filesystem identity,
quota and CSI expansion safeguards. The new observer uses the already pinned
PostgreSQL image, UID/GID 26, Restricted security, a read-only root filesystem,
dropped capabilities and no service-account token. It has no `fsGroup` or
permission-changing initializer. It requests 50m CPU/64 MiB memory and is limited
to 100m CPU/128 MiB memory. Only the two fresh target claims are selected, with
read-only claim sources and container mounts; original volumes are excluded.

A separate observer-only Cilium ingress/egress deny is prepared before the Pod.
The parser is checked against the actual pinned Cilium 1.20.2 policy model,
including numeric deny verdicts and exact policy provenance. This preparation
is not a runtime network-denial claim: the observer never reaches execution.
The existing PostgreSQL endpoint/policy qualification remains enforced.

The same 540-second total deadline, 70-second cleanup reserve, producer limits,
PVC sizes, guarded target-only expansion and recovery assertions are retained.
The existing two-Pod quotas remain unchanged. Both native database fixtures
become Ready and their bootstrap work is no longer active before observer
creation; their seeds and the small neighbor transaction are recorded.

## Actual stop and diagnosis

The observer Pod is accepted and scheduled onto the authenticated database Node,
but remains Pending in `ContainerCreating`. It never becomes available within
its 60-second readiness bound. The driver records
`observer_readiness_or_network_deadline` at 124.239 seconds; the complete attempt,
including cleanup and independent preservation, ends after **146.566 seconds**.

Narrow read-only diagnostics correlate the exact observer Pod UID, target claims
and database mount paths in the native kubelet and CSI-node logs. The deployed
`openebs/lvm-driver:1.10.1` receives `NodePublishVolume` requests with
`readonly: true` for both observer mounts. It rejects each with:

```text
verifyMount: device already mounted at [existing PostgreSQL Pod mount]
```

This establishes why this observer cannot start with the installed driver and
mount arrangement. It does not establish that every RWO driver rejects multiple
Pods, that ext4 is faulty, or that the driver has a stale mount: the referenced
PostgreSQL mount is intentionally active. Namespace-scoped Events have already
disappeared during ordinary cleanup; no missing Event is invented as evidence.

The observer runs no filesystem command. Its read-only mounted-capacity and
explicit network-denial checks therefore have no runtime pass. No replication
slot, WAL producer, ambiguous producer transaction, target expansion or recovery
is dispatched in this attempt. Confirmed producer commits are **zero**. The
prior two real WAL PANICs and their unknown final outcomes remain separate;
their receipts are not reused for this run.

## Cleanup, preservation and verification

The unchanged ordinary cleanup validates recovered Namespace/Class UIDs,
operation ownership and every fresh PVC/PV/CSI identity. It deletes only the two
owned namespaces with UID/resource-version preconditions and allows normal
Kubernetes/CSI reclaim. The four claims, PVs and physical LVs disappear; the
captured new class is removed only after physical VG UUID/size/free bytes/LV
count match the baseline. No direct PV/LV deletion, forced finalizer, database
unmount, storage-driver patch or new provider order occurs.

Independent final readback passes the original Node UID/boot/readiness, all
30 original Running Pod identities/restarts, six PV/five PVC full specifications,
Retain class, original database and Pooler, both SQL markers and exact journal
custody: 4,096 pending facts, zero acknowledgements and zero accepted receipts.
The local environment files remain byte-identical, ignored, untracked and mode
0600. All 14 held source-file hashes remain unchanged.

Private Python syntax and cleanup-module syntax checks pass. There is one actual
native qualification invocation, zero new automated test stories and zero full
workspace gates for this unchanged-upstream operational exercise. No failed
result is relabeled green. Cloudflare control state, Worker deployment, Secrets,
customer admission and all other held candidates remain unchanged.

## Smallest next proposal

Review a fresh `statfs` observation through the CSI node's existing trusted mount
or its maintained `NodeGetVolumeStats` path, avoiding a second volume publication.
That read-only investigation is proposed, not verified here. Any subsequent
incident invocation requires a separately declared bounded exception retaining
all four attempts, the same failure/neighbor/commit-reconciliation assertions and
original-state cleanup. Do not change PVC access modes, introduce a privileged
observer, unmount PostgreSQL, upgrade the driver or automatically retry.

The selected full WAL incident/recovery remains open under PLAN.md's stop rule.
Backup/PITR, node-loss recovery, funded lifecycle and production acceptance also
remain separate gates.

References: [Cilium 1.20.2 verdict model](https://github.com/cilium/cilium/blob/v1.20.2/pkg/policy/types/policyentry.go),
[Cilium 1.20.2 L4 serialization](https://github.com/cilium/cilium/blob/v1.20.2/pkg/policy/l4.go),
[isolated fixture](../../infra/qualification/postgres-storage-recovery/README.md).
