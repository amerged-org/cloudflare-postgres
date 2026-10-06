# Operator recovery

The operator deployment uses local PostgreSQL volumes and R2 archives. Loss of a VPS is recovered
from R2; the last recoverable commit depends on the WAL that actually reached R2. There is no
synchronous replica or zero-loss promise. Record both recovery duration and the last restored
commit in `PLAN.md` after each real drill.

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
the restore, install the private source-read map described in
[the credential runbook](credentials.md#cross-region-restore-source-credentials) in the target
regional cluster. It binds the source region ID to the exact source bucket, HTTPS endpoint and
bucket-scoped read-only S3 credential. The management API keeps no S3 credential map; its source
catalog reads use the source region's R2 binding.

The agent creates a separate `recovery-source-credentials` Secret in the target database namespace
and a recovery-source ObjectStore for the original archive. The target's `pgcf-backup-s3` write
credential, archive identity and temporary administration HMAC remain tied to the target region.
Database egress allows HTTPS only to the exact configured source and target R2 endpoint hosts,
alongside the existing DNS and Kubernetes API rules. Do not widen egress to arbitrary R2 hosts.
The default same-region restore needs no cross-region source map.

Cross-region acceptance requires a real Dev run: verify the source commit markers over the normal
Cloudflare SQL endpoint, promotion, nonsuperuser application access, removal of temporary
administration and a new target backup/WAL archive. Record duration and the last restored commit
in `PLAN.md`; configuration or local checks alone do not establish acceptance. Preserve source
data, archives and physical identities until an explicitly authorized loss drill or cleanup.

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
   the [reviewed bootstrap procedure](operator-installation.md#existing-eu-worker-and-new-us-region)
   with the new identity and `spec.role:"worker"`; repeating the same recovery request and key
   returns the same addition. An uncertain response does not authorize another operation or an
   automatic reinstall. Current recovery supports a worker joining a surviving regional cluster;
   it does not rebuild a lost regional control plane.
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
recorded in `PLAN.md`. The current completion drill installs and admits US1, then fences the exact
EU2 worker and restores its disposable source from the EU R2 archive into a separate US1 target.
Verify SQL, recovered markers, recovery duration and the last recoverable transaction. Admit the
new EU customer worker into the retained EU cluster before retiring the old EU2; the final
topology retains the EU control/relay server, new EU customer worker and US1. Old EU2 cleanup
requires authenticated physical absence of the exact old LV identities, as described above;
provider cancellation or Kubernetes metadata removal alone is insufficient. Keep the source
healthy until US1 is Ready and the scoped source-read credential map is installed.
A complete regional control-plane loss drill remains outside this customer-free completion gate.
