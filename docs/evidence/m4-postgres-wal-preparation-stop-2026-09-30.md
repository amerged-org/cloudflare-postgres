# PostgreSQL WAL qualification — preparation stop and safety cleanup

Status: held after two corrections. Actual target WAL failure is observed twice;
independent post-failure filesystem evidence and recovery remain unqualified.
Every attempt's fresh resources are removed and original state is restored.
The first attempt below remains a preparation stop, not a successful incident.

## Admitted preparation

The [public fixture](../../infra/qualification/postgres-storage-recovery/README.md)
initially declares `max_wal_size=1GB` against a 128-MiB WAL claim. Native CNPG
admission rejects that combination. The original preview failure is retained.
Before any resource creation, a narrow preparation correction sets the admitted
96-MB maximum and an explicit run-owned physical replication-slot reservation
with a 1-GB retention ceiling. This selects an unavailable receiver as the WAL
retention cause while retaining the 256-MiB/120-second logged SQL producer,
original storage bounds and durability requirements. Two corrected native
previews preserve explicit fields and establish the admitted default specs.

Runtime preparation source is `b772fd6fbeffe34352a2e5bdd8558a8a18d5070d`.
Public GitHub readback matches both corrected source files. The rendered private
specifications match the source; native read-only inventory verifies sufficient
request/storage headroom, exact original identities, actual operator/DNS labels
and absent fixture names. Cilium endpoint/native-status schema is read from the
existing installation, without invoking a held native or observer qualifier.

## One actual attempt

The frozen driver dispatches exactly one qualification case with a 540-second
limit and a 70-second cleanup reserve. Its safety review binds owned identities,
policy fields, admitted Cluster specs, target-only guarded expansion, durable
transaction intentions and expected payload digests, and independent final
preservation. No artificial red test or workspace gate is introduced for the
unchanged upstream storage/database behavior.

Two fresh restricted namespaces, two CNPG Clusters, four fresh thick claims,
quotas and narrow network policies are created. The target PostgreSQL Pod and
Cluster become Ready. Its CEP owner UID matches that Pod, but CEP state is still
`waiting-for-identity`. The current immediate assertion stops rather than waiting
for the separate endpoint/policy readiness condition. The run ends after
28.352 seconds, with zero acknowledged transactions and no uncertain transaction.
No seed/producer SQL, replication slot, target expansion or WAL ENOSPC occurs.

The first frozen cleanup stops with `namespace_inventory_incomplete` before
deletion. Its metadata-only API-list handoff is not a qualified ordinary client
list. The original qualification result remains failed; neither failure is
relabeled as a successful test or repaired through another incident invocation.

## Safety cleanup and independent preservation

A separately reviewed, bounded safety cleanup uses ordinary maintained
Namespace/PVC/PV APIs. Complete readback verifies both captured namespace UIDs,
operation labels and absence from baseline, the captured fresh class UID and
Delete policy, all four separate bound CSI identities, and exclusion of every
original handle/UID. Namespace deletion uses exact UID/resource-version
preconditions and ordinary foreground removal. No PV/LV is directly deleted,
no finalizer is forced and no existing namespace is selected.

The two namespaces, four claims/PVs and their actual LVs disappear. The physical
VG UUID, size, free bytes and LV count match the original snapshot exactly before
the captured fixture class is removed with its UID/resource-version guard.
Cleanup completes successfully; its proof is separate from the failed qualifier.

Independent final readback confirms the same Node UID/boot and Ready state;
all 30 original Running Pod UIDs/restart counts; six PV/five PVC identities and
full specs; the unchanged Retain class, original CNPG Cluster and Pooler; both
original SQL-marker counts one; and exact journal identity/outbox SHA with
4,096 pending facts, zero acknowledgements and zero accepted receipts.
Environment files and held source hashes remain unchanged. No provider server
order, Cloudflare deployment/secret/schema change or customer admission occurs.

## Required next step

A bounded correction must wait for the actual owned CEP/native endpoint to become
Ready with the frozen enforced policy, rather than equating PostgreSQL readiness
with endpoint readiness. Cleanup must use the independently verified ordinary
API-list shape while preserving exact owned UID and original-storage guards.
Freeze and review that correction before a separately declared continuation.
This record does not authorize a retry, weaken WAL ENOSPC acceptance, resume held
work, or establish any result of incident SQL or recovery.

## First correction: actual WAL panic, failed in-container observation

The first bounded continuation changes only endpoint readiness waiting and the
cleanup's ordinary API-list shape. All identities, enforced policy assertions,
producer bounds, volume sizes and recovery conditions remain unchanged. Prior
failure records are retained; this is corrective attempt one on the same case.

The target commits and acknowledges 74 identified one-MiB logged payloads, each
with an independently expected digest. Batch 75 returns `PANIC 53100` while
writing `pg_wal/xlogtemp`: `No space left on device`. The disconnect is recorded
as an uncertain transaction and it is not replayed. This is direct PostgreSQL
WAL-storage failure evidence, not a generic readiness error.

The subsequent filesystem observation uses Exec inside the target container.
PostgreSQL's failure removes that available container, so the command returns
`container not found`. The continuation ends after 83.675 seconds before neighbor
incident proof or any expansion/recovery. Its corrected ordinary cleanup passes
and the independent final full original/journal preservation passes.

## Second correction: fresh off-process observation is unavailable

Corrective attempt two observes the failed target through the existing native
Kubelet stats-summary API, with no additional Pod, role or privilege. Read-only
schema discovery confirms PVC capacity/free-byte/time fields. The observer binds
the current owned Pod UID, namespace, both exact sealed PVC/PV/CSI identities and
the actual pre-incident mounted capacities. It requires both measurement times
to be at or after the independently recorded failure time. This freshness rule
is not weakened to accept cached data.

The same unchanged producer again acknowledges 74 transactions and receives the
same PostgreSQL WAL `PANIC 53100` for batch 75. The failure is observed at
19:03:11.794 UTC. The available target Kubelet samples are from 19:03:03 UTC,
with 33,395,712 available WAL bytes before the failure; they cannot establish the
post-failure filesystem condition. No fresh matching sample arrives within the
75-second bound. The case ends after 171.017 seconds with
`fresh_failed_volume_stats_deadline`, before neighbor incident proof or recovery.

Cleanup removes only the two fresh namespace UIDs, their four claims/PVs and
physical LVs and the fresh class. Physical VG identity/size/free bytes/LV count
match the snapshot. Original Node/boot, all original workloads/restarts, full
PV/PVC specs, retained class, manual Cluster/Pooler, both SQL markers and exact
journal custody pass final verification. No extra source workload, API-managed
environment, provider order, Worker deployment, schema or Secret change occurs.
The two native corrections add no automated cases and run no workspace gate.

## Mandatory stop and reviewable next proposal

The same complete qualification remains red after two implementation corrections.
It is held under PLAN.md's bounded-stop rule; there is no fourth invocation.
WAL failure is proved, but the full incident/recovery claim remains false.
The two unknown batch-75 outcomes are never replayed or assigned a guessed result;
cleanup deletes only their independently declared disposable fixtures.

A private, unapplied proposal adds one nonprivileged observer only in the new
fresh target namespace after native bootstrap, with read-only mounts of only
that target's two sealed new claims. It uses no service-account token or
credentials, requests 50m CPU/64 MiB memory, and would measure the live filesystem
without depending on PostgreSQL or cached Kubelet samples. The original workload,
capacity/expansion limits, nine-minute total bound, failure/recovery assertions and
cleanup remain fixed. Exactly one extra attempt has been requested from the
human user. No observer resource or extra attempt exists without that explicit
exception; elapsed time and automatic goal continuation are not approval.
