# Manual physical base backups v1

An authorized customer may request a physical base backup of one existing managed
environment. The operation uses its current CNPG Cluster and configured Barman
archive. It includes all PostgreSQL databases in that environment; it is not a
logical per-database export. The generic product API and regional executor remain
separate from installation/provider qualification.

## Customer request and retained history

`POST /v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/backups`
requires organization `projects:write`, `Idempotency-Key` and exactly `{}`.
The customer supplies no hostname, path, credential, retention window, CNPG field
or recovery target. The primary D1 transaction binds the ready environment,
accepted Cluster UID, immutable spec/hash, run identity and current running
runtime revision. Active parent/region and requested project/environment budget
state are rechecked before accepting new work. Only one queued/running manual
backup is permitted per environment.

The reply is `202 {backup,operation}`. Exact scoped intention replay preserves the
original identity/response; a different intention under that key conflicts.
Ordinary read-scoped item/collection endpoints retain public backup metadata and
the organization's operation endpoint retains the operation identity. History
remains readable while the environment is stopped or the backing Kubernetes CR
has disappeared. No archive URLs, credentials, backend Secret references, lease
tokens, raw errors or private dispatch nonce are exposed in customer history.

Separate immutable intention/history tables use additive migration `0015`. They
preserve the original environment profile and its serialization.

## Runtime and funding interlocks

Manual suspension cannot race a pending backup: both enqueue transactions recheck
the other's queued/running operations atomically, and uncertain expired leases
still hold the manual-suspend lock. Backup claim, renewal and dispatch require
current running environment/runtime identity and permitted requested budget state.
No new backup is admitted to manufacture wake or continued compute authority.

The manual interlock does not prevent an independent hard-budget stop or extend
an allowance. Backup work runs in an existing Barman instance sidecar; it creates
no new worker Pod, changes no quota and acquires no extra funding. The existing
allocation collector remains responsible for actual resource-time attribution;
this feature supplies no invented zero charge, final accounting or archive-byte
measurement. Physical enforcement flags stay unchanged.

A narrow terminal-custody report may retain a known completed/failed observation
under an otherwise valid winning unexpired lease during requested budget pause.
It must still match active ownership, spec/Cluster/run/runtime identity and grants
no new dispatch, renewal or compute authority. The regional controller stops
using a lost/expired lease; uncertain backend or transport outcomes defer rather
than publish a guessed terminal result.

## Leased regional execution and dispatch checkpoint

The private lane is
`/v1/regions/{regionId}/backup-operations/{claim|operationId/renew|operationId/dispatch|operationId/result}`.
It reuses the existing region executor token and claim/report scopes. Claims
include the immutable environment execution specification, accepted Cluster UID,
runtime revision, optional run epoch, ordinary lease and any recorded dispatch.
Archive references are private executor configuration; they do not authorize
customer selection of arbitrary providers or administrative access.

The first executor reads the derived managed Namespace, `database` Cluster and
`archive` ObjectStore. It validates platform ownership/spec/run labels, the exact
accepted Cluster UID and actual profile compute/storage/image/bootstrap/plugin
configuration. The Cluster must be ready and not hibernated. Its enabled Barman
parameters must resolve `archive` and serverName `database` in that environment.
The ObjectStore endpoint, destination including the environment suffix, fixed
credential selectors, gzip WAL/data, retention and bounded sidecar resources
must match the product profile. Extra sidecar environment or arguments and
unmodeled archive settings are refused. Only pinned CRD defaults of 1,800 seconds and
log level `info`, or omitted equivalents, are accepted.

The executor observes real Namespace/ObjectStore UIDs; no UID is manufactured
from an environment identifier. It records a D1 dispatch checkpoint with exactly
`version:1`, a fresh `nonce`, issuing `leaseEpoch`, and this binding:

```json
{
  "namespaceUid": "<observed namespace UUID>",
  "clusterUid": "<accepted Cluster UUID>",
  "specHash": "<immutable environment hash>",
  "objectStoreUid": "<observed archive UUID>",
  "objectStoreGeneration": 1,
  "objectStoreSpecHash": "<canonical actual ObjectStore spec SHA256>",
  "backupName": "backup-<backup UUID without hyphens>",
  "backupSpecHash": "<canonical fixed Backup spec SHA256>"
}
```

Hashes use recursively ASCII-sorted JSON object keys with array order retained.
The full actual ObjectStore spec remains bound across leases; status-only
recovery-window updates do not change this binding or require a stable resource
version. Namespace/Cluster/archive identities and policy are rechecked before
effects and terminal publication. Trusted administrators must coordinate changes
because there is no cross-resource Kubernetes/D1 transaction.

Only a positive `created:true` response for the fresh nonce and current lease
permits the originating process to attempt the initial Backup creation once.
Exact checkpoint replay returns `created:false` and never grants that permission.
An in-memory attempt flag is set before the Kubernetes request. A timeout follows
the same deterministic resource readback; it never blindly repeats the create.

Reclaimed claims with a checkpoint are observation-only. The same owned resource
can continue, but a 404 after dispatch remains an unknown outcome. This applies even
if the process crashed between committing dispatch and making the Kubernetes
request. Explicit operator reconciliation is needed for that gap; there is no
automatic reset/cancel/redispatch endpoint in this slice. Losing a HTTP response
cannot create another physical backup.

## CNPG resource and terminal observation

The fixed Backup specification is:

```json
{
  "cluster": { "name": "database" },
  "target": "primary",
  "method": "plugin",
  "pluginConfiguration": { "name": "barman-cloud.cloudnative-pg.io" }
}
```

The platform explicitly supplies the accepted Cluster UID controller owner,
environment/backup identity and immutable spec/dispatch/archive annotations.
CNPG's manual controller does not add this ownership itself. Existing foreign
resources, divergent specifications or a changed observed UID are refused;
trusted administrators must not recreate a resource with copied operation
metadata. A fresh process may recover only the exact checkpoint-owned resource.
There is no Backup patch/delete, archive mutation, restore, SQL command or WAL
switch in this executor.

Only CNPG `completed` and `failed` are terminal. Pending/started/running,
wal-archiving failures, invalid definition and unknown states defer under the
same durable operation. A `completed` resource requires its Barman backup ID/name,
major version, ordered valid tool times, WAL and LSN values, online flag and the
six pinned plugin metadata fields. Its source Cluster UID and plugin identity
must match. Valid seconds-only UTC Kubernetes times are normalized to canonical
millisecond UTC; no nonexistent `observedGeneration` or Pod UID is inferred.

The completion projection contains the exact Namespace/Cluster/ObjectStore
binding, Backup resource UID/version/spec hash, terminal phase and either the
whitelisted artifact or null for failure. Raw command/error output, credentials,
backup-label and tablespace contents are excluded. Stable result codes are
`base_backup_completed` and `backup_failed`. Winning-lease acceptance atomically
retains terminal history; exact replay cannot revive execution.

**Completed means the trusted operator reports a physical base artifact.** It
does not prove remote objects still exist, WAL continuity, an independent restore,
PITR, safe retention or an available recovery window. Wire flags
`remoteObjectsVerified` and `restoreVerified` remain false; public PITR
verification is also false. Deleting a Backup CR is not archive deletion, and
plugin catalog maintenance can remove a CR independently. D1 completion history
therefore survives later CR disappearance.

## Deployment and qualification

The regional lane is explicitly enabled with `PGCF_MANUAL_BACKUPS_ENABLED=true`.
Omitted or `false` keeps it off; other values fail configuration before work
starts. It uses the existing region token file and kubeconfig, introduces no
Secret file, and adds only Backup `get/create` RBAC. A queued customer intention
does not complete while the installation leaves its executor disabled.

The source uses pinned CNPG 1.30.1 and Barman 0.15.0 contracts. Actual S3/R2 access,
runtime backup/WAL/restore/PITR and archive accounting require their own qualified
installation. The installation operator must qualify its existing plugin and provider
credentials before enabling backup execution. No production availability or customer admission is
implied by mock tests or source delivery.

Exactly three top-level cases are touched across this feature: one new Worker
lifecycle/interlock case, one new regional owned-operation story, and one expanded
existing control-recovery case preserving the new backup records/schema. Every
case fails meaningfully before implementation. Iteration stays on named files;
the parent freezes and runs the canonical full gate once. Other held cases and
the unchanged Go evidence are retained.

Sources: [CNPG 1.30.1 Backup types](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/api/v1/backup_types.go),
[CNPG plugin status writer](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/management/postgres/webserver/plugin_backup.go),
[Barman 0.15.0 metadata](https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.0/internal/cnpgi/instance/types.go),
[archive/sidecar configuration](https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.0/api/v1/objectstore_types.go),
[catalog retention](https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.0/internal/cnpgi/instance/retention.go).
