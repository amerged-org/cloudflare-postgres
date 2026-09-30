# PostgreSQL WAL-capacity incident and recovery

Status: **the selected single-node WAL incident/recovery is qualified**.
This is an operator-owned exercise of PostgreSQL 18.4, CloudNativePG 1.30.1,
OpenEBS LVM driver 1.10.1 and the existing Talos/Kubernetes installation. It is
not a backup/PITR, node-loss, customer-ingress or production milestone claim.

## User direction and precise correction

The [original preparation and two corrections](m4-postgres-wal-preparation-stop-2026-09-30.md)
and [subsequent observer stop](m4-postgres-wal-observer-stop-2026-09-30.md)
remain recorded. The user then explicitly instructed: remove the limit and fix
it. PLAN.md removes the fixed two-correction cap; meaningful red-first evidence,
targeted tests, one final source gate, invocation deadlines and cleanup remain.
No previous failure is relabeled as passing.

The implementation uses the existing authenticated CSI node plugin and its
already-published database mounts. It performs read-only `statfs` and mount-info
observations through ordinary operator Exec. No second volume publication,
extra observer Pod, added privilege, filesystem-content read, permission change,
unmount or storage-driver modification is needed. This remains a trusted
installation-operator procedure, not customer authority to select host paths.

Before incident effects, the observer binds the Node UID/boot, CSI Pod UID/full
spec/container identity/image/restarts, owned database Pod and Cluster, both
PVC/PV/CSI bindings and exact host mount paths. It checks ext4, distinct devices,
LV source identities, mounted capacity and device agreement with PostgreSQL.
Post-failure measurements are actual syscalls dispatched after the failure;
pre-failure Kubelet caches are never accepted as fresh evidence.

## Retained parser stop and red-first correction

Native invocation five reaches both Ready fixtures and successfully returns
current filesystem measurements through the CSI plugin. Its parser treats the
blank separator preceding mount-info output as a mount record and raises
`ValueError`. It stops before seed/producer/slot/expansion work at 56.173 seconds;
cleanup and independent original preservation pass, with the entire invocation
ending after 77.932 seconds.

One captured-output regression fails first for exactly that defect. The minimal
correction skips blank separators while retaining strict parsing of every
nonempty mount record and all two-device checks. The same named regression
passes. There is one new private top-level regression, no test matrix and no
new public runtime test suite. Every immutable invocation and driver hash is
retained; the corrected driver is reviewed and frozen before invocation six.

## Complete actual qualification

Invocation six preserves the original 540-second total bound and 70-second
cleanup reserve. Two fresh restricted namespaces, independent CNPG Clusters,
four thick ext4 claims, enforced network policies and unchanged quotas are used.
The target data/WAL requests start at 512/128 MiB; the neighbor starts at
256/128 MiB. Only the target WAL request expands to 384 MiB.

The ordinary logged SQL producer acknowledges **60 identified one-MiB commits**
with independently expected payload hashes. Transaction 61 loses its response
and is retained as uncertain; it is never replayed. PostgreSQL's actual record
is **PANIC / SQLSTATE 53100**, with `pg_wal/xlogtemp` failing because there is no
space left on the device.

Fresh post-failure observations show:

| Measurement | Actual bytes / count |
| --- | ---: |
| WAL filesystem capacity before expansion | 120,015,872 bytes |
| WAL bytes available after failure | 16,618,496 bytes |
| WAL inodes available after failure | 32,741 |
| Data filesystem capacity | 510,873,600 bytes |
| Data bytes available after failure | 401,711,104 bytes |
| WAL mounted capacity after expansion | 371,080,192 bytes |
| WAL bytes available after recovery | 250,905,600 bytes |

Available bytes need not be zero to reject the next WAL allocation. The explicit
WAL error, fresh filesystem pressure, available inodes and substantial separate
data headroom jointly prove this selected failure. Mounted ext4 capacities are
measured usable values, not nominal PVC requests.

While that condition persists, the neighbor acknowledges another small durable
transaction and reads both receipts and its seed. Its database identity and
both volume capacities remain unchanged after target recovery.

Only the sealed target WAL PVC storage request and matching Cluster WAL size
are patched, each with UID/resource-version/full-spec guards. The same PVC,
PV, CSI handle, LV devices, data filesystem and PostgreSQL system identifier are
preserved. Actual node and PostgreSQL filesystem measurements agree on expansion.
The same owned replication slot, starting LSN and inactive receiver remain
unchanged; no WAL is manually deleted or reset.

Recovery takes **16.220 seconds** from the declared recovery observation start.
All 60 acknowledged rows and receipt hashes match exactly. The uncertain
transaction 61 is wholly absent. A fresh distinct transaction then commits and
reads back correctly. The original seed and system identity match. No uncertain
write is retried or given a guessed outcome.

The entire invocation, including ordinary cleanup and final preservation,
passes in **125.006 seconds**, with one selected native case. No workspace-wide
source gate is repeated for this unchanged-upstream operational exercise.
Private driver and cleanup syntax checks pass.

## Cleanup and preservation

Cleanup deletes only recovered fixture Namespace UIDs with resource-version
preconditions. Normal Kubernetes/CSI reclaim removes all four fresh claims,
PVs and actual LVs. The new Delete class is removed only after the physical VG
UUID, size, free bytes and LV count match the original baseline. No original
volume, retained class or finalizer is altered to obtain cleanup.

Independent final readback passes the original Node/boot/readiness, all
30 original Running Pod identities/restarts, six PV/five PVC full specifications,
Retain class, manual CNPG database and Pooler, both SQL markers and full usage
journal custody: 4,096 pending facts, zero acknowledgements and zero accepted
receipts. Environment files remain ignored, untracked, mode 0600 and byte-identical.
All held source drafts remain unchanged. No Cloudflare deployment, schema,
Secret, customer admission or provider server order occurs.

The public fixture documents the corrected operator measurement procedure.
Actual customer storage automation, other disk-full modes, backup/WAL/PITR,
node-loss recovery and the remaining PLAN.md production gates remain open.
