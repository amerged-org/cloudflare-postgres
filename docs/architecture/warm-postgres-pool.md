# Warm PostgreSQL pool

Status: **alternative 8 approved on 2026-10-12; implementation and live acceptance remain open.**
The owner reaffirmed the sleeping-database first SQL below one second as the primary product
goal on 2026-10-13. The detailed alternative 8 design below governs the ULTRA rows "Sub-second
decision" and "Pool cold-start test". Earlier proposal and fallback sections remain design context.

Citations: repository `path:line` refer to origin/main 05489c8. `rt` is
[rust-runtime-and-cold-starts.md](rust-runtime-and-cold-starts.md), `plan` is
[cloudflare-convergence-and-serverless-plan.md](cloudflare-convergence-and-serverless-plan.md),
`sc/` is `apps/sandbox-controller/src/`, `nc/` is `apps/native-controller/src/` and `actor` is
`apps/api/src/database-actor.ts`. Upstream sources [U1]–[U24] are listed at the end; they are pinned
to the deployed CNPG 1.30.1, plugin-barman-cloud 0.15.1, Kubernetes 1.36.5, containerd 2.3.6,
OpenEBS LVM LocalPV 1.10.1 and PostgreSQL 18.6.

**Keep X Pods ready and hang a database into one?** Not at Pod level. A Pod's volumes, environment
and ServiceAccount are fixed when it is created [U1]. CNPG runs only Pods it creates from the
Cluster, resumes hibernation by creating a new Pod [U2], and CNPG-I has no attach or rebind call
(rt:131-143). No design can start the postmaster before its data directory is attached either,
because PostgreSQL fixes the data directory at server start [U24]; Neon's pooled computes likewise
wait empty and start `postgres` only after they receive a spec [U3]. Neon can
give any database any compute because its storage is remote (rt:63-68, rt:103-106); a PGCF database
lives on one node's local volume, so slots are per node and Kubernetes must mount that volume.

What works is a ready unit *below* the Pod: X tenant-free slots per node (R2,
`PUT /v1/nodes/{id}/compute-pool`, `target_slots` 0–16; packages/contracts/src/compute-pool.ts:26-40).
This proposal lets a claimed slot start PostgreSQL on the woken database's own volume as soon as
kubelet has mounted it, ahead of CNPG's in-Pod startup chain; CNPG then adopts the running server.
Detaching after 1–15 idle minutes is the existing `sleep_after_seconds` (60–900 s). Whether a hit
reaches the required first SQL below one second is unproven and doubtful while CNPG creates a Pod
on every wake (§2). Gate 0 (§11) settles that before the slot runner is built.

## Owner direction (2026-10-12)

The owner asked for prestarted PostgreSQL in warm Pods: X ready per node, a database bound on
connect and detached after the idle setting. Only rejected alternative 8 removes Pod creation from
a wake, so it is the recommended target; the early-postmaster runner of §3 stays the CNPG-owned
fallback. Alternative 8 changes the CNPG-ownership constraint (rt:122) for the awake period only:
CNPG keeps creation, restore and point-in-time recovery, the hibernated Cluster and its PVC, while
PGCF supervises the running server in the pool Pod, as Neon's `compute_ctl` does for its computes
[U3]. Its own design settles WAL archiving, base backups, the single-writer authority between the
hibernated Cluster and the pool Pod, TLS and credential custody, and network identity through
late-bound Pod labels. The approved orchestration work (rt §6, §9, §10) and Gate 0 (§11) come
first, because every wake needs them.

## Alternative 8 detailed design

**Owner decision (2026-10-12): alternative 8 is approved.** Per node, X pre-warmed pool Pods run
a PGCF supervisor, as Neon's `compute_ctl` does [U3]. On connect the database's local LVM volume is
attached into a pool Pod, `postgres` starts on it, and late-set Pod labels record the tenant.
After `sleep_after_seconds` (60–900 s) of idleness the database is detached again. CNPG's
ownership of the running process is waived for the awake phase only; CNPG keeps creation,
restore and point-in-time recovery, the hibernated Cluster and the PVC. The target is a first SQL
after wake below one second, measured through Cloudflare, against the EU1 baseline of §2: first
SQL after wake 9.6–11.2 s, Pod Ready 4.9–6.6 s, orchestration after Ready 4–5 s, awake path
alone 0.69–0.93 s.

Repository citations in this section refer to origin/main dc635b2; `gw/` is
`apps/native-gateway/src/`. Sources [U25]–[U53] extend the list at the end; besides the pins
above they are pinned to Talos 1.14.2, Cilium 1.20.2, Linux 6.18.54 (the kernel of Talos 1.14.2
[U40]), lib-csi 0.9.0, the barman-cloud library 0.6.0 and Barman 3.20.1. Where this section and
the summary of alternative 8 in §12 differ, this section applies. Nothing here is implemented or
measured on EU1; statements marked *unproven* need the live proof of A8.7.

### A8.0 Parts, holder invariant and eligibility

| Part | Responsibility |
| --- | --- |
| Pool Pod, namespace `pgcf-pool` | Pre-created and tenant-free; X per node, the node policy's `target_slots`, with idle requests inside the policy's idle budget (packages/contracts/src/compute-pool.ts:26-51). Container `postgres` (pinned PostgreSQL image) runs `pgcf-supervisor` as PID 1; container `archiver` runs the pinned plugin-barman-cloud sidecar image unmodified, with Barman 3.20.1 [U47]. An init container copies the static supervisor from the PGCF image into a memory emptyDir, as CNPG's init container copies its manager [U44]. A pool Pod serves one binding and is then deleted (rt:93-96). |
| `pgcf-supervisor` | Static Rust. Waits empty; starts unmodified `postgres` only when the node agent's mount signal and the controller's tenant bundle for the same binding have both arrived; stops it on request. It never runs initdb, edits PGDATA or restarts PostgreSQL. |
| Node agent | The existing `pgcf-sandbox-controller` host service (A8.1.6). Mounts and unmounts under Cloudflare authority; holds no Kubernetes credentials. |
| Native controller | Creates, refills and deletes pool Pods; holds CNPG's primary Lease during a binding; pushes the tenant bundle; runs fresh checks, the sleep proof and pool backups; writes the gateway's binding record. |
| Cloudflare | D1 `pool_pods` (inventory) and `pool_bindings` (authority). The DatabaseActor claims, signs permissions and admits. |

**Holder invariant.** For each database exactly one holder may use the volume: `cnpg` or
`pool/<binding ID>`. The `pool_bindings` row is authoritative and moves only forward by
conditional update: `claimed → mounted → serving → detaching → released`; a failure passes
through `failed` to `released`, an aborted bind ends `refused` and a reboot ends `lost`. A new
binding, and equally a CNPG wake (hibernation off), are allowed only after the previous binding
reached `released`, `refused` or `lost` with a recorded outcome. Pool Pods run under Pod Security
`restricted` with `restartPolicy: Never`, no `fsGroup` and no ServiceAccount token.

**Eligibility for a hit.** The database is running and not suspended; its node has a ready pool
Pod whose profile (PostgreSQL image digest, CPU and memory limits) equals the database's; its
desired configuration fingerprint equals the applied one in its sleep record (§7, A8.3); its last
holder released with a clean stop (A8.2.3); its Cluster is hibernated with no non-terminal instance
Pod and an empty primary Lease (A8.1.4); it is established (`ever_ready`) with a single PVC; and
its volume is thick until thin bindings are proven (A8.7). Anything else is a `miss` and takes
the CNPG wake.

### A8.1 Single writer

Neither LVM nor the kernel's open semantics can make one LV exclusive to one process on a node
(A8.1.1). Exclusivity rests on one authoritative holder (A8.0), the node agent's kernel proof
before and after every mount (A8.1.2, A8.1.5), and fences that keep CNPG from starting while a
pool binding holds the volume (A8.1.4).

**A8.1.1 What LVM, the kernel and PostgreSQL guarantee.**
- *Activation is not ownership.* OpenEBS calls `lvcreate` without an activation option, so LVM
  activates every new LV, and neither NodePublish nor NodeUnpublish changes activation [U32].
  Exclusive activation (`-aey`) is a host lock that lvmlockd grants in shared VGs; `pgcf` is a
  local VG for a single host [U31]. Every PGCF LV is therefore active whenever its node is up,
  and LVM gives no exclusion between processes of one node. PGCF neither changes activation nor
  uses it as a lock.
- *Exclusive open is per device, not per mount.* The first ext4 mount opens the device with its
  superblock as exclusive holder, after which a userspace `O_EXCL` open fails; both are global and
  ignore mount namespaces [U25][U26]. A second mount of the same device, in any namespace, reuses
  that superblock without opening the device again [U25]. A mount therefore never excludes
  another mount.
- *The device-mapper open count* counts every open of the mapped device [U26][U27]. Zero proves
  that, at that instant, no mount and no other opener exists anywhere. After our own mount, one
  does not prove that we are alone, because a second mount shares the superblock.
- *PostgreSQL's interlock is namespace-local.* The postmaster.pid check probes the recorded PID in
  its own PID namespace and the shared-memory check attaches in its own IPC namespace [U49][U22];
  CNPG deletes a postmaster.pid whose PID it cannot see [U17]. Two Pods can start two postmasters
  on one PGDATA, so single writer must be enforced outside PostgreSQL.

**A8.1.2 Bind-time proof by the node agent.** Nothing is mounted unless every check passes:
1. The bind permission (A8.1.6) is valid for this node UID, boot ID, binding, generation and
   expiry.
2. `/dev/mapper/pgcf-<escaped volume handle>`, OpenEBS's own device path [U32], is exactly one
   `dm-N` whose device-mapper UUID is `LVM-<VG UUID><LV UUID>`, found by the complete inventory
   that sc/storage_dm.rs:114-153 already uses for thin volumes. The permission pins the LV UUID
   once it is recorded; the first bind of a retained thick volume records it.
3. `DM_DEV_STATUS` reports open count 0 (sc/storage_dm.rs:83-90; today reached only behind the
   thin identity check, extended to linear targets).
4. No superblock with the LV's `dev_t` exists in any mount namespace. The agent walks every mount
   namespace with `NS_MNT_GET_NEXT` and reads its mounts with `listmount` and
   `statmount(STATMOUNT_SB_BASIC)`; as root in the initial user namespace it sees all of them,
   including namespaces that no process holds [U28] (unproven from the agent's context, A8.7).
   A cross-check reads every process's `mountinfo` through the host `/proc` handle the agent
   already keeps (sc/host_context.rs:21-22, 187-199).
5. The mountpoint is the `data` directory of the pool Pod's `volume` emptyDir, opened with
   `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` below `/var/lib/kubelet/pods/<pool Pod UID>`:
   a root-owned 0755 directory on that Pod's tmpfs, prepared while the Pod was tenant-free
   (A8.1.3).
6. A durable record `accepted` is written the way owner records are (sc/controller.rs:70-115).

The agent then mounts ext4 through `fsopen`/`fsmount` and `move_mount` onto the opened directory
descriptor, so no path can be swapped, with the device path of check 2 as source string and
`nodev,nosuid,noexec`. It repeats check 4: every mount of the `dev_t` must be a propagated copy at
that emptyDir path (agent, kubelet and pool-container namespaces, and OpenEBS's plugin
namespace). Any other mountpoint is foreign: unmount, record `refused`. Only then does it record
`mounted` with mount ID and `dev_t` and signal the supervisor.

**A8.1.3 Mount propagation, Pod Security and kubelet.**
- *Mechanism.* Both pool containers mount a memory-backed emptyDir `volume` at
  `/var/lib/postgresql` with `mountPropagation: HostToContainer`, so the LV appears at CNPG's own
  PGDATA path `/var/lib/postgresql/data/pgdata` [U44]. kubelet passes HostToContainer to CRI, and
  containerd requires a shared or slave source and binds it `rslave` [U34][U39]; a mount below a
  shared mount propagates to its peers and slaves [U30]. Talos binds `/var/lib/kubelet`
  `rbind,rshared` into kubelet and, with workload isolation, runs CRI, kubelet and Pods in one
  sandbox PID+mount namespace [U40], which the agent joins (sc/host_context.rs:113-170).
- *Pod Security `restricted` permits it.* API validation forbids only Bidirectional propagation
  for unprivileged containers [U34]; the restricted volume list includes emptyDir, and none of the
  19 pinned Pod Security checks reads `mountPropagation` [U35]. The pool Pod needs no hostPath,
  privileged container or capability.
- *Precheck (unproven under Talos workload isolation).* Before a pool Pod enters the inventory,
  the agent requires its `volume` tmpfs to be `shared:N` in the agent's `mountinfo` and the
  containers' copies to be `master:N` with the same N. It then sets the emptyDir root to 0755
  root:root and creates `data`, so the uid-26 containers cannot replace the mountpoint; check 5
  still refuses anything else at bind time. After every mount, check 4 must find the LV in
  kubelet's and both containers' mount tables.
- *kubelet does not know the nested mount and cannot destroy it.* Memory emptyDir teardown
  unmounts the tmpfs before it removes the directory [U36]; the unmount fails with EBUSY while the
  LV is mounted beneath [U29], so the removal never runs. `SyncTerminatedPod` waits for the
  unmount and the API object is deleted only afterwards [U37]: while the LV may be mounted, the
  pool Pod object exists. Orphaned-Pod cleanup removes only empty directories on one filesystem
  and skips Pods with mounted volumes [U37]. A disk-backed emptyDir would remove recursively
  across the mount [U36][U23] and stays excluded. The EBUSY protection is unproven on EU1.
- *No fsGroup.* kubelet changes ownership only when fsGroup is set [U36]. Pool Pods set none, so
  kubelet never walks into PGDATA, not even when it runs SetUp again after a restart.
- *OpenEBS's single-mount guard* compares source strings in the plugin's own mount table
  [U13][U33]. The plugin mounts `/var/lib/kubelet` Bidirectionally [U32] and the pool mount uses
  the same source string below that tree, so a CNPG NodePublish during a binding should be
  refused. Unproven, and not relied upon.

**A8.1.4 Fences between the hibernated Cluster and the pool.**

| Fence | While the pool holds: CNPG cannot start | While CNPG holds: the pool cannot bind |
| --- | --- | --- |
| Binding record | A CNPG wake needs the binding `released`, `refused` or `lost`; until then the controller refuses to turn hibernation off, which today happens at nc/power.rs:1637, reached from nc/reconcile.rs:840-856. | Cloudflare signs a bind permission only when the last holder released and the sleep record shows a clean stop. |
| `cnpg.io/hibernation=on` | Stays on for the whole binding. A hibernated Cluster's reconcile returns before CNPG reconciles Pods [U41], and CNPG fails every Backup of it [U42]. | The controller requests a permission only after it observed the Hibernated condition and no non-terminal instance Pod (nc/power.rs:1310-1345). |
| CNPG primary Lease `database` | CNPG starts a primary's PostgreSQL only after it holds this Lease and takes the Lease over only when it is empty or unrenewed for 15 s [U43]. Before pushing the bundle the controller claims it as `pgcf-pool/<binding ID>`, renews it at least every 5 s, and empties it after `released`, as CNPG does at a clean stop [U43]; CNPG's operator only ensures that the Lease exists [U43]. | The controller claims only an empty Lease, which CNPG leaves at its clean stop [U43]. |
| PVC | The pool never references the PVC, so kubelet's PVC path stays CNPG's; OpenEBS's guard (A8.1.3) is an extra, unproven layer. | The permission binds PVC, PV, volume handle and LV; open count 0 and the namespace scan (A8.1.2) prove that no CNPG Pod has the PVC mounted. |

A mistaken hibernation-off therefore still cannot start a second postmaster: CNPG's instance
manager waits for the Lease before PostgreSQL starts [U43]. It may rewrite its configuration
files before that gate [U43], with the same content while the configuration fingerprint and the
CNPG release are unchanged (A8.3).

**A8.1.5 Unmount.** The agent unmounts after the supervisor reported a clean stop or after the
pool Pod's processes have ended; if a holder survives, it kills the pool Pod's cgroup first. It
uses a non-lazy unmount, which fails with EBUSY while any propagated copy is in use; a lazy
detach would leave a live superblock without a mount entry and is never used [U29]. It records
`released` only with open count 0 and an empty namespace scan. Unmounting needs no Cloudflare
permission, because it can only end the single writer.

**A8.1.6 The privileged component and its authority.** The node agent is the sandbox controller.
node-bootstrap is a Cloudflare Container (apps/api/wrangler.example.jsonc:67-70) that reaches
nodes through the Talos API; it is not a node service. Of PGCF's node components only the sandbox
controller is a Talos host service (infra/talos/sandbox/service.yaml:2-16); the node reclaimer is
restricted to bounded memory reclaim (rt:315-321). The sandbox controller already runs in CRI's
PID and mount context with the host `/proc` handle (sc/host_context.rs:21-22, 113-199), issues
device-mapper ioctls (sc/storage_dm.rs:61-90), verifies Cloudflare's Ed25519 authority against
pinned keys (sc/storage.rs:147-176, 239) and persists owner records (sc/controller.rs:70-115).
- *Signed bind permission.* Ed25519 with prefix `pb1` and domain `pgcf-pool-bind/v1\n`, signed with
  the existing storage-authority keys under that separate domain
  (packages/contracts/src/storage-write-authority.ts:7-12, 85-111), so the node needs no new trust
  anchor (infra/talos/sandbox/configuration.ts:15-56). Claims: binding ID, database ID,
  generation, node UID, boot ID, storage UID, PVC and PV UIDs, volume handle, VG and LV UUIDs,
  pool Pod UID, the attested supervisor key fingerprint, PostgreSQL image digest, the sleep
  record's system identifier and timeline, a bundle nonce, issue time and an expiry at most 30 s
  later. It reaches the agent through a held request on the existing agent endpoint
  (sc/policy.rs:251-279).
- *Identity checks.* Node UID and boot ID (sc/storage.rs:107-116); the pool Pod's containers in
  containerd's `k8s.io` namespace with that Pod UID and the supervisor's executable hash; the
  supervisor key; the device (A8.1.2).
- *Supervisor attestation.* At pool Pod start the supervisor generates a TLS key in memory and
  writes the public key into its `control` memory emptyDir; the agent reads it below the Pod's
  kubelet directory and reports it with the pool Pod. Agent and supervisor talk over a Unix socket
  in that emptyDir; the supervisor accepts only a peer with uid 0 outside its PID namespace
  (`SO_PEERCRED`), which no tenant backend can be.
- *Exact-once outcome record.* One durable record per binding ID, moving through `accepted`,
  `mounted`, `failed` and `released`, or ending `refused` or `lost`. A binding ID is mounted at
  most once, and a record from another boot is never resumed. Each state is reported with the
  binding ID as idempotency key; Cloudflare advances its row only forward and acknowledges
  repeats.

### A8.2 WAL archiving and backups

**A8.2.1 Archive command.** CNPG's mandatory `archive_command` calls
`/controller/manager wal-archive` [U16], which does not exist in a pool Pod. The supervisor starts
unmodified `postgres -D /var/lib/postgresql/data/pgdata` with exactly three command-line settings,
which override postgresql.conf and ALTER SYSTEM [U51]:
`archive_command='/pgcf/bin/pgcf-supervisor wal-archive %p'`, `logging_collector=off` and
`log_destination=stderr`. Everything else comes from CNPG's configuration in PGDATA. Memory
emptyDirs reproduce CNPG's `/controller`, `/run` and `/dev/shm` layout, so the remaining paths
resolve unchanged [U44]. The shim hands the WAL path over a Unix socket to the `archiver`
container, which holds the R2 credential and runs the first command below; A8.2.2 uses the other
two. All three carry exactly the options the plugin derives [U46][U47][U48] from the ObjectStore
PGCF writes (nc/manifests.rs:91-106), with `serverName` from the Cluster's plugin parameter
(nc/manifests.rs:341) and `AWS_DEFAULT_REGION=auto` (nc/manifests.rs:73-76):

```text
barman-cloud-wal-archive --gzip --endpoint-url <endpoint> --cloud-provider aws-s3 \
  <destinationPath> <serverName> <WAL file>
barman-cloud-backup --user postgres --name backup-<compact ISO time> --gzip \
  --endpoint-url <endpoint> --cloud-provider aws-s3 <destinationPath> <serverName>
barman-cloud-backup-delete --endpoint-url <endpoint> --cloud-provider aws-s3 \
  --retention-policy <policy> <destinationPath> <serverName>
```

The archiver takes one file at a time without a spool and exits 0 only after the upload
succeeded; PostgreSQL then renames `.ready` to `.done` [U50].

*Compatibility with CNPG's later resume* (unproven until A8.7):
- Same timeline: a pool never promotes or recovers.
- Same destination, server name, compression and Barman release, hence the same object names.
- Archive status lives in PGDATA (`pg_wal/archive_status`): CNPG's archiver continues with what
  the pool left `.ready`. The plugin's spool is per Pod [U44] and holds nothing from the pool.
- Re-archiving a segment overwrites identical content; PostgreSQL requires archivers to tolerate
  it [U50], and the plugin checks only its spool [U46].
- The empty-archive check runs only while `.check-empty-wal-archive` exists, and CNPG deletes the
  marker once continuous archiving holds [U46]. Pool eligibility requires its absence, checked on
  the mounted volume.

**A8.2.2 Base backups.** CNPG fails every Backup of a hibernated Cluster with "cannot backup a
hibernated cluster", while its ScheduledBackup keeps creating them [U42], and plugin retention
runs only in the sidecar of the current primary [U47]. During a pool phase neither works; by the
same source, scheduled Backups of sleeping databases fail today as well. Decision: PGCF takes the
base backup in the pool Pod and does not hand over to CNPG (unproven, A8.7).
- *Trigger:* while serving, when the catalog's newest completed base backup is older than 24 h,
  the daily cadence of the ScheduledBackup (nc/manifests.rs:357). The controller sends `backup`
  over the supervisor channel after admission, never on the bind path.
- *Command:* the `archiver` runs `barman-cloud-backup` as listed in A8.2.1, as the plugin does
  [U47], connecting through `/controller/run` under CNPG's `local all all peer map=local` rule
  [U44]; it sees PGDATA at the same path.
- *Retention:* after a `DONE` backup it runs `barman-cloud-backup-delete` as listed in A8.2.1 with
  the ObjectStore's retention (nc/manifests.rs:275-276).
- *Record:* the controller reads the new `backup.info` with the restore catalog's parser
  (apps/api/src/domain/restore-catalog.ts:15-55) and reports it as backup health beside CNPG's
  Backup objects (nc/health.rs:355-369, 404-526); the newer completion wins. Restore is unchanged
  because it reads the Barman catalog.
- *Detach waits* while a pool backup runs.
- *Why not a short CNPG wake:* a database that never goes idle has no CNPG-owned phase, and a
  forced hand-over would wait for busy sessions, which the gateway never closes
  (gw/control.rs:265-283), and then pay a cold CNPG wake. CNPG-owned phases keep the
  ScheduledBackup and plugin retention unchanged.

**A8.2.3 Sleep proof preserved.** The statements remain those of
apps/regional/src/agent/sleep.ts:52-75, executed by nc/power.rs:1085-1218: guard, identity,
`pg_switch_wal()`, then waiting until the closed segment's `.done` appears
(nc/power.rs:1191-1203). The controller dials the pool Pod IP with TLS name
`database-rw.pgcf-db-<id>.svc`; nc/postgres.rs:78-88 changes from Service DNS to an address plus
that name. Only after `Proved` does the supervisor fast-stop PostgreSQL, read `pg_controldata`
(`shut down` [U50]) and report; the agent unmounts (A8.1.5); the controller empties the Lease and
stores the sleep record of §7 with the outcome. Hibernation is already on, so the hibernate step
(nc/power.rs:1407) is skipped, and a hibernated observation requires `released` instead of
terminal CNPG Pods (nc/power.rs:1310-1345).

### A8.3 TLS and credential custody

- *Source.* CNPG keeps the server certificate and key in Secret `database-server` and its CA in
  `database-ca` in the tenant namespace [U45]. The controller reads them by the names in
  `status.certificates`, as it already reads the CA (nc/reconcile.rs:1382-1408), under its existing
  cluster-wide `get` on Secrets (infra/platform/regional/rbac.yaml:43-47): no new RBAC.
- *Copy.* The controller pushes one bundle per binding (`server.crt`, `server.key`,
  `client-ca.crt`, destination path, server name, endpoint, binding ID and the permission's nonce)
  to the supervisor's TLS endpoint on the pool Pod IP, pinned to the supervisor key fingerprint
  that the agent attested and Cloudflare forwarded. The supervisor accepts a bundle only for its
  current binding and nonce, which it learns from the agent; writes the files with mode 0600 for
  uid 26 under `/controller/certificates`, where CNPG's mandatory settings point [U44]; and never
  logs them. The `archiver` container does not mount that directory. Cloudflare never sees the
  key, and the tmpfs ends with the Pod. If CNPG renews the Secret during a binding, the controller
  pushes again and the supervisor reloads PostgreSQL.
- *Archive credential.* It is the regional R2 key the controller already copies into every tenant
  namespace (nc/manifests.rs:88-90, 260-265; nc/reconcile.rs:1282-1323). A copy in `pgcf-pool`
  reaches only the `archiver` container, as CNPG's sidecar holds it today: no new breadth.
- *Role passwords.* pg_authid on the volume holds what CNPG's managed roles last applied and the
  controller acknowledged (nc/reconcile.rs:84-131). The pool never changes roles, and a database
  is pool-eligible only while its desired configuration fingerprint
  (packages/contracts/src/reclaim.ts:301-379: image, sizes, roles with revisions, archive and
  storage) equals the applied one in its sleep record.
- *Role change while awake in the pool: deferred, not refused.* Creating a role or resetting a
  password raises the database generation (apps/api/src/domain/roles.ts:54-167). For a pool-bound
  database the Actor's barrier (rt §10) closes admission for new sessions, and the controller runs
  the detach path, which completes once in-flight work has ended, because busy sessions are never
  forced closed. A CNPG-owned wake then applies the managed roles, and admission reopens after
  acknowledgement. No new session can authenticate with an old password in between. Refusal would
  fail an integrator's rotation whenever the database is busy.
- *Supervisor:* no ServiceAccount token and no Kubernetes access.

### A8.4 Network identity and late-set labels

- *Policies cannot follow labels across namespaces.* A pre-created Pod cannot move into
  `pgcf-db-<id>` [U1]. The tenant's NetworkPolicy and CiliumNetworkPolicy select
  `cnpg.io/cluster=database` inside that namespace (nc/manifests.rs:163-228), and gateway and agent
  egress allow `cnpg.io/cluster: database` only in namespaces labelled `pgcf.io/database-id`
  (infra/platform/regional/network-policies.yaml:95-107, 143-156). Whatever its labels, a pool Pod
  is never selected by them.
- *Pool namespace policy.* `pgcf-pool`, Pod Security `restricted`: default deny; ingress to pool
  Pods on 5432 from `pgcf-gateway` and `pgcf-agent`, and on the supervisor port from `pgcf-agent`
  only; egress only to the R2 endpoint by FQDN on 443 and to kube-dns for that name; no
  kube-apiserver and no traffic between pool Pods. Gateway and agent egress gain one fixed rule for
  `app.kubernetes.io/name: pgcf-pool` in `pgcf-pool`.
- *Cilium identity.* Cilium makes every Pod label without an ignore prefix identity-relevant,
  allocates identities as CRD objects and lets an endpoint use a changed identity only after
  `identity-change-grace-period`, 5 s by default [U52]. A tenant label set at bind time would put
  that wait on the critical path and create an identity per binding. Decision: the controller sets
  `pgcf.io/pool-database=<id>` and `pgcf.io/pool-binding=<binding ID>` after admission, and
  Cilium's `labels` option gets the single ignore prefix `k8s:!pgcf\.io/pool-` [U52]. Ignore-only
  prefixes keep Cilium's default rules, and the match is anchored at the start of the key [U52],
  so no existing identity changes (unproven, A8.7). The labels serve inventory, metering and
  operators; they are never an authorization input.
- *Routing (rt §6, §10).* The route token (packages/contracts/src/route-token.ts:36-45) becomes
  version 3 with the route revision (rt:296) and the target: kind `pool`, binding ID, Pod UID, IP
  and node; its 512-character bound (route-token.ts:16) must grow. The controller writes the same
  target as `pool-binding.json` into the existing `gateway-fence-<id>` ConfigMap, which the gateway
  already watches (gw/targets.rs:71-87). The gateway admits only when token target, binding record
  (state `serving`) and power fence agree, and then dials the IP with TLS name
  `database-rw.pgcf-db-<id>.svc` and the CNPG CA from `ca-<id>` (gw/transport.rs:506-507,
  713-751). For thin volumes the storage binding's Pod UID is the pool Pod's
  (gw/targets.rs:313-405). EndpointSlice routing (gw/targets.rs:247-311) remains for CNPG-owned
  phases; only the native gateway gets pool routing.
- *What prevents a stale label from admitting traffic.* Nothing reads the late labels for access:
  no policy, token claim or gateway check. Admission needs a signed, single-use token valid for at
  most 30 s (route-token.ts:16-18; apps/native-gateway/README.md:13-15) whose target equals the
  binding record; the record leaves `serving` before quiesce; a reused IP fails the Pod UID check;
  a wrong server fails TLS against the database's CA and name. A pool Pod serves one binding and is
  then deleted with its labels.

### A8.5 Failure and restart behaviour

| Situation | Behaviour |
| --- | --- |
| Supervisor dies | With `restartPolicy: Never` kubelet starts no new supervisor on the mounted volume. The supervisor is PID 1 of the `postgres` container, so its exit kills every remaining process of that PID namespace, the postmaster included [U53]. The agent sees the exit and records `failed`; Cloudflare revokes the route: fence closed, sessions closed, nothing replayed (rt:250). The agent kills the rest of the pool Pod's cgroup, unmounts, checks open count 0 and the namespace scan, and records `released` with an unclean stop; the controller empties the Lease. The next wake is a CNPG wake with crash recovery, labelled `miss`. |
| Pool Pod deleted (API, eviction, drain) | The route is revoked first. On SIGTERM the supervisor fast-stops PostgreSQL within the Pod's termination grace period and reports pg_control. The memory emptyDir cannot be torn down while the LV is mounted beneath it, so the Pod stays Terminating until the agent has unmounted after the postgres processes ended (A8.1.3). WAL not yet archived stays `.ready` for the next owner. If SIGKILL comes first, the row "Crash-stopped PGDATA" applies. A forced API deletion removes only the object; the node record and the kernel state still decide. |
| Node reboot | Pool Pods and mounts end with the boot. Records of the old boot ID are never resumed; the agent reports them `lost` with the new boot ID, and Cloudflare closes the binding without a clean-stop record. The controller empties the stale Lease, which CNPG would otherwise take over after 15 s [U43]. The next wake is a CNPG wake with crash recovery, labelled `miss`. |
| Two wakes, one free pool Pod | Claims are conditional updates of one `pool_pods` row per Pod (`binding_id IS NULL`). The first commit wins and is a hit; the other database finds no free compatible Pod and takes the CNPG wake, labelled `miss`. Two wakes of one database coalesce in its Actor (rt:81-84). |
| Node agent restart mid-bind | Records survive in the agent's state directory. `accepted` without a mount continues only while the permission is valid, otherwise it becomes `refused`. A mount found under `accepted` (crash between mount and record) gets the post-mount namespace scan again, then `mounted` if the permission is still valid, else an unmount. The supervisor is signalled only after `mounted` is durable, so no postmaster runs on an unrecorded mount. A `mounted` or serving binding is verified again and continues. |
| Detach interrupted | The binding stays `detaching`: hibernation on, Lease held, no `released`, so neither CNPG nor a new binding can start. The retry stops PostgreSQL again if it still runs, kills remaining holders in the pool Pod's cgroup, unmounts non-lazily and verifies. Admission stays closed; a wake meanwhile waits for `released` and then binds anew or wakes CNPG. |
| Cloudflare unreachable | No bind starts without a fresh permission, and no client connection reaches the region without Cloudflare anyway. Serving bindings continue; the controller keeps renewing the Lease inside the cluster; nothing detaches without Cloudflare's sleep decision; outcome reports are retried. Thin volumes would keep the existing write-authority expiry (open for R2b, A8.7). |
| Crash-stopped PGDATA | A bind needs a sleep record with a clean stop. After mounting, the supervisor checks the volume again: pg_control `shut down` [U50] with the recorded system identifier and timeline, `PG_VERSION` 18, and no `postmaster.pid`, `standby.signal`, `recovery.signal` or empty-archive marker. Anything else aborts before PostgreSQL starts: unmount, `refused`, and the wake continues as a CNPG wake with crash recovery, labelled `miss`. |
| Native controller restart | A bind whose bundle does not arrive before the permission's expiry is abandoned: the supervisor reports it, the agent unmounts and records `refused`, and the wake continues as a `miss`. For a serving binding, Lease renewal pauses; CNPG could take the Lease after 15 s but has no instance while hibernated; the new process resumes renewal from the binding record. Admission state is unchanged. |

### A8.6 Sequence and timing

Pool hit. Steps 1–6 are the critical path; steps 2 and 3 run in parallel.
1. Client → Edge → DatabaseActor. The wake commit (actor:584-605) also claims a free compatible
   pool Pod on `db.node` in the same D1 batch and records the binding. The Actor signs the bind
   permission and answers the agent's held request; RegionLink hints the controller, which
   fetches the binding with the database's desired state (rt §9).
2. Node agent: the checks of A8.1.2, durable records, mount, post-mount scan, signal to the
   supervisor.
3. Controller: Cluster still hibernated, Lease claimed, server Secret and CA read, bundle pushed.
4. Supervisor: the volume checks of A8.5 ("Crash-stopped PGDATA"), TLS files, `postgres` start;
   ready when `postmaster.pid` reports `ready` [U11]; report to agent and controller.
5. Controller fresh checks over one maintenance session to the Pod IP: TLS name and CA, database,
   not in recovery, system identifier, roles and their attributes, settings. Then
   `pool-binding.json`, fence release (a pool branch of nc/power.rs:1700-1735) and the immediate
   observation. Cloudflare admits when observation and the agent's proof agree with the claim, and
   pushes to the Actor instead of the 250 ms poll (actor:788-839).
6. Edge signs the version-3 token; Tunnel; the gateway checks token, record and fence and dials;
   TLS; StartupMessage; SCRAM passthrough (rt:300-306); query; first row.
7. Off the path: late labels; in-place resize of the pool Pod's requests to the database's,
   generally available in the pinned Kubernetes [U38]; per-role login checks as background
   verification (rt:238); a pool backup when due; refill to X. Misses take the CNPG wake with the
   region's selected runtime; pool hits do not use R2's sandbox slots.

**What a hit removes** from today's wake: CNPG's Pod creation, scheduling, kubelet's volume wait,
sandbox and CNI, init container, sidecar and instance-manager start with their probes (connect →
Pod Ready 4.9–6.6 s), and the orchestration after Ready (4–5 s), which steps 1, 5 and 6 replace by
pushes.

**Expected latency against one second.** The awake path, 0.69–0.93 s, already contains the client's
connection to Cloudflare, an admission and all of step 6. A hit adds steps 1–5 in place of that
awake admission, whose duration is unmeasured. For a first SQL below one second, steps 1–5 must
fit in 1 − 0.93 = 0.07 s at the slow end and 1 − 0.69 = 0.31 s at the fast end of the measured
awake path, plus the awake admission they replace. A clean PostgreSQL start to first SQL took
44–302 ms on a laptop, and 71–112 ms including the ext4 mount (§2), not on EU1; steps 1, 2 and 5
contain at least one Cloudflare → EU1 and one EU1 → Cloudflare delivery and a D1 commit, none of
them measured. At the slow end the clean start alone can use the whole remaining budget; at the
fast end everything in steps 1–5 must fit in 0.31 s plus the replaced admission. The target
therefore stays unproven and doubtful. The first live runs must record the split of the awake
path (plan: "Wake stage measurement") next to the hit stages. If the part after admission
dominates, the remaining lever is to open the Edge → gateway WebSocket and hold the client's
StartupMessage before admission; that changes the admission order of rt §10 and needs its own
owner decision.

### A8.7 Component changes and acceptance

| Files | Change |
| --- | --- |
| packages/contracts/src/compute-pool.ts | A pool-Pod kind of the node policy (PostgreSQL and sidecar image digests, supervisor hash, CPU and memory limits; `target_slots` is X) and its observation (Pod UID, IP, supervisor key fingerprint, propagation precheck); run labels `hit` and `miss` with stage timestamps. |
| New packages/contracts/src/pool-binding.ts; packages/contracts/native/generate.ts | Bind permission `pb1`, outcome records, binding states and the sleep record, with generated native constants. |
| packages/contracts/src/route-token.ts | Version 3 with route revision and target; a larger length bound. |
| packages/contracts/src/reclaim.ts | The runtime attestation (lines 181-205) for a pool binding: kind, binding ID, pool Pod. |
| apps/api/src/database-actor.ts | Claim in the wake commit; admission push; deferral of role changes for pool-bound databases. |
| apps/api/src/domain/compute-pool.ts, roles.ts, desired.ts, observations.ts; new apps/api/migrations/0046_pool_bindings.sql | `pool_pods` and `pool_bindings`, held agent request, idempotent outcomes, binding in desired state, sleep record, pool backup observations. |
| apps/edge/src/index.ts (apps/edge-rust once it replaces it) | Sign version-3 tokens (index.ts:134). |
| apps/native-controller/src/power.rs, reconcile.rs, postgres.rs, health.rs, kubernetes.rs, measurements.rs; new pool.rs | Pool branches of wake, sleep proof and detach; hibernation-off refused while bound; dial by address with the service TLS name; pool Pod lifecycle and refill, Lease, bundle push, backups, labels and resize; backup health from the catalog; usage attributed by binding record. |
| New apps/pool-supervisor (workspace member) | Supervisor, `wal-archive` shim and archiver mode. |
| apps/sandbox-controller/src: new binding.rs; storage_dm.rs, policy.rs, main.rs; README.md | Permission verification, kernel checks, descriptor-based mount, unmount, records and outcomes; status by UUID for linear targets; held request and pool observation. It ships in the existing extension without a new trust anchor. |
| apps/native-gateway/src/targets.rs, transport.rs, kubernetes.rs; README.md | Pool targets from `pool-binding.json`; token target checks. |
| infra/platform/regional: new pool.yaml, kustomization.yaml, network-policies.yaml, rbac.yaml | Namespace `pgcf-pool` (Pod Security `restricted`, default deny, CiliumNetworkPolicy, PriorityClass); gateway and agent egress; a Role in `pgcf-pool` with Pod `create` and `patch` and `pods/resize` `patch`, which the controller's slot preparation, refill, labels and requests need (rt:370); a ClusterRole with `get` and `update` on `leases` named `database` for the CNPG start fence. Pod `get`, `list`, `watch` and `delete` and Secret `create` and `update` already exist (rbac.yaml:43-47, 78-89). |
| infra/platform/base/values/cilium.yaml | `labels` set to `k8s:!pgcf\.io/pool-`. |
| THIRD_PARTY.md | The pool runs the pinned plugin sidecar image unmodified as its archiver. |

**Live acceptance on EU1 through Cloudflare**, after R2 is accepted:
1. *Hit or miss.* A sleeping database (Cluster hibernated, no CNPG Pod) with X ready pool Pods on
   its node; a normal client connection through `db.ohmyho.st`; `connect_ms` and `first_read_ms`
   from one instant, broken down into claim, permission and hint delivery, device checks, mount,
   Lease, bundle, PostgreSQL ready, fresh checks, both proofs, admission, token, gateway dial, TLS,
   AuthenticationOk and first row. Every run is labelled `hit` or `miss` with the miss reason.
2. *Data and refill.* The committed marker reads back; the used pool Pod is gone and the pool
   observation shows X ready pool Pods again.
3. *Detach after 60 s and after 900 s.* The closed segment's `.done` precedes the stop; pg_control
   reads `shut down`; the agent records `released` with open count 0 and an empty namespace scan,
   and none of its scans during the binding saw a second mountpoint; the Lease is empty; the
   Cluster is hibernated with no instance Pod.
4. *WAL, backup and restore.* `pg_switch_wal()` in a pool phase puts the segment into R2 under the
   destination path and server name; a pool base backup reaches `DONE`, appears in the restore
   catalog and restores with its WAL into a separate database through the API with the marker; a
   later CNPG-owned wake archives on the same timeline and server name without error, and its
   ScheduledBackup completes.
5. *Failure tests, one each:* supervisor killed; pool Pod deleted while serving; node reboot with a
   bound pool Pod; two wakes on one node with one free pool Pod. Each shows the behaviour of A8.5
   and no second writer.

**Open blockers that need live proof.**
1. Propagation of the agent's mount into the pool containers and into kubelet's namespace under
   Talos workload isolation (A8.1.3).
2. The EBUSY-protected emptyDir teardown on EU1 while the LV is mounted beneath.
3. Mount-namespace enumeration with `NS_MNT_GET_NEXT`, `listmount` and `statmount` from the
   agent's context on Talos 1.14.2.
4. CNPG resuming after pool phases: archiving on the same timeline, Lease hand-back, no
   empty-archive refusal.
5. Pool base backups and retention against the plugin's catalog, and restore from them.
6. Cilium: the ignore prefix keeps pool identities stable, and gateway and agent reach pool Pods.
7. In-place resize of a serving pool Pod's requests.
8. A first SQL below one second through Cloudflare (doubtful, A8.6).
9. Thin volumes: a write authority bound to the pool Pod UID and the guard's suspension of pool
   bindings, with R2b.
10. OpenEBS's guard refusing a CNPG NodePublish during a binding (useful, not relied upon).

The orchestration that every wake needs (immediate publication, Actor push, route token with
target and direct dial; rt §6, §9, §10) comes first, as the Owner direction states; it carries
steps 5 and 6.

## 1. Decision requested from the owner

**Decision 1 (now).** Approve the early-postmaster binding of §3 as the shared-pool mechanism; it is
built only after Gate 0. CNPG keeps creating and owning the instance Pod, its PVC and RBAC, WAL
archiving, backups, managed roles, fencing and hibernation. Three approved rules change:

| Approved rule | Requested change |
| --- | --- |
| CNPG owns the PostgreSQL process "throughout that binding" and starts it with its unchanged instance manager (rt:117-118, rt:145-148). | On a runner hit a PGCF launcher starts unmodified PostgreSQL on CNPG's last applied configuration, and CNPG's unchanged instance manager adopts the live server through the path of its own in-place upgrade [U4][U5]. Until adoption, bounded by a deadline, the launcher only supervises; it changes no configuration, role or archive setting. |
| The gateway fence opens only after Cluster Ready and a Ready `postgres` container (nc/reconcile.rs:992-1028, nc/power.rs:1706-1728). | On a runner hit the fence opens after fresh checks against the running server (TLS and CA, every role's login and privileges, database identity, storage binding) and a matching node runner proof. CNPG readiness is verified after adoption, and a failure revokes the route. Fresh checks before admission (rt:238, rt:358) still hold. |
| A slot never receives PostgreSQL data, mounts or commands; the CRI child OCI spec owns them (apps/sandbox-controller/README.md:5-9, apps/node-runtime/README.md:7-8). | The sandbox controller creates one runner container per claimed slot from kubelet's own mounts for that one Pod, under a fixed security template qualified per release. The holder is unchanged. |

If Decision 1 is declined, the CNPG-compatible pool stays at R2's sandbox level, which leaves the
whole in-Pod chain on every wake (plan:118). The pool-hit gate is then recorded as blocked
(rt:122-127) and only rejected alternative 8 remains.

**Decision 2 (only if Gate 0's stop rule fires).** Either build the runner anyway for the stages it
removes and keep the pool-hit gate open, which keeps migration blocked (plan:22-25), or approve
taking Pod creation off the hit path: PostgreSQL in pre-created pool Pods supervised by PGCF, with a
late-bound volume (rejected alternative 8). That changes the CNPG-ownership constraint (rt:122) and
needs its own design for archiving, backups and volume authority.

**Open blockers.**
1. The pre-adoption window, the pool-hit readiness rule and the slot boundary need Decision 1; no
   implementation removes them.
2. A pool-hit first SQL below one second (rt:23-27, rt:185-194) is unproven; Gate 0 measures it first.
3. The container alias and CNPG's adoption on a first instance-manager start are unproven; Dev
   acceptance must show them, and every CNPG, barman plugin, containerd and PostgreSQL release
   requalifies them (§11).

## 2. Measured baseline

| Measurement | Value | Source |
| --- | --- | --- |
| Sleeping database: connect → first SQL through Cloudflare | 9.6–11.2 s | EU1, 2026-10-12, R1.2 TypeScript agent, standard runtime, CNPG hibernation |
| Connect → database Pod Ready | 4.9–6.6 s | same runs |
| Pod Ready → admission: agent cadence, role and archive probes, gateway fence, observation, Actor D1 poll every 250 ms (actor:788-839), Edge | 4–5 s | same runs |
| Awake database: connect + first SQL through Cloudflare | 0.69–0.93 s | plan:84; always-warm p95 734 ms (rt:35) |
| R2 slot claim (runtime only, no SQL) | 10.4 / 11.5 ms | plan:75 |
| PostgreSQL 18.6 clean start → first SQL | 44–302 ms | laptop reference, not EU1 |
| ext4 mount + clean start → first SQL | 71–112 ms | laptop reference |
| Crash recovery, 296 / 509 MB WAL since redo | 1.29 / 1.97 s to ready | laptop reference |

The stage breakdown of the 4.9–6.6 s is still open (plan:117).

**What a runner hit removes.** Between mount and readiness a wake today waits for the
bootstrap-controller init container, whose exit kubelet notices on its one-second PLEG relist [U6];
for the barman sidecar, which holds back the next container behind a one-second exec startup probe
[U7]; for the instance manager's boot, plugin loading, Lease and first reconcile [U8]; for the
one-second startup and readiness probes (nc/manifests.rs:341); and for Pod, Cluster and EndpointSlice
readiness. A runner hit takes all of this off the first-SQL path.

**What a runner hit still pays.** The controller patch; CNPG's reconcile and Pod creation;
scheduling; kubelet's volume wait, which re-checks every 300 ms [U6][U9]; containerd's network
namespace and Cilium CNI, which run before the sandboxer is called [U10]; the runner and PostgreSQL
start; the fresh checks; and the client's TLS, SCRAM and query, which cannot overlap the wake while
SCRAM passes through to PostgreSQL (rt:300-306). None of these stages is measured on EU1 yet. With
the awake path alone at 0.69–0.93 s, little room is left under one second, so the target is doubtful
until Gate 0 shows otherwise. The 4–5 s after Ready are addressed for hits and misses alike by the
approved immediate controller publication, Actor push and direct target routing (rt §6, §9, §10);
their remaining cost under the native controller is unmeasured.

## 3. Recommended mechanism

R2's pool stays as built: per node, `target_slots` tenant-free slots, each a namespace holder plus a
stock runc v2 shim in an idle cgroup, refilled outside the claim path (sc/controller.rs:609-730;
apps/sandbox-controller/README.md:82-97). Each slot additionally prepares an unstarted **runner**: a
rootfs snapshot of the profile's pinned PostgreSQL image and an OCI template. Pools are per node
because the data is local (rt:108-111); more than X concurrent wakes on one node become misses.

**Pool-hit path.** Steps 1–7 are the critical path.
1. Connect → Edge → DatabaseActor. The wake commit (actor:584-600) also records the claim
   (rt:81-84): operation, node, profile hash, storage generation, applied configuration
   fingerprint, releases, the sleep record of §7 and an expiry. The node receives a signed wake
   permission with these values through a held request on its existing lease endpoint; the region
   receives a hint.
2. The watch-driven native controller (nc/main.rs:324-345) sets the pool label and turns hibernation
   off (nc/reconcile.rs:852-865, nc/power.rs:995-1029). Unchanged.
3. CNPG creates the instance Pod; admission adds `runtimeClassName: pgcf-prestarted`
   (infra/talos/sandbox/runtime-admission.ts:33-101); the scheduler binds it; kubelet mounts the
   PVC, the emptyDirs and the token before any runtime call [U6]; containerd runs CNI; sandbox
   Create and Start reach the slot.
4. Sandbox Create runs today's checks and claim (sc/controller.rs:1134-1258). It then waits, bounded
   by the claim's expiry, for the matching permission; today a missing thin startup permission is
   refused at once (sc/storage.rs:389-414) and the lease is polled every second (sc/storage.rs:594-599).
   It then evaluates eligibility (§5) and the exclusive-writer check (§9). Any failure leaves an
   ordinary prestarted sandbox in which CNPG starts PostgreSQL (`sandbox_hit`).
5. The runner is created in the slot with the Pod's namespaces and kubelet's mounts (§5). The
   launcher starts `postgres` as its child and reports `ready` from postmaster.pid [U11].
6. Two proofs: the sandbox controller pushes the runner proof; the native controller dials the Pod
   IP, runs the fresh checks, opens the power fence and publishes its observation (§6). Cloudflare
   admits when both match the claim, and the Actor is notified instead of polling.
7. The gateway dials the target carried in the route token; SCRAM passes through; first SQL.
8. Off the critical path, kubelet runs the init container and the barman sidecar as usual. CRI's
   `postgres` container is aliased onto the runner and execs CNPG's instance manager, which adopts
   the server [U4]. Pod and Cluster become Ready, the controller completes full verification, and
   `maintain()` refills the slot.

Labels: `runner_hit` means the slot was ready before the wake intent and the runner served the first
SQL; only this label counts for the pool-hit gate (rt:185-194). `sandbox_hit` means a prestarted
sandbox in which CNPG started PostgreSQL. `miss` means an on-demand slot
(apps/sandbox-controller/README.md:49-53).

This is the deepest preparation that CNPG ownership allows. It stays at the approved boundary below
Pod identity (rt:145-148), removes the expensive in-Pod preparation that rt:117-120 demands, reuses
R2's pool, policy API and refill, and falls back to R2's sandbox path on any doubt.

**Design review findings and their resolution**

| Finding | Resolution |
| --- | --- |
| PostgreSQL runs and accepts writes before CNPG owns it | Open: Decision 1, first row. Bounded by eligibility, the Lease check, the adoption deadline and a launcher that changes nothing (§5). |
| Credential and role checks move behind admission | Resolved: they run against the runner before the fence opens (§6). |
| CNPG's primary-Lease gate and demotion branch are bypassed | Resolved: one instance, no replica cluster, target and current primary equal to the Pod name, Lease free or held by the Pod name (§5). |
| The runner is invisible to Stop, storage-expiry stop and Shutdown and can outlive its Pod as a second writer | Resolved: registered under the sandbox ID inside the Pod cgroup; every stop path kills that cgroup and waits until it is empty before `note_stopped`; an exclusive-writer check precedes every start (§8, §9). |
| The sandbox controller becomes a second container runtime fed by an annotation | Resolved in part: fixed security template, `openat2` path resolution, LV check on the opened mount, alias equality check (§9). The boundary change itself is Decision 1, third row. |
| Below one second is unlikely while CNPG creates the Pod | Open: Gate 0 stop rule and Decision 2 (§11). |
| The container alias and CNPG's adoption path are unproven | Accepted cost: built only after Gate 0 and requalified per release (§11). |
| Logs and WAL archiving before adoption | Resolved: logs drained and replayed into the container log; archive lag measured (§5, §11). |
| A crash-stopped PGDATA on the fast path | Resolved: runner only when pg_control reads `shut down`; otherwise CNPG recovers (§5). |

## 4. Slot lifecycle

| State | Meaning | Next |
| --- | --- | --- |
| preparing | Holder, stock shim and runner bundle prepared in the idle cgroup | ready, destroyed |
| ready | Tenant-free and younger than `max_age_seconds`; counts toward `target_slots` | assigned, retiring |
| assigned | Sandbox Create accepted for one CNPG instance Pod; owner record written (sc/controller.rs:1216-1257) | binding, sandbox-only |
| binding | Permission matched, eligibility and exclusive-writer checks passed, runner created, launcher running | serving, failed |
| serving | Server ready, runner proof published, adoption deadline armed | adopted, failed |
| adopted | CRI `postgres` container aliased; CNPG's instance manager is the runner's PID 1 | stopping |
| sandbox-only | No runner; CNPG starts PostgreSQL in the slot exactly as in R2 | stopping |
| failed | Runner stopped and killed, cgroup empty, route revoked; the Pod continues as sandbox-only | stopping |
| stopping → destroyed | Sandbox Stop and Shutdown; a used slot never returns to the pool (rt:93-96) | — |
| retiring | Unused slot that is aged, surplus or from an older release | destroyed |

Refill and policy remain R2's: `maintain()` runs every 250 ms and prepares one slot per pass outside
the claim mutex; the lease is fetched every 5 s and lasts 30 s; policy expiry blocks claims and
retires only unused slots (apps/sandbox-controller/README.md:82-97). An idle runner is a prepared
bundle, not a process, so idle cost stays within the per-slot CPU and RAM that already count as real
node usage (rt:90-92; packages/contracts/src/compute-pool.ts:26-51). The profile gains the PostgreSQL
image digest and the launcher and proxy hashes (compute-pool.ts:14-25); a database on another image
gets a `sandbox_hit`. More than 16 slots per node needs `COMPUTE_POOL_LIMITS.max_slots` raised
(compute-pool.ts:6-13).

## 5. Binding and CNPG ownership

| Concern | Owner |
| --- | --- |
| Pod name, namespace, ServiceAccount, PVC, labels | CNPG, unchanged [U12] |
| Volume mount | kubelet and OpenEBS, unchanged; OpenEBS's single-mount guard stays intact [U13] |
| Network namespace and policy | containerd and Cilium, unchanged; policies select `cnpg.io/cluster=database` (nc/manifests.rs:207-228) |
| Starting PostgreSQL on a runner hit | PGCF launcher |
| Supervision after adoption, archiving, backups, roles, fencing, restarts, hibernation | CNPG |

**Eligibility.** All of the following must hold, otherwise the wake is a `sandbox_hit`:
- The Pod is a CNPG instance Pod of Cluster `database` in `pgcf-db-<id>` on `db.node`, and the
  `postgres` container in its `cnpg.io/podSpec` annotation [U12] matches the release template.
- The wake permission is valid for this node, boot, operation and namespace.
- The applied configuration fingerprint (packages/contracts/src/reclaim.ts:301-379: image, size,
  role revisions, storage) equals the desired one. The CNPG operator, barman plugin, PostgreSQL image
  and fleet assignment revision equal the sleep record (§7).
- `spec.instances` is 1 (nc/manifests.rs:341), the Cluster is not a replica cluster, and
  `status.targetPrimary` and `status.currentPrimary` both equal the Pod name, so CNPG's demotion
  branch cannot run against the live server [U14]. The primary Lease is free or held by the Pod name,
  the identity CNPG itself reuses [U15].
- The device-mapper UUID of the mounted pgdata device equals the LV UUID of the thin authority or the
  legacy binding (packages/contracts/src/storage-write-authority.ts:17-62). `PG_VERSION` matches the
  image, and pg_control reads `shut down` with the recorded system identifier.
- The exclusive-writer check passes (§9).

**Runner container.** The sandbox controller creates it in the slot's shim and registers it as a
containerd container bound to the Pod's sandbox ID, without CRI labels, so the existing inventory
lists it (sc/controller.rs:757-776). It joins the Pod's network, IPC and UTS namespaces through the
holder and has its own PID and mount namespaces. Its cgroup is a child of the Pod cgroup with the
`postgres` container's limits. Its mounts are bind clones of this Pod's kubelet volume directories:
pgdata, `scratch-data` at `/controller`, `shm`, `plugins` and the projected token. Its security fields
come from the fixed template (§9). The launcher binary sits in the runner's own rootfs layer, not in a
host mount or a tenant volume.

**Launcher** (static Rust, uid 26, no capabilities, every descriptor `O_CLOEXEC`):
1. Reads the Cluster, its server and CA Secrets and the Lease with the Pod's own token and CNPG's
   per-Cluster Role, and rechecks the Cluster conditions above.
2. Writes the TLS files that `postgresql.conf` names, where and as CNPG writes them [U8]. Creates
   `/controller/run` and CNPG's log FIFOs and drains them into a bounded buffer.
3. Starts `postgres -D $PGDATA` as its child with CNPG's environment and process group [U4]. The
   server reads CNPG's mandatory settings from PGDATA, including CNPG's `archive_command` and
   `restart_after_crash = off` [U16]. The launcher never runs initdb and never edits configuration.
4. On the aliased Start, `dup2`s CRI's stdio, writes the buffered log lines, and `execve`s CRI's exact
   argv and environment, i.e. CNPG's `/controller/manager instance run`. The instance manager rewrites
   identical certificates and configuration without a reload, takes the Lease under the same
   identity [U14], detects the live child postmaster [U17] and adopts it [U4], as it does after its
   own in-place upgrade [U5].

**Alias proxy.** A per-slot task-v3 service sits in front of the stock shim; Start returns its address
instead of the shim's (sc/controller.rs:1305-1313). It forwards every call. On `CreateContainer` for
`postgres` it compares CRI's OCI spec with the runner's: image digest, user and groups, capabilities,
`NoNewPrivs`, seccomp, read-only root, masked paths, mount sources, resources and the CNPG variables
`POD_NAME`, `PGDATA`, `NAMESPACE`, `CLUSTER_NAME`, `PGHOST`, `PGPORT` and `TMPDIR`. Only the rootfs
snapshot (same image digest plus the launcher file), `/etc/hosts` and `/dev/termination-log` may
differ. If the specs match, the container's task calls (Start, Kill, Wait, Exec, Stats, Update,
Delete) go to the runner. After the runner exits, the alias is retired and any later container is
ordinary.

**Pre-adoption window (Decision 1).** It runs from postmaster start to adoption and is bounded by an
adoption deadline derived from Gate 0's measured kubelet chain. Committed data is durable on the local
volume. CNPG's `archive_command` fails until the init container has copied `/controller/manager` and
the instance manager runs: the archiver exits on "command not found" and is restarted at most every
10 s, and after three failures it waits up to 60 s or until another segment is ready [U18]. WAL
completed in the window therefore reaches R2 after adoption. Established databases already do not
gate admission on archive continuity (nc/reconcile.rs:1089-1096; rt:240). No backup or role change
runs before adoption.

## 6. Readiness and routing

- **Fresh checks before admission** (rt:238, rt:358). The native controller dials the Pod IP with TLS
  name `database-rw.pgcf-db-<id>.svc` and the CNPG CA. It cannot use the Service as it does today
  (nc/postgres.rs:80), because the Service has no Ready primary endpoint before adoption. It runs the
  sleep proof's identity query (database, not in recovery, TLS; nc/power.rs:1139-1156), checks every
  role Secret against the Cluster status CNPG persisted (nc/reconcile.rs:84-131), logs in as every
  role and checks its settings and privileges (nc/postgres.rs:95-110), and checks the CA, applied
  objects and volume binding (nc/reconcile.rs:1042-1088). Only then does `finish_running` open the
  power fence (nc/power.rs:1706-1728), and the observation is published at once. If a check cannot
  pass before adoption, admission waits for CNPG readiness; nothing is revoked because nothing was
  admitted.
- **Runner proof** from the sandbox controller: node UID and boot ID, slot and sandbox IDs, Pod UID
  and the IP read from the network namespace, PVC, PV and LV UUID, storage generation, claim
  operation, pg_control state before start, system identifier, image digest, launcher hash,
  postmaster PID and start time. Cloudflare admits only when this proof and the controller's
  observation agree with each other and with the claim.
- **Admission** is pushed to the Actor when the second proof arrives, replacing the 250 ms D1 poll
  (actor:788-839; rt §10).
- **Routing.** The route token carries the route revision and the target: Pod UID, IP and node
  (rt:296). The gateway checks it against its fence and storage watches and dials the IP (rt §6).
  Today it routes only to the Ready EndpointSlice writer (apps/native-gateway/README.md:41-48); that
  changes. For thin volumes the controller requests the Pod-bound write authority as soon as the Pod
  exists.
- **After adoption** the full chain runs in the background: Cluster Ready, a Ready `postgres`
  container with the expected image, and the runtime attestation with the CRI container ID
  (nc/reconcile.rs:992-1137). A failure revokes the route: the fence closes, sessions close and no
  uncertain write is replayed (rt:250).
- Misses and sandbox hits keep the full chain before admission, with the same immediate publication.

## 7. Idle detach and the API idle setting (1–15 min)

- **Setting.** `sleep_after_seconds` on the size class or resource profile accepts 60–2,592,000 s, or
  `null` for always warm (packages/contracts/src/api.ts:205); 1–15 minutes is 60–900. Size classes in
  use are immutable (apps/api/src/platform/size-classes.ts:53-72, 92-96), so a change is a new
  revision through `PUT /v1/resource-profiles/{id}`, assigned with
  `PUT /v1/databases/{id}/resource-profile` (apps/api/src/domain/resource-profiles.ts:54-118, 170-187).
  The value is outside the configuration fingerprint (packages/contracts/src/reclaim.ts:301-379), so
  changing it does not make a database ineligible. No new field is needed.
- **"Is the database still in use?"** Each regional activity report updates the Actor
  (apps/api/src/domain/agent-metrics.ts:84-110). The Actor hibernates only when no connection is busy
  and no authenticated activity occurred for `sleep_after_seconds` (actor:959-985). The sleep proof
  then refuses busy sessions and open or prepared transactions, quiesces the gateway, switches WAL
  and waits for the closed segment's archive `.done` (nc/power.rs:1091-1225).
- **Sleep record (new).** With the hibernated observation the controller stores in D1 the Cluster's
  `status.systemID` (CNPG clears it once no instance reports [U19]), the applied fingerprint, the
  CNPG, barman plugin and PostgreSQL releases, the fleet assignment revision and the LV UUID. The
  next claim and its permission carry these values.
- **Detach** is today's hibernation: `cnpg.io/hibernation=on`; CNPG deletes the Pod; the instance
  manager shuts PostgreSQL down within `stopDelay`; kubelet stops the containers; sandbox Stop kills
  whatever remains in the runner cgroup and waits until it is empty before `note_stopped`; Shutdown
  destroys holder, shim and runner; `maintain()` refills to X.
- **Clean shutdown.** The next runner hit needs pg_control `shut down`. Retained thick volumes use
  CNPG's default `stopDelay`; thin profiles bound the shutdown by `drain_seconds` (1–120 s) with
  `smartShutdownTimeout` 0 (nc/manifests.rs:346-348; packages/contracts/src/database-storage.ts:28).
  Gate 0 records pg_control at every wake. Only if an unclean stop is observed, add an explicit
  `CHECKPOINT` to the sleep proof; `pgcf_maintenance` then needs `pg_checkpoint`
  (packages/contracts/src/maintenance.ts:14-19). Fencing before hibernation would bound the stop by
  `switchoverDelay` instead, but CNPG then hibernates only a Healthy cluster, which a recreated
  fenced Pod blocks [U20][U21]. An unclean stop costs a miss with CNPG crash recovery, never data.
- Explicit suspension still means real hibernation and an authorized resume (rt:205). Warm reclaim
  is unchanged (rt §12).

## 8. Failure handling

| Situation | Behaviour |
| --- | --- |
| No matching permission before the claim expires, or eligibility fails | No runner. CNPG starts PostgreSQL in the slot, with crash recovery if needed, labelled `sandbox_hit` or `miss`. Nothing is resent to reuse a slot. |
| Claim outcome uncertain (no proof by expiry) | Admission stays closed for that operation; the node kills the runner when the permission expires; the Pod continues on CNPG's path. |
| Exclusive-writer check fails | Sandbox Create is refused, so no PostgreSQL starts; the conflict is reported and needs recovery. |
| Server not ready by the bind deadline | Smart, then fast shutdown, then `cgroup.kill`; wait until the cgroup is empty; CRI's `postgres` container then starts as an ordinary container. No proof is published. |
| A fresh check cannot pass before adoption | No admission until CNPG readiness; nothing to revoke. |
| Adoption deadline passes (sidecar never Ready, Pod stuck) | Route revoked: the fence closes, sessions close, nothing is replayed. Fast shutdown, kill, wait; CNPG's ordinary path continues. |
| CRI spec differs from the runner | Alias refused; handled as the previous row. |
| Launcher or postmaster dies before adoption | The runner's PID namespace ends; route revoked; WAL is durable; CNPG later starts PostgreSQL with crash recovery. |
| Pod deleted before adoption | Sandbox Stop: fast shutdown within the Pod's grace period, kill, wait, then `note_stopped`; slot destroyed. |
| Sandbox controller or containerd restarts | Runner state is in `owner.json` (pidfd identity, start ticks, boot ID). An unadopted runner that cannot be re-verified is killed and its route revoked; an adopted runner is an ordinary task of the sandbox. |
| Proxy crash | Restart on the same socket from the persisted alias map; otherwise kill the sandbox's tasks so that CNPG recreates the Pod. |
| Node reboot | Slots and runners die; owner records of an old boot are never reused; pg_control reads `in production`, so the next wake is a miss with CNPG crash recovery. |
| Two wakes, one ready slot | One `runner_hit`; the other gets an on-demand slot and is a `miss`. |
| Thin write authority expires | The existing guard suspends the device and stops the Pod's tasks (sc/storage.rs:813-837), now including the runner. |

## 9. Isolation

- **Tenant-free until bound.** A ready slot holds no tenant data. The runner exists only after the
  slot is bound to one CNPG instance Pod and is destroyed with it (rt:93-96;
  apps/sandbox-controller/README.md:49-58).
- **Same profile as CNPG's `postgres` container:** uid and gid 26, all capabilities dropped,
  `NoNewPrivs`, RuntimeDefault seccomp, read-only root, masked and read-only paths, no devices. These
  fields come from a fixed template qualified per release and never from `cnpg.io/podSpec`, which
  CNPG writes before admission and which lacks admission-added volumes [U12]; the annotation only
  supplies identity fields, which are checked. Pod Security `restricted` (nc/manifests.rs:194) and
  the Pod spec are unchanged.
- **Privileged work stays in the sandbox controller**, which already runs in CRI's context
  (apps/sandbox-controller/README.md:34-47): resolving kubelet volume paths with
  `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`, checking the LV identity on the opened mount, and
  `runc create`. The launcher holds no privilege.
- **Credentials.** Only the Pod's own projected token with CNPG's per-Cluster Role. TLS keys are
  written where CNPG writes them. There is no new RBAC, nothing secret is logged, and Cloudflare never
  sees a TLS key.
- **Network.** Cilium and NetworkPolicy rules for `cnpg.io/cluster=database` apply from the first
  packet, because CNI runs before the sandboxer [U10] (nc/manifests.rs:207-228).
- **Single writer.** PostgreSQL's shared-memory interlock works only within one IPC namespace [U22],
  CNPG's postmaster check only within one PID namespace [U17], and OpenEBS's mount guard only within
  its own mount namespace [U13]; retained thick volumes have no old-writer check in `permits_create`
  (sc/storage.rs:396-397). Therefore the runner shares the Pod's IPC namespace, lives in the Pod's
  cgroup and is visible to every stop path, and Stop returns an error until that cgroup is empty, so
  kubelet keeps retrying the teardown instead of reporting the sandbox stopped. Before any postmaster
  starts on the pool runtime, the sandbox controller requires that every mount of the PGDATA device,
  in any mount namespace, belongs to this Pod (kubelet's volume path for this Pod UID or a process in
  this Pod's cgroup), and for thin volumes that the device-mapper open count matches
  (sc/storage_dm.rs:20).
- **Abuse.** A wake still starts before SCRAM (rt §11). A claim passes the Actor's existing admission
  (known database and role, admission limits; rt:280); exhaustion only produces labelled misses.

## 10. Component changes

| Component | Change |
| --- | --- |
| `packages/contracts` | Profile gains the PostgreSQL image digest and the launcher and proxy hashes (compute-pool.ts:14-25); wake permission and runner proof; sleep record on the hibernated observation; labels `runner_hit`, `sandbox_hit` and `miss` with stage timestamps in the pool observation (compute-pool.ts:109-121); versioned route token with target (rt:296). |
| `apps/api` | Claim in the wake commit (actor:584-600); signed permission over a held lease request; runner-proof endpoint; Actor admission pushed when both proofs match, replacing the D1 poll (actor:788-839); route token with target; revocation after a background failure; sleep record in D1. |
| `apps/native-controller` | Pool-hit readiness by direct dial before `finish_running` (§6); background full verification; sleep record; thin Pod-bound authority requested when the Pod appears. |
| `apps/sandbox-controller` | Runner bundle per slot; bounded wait for the permission in Create; eligibility and exclusive-writer checks; runner registered under the sandbox ID inside the Pod cgroup; proof push; adoption deadline; Stop, Shutdown and storage-expiry stop extended to a clean shutdown of an unadopted runner, `cgroup.kill`, wait until empty, then `note_stopped` (sc/controller.rs:999-1130, 1380-1501); runner state in `owner.json`; stage timestamps. |
| New `pgcf-launcher` | §5; static Rust binary shipped in the sandbox extension. |
| New per-slot task proxy | §5; Rust, shipped in the sandbox extension. |
| `apps/native-gateway` | Accepts the token target after fence and storage-binding checks and dials its IP (rt §6). |
| `infra/talos/sandbox` | Ships and wires launcher and proxy; `runtime-admission.ts` is unchanged. |
| Unchanged | CNPG 1.30.1, plugin-barman-cloud 0.15.1, PostgreSQL 18.6, Kubernetes 1.36.5, containerd 2.3.6, runc 1.5.2, OpenEBS LVM LocalPV 1.10.1, Cilium, Talos 1.14.2. |

Order: first the approved work every wake needs (immediate controller publication, Actor push, route
token with target and direct gateway dial; rt §6, §9, §10) and the bounded permission wait; then Gate
0; then the sleep record, runner, launcher and proxy, only after Decision 1 and a passing Gate 0, or
after Decision 2 chooses to build anyway. Launcher and proxy ship in the sandbox extension, so each
change needs a fleet release on EU1 (infra/talos/sandbox/README.md:4-10).

## 11. Acceptance measurements

**Gate 0: measure before building the runner** (closes plan:117). Run it on EU1, first on the standard
runtime, then with the R2 pool once that is live (plan:96). Kubernetes object times have one-second
resolution, so use millisecond stamps from the controller's watch receipts, containerd's CRI log,
Cilium's endpoint creation, the sandbox controller and CNPG's JSON log. Per wake, from the
client-connect instant: claim committed; hint received; hibernation off; Pod added; Pod bound;
RunPodSandbox start (the end of kubelet's admission and volume wait); CNI done; sandbox Create; init
container exit; sidecar startup probe passed; `postgres` started; PostgreSQL start → "database system
is ready to accept connections"; Pod Ready; Cluster Ready; ready observation; admission; gateway dial;
AuthenticationOk; first row. Also record:
- how long kubelet takes to apply `fsGroup` 26 to PGDATA on mount (CNPG sets fsGroup without a
  change policy [U12]); if it is material, set `fsGroupChangePolicy: OnRootMismatch` through the
  Cluster's `podSecurityContext`, which helps every wake;
- the pg_control state at every wake;
- the split of the 0.69–0.93 s awake path into the parts before and after readiness.

**Stop rule.** If the median of connect → sandbox Create, plus the measured clean PostgreSQL start,
plus the fresh checks, plus the post-readiness part of the awake path reaches one second, the runner
cannot pass the pool-hit gate. Record the incompatibility (rt:122-127) and take Decision 2 before
building the runner.

**Pool-hit acceptance** (rt:185-194, rt:392-397; plan:97). A real slot is ready before demand. Connect
normally through Cloudflare to a sleeping database with no running compute and measure `connect_ms`
and `first_read_ms` from one instant. Break down every Gate 0 stage plus runner create, Lease and
Secret reads, postmaster ready, both proofs, admission, token, dial, TLS, AuthenticationOk and first
row. Label each run `runner_hit`, `sandbox_hit` or `miss`. The marker must be preserved and the slot
count must return to X.

**CNPG ownership on every runner hit.** The instance manager logs "Detected alive postmaster from PID
file" for the runner's child [U17] and no second postmaster starts; the instance manager is the
runner's PID 1; the primary Lease is held by the Pod name; Pod and Cluster are Ready; after
`pg_switch_wal()` the segment reaches R2; WAL completed in the window is archived and its lag
recorded; a plugin backup succeeds; a managed-role password change applies; the adoption delay stays
below the deadline; the window's log lines appear in the container log.

**Detach.** With `sleep_after_seconds` at 60 and at 900, hibernation follows idleness; the next wake
reads pg_control `shut down`; the slot is destroyed and not reused; no mount namespace still holds the
LV, and for thin volumes the open count is 0; the slot count returns to X.

**Focused failure tests, one each:** launcher killed before adoption; Pod deleted before adoption;
sidecar never Ready; sandbox controller restarted during binding; containerd restarted with a runner
present; CRI spec mismatch; node reboot with a bound slot; two wakes with one ready slot; a leftover
process holding the volume blocks the next start.

**Release qualification.** Each change of CNPG, the barman plugin, containerd, runc or PostgreSQL
reruns the adoption and alias checks before a profile with the new hashes is approved.

## 12. Rejected alternatives with reasons

1. **Adopt a prestarted generic Pod into the Cluster.** Volumes, environment and ServiceAccount are
   fixed at creation [U1], a Pod cannot change namespace, and CNPG runs only its own Pods
   (rt:131-143).
2. **Pre-create the instance Pod under CNPG's name.** It needs the tenant PVC at creation, so it is
   never unassigned, and it breaks CNPG's rule that a Pod name is reused only after the previous
   incarnation is dead [U15].
3. **Resume hibernation into an existing Pod.** Resume always creates a Pod [U2].
4. **A CNPG-I plugin that defers the volume or gates the start.** CNPG-I 0.6.0 has no attach, rebind
   or instance-side start call (rt:138-141), and the instance manager writes PGDATA in its first
   reconcile [U8].
5. **Swap PGDATA under a running or fenced slot.** Forbidden (rt:111-112).
6. **Change a running Pod** through an update, ephemeral containers, in-place resize, or inline or
   generic ephemeral volumes. Volumes cannot be added [U1], kubelet mounts before any container runs
   [U6], and generic ephemeral volumes create a new, empty PVC (rt:112).
7. **Parked CNPG Pods per database through fencing**, the "wake without a new Pod" option of plan:118.
   One Pod per database is not the pool (rt:70-72) and cannot satisfy its acceptance (rt:9-11,
   rt:194). Parked Pods keep their requests, against the sleeping-CPU release (rt:5-7, plan:99).
   Demotion to hibernation stalls once a parked Pod has been recreated, because CNPG hibernates only a
   Healthy cluster [U20] and a fenced, NotReady instance keeps it from becoming Healthy [U21]. The
   4–5 s after Ready remain. Its eligibility predicate and labels are reused here.
8. **PGCF-supervised PostgreSQL in pre-created pool Pods, with the volume late-bound through a
   memory-backed emptyDir and HostToContainer propagation.** It is the only option that removes Pod
   creation from the hit path. But CNPG would not own the process: archiving, backups, roles and
   fencing move to PGCF; a shared pool namespace needs the tenant's network identity and secret
   custody; and the volume needs its own authority against the hibernated Cluster. This is the
   Decision 2 escalation and needs its own design (rt:122-127).
9. **NRI mount injection, hostPath slots, mount-namespace injection.** They only serve option 8.
   hostPath is forbidden under Pod Security `restricted` (nc/manifests.rs:194); NRI and
   namespace injection bypass admission, kubelet and OpenEBS's mount guard.
10. **A disk-backed emptyDir as the propagation anchor.** Its teardown deletes recursively across mount
    points [U23].
11. **Start CNPG's instance manager and sidecar early in the slot.** CNPG's boot stays on the path, two
    containers need aliasing, and it races the init container's copy of the manager.
12. **Serve before CNPG creates the Pod.** containerd creates the network namespace and runs CNI only
    for a real Pod sandbox [U10], and OpenEBS refuses a second mount [U13]; serving earlier would bypass
    Cilium policy and the single-writer guard.
13. **VM pools and snapshots** (Kata VMCache, microVMs). They need KVM, which the Contabo VPS lack
    (rt:163-171).

## Upstream sources

- [U1] Kubernetes 1.36.5, updatable Pod spec fields:
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/apis/core/validation/validation.go#L5691-L5697
- [U2] CNPG 1.30.1, a new Pod for a dangling PVC:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/cluster_create.go#L1579-L1603
- [U3] Neon `compute_ctl` states (Empty, ConfigurationPending, Running):
  https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/compute_tools/README.md#L35-L55
- [U4] CNPG 1.30.1, `Instance.Run` adopts a live postmaster or starts one:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/management/postgres/instance.go#L785-L830
- [U5] CNPG 1.30.1, in-place instance-manager upgrade by `syscall.Exec` while PostgreSQL runs:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/management/upgrade/upgrade.go#L183-L196 and
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/cmd/manager/instance/run/lease/runnable.go#L175-L187
- [U6] Kubernetes 1.36.5 kubelet, PLEG relist period and volume wait before the runtime:
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/kubelet/kubelet.go#L215 and
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/kubelet/kubelet.go#L2195-L2196
- [U7] plugin-barman-cloud 0.15.1, sidecar startup probe:
  https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.1/internal/cnpgi/operator/lifecycle.go#L440-L468
- [U8] CNPG 1.30.1, first instance reconcile (plugins, certificates, configuration, initialize):
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/management/controller/instance_controller.go#L145-L230
- [U9] Kubernetes 1.36.5, volume manager loop and retry intervals:
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/kubelet/volumemanager/volume_manager.go#L57-L79
- [U10] containerd 2.3.6, network namespace and CNI before `CreateSandbox`:
  https://github.com/containerd/containerd/blob/v2.3.6/internal/cri/server/sandbox_run.go#L208-L281
- [U11] PostgreSQL 18.6, postmaster.pid status line:
  https://github.com/postgres/postgres/blob/REL_18_6/src/include/utils/pidfile.h#L44-L54
- [U12] CNPG 1.30.1, Pod security context with fsGroup, `cnpg.io/podSpec` annotation, Pod name:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/pods.go#L447-L470,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/pods.go#L499-L505 and
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/pods.go#L530-L540
- [U13] OpenEBS LVM LocalPV 1.10.1, single-mount guard:
  https://github.com/openebs/lvm-localpv/blob/v1.10.1/pkg/lvm/mount.go#L128-L173
- [U14] CNPG 1.30.1, primary start gated on the Lease, and the demotion branch:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/management/controller/instance_startup.go#L61-L168
- [U15] CNPG 1.30.1, Lease identity is the Pod name:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/cmd/manager/instance/run/lease/runnable.go#L124-L137
- [U16] CNPG 1.30.1, mandatory PostgreSQL settings:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/postgres/configuration.go#L560-L600
- [U17] CNPG 1.30.1, live-postmaster detection and stale PID cleanup:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/management/postgres/pidfile.go#L50-L108
- [U18] PostgreSQL 18.6, archiver intervals and FATAL on "command not found":
  https://github.com/postgres/postgres/blob/REL_18_6/src/backend/postmaster/pgarch.c#L62-L71 and
  https://github.com/postgres/postgres/blob/REL_18_6/src/backend/archive/shell_archive.c#L83-L93
- [U19] CNPG 1.30.1, `status.systemID` cleared when no instance reports:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/cluster_status.go#L779-L814
- [U20] CNPG 1.30.1, hibernation deferred unless the cluster is Healthy:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/reconciler/hibernation/status.go#L93-L104
- [U21] CNPG 1.30.1, cluster reconcile requeues while instances are not Ready:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/cluster_controller.go#L1146-L1154
- [U22] PostgreSQL 18.6, shared-memory interlock:
  https://github.com/postgres/postgres/blob/REL_18_6/src/backend/port/sysv_shmem.c#L435-L453
- [U23] Kubernetes 1.36.5, emptyDir teardown:
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/volume/emptydir/empty_dir.go#L528-L556
- [U24] PostgreSQL 18, `data_directory` can only be set at server start:
  https://www.postgresql.org/docs/18/runtime-config-file-locations.html
- [U25] Linux 6.18.54, a further mount of a mounted block device reuses its superblock; the first
  mount opens the device with the superblock as holder:
  https://github.com/gregkh/linux/blob/v6.18.54/fs/super.c#L1673-L1714 and
  https://github.com/gregkh/linux/blob/v6.18.54/fs/super.c#L1616-L1623
- [U26] Linux 6.18.54, exclusive block-device claims, per-open disk accounting and userspace
  `O_EXCL` as exclusive open:
  https://github.com/gregkh/linux/blob/v6.18.54/block/bdev.c#L535-L551,
  https://github.com/gregkh/linux/blob/v6.18.54/block/bdev.c#L711-L737,
  https://github.com/gregkh/linux/blob/v6.18.54/block/bdev.c#L921-L930 and
  https://github.com/gregkh/linux/blob/v6.18.54/block/fops.c#L649-L688
- [U27] Linux 6.18.54, device-mapper open count and its report in `DM_DEV_STATUS`:
  https://github.com/gregkh/linux/blob/v6.18.54/drivers/md/dm.c#L314-L360 and
  https://github.com/gregkh/linux/blob/v6.18.54/drivers/md/dm-ioctl.c#L844-L849
- [U28] Linux 6.18.54, iteration over every mount namespace and each mount's superblock device:
  https://github.com/gregkh/linux/blob/v6.18.54/include/uapi/linux/nsfs.h#L28-L41,
  https://github.com/gregkh/linux/blob/v6.18.54/fs/nsfs.c#L320-L360,
  https://github.com/gregkh/linux/blob/v6.18.54/fs/namespace.c#L2103-L2133,
  https://github.com/gregkh/linux/blob/v6.18.54/fs/namespace.c#L5159-L5165,
  https://github.com/gregkh/linux/blob/v6.18.54/fs/namespace.c#L5790 (`statmount`) and
  https://github.com/gregkh/linux/blob/v6.18.54/fs/namespace.c#L5944 (`listmount`)
- [U29] Linux 6.18.54, a non-lazy unmount fails while any propagated copy is busy; a lazy one
  detaches regardless:
  https://github.com/gregkh/linux/blob/v6.18.54/fs/namespace.c#L1947-L1958 and
  https://github.com/gregkh/linux/blob/v6.18.54/fs/pnode.c#L423-L453
- [U30] Linux 6.18.54, shared and slave mounts:
  https://github.com/gregkh/linux/blob/v6.18.54/Documentation/filesystems/sharedsubtree.rst#L262-L283
- [U31] LVM2 2.03.32, the `lvm2` of Alpine 3.22, on which the pinned driver image is built
  (https://github.com/openebs/lvm-localpv/blob/v1.10.1/buildscripts/lvm-driver/Dockerfile.buildx#L44-L45;
  the exact package in the image is not verified); local VGs and exclusive activation through
  lvmlockd:
  https://github.com/lvmteam/lvm2/blob/v2_03_32/man/lvmlockd.8_main#L258-L264 and
  https://github.com/lvmteam/lvm2/blob/v2_03_32/man/lvmlockd.8_main#L530-L541
- [U32] OpenEBS LVM LocalPV 1.10.1, LV creation without an activation option, device path,
  publish and unpublish without staging, and the node plugin's Bidirectional kubelet mount:
  https://github.com/openebs/lvm-localpv/blob/v1.10.1/pkg/lvm/lvm_util.go#L229-L264,
  https://github.com/openebs/lvm-localpv/blob/v1.10.1/pkg/lvm/lvm_util.go#L671-L680,
  https://github.com/openebs/lvm-localpv/blob/v1.10.1/pkg/driver/agent.go#L241-L322,
  https://github.com/openebs/lvm-localpv/blob/v1.10.1/pkg/driver/agent.go#L381-L407 and
  https://github.com/openebs/lvm-localpv/blob/v1.10.1/deploy/helm/charts/templates/lvm-node.yaml#L126-L134
- [U33] OpenEBS lib-csi 0.9.0, pinned at
  https://github.com/openebs/lvm-localpv/blob/v1.10.1/go.mod#L14; the guard compares the source
  string in the caller's mount table:
  https://github.com/openebs/lib-csi/blob/v0.9.0/pkg/mount/mount_utils.go#L23-L43
- [U34] Kubernetes 1.36.5, mount propagation validation and kubelet's translation for CRI:
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/apis/core/validation/validation.go#L1427-L1455 and
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/kubelet/kubelet_pods.go#L428-L446
- [U35] Kubernetes 1.36.5, Pod Security restricted volume types, and the policy directory with
  the 19 checks, none of which reads `mountPropagation`:
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/staging/src/k8s.io/pod-security-admission/policy/check_restrictedVolumes.go#L88-L104 and
  https://github.com/kubernetes/kubernetes/tree/v1.36.5/staging/src/k8s.io/pod-security-admission/policy
- [U36] Kubernetes 1.36.5, emptyDir permission, SetUp with ownership change, memory and default
  teardown, and no ownership change without fsGroup:
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/volume/emptydir/empty_dir.go#L51,
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/volume/emptydir/empty_dir.go#L235-L287,
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/volume/emptydir/empty_dir.go#L496-L556 and
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/volume/volume_linux.go#L71-L74
- [U37] Kubernetes 1.36.5, Pod deletion waits for unmounted volumes; orphaned-Pod cleanup stays on
  one filesystem:
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/kubelet/kubelet.go#L2458-L2493,
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/kubelet/status/status_manager.go#L1241-L1257 and
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/kubelet/kubelet_volumes.go#L76-L164
- [U38] Kubernetes 1.36.5, in-place Pod resize is generally available:
  https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/features/kube_features.go#L1534-L1538
- [U39] containerd 2.3.6, HostToContainer requires a shared or slave source and binds `rslave`:
  https://github.com/containerd/containerd/blob/v2.3.6/internal/cri/opts/spec_linux_opts.go#L166-L174 and
  https://github.com/containerd/containerd/blob/v2.3.6/internal/cri/opts/spec_linux_opts.go#L275-L291
- [U40] Talos 1.14.2: Linux 6.18.54, kubelet binds `/var/lib/kubelet` `rbind,rshared`, and CRI,
  kubelet and Pods share the sandbox PID+mount namespace under workload isolation:
  https://github.com/siderolabs/talos/blob/v1.14.2/hack/release.toml#L34,
  https://github.com/siderolabs/talos/blob/v1.14.2/internal/app/machined/pkg/system/services/kubelet.go#L166,
  https://github.com/siderolabs/talos/blob/v1.14.2/internal/app/machined/pkg/sandboxd/init.go#L5-L6 and
  https://github.com/siderolabs/talos/blob/v1.14.2/internal/app/machined/pkg/system/services/cri.go#L189-L194
- [U41] CNPG 1.30.1, a hibernated Cluster's reconcile returns before Pods are reconciled:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/cluster_controller.go#L551-L563 and
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/reconciler/hibernation/reconciler.go#L36-L64
- [U42] CNPG 1.30.1, Backups of a hibernated Cluster fail; ScheduledBackup creates them
  regardless:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/backup_controller.go#L389-L409,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/scheduledbackup_controller.go#L111-L131 and
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/scheduledbackup_controller.go#L240-L269
- [U43] CNPG 1.30.1, the primary Lease: start gate, take-over, release, operator creation and
  defaults:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/management/controller/instance_startup.go#L72-L87,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/management/controller/instance_controller.go#L201-L230,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/cmd/manager/instance/run/lifecycle/run.go#L78-L103,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/cmd/manager/instance/run/lease/runnable.go#L188-L228,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/cmd/manager/instance/run/lease/runnable.go#L301-L353,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/primary_lease.go#L47-L95 and
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/api/v1/cluster_types.go#L1462-L1473
- [U44] CNPG 1.30.1, the instance layout: local peer rule and ident map, `/controller` paths,
  PGDATA path, volumes and the init container that copies the manager:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/postgres/configuration.go#L103-L105,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/postgres/configuration.go#L133-L141,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/postgres/configuration.go#L170-L213,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/postgres/configuration.go#L240-L247,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/pods.go#L84-L88,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/volumes.go#L98-L121,
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/volumes.go#L236-L256 and
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/containers.go#L32-L42
- [U45] CNPG 1.30.1, TLS Secret names:
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/api/v1/cluster_funcs.go#L636-L662 and
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/api/v1/cluster_types.go#L49-L57
- [U46] The empty-archive marker and the plugin's archive steps; CNPG 1.30.1
  https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/management/controller/instance_controller.go#L1143-L1158,
  plugin-barman-cloud 0.15.1
  https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.1/internal/cnpgi/metadata/constants.go#L49-L52 and
  https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.1/internal/cnpgi/common/wal.go#L107-L229
- [U47] plugin-barman-cloud 0.15.1, backup and retention run in the instance sidecar, retention
  only on the current primary, with Barman 3.20.1:
  https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.1/internal/cnpgi/instance/backup.go#L71-L129,
  https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.1/internal/cnpgi/instance/retention.go#L124-L166 and
  https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.1/containers/sidecar-requirements.txt#L21
- [U48] barman-cloud library 0.6.0, pinned at
  https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.1/go.mod#L8; option builders for
  WAL archive, backup and retention:
  https://github.com/cloudnative-pg/barman-cloud/blob/v0.6.0/pkg/archiver/command.go#L33-L89,
  https://github.com/cloudnative-pg/barman-cloud/blob/v0.6.0/pkg/command/commandbuilder.go#L79-L91,
  https://github.com/cloudnative-pg/barman-cloud/blob/v0.6.0/pkg/backup/backup.go#L91-L133 and
  https://github.com/cloudnative-pg/barman-cloud/blob/v0.6.0/pkg/command/backupdelete.go#L35-L64
- [U49] PostgreSQL 18.6, postmaster.pid and shared-memory interlock:
  https://github.com/postgres/postgres/blob/REL_18_6/src/backend/utils/init/miscinit.c#L1351-L1409 and
  https://github.com/postgres/postgres/blob/REL_18_6/src/backend/port/sysv_shmem.c#L317-L336
- [U50] PostgreSQL 18.6, pg_control states and archive completion:
  https://github.com/postgres/postgres/blob/REL_18_6/src/include/catalog/pg_control.h#L89-L98,
  https://github.com/postgres/postgres/blob/REL_18_6/src/bin/pg_controldata/pg_controldata.c#L50-L67,
  https://github.com/postgres/postgres/blob/REL_18_6/src/backend/postmaster/pgarch.c#L475-L478 and
  https://github.com/postgres/postgres/blob/REL_18_6/src/backend/postmaster/pgarch.c#L809-L833
- [U51] PostgreSQL 18, command-line settings override postgresql.conf and ALTER SYSTEM:
  https://www.postgresql.org/docs/18/config-setting.html#CONFIG-SETTING-SHELL
- [U52] Cilium 1.20.2, identity label rules, the chart's `labels` option, CRD identity allocation
  and the identity change grace period:
  https://github.com/cilium/cilium/blob/v1.20.2/pkg/labelsfilter/filter.go#L57-L79,
  https://github.com/cilium/cilium/blob/v1.20.2/pkg/labelsfilter/filter.go#L158-L171,
  https://github.com/cilium/cilium/blob/v1.20.2/pkg/labelsfilter/filter.go#L218-L259,
  https://github.com/cilium/cilium/blob/v1.20.2/pkg/labelsfilter/filter.go#L297-L340,
  https://github.com/cilium/cilium/blob/v1.20.2/install/kubernetes/cilium/templates/cilium-configmap.yaml#L163-L175 and
  https://github.com/cilium/cilium/blob/v1.20.2/install/kubernetes/cilium/values.yaml#L2285-L2289
- [U53] Linux 6.18.54, when a PID namespace's init exits, every remaining process in it is killed:
  https://github.com/gregkh/linux/blob/v6.18.54/kernel/exit.c#L608-L633 and
  https://github.com/gregkh/linux/blob/v6.18.54/kernel/pid_namespace.c#L192-L231
