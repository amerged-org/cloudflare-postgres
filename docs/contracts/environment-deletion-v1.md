# Environment deletion v1

The first implementation stage accepts a durable deletion intention, closes
execution authority and reuses the ordinary regional compute-stop workflow.
It does not yet dispose of database resources or establish physical deletion.
The complete deletion lifecycle remains part of the v1 roadmap.

## Request and recovery

`DELETE /v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}`
requires a current organization token with `projects:write`, an
`Idempotency-Key` and this exact body:

```json
{
  "expectedRevision": 0,
  "volumePolicy": "delete",
  "backupPolicy": "retain"
}
```

`expectedRevision` is the current compute-runtime revision from `GET .../runtime`.
Deletion can attach to an existing current suspend operation; it does not require
restarting compute first. A fresh running environment receives one ordinary
`environment.suspend` child. A single D1 transaction records the parent
`environment.delete` operation, immutable deletion binding, child stop intention
and runtime transition where needed. Concurrent state changes or active uncertain
database work conflict instead of being declared cancelled or completed.

The initial stage requires a ready environment with its accepted resource
observation. Cleanup of pending or failed partial provisioning remains an open
implementation requirement; it must discover and retain actual effect identities
before deciding what can be removed.

An accepted response is `202 {deletion, operation, stopOperation, runtime}`.
Exact idempotent replay returns the originally stored response and the same
parent/child identities. Changed valid input under the same key conflicts.
Replay still requires current authorization; it supplies no new execution grant.

`GET .../lifecycle` requires `projects:read` and returns
`{lifecycle, operation, stopOperation, runtime}`. An environment without a deletion
intention has null lifecycle and deletion operation fields. Environment item and
collection reads also expose lifecycle separately from historical provisioning
status and the original creation operation.

The public deletion view reports:

- `desiredState: "deleted"`, never a claim of current physical removal.
- Immutable parent `operationId` and compute `stopOperationId`.
- `phase: "stopping"` while the child is queued or running.
- `phase: "pending_physical_deletion"` after a reported stop result.
- `volumePolicy: "delete"` and `backupPolicy: "retain"`.
- `physicalDeletionVerified: false` throughout this implementation stage.

The parent is not marked succeeded by a child stop result. Kubernetes convergence
and a stored stop observation do not establish qualified node termination,
resource disposal or backend disk deallocation.

## Authority and retained history

The immutable intention is an execution barrier. Running-path predicates reject
new provisioning effects, role/database mutations, credential disclosure,
connection discovery, backups, resizing and allowance issuance. Creation claims,
lease renewal and result publication must observe the same barrier. Historical
completed result replay can remain readable without reprovisioning resources.

Existing allowance authority reads include the deletion binding in their primary
snapshot and post-hash revalidation. They return a stop decision with
`environment_deleting`. Changing mutable runtime state or an integrator's budget
cannot remove this intention or restore authority.

The separate stop child remains authorized to close compute admission, scale the
owned Pooler down and request CNPG hibernation. It reuses the
[suspend contract](environment-suspend-v1.md); its present executor defers physical
completion with `physical_verification_pending`.

Environment identity rows, operations, encrypted credential versions, backup
metadata, usage facts, gaps and reservations remain recoverable. Late usage,
corrections and historical settlement remain permitted under their original
scopes. Deletion intent creates no final zero usage, credit, settlement or released
reservation. Data disks continue consuming attributable storage until actual
deallocation is proved.

## Remaining physical disposal gates

Before adding irreversible cleanup, qualify complete workload birth/history,
retirement on every original eligible node or an independently proved fencing
path, stale-writer exclusion and final accounting custody. Bind every resource
and effect to its exact retained UID and durable dispatch identity. An uncertain
delete response requires observation of the same target; replacement identities
cannot be adopted or blindly deleted.

CNPG/PVC/Namespace removal and local-volume deallocation are separate facts.
The existing Retain policy must not be mistaken for freed disk space. Prove the
OpenEBS/CSI backend retirement and its allocation-end evidence before reporting
storage removal.

Retain archive/server identity, backup metadata, retention responsibility and
usable installation-owned archive credentials outside the removed namespace.
Independently restore from retained R2 after source removal. Remote archive purge
is a separate qualified operation. The held backup, native and Pod-birth
qualification workflows are not resumed by this source stage.
