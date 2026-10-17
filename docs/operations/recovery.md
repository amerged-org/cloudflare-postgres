# Operator recovery

The operator deployment uses local PostgreSQL volumes and R2 archives. Loss of a VPS is recovered
from R2; the last recoverable commit depends on the WAL that actually reached R2. There is no
synchronous replica or zero-loss promise. Record both recovery duration and the last restored
commit in the ULTRA plan after each real drill.

The operator topology is EU only: customer EU1 (6 vCPU, 12 GB RAM), as recorded in the canonical
[ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md). The Kubernetes
runtime was retired on 2026-10-17; no node executes databases until the Debian node runtime of
the plan is installed. Never order a replacement node without the owner's explicit, costed go.

Recovery drills use separate targets while preserving the healthy source and its committed data.
Do not reset, re-adopt, fence, delete or decommission EU1 for an acceptance drill. The incident
procedures below apply to an actual loss or a separately reviewed drill that preserves or
recovers the same customer EU1.

## Restore or PITR

1. Check `/v1/operational-health?scope=databases` and the source's archive summary. Missing
   observations are unknown. A completed base backup and continuous archived WAL are required.
2. Submit `POST /v1/databases/{source-id}/restore` with a persistent `Idempotency-Key` and either
   `{"mode":"full","name":"recovered"}` or
   `{"mode":"pitr","name":"recovered","target_time":"<UTC timestamp>"}`.
   Optional `region_id` selects a target region; omission keeps the source region. For example,
   `{"mode":"full","name":"recovered","region_id":"<target-region-id>"}` restores into healthy
   capacity in that region after the source-read credentials below have been installed.
3. Save the returned target ID and operation ID. Repeating the same request and key returns the
   same target; a transport failure does not justify issuing a new key or replaying SQL writes.
4. Poll the operation. The source stays unchanged. The target uses new storage and its own
   region's bucket, endpoint and archive path; its configuration revision is independent of its
   storage generation. Source backup/WAL selection still uses the source region's catalog and
   bucket, including when the source has been deleted.
5. Ready requires recovery promotion, SQL database-name mapping, actual role/settings and volume
   checks, and removal of the temporary restore administrator. Authenticate to the target over
   the normal endpoint and compare the required tables, roles, sequences and committed markers.
   Confirm promotion by writing a new target marker, then obtain a completed base backup and
   archived WAL in the target's own archive. Source credentials must not write those objects.
6. Switch the adopter's connection only after these checks. Once writes reach the target, do not
   switch back to an older source without reconciling those writes.

A deleted source can be restored within its configured retention window. Keep its encrypted
credentials and the corresponding `CREDENTIAL_KEYS` key IDs until that window ends. Expired
archive cleanup is bounded and uses only the exact owned prefix; do not modify archive timestamps
to simulate expiration.

The v1 catalog is limited to 16 pages, 16,000 objects, 64 backup metadata files and 64 KiB per
metadata file. A newer WAL timeline needs a completed base backup on that timeline. Unsupported,
missing or ambiguous coverage is refused rather than creating an empty database.

### Cross-region source access

Complete the target region's node installation and capacity admission first. Before requesting
restore, create the target/source relationship through the authenticated PGCF API described in
[the credential runbook](credentials.md#cross-region-restore-source-credentials). It binds the
source region ID to the exact registered bucket, HTTPS endpoint and supplied bucket-scoped
Object Read Only S3 credential. Cloudflare stores encrypted custody and publishes the source-read
map only to the authenticated target region. Provider IAM read-only permission needs a separate
live check; accepting a credential is not proof of that permission.

The target's write credential, archive identity and temporary administration HMAC remain tied to
the target region. Same-region restore uses its ordinary regional credential and needs no
cross-region relationship.

Use the relationship's expected revision and a stable idempotency key for source-key rotation.
Unfinished referencing restores block rotation; successful restored targets receive a new
desired generation through the existing reconcile path. A missing or drifted entry of the
authoritative desired map fails closed for that source.

Cross-region acceptance requires a real Dev run: verify the source commit markers over the normal
Cloudflare SQL endpoint, promotion, nonsuperuser application access, removal of temporary
administration and a new target backup/WAL archive. Record duration and the last restored commit
in the ULTRA plan; configuration or local checks alone do not establish acceptance. Preserve source
data, archives and physical identities until an explicitly authorized loss drill or cleanup.
A healthy cross-region restore proves archive portability and target recovery; it does not prove
an actual server-loss or outage recovery duration. That separate gate needs an authorized real
failure, the actual restored transaction boundary and measured recovery time.

## Lost node

Node-loss and node-addition endpoints require an admin API key.

1. Read `/v1/operational-health?scope=nodes` and verify the actual node UID. A stale heartbeat
   excludes placement after 180 seconds; it does not automatically authorize a replacement order.
2. Submit `POST /v1/nodes/{id}/mark-lost` with
   `{"expected_node_uid":"<verified UID>","reason":"<short incident description>"}`.
   Loss is terminal and repeated calls preserve the original record. Metadata, archives and
   historical provider receipts remain available. Heartbeats cannot make the node healthy again.
3. Restore affected databases onto available healthy capacity using the separate-target restore
   procedure above. An established database on a lost node must report recovery required.
4. Reinstalling a node uses AddNode in recover mode with the pull installer
   ([plan 9.2](../architecture/cloudflare-convergence-and-serverless-plan.md#92-installing-a-node-on-contabo-no-relay-no-ssh)
   and [9.4](../architecture/cloudflare-convergence-and-serverless-plan.md#94-node-loss-and-recovery)),
   which is built in Stage 3. Until then, recover databases by restore.

## Control plane

Keep a D1 export, the deployment source, private Worker binding configuration, Worker secret
values, agent credentials and routing keyrings together in an encrypted operator backup.
Cloudflare cannot return previously issued secret values. Keep the decryption key outside the
repository and an independent copy outside the machine that created it.

After control loss, restore the export into a separate D1 database, check SQLite integrity and
foreign keys, and verify region/node/credential identity before switching Worker bindings.
Restore secret values without replacing the retained agent identity. Recover PostgreSQL through
R2 into separate targets. Validate SQL and routing before opening traffic.

Restoring a daily D1 export into a scratch D1 database is open as go-live gate G6 of the ULTRA
plan; the daily artifacts have so far only been read back. A cross-region restore into a later
region installs its scoped source-read credential map only after that region is Ready; its
credentials must not alter the source archive.

## Integrator migration

Operator acceptance and customer migration are separate; moving existing databases from another
provider is the integrator's task. Keep the source databases in service until a reviewed
per-database cutover is accepted. Inventory roles, extensions, data/sequences, clients/pooling and
capacity in the integrator's repository, then stop source writes for the actual transfer. Verify
target contents, nonsuperuser roles and TLS through Cloudflare, plus a completed target base backup
and archived WAL, before changing application connections. Retain the source through acceptance;
after target writes, a rollback must reconcile them rather than point clients at stale data. Keep
adapter changes and customer prices outside this generic service.

## Thin storage admission and recovery

Thin storage is enabled per node. Existing thick volumes keep their backend and data. A thin
volume keeps its class, Node UID, volume-group UUID and pool UUID; logical quota growth is
forward-only within the configured finite maximum.

- Room: a start needs a thin pool without error, a storage observation at most 120 s old, free
  data at least the profile's `data_reserve_bytes` and free metadata at least
  `metadata_reserve_bytes`. Without room Cloudflare refuses create, resume, restart, restore and
  wake. Logical quota totals do not reserve extents. `thin_storage_blocked` fires when the pool has
  no room or cannot grow.
- A full pool fails writes at once (`--errorwhenfull y`). PostgreSQL then stops with PANIC and no
  commit is acknowledged without durable WAL. Grow the pool; the next start recovers from WAL.
  Running writers are never stopped for storage.

Thin physical allocation metrics stay null until a real measurement exists; neither a logical
quota nor zero stands in for an unknown measurement. The node agent's full-pool and full-volume
recovery ([plan 4.3](../architecture/cloudflare-convergence-and-serverless-plan.md#43-disk-thin-lvm))
is built in Stage 3.
