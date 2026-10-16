# Operator recovery

The operator deployment uses local PostgreSQL volumes and R2 archives. Loss of a VPS is recovered
from R2; the last recoverable commit depends on the WAL that actually reached R2. There is no
synchronous replica or zero-loss promise. Record both recovery duration and the last restored
commit in `PLAN.md` after each real drill.

## Talos patch recovery

Before patching, retain each node's complete current machine configuration and canonical hash,
an accepted R2 etcd snapshot with its metadata and decryption key, and a working direct Talos
mTLS configuration. Verify the direct node identity independently of the bootstrap relay.

Talos upgrades use an A/B boot scheme that retains the previous kernel and OS image. A failed
boot can fall back to that image. If the Talos API remains reachable, the supported manual
rollback changes the boot reference and reboots the selected node:

```sh
talosctl --talosconfig <working-direct-config> --endpoints <node-ip> --nodes <node-ip> rollback
```

Run recovery only in the approved operator window. An OS rollback does not downgrade Kubernetes
or prove that the earlier machine configuration has been restored. Recheck direct identity,
configuration and database availability before resuming the existing fleet operation. Do not
reinstall, reset or restore etcd merely because a patch has stalled. The procedure's availability
does not attest that a retained node currently has a usable alternate boot slot; record actual
slot observations separately. See the pinned [Talos upgrade and rollback procedure](https://docs.siderolabs.com/talos/v1.14/configure-your-talos-cluster/lifecycle-management/upgrading-talos).

The operator topology is EU only: EU control/relay and customer EU1 (6 vCPU, 12 GB RAM). The US
region is cancelled and US1 is marked lost, as recorded in the canonical ULTRA plan. Never order
a replacement or reinstall an EU node to resume a stalled rollout.

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
desired generation through the existing reconcile path. A missing or drifted entry of the
authoritative desired map fails closed for that source.

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

Restoring a daily D1 export into a scratch D1 database and an etcd snapshot status check are
open in the ULTRA go-live path (backups); the daily artifacts have so far only been read back.
Node check 5 of the ULTRA plan restores an EU1 test database from the EU R2 archive into a
separate target. Verify SQL, recovered markers, recovery duration and the last recoverable
transaction. Keep EU1 healthy throughout the restore and retain its Node, namespace, Cluster,
PVC/PV, role and encrypted custody identities. The topology is the EU control/relay server and
existing customer EU1; it requires no EU1 removal. The earlier destructive loss and cleanup kits
are withheld. A cross-region restore into a later region installs its scoped source-read
credential map only after that region is Ready; its credentials must not alter the source
archive. A later separately authorized incident or loss drill must preserve or recover this same
customer EU1. A regional control-plane loss has no procedure yet (go-live path: recovery).

## Integrator migration

Operator acceptance and customer migration are separate; moving existing databases from another
provider is the integrator's task. Keep the source databases in service until a reviewed
per-database cutover is accepted. Inventory roles, extensions, data/sequences, clients/pooling and
capacity in the integrator's repository, then stop source writes for the actual transfer. Verify
target contents, nonsuperuser roles and TLS through Cloudflare, plus a completed target base backup
and archived WAL, before changing application connections. Retain the source through acceptance;
after target writes, a rollback must reconcile them rather than point clients at stale data. Keep
adapter changes and customer prices outside this generic service.

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
`Idempotency-Key` protects repeated requests. Selection records desired policy and supplies no
qualification; only a Native report changes its `status`. An active Native lease blocks
reselection, and an uncertain dispatched pool action blocks any change to it. The approved
release must pin the exact driver, the storage verifier, the `pgcf-sandbox-controller` host
extension and the `native-gateway` and `native-controller` images on every role. Only the
native controller writes the gateway's write-authority ledger, protection marker and
reclamation proof.
The regional capacity policy accepts an optional `thin_storage` standing template: omission
preserves it, explicit null clears it. Future purchases seal that template before ordering;
customer placement still waits for the actual joined node's qualified physical report.

A retained node is selected in place. A release that pins this guard configures and requires
the `dm_thin_pool` kernel module on every role in its host-configuration stage, before any
receipt exists, so the release's own patch makes the module live. The region release must declare
`thin_storage_sampling_version: 1` and its sampling controllers must have confirmed patches before
selection or qualification is accepted (otherwise HTTP 409). The capability marker stays in
Cloudflare; the desired fleet-release wire view omits it. Composed inventory authorities and
sampling targets are withheld from controllers without this capability. Thin storage also requires the
region capacity policy's `compute_pool`: activation and write authority bind the patch's runtime
admission, which is recorded only while that policy is set. Once the node's current release patch
has completed with its host configuration, a successful PUT starts the Native executor. Its one
lease initializes a missing `pgcf_thinpool` from free volume-group extents only, leaves thick
volumes untouched and never repeats an uncertain dispatched action. The response waits for that
first Native run and reports the resulting `status` and `error_code`. A failed run leaves the
node `blocked` with its `error_code`; after the lease expires, repeat the PUT with the current
`expected_revision` to start one new run. While a dispatched action is uncertain, only the
identical selection is accepted: it keeps the revision and the action, and the new run only reads
the action back. Only the pool that action created or grew, at its target size, confirms it;
otherwise the node is blocked again and the write is not repeated. Without that completed patch
the PUT is refused; select after the sampling controllers converge. No API removes a
selection, and a selected node never takes new thick placements.

The native controller reads exporter headroom every `guard_seconds / 5` and answers a single-use
Cloudflare nonce at `POST /agent/v1/nodes/{id}/storage-headroom`. Cloudflare alone signs authority,
anchored to nonce issue and bounded by the 300-second identity proof. The executor refreshes that
proof every 60 seconds; transient readback races retry with 5–60-second backoff, while uncertain
pool actions stay journaled for readback. A held writer can receive its first token before its IO
limits are measured, but a later identity read without those limits ends both its token and startup
grant. A controller rollback withdraws sampling capability; it never relabels a fast sample as an
inventory proof.

While a thin database's sleep (idle or manual) is under way, the host lease keeps its instance Pod
the running writer: until the sleep's stop operation of that generation leaves pending or running,
the entry is `running` with a write token for that one Pod, and carries no startup grant and no
drain. The Pod is named by the same evidence the running token trusts: the Pod the latest identity
proof measured on the volume or, before a reading has measured it, the held writer (the start's
storage hold plus the controller's attestation); both must agree. The controller stops PostgreSQL
in that Pod; once it reports the sleep the entry becomes `suspended` (a parked Pod keeps its token)
and the guard may freeze the volume the stopped Pod left. Without that evidence or a current
write-allowed reading, or after the stop timed out, the guard freezes the volume and stops the Pod.
Only a deletion still drains. A wake reuses a parked Pod only when the controller's last report
claimed the fast wake and the wake is the generation right after the reported sleep; any other wake
retires the parked Pod and the controller starts a new one.

The first lease of a sleep window or of a fast wake can arrive while the node's authority revision
has not moved since the previous token; the guard then refuses that whole node lease once and keeps
its previous state until the next accepted headroom sample moves the revision. The fast-wake claim
is the controller's last parked report: if the Pod drifts after it and the wake has to start a new
Pod after all, the guard refuses that Pod for the wake's generation until the wake times out and the
next wake bumps the generation.

A release that carries the receipt requires current thin write authority from every member that
takes databases and from every member that already has a selection. Until then that member stays
Pending, its patch storage check repeats and operation-owned placement stays closed. A
control/relay member with database placement disabled and no selection converges without a pool.

Cloudflare admits starts from the **already allocated** pool's actual data and metadata
headroom, verified live write limits and outstanding startup holds. Logical quota totals do
not reserve thin extents. Free space elsewhere in the volume group becomes placeable only
after a bounded pool growth has completed and Native has read back its larger geometry.
Native fails closed with `thin_storage_pool_percent_invalid` when LVM reports an empty or
non-decimal pool data or metadata percentage; an unknown percentage never reads as 0%.
Profiles explicitly configure quotas, IO limits, guard/drain windows and reserves; they have
no unbounded or guessed defaults. Thin starts require the region's actual-RAM policy.

The existing startup ledger captures both the full RAM peak and the bounded storage debit.
A thin start temporarily debits the greater of its configured startup reserve and current logical
quota until actual Ready, later RAM and Native LV/Pod IO-limit proof cover it. This bounds uncapped
startup writes and dirty writeback; established or sleeping databases do not permanently debit
that quota. Mapping headroom includes these in-flight bytes and established writers' bounded
64KiB chunk exposure. These holds reserve admission runway; they do not preallocate extents.
The RAM peak includes PostgreSQL, the Barman limit and one assigned host allowance. Idle
prestarted-slot memory is already present in actual Node measurements and is not subtracted again. Permission
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

### Thin storage qualification run

A release's `thin_storage_qualification` receipt comes only from a completed qualification run.
`PUT /v1/fleet/releases/{id}` refuses a receipt unless a completed run has the same `receipt_sha256`,
`profile_sha256`, `driver_image`, `host_extension_image`, `kernel_version` and `qualified_at`.
Hand-typed gate flags are never accepted.

The run is scratch-first. It creates `pgcf_thinpool` from free extents with the product `lvcreate`
command and the exact profile geometry. All gates run in the fenced namespace `pgcf-thin-q-<run>`
(deny-all NetworkPolicy, ResourceQuota, restricted Pod security) on the scratch StorageClass and VAC
`pgcf-thin-q-<run>`. These carry the product class parameters. Afterwards the run removes every
scratch object, LV, the pool and a pool metadata spare that did not exist before. It never writes a
`node_thin_storage` row, and thin selection on that node is refused until the run ends.

**Preconditions**
- The node is a ready customer node with fresh observations. Never use the control node.
- The node has no thin selection. A selected node is refused, and a selection cannot be removed.
- Database placement on the node is disabled (`PUT /v1/nodes/{id}/database-placement`) from before
  the start until the run ends. Thick placement does not count the scratch pool, and a new database
  would change the retained baseline. Re-enabling placement during the run ends the measurements;
  cleanup still runs. Re-enable placement after the run.
- The region compute pool is on (`compute_pool` in `PUT /v1/regions/{id}/capacity-policy`). Thin
  storage depends on its runtime admission fact.
- The assigned region release pins the thin guard: digest-pinned `native-gateway`,
  `native-controller`, thin-tools `openebs-lvm` and `pgcf-sandbox-controller` images. Every role
  requires host configuration, carries the `pgcf-sandbox-controller` extension and runs
  `native-gateway`, `native-controller` and `openebs-lvm`. The release also pins `postgres`. The
  storage authority keys equal the current signer keys. `dm_thin_pool` is live.
- The VG has only the retained linear LVs. Free extents cover the profile maximum, twice its metadata
  and its VG reserve, plus 16 GiB for the metadata scratch pool. Each fill claim must exceed the pool
  it fills by one seventh within the room the scheduler counts for a thin claim, or the run fails
  with `thin_qualification_fill_room_insufficient`. That room is the free extents above the pool,
  twice its metadata and the VG reserve; the full-pool fill also counts the free data of the
  maximum pool.
- The profile can grow (`initial_data_bytes` < `maximum_data_bytes`) and has at most 256 volumes.
- One NodeBootstrap container slot is free. Run it outside a fleet patch or rollout.

**Start and observe**
1. `POST /v1/nodes/{id}/thin-qualifications` with an `Idempotency-Key` and
   `{ "node_uid", "address", "profile" }`. `address` is the node's literal Talos address. `profile`
   is the complete finite profile the release will carry.
2. A Workflow drives one durable step per gate through the bootstrap container and relay. Every
   mutating action is checkpointed in D1 before dispatch. An interrupted write is resolved by readback
   or ends the run; it is never repeated.
3. `GET /v1/thin-qualifications/{id}` returns status, step, the measured evidence per gate and the
   decision Cloudflare computed from it.
4. A run that stops progressing, for example after a failed Workflow start (a `500` after the run was
   committed) or a stopped instance, continues with `POST /v1/thin-qualifications/{id}/resume`. A
   start refused because a run is already running names that run in `details.run_id`.
5. `POST /v1/thin-qualifications/{id}/cancel` ends the measurements with
   `thin_qualification_cancelled`. Cleanup still runs; the run then fails without a receipt.

The run never reboots the node. The six live checks verify pool and thin volume activation after a
boot at the next reboot a fleet patch orchestrates: the R2b `talos_reboot` or `host_service` stage.

Suspend the node's databases (`POST /v1/databases/{id}/suspend`) before the start and resume them
once the run is terminal. Until then, create, restore or delete no database in the node's region.
`retained_thick_preservation` and cleanup compare the retained thick volumes, claims and CNPG
clusters with the setup baseline, so such a change fails the run.

| Gate | What the run does | Pass criterion (computed by code) |
| --- | --- | --- |
| `data_full` | Commits a marker and acknowledged inserts, fills the pool with direct writes, probes an unmapped thin LV, grows the pool with the product `lvextend`, restarts PostgreSQL on the same PVC | Pool `out_of_data_space` with `error_if_no_space` at 100%; fill and probe end with ENOSPC/EIO, the probe within `drain_seconds`; same pool and LV UUIDs; `rw` after growth to `min(maximum, initial + growth)`; marker and every acknowledged commit present after crash recovery |
| `metadata_full` | A separate pool below the profile metadata floor is exhausted, deactivated, checked (`thin_check`), repaired (`lvconvert --repair`) and reactivated; then the profile pool at its maximum is filled across `maximum_volumes` thin LVs | Scratch pool `ro`/`fail` with no new chunks after exhaustion; data verifies after repair or activation is refused; maximum pool full with metadata use at most `metadata_bytes - metadata_reserve_bytes` |
| `noflush_quiescence` | `dmsetup suspend --noflush --nolockfs` of a buffered writer's LV, then resume as drain; the same suspension on a full pool | Dirty pages present; suspended state; no new sectors or chunks while suspended; drain at most max(startup reserve, quota) within `drain_seconds`; clean `e2fsck`; suspension confirmed on a full pool; an accepted fast sample wholly inside the suspended window |
| `resume_marker` | Commits a marker, starts a long uncommitted INSERT, suspends the exact LV, kills the Pod, verifies the thin table identity, resumes and restarts on the same PVC | Marker present, uncommitted rows absent, same LV and pool; the resume target's DM UUID and thin-pool device are verified before resume |
| `startup_bound` | Cold start on a fresh PVC (mkfs, initdb, bulk load), Pod `io.max`, direct-write rates at the VAC limits, one product-equivalent Native readback | Mapped growth at most max(startup reserve, quota); every ext4 group `ITABLE_ZEROED`; finite `io.max` at most the profile; measured rates within 10% of the limits; identity readback turn under 60 s; longest accepted fast-sample interval during the bulk load below `guard_seconds / 2` |
| `trim_delete_recreate` | Writes a raw volume, deletes its PVC/PV/LV, deletes the last thin LV, re-initializes the pool with the product command if the driver removed it, recreates a volume of the same size | LV gone from `lvs -a` and DM; pool usage back to baseline; re-initialized pool has a new UUID; recreated LV reads back only zeros |
| `retained_thick_preservation` | Compares the retained thick LVs, PVs/PVCs, LVMVolumes and CNPG `Ready`/`ContinuousArchiving` with the setup baseline | All identical and no thin-profile database on the node |

`trim_delete_recreate` qualifies extent return on LV and PVC deletion. The thin class has no
in-filesystem discard. A resume through the Cloudflare host guard, including refusal of a changed LV
identity and of an expired token, is verified after activation by the six live checks.

**Failure and cleanup**
- A failed gate or executor error records its code and moves straight to cleanup.
- The `noflush_quiescence` drain names its failure. An exec that did not run the command is
  repeated, at most three times and only while the writer Pod runs. Every other failure is final:
  `thin_qualification_drain_sync_failed` (`sync -f` ran and returned non-zero),
  `thin_qualification_writer_not_running` (the Pod no longer ran when its exec failed) and
  `thin_qualification_drain_exec_failed` (three execs against a running Pod did not run the
  command). The `noflush_quiescence:resume` journal entry holds each attempt's exit codes, the last
  200 characters of its stderr and the Pod's phase and termination reason. The writer dirties at
  most 512 MiB, half of its Pod's memory limit.
- A turn whose executor stops answering keeps its lease until the lease expires. The Workflow waits
  for that lease before the next turn or a step deadline, so cleanup still gets all its turns.
- Cleanup resumes any suspended scratch LV and removes everything the run created, also after a
  reboot or a kernel, driver or host extension change. It reports absence, the LV inventory and VG
  free space against the baseline.
- A failed run keeps its first error code. If its `cleanup` is null or unverified
  (`thin_qualification_cleanup_incomplete`), remove the remaining objects by hand. They are:
  namespace `pgcf-thin-q-<run>`, the StorageClass and VAC of the same name, LVs tagged
  `pgcf.thin-q.<run id>` or named `pgcf_thin_q_<run>*`, and a `pgcf_thinpool` whose
  `pgcf.action.<nonce>` tag matches the run journal.

**Receipt into a release (R2b)**
1. Copy `qualification` from the completed run.
2. Approve a copy of the qualified release spec with that object as `thin_storage_qualification`
   under a new release id. Releases are immutable.
3. Set the region `thin_storage` template to the byte-identical profile.
4. Select the profile on the node with `allow_new_databases:false`. Roll out the new release as a
   successor, then activate placement.
5. `kernel_version` is the exact `nodeInfo.kernelVersion`. `profile_sha256` is the full-profile hash,
   not the class hash. Each new Talos kernel, driver or host extension needs a new run.

**Requalification after R2b (open owner decision)**
A new run needs a customer node without a thin selection. R2b selected EU1, so EU has no such node:
the selection cannot be removed, the control node is excluded and AddNode selects thin storage on
every new node. A later release that changes the Talos kernel, `openebs-lvm` or
`pgcf-sandbox-controller` then cannot obtain a receipt, and its patch leaves EU1 waiting in the
storage stage without thin write authority. Do not roll out such a release before the owner decides
how to requalify. A run also needs the node's release to equal the
region release, so a requalification first rolls out a receipt-less candidate release. Selected
nodes have no thin write authority until the successor with the new receipt is rolled out; the
decision must accept or avoid that outage. Options:
- Qualify on the control node, which has placement disabled and no selection. This puts scratch
  writes on the relay host and needs free extents in its VG.
- Allow a run on a selected node that holds no thin volumes, using a distinct scratch pool name.


## Parked sleep tier

The parked tier is implemented ([design](../architecture/parked-instances.md)); its live
acceptance is open in the ULTRA go-live path. With the region policy `parked_tier` enabled
(`PUT /v1/regions/{id}/capacity-policy`), an idle sleep fences the database's single CNPG
instance instead of hibernating the Cluster: only PostgreSQL stops, while the instance Pod, its
volume, the Barman sidecar and the primary Lease stay and the Pod's requests shrink in place. The
sleep proof (quiesce, archived WAL segment) is unchanged, so every acknowledged commit is in R2
before the fence. The public state stays `hibernated`; the next connection unfences the Pod and
resizes it back instead of creating a new one.

The native controller demotes a parked database to full hibernation when `ttl_seconds` passes,
when the node holds more than `max_per_node` parked databases (the oldest first), when the policy
is switched off (`enabled:false`) or removed (`null`), and when anything changed since parking:
the fleet release, the node boot, the Pod or container identity, or the desired spec (a resize, a
role change or a password reset). A manual suspend demotes it; a delete follows the ordinary
delete flow. A wake that is not eligible for the fast path demotes first and takes the ordinary
CNPG wake. No writer exists while a Pod is fenced.

## Optional warm reclaim

Warm reclaim is implemented in the API and the host publisher but inactive on the live fleet: no
node is qualified and no database carries a policy, so every idle database takes the sleep path
above. The node reclaimer binary was deleted (2026-10-15) and no node can execute reclaim.

The default idle path remains Pod-cold hibernation. Administrators explicitly configure a database
with `GET`/`PUT /v1/databases/{id}/warm-reclaim` (`expected_revision`, `expected_generation`, and a
nullable policy containing only idle seconds, episode budget and step bytes). PostgreSQL CPU/RAM
ceilings continue to come from its effective resource policy. Warm idle retains the same running
Pod, PostgreSQL, Barman and their active CPU accounting.

`GET`/`PUT /v1/nodes/{id}/warm-reclaim-qualification` records an independently accepted isolated
worker proof bound to the current Node UID, boot, sealed cluster/material and selected release.
A control-plane node, missing qualification, a release without a `node-reclaimer` image component or
a stale/mismatched runtime proof cannot issue reclaim.
No retained node is implicitly qualified by deploying this source. The approved
isolated-worker and actual encrypted-swap acceptance remain required before any live trial.

The protected host publisher uses the existing regional identity to fetch
`GET /agent/v1/nodes/{id}/reclaim` and post bounded observations to
`POST /agent/v1/nodes/{id}/reclaim-observations`. It publishes a two-second envelope of CF-signed,
five-second maximum rc1 scopes. A poll with nothing to deliver, the 404 of a node without a
qualification included, is answered 3.5 s after it arrived (the host's client gives up after 5 s),
so an idle node polls about every 3.75 s; a Worker isolate remembers a node's missing
qualification for 5 s, and a new one reaches the node within about 9 s. A consumer receives public
verification keys and local identity
snapshots; it receives no CF write credential, PostgreSQL credential or CRI socket. The node
reclaimer that consumed them was deleted on 2026-10-15 and no replacement exists, so the scopes are
published but nothing executes them.

The Actor persists one idle episode with its own revision. Renewal cannot replenish its budget
or change its runtime scope. Before a connection uses the warm route, the Actor persists a higher
revoked revision and waits for its exact same-runtime revoked acknowledgement, or for the last
issued reclaim lease plus clock skew to expire. A lost reply, signer failure or Actor eviction
keeps this barrier closed. An already-running bounded kernel call may finish after the revoke
acknowledgement; no further step can be scheduled. Admission still reads current authoritative
state and never treats a reclaim result as hibernation, CPU release or permission to replay SQL.

The local authority tests do not establish swap safety, reclaimed-memory savings or first-read
performance on the retained fleet.
