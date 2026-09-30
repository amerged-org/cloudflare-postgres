# PostgreSQL WAL qualification — preparation stop and safety cleanup

Status: stopped before incident SQL; original state restored. This is not a WAL
failure, recovery, storage expansion or M4 completion result.

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
