# Isolated PostgreSQL WAL-storage failure and recovery

Status: **qualification assets; complete incident/recovery held after two corrections**.
The [preparation-stop evidence](../../../docs/evidence/m4-postgres-wal-preparation-stop-2026-09-30.md)
records the initial preparation/cleanup stops, two later actual PostgreSQL WAL
panics, failed fresh filesystem observations and independently verified cleanup.
There is no complete WAL-failure/neighbor/recovery qualification claim. This is one
operator-owned exercise of PostgreSQL 18.4, CloudNativePG 1.30.1 and an existing
qualified OpenEBS LocalPV LVM stack. It measures a full WAL filesystem, a fresh
neighbor's durable transactions and bounded storage-expansion recovery. It does
not establish every disk-full mode, node loss, backup/PITR or production tenancy.

The resources are examples, excluded from platform Flux reconciliation. Their
placeholder values must be replaced in a private copy before rendering or any
provider operation. Follow [PLAN.md](../../../PLAN.md)'s stop limits and preserve
every failed preparation or runtime observation. Reuse no held qualifier and do
not introduce an artificial red test or a full workspace gate for unchanged
upstream behavior.

## Freeze the owned scope

Copy this directory to ignored private storage. Set the five values in
[settings.example.yaml](settings.example.yaml): a new operation UUID, an
authenticated Node name, two new namespaces and a new StorageClass name. Every
name must be absent before creation. Keep a private immutable operation ledger
with the rendered hashes, exact object specifications, identities recovered
after uncertain creates, acceptance deadlines and cleanup ownership.

The replacements propagate names, operation labels and storage selection. The
settings ConfigMap is an ordinary nonsecret resource in the target namespace;
include it in the owned inventory. Do not publish private Node names, UIDs,
addresses, credentials or observations. Refuse any rendered placeholder or the
literal example namespace/class names before dispatch.

Render with a maintained Kustomize client, inspect all resulting resources, and
validate them against the actual CNPG, Cilium and Kubernetes schemas. A preview
must preserve the exact intended spec after documented admission defaults. Stop
on an unexplained field or unavailable prerequisite; do not relax an identity
comparison to continue. The Node's `kubernetes.io/hostname` label must equal the
selected authenticated name. Seal its UID/boot ID and verify both instance Pods
actually use that same Node; a selector alone is not identity proof.

The fresh StorageClass copies the existing qualified thick/ext4/`pgcf` group,
`WaitForFirstConsumer` and expansion settings. Only its new fixture volumes use
`Delete`. Keep the existing `pgcf-lvm` Retain class unchanged. No existing claim,
retained volume or database is a target, neighbor or cleanup candidate.

| Fixture  | Data PVC | Initial WAL PVC | Final WAL PVC | Instance request / limit           |
| -------- | -------- | --------------- | ------------- | ---------------------------------- |
| Target   | 512 MiB  | 128 MiB         | 384 MiB       | 100m / 500m CPU; 256 / 512 MiB RAM |
| Neighbor | 256 MiB  | 128 MiB         | 128 MiB       | 100m / 500m CPU; 256 / 512 MiB RAM |

Initial allocation is 1 GiB; the one target-WAL expansion makes the total
1.25 GiB. Namespace quotas permit the final storage amount and at most two
bounded Pods, allowing native bootstrap Job/instance overlap. Verify actual
CNPG-created resource requests/limits and current scheduling, memory pressure,
physical group free space and recovery headroom before creation. Nominal free
space is not a production capacity reservation. If these small data/WAL sizes
cannot bootstrap under the pinned image/operator, record the preparation stop;
do not silently increase the volumes or change the scenario.

The namespaces enforce Restricted Pod security. Their Cilium policies select
all local endpoints and permit only Pods in the existing CNPG operator namespace
with `app.kubernetes.io/name=cloudnative-pg` on TCP8000, Kubernetes API egress and
CoreDNS egress. They create no public ingress
or TCP5432 client path. Review existing additive/global policies and actual
operator/DNS identity, including that exact operator Pod selector, before
dispatch; these manifests alone do not prove full
network isolation. Preserve the CNPG-owned ServiceAccount token projection:
the instance manager needs its existing Kubernetes API authority. Do not grant
it new cluster roles or disable the projection to imitate a SQL client Pod.

Create and verify the fresh namespaces, quotas, settings and network policies
before creating either Cluster or allowing its native bootstrap Job. A rendered
resource order is not a policy-install barrier; do not apply the whole output
as an undifferentiated batch. Record exact Namespace/policy UIDs and intended
selector/port/entity specifications. After bootstrap, require current owned
CiliumEndpoints with Ready/healthy status, both ingress and egress policy
enforcement, and realized policy revision greater than or equal to the desired
revision before any seed/producer SQL or WAL incident effect. Retain policy
provenance and recheck it across recovery; require all selected operator Pods to
match the reviewed namespace and label rather than assuming the selector fits.

Seal the original Node, active Pod/restart maps, Clusters, PVC/PV/CSI/LV identities,
source StorageClass, physical VG identity/free bytes and existing SQL markers.
Preserve complete usage-journal custody independently. Re-read the baseline
before each incident, recovery and cleanup effect. All workload/resource writes
in this exercise address only the fresh owned identities.

## Prove the selected WAL failure

Wait for native bootstrap and both actual PostgreSQL instances. Require distinct
data/WAL PVC/PV/CSI handles, the selected physical group and separate mounted
filesystems. Confirm `/var/lib/postgresql/data/pgdata/pg_wal` resolves onto the WAL
mount in the actual image. Record usable capacity and PostgreSQL system identity.
Keep PostgreSQL durability enabled and make no archive/plugin configuration.

Use authenticated operator Exec into each fresh PostgreSQL container and its
local Unix socket. Run `psql -X -v ON_ERROR_STOP=1 -d app` as the trusted operator,
then `SET ROLE app` for fixture schema and producer SQL. This path does not
qualify customer password authentication, TLS ingress, a native client profile
or the held API-managed pilot.

Commit a unique seed and a small identified transaction in each database, retain
their expected contents/hashes, and read both back before the incident. The
target producer uses a logged table owned by `app`, one unique batch ID per
transaction and bounded, incompressible stored payloads. For example, a text
payload column set to `STORAGE EXTERNAL` avoids TOAST compression of repeated
test bytes. One row containing `repeat(md5(batch_id), 32768)` has exactly 1 MiB
of text payload; confirm both `octet_length` and `pg_column_size` in the real
fixture. Keep row counts and expected payload hashes in the private ledger.
Do not use unlogged/temporary tables, arbitrary filesystem filler, WAL deletion,
`pg_resetwal` or a customer superuser as an alternative failure mechanism.

Before the producer, the operator creates one physical replication slot with
immediate WAL reservation in only the fresh target, using a unique run-bound
name. Record its starting LSN and require that no receiver advances it. This
models an unavailable replication receiver retaining WAL; the producer still
uses the ordinary `app` role. The native CNPG admission requires `max_wal_size`
to be smaller than its WAL volume, so the valid 96-MB threshold is explicit.
The retained slot, not an invalid maximum or disabled durability, creates the
selected pressure. `max_slot_wal_keep_size=1GB` stays above the producer's
256-MiB bound. Do not create a slot in an existing database or change it after
an observed incident to manufacture the required result.

Freeze one producer of at most 256 transactions, at most 1 MiB of payload per
transaction (256 MiB total plus measured row/WAL overhead), and a 120-second
wall-clock deadline. The target's `max_wal_size=96MB`, `max_slot_wal_keep_size=1GB`,
`checkpoint_timeout=30min` and `wal_compression=off` are deliberate incident
settings; `min_wal_size=80MB` is retained. Measure effective values and elapsed
time. Stop when the selected
storage failure occurs or a bound is reached. A checkpoint, elapsed deadline or
unexpected data-volume failure cannot be reported as WAL exhaustion.

Record each acknowledged commit before issuing the next batch. On an uncertain
final transaction, stop issuing writes; never replay it blindly. Retain its
batch identity and complete expected row set for post-recovery reconciliation.

A failure pass requires explicit PostgreSQL WAL `ENOSPC`/no-space-left evidence
tied to this exact WAL filesystem, independently observed WAL free space/failed
allocation, and data-filesystem headroom. A preventive CNPG low-space shutdown
without actual WAL `ENOSPC` is an inconclusive result. Do not change parameters
or assertions after that observation to force success. A generic disconnect,
unready Pod or full data filesystem is insufficient. Record the actual severity,
SQLSTATE where available, and CNPG readiness/primary/instance observations.

While that exact target condition persists, the fresh neighbor must retain its
seed, acknowledge a new small logged transaction, read it back and remain on its
unchanged data/WAL bindings. Bound neighbor payloads so its own 128-MiB WAL
filesystem does not become a second exhaustion scenario. Existing lab databases
receive only their original read-only marker checks.

## Expand and reconcile the same database

CNPG's pinned troubleshooting procedure expands the affected PVC first and then
sets the matching Cluster size. Seal the target WAL PVC's UID, binding, old
request and full spec; test those identities/current resource version before
changing only its storage request from `128Mi` to `384Mi`. Recover an uncertain
response through that same identity and intended size, rather than another
resource or a repeated unguarded request.

Then test the fresh target Cluster's UID, current resource version and unchanged
specification, and change only `spec.walStorage.size` to `384Mi`. Its data size,
neighbor sizes, image, parameters, instance count and resource bounds remain
fixed. The target quota already accommodates the final bound. Do not patch the
original class, source Cluster, unrelated PVCs or operator installation.

Require the same WAL PVC/PV/CSI/LV binding, actual CSI expansion and ext4 mounted
capacity increase, adequate WAL free space, and fresh PostgreSQL recovery logs.
An accepted patch or larger PVC spec is not expansion proof. Do not delete a
Pod or widen recovery actions after an unexpected result; record the smallest
proposed next step under the frozen operation and stop limits.

Acceptance requires the same PostgreSQL system identifier and data volume,
actual Ready instance and SQL service, exact seed and every acknowledged batch
preserved, the uncertain final batch either entirely absent or present exactly
once with matching contents, and one fresh acknowledged transaction/readback.
Record the observed recovery time against the declared deadline. No partial
batch or missing acknowledged commit is acceptable. Reconfirm the neighbor and
all protected original resources before cleanup.

## Reclaim only the fixture

Keep owned metadata and all four new CSI/LV handles, explicitly excluding every
original handle. For each namespace deletion, require the exact recovered UID
and operation ownership; an uncertain response is observed until absence. Let
CNPG/Kubernetes/CSI remove their normal dependents. Do not force finalizers or
delete unknown PVs/LVs manually. Remove the exact fresh StorageClass only after
its owned claims/PVs are gone, using its recorded UID.

Require absence of both namespaces, settings ConfigMap, Clusters, instance and
bootstrap Pods/Jobs, all four fixture PVCs/PVs/LVMVolumes, and their actual LVs.
The original PV/LV identity/size set, VG UUID/size/free bytes, source Retain class,
Node/boot/health, protected workloads/restarts, source SQL markers and complete
journal custody must match the sealed baseline. A Namespace or PV API deletion
alone is not physical reclamation evidence.

Keep failed records and actual measurements in private evidence. Add a public
result separately only after the original-state readback and cleanup finish.
Even a successful exercise leaves backup/PITR, fresh-infrastructure/node-loss
recovery, other disk-full modes, funded lifecycle and production acceptance open.

Sources: [CNPG 1.30.1 storage-full recovery](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/troubleshooting.md#storage-is-full),
[CNPG 1.30.1 volume expansion](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/storage.md#volume-expansion),
[CNPG 1.30.1 instance-manager disk-full behavior](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/instance_manager.md#disk-full-failure),
[PostgreSQL 18 WAL configuration](https://www.postgresql.org/docs/18/runtime-config-wal.html),
[Cilium entity policy](https://docs.cilium.io/en/stable/security/policy/language/#entities-based).
