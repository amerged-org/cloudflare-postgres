# Parked instances: a sleep tier that keeps the Pod and stops PostgreSQL

Status: **implemented on branches, not deployed.** There is no release marker; the region policy
`parked_tier` is the only switch (no backwards compatibility in Dev). Live findings of 2026-10-15
changed section 3.3: the API keeps a stopping Pod's token until the controller's stop observation
commits, and the wake token for a parked Pod needs its fast-wake claim. The controller publishes a
resumed Pod on its attestation without the kubelet's Ready bit (section 2.2.1); that needs the
gateway change of section 5.4 on the same node, so a fleet patch applies the gateway first, then
the controller, in one release.
Design date: 2026-10-15. Repository snapshot: origin/main `95e64ab`; every
`path:line` below refers to that snapshot. CNPG citations (`cnpg:path:line`) refer to a clone of
the v1.30.1 tag (commit `2a35abb`, the version the repository pins); `cnpg-plugin:path:line` refers
to the plugin-barman-cloud v0.15.1 tag (pinned at `infra/platform/versions.lock.json:117`). `lab` is the
[lab measurement section](#lab-measurements) at the end (EU1 of 2026-10-15). `plan` is
`docs/architecture/cloudflare-convergence-and-serverless-plan.md`; `pool` is
`docs/architecture/warm-postgres-pool.md` at that snapshot (deleted since; git history keeps it); `rt` is
`docs/architecture/rust-runtime-and-cold-starts.md`.
No effort or duration estimates appear anywhere in this document (AGENTS.md); all times are
latencies or time-to-live values.

The shared warm pool that this design compares itself with and stays compatible with (alternative 8:
`pool`, the `postgres-pool*` modules and the `pool_*` tables) was deleted from the repository after
this snapshot (owner decision 2026-10-15). Its citations point at the snapshot, and the coexistence
rules written against it, such as `parked_json IS NULL` in pool claims, no longer have an
implementation.

## 0. Decision summary

1. **Mechanism.** After the unchanged sleep proof, fence the database's single CNPG instance
   (`cnpg.io/fencedInstances: ["*"]` on the Cluster) instead of switching hibernation on. The
   instance Pod, its mounted volume, its primary Lease, the instance manager and the barman
   sidecar stay; only the postmaster stops (CNPG's own fence: checkpoint, fast shutdown with
   immediate fallback). The controller shrinks the Pod's requests in place (`pods/resize`).
   Wake is unfence plus resize-up; demotion is hibernation.
2. **Customers see nothing new.** The public state stays `hibernated`
   (`apps/api/src/domain/rows.ts:95-101`). The additive hint is internal: observation field
   `power.parked`, D1 column `databases.parked_json`, region policy `parked_tier`.
3. **Who decides.** Cloudflare owns policy (enable, time-to-live, per-node cap, parked requests);
   the native controller executes it and demotes (TTL, oldest-first cap, drift). The API cron and
   the Actor do not demote.
4. **No host extension, driver or kernel change.** The host guard would freeze or kill a Pod
   whose lease entry is not `running` (`apps/sandbox-controller/src/storage.rs:579-595,764-877`).
   The API therefore presents a parked database to the guard as `running` with a valid runtime
   token naming the parked Pod (section 3.3). That is the only place where the lease and D1 differ.
   No thin requalification is triggered (plan:225-232).
5. **Latency.** The parked path removes Pod creation, sandbox/CNI/volume wait, init container,
   sidecar and instance-manager boot (Gate 0: connect to Pod Ready 6.1-6.8 s of 8.1-9.4 s, plan:126).
   Sub-second is not reachable with kubelet readiness in the loop (lab: unfence to PostgreSQL
   accepting 226-305 ms including a 160-207 ms laptop round trip; unfence to `readyInstances=1`
   564-753 ms). It needs a direct SQL readiness check, a gateway change that routes to the
   controller-attested Pod before its Ready condition (section 5.4), and trimming the
   post-readiness chain (section 6.4). Even then the allocations plus the measured awake floor give
   about 1.1-1.2 s; below 1 s needs a further 130-200 ms of removals (section 6.1). The budget in
   section 6.1 is honest about what is measured.
6. **Binaries that change:** API Worker, `pgcf-native-controller`, shared contracts (generated
   native constants), and (conditional second stage) `pgcf-native-gateway`. Unchanged: sandbox
   controller (host extension), OpenEBS driver image, Talos/kernel, node-bootstrap, Edge, relay.
7. **Documentation conflicts the owner must resolve** are listed in section 0.2; the parked tier
   contradicts the explicit "shared pool required, same-Pod results cannot substitute" text.

### 0.1 What was verified and what remains for live proof

| Fact | Status |
| --- | --- |
| Fence annotation is a JSON list of instance names; `"*"` fences all; empty list = unset (`cnpg:pkg/utils/fencing.go:48-79,95-110`, `cnpg:docs/src/fencing.md:22-30`) | verified in source |
| Fencing = checkpoint + `pg_ctl -m fast stop -t switchoverDelay`, then immediate on failure (`cnpg:pkg/management/postgres/instance.go:589-633,695-725,1655-1662`) | verified in source |
| A fenced instance manager never starts PostgreSQL and re-reads the fence before any start (`cnpg:internal/cmd/manager/instance/run/lifecycle/run.go:78-92`, `cnpg:internal/management/controller/instance_controller.go:554`) | verified in source |
| Fencing does not release the primary Lease; unfencing resumes without a lease transition (`cnpg:internal/cmd/manager/instance/run/lease/runnable.go:450-453`) | verified in source |
| Operator never rolls out a fenced instance; no switchover while the primary is fenced (`cnpg:internal/controller/cluster_upgrade.go:73,112`, `cnpg:internal/controller/cluster_controller.go:735-739`) | verified in source |
| Rollout compares the Pod's stored `cnpg.io/podSpec` with the target spec, never live resources (`cnpg:internal/controller/cluster_upgrade.go:698-748`) | verified in source; lab confirms no roll after resize |
| Hibernation proceeds only if `status.phase` is Healthy or hibernation already started (`cnpg:pkg/reconciler/hibernation/status.go:96`) | verified in source |
| Phase is written only by `RegisterPhase` calls; a fenced instance that keeps its Pod never changes it (`cnpg:internal/controller/cluster_controller.go:1150-1153` returns `ErrNextLoop` before `finalizeReconciliation`; `cnpg:internal/controller/plugins.go:136`) | derived from source, **confirm live (V-1)** |
| `Ready` condition equals `phase == "Cluster in healthy state"` (`cnpg:pkg/resources/status/transactions.go:34-56`) | verified in source |
| A Backup whose target Pod is not Ready (a fenced primary Pod is not) stays Pending and is retried every 30 s (`cnpg:internal/controller/backup_controller.go:318-331`); a Backup of a hibernated cluster fails (`:407`) | verified in source |
| Instance restarts while fenced stay fenced; the startup probe is an HTTP probe of the instance manager (`cnpg:pkg/specs/pods.go:223`) whose handler runs `pg_isready` and fails while PostgreSQL is down (`cnpg:pkg/management/postgres/webserver/probes/isready.go:45-62`); PGCF sets period 1 s and failureThreshold 3600 (`apps/native-controller/src/manifests.rs:341`) | verified in source |
| `pods/resize` of requests: no restart, same Pod UID, CNPG does not roll (60 s observed) | lab |
| In-place resize of the barman sidecar (a restartable init container, `plugin-barman-cloud`, `cnpg-plugin:internal/cnpgi/operator/lifecycle.go:452,596-603`) | **not measured (V-3)**; lab ran without the plugin |
| Instance manager RSS about 62 MB fenced; PostgreSQL start 111-117 ms; unfence to accepting 226-305 ms | lab |
| Sidecar RSS parked | **not measured (V-7)**, estimate 25-40 MiB (Go gRPC server, unix socket, uncached client) |
| The barman sidecar runs its catalog maintenance (retention policy, backup list against R2) at start and every 1800 s while its Pod is the current primary, parked or not (`cnpg-plugin:internal/cnpgi/instance/retention.go:56-189`, `cnpg-plugin:api/v1/objectstore_types.go:36-38`, `apps/native-controller/src/manifests.rs:104,275`) | verified in source; cost not measured (V-7) |
| The fence's fast stop is bounded by `spec.switchoverDelay` (CNPG default 3600 s; PGCF sets only `stopDelay`) (`cnpg:api/v1/cluster_funcs.go:795-801`, `cnpg:pkg/management/postgres/instance.go:695-725`, `apps/native-controller/src/manifests.rs:347`) | verified in source; duration measured by V-13 |
| At shutdown PostgreSQL's archiver gets one last cycle for completed segments (PostgreSQL 18 `src/backend/postmaster/postmaster.c:3795-3814`) | verified in source (reading), not measured |
| While fenced the instance reconcile still refreshes certificates and configuration files but stops before reload, roles and monitoring (`cnpg:internal/management/controller/instance_controller.go:200-240`) | verified in source |

Live checks V-1..V-13 are collected in section 7.4.

### 0.2 Where code and documentation disagree

| # | Statement | Conflict |
| --- | --- | --- |
| D-1 | `pool:913-918` (rejected alternative 7, "Parked CNPG Pods per database through fencing") gives four reasons: one Pod per database is not the pool; "Parked Pods keep their requests"; "Demotion to hibernation stalls once a parked Pod has been recreated"; "The 4-5 s after Ready remain" | (1) is D-2. (2) Requests of a running Pod can be shrunk in place with the same Pod UID (lab; V-3 for the sidecar), so a parked Pod need not keep them. (3) Holds only for a Pod that CNPG **recreated** while fenced: the new Pod is Pending first, CNPG then registers `Waiting for the instances to become active` (`cnpg:internal/controller/cluster_controller.go:925-935`) and, because a fenced instance can never become Ready, never reaches `RegisterPhase(Healthy)` (`cnpg:internal/controller/plugins.go:136`); derived from source and probed in L6. A Pod that was never recreated keeps phase Healthy and hibernates directly (V-1, V-2); algorithm B (2.3) covers the recreated one. (4) Outdated: the delivered wake orchestration measures 1.2-2.2 s from Pod Ready to admission (plan:125; 1.0-2.9 s across the stage-measurement rounds, plan:126), and the same remainder applies to a pool hit (plan:123); section 6.4 lists what is left. |
| D-2 | `rt:70-72`, `rt:193-194`: a per-database warm Pod "is not this mechanism"; "a same-Pod warm/reclaim result cannot replace this shared-pool result"; `plan:123,124` | This tier is exactly a per-database retained Pod. Needs an owner decision and amendment of the ULTRA rows "Sub-second decision", "Shared PostgreSQL warm pool on thin storage", "Pool cold-start test". |
| D-3 | `rt:205`: `hibernated` = "No per-database compute runs"; `plan:193`: "A confirmed hibernated database has no Pod, charge or RAM" | Publicly still `hibernated`, physically a Pod and a measured charge. State tables need a `parked` row. |
| D-4 | `apps/native-controller/src/reconcile.rs:1141` `condition(cluster, "Hibernated")` | `condition()` (reconcile.rs:85-91) matches condition **type**; CNPG's type is `cnpg.io/hibernation` with **reason** Hibernated (`cnpg:pkg/reconciler/hibernation/status.go:45,53`). `power.rs:1102-1108` matches type and reason correctly. The first disjunct of `needs_startup` (reconcile.rs:1140-1153) therefore never fires: a hibernated Cluster whose image, resources and parameters are unchanged and whose `currentPrimary` is set does not demand `startup_valid` here (the other gates and the host guard still apply). Derived from source; not caused by this design. Fix it in the same block with a failing test first (AGENTS.md), since the parked path reuses the predicate (2.2 step 1). |
| D-5 | `infra/platform/regional/rbac.yaml` (agent ClusterRole comment): "Pods are never created, updated or patched" | `pods/resize` `patch` is a new right (section 5.5). |
| D-6 | `desired.ts:254-258` omits `memory_request_mib` for suspended databases | `configuration_fingerprint` (`apps/native-controller/src/contracts.rs:238-247`) of a suspended record differs from the running record under `actual_ram` placement, so it cannot be compared across a sleep. Eligibility uses spec containment instead (section 2.2). |
| D-7 | `apps/regional/src/agent/power.ts` (TypeScript agent) still exists | The tier is native-only; the capability gate (section 5.2) keeps TS regions from parking. |

### 0.3 Position among the existing sleep states

| State | Physical state | First row through Cloudflare | Held per idle database | Status |
| --- | --- | --- | --- | --- |
| active / always warm | PostgreSQL, Pod and sidecar run | awake path 0.47-0.96 s, 0.54-0.61 s warm (plan:126) | full request | built |
| `warm_idle` (warm reclaim) | same PostgreSQL process and Pod run, selected cold pages reclaimed (`rt:202`, `rt:308-360`) | awake path plus page-in of the pages the query touches (not measured here) | the pages the reclaim leaves resident | control plane only (`apps/api/src/domain/warm-reclaim.ts`; the node reclaimer was deleted 2026-10-15), per-node qualification (`warm-reclaim.ts:79-142`), candidate check (`:144-209`) |
| **parked (this spec)** | Pod, instance manager and sidecar run, PostgreSQL stopped by fence | 1.3-2.2 s first implementation, about 1.1-1.2 s with direct readiness, G-1 and trims (section 6.1) | about 100-115 MiB and 15 millicores (estimates, V-7) | design |
| `hibernated` (CNPG) | no compute, volume only | 8.1-9.4 s measured (plan:126) | nothing but the volume | built |
| shared pool hit (alternative 8) | prestarted unassigned slot is claimed | below 1 s targeted; "1-2 s is the realistic first result, under 1 s is not structurally excluded" (plan:123) | a slot per node, not per database | implementation in progress, no live hit measured (plan:124); needs the sandbox host extension and thin requalification (plan:225-232) |

The parked tier and the shared pool answer the same question with the same arithmetic (plan:123:
orchestration after PostgreSQL is ready, PostgreSQL start and the 0.5-0.6 s awake path must fit
together). They differ in what they keep: the parked tier keeps a Pod per recently used database
and needs no host extension; the pool keeps compute per node and needs one. They are not mutually
exclusive per region (a pool claim needs `parked_json IS NULL`, section 1.2), and a database with a
qualified warm-reclaim policy never reaches either (section 2.4).

## 1. State model

### 1.1 States and representation

| Aspect | awake | parked | hibernated |
| --- | --- | --- | --- |
| Public `desired_state` / `observed_state` | `running` / `ready` | `suspended` / `hibernated` (unchanged, `rows.ts:95-101`) | same |
| D1 `observed_power` | `awake` | `hibernated` (CHECK allows only `awake`,`hibernated`, `apps/api/migrations/0008_database_lifecycle.sql:37`; no new value) | `hibernated` |
| D1 `parked_json` (new, nullable) | NULL | `{v:1, pod_uid, generation, cpu_millicores, memory_mib, wake?, parked_at, observed_at}` | NULL |
| Cluster annotations | no fence; `cnpg.io/hibernation` off/absent | `cnpg.io/fencedInstances='["*"]'`; hibernation off/absent; `pgcf.io/power-revision`,`power-operation` | `cnpg.io/hibernation=on`; no fence |
| CNPG Cluster status | Healthy, Ready | phase unchanged (Healthy); `readyInstances=0`; Lease held by the instance | `cnpg.io/hibernation` condition reason `Hibernated` (`cnpg:pkg/reconciler/hibernation/status.go:53`) |
| Kubernetes Pod | Running, Ready | Running, not Ready; PostgreSQL absent; instance manager + sidecar up; volume mounted; requests shrunk | none |
| Primary Lease `database` | held | held (fence does not release it) | empty/released at clean stop |
| Controller fence ConfigMap `gateway-fence-<id>` | intent `running`; `power.json` phase `awake` | intent `quiesce`; `power.json` phase `parked` + `park` record | intent `quiesce`; phase `hibernated` |
| Host-guard lease entry | `running` + token | **`running` + token for the parked Pod** (section 3.3) | `suspended`, no token |
| Gateway | admits | refuses (intent `quiesce`) | refuses |
| API node charge | full | parked requests (new term, section 4.3) | 0 |
| Usage lifecycle events | `woke`/`ready` | `hibernated` event once (`observations.ts:404-414,530-545`), awake seconds stop | `hibernated` |

No new public state is justified: every consumer in `apps/api` that matters keys on
`observed_power='hibernated'` and `desired_state='suspended'`, which stays true. A new value would
need a table rebuild of `databases` (SQLite cannot alter a CHECK) and would break expand-only.

Controller phase machine (`apps/native-controller/src/power.rs:129-140`): add `Parking` and
`Parked`.
`Quiescing → Switching → Archive → Proved → (Hibernating → Hibernated | Parking → Parked)`; wake
goes through `Wake → Awake` as today. `Progress` (power.rs:148-169) gains an optional `park`
record (inside the existing 16 KiB bound, power.rs:449,743):
`{pod_uid, container_ids[postgres, plugin-barman-cloud], node_boot_id, release_id, spec_sha256,
assignment_revision, requests_before, requests_parked, parked_at}`. `progress_from`
(power.rs:491-509) requires `segment`, `proof_intent` and `gateways` for `Parking`/`Parked` exactly
as for `Hibernating`.

### 1.2 Every place in `apps/api` that equates `hibernated` with "no Pod, no holder, no charge"

| Location | What it assumes | Change for a parked database |
| --- | --- | --- |
| `startup-admission.ts:57-65,75-76` (`databaseCpuChargeSql`, `sleeping`) | confirmed-stopped sleeper charges 0 CPU | **Keep unchanged.** Many callers use `=0` as "confirmed cold" (below). Add a separate term `databaseParkedCpuSql` (section 4.3). |
| `startup-admission.ts:113-116` (`nodeCpuHeadroomSql` sum over node databases) | sum of charges | add `+ databaseParkedCpuSql` to the sum |
| `placement.ts:260` (`reserved_cpu_millicores`) | sum of charges | same addition |
| `postgres-pool-inventory.ts:342` | sum of charges vs allocatable | same addition |
| `databases.ts:415-424` (resize of a suspended database requires `databaseCpuChargeSql=0`) | cold = no Pod | **no change needed** because the charge function is unchanged; resizing a parked database stays allowed and is D1-only (it bumps generation and `observed_generation`); the next wake takes the slow path (section 2.2 eligibility) |
| `resource-profiles.ts:123,201`, `fleet-postgres.ts:155` (`=0` confirmed cold) | rollouts apply to cold databases | unchanged; parked counts as cold; the rollout only edits desired config, effective at the next (slow-path) wake |
| `observations.ts:386-392,470-526,713-748` (`inactive`, `observed_power`, hold release, startup release) | `hibernated` observation completes the stop | unchanged; add `parked_json` write/clear (section 5.2) |
| `observations.ts:530-545,581,641` (lifecycle snapshots `reserved_*`) | stopped sleeper reserves 0 CPU (`databaseCpuChargeSql(...,true)`); reserved memory is class memory plus sidecar request regardless of power | `hibernated` snapshot (530-545): add `databaseParkedCpuSql` to `reserved_cpu_millicores` for a parked observation (4.3) so reserved CPU seconds match the node accounting; `woke`, `ready` and `resized` snapshots (581, 641) unchanged (full charge) |
| `database-actor.ts:802,1129,1226,1362` (awake-only admission, idle requests) | `awake` required | unchanged |
| `database-actor.ts:942-952` (`claimWake` needs `suspended`+`idle` and a `database.hibernate` operation) | idle sleeper | unchanged; a parked database qualifies |
| `lifecycle.ts:27-128,196-210` (`powerTransitionStatements`, `verifiedIdle`) | wake guard requires startup headroom | unchanged; manual suspend of a parked database is a normal power transition (controller demotes, section 2.3) |
| `node-thin-storage.ts:305-312` (`storageWriteAuthorityForDatabase` returns undefined unless `desired_state='running'`) | sleeper has no writer | add the parked-holder source (section 3.3) |
| `node-thin-storage.ts:870-872,946-961` (`hostStorageLease` entry `desired_state: row.desired_state`) | suspended entry = stop the Pod | present parked as `running` + token (section 3.3) |
| `node-thin-storage-samples.ts:478-486` (tokens in headroom responses: `desired_state='running'` rows only) | sleeper needs no token | unchanged on purpose: no ledger churn for parked Pods |
| `node-thin-storage-execution.ts:1064`, `storage-capacity.ts:529,660,706-722,753,830` | protections/holds for running databases; `observed_power='hibernated'` exempts hold coverage | unchanged |
| `database-admission-snapshot.ts:209`, `database-actor.ts:325-359` | snapshot admissible only if `awake` | unchanged |
| `node-state.ts:199-212` (policy change needs an empty or **manually** suspended cohort) | idle sleepers already block | unchanged (idle-hibernated databases already block it) |
| `postgres-pool.ts:730`, `postgres-pool-cold-start.ts:25-40`, `postgres-pool-qualification.ts:323,450,1235,1362,1407` (pool eligibility needs `hibernated`) | sleeper has no Pod and an empty Lease | add `parked_json IS NULL` to pool claim eligibility so a pool binding can never claim a volume that a parked Pod holds |
| `usage-rollup.ts:148`, `contracts/src/usage.ts:113` | event `hibernated` ends awake time | unchanged |
| `rows.ts:48,95-101`, `databases.ts:379-381` | public state mapping/filter | unchanged |
| `desired.ts:225-237,256-258` | `power` object; memory request omitted when suspended | unchanged; region object gains `parking` (section 5.2) |

Native side: `measurements.rs:386-512` accepts intent modes `running|quiesce` (parked = `quiesce`);
`main.rs:657,1289` treats `hibernated` as ready; `initial_backup.rs:30-60` retries only for
`desired_state=running`, so a parked database is never retried (its backup is Pending, not failed;
section 2.4).

### 1.3 Actor flows

The Durable Object `DatabaseActor` (`apps/api/src/database-actor.ts`) is the only writer of the idle
and wake intents. Parking changes none of its code paths; the table records why.

| Flow | Code | Effect of parking |
| --- | --- | --- |
| Idle to sleep | `requestIdle` (1326-1418): needs the current activity report revision (1337-1350), D1 `running`/`ready`/`awake` at that revision, no qualified warm-reclaim policy (1365-1381), idle for `size_classes.sleep_after_seconds` (1382-1388), revokes a reclaim lease (1389), then one D1 batch `powerTransitionStatements(..., 'hibernate')` (1392-1409) that sets `desired_state='suspended'`, `suspension_reason='idle'`, generation+1 and a `database.hibernate` operation, and notifies the region link (1412-1416) | none; the tier is chosen by the controller after this intent (sleep step S5) |
| Observation of the sleep | `inactive` (`observations.ts:386-394`) needs `power.state='hibernated'`, the current operation and revision, no refusal and `ready_wal_files` null or 0; the UPDATE (470-526) sets `observed_power='hibernated'` | `power.parked` is an additive field of that observation; `parked_json` is written in the same UPDATE |
| Wake | `ensureAwake` (1044-1089, 30 s deadline) calls `waitForAwake` (1098), which uses `claimWake` (926-1042): requires D1 `suspended` + `idle` + a `database.hibernate` operation (942-952), may prepare a pool claim (960-971), flips to `running` with a `database.wake` operation and generation+1 through `powerTransitionStatements(..., 'wake')` (972-980), stores `database_wake` and sends the hint once (1005-1036) | unchanged; a parked database is indistinguishable here, so there is no Durable Object state to migrate |
| Admission | `observedReady` (1174) and `poll` (1197-1267) wait for the `ready` observation or a pushed admission snapshot (`publishAdmissionSnapshotLocked`, 255-306), then `admit` (769) | unchanged; trims 6.4 #13 and #14 are optional |

Consequence: **a wake claim can race the controller's demotion.** The Actor flips D1 to `running`
while the controller may be inside demotion algorithm A or B. Every controller pass starts from the
current desired intent: a demotion that has not yet written `Hibernating` is abandoned in favour of
the wake, and one that has written it completes (or is superseded by) `prepare_running`, which
writes `Phase::Wake` for any previous progress whose revision is not newer and sends
`cluster_intent off` (`power.rs:2059-2079`), after which eligibility (2.2) is false and the
unmodified CNPG wake runs. Both end in a verified `ready`; the Actor's 30 s deadline covers the slow
path (8.1-9.4 s measured).

## 2. Transitions

### 2.1 Sleep: awake to parked

Trigger and policy, all existing: the controller's activity report reaches
`ingestAgentActivity` (`apps/api/src/domain/agent-metrics.ts:63-111`), the Actor's `requestIdle`
(`database-actor.ts:1326-1419`) flips D1 to `suspended`/`idle`, generation+1 and a
`database.hibernate` operation (`lifecycle.ts:27-128`), and hints the region. Parked tier applies
**only to idle sleeps** (`suspension_reason='idle'`); an explicit `suspend` stays real hibernation
(`rt:205`).

Controller (`power.rs` `suspend_step`, 1275-1494). Steps S1-S5 are the existing code, unchanged:

1. S1 `anchor`, progress `Quiescing`, `bind_fence` (1285-1345).
2. S2 gateway `begin` and `close` (1399-1400); `Switching` written with gateway identity before
   the SQL (1407-1415).
3. S3 `sleep_proof` (1129-1263): maintenance identity query, no busy or prepared work,
   `pg_switch_wal()` once (persisted `segment`), wait for the closed segment's `.done`, second
   safety read, `verify` again.
4. S4 `Proved` written (1441-1443), `anchor` re-verified (1444-1447).
5. S5 **decision** (new): park if all hold: region policy `parked_tier.enabled`; reason `idle`;
   the Cluster has `spec.instances == 1`, no `pool_binding`; exactly one non-terminal instance
   Pod owned by the Cluster, `Running`, with containers `postgres` and `plugin-barman-cloud`
   present and not restarting; the node's parked count (fence ConfigMaps with phase `parked` and
   `anchor.node == db.node`, one list of `pgcf-system` ConfigMaps labelled with the fence label)
   is below `max_per_node`. Otherwise take the existing `Hibernating` branch (1448-1452).
6. S6 write `Phase::Parking` with the `park` record (pod UID, container IDs, node boot ID from
   `Node.status.nodeInfo.bootID` as read at reconcile.rs:1449, release id and assignment revision
   from `snapshot.fleet_release`, requests before) **before** any Cluster write, as
   `Hibernating` precedes `cluster_intent(on)` at power.rs:1448-1451.
7. S7 one merge-patch with resourceVersion/uid CAS (`Kubernetes::patch`, kubernetes.rs:835-879)
   of annotations `cnpg.io/fencedInstances='["*"]'`, `pgcf.io/power-revision`,
   `pgcf.io/power-operation` (a variant of `cluster_intent`, power.rs:1033-1067, with the fence
   instead of hibernation). Use `["*"]`, not the instance name: stable if the instance serial ever
   differs, and the only unfence form CNPG supports for a wildcard fence is clearing the
   annotation (`cnpg:pkg/utils/fencing.go:116-135`).
8. S8 (next reconcile, branch parallel to power.rs:1354-1390). Confirm **PostgreSQL is stopped
   and the instance is fenced**, polling inside the job at 100-250 ms up to the job budget:
   a) Pod UID equals the `park` record, `Running`, not deleting;
   b) the Cluster annotation and power annotations equal the expected values;
   c) `cnpg_collector_fencing_on 1` from `http://<podIP>:9187/metrics` (the agent already scrapes
      this port: reconcile.rs:735-749; CiliumNetworkPolicy and NetworkPolicy already allow the
      agent to 9187 and 5432, manifests.rs:218-227; CNPG sets the gauge before the collection
      shortcut, `cnpg:pkg/management/postgres/webserver/metricserver/pg_collector.go:403-408`);
   d) a TCP connect to `<podIP>:5432` is refused (connection refused proves the listener is gone;
      any answer, including SQLSTATE 57P03 "shutting down", means a postmaster still exists and the
      poll continues; this is a negative probe and never proof by itself, only together with c);
   e) gateway `status` controls and `anchor` unchanged (as 1357-1383).
9. S9 resize down (section 2.1.2); S10 `Phase::Parked` written; observation `hibernated` with
   `power.parked = {pod_uid, cpu_millicores, memory_mib, wake?: "fast"}` (power.rs:526-534 gains the
   field). `wake: "fast"` is claimed only while every fast-path predicate holds (release, node boot,
   Pod and container identity, runtime, image, manifest containment); on drift the controller
   demotes before any wake.

**What "stopped cleanly" can and cannot mean.** The controller has no exec or log access to the
Pod (rbac comment: no `pods/exec`, no cluster-wide `pods/log`), so it cannot read `pg_control`.
It proves: closed WAL segment archived before the fence (existing proof), instance manager
fenced and postmaster absent. CNPG's fence is checkpoint + fast shutdown, immediate only if the
fast stop fails (`cnpg:pkg/management/postgres/instance.go:695-725`), i.e. the same stop
hibernation performs on SIGTERM. Cleanliness is not a safety input (WAL is durable; PostgreSQL
recovers either way) and is observed at the next wake: `pg_postmaster_start_time()` to accepting
latency is logged as `pg_accepting`; sustained values above 500 ms indicate crash recovery.
Granting `pods/log` to read the instance manager's `pg_controldata` line is possible but widens
RBAC against an explicit statement and is **not recommended**.

#### 2.1.1 Timing constraint

The fence must complete while the lease still carries the sleep `drain`
(`node-thin-storage.ts:893-945`). The entry is re-issued at every lease fetch with
`expires_at = min(authority expiry, now + drain_seconds)` for as long as the stop operation is
current, and the guard treats the drain as active only while such fetches keep arriving
(`storage.rs:435-459`: `drain.expires_at > now` and `received.elapsed() < remaining`). The cover
ends when the observation commits and the operation succeeds; the same fetch then presents R1
(3.3).

Parking has fewer steps than hibernation (no Pod deletion, no wait inside kubelet's grace
period), but one stage is bounded differently: the fence's fast shutdown is bounded by
`spec.switchoverDelay`, which PGCF does not set (CNPG default 3600 s,
`cnpg:api/v1/cluster_types.go:1454`, `cnpg:api/v1/cluster_funcs.go:795-801`), whereas the SIGTERM
path of hibernation is bounded by `stopDelay` = `drain_seconds` (`manifests.rs:347`). With the drain
re-issued per fetch this matters only if Cloudflare is unreachable during the sleep; the guard then
acts after `drain_seconds` exactly as it does for hibernation. V-13 measures the fence stop on EU1;
setting `switchoverDelay` to `drain_seconds` next to `stopDelay` (one manifest line) is the remedy
only if it is observed to matter.

#### 2.1.2 In-place resize down

`PATCH /api/v1/namespaces/<ns>/pods/<pod>/resize`, content type
`application/strategic-merge-patch+json` (JSON merge patch would replace the container lists),
body with the Pod UID precondition only (the Pod's resourceVersion churns):
`{"metadata":{"uid":"<uid>"},"spec":{"containers":[{"name":"postgres","resources":{"requests":{"cpu":"..","memory":".."}}}],"initContainers":[{"name":"plugin-barman-cloud","resources":{"requests":{...}}}]}}`.
Requests only; limits are untouched, so the Pod stays Burstable (QoS cannot change under resize,
K8s 1.36 docs). `resizePolicy` defaults to `NotRequired` for both resources, so no restart
(lab). Completion is read from `status.containerStatuses[postgres].resources` and
`status.initContainerStatuses[plugin-barman-cloud].resources` and the absence of conditions
`PodResizePending`/`PodResizeInProgress`. **If the resize is rejected or times out, park anyway
with the full requests and record them in `parked_json`** (the API then charges the full request;
safe, only density is lost). The existing client has no subresource or typed-patch support
(`kubernetes.rs:211-264,677-722`): add `resize_pod` and a content-type parameter.

### 2.2 Wake: parked to awake

Existing entry (`reconcile.rs:1004-1180`): `guard`, reads, `context`, runtime label,
`prepare_running`. New behaviour is confined to `prepare_running` (power.rs:2032-2089) and the
readiness predicates.

1. **Eligibility** (read-only, all in parallel with `try_join!`; ~14 GETs): the fence progress is
   `Parked`/`Parking`; the fence annotation is present and hibernation is not `on`;
   `physical.matches(anchor)` (existing, power.rs:2053-2058); the Pod named in the park record
   exists with the same UID, `Running`, not deleting, same container IDs for `postgres` and
   `plugin-barman-cloud`, same `spec.runtimeClassName` as `runtime_class(context)`
   (reconcile.rs:141-147), same node boot ID; fleet release id, `spec_sha256` and the node's
   assignment revision equal the record (an operator or runtime upgrade would make CNPG roll the
   Pod right after unfence, `cnpg:internal/controller/cluster_upgrade.go:698-748`); and
   **applying the desired manifests would change no spec or data**: for every manifest from
   `manifests::build` the existing `contains` check of `apply` (reconcile.rs:2296-2303) holds
   ignoring only the `pgcf.io/generation` annotation. That single predicate covers size class,
   image, parameters, plugin/ObjectStore, managed roles and Secret content (role password
   rotation), so none of those can cause a post-wake rollout or an unacknowledged credential.
   Also required: a current Cloudflare startup hold for this generation and node
   (`startup_valid`, reconcile.rs:435-443), because the unfence is a start of PostgreSQL on the
   volume exactly as a hibernation resume is. `needs_startup` (reconcile.rs:1140-1153) is meant to
   demand that for a hibernated Cluster; D-4 is why its first disjunct never fires. The design adds
   the present fence annotation as a start condition there and fixes D-4 in the same block.
2. **Fast path** (all true): in one step, concurrently,
   a) one merge-patch on the Cluster: `cnpg.io/fencedInstances: null`, `cnpg.io/hibernation:
      "off"`, power annotations (existing `cluster_intent` extended; `Phase::Wake` progress is
      written first, power.rs:2069-2077, so a controller crash resumes);
   b) `resize_pod` up to the Cluster's desired requests;
   c) a poll loop (20 ms) of the maintenance session to the **Pod IP**
      (`postgres::connect_at` with `hostaddr`, postgres.rs:96-129, as `connect_pool` does,
      TLS name stays `database-rw.<ns>.svc`): connect, identity query (`database`, not in
      recovery, TLS, `inet_server_addr() = podIP`) and `pg_postmaster_start_time() >` the unfence
      patch time, which proves a fresh postmaster rather than a stale answer.
   The job does not return to the scheduler between unfence and observation (it holds one of
   `SLOTS=4`, main.rs:528, in class `Wake`, for the job's duration).
3. **Verification chain** (existing checks, same strength, run concurrently where independent):
   apply pass (a no-op except generation annotations), `renew_storage_authority` (1247),
   `ca()` (2423-2453), `bind_volume`, `credential_acknowledged` (92-139), per-role logins
   (`postgres::roles`, postgres.rs:212-233, changed to dial the Pod IP and to run roles in
   parallel), `archive()` sample (675-774), runtime proof (1445-1509) and `runtime_readback`
   (2008-2093). Predicates that today mean "kubelet says ready" are replaced in the parked path
   (as built: section 2.2.1):
   - `condition(cluster,"Ready") == "True"` (1307): vacuous here (phase never left Healthy); the
     real gates are the Pod identity and the SQL proof;
   - `primary_current` requiring Pod `Ready` (158-164), container `ready == true` (1327-1343) and
     `archive()` requiring Pod `Ready` (766): replaced by "Pod Running, UID/container IDs equal
     the park record, `postgres` container running, SQL identity verified";
   - the Pod's `spec` resources must equal the desired Cluster resources (1348-1356) — satisfied
     as soon as the resize patch is accepted; `status` lag is reported, not awaited.
4. **Publication**: `finish_running` (2148-2182: fence release, gateway `release`, intent
   `running`), then `persist_admission_target` (2094-2150) and the observation (`ready`,
   `runtime_attestation` v2 as at 1445-1509).
5. **Slow path** (any eligibility predicate false before the unfence patch): demote (2.3), then
   the existing CNPG wake (`cluster_intent off` creates a new Pod); it costs the CNPG baseline plus
   the demotion. **A fast path that fails after the unfence patch** (job budget, PostgreSQL slow to
   accept) is not demoted: the next pass finds `Wake` progress with the fence gone and continues on
   the same Pod under the existing kubelet-readiness predicates, which is the ordinary CNPG wake of
   a running instance. Either way no client is admitted before the verification chain succeeds.

Staying unrouted until verified is unchanged: the gateway fence stays `quiesce` until
`finish_running`, and the Actor admits only an accepted `ready` observation
(`database-actor.ts:769-810,1197-1267`).

**Gateway routing before kubelet readiness** is the one stage the controller cannot fix: the
native gateway routes only to a Ready EndpointSlice endpoint (`targets.rs:499-508`) whose
`postgres` container reports `ready` (`targets.rs:239-267`; README "exact Ready writer"). Without
the gateway change (5.4) the controller must not publish `ready` before the endpoint is Ready, and
the wake is bounded by the kubelet readiness probe (period 1 s, `manifests.rs:341`). The gateway
change G-1 is implemented (5.4), and with it the controller publishes on its own proof (2.2.1).

#### 2.2.1 Fast ready: what stands in for the kubelet's Ready bit

A resumed Pod is published once all of this holds, and not before; the gateway then routes to it by
the attestation the controller persists (`admission_target`: Pod UID, container ID, CA identity).

1. PostgreSQL answers on the Pod's own address with the right identity: database, role, server
   address (`host(inet_server_addr())`), not in recovery, TLS, and a postmaster that started after
   the unfence (the server's clock for its age, the controller's monotonic clock for the unfence).
2. The Pod is the parked one: same UID, `postgres` and sidecar containers under the recorded IDs,
   `postgres` running and not restarted since the fence was lifted. This is read before PostgreSQL
   answers, after it, and once more at the end of the archive probe.
3. The kubelet has not held the requests the Pod was resized back to: a resize it deferred or
   found infeasible, or one the API server refused, holds the wake (the next pass asks again or
   gives the Pod up before any client was admitted); one it is still actuating does not, because the
   resize changes requests alone, no limit and no cgroup limit.
4. Roles, archive identity, volume identity and thin authority, the CA and the applied objects are
   verified exactly as for any wake.
5. The attestation is a v2 proof read back against the Pod and the Cluster the archive probe read
   last. The kubelet reports Ready, and CNPG writes the Cluster status, while the chain runs; a
   proof read back against what was read before PostgreSQL answered would meet them. A resumed
   Pod that cannot be attested (no admission, no complete watch, a read-back that moved) is not
   published before the kubelet reports it Ready, because only the attestation lets the gateway
   route to it.

Later passes of a wake that did not finish continue on the same Pod under the ordinary chain, which
waits for the kubelet's Ready bit and the Cluster's `Ready` condition (2.2 step 5).

The kubelet's Ready bit is measured, not awaited: the phase `kubelet_ready_observed` ends in the
first later read of the Pod that finds it set, counted from the answer of PostgreSQL (the span the
wake used to wait).

**How long the attestation stands in for the Ready bit.** The gateway routes to the attested Pod
until the kubelet's report, not for as long as the fence carries the attestation. Once it has seen
that Pod's endpoint and `postgres` container reported Ready, the attestation is spent for that Pod
UID, container ID and revision and only the ordinary rules apply: a Pod that is not Ready later
(PostgreSQL down under the same container, an operator's fence, a node whose lifecycle cleared
Ready) refuses new connections and closes established sessions as before G-1. It also ends 10 s
(the startup bound of a connection) after the gateway first relied on it, so a Pod the kubelet
never reports Ready, or one that was not Ready before a gateway replica started and left that
replica no report to see, is routed once it is Ready. The controller publishes `ready` on its
proof, so a wake whose `kubelet_ready_observed` is longer than that bound is refused by the
gateway until the report arrives.

**The completed generation is written before the proof.** The namespace's `pgcf.io/generation`
annotation marks the generation a pass completed, and the runtime proof names the namespace at its
resourceVersion. It was written after the proof, so the first pass of every generation changed the
namespace under its own proof and ended in `runtime proof changed before target publication` after
the gateway fence had been released; the next pass repeated the whole chain. It is written before
the proof now, and the proof waits (at most 500 ms) until the controller's own watch has delivered
that write. This holds for every wake, not only the parked one.

### 2.3 Demotion: parked to hibernated

Decider: the controller, in the periodic reconcile of each parked database (cadence 60 s,
`main.rs:654-685`; TTL granularity is therefore up to +60 s, acceptable for TTLs in minutes).

Why the controller and not an API-side decider: the inputs are node-local and already in the
controller's hands (Pod identity, `Node.status.nodeInfo.bootID`, the node's fence ConfigMaps, which
carry a common label so one list suffices, `power.rs:4367`), the action is a Kubernetes write it
performs for hibernation anyway. The implementation runs no job without a full desired pull in
the last 90 s, so while Cloudflare is unreachable no TTL, cap or drift demotion happens and parked
Pods keep their parked requests until the link returns. The policy values stay Cloudflare-owned desired
state (`region.parking`, section 5.2), so the controller executes desired state and reports an
observation, as AGENTS.md requires. An API-side decider would need a new desired field with its own
revision protocol and a pull round trip per demotion, and would still depend on the controller to
act: more machinery for no gain.

Triggers, evaluated in this order:

1. Policy off, or the region lost the capability → demote now.
2. **TTL**: `now - park.parked_at >= parked_tier.ttl_seconds` (cap: 3300 s so a restarted
   container cannot reach its 3600 s startup-probe kill before demotion: `manifests.rs:341`,
   `cnpg:pkg/specs/pods.go:223`, `cnpg:api/v1/cluster_types.go:1459`).
3. **Cap, oldest first**: let the node's parked databases be ordered by `(parked_at, id)`;
   if `count > max_per_node`, each database computes its own rank and the oldest `count-max`
   demote themselves. No cross-database writes, restart safe, converges without coordination.
4. Identity or drift: eligibility predicates of 2.2 become false while parked (Cluster spec
   drift from a resize or role change, Pod identity/boot/release change).
5. A new intent: manual `suspend` (D1 flips `suspension_reason='manual'`, new operation) → demote
   and observe `hibernated` for the **new** operation; `delete` follows the delete flow.

Algorithm (idempotent; every write is a CAS merge-patch; progress persisted first):

- **A (preferred, only when the Cluster phase is Healthy)**: write `Hibernating`; patch
  `cnpg.io/hibernation=on` (+power annotations) **leaving the fence in place**. CNPG's
  hibernation reconciler runs before any Pod logic and deletes the Pod
  (`cnpg:internal/controller/cluster_controller.go:555-566`, `cnpg:pkg/reconciler/hibernation/reconciler.go:66-95`);
  the fenced instance manager exits on SIGTERM without starting PostgreSQL. This avoids a
  PostgreSQL start (and its RAM spike) on a node that is demoting because it is short of memory.
- **B (fallback, phase not Healthy, e.g. after a reboot or Pod recreation)**: the phase is
  stuck below Healthy because a fenced instance can never become Ready
  (`cnpg:internal/controller/cluster_controller.go:1150-1153`), and hibernation would wait
  forever (`status.go:96`). Patch the fence away (unfence), wait until the Pod is Ready and the
  phase Healthy, then run A. No re-proof is needed: no client could write since the park (gateway
  closed), and the existing proof covered every commit.
- Completion (existing branch power.rs:1354-1390): `cnpg.io/hibernation=on`, condition
  `cnpg.io/hibernation` reason `Hibernated`, every instance Pod terminal, anchor unchanged,
  gateways unchanged. Then **remove the fence annotation** (so a later resume does not start a
  fenced Pod), write `Hibernated`, and post `hibernated` **without** `power.parked`.
- Observation order is conservative: `parked` stays in the observation until `Hibernated` is
  confirmed, so the API's charge and the guard lease never undercount a still-present Pod.

Resume of a demoted database is the unmodified CNPG wake (`cluster_intent off`, new Pod).
`prepare_running` always sends `cnpg.io/fencedInstances: null` together with hibernation `off`
(idempotent) so a stale fence can never survive into a recreated Pod.

### 2.4 Interplay

| Event | Behaviour |
| --- | --- |
| **Delete** | Existing flow (`power.rs:2732-3116`): set PV reclaim `Delete`, delete the Namespace (3002-3006). The Cluster, parked Pod and PVC are removed by Kubernetes and CNPG like an awake Pod's. The lease entry becomes `deleted` + `database.delete` drain (`node-thin-storage.ts:896-945`). `parked_json` is cleared by the final `deleted` observation. |
| **Resize** | D1-only for a sleeping database (`databases.ts:415-424`), unchanged. The parked Pod keeps its old shape; the next wake fails the spec-containment predicate and takes the slow path (new Pod from the new spec). Optional: the controller also demotes proactively on drift (trigger 4). |
| **Role create / reset password while parked** | Desired Secret data changes, so the manifest-containment predicate (2.2 step 1) is false: demote, then the CNPG wake applies roles on a fresh instance, as today. Waking the parked Pod instead is not used: CNPG's role synchronizer is triggered from the instance reconcile pass that follows a lifted fence, and that pass is preceded by a blocking 20 s sleep in `RequestAndWaitFencingOff` (`cnpg:internal/management/controller/instance_controller.go:506-526`, `cnpg:pkg/management/postgres/instance.go:1565`; derived from source, not measured). |
| **Restore** | Creates a new database; never parked at creation. Restoring *from* a parked database reads the Barman catalog in R2, which the sleep proof already completed. |
| **Manual suspend / resume** | Suspend: demote (2.3 trigger 5). Resume of a parked (idle) database: `changePower(resume)` → ordinary wake (fast path if eligible). |
| **Scheduled backups (`daily-backup`, `0 0 3 * * *`, `manifests.rs:357`)** | The ScheduledBackup creates its Backup at 03:00 whatever the Cluster state. A Backup whose target Pod is not Ready (a fenced primary) stays **Pending** and is retried every 30 s (`cnpg:internal/controller/backup_controller.go:318-331`); the ScheduledBackup waits for it (`cnpg:internal/controller/scheduledbackup_controller.go:125-133`). If the database is demoted first, CNPG fails the Backup with "cannot backup a hibernated cluster" (`:407`), as for a database that is hibernated at 03:00 today. If it wakes first, the Backup runs within 30 s of Pod Ready: **a parked database that wakes after 03:00 takes that day's base backup at its first wake**, which a hibernated one would not (Q16). `initial_backup.rs` retries only a failed immediate backup of a running database (`initial_backup.rs:30-60`); a parked database's pending initial backup needs no retry. |
| **WAL archiving** | Nothing archives while parked (no postmaster). Everything committed is in segments the proof saw archived. At the fence stop PostgreSQL's archiver still gets one last cycle for completed segments: after the shutdown checkpoint the postmaster wakes the archiver and waits for it (`PMSIGNAL_XLOG_IS_SHUTDOWN`, state `PM_WAIT_XLOG_ARCHIVAL`; PostgreSQL 18 `src/backend/postmaster/postmaster.c:3795-3814,3054-3066`, source reading, not measured). The shutdown checkpoint record itself sits in the final partial segment, which is archived once a later start completes it (`archive_timeout` or size), exactly as with hibernation. The `hibernated` observation carries `ready_wal_files: null` (`power.rs:527`), which `inactive` accepts (`observations.ts:386-394`). PITR window and R2 layout unchanged. |
| **Node reboot** | Two outcomes, both fenced because the annotation persists on the Cluster: the kubelet restarts the containers in place (same Pod UID, new container IDs, the requests as last patched), or the Pod became terminal and CNPG replaces it (`deleteTerminatedPods`, `cnpg:internal/controller/cluster_controller.go:883-888,978`; new UID, full requests, phase below Healthy until unfenced). In both the park record no longer matches (boot ID, container IDs or UID), so trigger 4 demotes: algorithm A while the phase is Healthy, else B. PostgreSQL cannot start while fenced, so no writer exists in between. The plan records that reboots on EU1 left Failed or Succeeded Pods (plan:99), so the second outcome is the expected one, but both are handled (V-12), and a restarted container runs its startup probe again, which is why the TTL cap is 3300 s. |
| **Controller restart or rollout** | Progress is in the fence ConfigMap; `Parking` resumes at S8, `Parked` is re-verified each 60 s, `Wake` resumes (power.rs:2069-2077). **Downgrading to a controller without this phase makes `power.json` unparseable (`power_progress_invalid`)**: demote all parked databases (policy off) before such a rollback. |
| **CNPG operator upgrade/restart** | A fenced primary is never rolled out (`cluster_upgrade.go:112`) and no switchover happens (`cluster_controller.go:735-739`); the running instance manager keeps its old binary. At wake the release predicate (2.2) is false, so the first wake after an operator or fleet release change demotes and recreates the Pod instead of waking into a rollout. |
| **Gateway restart** | Fence ConfigMap is persistent; no sessions exist. |
| **Cloudflare/D1 outage** | No demotion until the next full desired pull (see 2.3). The guard lease lapses like for any database; a parked Pod is then frozen/killed by the guard (harmless, no writer), and the first wake after recovery resumes it through the existing startup-resume path (`storage.rs:461-499,824-849`); wake is slower, never unsafe. |
| **Warm reclaim (`node-reclaimer`)** | Disjoint. A database that is a warm-reclaim candidate never takes the idle-hibernate path: `requestIdle` returns `not_idle` for it (`database-actor.ts:1365-1381`) and a reclaim lease is revoked before a real idle sleep (`:1389`). Parking therefore applies only to databases without a qualified warm policy; nothing in `warm-reclaim.ts` changes. |
| **Usage and cost metrics** | `awake_seconds`, `memory_mib_seconds` and `cpu_millicore_seconds` stop at the `hibernated` event (`usage-rollup.ts:91-92,148-152`). The snapshot of that event keeps `reserved_memory_mib` at class memory plus the sidecar request (`observations.ts:530-545`), which already exceeds a parked Pod's footprint, but sets `reserved_cpu_millicores` to 0 (charge 0, `startup-admission.ts:57-77`). Section 4.3 adds the parked CPU to that snapshot so that `reserved_cpu_millicore_seconds` equals what the node accounts. No new metric name (open question Q11). |
| **Pool runtime** | A parked database is excluded from pool claims (D1 `parked_json IS NULL`, section 1.2); the pool's own eligibility already requires a hibernated Cluster with no Pod and an empty Lease (`pool:83-88`). Both routes can be enabled in one region: a parked database wakes through the parked path, a demoted one is an ordinary hibernated database and a pool claim may serve its next wake. |

## 3. Safety

### 3.1 Single writer

PGDATA of one database is written by at most one process at any time:

1. **While parked there is no writer process.** The instance manager does not start PostgreSQL
   while its in-memory fence flag is set (`run.go:88-92`); the flag is loaded from the Cluster
   annotation before any start (`systemInitialization.Wait()` then `IsFenced`, `run.go:78-92`;
   `instance_controller.go:554`), so a container restart, a Pod recreation or a node reboot
   re-fences before the first start. All fence-time commands other than `fenceOff` are ignored
   (`instance.go:1642-1652`).
2. **No second Pod can run PostgreSQL on the volume.** The instance keeps the primary Lease
   (`cnpg:internal/cmd/manager/instance/run/lease/runnable.go:450-453`) and a primary instance
   manager blocks every PostgreSQL start until it holds the Lease
   (`cnpg:internal/management/controller/instance_startup.go:72-86`). The Pod name is unique per
   Cluster, CNPG creates a replacement Pod only after the old one is terminal
   (`cnpg:internal/controller/cluster_controller.go:883-888`), the volume is a node-local LV (PV node
   affinity) and the PGCF controller never creates Pods (`infra/platform/regional/rbac.yaml:79-89`:
   Pods get/list/watch/delete only). OpenEBS's single-mount guard is *not* relied upon
   (`pool:175-178`: unproven).
3. **No pool holder.** Pool claims need a hibernated Cluster with no non-terminal instance Pod and
   an empty Lease (`pool:83-88`); a parked database has both. D1 excludes parked rows from claims.
4. **Only the PGCF controller changes the fence.** CNPG never edits `fencedInstances`; only
   principals with `patch clusters` can (the `pgcf-agent` ClusterRole, `infra/platform/regional/rbac.yaml:57-59`). The
   controller removes it only after eligibility or in the demotion algorithm, always with
   `Phase::Wake`/`Hibernating` persisted first.
5. **No client reaches PostgreSQL before verification.** The gateway fence stays `quiesce`
   (refusing) until `finish_running`, which runs after the SQL identity/role/archive/runtime
   checks; the Actor admits only an accepted `ready` observation.
6. **Unfence while a fence-on is still stopping PostgreSQL** is serialized by the instance
   manager's unbuffered command channel (`cnpg:pkg/management/postgres/instance.go:469,1533-1535,1655-1662`):
   the unfence request is handled only after the shutdown returns.

### 3.2 No loss and no uncertain replay of committed data

- The park entry condition is the existing sleep proof (closed segment archived, no busy or
  prepared work, identity and storage anchor verified twice). The fence stop is a checkpoint and
  fast shutdown (immediate fallback keeps WAL durable and recovers at start).
- Uncertain writes: every Kubernetes mutation is a CAS merge-patch whose outcome is re-read by
  the next reconcile (`kubernetes.rs:835-879`); intent (`Parking`, `Wake`, `Hibernating`) is
  persisted **before** the Cluster write, so a lost reply is resolved from the cluster state.
- The gateway never replays SQL; a parked wake starts new sessions only after admission.
- Unfence/resize failures fall back to the slow path (demote then CNPG wake); the guard and the
  fence still prevent admission.
- Data written by crash recovery after an immediate fallback is covered by PostgreSQL's WAL.

### 3.3 Thin write authority, host guard, I/O limits, reserved capacity

**Live findings (EU1, 2026-10-15) and their fixes.** V-5 below is confirmed: a thin idle sleep had its
Pod's tasks stopped by the guard 7 s after the sleep intent (restartCount 1); PostgreSQL restarted
while D1 stayed `suspended` and the controller's reconcile failed in a loop. Fix (API only): while a
stop operation (`database.suspend` or `database.hibernate`) of the current generation is pending or
running and the node proof evidences the Pod, the lease presents `running` with a token for that Pod;
the window ends with the controller's stop observation or the operation's timeout. A replay of the
lease through `storage.rs` also showed that a wake from parked that later takes the slow path at the
same generation leaves the replacement Pod unpermitted. Fix: the wake token for the parked Pod is
issued only when the parked record claims `wake: "fast"` and the database generation is exactly the
parked generation plus one (the row may be ahead of it by role changes, which start nothing); every
other wake retires the parked Pod and starts a new one. The stop
window accepts the same evidence as the running token: the Pod a node reading measured, or before
any reading the held writer (startup hold plus the controller's attestation). Two limits remain on
thin volumes: a database that parks before the first reading after its start gets no parked token
and is demoted instead; and a parked Pod that CNPG recreates after a node reboot cannot start
without a startup grant, so it stays down until the next wake, which starts it normally.

What the guard does with a Pod it knows (`storage.rs:536-595,764-877`): a Pod in a `pgcf-db-<id>`
namespace is permitted only while its lease entry is `running`, not `write_blocked`, with a valid
token naming that Pod UID or a valid startup grant (`permits_at`, 579-595). Otherwise the guard
noflush-suspends the LV unless a drain is active (`protection.filter(!was_quiesced && !active_drain)`,
850-863) and calls `stop_pod_tasks` (864-874; effective for Pods of the sandbox runtime,
`controller.rs:999-1021`). A new generation's startup entry also marks the **previous holder's
Pod UID** for resume-and-stop (`resume_scope`, 478-499): the guard retires the old writer before a
new one starts, even when Kubernetes reuses the Pod UID (comment at 336-337; unit test
`storage.rs:1004-1068`).

A parked Pod would therefore be (a) frozen/killed after the drain window of its sleep intent
(`desired_state='suspended'`), and (b) killed at wake when generation G+2 appears with a startup
entry and no token naming the Pod. Both are avoided **without touching the host extension** by
API-side lease presentation. Three rules, all in `apps/api`:

- **R1 parked steady state.** A database is *parked* when `parked_json` is set,
  `desired_state='suspended'`, `suspension_reason='idle'`, `observed_power='hibernated'`, and the
  controller's last `parked` observation (`parked_json.observed_at`) is at most 180 s old; it does
  not depend on `observed_generation` (a D1-only resize bumps both generations at once,
  `databases.ts:415-420`, and the hint is re-posted at the next controller pass).
  `hostStorageLease` emits for it `desired_state: "running"`, `write_blocked` computed as for a
  running database (the non-drain branch at `node-thin-storage.ts:950-960`: protected writer,
  missing or blocked node authority), `startup_*: null`, `drain: null`,
  `volume: receipt`, and `runtime_authority:` a token signed for
  `(database, current generation, parked.pod_uid)`.
- **R2 waking from parked.** When D1 is `desired_state='running'`, the power operation is a
  wake/resume of this generation, `observed_power='hibernated'` and `parked_json` is set,
  `storageWriteAuthorityForDatabase` accepts the parked holder as the Pod source (in
  addition to `io?.pod_uid` and `heldWriterPod`, node-thin-storage.ts:365-376). The token for
  generation G+2 therefore exists in the **very first lease** (and in the first desired pull and
  headroom response) in which G+2 appears, together with the startup entry. Guard acceptance
  (`storage.rs:182-365`) then sees `highest[id]` advance to `(G+2, pod)` in the same lease, so
  `resume_scope` finds `entry.generation > old.generation` false and nothing is stopped. The same
  signed claims are produced by `heldWriterPod` after the ready observation (claims are a pure
  function of row, receipt, authority and Pod), so the two sources never conflict at one authority
  revision. The guard refuses a lease whose token has the accepted token's node authority revision
  but different claims (`storage.rs:255-269`; the revision advances with every accepted sample,
  `node-thin-storage-samples.ts:424`, about every 2 s at the 10 s guard,
  `thin-authority-renewal.md` section 1). A wake lease that lands on the revision of the last
  parked token is therefore refused whole and replaced by the next fetch: acceptance is delayed by
  one fetch and nothing is killed, because the parked Pod stays permitted by the previous entry.
  Ordinary wakes carry the same property.
- **R3 evidence.** `parkedHolder` returns the Pod UID only if the latest identity proof's volume
  entry for this database (any generation `<= row.generation`, same storage/namespace/cluster/
  LV/PVC/PV identities as the receipt) has exactly one `io` element whose `pod_uid` equals
  `parked.pod_uid` and whose limits are within the profile, the node authority is current and
  `write_allowed`, and `!storageWriterProtected`. The proof itself already treats a running
  instance Pod as a writer and measures its cgroup `io.max` regardless of desired state
  (`apps/node-bootstrap/src/thin-storage.ts:267-273,1781-1827`), so a parked Pod keeps being
  evidenced. This is a **new function `parkedHolder` used by `hostStorageLease` and the R2 branch
  only**; `storageWriteAuthorityForDatabase`'s running path and the headroom token loop
  (`node-thin-storage-samples.ts:478-486`) are otherwise untouched, so parked Pods cause no
  ledger churn.

Sketch (TypeScript, `apps/api/src/domain/node-thin-storage.ts`):

```
parkedHolder(env, row, storage, receipt, authority): string | undefined
  parked = ParkedRecord.safeParse(row.parked_json)            // v:1, pod_uid, observed_at
  require parked && row.observed_power === 'hibernated' && row.deleted_at === null
  require row.desired_state === 'suspended' && row.suspension_reason === 'idle'   // R1
       || row.desired_state === 'running' && isWakeOfCurrentGeneration(row)       // R2
  require Date.now() - Date.parse(parked.observed_at) <= 180_000
  volume = authority.volumes.find(v => v.database_id === row.id && sameReceiptIdentity(v, receipt)
                                       && v.generation <= row.generation)
  require volume?.io.length === 1 && volume.io[0].pod_uid === parked.pod_uid
  require io within storage limits && !storageWriterProtected(row, authority)
  return parked.pod_uid
```

`hostStorageLease` (R1) calls it for suspended rows and, when it returns a Pod UID, builds the
entry with `desired_state: "running"`, signs a token for that Pod, and skips the `drain`/`stop`
logic (the stop operation is already complete). `storageWriteAuthorityForDatabase` (R2) calls it
only as a third source after `io?.pod_uid` and `heldWriterPod`.

Properties kept:

| Property | Argument |
| --- | --- |
| Tokens/held writers | Cloudflare remains the only signer. A token for a parked Pod authorizes writes that cannot happen (no postmaster). A token is never issued for a Pod UID the controller did not attest and the node proof did not evidence with `io.max`. Wake tokens reuse the attested Pod. |
| Expiry kill | Unchanged: if authority or the controller lapses, the lease reverts (180 s freshness bound on the parked hint, node authority expiry) and the guard acts exactly as for a running database. For a parked Pod this is harmless. |
| Reserved capacity | A retained thin LV's full logical size stays reserved while sleeping or parked (thin-authority-renewal.md header, plan:104); parking adds no write path and releases nothing. |
| I/O guard | The Pod's `io.max` is unchanged (Pod cgroup); the proof still measures it. |
| Quiesced device | If the guard did freeze the LV during an outage, the first wake resumes it through the existing startup path (`storage.rs:824-849`); parked state never needs a guard-side change. |
| Honest alternative | A lease field for "retained holder, no writer" is the principled design but changes the host extension and forces thin requalification (plan:225-232). R1 is the deliberate deviation: **the lease says `running` for a database whose D1 desired state is `suspended`**. Record it in the code comment and revisit when the extension next changes for another reason. |

**Existing uncertainty to confirm live (V-5).** By this reading a suspended thin entry makes the
guard act on the Pod as soon as the lease flips (suspend the LV unless `active_drain`, stop tasks
if the Pod is assigned to the sandbox runtime), which would also hit today's normal idle sleep of a
thin database before its Pod is gone. Whether the `drain` scope (`storage.rs:435-459`, requires
`drain.authority_revision > old.authority_revision`) always holds in that window could not be
established from the code alone. Confirm that a normal thin idle sleep reaches hibernation on EU1
before relying on parking: the sleep window of a parked database has the same exposure as today's,
and R1 removes the exposure afterwards.

## 4. Resource model

### 4.1 Requests and limits

| | awake (existing) | parked |
| --- | --- | --- |
| `postgres` container requests | CPU `cpu_request_millicores ?? cpu_millicores`; memory `memory_request_mib` under `actual_ram`, else `memory_mib` (`manifests.rs:148,341`, `desired.ts:256-258`) | CPU 10m, memory 96Mi on the container (lab shrank 100m/256Mi to 20m/96Mi; manager RSS ~62 MB); the Pod's effective requests stay at the class requests (below) |
| `plugin-barman-cloud` requests | 100m / 128Mi (`contracts/src/sizing.ts:5-10`) | CPU 5m, memory 64Mi (to be set from V-7) |
| limits | CPU `cpu_millicores`, memory `memory_mib`; sidecar 500m / 512Mi | unchanged (resize touches requests only) |
| RuntimeClass `spec.overhead` (pool runtime) | per-slot (immutable) | same (immutable); included in the charge |

The parked values are policy (`parked_tier`), tuned after V-7. Example (256 MiB class, plan:189):
awake requests 450m / 320Mi; parked requests stay at the class requests.

**Request floor.** A parked Pod's effective requests cannot fall below the class requests. CNPG's
regular init container `bootstrap-controller` carries `cluster.Spec.Resources`
(`cnpg:pkg/specs/containers.go:45`), and the Pod's effective request is `max(sum of containers and
sidecars, each regular init container)` for CPU and memory alike. The observation reports the
effective figures, so the API's charge is correct. Parking frees the sidecar's request delta and
the RAM the stopped PostgreSQL used (which `actual_ram` placement sees), not scheduling requests.
Classes that sleep should set small requests (`cpu_request_millicores`, and `memory_request_mib`
under `actual_ram`). Kubernetes 1.36 can shrink the completed init container in place
(`InPlacePodVerticalScalingInitContainers`, beta and on by default, with `NodeDeclaredFeatures`);
that would lower the floor but is not implemented, and EU1's feature declaration is unconfirmed.

**In-place resize versus lower fixed requests.** Fixed low requests would make every awake Pod
scheduling-light, break the API's CPU arithmetic (it charges `cpu_request_millicores`,
`startup-admission.ts:43-77`) and require a Cluster spec change (a CNPG rollout). In-place resize
keeps the awake model, needs `pods/resize patch`, and degrades safely (full requests when it is
rejected). Recommended: in-place resize.

### 4.2 Memory

Parked footprint per database is the sum of the instance manager (62 MB measured), the barman
sidecar (estimate 25-40 MiB), the pause/shim overhead outside the Pod cgroup (estimate 10 MiB)
and page cache that is not charged: about 100-115 MiB, plus the periodic burst below.

Basis of the sidecar estimate: `ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.15.1` (digest
pinned at `infra/platform/versions.lock.json:117`) is a Go controller-runtime manager with a gRPC
server on a unix socket and an uncached client for Secret, ObjectStore, Cluster and Backup
(`cnpg-plugin:internal/cnpgi/instance/manager.go`), a smaller program than the instance manager
that measured 62 MB; V-7 replaces the estimate. **The sidecar does not go idle while parked.** Its
`CatalogMaintenanceRunnable` runs at start and then every `retentionPolicyIntervalSeconds`
(default 1800, `cnpg-plugin:api/v1/objectstore_types.go:36-38`; PGCF sets only resources,
`manifests.rs:104`). Because `cluster.Status.CurrentPrimary` still names the parked Pod, each cycle
applies the retention policy (`backup_retention_days` days, `manifests.rs:275`) and reads the
backup list with barman subprocesses against R2 (`cnpg-plugin:internal/cnpgi/instance/retention.go:56-189`).
A parked Pod therefore sees at most one cycle per 1800 s of parking: a CPU burst and a transient
memory peak that sit outside the parked requests, plus R2 list requests. The cap formula (4.4)
reserves a burst allowance.

Under `actual_ram` placement the node memory sample already contains the parked footprint and any
burst in progress, so the wake admission (`startupHeadroomSql`, `startup-admission.ts:150-167`:
`available_bytes >= peak + sum(start budgets)`) is automatically conservative: it requires the
full start peak although the parked Pod already holds part of it. `reserved` placement counts every
non-deleted database at class memory (`placement.ts:260`), unchanged.

### 4.3 CPU charge

New SQL term (one helper, four call sites listed in 1.2):

```
databaseParkedCpuSql(d, acceptingStop = false)
                        = CASE WHEN <sleeping predicate of databaseCpuChargeSql(d, s, acceptingStop)>
                               AND d.parked_json IS NOT NULL
                          THEN COALESCE(json_extract(d.parked_json,'$.cpu_millicores'),0) ELSE 0 END
```

`databaseCpuChargeSql` itself is unchanged. Charging conservatively follows from existing
sequencing: the charge is full until the stop operation is confirmed, becomes parked-small with the
observation that carries `parked`, becomes full again at the wake claim (desired `running`), and
`parked_json` is cleared by the `ready` or `hibernated` observation.

The helper takes the same `acceptingStopInCurrentBatch` flag as `databaseCpuChargeSql`
(`startup-admission.ts:43-48`): the lifecycle INSERT for the `hibernated` event runs in the same
D1 batch as the UPDATE that writes `parked_json` (`observations.ts:470-526,530-545`), so its
`reserved_cpu_millicores` is `databaseCpuChargeSql("d","s",true) + databaseParkedCpuSql("d",true)`.
`UsageResourceSnapshot` (`contracts/src/usage.ts:98-106`) needs no new field.

Feasibility of the in-place resize up at wake is guaranteed by the same arithmetic: Kubernetes sums
requests of all non-terminal Pods; the controller reports as `platform_reserved_*` only Pods
outside desired database namespaces (`inventory.rs:168-186`), so parked Pods are accounted once,
through `parked_json`. A `Deferred`/`Infeasible` resize is reported and does not block admission.

### 4.4 Per-node parked cap

Inputs (all from existing node observations and policy): `A_cpu`, `A_mem` allocatable;
`P_cpu`, `P_mem` platform requests; `K` the awake limit the operator wants preserved; per-awake
charge `c_cpu` (class request + sidecar request + overhead), per-awake memory ceiling
`m_awake` (class memory limit + sidecar limit + overhead); `N` non-Pod/kernel reserve (plan:177-185:
512Mi system + 512Mi kube); parked cost `p_cpu` (the parked charge), `p_mem` (115 MiB until V-7);
`B` allowance for catalog-maintenance bursts of the sidecars (two concurrent runs at an estimated
100 MiB each until V-7; the runs are spread by their start times).

```
slack_cpu = A_cpu - P_cpu - K * c_cpu
slack_mem = A_mem - P_mem - N - B - K * m_awake
max_parked = floor(0.8 * min(slack_cpu / p_cpu, slack_mem / p_mem))
```

The cap is checked and then acted on per pass, so concurrent passes on one node can exceed it until
the oldest databases demote; a deleted or unreadable fence ConfigMap holds no slot.

EU1 worked example (inputs from plan:187-198, estimates marked): `A_cpu=5000m`, `P_cpu=650m`,
`K=9` at 450m: `slack_cpu = 300m`; with `p_cpu` at the class request (request floor, 4.1) → 0, so the
cap needs a smaller class CPU request or a smaller `K`; `A_mem = 10,819 MiB`, `P_mem` and `N` taken
as 1,500 MiB (estimate), `B = 200 MiB` (estimate), `m_awake = 256+512 = 768`:
`slack_mem = 10,819 - 1,500 - 200 - 6,912 = 2,207` → 19 at 115 MiB. `max_parked = floor(0.8 * 19) = 15`.
Recommended initial value 8 until V-6 and V-7 are measured. Parking leaves `K` unchanged only
while `max_parked * p_cpu <= slack_cpu` and `max_parked * p_mem <= slack_mem`; with the CPU floor
the request floor makes the CPU term bind first.

CNPG load: a fenced Cluster is reconciled by the operator **every second**
(`cnpg:internal/controller/cluster_controller.go:1150-1153` returns `RequeueAfter: 1s, ErrNextLoop`
for `readyInstances != instances`; translated to a plain requeue at `:267-269`), plus a Lease
update every 2 s per instance (`cnpg:api/v1/cluster_types.go:1473`). This is per parked database
and unmeasured (V-6); it is the main density cost besides RAM.

### 4.5 Effect on the density test (plan:166-221)

- S1 Create unchanged. S2 awake limit `K` unchanged while `max_parked * p_cpu` fits `slack_cpu`.
- S3 Sleep: databases park up to the cap and hibernate beyond it; the assertion "charge 0"
  becomes "sleeping charge = `parked` term"; node RAM at idle rises by `parked * p_mem`.
- S4 Wake storm: label each wake `parked` or `cold`; parked wakes bypass Pod creation; admission
  still obeys CPU/RAM start admission.
- New scenario S3p: TTL and cap demotion (observe oldest first, Pod absence, charge return) and
  CNPG-operator CPU with the maximum parked count.
- With `max_per_node = 0` every number equals today's.

## 5. Change list

### 5.1 Native controller (Rust), `apps/native-controller/src`

| File | Change |
| --- | --- |
| `power.rs` | `Phase::{Parking,Parked}`; `park` record in `Progress`; validity rules in `progress_from` (491-509); `observation()` gains `power.parked`; `suspend_step`: S5-S10 after 1444-1447; `Parked` periodic branch (verify record, TTL, cap rank, drift) next to 1354-1390; demotion A/B; `prepare_running` parked branch before 2078 (eligibility, fast path, slow path); `finish_running` unchanged (2167 stays: hibernation `on` returns None); delete flow untouched |
| `kubernetes.rs` | `resize_pod` (strategic-merge to `pods/<name>/resize`), `patch` with explicit content type; keep `named()` fixed paths (279-287); no list of Pods beyond existing |
| `postgres.rs` | `connect_pod(db, ca, role, pwd, db, ip)` (reuse `connect_at` hostaddr, 96-129); `roles` dials the Pod IP and logs roles in with `try_join_all` (212-233) |
| `reconcile.rs` | parked predicates replace kubelet-readiness gates in the fast path only (1307-1343, 158-164, 766; as built: 2.2.1); parallel eligibility reads; `needs_startup` (1140-1153) also treats a present fence annotation as a start and D-4 is fixed there; wake-phase timing events (section 6.3); `archive()` takes a `ready_required` flag |
| `main.rs` | `settle` (654-685): parked result re-queues at `min(+60 s, TTL deadline)`; parked-observation posting rule unchanged (1284-1293); no new job kind. A Pod event of a ready, including parked, cell sets `reattest` and classes its next pass `Wake` (`main.rs:543-546,594`): harmless (it only reorders and re-verifies), counted in L2 |
| `contracts.rs`/generated | `database_valid`, `DatabaseObservationUpdate` schema (regenerated), `region.parking` accessor; no fingerprint change |
| tests | section 7 |

### 5.2 API (TypeScript), `apps/api`

| File | Change |
| --- | --- |
| `migrations/0051_parked_tier.sql` | expand-only: `ALTER TABLE databases ADD COLUMN parked_json TEXT CHECK(parked_json IS NULL OR json_valid(parked_json));` and `ALTER TABLE node_region_policies ADD COLUMN parked_tier_json TEXT CHECK(parked_tier_json IS NULL OR json_valid(parked_tier_json));` Both nullable, no backfill; absent = disabled. Ship before code (same pattern as `0036_warm_reclaim.sql`). |
| `src/domain/rows.ts` | `parked_json?: string \| null` |
| `src/domain/observations.ts` | accept `power.parked` only for `state='hibernated'`, `desired_state='suspended'`, `suspension_reason='idle'`; write `parked_json = {v:1,pod_uid,generation,cpu_millicores,memory_mib,wake?,parked_at,observed_at}` in the same UPDATE as `observed_power` (470-526); set NULL for `ready`/`deleted`/`hibernated` without `parked`; leave unchanged for `provisioning`/`error` |
| `src/domain/startup-admission.ts` | `databaseParkedCpuSql`; add to `nodeCpuHeadroomSql` (113-116) |
| `src/domain/placement.ts` (260), `postgres-pool-inventory.ts` (342) | add the term |
| `src/domain/node-thin-storage.ts` | `parkedHolder`; R2 branch in `storageWriteAuthorityForDatabase` (305-376); R1 presentation and freshness bound in `hostStorageLease` (870-961) |
| `src/domain/desired.ts` | `region.parking` whenever the region policy is set |
| `src/domain/node-state.ts`, `src/routes/nodes.ts` | persist/serve `parked_tier` in the capacity policy (upsert pattern 193-223; `KEEP` semantics, `contracts/src/nodes.ts:~143-200`) |
| `src/domain/postgres-pool.ts`, `postgres-pool-cold-start.ts` | `AND d.parked_json IS NULL` in claim eligibility |
| `src/database-actor.ts`, `observations.ts`, `desired.ts` | timing events (section 6.3); optional trims (6.4) |
| OpenAPI | regenerate agent/internal schemas; public documents unchanged |

### 5.3 Contracts (`packages/contracts`)

| File | Change |
| --- | --- |
| `src/agent.ts` | `DatabaseObservation.power.parked: strictObject{pod_uid:uuid, cpu_millicores:Count, memory_mib:Count, wake:literal("fast").optional()}.optional()`; superRefine: only with `state==="hibernated"` and no `refusal` (extends 599-620); `DesiredResponse.region.parking: ParkedTierPolicy.optional()`; `cpu_millicores` and `memory_mib` are the Pod's effective scheduling request after the resize (container requests plus `Pod.spec.overhead`), the quantity Kubernetes sums per node |
| `src/nodes.ts` | `NodeRegionPolicy.parked_tier: ParkedTierPolicy.nullable().optional()`: `{enabled, ttl_seconds 60..3300, max_per_node 0..64, postgres_cpu_millicores, postgres_memory_mib, sidecar_cpu_millicores, sidecar_memory_mib}` |
| `native/*.generated.json` | regenerate (`generate.ts`); wire constants are Kubernetes keys held as Rust consts like `HIBERNATION` (power.rs:30) |

There is no release marker. Order: migration, API, release containing the controller, policy PUT;
an older controller rejects `region.parking` on its strict parse, so the policy is set only after the
new controller runs.

### 5.4 Edge and gateway

- **Edge** (`apps/edge`, `apps/edge-rust`): no change for correctness. Optional timing fields
  (6.3).
- **Gateway G-1, implemented, no image released**
  (`apps/native-gateway/src/targets.rs`, `kubernetes.rs`): route to the controller-attested Pod
  before its Ready condition. In `endpoint()` (466-551), when no ready endpoint exists, accept the
  single endpoint whose `targetRef.uid` equals the fence's `admission_target.pod_uid`
  (`apps/native-gateway/src/kubernetes.rs:25-37,45`, written by `persist_admission_target`,
  reconcile.rs:2094-2150), not terminating, address private and unique; in `runtime_container()`
  (239-267) accept a `postgres` container that is `running` with
  `containerID == admission_target.container_id` without `ready == true`. Everything else stays:
  v4 token with equal Pod UID, container ID, CA identity, intent `running` at the admitted
  revision, storage binding and token (transport.rs:632-690,826-879). The EndpointSlice still
  proves the Service selects this Pod. The Ready bit is a kubelet opinion; the attested identity is
  stronger evidence for admission than it. The sketch let the attestation route for as long as the
  fence carried it; the implementation spends it at the kubelet's report and bounds it (below),
  because a Pod that was Ready and is not any more is not a wake: the report was withdrawn for a
  reason the attestation does not know, and a dial to it can still reach a PostgreSQL the cluster
  has replaced. Requires a gateway image release (README: Dockerfile pins).
  The implementation is stricter than that sketch in these ways, each pinned by a test in
  `targets.rs`: the target counts only from a live fence in mode `running` whose target
  generation equals the intent revision (`Targets::attested`, parsed by the same
  `kubernetes::admission_target` as the fence watch); the attested endpoint must be the only
  non-terminating candidate (another not-Ready endpoint makes the writer ambiguous) and have
  exactly one address; the Pod watch must show the Pod on that node and address, not deleting,
  with the attested container running, and the watched CA identity must equal the attested one
  (`Targets::runs_attested`); the route is withdrawn while the Pod watch is stale; only a v4
  route may use such a writer (`admitted_runtime_current`); a Ready endpoint always wins and a
  pool binding never falls through. The attestation is spent once the gateway has seen that Pod's
  endpoint and `postgres` container Ready for that Pod UID, container ID and revision (`Witness`,
  kept per database in the gateway's own memory; the controller publishes nothing for it), and it
  ends `ATTESTED_ROUTE_BOUND`, the startup bound of a connection (`transport::STARTUP_BOUND`,
  10 s), after the gateway first relied on it. No cluster event marks that bound, so it is read at
  every admission and every check of an established session. A session admitted on the
  attestation is closed, not drained, when the fence leaves `running` at the attested revision or
  the container is restarted before the kubelet's report: the evidence it rests on is withdrawn,
  which the generation check (target generation equals the intent revision) is there for; after
  the report it is an ordinary session. `/readyz` requires the Pod watch beside the fence,
  EndpointSlice and ConfigMap watches, since only it recognizes such a writer, and `conn_stages`
  carries the fixed `route` class (`ready` or `attested`) so that a live read tells the paths
  apart. The measurement gate the sketch named
  (`kubelet_ready - pg_accepting >= 300 ms` at p50) is met by the lab numbers of section B:
  PostgreSQL accepting 226-305 ms and Cluster Ready 564-753 ms after the same annotation, about
  390 ms between the range midpoints. The controller side is implemented (2.2.1: `resumed_settled`
  in `power/parked.rs`, the `postgres` container `ready` gate and the archive sample's Pod `Ready`
  in `reconcile.rs` no longer wait for the kubelet's bit); V-11 must hold on EU1 before the
  gateway is released.

### 5.5 Infrastructure

- `infra/platform/regional-native/rbac.yaml`: JSON-patch op adding `{apiGroups:[""],
  resources:[pods/resize], verbs:[patch]}` to ClusterRole `pgcf-agent`. The wake path v2 adds `watch`
  for the kinds of the manifests and the volume that the metadata watches follow (quotas, limits,
  network policies, Cilium policies, the scheduled backup, the object store, the LVMVolume). Update the comment in
  `infra/platform/regional/rbac.yaml` ("Pods are never ... patched"). The right is cluster-wide
  like the existing Pod `delete` (`infra/platform/regional/rbac.yaml:86-89`); RBAC cannot scope by namespace label.
  A ValidatingAdmissionPolicy limiting `pods/resize` by this principal to `pgcf-db-*`
  namespaces is an optional hardening (open question Q6).
- NetworkPolicy/CiliumNetworkPolicy: none (agent to 5432 and 9187 is allowed, `manifests.rs:218-227`).
- Fleet release: new native-controller image digest in `infra/platform/versions.lock.json`; host
  extension, driver and kernel identical.

### 5.6 Documentation

`plan` rows (Sub-second decision, Wake orchestration, Wake stage measurement, Density, Shared
PostgreSQL warm pool) and Done measurements; `pool:913-918,771-773` (alternative 7 and the
fencing remark: D-1); `rt` section 4/5/15 state table and acceptance (D-2, D-3); `README.md`
states and the wake diagram (diagrams are checked by the repository's mermaider tooling before
push); `docs/operations/recovery.md` (parked-tier runbook: policy off demotes every parked
database); `apps/api` OpenAPI text for the capacity policy.

### 5.7 Items that force thin requalification

None. Host extension (`pgcf-sandbox-controller`), driver image, kernel and thin profile are
untouched (plan:225-232). Do **not** add tests to `apps/sandbox-controller`; any change to that
crate alters the extension's source identity.

## 6. Latency

### 6.1 Budget, connect to first row, parked wake

Measured anchors: awake first row 0.47-0.96 s (warm 0.54-0.61 s) with client to Edge 45-113 ms,
Edge admission including Actor and Tunnel WebSocket 117-217 ms, gateway accept to
StartupMessage 24-101 ms, PostgreSQL dial 3-12 ms, round trip 23-43 ms (plan:126). CNPG wake
8.1-9.4 s; Pod Ready to admission 1.1-2.9 s.

| # | Stage | Measured | Target (p50) | Event name | Lever |
| --- | --- | --- | --- | --- | --- |
| 1 | client to Edge upgrade | 45-113 ms | 60 | client `t0`; Edge `conn_admission` | none |
| 2 | Edge pre-wake: 2 rate limiters + Actor RPC | unmeasured | 25 | `edge_ensure_awake` | issue second limiter in parallel (`index.ts:63-70,127-134`) |
| 3 | Actor claim (D1 batch, barrier, hint) | unmeasured | 80 | `actor_claim` | trim reads (6.4 #12) |
| 4 | hint to controller (RegionLink to WebSocket) | unmeasured | 40 | `wake_hint_received` | none |
| 5 | desired pull for the id | unmeasured | 60 | `desired_pull` | 6.4 #11 |
| 6 | eligibility reads + unfence patch (+resize) | unmeasured | 30 | `park_eligibility`,`unfence_patch`,`resize_up` | parallel reads |
| 7 | unfence to PostgreSQL accepting | 226-305 ms incl. 160-207 ms laptop to API; PostgreSQL start 111-117 ms | 150 | `pg_accepting` | none |
| 8 | verification (identity, roles, archive, proofs) | unmeasured | 80 | `role_runtime_auth`,`archive_metrics`,`volume_identity`,`runtime_unchanged` | parallelize (6.4 #4,#5) |
| 9 | fence release + gateway acks | unmeasured | 30 | `fence_release` | none |
| 10 | observation POST, D1 commit, publish, Actor release, admit | unmeasured | 120 | `observation_post`,`observation_commit`,`admission_publish`,`actor_release` | 6.4 #10,#13,#14 |
| 11 | token sign, Tunnel WebSocket, gateway dial | part of 117-217 ms | 80 | `edge_token`,`edge_gateway_connect`,`conn_stages` | G-1 removes the readiness wait |
| 12 | PostgreSQL protocol (SSLRequest, startup, SCRAM, query) | 23-43 ms per round trip, 4-5 round trips | 150 | client | none |

Sum of the allocations: 905 ms, of which 315 ms are the stages every connection pays (1, 2, 11,
12) and 590 ms the wake-specific stages 3-10. Two corrections to that sum:

1. The measured awake first row is 0.47-0.96 s, 0.54-0.61 s warm (plan:126), i.e. the stages every
   connection pays already cost more than their 315 ms allocation. With the awake floor and the
   allocated wake-specific stages the first row is about 0.54-0.61 s + 0.59 s = **1.1-1.2 s**.
   Below 1 s needs the wake-specific stages near 400-450 ms, about 130-200 ms of removals beyond
   the allocations, or a lower awake floor. The allocation sum alone must not be read as a
   sub-second promise.
2. **With kubelet readiness in the loop** stage 7 becomes `unfence + readiness`: lab 564-753 ms
   from a laptop, i.e. roughly 0.4-0.65 s in the cluster instead of the 150 ms target, and the
   existing verification chain then runs after readiness (Gate 0 measured 1.1-2.9 s from Pod Ready
   to admission for the CNPG wake, partly overlapping). Expected for the first implementation:
   **1.3-2.2 s**, against 8.1-9.4 s today.

**Conclusion:** the parked tier moves a wake from 8-9 s to roughly 1.3-2.2 s without further work
and to about 1.1-1.2 s with direct readiness, the gateway change G-1 (so that the route does not
wait for the kubelet probe) and the trims in 6.4. Sub-second is a stretch target that additionally
needs the removals above, which is the same position the plan takes for a pool hit (plan:123). The targets are allocations, not measurements; stages marked
"unmeasured" have no number anywhere in the repository, and the first live run (6.3) replaces
them.

### 6.2 Phase order (dependencies, not durations)

P0 timing events only (controller + API), measure the CNPG wake split. P1 parked tier with the
existing readiness predicates (expected 1.3-2.2 s). P2 direct readiness plus G-1 if
`kubelet_ready - pg_accepting >= 300 ms`. P3 trims that P0/P1 show to matter. No stage is built
before its measurement names it.

### 6.3 Minimal instrumentation

One correlation key everywhere: `database_id` + power `operation` id; every event carries wall
clock `at_ms` (NTP-synchronized hosts, skew bounded by the 5 s node-clock checks already used,
e.g. `power.rs:1817-1819`) plus component-local monotonic `elapsedMs`.

- **Native controller** (reuse the TypeScript agent's event shape, `apps/regional/src/agent/power.ts:56-123`:
  `{"event":"wake_phase","phase","elapsedMs","outcome","database_id"}`; `WAKE_PHASES` constants
  already generated into `power.generated.json` but not emitted by the native controller): emit
  `wake_hint_received` (the `desired` link message, `main.rs:871-872`), `desired_pull` (`main.rs:1079,1088,1220`),
  `wake_prepare`, `park_eligibility` (+reason), `unfence_patch`, `resize_up`, `pg_accepting`
  (+poll count), `resize_actuated`, `kubelet_ready_observed` (informational: when the kubelet's
  Ready bit of the resumed Pod was first read, the wait the wake no longer pays),
  `desired_apply`, `role_runtime_auth`, `archive_metrics`, `ca_publication`,
  `volume_identity`, `runtime_unchanged`, `fence_release`, `observation_post`; plus
  `reconcile_summary {calls, elapsedMs}` (count of Kubernetes calls) and `loop_lag_ms` of the
  single-threaded runtime (`main.rs:1322`, measurement cycle every 250 ms at 981-1012).
- **API**: `actor_claim {claim_ms, hint_ms}` (`database-actor.ts:926-1042`),
  `actor_release {waited_ms, via: push|poll}` (1197-1267), `desired_page {elapsedMs}`
  (`desired.ts:68-324`), `observation_commit {d1_ms, publish_ms, push_ms}`
  (`observations.ts:470,735,748`).
- **Edge**: add `ensure_awake_ms`, `token_ms`, `gateway_connect_ms` to the existing
  `conn_admission` line (`index.ts:250`, `runtime.rs:250`); **gateway**: `conn_stages` exists
  (`transport.rs:252`).
- One live run (section 7.3 step L3) prints the full split; the client records `t0` and first row.

### 6.4 Known sources of delay after readiness, with proposed removal

| # | Location | Mechanism | Removal |
| --- | --- | --- | --- |
| 1 | `main.rs:561-567,654-685` | a not-ready wake re-runs after 1 s (first five), unless a Kubernetes hint arrives | parked fast path polls inside one job (20 ms) and never returns to the scheduler |
| 2 | `manifests.rs:341`, `reconcile.rs:1307-1343,158-164,766` | kubelet readiness (1 s probe), Cluster `Ready`, container `ready`, Pod `Ready` gate the chain | direct SQL readiness in the parked path; G-1 in the gateway |
| 3 | `reconcile.rs:1233-1246,2281-2322` | ~13 manifests, each GET then (on the first pass after any generation change) PATCH + read-back GET, sequential; a power transition always changes every generation annotation | issue reads concurrently (bounded 4-8); skip objects whose content is unchanged except the generation annotation by patching those after publication; unfence first, apply pass in parallel with PostgreSQL start |
| 4 | `reconcile.rs:1372-1393`, `2008-2093` | re-GET every applied object, then 3 + 8 more GETs for the runtime readback, sequential | `try_join_all` (pure reads) |
| 5 | `postgres.rs:221-233`, `reconcile.rs:703-724`, `postgres.rs:116` | one TLS+SCRAM login per role in sequence, another login for the archive sample, all through Service DNS (needs a Ready endpoint) | parallel logins, reuse one maintenance session for identity and archive queries, dial the Pod IP |
| 6 | `kubernetes.rs:865-871` | every PATCH is followed by a GET; ~8 patches on the wake path | return the PATCH response (uid already verified at 862); keep the read-back only for uncertain results |
| 7 | `power.rs:574-580` (called at 1285, 1444, 2047, 2166, and in `verify` 1080) | `anchor` lists **all** PersistentVolumes and LVMVolumes of the cluster each call | GET the PV by the recorded handle and the LVMVolume by name |
| 8 | `reconcile.rs:1020,2219`, `kubernetes.rs:1027` | `assert_cluster` GET twice per reconcile | cache for one reconcile |
| 9 | `kubernetes.rs:483-640` + `main.rs:591-595,1158` | the controller's own writes (progress, annotation, ledger) are watched and mark the cell due again: each write forces another full pass | ignore events whose resourceVersion equals a version the controller just wrote |
| 10 | `reconcile.rs:1513-1521`, `main.rs:1284-1293` | observation is posted only after `persist_admission_target` and the whole chain | keep order (the gateway needs the target) but run `persist_admission_target` concurrently with the proof readback it follows |
| 11 | `api.rs:348-380`, `desired.ts:68-324` | one HTTP page per hinted id; the handler runs region policy, all thin nodes' authority (`desiredRegionStorageNodes` 96), samples, a large JOIN, per-row credential decrypt, `storageWriteAuthorityForDatabase` re-reading the node authority (169), release and archive sources | a single-database fast path that skips region-wide reads the controller already holds (the snapshot is cached; only the database row changes) |
| 12 | `database-actor.ts:926-1042` | claim performs `known()` (admission query), `SELECT *`, sleeping-intent SELECT, pool prepare (3 reads, `postgres-pool.ts:286-305`), admission barrier, batch, two more SELECTs, DO SQL, hint: ~8-10 sequential awaits | skip pool prepare when `parked_json` is set; read once; send the hint before non-essential reads |
| 13 | `observations.ts:735` | `publishDatabaseAdmission` (repair RPC, snapshot reads, seed RPC, publish RPC) is awaited **before** the push that is `waitUntil` at 748 | start the push first or run both with `Promise.all` |
| 14 | `database-actor.ts:1197-1267` | push only interrupts the loop; the loop re-reads D1 (SELECT), then `admit` reads D1 unless a snapshot is cached | trust the publish: `publishAdmissionSnapshotLocked` already sets `pushed` (`database-actor.ts:296-306`); drop the second read when the snapshot generation equals the wake revision |
| 15 | `apps/edge/src/index.ts:63-70,127-134` | second rate limiter awaited after the wake | issue in parallel |
| 16 | `main.rs:1322,981-1012` | `current_thread` runtime shared with a 250 ms measurement cycle (4 GETs per database) | measure `loop_lag_ms` first; deprioritize or move the cycle only if lag is observed |
| 17 | `cnpg:pkg/management/postgres/instance.go:1565` | instance manager sleeps 20 s inside its reconcile loop after lifting a fence (does not block readiness) | none; documented: a re-fence inside 20 s is deferred, and role/config changes after unfence wait for it (hence the slow path for them) |

Items 11 to 14 are implemented in the API, measured in the Actor and desired-page tests as
sequential D1 round trips (the Actor's concurrency block is held across every one of them in the
claim):

- Item 11, without a contract change: the page's region reads (capabilities, policy, thin nodes,
  samples, fleet release, archive sources) are issued together, and each thin node is read once for
  the page and its databases. One database: 10 sequential round trips became 3 (thick), 20 became
  9 (thin).
- Item 12: the claim reads the database row with the admission read, the epoch once (it inserts only
  a first one), no presence for its own mutation, and issues no fence after a returned batch. The hint leaves at the commit, before the snapshot publish, and
  the committed row and operation are not read back. From the call to the hint: 16 round trips
  became 7; to the registered waiter: 17 became 10.
- Item 13: the push leaves at the commit, independent of the publish. A report is answered after at
  most one second of publish, which then finishes in the background; `observation_commit` carries
  the publish's steps and `actor_gate_held` names an Actor concurrency block held for a second.
- Item 14: a publish whose snapshot is admissible at the wake's revision, with no barrier standing,
  releases the waiters itself. A failed readiness read no longer fails a waiter: it is read again
  with the next push or after the fallback interval, and every waiter keeps its own deadline.

Items 3 to 10 are implemented in the native controller, measured in the in-process world (the
controller's own code against doubles of the Kubernetes API, PostgreSQL and the gateways) as
requests and as sequential round trips of a parked wake; the live effect is a measurement of the
next run, not of this list:

- Item 6: a PATCH or a Pod resize returns the server's answer after the identity checks the
  read-back had; a write of the gateway fence was a PATCH, a read-back and a read of the fence and
  the receipt (three rounds), and is one. A parked wake: 126 reads and 19 writes became 103 reads and
  19 writes.
- Item 7: the anchor reads its PersistentVolume and its LVMVolume by the handle the receipt
  recorded, together with the Node of a thin database, instead of listing every PersistentVolume and
  every LVMVolume of the cluster (four collection reads per wake, and per pass over an awake
  database whose operation is still in the record, two without). The failure codes and their order
  are unchanged and pinned.
- Item 8: a pass reads the identity of the cluster once: 2 reads became 1.
- Item 3: the thirteen manifests of a generation are read together before the first is written.
  What binds the Pod the Cluster creates (quota, limits, the three network policies, the Cilium
  policy, the archive store) is written together when all of it exists and all of it before the
  Cluster, which is read when its turn comes (CNPG writes its status continually) and followed by
  the scheduled backup; when something has to be created, the writes are one after another in
  manifest order as before. The apply pass of a new generation (nine of thirteen patched): 31
  sequential round trips became 6 with item 6.
- Item 4: the check that the applied objects stayed as applied reads them and the TLS authority
  together (14 sequential reads became two bounded waves), and the proof of the runtime reads its
  eleven objects in three rounds (11 sequential reads became 3), every object still read again after
  it was read.
- Item 5: the session that proved PostgreSQL accepts on the resumed Pod is the maintenance session
  of the attribute check and of the archive sample: maintenance logins of a parked wake 2 became 1
  (3 became 1 with a role that has attributes). The roles log in on their own credentials, together,
  on the Pod route as before; the ordinary CNPG wake keeps its sequential logins through the Service.
- Item 10: the gateways, the fence and the receipt are read back together with the write of the
  target, after every gateway acknowledged the release and not before: five requests in four rounds
  became four requests in one. A parked wake with items 3 to 10: 126 reads and 19 writes became 101
  reads and 19 writes; the pass over the awake database after it, 92 reads and 2 writes, became 84
  reads and no write (with item 9).
- Reads of the same kind around them, issued together as well (no write moved and none is dropped
  half sent): the identity of the cluster with the fence, then the Node, the deletion marker, the
  namespace, the receipt and the Cluster at the start of a pass (7 sequential reads became 2
  rounds); in the release of the fence the anchor with the fence and the binding with the gateway
  snapshot (2 rounds fewer); in the archive probe the credential, the Cluster, the Pod and the
  receipt read again after its questions (3 rounds became 1); the claim with the receipt of the
  volume's binding, the namespace label with the primary, the authority with its published copy,
  and the resumed Pod with the record of the wake, and the anchor with the fence of the wake's
  preparation (1 round fewer each). Everything above together, with every Kubernetes request of
  the in-process world answered after the same delay: a parked wake of 145 requests in 115
  sequential rounds became 120 requests in 43 rounds.
- Item 9: the version of every object the controller writes is remembered, and the watch event of
  exactly that version hints no database; a pass over an unchanged awake database writes nothing.
  Live, an awake database was reconciled 1.5 times a second as long as it stayed awake (89 requests
  and one accepted observation per pass): each pass rewrote the gateway fence (the record back to
  `Wake` and again to `Awake` with a new start, or `Awake` alone), which the watch delivered and
  which made the database due again at once. In the in-process world a pass over an unchanged awake
  database wrote the fence twice (once without the operation in the record) and now writes nothing; a
  completed wake leaves no hint behind, and the next pass is the proof renewal or a change of
  someone else.

Wake path v2 (W1, [wake-path-v2-and-scale.md](wake-path-v2-and-scale.md) 4.2) changes this list's
shape: a wake reads through a memory of what the watch proves unchanged, publishes on the barrier
read of the Pod and the Cluster, and leaves the stamps of items 3 and 4, the role logins of item 5 and
the archive probe to the pass after it. In the same in-process world a parked wake after a periodic
parked pass is 4 reads and 6 writes in 5 sequential rounds (from 100 and 19 in 43), and its first
request is the wave of writes that unfences.

Optional, only if P0/P1 show the pull dominating: **speculative unfence on hint**. The existing
principle (rt:264) says hints are not executable desired state; the unfence is idempotent,
reversible and non-admitting (the gateway stays closed until the authoritative pull verifies), so
the exception is bounded. Default: off.

## 7. Test plan

### 7.1 Failing tests first, controller (Rust)

Level: `PowerCoordinator::with_clock` against the in-process HTTPS Kubernetes double
(`apps/native-controller/src/test_server.rs`, records every write and can drop the reply of one
committed write) in `power.rs` `tls_tests`-style modules; plus the isolated real
kube-apiserver/etcd fixture (`apps/native-controller/tests/run-kubernetes.py`, example
`parked-kubernetes.rs`, the only example it runs).

| Test (name) | Level | Proves |
| --- | --- | --- |
| `an_idle_sleep_parks_only_after_the_recorded_segment_is_archived` | double | no fence before `segment`+`Proved`; `Parking` persisted before the annotation patch; annotation exactly `["*"]`; hibernation untouched |
| `a_busy_or_unproved_sleep_never_fences` | double | refusal paths unchanged (mirrors power.rs:3641) |
| `park_requires_a_stopped_postmaster_and_fence_gauge` | double (metrics text, refused connect) | `Parked` only after `fencing_on 1` and refused 5432; Pod UID bound |
| `an_uncertain_fence_patch_is_read_before_continuing` | double (`lose`) | CAS and read-back semantics |
| `resize_down_uses_strategic_merge_on_the_resize_subresource_and_never_changes_limits` | double + real apiserver | body shape, UID precondition, both containers, QoS accepted |
| `a_rejected_resize_parks_with_full_requests_recorded` | double | fallback charge |
| `a_hibernated_cluster_demands_a_current_startup_hold_before_resume` | double | D-4: fails today because the condition type never matches |
| `a_fenced_cluster_demands_a_current_startup_hold_before_unfence` | double | no unfence without `startup_valid` |
| `a_parked_wake_unfences_resizes_and_publishes_after_sql_identity` | double + SQL double | order: progress `Wake`, one patch removing the fence and setting hibernation off, SQL proof with fresh `pg_postmaster_start_time`, then fence release |
| `any_manifest_content_change_takes_the_slow_path` | double | role secret, size, image, plugin each force demotion |
| `a_changed_pod_uid_container_id_boot_id_or_release_forces_demotion` | double | identity predicates |
| `ttl_demotes_a_parked_database_without_starting_postgres_when_phase_is_healthy` | double | algorithm A |
| `a_stuck_phase_unfences_before_hibernation` | double | algorithm B |
| `the_oldest_parked_databases_demote_themselves_when_the_cap_is_exceeded` | double | rank rule |
| `manual_suspend_of_a_parked_database_hibernates_and_observes_the_new_operation` | double | trigger 5 |
| `the_fence_is_removed_when_hibernation_completes_and_on_every_wake` | double | no fenced replacement Pod |
| `parked_progress_roundtrips_and_an_unknown_phase_is_a_recovery_error` | unit | forward/backward safety |
| `a_parked_observation_validates_against_the_generated_schema` | unit | contract |

Real-apiserver example checks only API semantics available without kubelet or CNPG: annotation
merge-patch with `null` removal on a minimal Cluster CRD, `pods/resize` patch validity for a Pod
with a restartable init container and both content types, UID precondition.

### 7.2 Failing tests first, API (real D1 harness, `apps/api/test/domain`)

| Test | Proves |
| --- | --- |
| `parked_observation_is_stored_only_for_idle_sleeps_and_cleared_by_ready_or_demotion` | `parked_json` lifecycle |
| `parked_cpu_is_charged_in_node_headroom_and_placement_but_cold_predicates_still_hold` | charge split; resize/rollouts still allowed |
| `a_parked_database_gets_a_running_lease_entry_with_a_token_for_the_parked_pod` | R1, `desired_state:"running"`, no `drain`, no `startup_*` |
| `the_first_lease_after_a_wake_claim_carries_a_token_for_the_new_generation_and_the_same_pod` | R2 (guard never sees a startup entry without a token) |
| `parked_token_requires_io_evidence_for_the_attested_pod_and_a_fresh_controller_observation` | R3, 180 s bound |
| `headroom_tokens_and_desired_records_carry_no_token_for_a_parked_database_before_wake` | no ledger churn |
| `desired_region_parking_only_for_capable_regions` | gating |
| `pool_claim_is_refused_for_a_parked_database` | exclusion |
| `capacity_policy_parked_tier_roundtrip_and_keep_semantics` | contract + route |

The guard's acceptance rules cannot be exercised from TypeScript. They are verified live (L2/L3).

### 7.3 Live acceptance on EU1 (throwaway database, nothing bought, no production write)

Run on the thin class used for acceptance, region policy `parked_tier` set explicitly, with
`max_per_node` at least 1. Stage events from 6.3 enabled.

| Step | Action | Proves |
| --- | --- | --- |
| L0 | record VG free bytes, node RAM/CPU, controller/gateway/CNPG versions, operator CPU | baseline and the number step L7 must restore |
| L1 | create the database, SQL through Cloudflare, commit a marker | create path unchanged |
| L2 | idle to sleep; wait 3 x (`guard_seconds` + `drain_seconds`) | public `hibernated`; Pod Running not Ready; annotation `["*"]`; Lease held; 5432 refused; requests shrunk; **LV not suspended and Pod tasks alive** (V-5); `.done` of the closed segment in R2; `parked_json` set; charge equals parked term; PG start absent |
| L3 | connect and read the marker, 5 times with a 2 minute gap; record the stage split | marker intact; wake latency distribution labelled `parked`; the guard did not stop the Pod at the generation change (no container restart, `restartCount` unchanged); `pg_accepting`, readiness lag, chain cost |
| L4 | idle again; let TTL expire | demotion A: Pod deleted, hibernation `on`, fence removed, `parked_json` NULL, charge 0, Cluster condition `Hibernated` |
| L5 | connect | CNPG wake baseline (8-9 s) and marker intact; archive continuity on the same timeline |
| L6 | one failure probe each on a fresh parked database: controller restart; operator restart; instance-manager container killed (restarted in place, fenced, then demotion); Pod delete (recreated fenced, then algorithm B); role password reset (slow path correct); resize (slow path correct); manual suspend | each resolves to a consistent state with no second postmaster |
| L7 | delete the database | namespace, PV, LV removed; VG free bytes equal L0 |

### 7.4 Live checks that gate the design

- V-1: phase and `Ready` stay Healthy/True while fenced and unrecreated (`kubectl get cluster -o json`).
- V-2: setting hibernation `on` on a fenced Healthy Cluster deletes the Pod and reaches `Hibernated`, and a fenced Pod deleted by hand is recreated fenced with the phase left below Healthy until it is unfenced (premise of algorithm B).
- V-3: resize of the restartable init container `plugin-barman-cloud` and of `postgres` together: no restart, `PodResizeInProgress` clears.
- V-4: admission policies do not intercept `pods/resize` (`runtime-admission.ts:49-60` matches `CREATE` of `pods` from the CNPG principal only).
- V-5: guard behaviour for suspended thin entries versus the R1 presentation (3.3).
- V-6: CNPG operator CPU and API-server write rate with the maximum parked count.
- V-7: parked RSS/CPU of instance manager and sidecar over at least one full 1800 s maintenance cycle (peak RSS of the sidecar cgroup during the barman subprocesses, CPU seconds, R2 request count per cycle).
- V-8: a 03:00 Backup stays Pending while parked, runs within 30 s of the first wake or fails at demotion, and the first-query latency while it runs (Q16).
- V-9: `managedRolesStatus` still acknowledges the unchanged role Secrets immediately after unfence.
- V-10: PostgreSQL start latency after a fence (clean) versus crash recovery frequency.
- V-11: EndpointSlice carries the not-ready endpoint with `ready=false` for `database-rw` (premise of G-1).
- V-12: what a node reboot does to a parked Pod (in-place container restart, or terminal Pod with replacement), observed at the next fleet-patch reboot rather than forced; no `PodDisruptionBudget` interference (fleet patches use reboots, not eviction).
- V-13: duration of the fence stop (checkpoint plus fast shutdown) on EU1 against the profile's `drain_seconds`, with the shutdown checkpoint of a database that just served writes.

## 8. Risks and open questions

| # | Risk or question | Recommended default |
| --- | --- | --- |
| Q1 | Owner decision: a per-database retained Pod contradicts `rt:70-72,193-194` and the pool acceptance text (D-2), and both routes aim at the same sub-second goal with the same arithmetic (0.3). | Build the parked tier first (smaller: no host extension, no thin requalification), measure it (6.3, L3), then name one route in the acceptance rows and delete the other (AGENTS.md: no parked or held work). Amend D-2 and D-3 together with that decision. |
| Q2 | Scope: idle sleeps only (manual suspend stays real hibernation per `rt:205`). | Idle only. |
| Q3 | TTL and cap. | `ttl_seconds` 600, `max_per_node` 8 (raise after V-6/V-7); upper TTL bound 3300. |
| Q4 | Lease presentation (R1) versus an honest lease field with a host-extension change and requalification. | R1 now; revisit at the next extension change. |
| Q5 | Gateway change G-1 is security-relevant (route before kubelet Ready). | Implemented (5.4) on the lab gate; keep v4 token, admission target, token and storage binding checks. Release only after V-11 and a live read of the first-connection stages (`conn_stages`, 6.3; its `route` tells the attested path from a Ready one). |
| Q6 | `pods/resize patch` cluster-wide (no namespace scoping in RBAC). | Accept, comment in rbac.yaml; ValidatingAdmissionPolicy restricting to `pgcf-db-*` only if the owner wants it. |
| Q7 | CNPG operator reconciles each fenced Cluster at 1 Hz; unmeasured. | Measure (V-6). Mitigations only if observed: lower TTL; `cnpg.io/reconciliationLoop: disabled` is possible but also disables hibernation, so it is not recommended. |
| Q8 | Startup probe kills a *restarted* fenced container after 3600 s; a container waiting in `CrashLoopBackOff` is "not alive" (`cnpg:pkg/utils/pod_conditions.go:98-107`) and a Cluster without a live instance is registered `Unrecoverable` (`cnpg:internal/controller/cluster_controller.go:954-960`, `cnpg:internal/controller/cluster_status.go:101-108`). | TTL <= 3300 s; algorithm B unfences first. |
| Q9 | First wake after any fleet/operator release change is a slow wake. | Accept; or demote parked databases when a release is assigned. |
| Q10 | Speculative unfence on hint (6.4). | Off until measured. |
| Q11 | Usage and cost metrics: parked time is public `hibernated` (no awake seconds), but the Pod holds real node RAM and a small CPU request. AGENTS.md: usage and infrastructure cost are reported as metrics, prices belong to integrators. | No new metric name. `reserved_cpu_millicore_seconds` carries the parked CPU through the lifecycle snapshot (4.3); `reserved_memory_mib_seconds` already counts class memory for sleepers (`observations.ts:530-545`). A separate `parked_seconds` dimension in `USAGE_METRICS` (`contracts/src/usage.ts:10-25`) is a contract change and an owner decision; not recommended before a consumer asks. |
| Q12 | Rollback of the controller while databases are parked makes `power.json` unreadable. | Operations runbook: set `parked_tier.enabled=false`, wait for demotion, then roll back. |
| Q13 | Sidecar and instance-manager RSS drift with CNPG/plugin upgrades. | Re-measure (V-7) per release; parked requests are policy, not code. |
| Q14 | Guard-lease `running` for a suspended database may confuse a future reader. | Code comment at the R1 site referencing this section; one live test (L2/L3) keeps the behaviour pinned. |
| Q15 | The barman sidecar keeps its catalog maintenance while parked (CPU and memory burst outside the parked requests, R2 list requests, every 1800 s of parking; 4.2). | Accept. The default TTL of 600 s bounds it to at most one cycle per park; measure in V-7; if the peak is material, raise `B` in the cap formula rather than changing the ObjectStore interval. |
| Q16 | A Backup created at 03:00 stays Pending while a database is parked and runs at its first wake (today a database hibernated at 03:00 skips that day's base backup). | Accept: it is the schedule's intent and equals what an awake database does at 03:00; V-8 measures the first-query latency effect. If it matters, demote a parked database whose daily Backup is Pending (one more trigger in 2.3) so that it fails as today. |
| Q17 | Per-database opt-out. The tier is a region policy; there is no per-database switch in v1 (AGENTS.md: no machinery for a hypothetical problem). | A database that must never park uses `sleep_after_seconds: null` (always warm: `rt:209`, `database-actor.ts:1384`) or warm reclaim; add a per-database field only when an integrator asks. |

## Lab measurements

### A. PostgreSQL 18.6 clean start floor (Pod pgcf-lab-pgstart, emptyDir, 6 vCPU / 12 GB EU1, product image)
initdb 1,014 ms. Eight rounds of `pg_ctl start -w` on a cleanly shut down 200k-row cluster (shared_buffers 32MB,
archive_mode on with archive_command true): start to ready 111-117 ms, start to first SQL (psql spawn included) 136-169 ms.

### B. CNPG fence/unfence on EU1 (namespace pgcf-lab-fence, CNPG 1.30.1, one instance, 1 GiB thick pgcf-lvm volume, product
postgres image, probes period 1 s, no barman plugin)
- Cluster Ready after 13.0 s (initdb job + Pod).
- Baseline Pod recreation (kubectl delete pod, CNPG recreates it): delete to Cluster Ready 5,198 ms and 4,102 ms.
- Fenced Pod: stays Running; instance manager (Go) RSS about 62 MB (cgroup memory.current 61.9 MB); PostgreSQL stopped.
- Unfence (remove annotation cnpg.io/fencedInstances) five rounds, laptop clocks, t0 before the annotate call:
  annotate API round trip 160-207 ms (laptop to API server, not present in-cluster);
  unfence to PostgreSQL accepting connections (in-pod pg_isready loop, 20 ms poll) 226-305 ms total;
  unfence to Cluster readyInstances=1 (kubelet readiness probe period 1 s) 564-753 ms.
- In-place Pod resize (pods/resize) of requests 100m/256Mi to 20m/96Mi: applied immediately, same Pod UID,
  zero restarts, CNPG did not roll the Pod within 60 s, Cluster stayed healthy.
### C. Facts from earlier Gate 0 (R2.3, retained thick DB, CNPG cold wake, 3 rounds)
first row 8.1-9.4 s; Pod created 0.08-0.83 s; postgres first log 4.0-5.2 s; PostgreSQL ready 4.7-6.0 s;
Pod Ready 6.1-6.8 s; Edge admission complete 7.8-9.0 s (so 1.1-2.9 s from Pod Ready to admission);
awake path first row 0.47-0.96 s (warm rounds 0.54-0.61 s).
