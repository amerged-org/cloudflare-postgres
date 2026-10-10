# Operator recovery

The operator deployment uses local PostgreSQL volumes and R2 archives. Loss of a VPS is recovered
from R2; the last recoverable commit depends on the WAL that actually reached R2. There is no
synchronous replica or zero-loss promise. Record both recovery duration and the last restored
commit in `PLAN.md` after each real drill.

The current operator topology retains the EU control/relay server and already-admitted customer
EU1 (formerly EU2), and adds one US1 using the same V159 / Cloud VPS Plus 4 model: 4 vCPU, 8 GiB
RAM and 150 GiB NVMe, with a one-month term. US1 is provider Running but still needs installation
and admission. Current completion first restores from the healthy EU1 source into a separate
US1 target. Do not reset, re-adopt, fence, delete or decommission EU1 for this drill; the earlier
loss and deletion kits are withheld. The incident procedures below apply to an actual loss or
a separately reviewed drill that preserves or recovers the same customer EU1.
US1's profile, binding and reported inspection are already retained; its original authorized job
is still `created`, with installation and Ready acceptance outstanding. Continue the same
Cloudflare addition/Workflow and seals rather than ordering, re-adopting or resetting that VPS.

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

Complete the target region's ordinary bootstrap and capacity admission first. Before requesting
restore, create the target/source relationship through the authenticated PGCF API described in
[the credential runbook](credentials.md#cross-region-restore-source-credentials). It binds the
source region ID to the exact registered bucket, HTTPS endpoint and supplied bucket-scoped
Object Read Only S3 credential. Cloudflare stores encrypted custody and publishes the source-read
map only to the authenticated target region. Provider IAM read-only permission needs a separate
live check; accepting a credential is not proof of that permission.

The existing regional reconciler creates a separate `recovery-source-credentials` Secret in the
target database namespace and a recovery-source ObjectStore for the original archive. The
target's `pgcf-backup-s3` write credential, archive identity and temporary administration HMAC
remain tied to the target region. Database egress allows HTTPS only to the exact configured
source and target R2 endpoint hosts, alongside the existing DNS and Kubernetes API rules.
Do not widen egress to arbitrary R2 hosts. Same-region restore uses its ordinary regional
credential and needs no cross-region relationship.

Use the relationship's expected revision and a stable idempotency key for source-key rotation.
Unfinished referencing restores block rotation; successful restored targets receive a new
desired generation through the existing reconcile path. An authoritative desired map never
falls back to the old manual map when an entry is missing or drifted. The manual map remains
compatible only while the API field is absent during a consumer-first rollout.

Cross-region acceptance requires a real Dev run: verify the source commit markers over the normal
Cloudflare SQL endpoint, promotion, nonsuperuser application access, removal of temporary
administration and a new target backup/WAL archive. Record duration and the last restored commit
in `PLAN.md`; configuration or local checks alone do not establish acceptance. Preserve source
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
   procedure above. A missing namespace for an established database must report recovery required.
4. To reinstall the same provider instance, verify its provider ID, the lost predecessor's node ID
   and original Kubernetes UID, and the surviving regional cluster. Submit
   `POST /v1/nodes/additions` using an admin API key and a persistent `Idempotency-Key`:

   ```json
   {
     "region_id": "<original region>",
     "mode": "recover",
     "provider_instance_id": "<verified provider instance ID>",
     "predecessor_node_id": "<lost node ID>",
     "expected_node_uid": "<original verified UID>"
   }
   ```

   Recovery reserves a new node, addition operation and bootstrap identity. It retains the lost
   predecessor tombstone, provider receipts and encrypted custody records. Ordinary `mode:"adopt"`
   still refuses reuse of a historical provider instance; do not erase identity to bypass that guard.
5. Save the new node and operation IDs and poll `GET /v1/nodes/additions/{operation-id}`. Continue
   the [reviewed bootstrap procedure](operator-installation.md#programmed-installation-path)
   with the new identity and `spec.role:"worker"`; repeating the same recovery request and key
   returns the same addition. An uncertain response does not authorize another operation or an
   automatic reinstall. Current recovery supports a worker joining a surviving regional cluster;
   it does not rebuild a lost regional control plane.
   Keep provider verification at the recovery lifecycle and before the first destructive write.
   The Cloudflare-stored source association survives proof renewals with fresh scoped claims;
   Kubernetes/Talos reads, grants and exact owned cleanup make no per-command provider calls.
   Current CF authority and actual host-key/TLS, Cluster UID and Node UID checks remain required.
   Resolve unknown provider/native mutation outcomes by readback, preserving their original intent.
6. Keep the lost server isolated until bootstrap verification, database restoration and SQL data
   comparison finish. Open traffic only after the new worker passes network/capacity verification
   and restored database targets pass the checks above.

### Remove the lost worker's Kubernetes identity before reinstall

The native installer creates a new hostname and Node UID. The operator removes the old worker
identity before starting rescue or installation; the installer does not delete Kubernetes Nodes.

1. Stop and fence the exact provider instance. Confirm the surviving cluster's `kube-system` UID
   against its retained join custody. Match the old Node name, UID and `pgcf.io/node-id` /
   `pgcf.io/provider-instance-id` labels to the terminal D1 loss record. Save the current Node,
   CiliumNode, OpenEBS LVMNode and source Cluster/PVC/PV identities privately.
   Before a planned loss drill, also record every source PV/claim UID, CSI volume handle,
   LVMVolume UID and the actual LV and volume-group UUIDs from an authenticated physical LVM
   inventory on that provider. Keep this inventory alongside the regional deletion ledger.
2. Read the Node immediately before removal. Send `DELETE /api/v1/nodes/{old-hostname}` through
   the authenticated Kubernetes API with this body, using the just-read resource version:

   ```json
   {
     "apiVersion": "v1",
     "kind": "DeleteOptions",
     "preconditions": {
       "uid": "<lost Kubernetes Node UID>",
       "resourceVersion": "<just-read Node resource version>"
     }
   }
   ```

3. Resolve a lost response through authenticated readback. Continue only when the old hostname
   is absent. Wait for the controllers to remove its CiliumNode and LVMNode; verify their absence
   too. If an old CR remains, inspect its saved UID, resource version and exact ownership by the
   deleted Node. Remove only that verified CR with its own UID/version preconditions; stop on a
   foreign or ambiguous identity.
4. Preserve the source CNPG Cluster, PVCs and PVs, including their old node affinity. Keep D1
   loss/addition records, archives and credential custody. Start the new recovery operation's
   rescue/install steps only after the old network/storage node identities are absent. Verify the
   new hostname, Node UID, volume-group identity and measured storage before admitting capacity.
   Restore database contents through the separate-target API procedure above.

### Verify physical storage reclamation after worker loss

Pinned OpenEBS LVM LocalPV 1.10.1 can remove a missing node's volume finalizers without deleting
its physical LV. The bootstrap installer writes its verified image extent and GPT; that does not
prove that every old LVM extent or volume disappeared. Kubernetes Namespace/PV/LVMVolume absence
is therefore insufficient evidence of reclaimed storage after a node loss.

Before accepting lost-source cleanup, obtain a fresh, authenticated physical LVM inventory on the
exact recovered provider and verify the relevant original and current volume-group identities.
Match it against the privately retained source handles and actual LV UUIDs. Every recorded old LV
must be absent, with measured storage confirming the reclaimed capacity. Keep the original
placement and deletion-ledger identities throughout this check. A partial inventory, unavailable
original identity or missing physical observation remains an unverified reclamation result.

If an exact recorded old LV persists, stop cleanup acceptance and reclaim only that owned LV
through an authenticated operation guarded by its provider, volume-group UUID and LV UUID, then
read back actual absence and capacity. Preserve unrelated LVs and retained R2 archives. Removing
finalizers or deleting a Kubernetes record cannot substitute for this physical proof, and missing
metadata never means zero physical storage use.

## Control plane and regional infrastructure

Keep a D1 export, the deployment source and immutable image digests, private Worker binding
configuration, Worker secret values, regional agent credentials, routing keyrings and encrypted
Talos/join custody together in an encrypted operator backup. Cloudflare cannot return previously
issued secret values. Keep the decryption key outside the repository and an independent copy
outside the machine that created it.

After control loss, restore the export into a separate D1 database, check SQLite integrity and
foreign keys, and verify region/node/credential identity before switching Worker bindings.
Restore secret values without replacing the retained agent identity. Reapply the reviewed
Cloudflare and regional configuration using immutable images. Rebuild platform resources only
on verified replacement infrastructure; recover PostgreSQL through R2 into separate targets.
An etcd snapshot helps recover Kubernetes configuration, but it does not recreate lost local
PostgreSQL volumes. Validate SQL and routing before opening traffic.

The D1 export/local restore rehearsal and API full restore/PITR/deleted-source acceptance are
recorded in `PLAN.md`. The current completion drill installs and admits US1, then restores the
customer EU1 test source from the EU R2 archive into a separate US1 target.
Verify SQL, recovered markers, recovery duration and the last recoverable transaction. Keep EU1
healthy throughout the restore and retain its Node, namespace, Cluster, PVC/PV, role and encrypted
custody identities. The final topology retains the EU control/relay server, existing customer EU1
and new US1; it requires no new EU worker or EU1 removal. The earlier destructive loss and cleanup
kits are withheld. Install the scoped source-read credential map only after US1 is Ready; its
credentials must not alter the EU source archive. A later separately authorized incident or
loss drill must preserve or recover this same customer EU1.
A complete regional control-plane loss drill remains outside this customer-free completion gate.

## Later adopter migration

Operator acceptance and customer migration are separate. Keep existing Neon databases in service
until a reviewed per-database cutover is accepted. Inventory roles, extensions, data/sequences,
clients/pooling and capacity in the adopter repository, then stop source writes for the actual
transfer. Verify target contents, nonsuperuser roles and TLS through Cloudflare, plus a completed
target base backup and archived WAL, before changing application connections. Retain the Neon
source through acceptance; after target writes, a rollback must reconcile them rather than point
clients at stale data. Keep adapter changes and customer prices outside this generic service.

## Thin storage admission and protective recovery

Thin storage is enabled explicitly per node only after the selected driver, fixed pool and
host expiry guard have passed qualification. An unqualified, stale or identity-mismatched
selection stays closed; it never silently falls back to thick provisioning. Customer activation
requires the immutable selected release's complete-profile qualification receipt, including
dirty-writeback and full-pool acceptance; driver-only readiness cannot enable placement. No such
live receipt is inferred from local tests. Existing thick volumes keep their backend and data.
A selected thin volume keeps its immutable class,
profile hash, Node UID, volume-group UUID and pool UUID; logical quota growth is forward-only
within the configured finite maximum.

Administrators read or CAS-select a profile with `GET`/`PUT /v1/nodes/{id}/storage-profile`.
PUT includes `expected_revision`, the physical `node_uid`, literal management `address`,
`volume_group_uuid`, the complete finite `profile` and `allow_new_databases:false`.
`Idempotency-Key` protects repeated requests. Selection records desired policy; it neither
acknowledges a physical mutation nor supplies qualification. An active or uncertain Native pool
action blocks reselection. The approved release must pin the exact driver and storage verifier.
The regional capacity policy accepts an optional `thin_storage` standing template: omission
preserves it, explicit null clears it. Future purchases seal that template before ordering;
customer placement still waits for the actual joined node's qualified physical report.

Cloudflare admits starts from the **already allocated** pool's actual data and metadata
headroom, verified live write limits and outstanding startup holds. Logical quota totals do
not reserve thin extents. Free space elsewhere in the volume group becomes placeable only
after a bounded pool growth has completed and Native has read back its larger geometry.
Profiles explicitly configure quotas, IO limits, guard/drain windows and reserves; they have
no unbounded or guessed defaults. Thin starts require the region's actual-RAM policy.

The existing startup ledger captures both the full RAM peak and the bounded storage debit.
A thin start temporarily debits the greater of its configured startup reserve and current logical
quota until actual Ready, later RAM and Native LV/Pod IO-limit proof cover it. This bounds uncapped
startup writes and dirty writeback; established or sleeping databases do not permanently debit
that quota. Mapping headroom includes these in-flight bytes and established writers' bounded
64KiB chunk exposure. These holds reserve admission runway; they do not preallocate extents.
The RAM peak includes PostgreSQL, the Barman limit and one assigned host allowance. Idle pool
memory is already present in actual Node measurements and is not subtracted again. Permission
expiry and an operation timeout do not release uncertain capacity. Accepted readiness or a
verified stopped runtime must be followed by later bound RAM and Native physical observations
before their holds are released.

When the host guard protects a running database, Native proves the bound Cluster is hibernated
and its Pods are absent. Cloudflare keeps the running intent and records that exact generation
and prior operation. A stale same-generation Regional Ready report cannot overwrite this
stop. Once current Node, RAM, CPU and physical storage checks permit it, the normal capacity
turn issues one real resume operation and advances the generation. Manual suspension,
deletion and a newer intent take precedence. No application SQL is replayed.

A thin deletion stays pending until a fresh Native read after the delete intent proves the
retained actual LV UUID absent from both physical and active inventories. An ordinary Regional
deleted report cannot supply that proof. Database deletion and the configured R2 archive
retention remain separate operations. Thin physical allocation metrics stay null until a real
measurement exists; neither a logical quota nor zero stands in for an unknown measurement.

See the ULTRA plan for the selected source, qualified images and completed live checks. Local
D1 and Workerd tests alone do not activate this feature or establish live storage acceptance.


## Optional warm reclaim

The default idle path remains Pod-cold hibernation. Administrators explicitly configure a database
with `GET`/`PUT /v1/databases/{id}/warm-reclaim` (`expected_revision`, `expected_generation`, and a
nullable policy containing only idle seconds, episode budget and step bytes). PostgreSQL CPU/RAM
ceilings continue to come from its effective resource policy. Warm idle retains the same running
Pod, PostgreSQL, Barman and their active CPU accounting; it does not count as a shared-pool hit.

`GET`/`PUT /v1/nodes/{id}/warm-reclaim-qualification` records an independently accepted isolated
worker proof bound to the current Node UID, boot, sealed cluster/material and selected release.
A control-plane node, missing qualification or stale/mismatched runtime proof cannot issue reclaim.
None of the three retained nodes is implicitly qualified by deploying this source. The approved
isolated-worker and actual encrypted-swap acceptance remain required before any live trial.

The protected host publisher uses the existing regional identity to fetch
`GET /agent/v1/nodes/{id}/reclaim` and post bounded observations to
`POST /agent/v1/nodes/{id}/reclaim-observations`. It publishes a two-second envelope of CF-signed,
five-second maximum rc1 scopes. The unprivileged reclaimer receives public verification keys and
local identity snapshots; it receives no CF write credential, PostgreSQL credential or CRI socket.

The Actor persists one idle episode with its own revision. Renewal cannot replenish its budget
or change its runtime scope. Before a connection uses the warm route, the Actor persists a higher
revoked revision and waits for its exact same-runtime revoked acknowledgement, or for the last
issued reclaim lease plus clock skew to expire. A lost reply, signer failure or Actor eviction
keeps this barrier closed. An already-running bounded kernel call may finish after the revoke
acknowledgement; no further step can be scheduled. Admission still reads current authoritative
state and never treats a reclaim result as hibernation, CPU release or permission to replay SQL.

See PLAN.md for actual deployment and kernel acceptance. The local authority tests do not establish
swap safety, reclaimed-memory savings or first-read performance on the retained fleet.
