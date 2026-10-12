# Warm PostgreSQL pool

Status: **proposal of 2026-10-12** for the ULTRA rows "Cold-start baseline", "Sub-second decision"
and "Pool cold-start test" (plan:117, plan:118, plan:97). Not approved and not implemented. It
refines the approved shared-pool target (rt §4–§5) for the pinned, unmodified CNPG and answers
plan:118 with "prestarted PostgreSQL with late-bound storage" in the form CNPG permits.

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
