# Wake path v2 and control-plane scale

Decision record and design proposal of 2026-10-16. The [ULTRA plan](cloudflare-convergence-and-serverless-plan.md#speed-and-scale-decisions-2026-10-16)
tracks status; this file keeps the evidence, the design and the experiments so they are not lost.

Seven read-only research passes produced it: Neon's cold start, Neon's connection path, Xata, the
controller's Kubernetes work, instant-resume techniques, control-plane scaling and the wider field.
Sources: neondatabase/neon at `fa504217` and neondatabase/autoscaling at `a4bce09e` (Apache-2.0),
xataio/xata at `3518b82` (Apache-2.0), CloudNativePG v1.30.1, Kubernetes v1.36.5, client-go,
controller-runtime, kube-rs 4.2.0, PostgreSQL REL_18_6, vendor engineering blogs and docs, and one
independent benchmark. Tags: **[V]** read in a primary source, **[M]** measured on PGCF's EU1,
**[E]** estimate or inference.

## 1. Verdicts

| Question | Verdict | Evidence |
| --- | --- | --- |
| Is the programming language what makes the wake slow? | No. | A parked wake issues about 100–145 Kubernetes requests: 11–14 ms of CPU in Rust, 22 ms in Go, 28 ms in Node on a laptop (1.5–3x on the VPS), at most 3–5 % of 0.8–1.9 s [E]. client-go's default limiter (5 QPS, burst 10) would need about 22 s for 120 requests [V]. Xata's Go gateway and operators show the same 1.1–1.25 s mode as PGCF's projection [V]. |
| Keep Rust for controller, gateway, host extension? | Yes. | The safety path wants no GC and exact control; Neon's production proxy is Rust [V]. The hand-written client is a capability gap (no watch cache), not a speed limit. |
| Adopt kube-rs? | No. | kube-rs 4.2.0 is HTTP/1.1 only like the current client and would replace about 400–500 lines of plumbing while PGCF's continuity proofs stay ours [V]. |
| Rust/Wasm edge Worker? | Only for shared contracts. | No evidence that it lowers latency: the edge path is I/O bound (Workers average about 2 ms CPU); Wasm startup grows with module size [V]. Measure `startup_time_ms` before a cutover. |
| TypeScript for API, Durable Objects, Workflows? | Yes. | Platform-native; no surveyed system runs wake orchestration inside Cloudflare, so there is no reference to copy, only the shape of the hops to cut. |
| Is a shared warm pool the way to sub-second? | No (stays deleted). | Neon's pool works because compute is stateless over remote storage; Xata's pool is claimed by a CSI attach and is a density tool, its pool hit mode (1.1–1.25 s) equals PGCF's parked projection [V]. |

## 2. Where the wake time goes

Measured on R2.13 from a Cloudflare Worker through the public endpoint, parked tier, before the
trims [M]: total 2.3–3.9 s. The split:

| Stage | Time | Owner of the stage |
| --- | --- | --- |
| client to Edge (probe Worker to Edge Worker) | about 0.45 s derived; the repo's own design table says 45–113 ms. Re-measure with a binding-based probe and a laptop; the laptop's first query on an awake database is 0.56 s in total [M] | Cloudflare |
| Edge to Actor, claim, hint to controller | 0.03 + 0.14 + 0.05 s | Cloudflare |
| controller: desired-state pull | 0.2–0.4 s | Cloudflare hop |
| controller: Kubernetes work and PostgreSQL | 0.7–1.5 s before the trims; 101 reads + 19 writes in 43 dependent rounds after them (in-process model) | node |
| PostgreSQL accepting after the unfence | 0.13–0.25 s (the 111–117 ms "clean start" is an upper bound: `pg_ctl` polls every 100 ms; CNPG execs `postgres` directly, real start 20–60 ms [E]) | node |
| observation POST | 0.25–0.65 s | Cloudflare hop |
| release to open socket, protocol | 0.05–0.15 s + 0.06–0.1 s | Cloudflare / gateway |

Measured on R2.14 (release `r2.14-5bd354f`, API `699e685`, 2026-10-16, thin database, from the probe
Worker, parked tier, `dev-idle` class) [M]: first query after idle **1.24 s, 1.54 s, 1.24 s**
(WebSocket open 1.16–1.46 s, PostgreSQL startup 45–62 ms, Edge admission 1.0–1.3 s). Split of the
1.16 s from socket creation to open: Edge, claim and hint to the controller 0.37 s; desired pull
0.21 s; controller chain from unfence to fence release 0.30 s (PostgreSQL accepting 0.12 s after the
unfence); observation POST 0.26 s; release to open 0.02 s. So the three Cloudflare terms (hint 0.37,
pull 0.21, POST 0.26) are 0.84 s of 1.16 s and the node-side work is 0.30 s. From a laptop (the pgcf CLI proxy and psql, Germany, same database, five parked rounds): first query
**1.79 s, 2.33 s, 2.50 s, 2.65 s, 3.16 s (p50 2.5 s)** against 0.41–0.54 s for the same statement on
an awake database. The wake adds about the same 1.2 s on the server side; the rest is the PostgreSQL
handshake paid after the wake over the client's round trips (SSLRequest, startup, two SCRAM
round trips, query: about five round trips of 100 ms) plus process start. The 1–2 s goal therefore
holds for a server-side client (a Worker, 1.24 s) and misses by 0.5–1 s for a client far from the Edge
until the handshake is pipelined (W8). Three further live
findings from the same run:

1. **A claim is refused with 57P03 in two of five parked rounds** (0.4–0.6 s after the connect, no wake
   operation created): `actor_claim_lost` with `retrying: true, attempt: 0`, then the loop finds the row
   unchanged and returns. Another predicate of the wake transition refused it. Both refusals came shortly
   before the next accepted thin identity proof, after an identity turn had failed transiently
   (`thin_storage_executor_failed`, `thin_storage_authority_refused` at 02:10:57Z and 02:17:10Z), which
   leaves the accepted inventory older than the 120 s startup freshness window [E]. Reading the code
   adds a second candidate: the wake predicate needs the identity proof's volume entry at the database's
   current generation, so a wake shortly after an idle sleep is refused until the next accepted proof
   [E]. Branch `golive/claim-wait`: the refused claim logs `actor_claim_refused` with every part of the
   guard, and waits for late reports within the caller's deadline (`actor_claim_waited`). With it the
   second candidate was confirmed live on EU1 (2026-10-16 [M]): every wake of a parked thin database
   within one identity-proof interval after its sleep was held about 15 s, `blocked_by:
   ["thin_identity_behind"]` with `volume_bound: true`, `volume_current: false` and every other part
   holding; the first query took 1.24 s when a proof happened to land between the sleep and the wake and
   17 s when not. Branch `golive/wake-identity` (not yet measured live): the wake claim of a parked
   sleeper accepts the proof's entry of the generation before its sleep (section 4.8, (e)).
2. **A cold wake of a thin database took 44 s** (hint 02:10:40, ready 02:11:24): `volume_identity` pended
   37 s, waiting for the next identity proof that carries the new Pod's I/O limits (a turn takes about
   47 s and runs every 60 s). The Edge gave up after 30 s (`08006`). During the Pod creation the controller
   ran about 20 full passes per second (about 42 calls each).
3. **An awake thin database still re-reconciles every 2.0 s** (80 calls and one observation POST per
   pass, about 0.5 Hz; it was 1.5 Hz on R2.13). The period equals the thin sample cadence; suspects are
   the sampler's per-sample ledger write and CNPG Cluster status events (resourceVersion bumps without a
   generation change, which the watch hints as a database change).

About 70 of the 101 reads re-read an object the same pass already holds [E]. Cloudflare-side hops are
1.3–2.9 s of the total; the controller's own Kubernetes and PostgreSQL work is 0.7–1.5 s.

## 3. What Neon and Xata do (verified)

**Neon, pool hit** (`neon fa504217`, vendor blogs):

1. The proxy authenticates first (cached secrets; a failed login never wakes a compute), then calls
   `wake_compute` (node-info cache of 4000 entries, 4 min idle TTL, rate limit, one HTTP call). The reply
   says `warm`, `pool_hit` or `pool_miss`.
2. The control plane assigns a spec to a running `compute_ctl` in state `Empty` (pre-created VM whose
   Postgres had been started and stopped once). Configure applies the spec; basebackup, swap, extensions
   and config run in parallel; catalog updates are skipped when unchanged.
3. Start: 55 ms in a local test, 180 ms p50 in production, 55 ms at 1 vCPU and 184–187 ms at ¼–½ vCPU
   (so full CPU at start matters). Readiness is the `postmaster.pid` file, not a platform probe; the
   proxy retries connects every 100–200 ms with TCP_NODELAY.
4. End to end: 3–6 s before pools, 0.6–0.75 s with pools, p50 500 ms (2024), "a few hundred ms" (docs
   2026); independent series (N=20, same region, forced suspend): median 568–593 ms, p95 1.06–1.56 s.
5. Pool miss: median 6–9 s (Pod provisioner) or 12–15 s (VM provisioner), tails 45–83 s; merging init
   containers saved about 1 s. No snapshot or restore code exists in either repository.

**Xata (open-source mirror)**:

1. Go control plane and per-cell Kubernetes data plane: Go SQL gateway, `branch-operator`, a CNPG fork
   (`xata-cnpg`, `release-1.28`), a CNPG-I scale-to-zero plugin; storage "Xatastor" (ZFS over NVMe-oF,
   closed; the OSS release uses OpenEBS).
2. Asleep means the CNPG Cluster is deleted and the volume retained. The fast path claims a pre-created
   Cluster (no-op bootstrap, Pod Ready, Postgres stopped) from a pool by dropping its owner reference, then
   a CSI gRPC call mounts the volume; the forked instance manager polls PGDATA every 30 ms and starts
   Postgres. The gateway holds the StartupMessage while it dials, polls every 100 ms with backoff.
3. Numbers: Postgres start 350 ms; pre-pool Pod wake 25.85 s (container ready 8 s, init containers 9 s,
   Pod Ready 7 s, gateway polling 1.5 s); gateway histogram: 90 % of wakes in 0.5–3 s, mode 1–1.25 s,
   second mode 10–30 s (pool miss or hibernation); pools must be homogeneous in size and settings.
4. Their Go operators still issue tens of Kubernetes calls per wake; they removed serial waits, not
   requests. Only the NVMe-oF I/O path is Rust.

**The field** (resume from zero): Neon 0.57–0.59 s median (independent) [V]; CockroachDB "a fraction of a
second", TiDB "half a second", from a proxy beside the compute [V]; Fly Machines suspend/resume a few
hundred ms for at most 2 GB, Postgres not offered [V]; Aurora Serverless v2 about 15 s [V]; Azure SQL
about 1 min; Snowflake Postgres 3–5 min manual. Every sub-1.5 s claim uses a tenant-free pool or a
snapshot. The leaders wake in one hop beside the compute and admit on a local fact; PGCF crosses
Cloudflare at least four times and learns readiness through an observation POST.

## 4. Design: wake path v2

### 4.1 Principles

1. One authoritative input (the wake row), one irreversible action (the unfence), one proof (SQL identity
   on the Pod IP plus Pod, volume and CA identity), one publication (intent, target, observation).
   Everything else is bookkeeping that runs in the first wave or in a follow-up pass.
2. A check may leave the critical path only if an equal-strength proof exists from earlier in the same
   wake, or it concerns availability or reporting, not the identity of the writer, the volume, the
   database or the fence.
3. Read once, write in parallel waves, never re-read what a write returned. Everything that does not
   need PostgreSQL runs while PostgreSQL starts (0.13–0.25 s of dead time).
4. Any memo miss, watch gap, epoch change or 409 falls back to the current full path unchanged.

### 4.2 W1 controller critical path (Rust, controller + gateway release)

Ranked, p50 gain, data-safety risk (none of them touches a client's SQL path, thin write authority or
the gateway's quiesce-until-proof rule):

| # | Change | Gain | Risk |
| --- | --- | --- | --- |
| 1 | `resourceVersion=0` on GETs that tolerate cache reads and on the two gateway-Pod LISTs (a GET without it is an etcd quorum read; a LIST waits for a progress notification, up to about 100 ms each) | 40–250 ms | none |
| 2 | Do not await the kubelet's resize actuation (the resize changes requests only; confirm in the follow-up pass with the existing `Infeasible`/overdue demotion) | 30–150 ms | low |
| 3 | Retry the gateway release on 409/503 up to about 150 ms instead of failing the pass (ack-before-target order unchanged) | removes +1 s events at p95 | none |
| 4 | Independent writes of the first wave concurrently; SQL readiness polling starts at the unfence | 5–100 ms | low |
| 5 | Version memo ("wake plan") recorded at park completion and at each parked pass, validated by the existing watch continuity; a hit issues no read before the unfence | 30–90 ms | low |
| 6 | Memo plus one barrier read of Pod and Cluster replace the post-PostgreSQL chain; stamps, archive probe and role scan move to a follow-up pass; add `system_identifier` and timeline to the SQL proof (it equals the data directory's identity; `ACCEPTING_QUERY`'s `server_address` is tautological) | 60–170 ms | low–medium |
| 7 | Watch baseline `limit=512` fails at roughly 60–130 databases and silently disables direct readiness: paginate it | none today, prevents a cliff | none |
| 8 | HTTP/2 or kept-alive connections, token cache, agent CPU limit above 500m, pause the 250 ms measurement cycle during a wake | 0–45 ms and tails | none |

Target critical path (assumptions: cached GET 1–2 ms, PATCH 4–10 ms, Cluster PATCH 8–18 ms behind two
webhooks, PostgreSQL 130–250 ms after the commit): plan check (0 requests), one parallel write wave,
SQL identity proof, barrier read, intent write, release with retry, target write, POST: **0.16–0.33 s,
p50 about 0.24 s, with 4 dependent Kubernetes rounds instead of 43** [E]. Three writes on the critical
path are unavoidable (Cluster PATCH, intent + Awake, admission target): CNPG starts a fenced instance
only when the Cluster annotation disappears and offers no local control endpoint [V]. A wake without
Kubernetes writes is not feasible.

Invariants that stay: unfence only with a current startup hold and valid host guard; gateway fence
`quiesce` until the proof; target written only after every gateway acknowledged; SQL identity with a
postmaster younger than the unfence; no client admitted before the `ready` observation is accepted; no
SQL replay anywhere. Tests the work must pin first (failing against the in-process world): memo hit
issues no read before the unfence and exactly one write wave; any identity change, gap, epoch change,
manifest-hash change or rotated role Secret is a miss; a 409 refreshes once; a crash between first-wave
writes recovers to one consistent state with at most one postmaster; intent precedes release, release is
retried, target only after every ack, observation last; a follow-up mismatch publishes a non-ready
observation exactly as a Pod change does.

Status (deployed in R2.15 on 2026-10-16 and measured live: parked wake chain 0.19 s from the pull to the
released fence once the lean path is on, see the R2.20 paragraph of the plan; the tests below are the
in-process world's). One parked wake in the world (every Kubernetes request answered after the same delay, so that
requests issued together are one round) after a periodic parked pass:

| | requests | sequential rounds |
| --- | --- | --- |
| origin/main (`d4cff9f`) | 100 reads + 19 writes | 43 |
| branch, memory warm | 4 reads + 6 writes | 5 |
| branch, memory off (every read is made) | 95 reads + 6 writes | 32 |

The pass after the wake is 11 reads + 12 writes (the stamps); the one after that writes nothing.

- Rows 1 to 4: cached reads (`resourceVersion=0`) for identity facts, the shared credential, the
  inspection and the gateway Pods; the resize actuation is not awaited when the kubelet has accepted it
  (a `Deferred` or `Infeasible` resize still holds the wake and demotes after the budget); the gateway
  release is asked again every 5 ms for 150 ms on 409 and 503; the record of the wake, the Cluster patch
  that unfences and the resize are one wave, and the poll of PostgreSQL starts with it.
- Row 5: no `WakePlan` structure. The client keeps what it last read or wrote of every object of a
  watched kind, and `read_known` answers from it when the watch holds that very version (or holds none
  of an object that was found absent) and reads otherwise. The parked passes populate it; the wake
  reads through it. Kinds added to the metadata watches (no hints, outside the runtime proof's epoch):
  `ResourceQuota`, `LimitRange`, `NetworkPolicy`, `CiliumNetworkPolicy`, `ObjectStore`,
  `ScheduledBackup`, `LVMVolume`; they need `watch` in `infra/platform/regional-native/rbac.yaml`
  (added) or their watches back off and their reads are made. A hit issues no read before the unfence;
  a changed version, a gap or a version the watch has not delivered (409, one read of the Cluster) is
  a read. The Cluster is held by its exact version, not by generation: a status write of CNPG is a read.
- Row 6: a database that was ready before, is admitted and whose watch can vouch is published on the
  barrier read of the Pod and the Cluster, the volume identity and the SQL proof; the generation stamps
  of the manifests and the receipt, every role's credential, the archive sample and the removal of
  roles are the next pass's, made due a second after the wake. The SQL proof now also compares
  `system_identifier` and the timeline of `pg_control` with the values the sleep recorded while the
  postmaster still ran (`pg_control_system()` and `pg_control_checkpoint()` check no privilege in
  PostgreSQL 18; to confirm on the pinned image). A sleep that cannot read them hibernates, a record
  without them is never resumed. A follow-up that finds a role that cannot log in fails and renews
  nothing, so the attestation of the wake lapses at its expiry; no other channel withdraws it.
- Row 7: the watch baseline reads every page (100 objects) at one revision, the tracked objects are
  bounded at 65536, and a watch that ends is logged (`watch_ended`) and asked for again after 1 s,
  doubling to 30 s.
- Gateway (row 4 of 4.5): `TCP_NODELAY` on every accepted socket and the dial of PostgreSQL at the
  admission of the route, with every check where it was (the StartupMessage is compared with the route
  and the fence is checked after it and after the dial); the greeting already leaves in one frame.
- Live findings: a database whose objects keep changing is looked at twice a second at most, a write
  of the controller's own and a status write of a Cluster hint nothing, the log names what hinted a
  database (`database_hinted`, once a second), and a wake that waits for a proof polls with backoff.
  What hinted the 2 s pass of the awake thin database is not known; the next run's log says.
- Left out: gateway snapshot and keyring from memory (the two cached LISTs remain), HTTP/2 and the
  token cache (row 8), label scoping of the new watches, a demotion of an awake database whose resize
  turns `Infeasible` after publication (the kubelet decides before PostgreSQL accepts, and the barrier
  read holds the wake for a resize it has deferred or refused).
- To measure live: the cost of one round; the hit rate (`reconcile_summary.memo_hits` against `calls`);
  the CNPG reaction time to the unfence; whether the Cluster's version holds between the parked pass and
  the wake; `pg_control_system()` for the maintenance role on the pinned image; the `watch_ended` lines
  of the new kinds after the RBAC is applied; the time from the wake to the pass after it.

### 4.3 W2 cut the pull (API + controller)

The Actor sends the row (or a delta against the controller's cached row, guarded by a base generation
and row hash) on the existing authenticated link right after the claim commit; the 60 s pull stays as the
repair path and validates through `desired_valid` and the same generation rules. Gain 0.2–0.35 s. First
split `desired_pull` into network and Worker time with the API's `desired_page.elapsedMs` line. The
hint carries only IDs today; a thin database also needs the startup hold and storage budget from the
row, so a speculative unfence from an ID alone is not safe, the row on the hint is.

Status (branch `golive/w2-hint-row`, tested locally, not deployed or measured live): the Actor builds
the page of the claimed wake's one database with the pull's own builder right after the claim commit
and sends it on the hint (`desired`, only while its row is the claimed revision and operation and the
message fits the link's 64 KiB); the controller takes it like a targeted pull begun on arrival when it
moves a held database to a newer generation, and pulls otherwise. To measure: `desired_from_hint` in
place of `desired_pull`, hint to `fence_release`, and `page_ms` in `actor_claim`.

### 4.4 W3 local admission (Edge + API + gateway; needs an owner review of the invariant)

Today the Edge waits for the Actor's release, which waits for the accepted `ready` observation (D1
commit and publish) before it signs a target-bound token and opens the WebSocket. Option: the Edge
opens the gateway connection right after the claim with a signed wake ticket (database, generation,
claim id, route revision); the gateway holds the client and upgrades when its own fence shows the
controller-attested target for that generation; the observation POST and the Actor release become
asynchronous. This removes 0.25–0.65 s (POST) plus 0.05–0.15 s (release) from the critical path and is
how every faster system works (Neon's proxy, Xata's gateway hold the connection beside the compute).
Cost: it relaxes "no client admitted before the `ready` observation is accepted" to "no client admitted
before the controller's attested target for the ticket's generation", and it resembles the route token v2
(admission without a target) that the deletion plan removes, so the target must stay bound to the
controller's attestation and generation, never to a gateway's cache alone. Decide after W1 and W2 are
measured.

### 4.5 W4 hops and placement (measure first)

- The 0.45 s client-to-Edge term contradicts the design table (45–113 ms): use a service-binding probe
  and a laptop before changing anything.
- `locationHint` for the Actor and RegionLink Durable Objects (they never move once placed), the D1
  region, Smart Placement for the Edge; service bindings instead of public fetches between Workers.
- Edge admission has five sequential awaits (limiter, ensure-awake, database limiter, token, gateway
  connect); the stage timings are already logged in `conn_admission`.
- Gateway: `TCP_NODELAY` on accepted sockets, flush the PostgreSQL greeting once, dial the target as
  early as the route decision allows (done on `golive/wake-v2-controller`, see 4.2); client: pipeline the
  PostgreSQL startup (SSLRequest + Startup in one flight; SCRAM first message with the startup, saving
  69–129 ms of 0.54–0.61 s) [E].
- Neon-compatible HTTP `POST /sql` (3 RTT cold, 1 warm) only if cold stays under 150 ms and warm under
  60 ms in a measured prototype.

### 4.6 W5 hot idle: no wake at all (experiment first)

Keep the PostgreSQL process and its CNPG Pod running, reclaim cold memory into zswap with
`memory.reclaim` (swappiness max, `memory.zswap.writeback=0`), shrink requests in place. D1 keeps the
database `running`, so the first query is the awake path (0.54–0.96 s, 0.54–0.61 s warm) plus 5–50 ms of
page-in [E]; the CNPG operator never requeues a NotReady Cluster; density is 2–4x the parked tier [E]
(idle PostgreSQL plus manager and sidecar settle at about 25–60 MiB). The Talos kernel has zswap built
in, no zram. Needs a Talos `SwapVolumeConfig` and `ZswapConfig`, kubelet `memorySwap: LimitedSwap`
(Burstable Pods only; Guaranteed and high-priority Pods get no swap), a reclaim consumer, and a
maintenance window (host configuration change). Experiment E1 on EU1: apply the documents, from a
privileged probe Pod reclaim a database's cgroup, watch `memory.stat`, `pswpin`, `zswpwb` for 10 minutes
under normal probes; pass if `memory.current` is at most 40 % of baseline right after reclaim and 60 %
after ten minutes, first-query p50 within +50 ms and p99 within +150 ms, zero `zswpwb`. A frozen
PostgreSQL tree (`cgroup.freeze`) adds at most 0.05–0.1 s over this and has hazards (a frozen postmaster
fails `pg_isready` so CNPG requeues at 1 Hz; a partial freeze can PANIC on a stuck spinlock; a stop while
frozen ends in crash recovery); `MADV_PAGEOUT` skips shared pages, so use `memory.reclaim`.

### 4.7 W6 cold path (hibernated, 9–14 s to 4–6 s) [E]

Pod creation to the first PostgreSQL log line is 4.0–5.2 s of quantised steps: 1 s PLEG relist, 1 s
sidecar startup probe, 1 s startup probe, 300 ms volume wait, a recursive fsGroup walk of PGDATA at
every mount, an instance manager that boots five informers and takes a Lease (up to 15 s after an
ungraceful stop; the guard's kills cost this). Knobs: `fsGroupChangePolicy: OnRootMismatch` (restate
`fsGroup: 26`, `runAsNonRoot: true`), drop or relax the Barman sidecar's 1 s startup probe by admission
mutation (CNPG compares the stored pod-spec annotation, so no rollout), mount the manager binary from an
image volume (GA in 1.36; verify exec). Do not remove the `bootstrap-controller` init container: CNPG
then silently skips the PodSpec-drift check for that Pod. First split the stages (experiment E3: ten
hibernated wakes with annotation removal, reconcile entry, Pod create, each container start, Postgres
ready, observation).

### 4.8 W7 thin identity turn (NodeBootstrap + API)

The identity proof is the slowest recurring step of the thin design: about 47 s per turn, every 60 s,
through the relay (many sequential driver commands). Everything that needs a fresh inventory waits for
it: a cold start (`volume_identity` 37 s), create to ready 51 s, delete with reclaim 288 s, the 120 s
startup freshness window (a failed turn makes the next wake claim 57P03), and rollouts. Work: (a) gather
the inventory with one batched command per turn instead of many round trips (the fixture world counts
commands); (b) request a turn the moment a cold start needs one (`volume_identity` pending) instead of
waiting for the cadence; (c) the claim waits for the next inventory within the caller's deadline instead
of returning 57P03 at once, and logs which predicate refused; (d) raise the Edge's 30 s admission
deadline for a cold start only if (a) and (b) leave it above 20 s. Expected: cold wake 44 s to about
10 s [E], create and delete several times faster.

Status (deployed 2026-10-16; cold Thin wake measured live at 21.8 s; the tests below are the Dev
fixture's):

- (a) The fixture world counts relay commands and sequential relay connections (a `kubectl exec` is two:
  the Pod, then the upgrade). A turn is **22 commands in 6 sequential connections for any number of
  volumes**; it was 31 + N commands in 17 + 2N connections for N io.max reads (34 and 23 for a writer with
  two Pods, a held start, a protected sleeper and a retained delete; 42 and 39 with eight more writers).
  The report is the same document. One command per turn is not possible: the cluster reads need `kubectl`,
  which the driver container lacks, and the opening and closing LVM reports must bracket them. Collapsing
  the bracket would accept a volume created between its PVC and its LV with incomplete accounting and
  stop every writer of the node, so the floor of this design is wave, driver exec, wave, driver exec. The
  reads and their order are in [thin-authority-renewal.md](thin-authority-renewal.md) section 5. Peak
  concurrent relay connections per turn are 10 (were 7), against the relay's limit of 32 connections.
- (b) The controller posts a waking database's observation only when it carries the power operation or a
  ready, deleted or hibernated state, and the desired page carries no marker, so the API cannot see
  `volume_identity` pend. Its marker is the startup hold, which every headroom sample already reads: an
  accepted sample asks for a turn while a start has no ready report yet and its hold is at most two minutes
  old. The hold's release after the ready report still waits for the next turn. The NodeBootstrap
  Durable Object starts a requested turn no sooner than 10 s after the previous turn started and runs one
  at a time.
- To measure live: `thin_storage_turn_accepted.turn_ms` (lease issue to acceptance) against the 47 s of
  R2.14, `thin_storage_turn_requested` (a sample asked for a turn, with the waiting holds), the cold wake's
  `volume_identity` phase and create to ready. (c) is done in the Actor (`actor_claim_waited`, `actor_claim_refused`); (d) is open.
- (e) A wake claim needs the proof's entry of its database at the database's current generation, and an
  idle sleep bumps the generation without touching the Pod or the volume, so a parked sleeper waited for
  a proof that could not show anything new. The claim of a parked sleeper (and only the Actor's wake
  claim, not a resume or a restart after a refused stop) now also accepts the entry of the generation
  before the sleep, when all of this holds: the controller confirmed the idle sleep and reported the
  parked Pod within the last 180 s, the sleep directly followed a start (the operation of the generation
  before is a creation, restore, wake, resume or resize and the entry is that generation), the entry
  shows exactly the parked Pod with its io limits and the volume not frozen, and every fact of the volume
  binding still matches. A role created between the start and the sleep, a resize, a hibernated sleeper
  whose Pod is gone, or a proof of another Pod keep the strict rule. A wake, a short use and a second
  sleep before any proof read the wake's generation still wait for the next proof (the entry is then two
  generations behind). To measure live: `actor_claim_refused.blocked_by` should no longer name
  `thin_identity_behind` for a parked database (the event now carries `parked` and `volume_generation`,
  so a refusal that remains shows what the proof read), `actor_claim_waited` should disappear for a
  wake after a sleep, and the Edge's `ensure_awake_ms` of the first wake after a sleep should match
  the awake-in-proof case (1.24 s on R2.14).
- (f) A wake claimed while a turn runs makes that turn's report unacceptable (its input has the woken
  database at the old generation), so the proof came 41–44 s after the hint instead of 21.8 s [M].
  Status (branch `golive/turn-cancel`, tested locally, not deployed): an accepted sample names its
  waiting starts; the NodeBootstrap Durable Object then has the container end a running turn without a
  pool action that read such a database at an older generation (`POST /v1/turn/cancel`), releases its
  lease without counting a failure and starts the next turn at once. A turn with a pool action always
  runs to its end, only an error the cancel itself raised counts as a cancel, and a report already sent
  is never cut off. To measure: `thin_storage_turn_superseded` and a cold wake's proof about 22 s after it.

Measured after the deploys of 2026-10-16 (API from `0a5cb81` and `d4cff9f`) [M]: total API requests per
second fell from 8.8 to 1.5 and each node's reclaim poll from about 3.2/s to 0.23/s (the 3.5 s hold);
an identity turn takes 18.6–29 s instead of 47 s (six sequential relay connections and 22 commands, first
turns after the deploy 29 s, then 21 s and 19 s); a cold wake of a thin database took 20.5 s instead of
44 s (the turn is requested when a start waits: `thin_storage_turn_requested`). The new
`actor_claim_refused` event then named the cause of the 57P03 class: `blocked_by: thin_identity_behind`
with `volume_bound: true, volume_current: false`. A sleep bumps `databases.generation` without touching the
Pod or the volume, and the wake predicate demands a node proof that lists the volume at the CURRENT
generation, so every wake of a parked database within one proof interval after its sleep waits for a proof
that cannot show anything new (the claim wait turned the refusal into a 15–17 s hold; 1.24 s only when a
proof happened to land in between). Fix (W9): accept the proof entry at the newest start generation while
every generation since is a pure power transition that kept the Pod and volume; everything else stays strict.

### 4.9 W8 client handshake after the wake (CLI proxy, driver, gateway)

Everything the client does after the socket opens is paid at the client's round-trip time. Neon's
WebSocket path needs 4 round trips in total (TCP 1, TLS 1.3 1, upgrade 1, one pipelined flight with
startup, cleartext password over TLS and the first query 1) against 9 in the baseline. For PGCF: answer
SSLRequest with `N` locally in the CLI proxy and in the driver (no round trip), send startup and the
first SCRAM message in one flight, and let the gateway authenticate the cleartext password over the
TLS-protected WebSocket against the verifier and replay the SCRAM keys to PostgreSQL, hiding the
authentication inside the wake instead of after it (the verifier custody and Cloudflare-side review are
owner decisions; the pipelined SCRAM flight needs none). The gateway already tolerates
`[SSLRequest][Startup][rest]` in one frame. Expected: 0.3–0.5 s less on a 100 ms path.

### 4.10 Small items from Xata and Neon

- Label every wake by path class (parked hit, hibernated, resize, demotion) and size, and record the
  gateway-boundary duration in fine buckets; size the parked TTL and cap from the idle-gap distribution.
- `recovery_init_sync_method=syncfs` (absent today) shortens an unclean start; Barman `wal.maxParallel`
  above 1 avoids a full volume in bulk loads (R2 rate and CPU limits apply).
- Nested timeouts and a clear FATAL while a database is waking, so clients never see an opaque
  disconnect; audit slow wakes with the start held for 20 s and 45 s.
- `pg_prewarm.autoprewarm` and a local file cache only help throughput after the first query.

### 4.11 Not recommended

CRIU and Kubernetes container checkpoint (beta in 1.36 without native restore, no `criu` on Talos, restore
2–6x slower than a clean start [E]); gVisor; Firecracker, Cloud Hypervisor, Kata, Unikraft snapshots (need
KVM; Contabo allows nested virtualization on VDS and dedicated servers only, about EUR 39 per month for
6 vCores; resume 50–200 ms warm, 0.2–0.6 s cold-lazy [E] only beats the hibernated tier); node-local push
instead of the fence ConfigMap (10–30 ms, moves the persisted-fence contract); a shared warm pool;
Go, TypeScript or kube-rs for latency.

## 5. Limits of the parked tier found by the research

- CNPG requeues every NotReady Cluster each second (`cluster_controller.go:1146-1153`) [V]: the parked
  tier's real scaling limit, and the reason the per-node cap matters.
- After an unfence the instance manager's reconcile is blocked about 25 s (5 s backoff plus 2x10 s
  sleep): a re-park within that window is applied late; role and config changes wait for it.
- A clean stop releases the primary Lease; any SIGKILL path (guard, OOM, node reboot) costs up to 15 s at
  the next start.
- The agent's CPU limit is 500m. (The watch baseline capped at 512 objects; it is paged now.)

## 6. Control-plane scale

Measured traffic to the API Worker on 2026-10-16 (Workers Logs, two nodes, steady state):

| Call | Rate | Per |
| --- | --- | --- |
| `GET /agent/v1/nodes/{id}/reclaim` | 3.0–3.2 /s | node, always (host extension polls every 250 ms; warm reclaim has no state; every poll is a 404 and an `api_request_failed` log line, about 1.7 /s) |
| `POST …/storage-headroom` (thin sample, nonce rotation = D1 write) | 0.4–0.6 /s | customer node |
| `GET …/storage-guard` (lease) | 0.5–0.8 /s | customer node with thin databases |
| `POST …/node-thin-storage` (identity proof) | 0.08 /s | node |
| `GET /agent/v1/desired` | 0.2–0.3 /s | region |

About 85–90 % of requests are the unused reclaim poll. Model (10 databases per node; handler statement
counts from code, D1 service time per statement assumed, the one unmeasured input):

| Customer nodes | API req/s | D1 statements/s | D1 busy (mid) |
| --- | --- | --- | --- |
| 1 | 8.7 | 40 | 7 % |
| 4 (EU1–EU4) | 23.7 | 128 | 21 % (59 % pessimistic) |
| 10 | 57 | 315 | 52 % |
| 50 | 275 | 1,541 | 256 % |
| 100 | 547 | 3,072 | 510 % |

Per database about 0.9 statements/s (usage samples, observations, desired rows) overtakes the per-node
term at about 22 databases per node; usage ingestion writes about 5.5 rows per sample.

First limits, in order: (1) one always-on NodeBootstrap container per thin node (identity proof every
60 s against a 120 s inactivity timeout; about USD 27–28 per node and month; the deployed `max_instances`
is 8 on `standard-1`, which caps thin nodes near 5–7 plus the control node's and operations' containers: raise
it before the fifth customer node); (2) D1 size and the nightly export (a
4 s stall today, longer as D1 grows; `usage_samples` grew about 9 MB per database per day before pruning);
(3) D1's single thread, knee near 12 nodes, saturation near 19 (range 7–54).

Staged plan (control D1 statements/s at 10 / 100 nodes, mid model):

| Stage | Change | Class | 10 / 100 |
| --- | --- | --- | --- |
| today | | | 315 / 3,072 |
| A | hold the unqualified reclaim answer 3–4 s (the extension's client timeout is 5 s; 3.1 req/s become about 0.26 on the existing binary), cache the region row (revocation visible within 10 s), batched usage insert, sampled high-rate logs | API deploy | 140 / 1,371 |
| B | usage in its own store (second D1 or accumulators), authority read cache with guarded CAS, retention | API deploy | 58 / 550 |
| C | idle suppression, change-triggered observations with a 300 s heartbeat, revision-gated desired pull, batched samples, jitter and backoff | controller release | 36 / 328 |
| D | delete the reclaim poller, lease over a hibernatable WebSocket, server hints | host extension (expensive) | 34 / 313 |
| E | per-node authority actor, D1 write-behind | API, safety review | n/a / 128 |

Stage D removes only about 4 % more D1 statements once A has neutralised the poll, so a host release is
not cut for scale alone: bundle it with the guard fixes. What must stay strongly consistent: the
single-use nonce, the monotone authority revision, token signing from current inputs, and the hold debit
atomic with headroom; caches may feed reads only while the guarded compare-and-set stays in D1 or in one
per-node actor. Not recommended: D1 read replicas on the lease or desired paths. Comparable systems:
Kubernetes (10 s Lease beat, NodeStatus on change or every 5 minutes), Nomad (server scales the
heartbeat TTL to nodes/50 per second), Consul (sync interval doubles beyond 128 nodes, random stagger),
Neon (heartbeat state in memory, only transitions persisted), Envoy and Temporal (incremental updates,
1 minute long poll). PGCF's RegionLink is already the right shape for push.

To measure next: D1 GraphQL analytics over 24 h including the export (queries per second,
`queryBatchTimeMs` percentiles), per-statement `sql_duration_ms`, deployed `max_instances` and running
NodeBootstrap containers, D1 bytes per table twice a day and export wall time, usage and observation
rates per awake, parked and hibernated database; deploy stage A on Dev for an hour as the natural
experiment (it removes a known 6.2 statements/s per node).

## 7. Operations findings

- A fleet rollout pauses thin write authority for the whole region until every node confirmed (R2.14:
  last sample 01:07:16Z, rollout start 01:07:19Z, sampling back at convergence about 01:45Z); awake thin
  databases lose their 10 s tokens and the host guard kills their Pods. Until authority continuity across
  patches that change no qualification fact exists, every rollout needs a maintenance window.
- **Rollout-safe authority (deployed and accepted live on R2.19, 2026-10-16).** A `continuing`
  qualification class keeps the fact equalities of `qualifiedThinStorageSql` (receipt facts, authority
  keys, host configuration sha, boot id, node, cluster, material) and drops the release id, spec hash,
  assignment and region revision. The node's completed patch and the release its proof was read
  under must pin the assigned release's facts (`fleet_releases.thin_continuity`, stored per release
  by migration 0057: receipt, authority keys, configuration schema, the OS block of both roles, and
  the `openebs-lvm`, `sandbox-controller`, `postgres`, `barman`, `cloudnative-pg` and Talos
  extension pins), and no later patch of the node, in any state, may pin others: a rollback after a
  pin change pauses until its own patch completed.
  Samples, the sampling target, the desired page's node entry and tokens, the host lease and the
  identity turn (lease evidence by fact, host custody read sealed, the executor no longer compares the
  custody's release label) continue through a rollout that changes none of them. The sampling wire
  gate asks that the newest completed patch of every member declared the protocol and no later patch
  did not; the `postgres` stage selects and counts by (image, version, schema). Placement, wake, hold release, deletion proofs,
  selection and qualification runs stay on the strict predicate; a changed extension, kernel, OS,
  key, runtime image or PostgreSQL pin is strict from the assignment. Open: live acceptance (sample
  and token continuity across a rollout that changes only the controller digest, strict refusal after
  an extension change), the controller `Recreate` gap against the 10 s guard, the observation age
  bound of `continuing` (300 s), whether Flux restarts the OpenEBS driver on an unrelated release, and
  the owner's choice of the pin set and of waking during a rollout.
- A guard above about 11 s cannot qualify: a qualification sample counts only when its nonce was issued
  inside the gate's window and the next sample also arrives inside it, and `startup_bound`'s window is
  4.7 s on EU1; guard 30 s failed (`thin_qualification_startup_bound_failed`).
- The `noflush_quiescence` gate failed once on the writer's memory (715 MiB dirty page cache against a
  1 GiB Pod limit); the executor now bounds the burst at 512 MiB, repeats only a lost exec and records the
  failure facts.
- Re-creating a deleted thin selection row restarts its revision counter and deadlocks pool creation
  (holds of deleted databases are covered only while their profile revision is at most the row's):
  restore the saved row.
- After the lease deploy (API `699e685`) the API side of the guard is healthy: lease handler 50–100 ms
  (was 1.9 s), token life at serve 6–8 s of 10 s, fetch period 1.07 s, samples every 2 s. A kill still
  happened with a valid token: on 2026-10-16 at 02:00:57Z both containers of a freshly parked Pod were
  SIGKILLed (exit 137, `Container created` twice, then `park_demotion` with reason `identity`) while no
  lease request from EU1 reached the API between 02:00:52 and 02:00:57, although the controller's samples
  arrived every 2 s and the control node's guard kept fetching. The stall is inside the host extension
  (suspects: the fsynced `publish_public("tasks")` every 250 ms, the persistence of each accepted lease,
  one runtime); an earlier kill at 01:50:15Z, nine seconds after a database became ready, was the
  token hole fixed by migration 0055. Until the extension is rebuilt, a 6 s stall of the guard kills
  every thin Pod; this raises the priority of the next host release (H1 delete the reclaim poller and
  its fsync, per-entry accept, tolerate unassigned Pods, an fsync-free fetch loop). Reading the code
  found two paths that produce exactly this stall, neither measured yet: the fetcher handed each lease
  to a one-slot channel whose reader first wrote the owner record of every token (fsync under the
  pool lock, once per renewed token of each Pod, about every 2 s), so one stalled write, plausibly behind the flush of a Pod being
  parked, stopped the fetches within two leases; and a request that hangs to the client's 5 s timeout
  delayed the next fetch by that long, with no journal line. The fetch loop is now a thread of its own
  that starts a fetch every second whatever the earlier ones do, accepts first and records afterwards
  (`sc/intake.rs`; effective with the next host extension release and a new thin qualification), and
  journals a fetch or a record write slower than 1.5 s, which names the cause on the next occurrence.
  The reclaim poller and its 250 ms publication to `/run` (a tmpfs, so its fsync cost nothing, but its
  pool-lock, container-list and `/proc` walks ran on the controller's runtime about three times a second) are
  deleted from the source; the snapshot had no reader.
- Host guard fixes that need an extension release: one bad lease entry must not refuse every entry
  (`accept` is all-or-nothing), a sticky `stopped` per Pod UID. Done in source: a token for a Pod not
  yet assigned no longer starves every other database's renewals (it is accepted, reported once per Pod and never retained as the scope), fetch errors are
  logged, and a retained scope that a minute of leases did not name is forgotten once its device is
  absent (it used to be retried ten times a second for ever).

## 8. Experiments, in order

| # | Experiment | Where | Answers |
| --- | --- | --- | --- |
| M1 | Per-request latency by verb and kind, new connections per wake, five wakes on the R2.14 build with phase events | EU1 | what a round really costs (the repo implies 16–19 ms against 1–5 ms idle) |
| M2 | Binding-based probe versus laptop versus the Worker probe | Cloudflare | the true client-to-Edge term |
| M3 | Split `desired_pull` into network and Worker time; `observation_post` against `observation_commit` | Workers Logs | what W2 and W3 buy |
| E0 | PostgreSQL start from `postgres -D` to first accept, no `pg_ctl` quantum | EU1 | the real floor |
| E1 | Swap + zswap + `memory.reclaim` on one database | EU1, window | whether W5 replaces the transition |
| E3 | Stage split of ten hibernated wakes | EU1 | which cold-path knob pays |
| E4 | Large `pgbench -i` with `wal.maxParallel` 1 versus 4–8; `kill -9` of a 20–50 GB database with `fsync` versus `syncfs` | EU1 | archive and recovery settings |
