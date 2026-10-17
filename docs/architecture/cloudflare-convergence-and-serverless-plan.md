# ULTRA: serverless PostgreSQL on plain Linux nodes

**Status:** canonical plan since 2026-10-17. It replaces the Kubernetes-era ULTRA plan at the same path (`docs/architecture/cloudflare-convergence-and-serverless-plan.md`), so the link in PLAN.md stays. The old plan and all work built on it are kept on branch `archive/kubernetes-runtime` (commit `6761e7f0`, which is main `4bfbe546` plus the unfinished stall-alerts work) and in Git history.

**Decision (owner, 2026-10-17):** option C. PGCF runs without Kubernetes, CloudNativePG (CNPG), Talos, OpenEBS, the slot pool and the control server. Each VPS is a self-contained node with:
- a minimal Debian;
- systemd;
- one Rust node agent;
- one sandboxed PostgreSQL service per database, each on its own thin LVM volume.

Cloudflare is the only control plane.

**How to read this plan:**
- Section 1 states the owner's goal and explains it.
- Section 2 summarises what we do.
- Sections 3–9 are the plan itself: definitions, overbooking, architecture, code, data safety, security and operations.
- Section 10 lists the delivery stages, section 11 the status and decisions, and section 12 the risks.
- Appendix C holds the implementation detail for builders. It moves into the READMEs of `infra/node-image` and `apps/node-agent` in Stage 3.

Each number carries its basis:
- *measured (EU1)*: measured on the live EU1 node under the Kubernetes runtime; used here as a reference.
- *measured (lab)*: measured in the 2026-10-17 supervision lab (Debian 13 "trixie", systemd 257, PGDG PostgreSQL 18.6, cgroup v2, 6 vCPU, on a laptop).
- *estimate*: not measured.
- *target*: an acceptance threshold.

Following AGENTS.md line 21, the plan gives no effort or duration estimates; each stage names its scope instead. Source tags such as "OP L399" are explained in Appendix A.

---

## 1. The goal

This section lists what the owner wants, in his terms, and explains each point. Everything later in the plan serves one of these points. Anything that serves none of them does not belong in the plan.

### 1.1 A cold database answers like Neon

A customer database that nobody has used for days answers its first real request through Cloudflare in under one second, at the 95th percentile. In the owner's words (2026-10-16): "A request from a customer that didn't use his data for 3 days gets executed under 1 s."

- **A real request** is ordinary SaaS work: a session lookup, a page of 50 rows, a count, an insert and an update. A `SELECT 1` never counts, and neither does the time to create a database.
- **Through Cloudflare** means measured where a customer's code runs: from a Cloudflare Worker, and also reported from a laptop in Germany.
- **Why it matters:** this is what makes PGCF a serverless database rather than a cheap always-on one. Integrators can let their customers' databases sleep without the customers noticing.
- **The one measure of progress:** nothing else is reported as progress (OP L43-46).

### 1.2 Only warm and cold

A database is either warm or cold:
- **Warm:** its PostgreSQL is running.
- **Cold:** everything else, whether it slept one minute or three days.

A database goes cold after its idle time and wakes on the next connection. There are no tiers in between. The parked tier, warm-idle and "hot idle" are gone, and their numbers are never reported as progress.

### 1.3 Thin-slice overbooking is the business model

Customers buy a size, for example a database with 256 MB of RAM and 1 GiB of disk. Most databases are cold most of the time. A cold database uses no RAM and no CPU, and only the disk it has actually written. So a node can carry far more sold capacity than it physically has.

- **RAM is overbooked in time.** Only awake databases use memory. A 12 GB node has about 9.7 GiB for awake databases (section 4.5). Suppose every awake database reserved its full size, and on average 5 % of databases were awake. Then one node could still carry about 290 databases of 256 MB, about six times its physical RAM (*estimate*, section 4.11). Decision D3 settles how far awake databases may also be overbooked against each other, by counting their measured use instead of their full size.
- **Disk is overbooked by thin volumes.** Each database gets a volume of its sold size, but disk is used only as it is written. An empty database writes about 120–160 MiB (*estimate*). So 300 databases sold at 1 GiB each need 300 GiB on paper but about 45 GiB in reality.
- **Admission control keeps it honest.** The node never wakes more databases than its RAM can really hold. Cloudflare never places new databases on a disk that is really filling up. When too many databases wake at once, the node acts in this order:
  1. It puts idle-but-awake databases to sleep, if the owner agrees (D2).
  2. It makes the newcomer wait briefly.
  3. It refuses with a retry hint.

  Cloudflare then moves the busiest databases to another node.

This overbooking is the centre of the design (section 4). That is why the plan measures real use everywhere and never reserves sold capacity in full.

### 1.4 Each VPS stands alone; there is no control server

Every VPS (eu1, eu2, and later us1, us2) is a complete, self-contained node: its own OS image, its own databases and its own Tunnel to Cloudflare.
- There is no separate control server, no etcd, no Kubernetes API and no relay.
- The owner stops the EU control server now (2026-10-17).
- A node depends only on Cloudflare and R2.

### 1.5 Grow by adding the same VPS; Cloudflare fills, balances and moves

- **Fill first.** New databases go to a VPS until its active RAM or its CPU load reaches 80 %. Each is measured as the peak of its 30-minute average. After that, new databases go to a new VPS (owner, 2026-10-17).
- **Same image everywhere.** Cloudflare installs a new VPS through the Contabo API, from the same image as every other node, under the operator's purchase policy (AGENTS.md line 10). Buying stays off until the owner gives a costed go.
- **No count limit.** The number of databases on a node is not a limit in itself. Only measured activity and real disk use are.
- **Moves by R2 restore.** A database moves to another node by restoring its R2 backup there under the same ID. This is also how load is balanced when a node runs hot.

### 1.6 Cloudflare is the only door and the only brain, with one stated exception

- **The only door.** All database traffic enters through Cloudflare: first the Edge Worker, then the node's outbound Tunnel. A VPS has no open port; PostgreSQL listens only on a local Unix socket.
- **The only brain.** D1, Durable Objects and Workflows decide placement, generations, routing, desired state, policy and purchases. Nodes execute and report.
- **The exception.** A node decides three things on its own, from local facts, under rules Cloudflare sets:
  - whether a wake fits in its RAM and disk right now (admission);
  - which idle database to put to sleep early while a wake waits, and only if the owner agrees (D2);
  - restarting its own databases that need recovery after a crash.

  The reason: RAM is a local physical fact. Asking Cloudflare would put a network round trip on the one-second path. The node reports every such decision, and AGENTS.md line 5 is amended to say so (Stage 0).
- **Nothing stops a running database by accident.** No lease expiry, stale sample or missing observation ever stops one. Only explicit, generation-checked orders do: suspend, delete, move and maintenance.

### 1.7 Never lose a committed transaction; never replay an uncertain write

- A commit is acknowledged only after its WAL is safely on the node's disk.
- Before a database counts as asleep, every committed transaction is in R2.
- A write whose outcome is unknown is never sent twice.
- Every database is backed up to R2: base backups, continuous WAL archiving and point-in-time recovery (PITR).

### 1.8 Metrics only, generic

- PGCF reports usage and its own infrastructure cost. Usage covers awake time, memory and CPU time, storage, backups, traffic and connections.
- Prices, credits and wallets belong to integrators.
- The API and its defaults are generic. Integrator-specific adapters, classes and pricing live in the integrator's own repository.

### 1.9 Cheap and open source

The point of PGCF is cost: cheap Contabo VPS instead of a hosted serverless database priced per database. Two Contabo VPS cost about USD 26 a month (owner, 2026-10-02). A hosted service for the same set of small databases costs hundreds of dollars a month.

PGCF is open source under Apache-2.0. Anyone with a Cloudflare account and a VPS can run it and add their own pricing.

### 1.10 Simple, small and real

- Build the smallest thing that passes live acceptance on the EU1 stack.
- Add machinery only for an observed problem.
- Delete everything unused; Git history is the archive.
- No mocks; acceptance only from real systems.

This is why option C was chosen: Kubernetes, CNPG and the pool caused most of the cold path, the pool misses and most incidents since 2026-10-12 (section 3.6).

### 1.11 Not in v1

- **Budget enforcement, compute autoscaling and branching.** Integrators call suspend and resume themselves (AGENTS.md line 12).
- **VM-level isolation.** Contabo VPS have no KVM.
- **Automatic high availability.** A region has one node until EU2 is approved. A lost node is replaced by restores from R2.
- **Automatic rebalancing between nodes.** It comes after go-live. Moves themselves exist from the start.

---

## 2. Summary

**What we build.** Every VPS runs one Debian 13 image. On it:
- systemd runs one hardened `pgcf-pg@<id>` service per database. Each runs on its own thin LVM volume, under its own Linux user, with no network.
- A Rust node agent is the only local actor.
- Today's native gateway connects to PostgreSQL over a Unix socket.
- cloudflared holds the node's outbound Tunnel.
- barman-cloud ships WAL and base backups to R2.

Cloudflare keeps the API, D1, the Edge, the Durable Objects and the Workflows. A per-node NodeActor replaces the per-region link.

**What stays:**
- the product promise, warm and cold, and the invariants;
- the API and its definitions (section 3.4);
- the Edge and its admission, the route token and the wake ticket;
- the gateway's hold-and-release protocol;
- usage metrics, the R2 archive layout, the alert engine and the daily D1 backup.

**What goes:** Kubernetes, CNPG, Talos, OpenEBS, the slot pool, the control server, the bootstrap relay, fleet patches, the host guard and identity turns. That is about 199k of 394,568 non-lockfile lines (section 6.6).

**Open-source research.** We found no project, in Rust or any other language, that does all of the following:
- runs many isolated PostgreSQL instances per plain-Linux host;
- wakes them on connect and stops them when idle;
- keeps PITR backups in S3;
- offers a control API.

We build the agent ourselves from proven parts (section 6.1).

**What to expect** (*estimates*, section 5.9):
- **Node path** (from the wake to PostgreSQL ready and released): 85–155 ms with volumes kept mounted, against 469 ms measured in release 23.
- **First answer** of a cold request: p95 of about 0.7–0.95 s (release 24: 1,080 ms).
- **Whole five-statement request:** p95 of about 1.1–1.4 s (release 24: 1.50 s). The four later statements cost 0.27–0.46 s through Cloudflare, whatever the node does (OP L399).
- **So option C alone does not reach the whole-request gate.** Cloudflare-side work is also needed: a connect p95 of about 0.25 s instead of up to 0.67 s, and cheaper round trips per statement. That work is Lane E of Stage 3, measured from Stage 1 on. The owner decides which number gates go-live (D1), knowing this.

**How we get there:**
- Stage 0: stop the old stack, rotate its credentials, put this plan and the amended AGENTS.md in place, and delete the obsolete documents.
- Stage 1: a lab on EU1 with stock Debian. It measures the start path, backups under the real permission model, and the Contabo and Cloudflare facts.
- Stage 2: clean main by deleting the old runtime code.
- Stage 3: build in five parallel lanes: agent; gateway; image and installer; API and Edge; Cloudflare path.
- Stage 4: Cloudflare installs EU1 from the image.
- Stage 5: live acceptance on EU1, including the cold p95, density and data safety.
- Stage 6: runbooks and README.
- Stage 7: go-live gates and the canary.

**Decisions the owner must take** (section 11.5; work proceeds on each default in the meantime):
- D1: gate definition;
- D2: early sleep;
- D3: RAM overbooking basis;
- D4: IDs after node loss;
- D5: naming;
- D6: alert destination;
- D7: shared-kernel isolation;
- D8: the control VPS;
- D9: EU2;
- D10: security reboots;
- D11: who may set per-database resources;
- D12: the Rust/Wasm Edge target.

---

## 3. Product definitions (binding)

### 3.1 The metric

The owner's goal of 2026-10-16 stays word for word; only the vehicle changes. "Loaded into a pool of already running, free PostgreSQL instances" becomes "started directly from its own volume". Every wake takes one path, with no pool and no hit-or-miss branch.

| Item | Definition |
| --- | --- |
| Metric | The first request of a cold database completes in under 1 s at p95 |
| Request | Ordinary SaaS work in sequence: session lookup by key, a 50-row list page, a count, an insert, an update. Today it is the operator's `saas_bench2.py`; Stage 3 commits it to `scripts/e2e` so that every run uses the same request. Never `SELECT 1`, never create time |
| Where measured | From a Cloudflare Worker; also reported from a laptop in Germany |
| Which databases | Idle for at least one hour, some for at least 24 hours |
| Which samples | Every cold first request counts, including those that waited for capacity. Waits are shown as a breakdown inside the p95 and never removed from it |
| What is reported | Per request: connect (wake) time, first answer, whole request, warm pass, and the number of requests until within 25 % of warm. Per-phase timing events as well (section 9.9) |
| Gate | The whole request under 1 s at p95 (plan default; [D1](#115-decisions-open-for-the-owner)) |

**Carried over: Cloudflare adds at most about 150 ms** (old goal item 7, OP L64-65). This is Cloudflare's own processing on the wake path: Edge start, limiters, admission, ticket signing and actor calls. It excludes network transit and the node. The target is at most about 150 ms at p95. Release 24 removed durable writes from admission and placed the actors in the EU; Lane E keeps this target measured.

**Whole-request budget.** The p95 values of the parts do not add up exactly; the table is a budget, not a sum.

| Part | Release 24 (*measured (EU1)*) | Option C without Cloudflare work (*estimate*) | Budget for a whole request under 1 s (*target*) |
| --- | --- | --- | --- |
| 1. Cloudflare connect: client Worker → Edge (TLS, upgrade, limiters, admission, ticket) → Tunnel → gateway | 182–670 ms (PROP) | unchanged, 182–670 ms | p95 ≤ 250 ms |
| 2. Node path: admission, start, release (partly hidden behind part 1) | 469 ms (release 23) | 85–155 ms | p95 ≤ 150 ms |
| 3. Login and first statement, including a cold cache | about 100–200 ms (implied) | 60–200 ms | p95 ≤ 150 ms |
| **First answer** | p50 693 ms, p95 1,080 ms | p95 about 0.7–0.95 s | p95 ≤ 0.55 s |
| 4. Statements 2–5: four round trips through Cloudflare plus execution | +0.27–0.46 s (releases 23 and 24, first pool hit) | unchanged | ≤ 0.40 s |
| **Whole request** | p50 1.15 s, p95 1.50 s | p95 about 1.1–1.4 s | p95 < 1.0 s |

What this means:
- With today's statement round trips, the whole-request gate needs a first-answer p95 of about 0.55 s.
- Option C brings the node part (part 2) into budget.
- The connect tail (part 1) and the statement round trips (part 4) are Cloudflare's. Only Lane E (Stage 3) works on them.
- Service bindings help little. Release 24 measured a p95 of 1,007 ms through a service binding against 1,073 ms public, and bindings work only for Workers on the same Cloudflare account (OP L399).

### 3.2 Warm, cold and activity

- **Warm:** the database's PostgreSQL is running.
- **Cold:** everything else.
- **Idle sleep:** a database sleeps once it has had no busy session and no client activity for its effective idle time (section 3.4).
- **Busy session:** a session that is authenticating, in a transaction (including idle in transaction), running a statement, in COPY, or of uncertain state. A prepared transaction also prevents sleep (`power_busy`).
- **Not activity:** an open, idle connection is not busy and does not keep a database awake. WebSocket pings and unauthenticated transports never count as activity (RRT L132, HAND L646-660).
- **Closing idle connections:** when a database sleeps, the gateway closes its idle connections with WebSocket code 1000, reason "database sleeping". Pools reconnect.

### 3.3 Invariants that never break

1. **Never lose an acknowledged commit.** PostgreSQL acknowledges a commit only after its WAL is fsynced locally. A proven sleep (section 7.9) puts every committed transaction in R2 before the database counts as cold.
2. **Never replay an uncertain write.** The gateway holds the client's startup until the writer is ready. After handoff nothing is replayed. HTTP `/sql` answers `08007` when an outcome is unknown.
3. **One writer per database.** One unit, one data directory and one node at a time. D1 is the generation authority.
4. **All traffic enters through Cloudflare.** PostgreSQL listens on a Unix socket only. The VPS has no listening port on a public address.
5. **Every database is backed up to R2 with Barman Cloud:** base backups, continuous WAL archiving, PITR.
6. **Fail loudly.** A full disk returns an error at once. PostgreSQL stops rather than acknowledge a commit without durable WAL.
7. **Only explicit orders stop a running database.**
   - No lease expiry, stale sample or missing observation ever stops one. Only explicit, generation-checked orders do: suspend, delete, move and maintenance.
   - A partial pull never means stop or delete.
   - Running writers are never stopped for storage.
8. **A refused sleep leaves the database awake and wakeable.** Release 24 found the opposite and fixed it (`3c0ec8a1`). In this design no state exists in which a refused sleep blocks the next wake.

### 3.4 Definitions carried over

These stay as worded in the integrator handover (HAND) and the old plan. Changes are marked.

- **Database ID.** 20 characters, `^[a-z][a-z0-9]{19}$`, random, not derived from the name. It is also the PostgreSQL database name (HAND L51-52).
- **IDs after restore, move and node loss:**
  - A customer restore (full or PITR) always creates a new database with a new ID. The integrator switches its pointer after verifying, and the source keeps running (owner, 2026-10-15).
  - A platform move keeps the ID (section 9.5).
  - Node-loss recovery: see [D4](#115-decisions-open-for-the-owner).
- **Idle time:**
  - `sleep_after_seconds` per database is 60–900 s, or null to use the class value.
  - The class value is 60–2,592,000 s, or null for always warm.
  - It is set on `POST /v1/databases` or with `PUT /v1/databases/{id}/idle-time`. The change is accepted in every state except deleted, and applies from the next idle check.
  - It is on main since `23b30ce7` (migration 0061) and not yet deployed.
- **Manual suspend and resume** (HAND L370-386):
  - `POST /v1/databases/{id}/suspend` refuses connections with `57P03` until `resume`. A connection never wakes a manually suspended database.
  - The database must be ready (`409` otherwise).
  - If sessions are busy, a prepared transaction exists or the archive does not drain, suspend fails with `power_busy` or `power_archive`, and the database keeps running.
  - `resume` is also the supported pre-wake of an idle-sleeping database. Without capacity, it answers `409 conflict` with reason `node_capacity` and `Retry-After: 30`.
- **Usage** (HAND L826-849):
  - Rows are hourly or daily, per project or per database, at most 31 days per query.
  - A row becomes final two hours after its hour ends; bill only from final rows.
  - A metric that is not known is `null`, never zero, and its name is listed in `gaps`.
  - Integrator keys see their own project only.
  - Metrics:
    - `provisioned_seconds` and `awake_seconds`;
    - `memory_mib_seconds` and `cpu_millicore_seconds`: the database's effective limits times awake seconds, not measured consumption;
    - storage used (actual bytes on the volume) and allocated (the effective storage size);
    - backup bytes;
    - `ingress_bytes`, `egress_bytes`, `connections` and `connection_seconds`.
  - Admin-only `GET /v1/costs` reports infrastructure cost per node.
  - **Changed:** `reserved_cpu_millicore_seconds` and `reserved_memory_mib_seconds` described Kubernetes requests and the sidecar. They are dropped (no backwards compatibility, owner rule).
- **Size classes** (HAND L72-95):
  - The operator defines classes; integrators pick one at create or resize.
  - A class that databases reference cannot change its resources or policies (`409`).
  - A disabled class is refused.
  - A class above the region's per-database memory maximum is refused (`400`).
  - A database that no node can host is accepted and waits unplaced ("Waiting for verified regional capacity").
- **Hostname and protocols:**
  - One hostname for all databases.
  - Neon-driver WebSocket mode at `GET /v2?database=<id>&user=<role>`, and HTTP `POST /sql`.
  - Replication connections are refused (`0A000`).
- **Integrator retry rule:**
  - Retry `57P03`, `08006` and `53300` with backoff (1, 2, 4, 8 s) for about 90 s.
  - Never retry `28P01`, `3D000`, `28000`, `0A000` or `08P01`.
  - Never replay non-idempotent writes.
- **PostgreSQL 18** (owner, 2026-10-15).

### 3.5 Resources per database

The owner decided on 2026-10-17 that storage, RAM and CPU are set per database, from outside, through the admin API.

- **Who sets them.** An admin key sets them on create and with `PUT /v1/databases/{id}/resources` (`memory_mib`, `cpu_millicores`, `storage_gib`). Integrator keys choose a size class, as today. Whether integrator keys may also set them is [D11](#115-decisions-open-for-the-owner).
- **Class and override.** The class supplies the defaults. A per-database value replaces the class value and may be above or below it, within the region bounds:
  - memory: 256–4,096 MiB in steps of 256 (today's region maximum);
  - CPU: 100 millicores up to the node's cores;
  - storage: at least the current size. There is no shrink; to get a smaller database, restore into a new one.

  The class rules of 3.4 stay; an override does not change the class.
- **Metrics.** Usage reports each database's effective values. `memory_mib_seconds` is the effective memory limit times awake seconds, and allocated storage is the effective `storage_gib`.
- **When a resize does not fit:**
  - A resize the node cannot take now answers `503 capacity_exhausted` with `Retry-After` (existing contract, HAND Appendix A). There is no automatic move in v1.
  - A sleeping database's new size applies at its next wake, which then needs room for the new size.
  - Storage grows online. A storage increase that would cross the node's logical cap (section 4.3) is refused the same way.

### 3.6 Why option C (what changed on 2026-10-17)

| Fact (Kubernetes runtime) | Value |
| --- | --- |
| Cold node path, release 23 | 469 ms: attach 75, archive binding 33, PostgreSQL start after the fence lift 275, release 82 (*measured (EU1)*, OP L399) |
| Kubernetes and CNPG share of it | about 280–340 ms (*estimate*, PROP) |
| Pool miss | 4.1–5.2 s for Pod recreation, 20.9 s on the old path (*measured (EU1)*) |
| Fleet rollout | 38–49 min per two-node rollout (*measured (EU1)*) |
| Node reserve on a 12 GB node | 1 GiB kubelet reserve, about 1 GiB idle platform, 1,650m of 6,000m CPU, and a 100m/128 MiB backup sidecar per awake database (PROP) |
| PostgreSQL alone on EU1 | 111–117 ms to ready, including `pg_ctl`'s 100 ms poll; first SQL 136–169 ms (*measured (EU1)*) |
| Hardened systemd unit, start to ready | 54.0 ms p50, 60.7 ms p95 (*measured (lab)*) |

Kubernetes and CNPG scheduled nothing. Each database was one PostgreSQL instance pinned to the node Cloudflare chose, and moves were already R2 restores.

Three judges scored four options (goal / safety / delivery, each out of 10):
- **A**, keep Kubernetes: 3.5 / 6 / 7.
- **B**, Kubernetes as a thin platform: 5.5 / 4.5 / 3.
- **C**, systemd and a Rust agent: **8.5 / 7 / 5**.
- **D**, one microVM per database: 1.5 / 4 / 1. Ruled out: Contabo VPS have no `/dev/kvm`, and KVM-capable VDS cost about 3.3 times more per GB of RAM.

### 3.7 Work rules

- Until the metric passes live: build option C to acceptance, fix live failures, and add no features.
- Do not over-test. Retest only after a relevant change or a concrete failure. Parallelize.
- One release per change batch. No staged compatibility deploys and no backwards compatibility (owner rule, 2026-10-15).
- Never name releases "R1/R2/R2.x": to the owner, "R2" means Cloudflare R2. Say "release 25".
- Never say "Dev". Say "the EU1 stack": there is no separate test environment.
- No effort or duration estimates (AGENTS.md line 21).
- Test doubles must speak the real PostgreSQL wire forms. Lesson learned: an `inet` value with `/32` once stopped every database from becoming ready.
- After every node release, run create, ready, SQL and delete before building anything on top.

---

## 4. Thin-slice overbooking (central)

### 4.1 Sold versus consumed

| | Cold database | Awake database |
| --- | --- | --- |
| RAM | 0 (no process; its files may stay in reclaimable page cache) | Up to its memory size (for example 256 MiB), a hard ceiling per database |
| CPU | 0 | A weighted share, plus a quota of its size once started |
| Disk | Only the chunks it has written to its thin volume | The same, growing as it writes |
| Sold to the customer | The full size | The full size, within its ceilings |

The overbooking is mostly in time. Most databases sleep most of the time, and a sleeping database costs no RAM and no CPU. Disk is overbooked separately, because thin volumes allocate only what is written. Neon gets its density the same way: scale-to-zero does the work (autoscaling README L39-40).

Whether awake databases are also overbooked against each other is [D3](#115-decisions-open-for-the-owner):

- **(a) Measured use (plan default).** A wake is admitted against the node's measured free memory.
  - This is what placement mode `actual_ram` does on main today: "running databases are not reserved" (`apps/api/src/domain/startup-admission.ts` L126-143 at `4bfbe546`).
  - Many more databases can be awake at once.
  - The risk: several awake databases may grow at the same time. The kernel's memory limit for all databases together then kills one backend, which may belong to another tenant. That database's PostgreSQL runs crash recovery; its sessions drop, and no acknowledged commit is lost (old density scenario S6, OP L687).
  - The customer's 256 MB is then a ceiling, not a guarantee.
- **(b) Full reservations.** Each awake database reserves its full size.
  - 256 MB is then guaranteed while awake.
  - Only about 37 awake 256 MiB databases fit on a 12 GB node (section 4.5).
  - This would overbook less than the code on main does today.

### 4.2 Owner rules (2026-10-17)

1. **Placement by measured activity.** New databases go to a VPS until its active RAM or its CPU load reaches 80 %, each measured as the peak of the 30-minute average. After that, new databases go to a new VPS installed from the same image.
2. **No count limit.** The number of databases per VPS is not a limit in itself. Only measured activity and real disk use are.
3. **Resources per database through the admin API** (section 3.5).
4. **When many databases wake at once,** in the owner's order:
   1. early sleep of idle-but-awake databases;
   2. queue, or refuse with a retry hint;
   3. move the most active databases to another VPS by R2 restore (sections 4.7 and 9.5).

Purchases still need the owner's costed go (section 9.7).

### 4.3 Disk: thin LVM

**What thin LVM is.** A thin pool is one large block of disk. Each database gets a thin volume with a nominal size, say 1 GiB. The pool hands out real disk only in small chunks (64 KiB) as the database writes. The sum of nominal sizes can therefore exceed the disk; that is the disk half of the overbooking.

**Layout per node.** The agent creates it once, at first boot:
- **Volume group `pgcf`** on the LVM partition, with a large LVM metadata area so that hundreds of volumes fit. The default area of about 1 MiB may not hold about 1,000 volumes; Stage 1 measures this.
- **One thin pool over the whole partition.** It holds the data, 1 GiB of pool metadata, and an equal spare for repair.
  - On a 150 GB disk that leaves about 125 GiB of data (*estimate*; Stage 1 records EU1's real disk size).
  - The pool is created at full size: there is no growth step, no anchor volume and no unused slack.
- **Zeroed chunks.** Chunks are zeroed before reuse, so a chunk freed by tenant A is never readable by tenant B. This is tenant isolation, verified in Stage 5.8.
- **Fail at once.** A full pool fails writes immediately instead of hanging for 60 s.
- **Ownership.** The agent owns the pool and never removes it.

**Per database:**
- One thin volume of the database's storage size, with its own ext4 filesystem.
- Mounted at `/var/lib/pgcf/db/<id>`, readable only by its owner.
- It stays mounted while the database sleeps, so its files can stay cached.
- After every clean sleep, the agent runs `fstrim` on it, off the request path. This returns space freed inside the filesystem (dropped tables, removed WAL) to the pool. Always-warm databases are trimmed daily.
- Storage grows online.
- *Estimate*: an empty database writes 120–160 MiB.

**Three pool rules.** Thresholds are operator configuration.

| Rule | Data | Metadata | Effect |
| --- | --- | --- | --- |
| Placement closed | Actual use ≥ 80 % (the owner's number), or the logical cap reached | ≥ 50 % | No new database or restore is placed on the node; warning alert |
| No room | Free data below the reserve | ≥ 75 % | Wakes, creates and restores on the node are refused with `57P03` "storage"; critical alert; running databases keep running |
| Full | No free data | — | Writes fail at once; affected databases stop; recovery below |

- **Logical cap** (plan default, from the research). The sum of nominal volume sizes stays at or below 4 × the pool's data size. It bounds how much sold storage a full pool can hurt. On a 125 GiB pool that is 500 GiB, or 500 databases of 1 GiB, above the expected density.
- **Reserve.** It starts at 6 GiB: the old 2 GiB reserve plus the old 4 GiB slack, now inside the pool. Stage 5.5 measures the node's sustained write rate while filling the pool. If that rate × 10 s is larger, the reserve is raised to it. This way the agent's pool sample, taken every 5 s, always sees the reserve being used before the pool is full.
- **Write limits.** Each database's write bandwidth and IOPS are capped by its size, starting at 16 MB/s and 1,000 IOPS for 256 MiB. Stage 5.5 sets the real values from the measured disk. This bounds how fast one tenant can fill the pool.
- **Full-pool recovery.** It is built into the agent in Stage 3, with a runbook in Stage 6. A full pool makes ext4 on the affected volumes abort its journal and remount read-only, so those databases stop.
  - Space comes back above the reserve through deleted or moved databases and trimmed volumes.
  - Then the agent stops each affected unit, unmounts it, runs `e2fsck -p`, mounts it again, and wakes the database through admission.
  - PostgreSQL then runs crash recovery from its durable WAL. Every acknowledged commit survives.

**A full single volume.** A tenant can fill its own volume in three ways: by reaching its quota, by running out of inodes (many relations or partitions), or by keeping WAL during an R2 outage.
- **Alerts.** The agent samples each volume's space and inodes every 60 s. At 80 % and at 90 % it raises an alert and a database event the integrator can read.
- **Recovery.** When the volume is full, PostgreSQL stops on the failed WAL write, and crash recovery itself needs to write. The agent therefore frees the filesystem's 1 % root-only reserve once. That lets recovery finish and lets the integrator delete data or resize.
- **If it still cannot start,** the database stays cold with health `storage_full` until a resize.
- **No automatic extension:** that would give away storage nobody bought.

### 4.4 Memory and CPU of one database

- **Memory:** a hard ceiling equal to the database's memory, a soft limit at 90 % (where the kernel throttles and reclaims first), and no swap.
- **PostgreSQL settings** follow the memory size (table in Appendix C). For 256 MiB: `shared_buffers` 32 MB and `work_mem` 2 MB.
  - *Estimate* of the worst case for 256 MiB: about 215 MiB, under the 230 MiB soft limit.
  - `shared_buffers` stays small because shared memory cannot be reclaimed without swap; the reclaimable page cache does the caching.
- **CPU:** a weight proportional to the database's CPU size. There is no quota while PostgreSQL starts, because a quota would stretch the start by up to 4×. The quota of its size is set right after ready, which takes 4.6 ms (*measured (lab)*).
- **Out of memory:** the kernel kills a backend, never the postmaster first. PostgreSQL then runs crash recovery for that database only. Acknowledged commits survive, and it is never a node event.
- **No swap and no zswap** in v1. Revisit only on an observed problem.

### 4.5 Node budget: 12 GB, 6 vCPU (EU1: 11,943 MiB visible)

All values are operator configuration. They remain *estimates* until Stages 1 and 5 measure them (OB model).

| Item | MiB | Note |
| --- | --- | --- |
| System: kernel, systemd, journald, sshd, cloudflared, gateway, agent | 768 | Agent and gateway are protected from reclaim. In the Kubernetes era: 1 GiB kubelet reserve plus about 1,041 MiB idle platform |
| Kernel memory of mounted sleeping volumes | 150 | About 0.5 MiB per mounted volume (*measured (lab)*: 0.13–0.55 MiB), so 150 MiB at 300 volumes. Stage 5.6 measures it at scale |
| Backup jobs | 512 | Two WAL uploads and one base backup or restore at once. Stage 1 measures memory per process and sets the concurrency (section 7.5) |
| Kernel and page-cache floor | 600 | About 5 % |
| **Awake-database budget** (hard limit on all databases together) | **9,913** | Enforced by the kernel on the database slice; admission per D3 |

**Awake capacity under (b), full reservations.** Each awake database reserves its memory plus 8 MiB. That allows 37 awake databases of 256 MiB, 19 of 512 MiB, 9 of 1 GiB or 4 of 2 GiB. For comparison, the Kubernetes runtime capped EU1 at 9 awake databases, limited by CPU requests (OP L673-676).

**Awake capacity under (a), measured use,** depends on what awake databases really use. Suppose an awake, mostly idle 256 MiB database uses about 80 MiB (*estimate*; Stage 5.6 measures it). Then about 120 fit by RAM, and CPU or disk binds first.

**CPU:**
- There is no node-wide cap on the sum of quotas. CPU is shared by weight, each awake database is capped by its own quota, and placement watches measured CPU load (the 80 % rule).
- At most 4 PostgreSQL starts run at once. In the lab, a 20-database storm was CPU-bound; all 20 were ready in 353–375 ms on 6 vCPU (*measured (lab)*).

### 4.6 Wake admission on the node

The agent is the one admitter for every PostgreSQL start on its node:
- wakes;
- creates;
- restores and PITR replay (replay counts as awake memory);
- move targets;
- recovery starts (section 7.10);
- the health check after an update.

One serialized loop decides on exact local facts, with no network hops. Its state is rebuilt from the running units whenever the agent starts.

For a start of database *d* with memory size *m*, three rules apply:

1. **Room rule** (ported from `storage-capacity.ts`). The pool sample is at most 10 s old, and the "no room" rule of 4.3 does not hold. Otherwise the answer is `57P03` with detail "storage".
2. **Memory rule**, one of two, per [D3](#115-decisions-open-for-the-owner):
   - (a) measured, the default: `MemAvailable`, minus the full size of every start in flight, minus the 600 MiB floor, is at least *m*. As on main, a start counts at its full size until it reports ready.
   - (b) reserved: the reservations of awake and starting databases, plus *m* + 8 MiB, stay within the 9,913 MiB budget.
3. **Start cap:** fewer than 4 starts are in flight.

**If all three hold**, the agent starts the unit. Under either memory rule, the kernel's limit on the database slice is the backstop. systemd never restarts a crashed unit by itself; the agent restarts it through this same admission, so no start ever bypasses the rules.

**Otherwise the wake waits** in a FIFO queue for up to 10 s. The gateway is already holding the client.
- If D2 is accepted, the agent puts one idle-but-awake database to sleep early while a wake waits (4.7).
- If the wait expires, the client gets `57P03` with detail "node at awake capacity" and a retry hint of 5 s, and the refusal is counted.

No other early sleep exists. Without a waiting wake, a database sleeps only at its own idle time. Every wake that waited still counts as a cold sample in the p95, with its wait shown in the breakdown.

### 4.7 When many databases on one node wake at once

1. **Admit** while the memory rule holds.
2. **Early sleep**, only if D2 is accepted and only while a wake is queued. The agent picks the least recently active database that meets all of these:
   - awake;
   - not always-warm;
   - not starting;
   - no client activity (section 3.2) for at least 30 s.

   It puts that database to sleep with the normal sleep proof, one per queued wake. The integrator handover states this rule, and `awake_seconds` keeps reporting the truth.
3. **Queue** for up to 10 s, then answer `57P03` with a retry hint. Integrators already retry `57P03` with backoff for about 90 s.
4. **Move.** Cloudflare sees the queue waits and refusals in the node rollups. An operator, or after go-live an automatic rule, moves the most active databases off the node by R2 restore under the same ID (section 9.5).

An early sleep is a full sleep proof: checkpoint, WAL switch, upload and stop. A waiting wake therefore takes seconds, not milliseconds; Stage 1 measures how long. Such wakes miss the one-second target and are counted in the p95.

### 4.8 Placement in Cloudflare

At create, restore and move, a node is **eligible** when all of these hold:
- it is online with fresh samples, and its room rule passes;
- its pool is open for placement (4.3: data below 80 %, metadata below 50 %, below the logical cap);
- **owner rule:** the peaks of the 30-minute averages of active RAM and of CPU load are both below 80 %;
- the database's memory fits the node's maximum.

**Fill first** (owner rule). Among eligible nodes, the fullest wins: the node with the highest active-RAM peak that stays under 80 % after adding the new database. A new node gets databases only when the others are full.

These definitions are plan defaults beyond the owner's rule, set in operator configuration:
- **Active RAM** is the RAM in use on the node (MemTotal − MemAvailable) divided by MemTotal. It is sampled every 15 s and averaged per 30 minutes. Under D3 (b), it is the sum of awake reservations divided by the awake budget instead.
- **CPU load** is busy time divided by cores, averaged the same way.
- **Peak window:** the highest 30-minute average of the last 7 days, or of the available history for a new node.
- **New databases without history** count at their full memory size until their first 30-minute average exists. This keeps a burst of creates from all landing on one node before its peak can move.

If no node qualifies, the create waits as "Waiting for verified regional capacity", as today. If purchases are enabled under a costed go, AddNode buys a VPS (section 9.7).

### 4.9 What Cloudflare tracks

- **NodeActor:** one Durable Object per node, a plain replacement for the per-region RegionLink.
  - It holds the agent's outbound, hibernatable WebSocket.
  - It holds the agent's latest snapshot, sent every 15 s: the awake set, queue length, memory in use and available, CPU load, pool data and metadata %, and the room flag.
  - It serves the desired page, and it receives observations, inventory, usage and wake timing events.

  Node-side refusals reach clients through the gateway as `57P03`. An offline node fails at its Tunnel.
- **D1** is the single writer, written about once a minute per node. It holds:
  - per-minute node rollups: awake count, RAM in use, CPU load, queue waits, early sleeps, capacity `57P03` refusals, pool data and metadata %, and actual bytes;
  - hourly per-database `awake_seconds` (exists today) and actual bytes;
  - per-node policy: reserves, thresholds and purchase switches.

Placement and purchase decisions read only D1 and NodeActor.

### 4.10 Capacity alerts

- **Kept:**
  - `regional_node_ram_warning` (85 %);
  - `regional_node_cpu_warning` (90 %, fed by agent CPU samples);
  - `regional_node_storage_warning` (pool closed for placement);
  - `thin_pool_no_room`;
  - `thin_pool_unobserved`;
  - `regional_node_stale` (180 s);
  - `regional_node_cap_reached`.
- **New:**
  - pool metadata thresholds;
  - a sustained count of capacity `57P03` refusals per node;
  - a database volume at 80 % and 90 % of its space or inodes;
  - `storage_full`.
- **Deleted:** `thin_pool_growth_exhausted` (there is no growth any more) and the sticky blocked state. Every sample re-evaluates; an error never latches.

### 4.11 Expected density (*estimate*)

The overbooking model (OB) bounds the databases sold per node with a 99.9 % binomial bound, at a 1.5× daily peak:

| Mean awake share | 256 MiB databases per 12 GB node under (b), RAM-bound at about 37 awake | Sold RAM vs physical |
| --- | --- | --- |
| 3 % | about 490 | about 10× |
| 5 % | about 290 | about 6× |
| 10 % | about 150 | about 3× |

- **Disk.** At about 0.3 GiB written per database, placement closes at about 330 databases (80 % of 125 GiB). So disk binds near the same point as RAM under (b), and before RAM under (a).
- **LVM.** Stage 1 measures how many volumes one volume group handles well. That number may bind first. It becomes a technical placement bound, not a sales limit.
- **Reality first.** Real awake shares stay unknown until `awake_seconds` is measured per database.
  - A database pinged by a health check every few minutes is effectively always awake, and placement sees that in its metrics.
  - Because the 80 % rule uses measured peaks, density follows reality without this model. The model only forecasts.

### 4.12 Old thin logic: kept and deleted

**Kept**, ported to the agent and checked locally before every start:
- the room rule (fresh sample, pool identity, data and metadata reserves);
- 64 KiB chunks;
- failing at once on a full pool;
- "never stop a running writer for storage";
- "nominal sizes do not reserve pool space".

**Deleted:**
- Cloudflare-driven pool growth. A create that needed a growth step took 160–246 s instead of 49 s.
- The `pgcf_anchor` volume.
- The sticky `blocked` status. It stopped placement and rollouts for about 3 h on 2026-10-17.
- Identity-proof turns, start holds, write tokens and the host guard.
- The `reserved` placement mode.
- The CPU charge of 450 m per awake 256 MiB database.
- The sidecar and compute-pool terms in admission.

---

## 5. Architecture

### 5.1 Big picture

```
Client (app, Worker, laptop)
   │ TLS WebSocket or HTTPS, one hostname
   ▼
Cloudflare Edge Worker ── DatabaseActor (DO): admitWake from DO state only
   │                  └── NodeActor (DO): the node's link and latest snapshot
   │ route token or wake ticket; Access service token; through the node's Tunnel
   ▼
VPS "eu1" (Debian 13 image, no open ports)
   cloudflared ─► gateway (loopback) ─► Unix socket /run/pgcf/<id>/.s.PGSQL.5432
                     ▲   local Unix socket (wake, release)
                     ▼
                  node agent (Rust) ── systemd (D-Bus) ── pgcf-pg@<id>.service ×N
                     │                 lvm2 / dm-thin ── thin volume per database
                     │                 barman-cloud (as the database's user) ──► R2
                     └── outbound WebSocket ─► NodeActor; HTTPS ─► API Worker
Cloudflare API Worker, D1 (authority), Workflows (AddNode), R2 (archives, images)
```

### 5.2 Who decides what

| Decision | Who | Basis |
| --- | --- | --- |
| Placement, generations, routing, desired state, policy | Cloudflare (D1, DatabaseActor, API) | Node rollups, owner rules |
| Purchases; declaring a node lost and fencing it | Cloudflare, through the operator or the API, under the purchase policy and the owner's costed go | Policy |
| Suspend, resume, delete, resize, restore, move, maintenance | Cloudflare orders; the node executes | Desired state |
| Idle sleep | The node, at the idle time Cloudflare sets | Gateway activity |
| Wake admission, queue, refusal | The node | Local RAM and pool facts |
| Early sleep while a wake waits (only if D2 is accepted) | The node, under rules Cloudflare sets | Activity |
| Recovery starts of its own unproven databases | The node | `pg_control`, proven-sleep record |

The node reports every decision it takes: wake timing events, queue waits, early sleeps, refusals and recovery starts.

### 5.3 Cloudflare control plane

**Stays:**
- **API Worker** product core: databases, roles, lifecycle, restore and the restore catalog, archives and retained archives, usage, costs, resource profiles, alerts and cron health, the Contabo provider, firewall allocation, API keys, projects, size classes, idempotency, the OpenAPI documents and the CronWatchdog DO.
- **D1** as the authority: placement, generations, routing and desired state. Partial pulls never mean delete.
- **DatabaseActor admission:**
  - `admitWake` reads only Durable Object state.
  - For an idle sleeper it returns a wake ticket (route token v5: operation, generation + 1, route revision, role revision hash).
  - Every connect of the same wake gets the same ticket, and D1 commits the claim after the answer.
  - Refusals are `3D000`, `28P01`, `57P03`, `08006` and `53300`.
- **Mutation barrier:** stop admission from the old snapshot, commit to D1, execute on the node, publish the new snapshot, then reopen.
- **Release 24's Cloudflare speedups and limits:**
  - gateway-terminated pipelined password, HTTP `/sql`, EU `locationHint` for the actors, and a smaller Edge bundle;
  - the service-binding limiter key;
  - 120 new connections per database per 60 s;
  - 32 waiters per wake;
  - 200 sessions per database and 2,000 per gateway.
- **Edge:** TypeScript (`apps/edge`, deployed). The approved target in AGENTS.md stays Rust/Wasm (`apps/edge-rust`, never deployed); this plan does not change it. Whether to keep that target is open decision [D12](#115-decisions-open-for-the-owner): the old plan's language verdict found no wake gain from it (OP L488-495).

**Changes:**

| Area | Today | Option C |
| --- | --- | --- |
| Node identity | Kubernetes `node_uid`, `k8s_node_name`, `cluster_uid` | `node_uid` is the install identity issued at enrollment (a reinstall is a new node); the hostname (`eu1`) replaces `k8s_node_name`; `cluster_uid` is dropped |
| Agent key, link, desired page | Per region (`pgcf_ak_<region>_`, RegionLink DO) | Per node: Ed25519 node key, NodeActor DO, desired page per node |
| Gateway URL | One per region, reached with a plain public fetch (`apps/edge/src/gateway.ts` L18-45) | One per node, on its own Tunnel, behind Cloudflare Access or a private binding (section 5.8) |
| Route token | v2–v4 carry a Pod target | One new version carries node and instance (systemd InvocationID); v2–v4 are deleted; v5 wake tickets stay. The route key is derived per node, so a node can verify only its own tokens |
| Release spec | Talos, Kubernetes, charts, fleet-patch stages | Node image (URL, sha256, size), binaries (URL, sha256), cloudflared, the pinned Debian snapshot and package lock |
| Thin storage | Container turns through the relay (18–29 s each) | Agent orders in the desired page; inventory in the agent's snapshot |
| Admission charges | Class + 512 MiB sidecar + slot overhead; CPU request per database | Per D3 on the node; placement per section 4.8 |
| Backup credential | One bucket-wide R2 key copied to every database | Per-database, per-generation temporary credentials signed by the Worker (section 7.3) |
| Retention | Plugin on the node | The Worker, through its R2 binding (section 7.7) |
| AddNode | Purchase, rescue, Talos install through the relay, join, fleet patch | Purchase, rescue with a pull installer, reboot, enroll (section 9.2) |
| Infrastructure backup | D1 export + etcd snapshot | D1 export only |

### 5.4 The node

**Operating system: Debian 13 (trixie).** PGDG publishes signed trixie packages of exactly the versions running today: PostgreSQL 18.6, pgvector 0.8.7 and barman-cli-cloud 3.20.1 (OSI). Flatcar, the alternative, ships no PostgreSQL and no Python, which barman needs. Debian brings systemd 257, lvm2 2.03.31 and thin-provisioning-tools 1.1.0.

**One image, installed once.**
- mkosi builds one disk image in CI, from a pinned Debian snapshot and a package lock that lists every version and sha256.
- The root filesystem is ordinary and writable.
- There are no A/B root slots, no sysext images, and no image signing beyond sha256 checks (section 9.1).
- At first boot, the rest of the disk becomes the LVM partition.
- Updates are described in section 9.3.

**Processes:**

| Process | Runs as | Purpose |
| --- | --- | --- |
| `cloudflared` | Sandboxed system user | One remotely managed Tunnel per node, carrying the gateway and the operator shell, both on loopback |
| `pgcf-gateway` | Own user | Today's native gateway in local mode (section 5.7) |
| `pgcf-agent` | root (LVM, mounts, systemd) | The only local actor (section 5.6) |
| `pgcf-pg@<id>` | `pgcf-<id>`, a fixed uid per database | One PostgreSQL per database (section 5.5) |
| barman-cloud jobs | `pgcf-<id>` of the database they serve | Started by the agent in the backup slice (section 7.4) |
| `sshd` | root | Bound to loopback only; reachable only through the Tunnel with Cloudflare Access (section 8) |

The firewall drops all inbound traffic except established flows and IPv6 neighbour discovery. Nothing listens on a public address.

### 5.5 The PostgreSQL service of one database

Each database runs as one systemd service, `pgcf-pg@<id>`, from a template in the image. Appendix C has the exact settings; `systemd-analyze security` rates the lab unit 0.4, "SAFE".

- **Started directly.** systemd starts `postgres` itself, never `pg_ctl`, which polls every 100 ms. PostgreSQL tells systemd the exact moment it accepts connections (`READY=1`), so nothing polls.
- **Its own user.** A fixed Linux user per database, never a recycled dynamic one, so a sleeping tenant's files can never pass to another tenant.
- **No network.** Only a Unix socket, and no IP address family at all.
- **Locked down:** a read-only system, private `/tmp` and devices, a private size-limited `/dev/shm`, no capabilities, a system-call filter, and no new privileges.
- **Own limits.** Memory, CPU, IO and task limits as in 4.4, inside the slice that holds all databases.
- **Its own volume.** The service refuses to start unless the database's volume is mounted.
- **Stopped cleanly.** A stop is a fast shutdown. systemd never restarts a crashed unit by itself; the agent restarts it through admission (section 4.6).
- **Authentication.** Tenant roles log in over the socket with SCRAM-SHA-256. The agent and backup roles use peer authentication. Nothing else can log in.
- **Archiving** goes through a small client that talks to the agent (section 7.5). The tenant's PostgreSQL never sees an R2 credential.
- **Limit changes** are applied as live unit properties, which takes 6.7 ms (*measured (lab)*). They never use a systemd reload, which took 73 ms with about 60 units (*measured (lab)*).

### 5.6 The node agent (Rust)

One binary, `apps/node-agent`, is the only actor on the node. Its jobs:

1. **Link.** Keep the outbound WebSocket to NodeActor, authenticated by the node key. Fetch the desired page. Post the snapshot, observations, inventory, usage and wake timing events.
2. **Admission.** The single admitter for every PostgreSQL start (section 4.6), plus early sleep if D2 is accepted.
3. **Storage.**
   - Create, grow and remove volumes.
   - Read pool health every 5 s, and each volume's space and inodes every 60 s.
   - Recover from a full pool or a full volume (section 4.3).
4. **Units.** Drive systemd over D-Bus: start, stop, wait for the result, and set limits without a reload.
5. **Database lifecycle:**
   - create, delete and resize;
   - roles, through the existing catalog SQL;
   - clean sleep with the sleep proof;
   - wake with the `pg_control` check;
   - move source and move target.
6. **Backups.** The archive socket, base backups, restore and PITR, each as a job under the database's own user (section 7).
7. **Recovery.** At boot, and after any failed proof or unexpected stop, find unproven databases and recover them through admission (section 7.10).
8. **Fencing orders from Cloudflare.** A superseded generation is never started or archived again (section 7.11).
9. **Metrics and diagnostics:** usage deltas (existing arithmetic), archive lag, pool %, and sanitized journal excerpts on request over the link.
10. **A health check** (`pgcf-agent check`): create a scratch database, start it, query it over its socket, then stop and delete it. The CI boot test uses it, and it runs after every update.

An agent restart never stops a database. The units are independent of the agent, and its state is rebuilt from the running units at start.

### 5.7 The gateway in local mode

The native gateway keeps about 10.5k lines:
- `transport.rs`: WebSocket to PostgreSQL, frame budgets, no replay after handoff;
- `auth.rs`: gateway-terminated SCRAM, pipelined password, zeroized;
- `sql.rs`: HTTP `/sql`;
- `hold.rs`: the wake queue, v5 tickets, 32 per database and 512 in total, and a 25 s wake bound under the Edge's 60 s;
- budgets, telemetry and sessions.

Changes:
- **Writer discovery.** The Kubernetes watches (`targets.rs`, `kubernetes.rs`, 2,498 lines) become a local table that the agent pushes. It maps each database to its socket path, generation, route revision, expected uid and main PID.
- **Dial.** A Unix socket (0.03 ms, *measured (lab)*) replaces TCP and TLS to a Pod. Backend TLS, CAs and TLS names are deleted.
- **Peer check.** The kernel tells the gateway the peer's uid and pid (`SO_PEERCRED`). They must be the database's uid and the unit's main PID (*measured (lab)*: equal). This replaces the Pod, CA and attestation checks.
- **Control channel.** The HTTP long-poll to the controller and the fence ConfigMap become one local Unix-socket channel to the agent. This removes release 23's 15–82 ms release step and its 33 ms archive binding.
- **Labels and listening.** Each connection is labelled warm or cold. The gateway listens on loopback only.

### 5.8 The path from the Edge to the node

- **cloudflared** 2026.10.0, pinned by sha256. There is one remotely managed Tunnel per node, created by the API at enrollment. Its token is loaded from an encrypted systemd credential, never from a command line.
- **The gap today.** The Edge reaches a gateway with a plain fetch to a public HTTPS URL (`apps/edge/src/gateway.ts` L18-45). Anyone on the internet can reach that hostname through Cloudflare and so bypass the Edge's rate limiters and admission. Only the route token protects it.
- **The fix:** each node's gateway hostname sits behind **Cloudflare Access**.
  - The Edge holds a service token. Access refuses requests without it.
  - cloudflared checks the Access token again before forwarding.
  - The gateway still requires the route token.
- **Alternative:** a private Worker-to-Tunnel binding (Cloudflare's Workers VPC). If the account has it and it measures at least as fast, Lane E uses it instead, and the public hostname goes away.
- **Check:** Stage 4 verifies that a direct request to the node hostname without Access credentials is refused at Cloudflare.

### 5.9 A cold wake, step by step

| # | Step | Basis | Value |
| --- | --- | --- | --- |
| 1 | The client Worker opens the WebSocket. The Edge runs both limiters and `admitWake` from DO state, signs a v5 wake ticket and opens the gateway socket through the node's Tunnel | *measured (EU1)*, release 24 "Cloudflare connect"; unchanged by option C; Lane E works on it | 182–670 ms |
| 2 | The gateway verifies the token, checks the replay cache and queues the wake with the agent **before** answering the upgrade. It holds the StartupMessage and the pipelined password | *estimate* | 0.1–0.5 ms |
| 3 | The agent applies the room and memory rules and reads `pg_control` with its checksum: state "shut down", identity and checkpoint against the proven-sleep record | *estimate* | 1–5 ms |
| 4 | Mount, only if not mounted | Kept mounted: 0; at wake: *measured (EU1)* 68–120 ms | 0 or 68–120 ms |
| 5 | Start the unit until PostgreSQL reports ready | *measured (lab)* 54.0 / 60.7 ms (p50/p95); *estimate (EU1)* 80–150 ms | 80–150 ms |
| 6 | Release to the gateway with uid and main PID; peer check | *estimate* | < 1 ms |
| 7 | Unix dial, forward the held startup, SCRAM login | *measured (lab)* 4.3 / 5.0 ms; *estimate (EU1)* 5–10 ms | 5–10 ms |
| 8 | First SaaS statement | *measured (EU1)*: about 20 ms with a warm cache, 88–149 ms with a cold cache | 20–149 ms |
| 9 | Answer back to the Worker | *estimate* | about 20 ms |
| 10 | After the answer, off the path: D1 claim, observation, usage, CPU quota | — | 0 ms |
| 11 | Statements 2–5, each one round trip through Cloudflare | *measured (EU1)*, releases 23 and 24 | +0.27–0.46 s |

- **Node path (steps 2–6):** *estimate* 85–155 ms with volumes kept mounted, 155–275 ms when mounting at wake. Release 23 measured 469 ms. *Target:* p95 ≤ 150 ms with volumes kept mounted.
- **First answer:** *estimate* p50 about 0.43–0.6 s, p95 about 0.7–0.95 s.
- **Whole request:** p95 about 1.1–1.4 s (section 3.1).
- **Overlap:** the wake starts before the upgrade is answered. This hides about one Worker-to-gateway round trip of the node path.

**What still decides the p95** is not the node:
- **The Cloudflare path:** the connect tail (up to 670 ms) and the four later round trips. Lane E works on both.
- **A cold page cache** for a database idle for days, which adds 70–130 ms to the first statement.
  - Volumes stay mounted while asleep, so a stopped database's files stay cached until the memory is needed. Only an unmount drops them (*measured (lab)*: a 64.3 MB table stayed fully cached after stop; unmounting dropped it to 0).
  - Under memory pressure, that cache goes first.
  - If a measured p95 misses because of it, the next step is `pg_prewarm` with `autoprewarm` (Neon found the same). This is added only on that observed problem.

### 5.10 Create, sleep, delete, resize, move

**Create:**
1. Cloudflare places the database (section 4.8) and writes the desired state.
2. The agent creates the user, the volume and the filesystem, mounts it, runs `initdb` and writes the configuration.
3. It checks that the database's R2 prefix is empty, and refuses otherwise.
4. It starts PostgreSQL through admission, applies the roles and takes the first base backup.
5. It reports **ready only when that backup is DONE**; only then does the Edge route traffic. WAL without a base backup cannot be restored, so a database is never writable before it is restorable. An empty cluster backs up in seconds; Stage 1 measures it.

For reference, the old standard runtime reached ready in 30.7 s, with the base backup and WAL in R2 20.7 s later (*measured (EU1)*, OP L372).

**Sleep:** the sleep proof (section 7.9), then `fstrim`. The volume stays mounted.

**Delete:**
1. Stop the unit and unmount.
2. Remove the volume; its chunks return to the pool.
3. Remove the user.

The R2 archive is kept until `deleted_at` + retention and then expired by the Worker, as today.

**Resize:**
- Memory and CPU are live limit changes. An awake database is admitted again, and the PostgreSQL settings apply at its next start.
- Storage grows online (section 3.5).

**Move:** section 9.5.

---

## 6. Reuse, build, delete

### 6.1 Open-source research: verdict

No open-source project does what PGCF needs:
- many isolated PostgreSQL instances per plain-Linux host, without Kubernetes;
- started on connect and stopped when idle;
- WAL and base backups to S3, with PITR;
- a control-plane API.

That holds for Rust and for every other language.

| Project | Verdict | Why |
| --- | --- | --- |
| Neon (Rust, Apache-2.0) | Do not adopt; copy patterns | Needs its own pageserver, safekeepers and storage controller; the control plane is closed; public development nearly stopped (12 commits since 2025-08-01) |
| Xata OSS (Go) | No | Requires Kubernetes, CNPG and OpenEBS: the platform we are leaving |
| DBLab Engine (Go) | No | Docker dev/test clones; no WAL archiving, PITR or wake path |
| Ubicloud (Ruby, AGPL-3.0) | No code; learn the backup and recovery flow | One VM per database (needs KVM); Ruby control plane over SSH |
| Pigsty, Autobase, StackGres | No | One instance per node via Ansible, or a Kubernetes operator |
| Tembo | No | Kubernetes operator; the organisation has 0 public repositories |
| postgresql-common (`pg_ctlcluster`) | No | Sleeps 0.5 s before its first readiness check |
| systemd-socket-proxyd | No | Idle means zero connections; no admission, sleep proof or authority |
| PgDog (AGPL), pgcat (dormant), Supavisor (Elixir) | No | Poolers, not node agents |
| pg_doorman (Rust, MIT) | Fallback only | Only if backend memory on 256 MiB databases becomes a measured problem |
| stratisd | No | Would replace LVM as owner of the most critical state |
| WAL-G (Go), wal-rus (Rust) | Not now | A different bucket layout from the one the API parses; wal-rus is at 0.3.7 with no PostgreSQL 18 cross-tool tests. Revisit if barman's per-segment cost is measured too high (section 7.5) |
| pgBackRest | No | Own layout, one stanza per cluster, maintainer churn in 2026 |

### 6.2 What we adopt

| Part | Version | License | Use |
| --- | --- | --- | --- |
| Debian 13 trixie, kernel 6.12 | Pinned snapshot | DFSG | Node OS |
| systemd | 257 | LGPL-2.1+ | Units, sandbox, cgroups, credentials, first-boot partitioning |
| PGDG PostgreSQL | 18.6 | PostgreSQL | Unmodified server, built with systemd support |
| pgvector | 0.8.7 | PostgreSQL | Extension |
| lvm2, thin-provisioning-tools | 2.03.31, 1.1.0 | GPL-2.0 / LGPL | Thin pool and volumes, run as separate tools |
| barman-cli-cloud | 3.20.1 | GPL-3.0 (separate tool) | WAL archive, base backup, restore, WAL restore |
| cloudflared | 2026.10.0 | Apache-2.0 | Tunnel |
| mkosi | Pinned tag | LGPL-2.1+ (build tool) | Image build |
| Rust crates (D-Bus control of systemd, readiness, PostgreSQL client, read-only device-mapper status) | Pinned in `Cargo.lock` | MIT/Apache-2.0, MPL-2.0 | Agent |

Patterns we copy, without their code:
- Neon `compute_ctl`: readiness without polling.
- TopoLVM: the overprovision rule.
- Neon autoscaling: scale-to-zero carries density.
- Ubicloud: the backup and restore flow.
- Deeplake: admission on a local memory fact.

Everything goes into THIRD_PARTY.md with pinned versions and licences.

### 6.3 Repository: keep (origin/main `4bfbe546`)

- **Clients and Edge:** `apps/edge` (4,887 lines, deployed), `packages/cli` (1,559).
- **API product core:** about 31.9k source lines remain after the deletions.
  - 45 files still name Kubernetes, Talos, relay, sidecar or compute-pool terms and must be adapted.
  - The heaviest are `fleet-releases.ts`, `fleet-rollouts.ts`, `infrastructure-backups.ts`, `storage-capacity.ts`, `startup-admission.ts`, `platform/nodes.ts` and `observations.ts`.
- **Gateway and protocol:** `apps/native-gateway` minus 2,498 lines; `packages/native-protocol` minus `storage.rs` (306) and `reclaim.rs` (213).
- **Contracts:** `packages/contracts`, minus the files in 6.6. The generated native JSON (about 25k lines) is regenerated.

### 6.4 Repository: reuse in the node agent

From `apps/native-controller` (33,712 lines), the parts without Kubernetes:
- `api.rs` 1-466: the Cloudflare client. The key format becomes per node.
- `contracts.rs`, `diagnostics.rs`, `timing.rs`: validation, error classes, wake phase events.
- `postgres.rs` 1-507: role, catalog, dependency and terminate SQL, and the identity query. Dialling becomes the Unix socket.
- `power.rs` 195-219 and 1478-1680: the sleep proof (busy and prepared-transaction guard, WAL switch, archive wait).
- `attach_protocol.rs` 31-34 and 407-449: the PostgreSQL 18 `pg_control` parser. Add the checkpoint location and the checksum check.
- `pool.rs` 57-115: the sleep record. It moves from a Kubernetes annotation to a file plus D1.
- `attach/dm.rs`, parts of `attach/linux.rs` (new mount API, `openat2`), and the single-writer holder rule in `attach/agent.rs`.
- `measurements.rs` (usage deltas and hour splits) and `health.rs` (archive-health judgement).
- `manifests.rs` 128-148: role ordering by membership.
- `test_postgres.rs`: the PostgreSQL wire double for tests.

From `apps/node-bootstrap/src/thin-storage.ts` 537-700: the thin-pool command decision logic (about 100 lines), ported to Rust.

### 6.5 Repository: build new

1. **`apps/node-agent`** (Rust): section 5.6.
2. **`pgcf-archive` and `pgcf-wal-fetch`:** small static Rust clients that PostgreSQL calls and that talk to the agent socket.
3. **Gateway local mode:** section 5.7.
4. **`infra/node-image`:**
   - the mkosi configuration;
   - the package lock: every deb with version and sha256, the Debian snapshot ID and the mkosi tag;
   - units, first-boot partitioning, firewall, sysctl and journald limits;
   - its README, which holds the builder notes of Appendix C.
5. **The pull installer:** a `#cloud-config` script under 32 KiB (section 9.2).
6. **API, D1, contracts and Edge**, in one migration set, without backwards compatibility:
   - per-node agent key, NodeActor, desired page, and a gateway URL behind Access;
   - the new release spec and route token version;
   - locally signed R2 temporary credentials;
   - retention in the Worker;
   - per-database resources;
   - placement by the 80 % rule, filling first;
   - AddNode with pull install and IP-bound enrollment;
   - the move operation, node-loss declaration with fencing, superseded-generation orders and the reinstall guard.
7. **Cloudflare path work:** Lane E (section 10).
8. **CI:** one `node-image` job in the single workflow (section 9.1).

### 6.6 Repository: delete

| What | Lines |
| --- | --- |
| `apps/node-bootstrap` (Talos installer, proofs, fleet patches, thin turns, etcd backup) | 60,855 |
| `apps/regional` (TypeScript agent, gateway, relay) | 37,218 |
| `apps/sandbox-controller` + `apps/node-runtime` (containerd sandbox, compute pool, host guard) | 13,755 |
| `apps/native-bootstrap-relay` | 1,528 |
| `infra/talos`, `infra/platform` (keep only the Rust and CI toolchain lock sections), `infra/storage` | 9,064 |
| API modules (fleet patches, NodeBootstrap DO, bootstrap jobs and relay, thin execution and qualification, node proof, region material, warm reclaim, node inspection and installation, host configuration, compute pool, node operator) | 18,740 src + 26,318 tests |
| Contracts files on the same topics | 8,790 |
| `apps/native-controller`: whole files (Kubernetes client, manifests, fleet, OpenEBS scrape, pool tests, Kubernetes test server) plus the CNPG and pool parts of the remaining files | 11,618 + parts |
| `apps/native-gateway` `targets.rs` + `kubernetes.rs` | 2,498 |
| Talos, relay and network-proof scripts | 8,612 |
| **Total** | **about 202k** of 394,568 non-lockfile lines |

**D1 tables dropped:**
- `fleet_patch_operations`;
- `node_bootstrap_jobs`;
- `node_host_configurations`;
- `node_installation_profiles` and `node_installation_bindings`;
- `node_compute_pool_policies` and `node_compute_pool_observations`;
- `thin_storage_qualification_runs` and `thin_storage_qualification_samples`;
- `region_bootstrap_credentials`, replaced by per-node keys;
- `node_network_preparations` and `node_network_mutations`, which go with the network-proof path.

Columns tied to Kubernetes, the sidecar, the compute pool and warm reclaim are dropped from `nodes`, `regions`, `node_thin_storage`, `node_region_policies`, `databases`, `fleet_node_releases` and `infrastructure_backup_artifacts`.

**Build-order trap.** The Rust contract generators import reference code from directories that are being deleted:
- `generate-power.ts` imports `SLEEP_SQL`, `SLEEP_REFUSALS` and `WAKE_PHASES` from `apps/regional`.
- `generate.ts` and `generate-activity.ts` import frame-budget, activity and telemetry.
- `generate-controller.ts` imports from `infra/platform`.
- The API imports files from `infra/talos`, `infra/platform` and `infra/storage`.

These sources move into `packages/contracts` first (Stage 2, step 1).

---

## 7. Data safety

### 7.1 Guarantees

| Event | Guarantee |
| --- | --- |
| Proven sleep | Every committed transaction is in R2 (section 7.9) |
| PostgreSQL crash, or out-of-memory kill, in one database | Crash recovery from local fsynced WAL; nothing acknowledged is lost; nothing is replayed; other databases are untouched |
| Agent or gateway crash | Databases keep running. A gateway crash drops sessions; clients reconnect |
| Guest crash, reboot or VM reset with the disk intact | No acknowledged commit is lost. At boot the agent recovers and archives every unproven database (section 7.10) |
| Host failure, or node loss with the disk gone | Treated as node loss: restore from R2. Awake databases lose at most `archive_timeout` plus upload time (one measurement: 66.7 s with a 60 s timeout, HAND). Databases with a proven sleep lose nothing. A VM reset cannot show whether the Contabo host honours disk flushes, so the plan claims no more than this |
| Full pool or full volume | Writes fail at once; no commit is acknowledged without durable WAL; new wakes are refused; recovery per section 4.3 |

### 7.2 R2 layout (unchanged)

- **Archive path:** `s3://<bucket>/<region>/<database id>/g<generation>-<op id>/database/`, with server name `database`. It holds:
  - `base/<backup id>/backup.info` and `data.tar.gz`;
  - `wals/<timeline+log>/<segment>.gz`, plus history files under `wals/`.
- **Compression:** gzip for WAL and base backups. Base backups never use zstd, lz4 or snappy: R2 requires equal multipart sizes (error 10048 otherwise), and Barman produces them only with gzip or bzip2.
- **A fresh path every time.** Every generation, restore and move gets a fresh path. This protects against overwrites, because `barman-cloud-wal-archive` overwrites without checking.
- **Parsing.** The Worker's `archive.ts` and `restore-catalog.ts` keep parsing this layout, and the contract's `backup_id` stays a Barman ID.
- **Old archives** written by plugin-barman-cloud are test data and are deleted in Stage 0.

### 7.3 Credentials

The API Worker holds a parent R2 key, new in Stage 0, and **signs temporary credentials locally** (an HS256 JWT, Cloudflare's local-signing method). Only local signing supports an explicit list of S3 actions; the API presets, such as object read-write, include delete ([R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)).

| Purpose | Scope | Lifetime |
| --- | --- | --- |
| WAL and base backups of one database generation | Prefix `<region>/<db>/g<gen>-<op>/`; actions Get, Head, Put, ListObjectsV2 and multipart; **no DeleteObject(s)** | 7 days (plan default; Stage 1 checks that R2 accepts it). Renewed after at most a third of the lifetime; an alert fires when less than 25 % is left |
| Restore source | Read-only on the source prefix | For the operation |

- **No delete rights on nodes.** Nodes never hold a delete right or the bucket-wide key. Retention runs in the Worker (section 7.7).
- **Margin for outages.** The 7-day lifetime leaves days of margin for a Worker, link or renewal outage. If a credential does expire, archiving fails, databases stay awake and WAL grows. The renewal alert fires long before that.
- **Overwrites stay possible.** A credential still allows overwriting objects inside its own generation's prefix. This is accepted, because that prefix belongs to that database and generation only.
- **HeadBucket.** Barman needs HeadBucket only for `--test` and for `barman-cloud-check-wal-archive`, and we use neither. Stage 1 verifies this.

### 7.4 Who runs barman

Every barman job runs as **the database's own Linux user**, never as a shared archive user.
- The agent starts it as a transient systemd job in the backup slice.
- The job has network access and its own memory limit.
- Every other database's paths, and the agent's state, are hidden from it.
- The volume stays mode 0700, with no group access.

Why: a shared user would need read access to every tenant's data, and it would see every concurrent job's credential. With the database's own user:
- a backup reads exactly what that database's PostgreSQL can read;
- a restore writes files PostgreSQL accepts as its own;
- the job's only credential is scoped to that database's own prefix. Even if that database's own user sees the credential, it gains nothing beyond its own archive.

Stage 1 runs the backup test with exactly these users and modes.

### 7.5 WAL archiving

1. PostgreSQL's archiver calls `pgcf-archive %p`, which connects to the agent socket inside the sandbox.
2. The agent identifies the database by the caller's uid. It checks the file name: 24 hex characters, `.history`, `.partial` or `.backup`.
3. It runs `barman-cloud-wal-archive --gzip` as the database's user (7.4). A 16 MiB segment is one synchronous PUT, and R2 answers 200 only once the data is durable.
4. On success, the agent appends the segment to the database's **upload log** and replies OK. The log is fsynced per entry, so it survives agent restarts. PostgreSQL then marks the segment done.
5. Any error, or a 60 s timeout, returns failure, and PostgreSQL retries.
6. Uploads are serial per database. Node-wide concurrency follows from measured memory:
   - concurrent uploads = (backup budget − one base backup or restore) ÷ the measured memory of one upload;
   - the starting point is 2 uploads plus 1 base backup or restore;
   - all limits sit in one place in operator configuration.
7. Metrics: duration, failures and the `.ready` backlog. A sustained backlog raises `database_archive_failing`.

**Cost trigger.** Each call forks Python and boto3 (*estimate*: 50–100 MB and 0.2–0.5 CPU-s per call; Stage 1 measures it). The WAL path switches to a native Rust PUT in the same Barman layout if either holds:
- a call costs more than 0.25 CPU-s or 80 MiB;
- a backlog persists at target density.

Only after that would WAL-G or wal-rus be reconsidered.

### 7.6 Base backups

A base backup runs:
1. at create (before ready), and after every restore, because a new timeline needs its own base backup;
2. when the idle timer fires and a backup is due, before the database sleeps;
3. daily, at a staggered time, for always-warm databases.

"Due" means one of:
- there is no DONE backup on the current timeline;
- the newest backup is older than 24 h and WAL has been written since.

**A database is never woken just to back it up.** A sleeping database does not change, so its last backup plus archived WAL fully describe it.

The job runs as the database's user, with low CPU and IO weight. It runs `barman-cloud-backup --gzip --immediate-checkpoint` over the database's socket, as the backup role. That role has `pg_backup_start`, `pg_backup_stop`, `pg_checkpoint` and `pg_monitor`. A backup counts only when `backup.info` says DONE.

### 7.7 Retention (in the Worker)

The Worker already lists and deletes the R2 prefixes of deleted databases, and it parses `backup.info` (`retained-archives.ts`, `restore-catalog.ts`). It now also applies each database's recovery window:
- after each DONE backup, it deletes base backups older than the window, and the WAL that only those backups needed;
- it never deletes the newest DONE backup, so a database asleep for weeks keeps its last backup.

Nodes never delete anything in R2.

### 7.8 Restore and PITR (into a new database)

1. Cloudflare creates a new ID and path `g1-<op>`, and sends the recovery order: source path, `backup_id`, and an optional `target_time`.
2. The agent creates the user and a volume at least as large as the source. It runs `barman-cloud-restore` as the new database's user, with the read-only credential. The replay counts as an awake database in admission.
3. It writes the recovery settings:
   - a `restore_command` through `pgcf-wal-fetch`, which runs `barman-cloud-wal-restore -p 4` with a spool directory per operation. It never uses the shared default, where two restores could receive each other's WAL;
   - `recovery_target_time`, if this is a PITR;
   - promote at the target, follow the latest timeline, and archive to the new path.
4. Start, replay and promote. Then check that:
   - the database is out of recovery;
   - its `system_identifier` equals that in the source `backup.info`;
   - its timeline is above the backup's.
5. Remove the recovery settings, reset the roles and take the first base backup. The operation succeeds only when that backup is DONE.
6. Delete the spool directory.

If the target lies beyond the archived WAL, the operation fails and the volume is deleted. API errors stay as they are: `archive_expired`, `no_recovery_point`, `archive_unusable`, `name_in_use`, `source_unavailable`, `region_unavailable`, `generation_changed`.

### 7.9 Sleep proof and the proven-sleep record

This keeps the tested `power.rs` proof, and its rule that a lost outcome is never sent again.

1. **Quiesce.** The gateway stops new work and closes idle sessions with WebSocket code 1000, reason "database sleeping".
2. **Guard.** There must be no busy session (section 3.2) and no prepared transaction. Otherwise the sleep is refused with `power_busy`, and the database stays awake and wakeable.
3. **Checkpoint:** `CHECKPOINT`.
4. **Switch.** Persist the "switching" phase, then call `pg_switch_wal()` and record the switched segment S.
5. **Archive proof.** The upload log contains S, and no segment is waiting for archive (no `.ready` file). The wait retries for up to 600 s, then the sleep is refused with `power_archive`; the database stays awake and wakeable.
6. **Guard** again.
7. **Stop** (fast shutdown). The archive socket keeps serving until PostgreSQL exits. *Measured (lab):* stop takes 29.8 / 42.6 ms (p50/p95).
8. **Check `pg_control`:**
   - state "shut down";
   - `system_identifier` and timeline as recorded;
   - the shutdown checkpoint lies after S;
   - every complete segment before the checkpoint's segment is in the upload log, and none is waiting;
   - `postmaster.pid` is gone.

   The checkpoint's own segment holds only what was written after the switch, with clients already locked out: the checkpoint, hint bits and autovacuum work, never a client commit. PostgreSQL 18 enables data checksums by default and therefore writes full-page images; Stage 1 measures where the checkpoint lands.
9. **Record.** Write the **proven-sleep record** (system identifier, timeline, checkpoint location, last archived segment) to a local file and fsync it. Then report the sleep to D1.

Only a database with a matching record is cold and safe. If steps 7–9 fail, the database is **unproven** (7.10).

### 7.10 Unproven databases

A database is **unproven** in any of these cases:
- it has no proven-sleep record;
- `pg_control`'s checkpoint differs from the record;
- a WAL segment is waiting for archive.

That covers a crash, a reboot or a Contabo shutdown that stopped PostgreSQL without a proof. It also covers an OS update while R2 was failing, and a failure in steps 7–9.

- At boot, after any failed or interrupted proof, and after any unexpected stop, the agent looks for unproven databases.
- It starts each one through admission (it counts as awake), lets it archive, and runs the sleep proof at once. No client is involved.
- Databases it cannot admit or archive right now (no capacity, R2 down) are retried in a loop until proven.
- Until then, committed data may exist only on the node. An alert covers a lasting failure.

### 7.11 One writer per database, and fencing

- **On a node:**
  - one unit name per database;
  - PostgreSQL's own `postmaster.pid` interlock (*measured (lab)*: a second postmaster on the same directory was refused);
  - the agent's single serialized loop;
  - the holder rule for mounts: an exclusive holder file, created only while the device is unused.
- **Across nodes:** D1 is the generation authority.
  - A database is served only by the node its current generation names.
  - Each generation has its own archive path and its own scoped credential, so a stale node can never write into a new generation's archive.
  - The Edge never routes to a stale node.
- **Concurrent wakes** of one database coalesce on one ticket and one start.
- **Planned move:** the target starts only after the source's proven sleep (section 9.5).
- **Node loss requires fencing first** (section 9.4).
  - A node is never declared lost from staleness alone.
  - Before any generation moves, its Tunnel and keys are revoked, and it is powered off through the Contabo API.
  - If it comes back, the agent receives "superseded generation" orders and never starts or archives those databases again.
- **Reinstall guard.** The API refuses to reinstall an instance, or to run AddNode in recover mode on it, while any database's current generation on it lacks a proven-sleep record. Only an explicit owner override bypasses this. A reinstall overwrites the disk, and with it any unarchived WAL.

---

## 8. Security and isolation

**No inbound surface:**
- The firewall drops inbound traffic, nothing listens on a public address, and root has no password.
- The Contabo provider firewall shrinks to deny-all inbound. Today it opens TCP 22, 50000, 6443, 50001, 10250 and 4240, and UDP 8472 and 51871.
- All traffic arrives through the outbound Tunnel.
- The CI boot test and an external scan of the public address assert that nothing listens outside loopback.

**Operator shell:**
- `sshd` listens on loopback only.
- The operator reaches it through the node's Tunnel, with Cloudflare Access and short-lived SSH certificates.
- This keeps "no inbound port" and "all traffic through Cloudflare", while giving the fix-until-it-works loop a real shell.
- The Contabo VNC console plus rescue stays the last resort.
- Whether to keep the shell is revisited at the canary.

**Gateway behind Access** (section 5.8): the Edge is the only client that can reach a node's gateway.

**Per-database isolation** on a shared kernel. Each database has:
- its own Linux user;
- no network;
- a read-only system and private `/tmp`, devices and `/dev/shm`;
- seccomp and no capabilities;
- its own memory, CPU, IO and task limits;
- its own filesystem on its own thin volume, mounted 0700;
- zeroed chunks;
- backup jobs under its own user.

These are the kernel features containers use, plus a user per database and no tenant network. The owner must accept shared-kernel isolation explicitly ([D7](#115-decisions-open-for-the-owner)). VM isolation is out of reach on Contabo VPS.

**Tenant privileges:**
- The owner role `app` is not a superuser and has no `CREATEDB`, `CREATEROLE` or `REPLICATION`.
- Replication connections are refused at the gateway.
- supautils (Apache-2.0) is a later option, if tenants need privileged extensions.

**Client authentication:**
- The Edge validates the route.
- The gateway checks the StartupMessage's database and user against the signed token (`28000` on mismatch).
- The client sends its password over the encrypted WebSocket. The gateway logs in with SCRAM-SHA-256 and trusts the server only after checking its signature.
- Passwords are never logged or stored, and are zeroized.
- The CLI uses end-to-end SCRAM.

**Secrets on the node.** The image holds none.
1. The installer writes a seed: node ID, region, API URL, and a one-time enrollment token. The token lives about 30 min and is bound to the image version.
2. **Enrollment is bound to the instance's public IPv4.** The Worker accepts the token only when two things hold:
   - the request's `CF-Connecting-IP` equals the address the Contabo API reports for that instance;
   - the installer's checkpoints for that token have arrived.

   A second enrollment is refused and raises an alert.
3. At first boot the agent generates an Ed25519 node key that never leaves the node. It enrolls with the token and its public key, and the API burns the token.
4. Over the enrolled link, the agent receives the Tunnel token and R2 temporary credentials, stored as encrypted systemd credentials. Without a vTPM this protects only against offline disk reads, not against the hypervisor.
5. The seed is deleted after enrollment.

A reinstall issues a new token, and a lost node's key is revoked.

**Route keys per node.** A node holds only its own derived key, so a compromised node cannot forge tokens for other nodes.

**Integrator keys:**
- Format `pgcf_sk_<12>_<43>`, stored only as an HMAC.
- Scoped to a project: another project's resource answers 404.
- Exercised live in Stage 5.8.

**Kernel security.** Isolation rests on the shared kernel, so kernel fixes reach nodes on a fixed schedule (section 9.3).

**Repository rules.** Never print or commit secrets, `.env*` files, node keys, Tunnel or enrollment tokens, or R2 keys. Never content-search private files.

**Shared Cloudflare account** (owner, 2026-10-15). Separating the account, or auditing its tokens, stays an after-go-live item.

---

## 9. Operations

### 9.1 The node image

**`infra/node-image`:** mkosi builds a Debian 13 disk image from a pinned snapshot and the package lock. It boots with a hybrid BIOS and UEFI GRUB, and carries no documentation and no recommended packages. The exact settings are in Appendix C.

**CI job `node-image`**, in the single workflow:
1. Download the locked packages and check their sha256. They are mirrored in R2 if snapshot.debian.org rate-limits.
2. Build the Rust binaries with the pinned toolchain.
3. Build the image.
4. **Boot test in QEMU** (SeaBIOS, with an extra 40 GiB disk). It asserts that:
   - first boot created the LVM partition, the volume group and the pool;
   - `pgcf-agent check` creates a scratch database on a thin volume and queries it;
   - after the VM reboots, the scratch database wakes again;
   - nothing listens except on loopback.
5. Compress with xz (the rescue system has xz; zstd is not certain), write the sha256 sums, upload to a private R2 prefix `node-images/<version>/`, and register the release in the API.

v1 has no nightly reproducibility build, no A/B slots and no image signing. Integrity comes from sha256 values delivered over authenticated channels: the installer's userData and the agent's link. More is added only after an update has actually broken a node.

### 9.2 Installing a node on Contabo (no relay, no SSH)

Stopping the control server removes the old installer's transport: the bootstrap relay was the only way to reach rescue SSH. The new path is a **pull install**:

1. Order a VPS (`POST /v1/compute/instances`, existing code), or reuse an instance.
2. Call `POST /v1/compute/instances/{id}/actions/rescue` with `userData` set to the pinned `#cloud-config` installer, under 32 KiB. It carries:
   - the image URL (presigned R2 or a Worker route);
   - the compressed and raw sha256 and sizes;
   - the hardware facts to assert;
   - a one-time progress token;
   - the network settings.
3. In the rescue system, the script:
   - checks the hardware (disk, MAC, IPv4, gateway, RAM);
   - downloads the image into RAM and verifies sha256 and sizes;
   - writes the disk, relocates the backup GPT and reads it back;
   - writes the network settings and the enrollment seed;
   - reports each checkpoint over HTTPS;
   - reboots.
4. First boot: partitioning, volume group and pool, enrollment, Tunnel, first samples.
5. Cloudflare checks the inventory and opens placement.

This needs no inbound port, no relay, no SSH key and no operator firewall sources. Stage 1 first checks whether rescue cloud-init runs `runcmd`.

**Fallbacks**, if it does not:
- open rescue SSH, key-only with a pinned host key, for a short window (weaker);
- buy the Contabo Custom Images add-on and reinstall from a qcow2. This is not on the account today and would be a costed decision.

### 9.3 Updates

**Agent, gateway and archive clients:**
1. The release spec names each binary's URL and sha256.
2. The agent downloads the binary to a versioned directory outside `/usr` and checks its sha256.
3. It switches a link and restarts the service.

An agent restart never stops a database. A gateway restart drops client sessions, so the gateway is drained first and clients reconnect.

**OS and PostgreSQL packages: the maintenance cycle.** A new release pins a newer Debian snapshot and package lock. One node at a time, in an announced window:
1. Cloudflare closes placement on the node, and the node holds new wakes with `57P03`.
2. The agent puts every awake database to sleep with the proof, so no running PostgreSQL ever sees replaced binaries.
3. The agent installs exactly the pinned versions with apt.
4. It reboots if the kernel or core libraries changed (*estimate*: 20–60 s).
5. The agent runs its health check and reports.
6. Cloudflare reopens the node. Each database picks up a new PostgreSQL minor version at its next start.

Debian keeps the previous kernel. A bad kernel is recovered from the boot menu over VNC, or with a one-shot GRUB entry.

**Kernel security policy.** Every Debian security advisory that fixes the kernel triggers the maintenance cycle within 7 days (plan default), in an announced window. The owner pre-approves such security reboots ([D10](#115-decisions-open-for-the-owner)). Stage 4 measures the whole cycle.

**PostgreSQL majors.** v1 ships 18 only, and each database's record pins its major version. Adding a major is an image change. Moving to a new major is a restore into a new database.

**Production rule**, from the canary on: reboots need an announced window. Apart from pre-approved security reboots, they also need the owner's go.

### 9.4 Node loss and recovery

1. A node that misses its link for 180 s raises `regional_node_stale`. **Staleness alone never declares a node lost.**
2. The operator declares the node lost (later the API may, under an explicit rule). Fencing comes first, in this order:
   1. Delete the node's Tunnel, and revoke its Tunnel token and node key.
   2. Power it off with the Contabo API (`actions/stop`), and confirm the instance status.
   3. Only then bump each database's generation and restore it from R2 onto another node.
3. IDs follow [D4](#115-decisions-open-for-the-owner). Each database's recovery point is reported.
4. If the old node comes back, its agent receives "superseded generation" orders. It neither starts nor archives those databases, and their volumes are deleted after the operator confirms.
5. The replacement VPS comes from AddNode (a purchase under the costed policy), or from a reinstall of the same instance through 9.2. Either is subject to the reinstall guard (section 7.11).

There is no control server, so there is no control-loss procedure.

### 9.5 Moves

A move is one operation, triggered through the API (admin) or by the operator. One database moves by R2 restore and **keeps its ID**:
1. Proven sleep on the source.
2. D1 bumps the generation, with a new archive path.
3. The target restores from the source's last backup plus WAL, through admission.
4. The target takes its first base backup.
5. D1 switches the route (mutation barrier).
6. The source deletes its volume.

A connect during the move is held, or answered with `57P03`. Stage 5.7 tests a move from one volume to another on EU1 and measures its duration.

- **ID rules:** a customer restore gets a new ID; a platform move keeps the ID; node-loss recovery follows D4.
- **Automatic rebalancing** comes after go-live: Cloudflare then picks the most active databases when a node passes its 80 % rule. Until then, an operator moves databases based on the node rollups.

### 9.6 Regions and naming

- **Nodes** are named by hostname: `eu1`, `eu2`, later `us1`, `us2`.
- **A region** is a Contabo location with its own R2 bucket, purchase policy and placement. The proposal is to rename the region `eu-dev` to `eu` in Stage 2's migration set ([D5](#115-decisions-open-for-the-owner)).
- **One image for every node (owner, 2026-10-17).** EU1, US1 and every later node run the same image release. OS patches, PostgreSQL upgrades and agent releases therefore roll out 1:1 identically across all nodes; there is no per-node or per-region variant, only configuration (region, bucket, keys).
- **EU first, then US1.**
  - EU1 is built and accepted first (Stages 1–5).
  - **TODO once EU1 passes Stage 5:** install US1 from the same image release as EU1. US1 is a new Contabo Cloud VPS Plus 4 (2026), server `pgcf-us1`, bought without setup; its address is in the operator's private configuration. It needs a US region row, its R2 bucket and its purchase policy, and then the same node acceptance as EU1.
  - The previous US1 (contract ends 2026-11-04) was marked lost on 2026-10-11 and powered off on 2026-10-16; its configuration is treated as compromised and is never reused.
  - `ARCHIVE_US` is kept until the old US archives expire.
- **Adding a region** needs no control server: a region row, a bucket, a purchase policy and a node.

### 9.7 Capacity and purchase policy

- Placement follows section 4.8.
- **The purchase signal** fires when no node fits the smallest size, or when every node in the region is closed for placement. AddNode buys only if purchases are enabled.
- Purchases and autoscale stay off through go-live. Enabling them, including EU2, needs the owner's explicit, costed go.
- There are no hard caps. `max_nodes`, and monetary or order-count ceilings, are optional. Fresh installations buy and send nothing.

### 9.8 Alerts

**Engine** (deployed since `699e685`):
- retries at least 60 s apart, with a 5 s deadline;
- the same `event_id` on every retry;
- one episode per region and kind.

`CronWatchdog` raises an alarm on a stopped cron, independently of the cron.

**No delivery destination exists yet.** The owner must provide one of these ([D6](#115-decisions-open-for-the-owner)):
- a webhook: `INFRASTRUCTURE_ALERT_WEBHOOK_URL` and its token;
- `RESEND_API_KEY`, plus a sender on a Resend-verified domain, plus a recipient.

OpenAPI must document email, thresholds and alert status.

**Kinds:**
- capacity (section 4.10);
- `infrastructure_backup_failed` and `infrastructure_backup_stale` (D1 only);
- `database_archive_failing` (input: the upload log and the `.ready` backlog);
- `database_base_backup_stale` (36 h of awake time; sleeping databases excluded);
- `archive_credential_expiring` (new, section 7.3);
- `control_cron_stalled` (300 s) and `control_cron_step_failing` (5 runs).

**Deleted:** the `thin_storage_*` identity-turn codes, the etcd artifact, and the "CNPG ContinuousArchiving" cause.

**Stuck operations.** The existing 20-minute `operation_timeout` stays. A deadline per operation type, with an `operation_stuck` alert, is deferred until after go-live. The exception: if an operation is observed stuck without the existing alerts firing, it is built earlier.

### 9.9 Observability

- **Wake timing events per phase**, so every p95 can be broken down, including capacity waits. The phases: Edge admission, Tunnel, agent admission and wait, mount, start, release, login, and each statement.
- **Usage metrics** as in section 3.4. Sleeping databases emit no samples.
- **Node rollups** (section 4.9) and infrastructure cost per node.
- **Logs** are sampled. Sanitized journal excerpts are available through the agent link and the operator shell. Error codes are never swallowed.

### 9.10 Infrastructure backup

The daily encrypted D1 export stays:
- a `PGCFINF1` envelope with AES-GCM, a key derived from `CREDENTIAL_KEYS`, and offline custody of the key;
- full R2 readback;
- failed and stale alarms;
- a retry after 90 min, at most 3 attempts a day.

Deleted: the etcd part, and the hold that waited while a fleet patch was unfinished.

The nightly export blocks D1 for about 4 s (*measured (EU1)*). Wakes do not depend on D1, so they are unaffected; G6 verifies this.

---

## 10. Delivery stages

Each stage lists its goal, steps, acceptance and scope. AGENTS.md line 21 forbids effort or duration estimates, so "scope" names what is built or removed. Stages 1 and 2 can run in parallel, and the lanes of Stage 3 run in parallel.

### Stage 0: Wind down, rotate, reset the documents

**Goal:** the old stack is stopped and its credentials are dead. Every agent reading the repository sees only this plan.

**Steps:**

1. **The owner stops the EU control server.**
   - EU1's Kubernetes cluster loses its control plane, and its controller, CNPG and gateway stop reconciling.
   - EU1 holds only test data, and placement stays closed.
   - Until Stage 2 deletes the code, failing EU1 turns and stale-node alerts are expected. They have no destination yet.
2. **The old work** is on `archive/kubernetes-runtime` (`6761e7f0`). Done.
3. **Documents.**
   - Done with this plan's commit: this plan replaces `docs/architecture/cloudflare-convergence-and-serverless-plan.md` at the same path; PLAN.md keeps its link and gets a new focus line; AGENTS.md line 7 states the decided runtime; the proposal page `runtime-without-kubernetes.md` is deleted (this plan carries its content).
   - After the owner has read this plan, AGENTS.md is amended further (line numbers as on `4bfbe546`):
     - line 4: the Cloudflare control plane is Workers, D1, Durable Objects, Workflows, R2, Secrets, Tunnel and Access (Containers removed);
     - line 5: "Only PostgreSQL data lives on VPS; nodes execute Cloudflare's desired state and report observations; a node decides only wake admission, early sleep and recovery starts, from local facts under rules Cloudflare sets, and reports each decision.";
     - lines 14 and 17: "Dev" becomes "the EU1 stack";
     - line 19: drop the Talos and kubectl clauses;
     - line 24: "Approved runtime: native Rust for the node agent, the gateway and the archive clients; Rust/Wasm for the Edge Worker (open decision D12).";
     - line 27: replaced by a pointer to this plan and to the `infra/node-image` and `apps/node-agent` READMEs;
     - line 31: add node keys, Tunnel and enrollment tokens, and R2 keys.
   - Delete `docs/architecture/rust-runtime-and-cold-starts.md`, `wake-path-v2-and-scale.md` and `region-controller.md`, and `docs/operations/fleet-patches.md`. They live on the archive branch.
   - Run the pinned mermaider `update`, then `check`.
4. **Credentials.** The control server and EU1 held copies, so treat them as compromised until rotated:
   - create a new R2 parent key for local signing, and store it as a Worker secret;
   - revoke the old bucket-wide R2 keys once no live consumer remains;
   - revoke the region agent keys and relay credentials;
   - delete the old Tunnels, their tokens, and the `eu-dev` gateway DNS hostname;
   - wipe the control VPS disk (reinstall or overwrite) before it is cancelled or reused.
5. **Test leftovers** are removed as data, because the node can no longer execute deletes:
   - the 6 benchmark databases;
   - the hibernated retained database `ee8udfo5zjm2t1rfwogf`;
   - the probe Worker `pgcf-wake-probe-dev` and its integrator key;
   - their R2 archives.

   Their D1 rows, and the US rows, go in Stage 2's migration.
6. **Worktrees and branches.** The 22 leftover worktrees and local branches (all but the archive branch) are deleted, and the local checkout moves to origin/main.
7. **The control VPS contract.** The owner decides ([D8](#115-decisions-open-for-the-owner)).

**Acceptance:**
- The control server is off, and its disk is wiped.
- No R2 key, agent key, relay credential or Tunnel token from before Stage 0 is valid.
- AGENTS.md and PLAN.md point only to this plan, and the deleted documents are gone.
- No customer database, test archive, probe Worker or worktree is left.

**Scope:** operations and documents; no product code.

### Stage 1: Lab on EU1 (stock Debian 13)

**Goal:** measure the facts the build depends on, before building on them.

**Preparation:**
- Reinstall EU1 with Contabo's stock Debian 13 image (test data only).
- SSH by key only, with the root password disabled. Contabo firewall: TCP 22 only from the operator's IP.
- No production secrets on the host. R2 credentials are short-lived and scoped to a prefix. An operator script mints them in memory from the Stage 0 parent key and never prints them.

**Block 1: start path on a thin volume.**
- Setup: PGDG PostgreSQL 18.6, the hardened unit in the database slice, a user per database, a private `/dev/shm`, and a volume group created with a large metadata area.
- 20 runs each, with the volume kept mounted and mounted at wake, with a warm and a cold cache. Record:
  - unit start to ready;
  - the `pg_control` read;
  - SCRAM login;
  - the first SaaS statement.
- Checked in the same runs:
  - PostgreSQL starts with the private `/dev/shm`, runs a parallel vacuum, and leaves nothing behind after kill -9;
  - a per-unit CPU weight inside the slice does not bring back the controller-toggle cost;
  - where the shutdown checkpoint lands after a WAL switch on PostgreSQL 18, for the proof rule in 7.9.
- LVM at scale: create 1,000 thin volumes on a loop-backed pool. Record the metadata area's size and free space, and the create, remove and list latency. This sets the metadata area size for the installer, and the technical volume bound.

**Block 2: backups under the real permission model.**
- Setup: barman jobs run as the database's own user in the backup slice; the volume is 0700, with no group access.
- With locally signed credentials (explicit actions, no delete, one prefix), run:
  - a WAL archive;
  - a gzip base backup above 21 MiB, so that it uses multipart;
  - a restore;
  - `wal-restore -p 4` with a spool directory per operation;
  - a PITR into a fresh volume, as the target's user.

  `system_identifier` and the data digest must match.
- Credential behaviour:
  - DeleteObject is refused;
  - HeadBucket is never needed;
  - a 7-day lifetime is accepted;
  - on expiry, barman fails with a clear exit code, and succeeds again after renewal.
- Measure the memory and CPU of one `wal-archive` call (with an empty and a full segment) and of a base backup, with `/usr/bin/time -v`. This sets the backup concurrency (7.5).
- Time an empty cluster's first base backup (for ready-after-backup, 5.10), and a full sleep proof (the cost of an early sleep, 4.7).

**Block 3: Contabo and Cloudflare facts.**
- First record: the firmware (BIOS or UEFI), the disk size, DHCP or static network, and the rescue tools (xz, sgdisk, curl).
- Then boot rescue once with a harmless reporting script: does rescue cloud-init run `write_files` and `runcmd`? Lane C's installer waits for this answer.
- The Cloudflare path alone:
  - Set up a Tunnel from the lab host to a loopback WebSocket echo.
  - From a Worker, make at least 30 connects, each followed by 5 sequential round trips.
  - Do this through a public hostname with and without Access, and through a Workers VPC binding if the account has one.
  - Record the connect and round-trip p50 and p95.

  Together with release 24's Edge timings, this shows before Stage 5 whether the whole-request gate is reachable.

**Acceptance (targets):**
- Node path p95 ≤ 150 ms with the volume kept mounted. If it misses, analyse before Stage 3 continues on the start path.
- PITR under the real users: identity and digest match.
- Locally signed credentials work end to end, including the delete refusal and expiry.
- The volume bound and the metadata area size are recorded.
- The rescue `runcmd` answer is recorded.
- The Cloudflare path numbers are recorded, and the whole-request budget (3.1) is re-estimated for the owner.
- Every figure is recorded in Done.
- Before Stage 4, the lab's credentials have expired or been revoked. The Stage 4 install overwrites the disk.

**Scope:** lab scripts outside product code; no product change.

### Stage 2: Clean main

**Goal:** main holds only what option C uses, and CI is green. Deleting first gives Stage 3 a clean base and removes the hidden build dependencies.

**Steps:**
1. Move these into `packages/contracts`: `SLEEP_SQL`, `SLEEP_REFUSALS`, `WAKE_PHASES`, the frame-budget, activity, telemetry and measurement constants, and the Rust and CI lock sections.
2. Delete everything in 6.6. Drop the D1 tables and columns in one migration set. The same migration deletes the test and US rows from Stage 0, and renames the region if D5 says so.
3. Remove the obsolete CI jobs and steps:
   - the Talos test client;
   - the Kubernetes manifests;
   - the storage image;
   - the sandbox proof;
   - Talos installer publishing;
   - the CNPG-derived PostgreSQL image.
4. Update THIRD_PARTY.md: remove the Talos, Kubernetes, CNPG, OpenEBS, Cilium, Flux, cert-manager, containerd and Helm notices.
5. Run the pinned mermaider `update`, then `check`.
6. Deploy the API with the remaining product core and migration 0061 (idle time).

**Acceptance:**
- One CI run on main passes every job.
- No source tree contains Talos, Kubernetes, CNPG, OpenEBS or relay code.
- The deleted line count is recorded.
- The deployed API serves the product routes.

**Scope:** about 202k lines removed; contracts reorganised; one D1 migration set.

### Stage 3: Build

**Goal:** everything that sections 4–9 describe exists, passes its tests and is in one release.

Lanes, run in parallel:
- **A, node agent:** section 5.6, tested against real PostgreSQL 18.6 that the test harness starts (no mocks). It includes:
  - admission (4.6);
  - full-pool and full-volume recovery (4.3);
  - the proof and the record (7.9);
  - recovery of unproven databases (7.10);
  - fencing orders (7.11);
  - the health check.
- **B, gateway local mode and archive clients:** sections 5.7 and 7.5.
- **C, image and installer:** section 9.1 with the QEMU boot test, and the pull installer of 9.2, designed on Stage 1's rescue answer.
- **D, API, contracts and Edge:** sections 5.3, 4.8, 4.9, 7.3, 7.7, 3.5, 9.4 and 9.5, plus AddNode and enrollment, with Rust↔TypeScript conformance tests for the shared contracts.
- **E, Cloudflare path:**
  - timing events for every hop (9.9);
  - the transport from the Edge to the node: an Access-protected node hostname, or a Workers VPC binding, chosen by measured connect p95 and round trip;
  - where the Edge runs relative to the node: try the placement options for the Edge Worker and keep only what measures faster;
  - the per-statement overhead in the Edge's WebSocket relay and in HTTP `/sql`;
  - the SaaS benchmark, committed to `scripts/e2e`.

  **Targets:** Cloudflare's own processing at most about 150 ms; connect p95 ≤ 0.25 s; statements 2–5 at most 0.40 s together (3.1).

The builders write the READMEs of `infra/node-image` and `apps/node-agent` from Appendix C, and Appendix C is then removed from this plan.

**Acceptance:**
- CI green, including the QEMU boot test with all its assertions.
- Contract conformance passes.
- One release is registered: node image, binaries, API and Edge.
- Lane E's measurements from a Worker meet its targets, or the remaining gap is reported to the owner with numbers before Stage 5.
- The READMEs replace Appendix C.

**Scope:**
- one new Rust crate and two small Rust clients;
- the image definition and the installer;
- gateway changes and Edge transport changes;
- one API and D1 migration set.

### Stage 4: Install EU1 from the image

**Goal:** EU1 runs the product image, installed by Cloudflare through the programmed path.

**Steps:**
1. AddNode in recover mode, for the existing EU1 instance, runs the pull install.
2. Enrollment, Tunnel, first samples.
3. Set the Contabo firewall to deny-all inbound.
4. Open placement.
5. Update the agent and gateway to a second build. Then run one maintenance cycle that includes a kernel update (9.3).

**Acceptance:**
- The time from rescue to enrolled is recorded.
- Fresh RAM, CPU and pool samples arrive in Cloudflare.
- An external scan finds no open port on the public address.
- A direct request to the node's gateway hostname without Access credentials is refused at Cloudflare.
- The operator shell works through Access.
- The binary update causes no reboot and stops no database.
- The maintenance cycle is measured end to end: close placement, hold wakes, sleep all with proof, update, reboot, health check, reopen.

**Scope:** operations through the API; fixes only.

### Stage 5: Acceptance on EU1

**Goal:** the product works live end to end, and the metric passes. EU1 holds only test data until the canary, so the storage and crash tests run on the real node.

| # | Test | Acceptance (target) |
| --- | --- | --- |
| 5.1 | **Base lifecycle:** create; SQL through Cloudflare; roles (membership, connection limit, `valid_until`, password reset, delete); base backup and WAL; full restore; PITR; resize; delete with reclaim | Ready only after the first base backup is DONE, and create to ready ≤ 30.7 s. Restore returns the same digest. PITR returns the state at the target time, into a new database. Delete removes the volume and returns pool space |
| 5.2 | **Sleep and wake:** idle sleep at 60 s and at a per-database value; an open idle connection and pings do not keep a database awake; wake on connect; manual suspend answers `57P03` until resume; resume pre-wakes, and answers `409 node_capacity` without room; a refused sleep leaves the database wakeable; 20 concurrent connects to one cold database | Exactly one writer; no stuck database |
| 5.3 | **Cold p95** on the 5.6 population: EU1 filled to that density, 5–10 % of databases awake in the background, awake demand below the awake budget. Databases idle ≥ 1 h, some ≥ 24 h. From a Worker and from a laptop; at least 30 cold requests; per-phase timing events | **Whole request p95 < 1 s** (per D1), with every sample counted and capacity waits shown inside. Node path p95 ≤ 150 ms. First answer, warm pass and time to within 25 % of warm reported |
| 5.4 | **Crash and reboot under writes:** kill -9 the postmaster, then the agent, then the gateway; a VM reset through the Contabo API; R2 blocked, then a systemd reboot, then R2 unblocked | Zero lost acknowledged commits. No replayed uncertain write. After each event, every unproven database is recovered, archived and proven again |
| 5.5 | **Storage:** fill the real pool on EU1 with test databases to its reserve, then to full; a tenant fills its own volume; inode exhaustion on one volume | At the reserve: wakes are refused with `57P03` "storage", an alert is raised, and other databases keep running. When full: after space returns, the agent recovers every affected database with the same digest. Own volume and inodes: alerts at 80 % and 90 %, recovery after a resize. Zero lost acknowledged commits. The node's write rate is recorded, and the reserve and write limits are set from it |
| 5.6 | **Overbooking and density:** at least 300 databases (thin, about 45 GiB really written); a synthetic 5–10 % awake pattern for at least 1 h; a 40-database wake storm; one database crash-looping during the storm; 1,000 wake/sleep cycles | The memory rule of D3 holds (under (b), reservations never exceed the budget). No out-of-memory kill outside the database slice; every kill inside it ends in crash recovery with zero lost commits. Queue, early-sleep and `57P03` counts match the design. Agent and gateway never restart. Recorded: memory per awake database by size; kernel memory per mounted volume; volume create and list latency; time from reboot to all volumes mounted; cold first-statement time at this density; caps for the handover |
| 5.7 | **Move:** one database, from one volume to another on EU1, by restore | ID kept; no lost commit; duration recorded. A go-live gate only if EU2 is approved (D9) |
| 5.8 | **Isolation:** (a) write a pattern in database A, delete A, create B, and read B's raw volume in unwritten areas; (b) as the tenant role, try `pg_read_server_files`, `COPY ... TO PROGRAM`, `lo_import`, `ALTER SYSTEM`, and `CREATE EXTENSION` of an untrusted extension; (c) from a process with A's user and sandbox, try B's socket and data, the agent socket as B, the node's keys, and any network socket; (d) use another project's key on A | (a) zeros only; (b) all denied; (c) all denied; (d) 404 |

**Scope:** measurement and fixes only.

### Stage 6: Runbooks and README

**Goal:** the operational documents describe only what runs.

**Steps:**
1. Rewrite the README and these runbooks: `operator-installation`, `recovery` (including fencing, a full pool and a full volume), `credentials`, `infrastructure-backups` and `native-external-probe`.
2. Rewrite `integrator-handover`. Correct its §4.3, which still claims full logical thin reservation, and add every item listed in G11.
3. Run mermaider `update`, then `check`.

**Acceptance:**
- No document describes Kubernetes, Talos, CNPG, the pool or the relay as current.
- CI is green.

**Scope:** documentation only.

### Stage 7: Go-live gates

One row per gate. A gate moves to Done only with its measured result. The canary starts when all other gates are done.

| # | Gate | Finished when |
| --- | --- | --- |
| G1 | Green main | One CI run on main passes every job and publishes the image and the release |
| G2 | Product acceptance | Stages 5.1, 5.2, 5.4, 5.5 and 5.8 pass |
| G3 | Cold metric | Stage 5.3 passes |
| G4 | Density | Stage 5.6 passes; caps recorded |
| G5 | Alerts delivered | The owner gives a destination; one real alarm reaches the named recipient; every kind carries its runbook action |
| G6 | Infrastructure backup | A D1 artifact is decrypted with the offline key and imported into a scratch D1. A night with an awake database under writes, and a wake during the export, shows no failed wake |
| G7 | Control database growth | Sleeping databases emit no samples; raw samples covered by final rollups are pruned |
| G8 | Credential hygiene | Stage 0's rotation is verified; per-node keys only; no node holds a bucket-wide or delete-capable R2 credential |
| G9 | Recovery | The EU1-loss runbook (fencing, AddNode or reinstall, restores, measured duration) is written, with its preconditions checked. The owner has pre-approved a costed replacement order, or EU2 exists |
| G10 | Integrator access and catalog | The owner approves the production catalog (memory, CPU, storage, `max_connections`, `sleep_after_seconds`, `archive_timeout`, `backup_retention_days`). Test classes are disabled. Project isolation is exercised live (5.8) |
| G11 | Handover | It states measured values for: RPO (including host failure as node loss) and the PITR window; ready only after the first backup; cold latency p50 and p95; `57P03` meanings, including early sleep (if D2) and the retry rule; what a sold memory size means under D3; volume-full behaviour; connection limits; outage classes and maintenance windows, including security reboots; IDs after restore, move and node loss; capacity caps. The first integrator confirms in writing |
| G12 | Canary | At least 5 internal databases of the first integrator run for at least 72 h, including two daily backup cycles. Each has a DONE base backup that satisfies the due rule, and continuous WAL. No `53300` refusals. One PITR restore is rebound by the integrator. No acknowledged commit is lost. Then the first integrator creates all new databases on PGCF |

From the canary on, the EU1 stack is production.

---

## 11. Status

### 11.1 Done

| Completed step | Measurement or boundary |
| --- | --- |
| Option C decided (owner, 2026-10-17) | Kubernetes, CNPG, Talos, OpenEBS, slot pool and control server retired; EU1 image and Rust service rebuilt; thin-slice overbooking central |
| Old work archived | `archive/kubernetes-runtime` at `6761e7f0` (= main `4bfbe546` + stall-alerts work in progress) |
| Research for this plan (2026-10-17) | Open source (nothing adoptable), OS image (Debian 13), overbooking model, backups (barman-cloud kept), supervision lab, code inventory (about 202k lines deletable) |
| Supervision lab (laptop, Debian trixie, systemd 257, PostgreSQL 18.6) | Hardened unit start to READY 54.0 / 60.7 ms (p50/p95). First SaaS answer 60.4 / 66.9 ms with a warm cache, 98.5 / 110.3 ms cold. Stop 29.8 / 42.6 ms. 20-database storm ready in 353–375 ms. Kernel memory per mounted volume 0.13–0.55 MiB |
| Baselines from the Kubernetes runtime (reference only) | PostgreSQL 18.6 on EU1 ready in 111–117 ms. ext4 mount on thin 68–120 ms. Release 24 cold first answer p95 1,080 ms, whole request p95 1.50 s. Old standard create to ready 30.7 s |

### 11.2 Open

| Stage | Status | Next step |
| --- | --- | --- |
| 0 Wind down | In progress: the owner is stopping the control server | Documents and AGENTS.md with this plan; credential rotation |
| 1 Lab on EU1 | Open | Reinstall EU1 with stock Debian 13, hardened |
| 2 Clean main | Open | Move the generator sources into contracts |
| 3 Build | Open | Lanes A–E |
| 4 Install EU1 | Open (needs Stage 3) | |
| 5 Acceptance | Open (needs Stage 4) | |
| 6 Docs | Open (needs Stage 5) | |
| 7 Go-live gates | Open; G5 waits for the owner's alert destination | |
| US1 | TODO once EU1 passes Stage 5 | Install `pgcf-us1` from the same image release as EU1 (9.6) |

### 11.3 Owner decisions taken

| Date | Decision |
| --- | --- |
| 2026-10-01 | No mocks, stubs or hardcoded data; acceptance only from real systems |
| 2026-10-02 | Cloudflare is the law; access only through Cloudflare; metrics only; one hostname; delete, don't freeze |
| 2026-10-05 | Rust runtime approved |
| 2026-10-11 | EU only; US cancelled; no effort or duration estimates |
| 2026-10-14 | Sub-second on a real cold wake; don't over-test; parallelize; no separate Dev |
| 2026-10-15 | Go-live approved; no backwards compatibility; PGCF generic; restore and PITR create a new database; PostgreSQL 18; 7-day retention for the first integrator's classes; Cloudflare account stays shared; alert sender later; EU1 loss and maintenance windows later |
| 2026-10-16 | Binding product goal: cold under 1 s; only warm and cold |
| 2026-10-17 | Decision A (remove the guard, simplify bloat). One release per batch; no "R1/R2" names. Per-database idle time 60–900 s. **Option C**, with no control server. Placement until 80 % of the 30-minute-average peak of active RAM or CPU; no count limit; storage, RAM and CPU per database through the admin API; thin-slice overbooking central. One image for every node, so patches and upgrades are identical everywhere; US1 (`pgcf-us1`) follows once EU1 works |

### 11.4 Design decisions taken in this plan

| Decision | Reason |
| --- | --- |
| Debian 13 with PGDG packages | Signed packages of exactly today's PostgreSQL, pgvector and barman versions; Flatcar has no PostgreSQL or Python |
| One image, installed once; binaries updated by download and restart; OS packages through pinned apt in the maintenance cycle | The smallest update path. A/B slots, sysext and reproducibility checks come only after an update breaks a node |
| Zeroed chunks; full-size pool at install | Tenant isolation; no growth machinery |
| Logical cap of 4 × pool, operator-configurable | Bounds the damage of a full pool without limiting the count |
| barman-cloud 3.20.1, with jobs as the database's own user | AGENTS.md line 8; per-tenant permissions and credentials |
| Retention in the Worker | Nodes never hold a delete right |
| Locally signed R2 credentials with a 7-day lifetime | Only local signing excludes delete; days of margin for outages |
| Ready only after the first base backup | A database is never writable before it is restorable |
| systemd never restarts PostgreSQL by itself | Every start goes through admission |
| Fill-first placement | Owner rule |
| No always-warm share cap, no proactive eviction, no PSI guards | Not owner rules; machinery for unobserved problems |
| Moves keep the ID; automatic rebalancing after go-live | A move is a platform operation, not a customer restore; the owner's list includes moves |
| Gateway behind Access; operator shell through Access | All traffic through Cloudflare, no inbound port, and a real shell for fixing |
| `reserved_*` usage metrics dropped | They described Kubernetes requests and the sidecar |
| Old plugin-written archives are disposable | EU1 holds only test data |
| The Edge target is not part of this rework | The deployed Edge is TypeScript; the approved Rust/Wasm target stays until the owner decides D12 |
| Contabo Custom Images not bought | Pull install through rescue; buying becomes a costed decision only if the rescue path fails |

### 11.5 Decisions open for the owner

Each has a plan default. Work proceeds on the default unless the owner says otherwise.

| # | Decision | Plan default |
| --- | --- | --- |
| D1 | What gates go-live: the whole 5-statement request, or the first answer? By estimate, option C reaches a first-answer p95 of about 0.7–0.95 s and a whole-request p95 of about 1.1–1.4 s. The whole-request gate also needs Lane E's Cloudflare work (3.1) | The whole request ("executed"). Both are reported, and the Stage 1 and Lane E numbers go to the owner before Stage 5 |
| D2 | Early sleep: may the node put an idle-but-awake database to sleep before its idle time, but only while another wake waits? | Yes: only with a wake queued, one per waiting wake, never with client activity in the last 30 s, never an always-warm database. Stated in the handover |
| D3 | Awake RAM: admit by (a) measured use, like `actual_ram` on main (more databases awake at once; a rare out-of-memory kill of one backend of another tenant, with no data loss), or by (b) full reservations (256 MB guaranteed while awake; about 37 awake 256 MiB databases per node)? | (a) measured use, matching the owner's "measured active RAM", with the slice limit as backstop |
| D4 | Database ID after node-loss recovery | New IDs, as the handover documents today. Alternative: keep the IDs and report the recovery point |
| D5 | Region and node naming | Region `eu`, renamed from `eu-dev` in Stage 2's migration; nodes `eu1`, `eu2` |
| D6 | Alert destination | Needed from the owner: a webhook, or a Resend key plus a verified sender plus a recipient |
| D7 | Accept shared-kernel isolation through the systemd sandbox | Accept (VMs are impossible on Contabo VPS) |
| D8 | The stopped control VPS | Wipe its disk, then cancel the contract |
| D9 | EU2, for redundancy and a cross-node move test | Not bought until a costed go. Until then 5.7 runs from one volume to another on EU1 and is not a gate |
| D10 | Standing pre-approval for kernel security reboots | Yes: within 7 days of a Debian kernel advisory, in an announced window, one node at a time |
| D11 | Who may set per-database resources | Admin keys only (the owner's "admin API"); integrator keys choose a class |
| D12 | The Rust/Wasm Edge (`apps/edge-rust`): AGENTS.md approves it as the Edge target; it was never deployed, and the old plan's language verdict found no wake gain (OP L488-495) | Keep the approved target; `apps/edge-rust` is not deleted in Stage 2 unless the owner decides otherwise |

---

## 12. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Cloudflare path: the connect tail (182–670 ms) and four statement round trips (0.27–0.46 s) | The whole-request p95 misses even with a fast node | Lane E with its own targets; measured in Stage 1 before the build; numbers go to the owner for D1 |
| Contabo vCPUs start PostgreSQL slower than the lab | Node path above 150 ms | Measured in Stage 1; no CPU quota during start; at most 4 starts at once |
| Cold page cache after days idle, especially at high density | +70–130 ms on the first statement | Volumes stay mounted; 5.3 runs at the 5.6 density; `pg_prewarm` only on an observed miss |
| Awake databases grow together under D3 (a) | An out-of-memory kill of a backend inside the slice; one database's sessions drop | Placement keeps 20 % headroom on measured peaks; per-database ceilings; crash recovery loses nothing; counted in 5.6; switch to (b) if it happens too often |
| Rescue cloud-init does not run `runcmd` | The pull install is impossible | Stage 1 checks this first; fallbacks in 9.2 |
| Firmware or network unknown | The image does not boot | Hybrid BIOS and UEFI image; static network settings; QEMU boot test with SeaBIOS |
| A bad kernel or package update | A node does not come back | One node at a time; previous kernel kept; VNC and rescue |
| LVM metadata area too small for many volumes | Volume creation fails near about 1,000 volumes, and the area cannot be fixed in place | Large metadata area at install; measured in Stage 1; technical volume bound |
| barman too costly per WAL segment at density | Memory pressure in backup jobs; archive backlog | Concurrency set from measured memory; cost trigger to a native PUT (7.5) |
| Thin pool fills (writers during an archive outage, or many writers at once) | Writes fail; affected databases stop until space returns | Logical cap; placement closes at 80 %; reserve from the measured write rate; per-database write limits; alerts; automated recovery; tested on the real pool in 5.5 |
| A tenant fills its own volume or its inodes | That database stops | Per-volume alerts at 80 % and 90 %; reserve release for recovery; resize; tested in 5.5 |
| R2 credential renewal fails | Archiving stops, databases stay awake, WAL grows | 7-day lifetime; renewal after a third; alert at 25 % left |
| Wake storm | Queued wakes and `57P03` | Early sleep (D2); queue; retry rule; counted in the p95 and alerted |
| Rebuilding what CNPG did (roles, crash restart, backups, retention) | Lifecycle bugs | Reuse the tested SQL and sleep proof; real-PostgreSQL tests; live acceptance after every node release |
| Agent bug | Wrong decisions on a node | Units independent of the agent; the kernel enforces the slice; Cloudflare can refuse but never kill; read-only preflight of new binaries |
| Shared-kernel escape | Tenant data exposed | Strict sandbox; a user per database; no network; zeroed chunks; kernel security policy (9.3); isolation tests (5.8) |
| A single node per region | Losing EU1 stops every database | R2 restore with a known RPO; fencing; costed pre-approval or EU2 before the canary (G9) |
| A node declared lost while still running | Split brain: acknowledged writes lost | Fencing before any generation moves; never declared from staleness alone (9.4) |
| D1 single writer under load | Control-plane saturation | Per-minute node rollups; no D1 on the wake path |
| Scope creep back into machinery | Slower delivery, new failure modes | The smallest thing that passes; machinery only for observed problems; delete on sight |

---

## Appendix A: Sources

| Tag | Source |
| --- | --- |
| OP | Old ULTRA plan, `4bfbe546:docs/architecture/cloudflare-convergence-and-serverless-plan.md` (on `archive/kubernetes-runtime`) |
| PROP | `4bfbe546:docs/architecture/runtime-without-kubernetes.md` |
| RRT | `4bfbe546:docs/architecture/rust-runtime-and-cold-starts.md` |
| HAND | `4bfbe546:docs/operations/integrator-handover.md` |
| AG | `4bfbe546:AGENTS.md` |
| OB | Overbooking research 2026-10-17 (node budget and density model) |
| OSI | OS-image research 2026-10-17 (Debian trixie, PGDG and kernel configs; Flatcar Stable 4757.2.1 artifacts; mkosi and systemd v257 manuals) |
| LAB | Supervision lab 2026-10-17 (Debian trixie, systemd 257, PostgreSQL 18.6, cgroup v2, 6 vCPU, laptop) |

Code at `4bfbe546`:
- `apps/api/src/domain/startup-admission.ts` L126-143: `actual_ram` admission.
- `apps/edge/src/gateway.ts` L18-45: the public gateway fetch.
- `apps/api/src/domain/retained-archives.ts` and `restore-catalog.ts`: archive deletion and `backup.info` parsing in the Worker.
- `apps/native-controller/src/manifests.rs` L459-505: the bucket-wide key copied per database.

Key external references:
- Neon: `compute_tools/src/pg_helpers.rs` L331-391, `monitor.rs` L210-330, `proxy/src/control_plane/mod.rs` L164-190; autoscaling README L34-46.
- PostgreSQL REL_18_STABLE: `postmaster.c` L2346-2352 (ready, `sd_notify`), `pg_ctl.c` L73.
- Kernel and system manuals: kernel docs on thin provisioning and cgroup v2; `lvmthin(7)`, `systemd.exec(5)`, `systemd.resource-control(5)`, `org.freedesktop.systemd1(5)`; lvm2 `lib/config/config_settings.h` (`pvmetadatasize`).
- Barman `release/3.20.1`: `cloud.py`, `cloud_walarchive.py`, `cloud_walrestore.py`, `retention_policies.py`.
- R2: [temporary credentials and local signing](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/), [API tokens](https://developers.cloudflare.com/r2/api/tokens/), multipart objects (equal part sizes), durability, consistency.
- Contabo API: instances, rescue, actions. Debian and PGDG package indexes (trixie-pgdg, 2026-10-15).
- TopoLVM thin-volumes proposal L95; wal-rus `docs/DESIGN.md`; WAL-G `docs/PostgreSQL.md` L639-682.

## Appendix B: Glossary

**Storage**
- **Thin pool / thin volume:** LVM storage that hands out real disk in small chunks only when written, so nominal sizes can exceed the disk.
- **Chunk:** the unit a thin pool allocates; 64 KiB here.
- **Pool metadata / spare:** the thin pool's own map of which chunk belongs to which volume. The spare is an equal area kept for repairing it. A full metadata area takes the whole pool offline.
- **LVM metadata area:** a small area on the disk that holds the text description of all volumes. Its size is fixed when the disk is set up.
- **Overbooking (thin slice):** selling more RAM and disk than physically exists, because most databases are asleep and unwritten space costs nothing.
- **`fstrim`:** tells the volume which blocks the filesystem no longer uses, so the thin pool can take those chunks back.

**Memory and processes**
- **cgroup / slice:** Linux resource groups. systemd puts each service in one and enforces memory, CPU and IO limits on it. One slice holds all databases.
- **MemAvailable:** the kernel's estimate of how much memory new work can get without swapping, including reclaimable cache.
- **RSS / Pss:** the memory a process uses. Pss splits shared pages fairly between the processes that share them.
- **Out-of-memory (OOM) kill:** the kernel ends a process when a memory limit is reached.
- **seccomp / system-call filter:** a kernel filter that kills a process when it calls a forbidden system function.
- **Page cache:** file data the kernel keeps in RAM. A warm cache makes the first queries fast.
- **`Type=notify` / `READY=1`:** PostgreSQL tells systemd the exact moment it accepts connections, so nothing has to poll.
- **`SO_PEERCRED`:** the kernel tells one end of a Unix socket the pid and uid of the other end. The gateway uses it to prove which PostgreSQL it reached.

**PostgreSQL**
- **WAL:** PostgreSQL's write-ahead log. A commit is durable once its WAL is fsynced. WAL is written in 16 MiB **segments**: `.ready` marks a segment waiting for archive, and `.done` one that has been archived.
- **LSN:** a position in the WAL.
- **Checkpoint:** PostgreSQL writes all changed data to disk and records the position. A clean shutdown ends with one.
- **`pg_control`:** a small file in every data directory that records the cluster's state ("shut down" or not), last checkpoint, timeline and identity.
- **`system_identifier`:** a number unique to one PostgreSQL cluster. A restore keeps it.
- **Timeline:** a branch of a cluster's WAL history. Each restore that promotes starts a new one.
- **Base backup / PITR:** a base backup is a full copy of the data directory. Together with archived WAL, it allows point-in-time recovery (PITR) to any moment.
- **`archive_timeout`:** forces a WAL segment to be archived after this many seconds. It bounds the data lost if a node's disk is lost, the **RPO** (recovery point objective).
- **`57P03`:** PostgreSQL's "cannot connect now". Clients retry with backoff.

**PGCF concepts**
- **Proven sleep / proven-sleep record:** a sleep for which the agent showed that every committed transaction is in R2. The record is the fsynced note of that proof (section 7.9).
- **Unproven database:** a stopped database without a matching record. The agent recovers it (section 7.10).
- **Generation:** a counter per database in D1. Each placement, restore or move starts a new one, with its own archive path. Only the node named by the current generation may serve the database.
- **Fencing:** making sure a node declared lost can no longer serve or write, by revoking its keys and Tunnel and powering it off.
- **Mutation barrier:** the Edge stops admitting from the old state, D1 commits the change, the node executes it, the new state is published, and admission reopens.
- **Route token / wake ticket:** short-lived signed messages from the Edge to a node's gateway, naming the database, role, generation and target.

**Cloudflare**
- **Durable Object (DO) / D1:** Durable Objects are Cloudflare's single-instance stateful objects, and D1 is its SQL database. D1 is PGCF's authority. DatabaseActor (one per database) and NodeActor (one per node) are Durable Objects.
- **Tunnel (cloudflared):** an outbound-only connection from the node to Cloudflare, so the node needs no open port.
- **Cloudflare Access:** Cloudflare's gate in front of a hostname. Only holders of a valid token get through: here the Edge, and the operator for the shell.
- **Workers VPC:** a Cloudflare binding that lets a Worker reach a private service behind a Tunnel without a public hostname.

**Build**
- **mkosi:** systemd's tool that builds a disk image from pinned packages.

## Appendix C: Builder notes (moves to `infra/node-image/README.md` and `apps/node-agent/README.md` in Stage 3)

**PostgreSQL unit `pgcf-pg@.service`:**
- **Start:** `Type=notify`, `NotifyAccess=main`, `ExecStart=postgres -D /var/lib/pgcf/db/%i/data`.
  - Never `pg_ctl`: it polls every 100 ms and hangs under `Type=notify`.
  - PGDG builds `--with-systemd`, and the postmaster sends `READY=1` when it accepts connections.
- **User:** `User=pgcf-%i`, a fixed uid from a node-local range, created as a normal `/etc/passwd` entry on the writable root. Never `DynamicUser`, because it recycles uids.
- **Slice:** `Slice=pgcf.slice`. Weights and limits on the slice avoid the +20 ms per start and +58 ms per stop caused by toggling the cgroup `cpu` controller in `system.slice` (*measured (lab)*).
- **Mount check:** `AssertPathIsMountPoint=/var/lib/pgcf/db/%i`. With `Condition…`, a start on an unmounted volume "succeeds" with the unit inactive (*measured (lab)*).
- **Stop and restart:** `KillMode=mixed`, `KillSignal=SIGINT`, `TimeoutStopSec=30`, `Restart=no`.
- **Limits:**
  - `MemoryMax` = memory, `MemoryHigh` = 90 %, `MemorySwapMax=0`, `TasksMax=64`;
  - `CPUWeight` by size, and `CPUQuota` set after ready;
  - `IOWriteBandwidthMax` and `IOWriteIOPSMax` by size.
- **OOM:** `OOMPolicy=continue`, `OOMScoreAdjust=-900`, `PG_OOM_ADJUST_FILE=/proc/self/oom_score_adj`, `PG_OOM_ADJUST_VALUE=0` (*measured (lab)*: postmaster -900, children 0).
- **Sandbox:**
  - network: `PrivateNetwork=yes`, `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`;
  - filesystem: `ProtectSystem=strict` with `ReadWritePaths` limited to its data and socket directories; `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `TemporaryFileSystem=/dev/shm:size=<from memory size>`;
  - kernel and processes: `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectControlGroups`, `ProtectProc=invisible`, `ProcSubset=pid`;
  - privileges: `RestrictNamespaces`, `RestrictSUIDSGID`, `NoNewPrivileges`, empty `CapabilityBoundingSet`;
  - system calls and memory: `SystemCallFilter=@system-service ~@privileged ~@resources`, `MemoryDenyWriteExecute=yes` (needs `jit=off`), `UMask=0077`.
- **Not set:**
  - `PrivatePIDs` and `PrivateIPC`: PostgreSQL's `postmaster.pid` interlock needs them off. The lab showed a second unit on the same directory being refused.
  - `unix_socket_group`: PostgreSQL would call chown, which the filter kills with SIGSYS.
- **Applying limits:** persistent `SetUnitProperties` at create and resize; never `daemon-reload`.

**PostgreSQL configuration:**
- `listen_addresses=''`.
- Socket directory `/run/pgcf/<id>`, owned by `pgcf-<id>`, mode 0750, with the gateway's group.
- `recovery_init_sync_method=syncfs`.
- `archive_mode=on`, `archive_command='/usr/libexec/pgcf/pgcf-archive %p'`, and `archive_timeout` from the class.
- `wal_init_zero=off`, `wal_recycle=on`, `min_wal_size=32MB`, and `max_wal_size` = 25 % of the volume.
- `huge_pages=off`, `jit=off`.
- `pg_hba`: tenant roles over the socket with `scram-sha-256`; agent and backup roles by `peer` through a `pg_ident` map.

| Setting | 256 MiB | 1 GiB |
| --- | --- | --- |
| `shared_buffers` | 32 MB (1/8) | 128 MB |
| `effective_cache_size` | 192 MB | 768 MB |
| `work_mem` | 2 MB (`hash_mem_multiplier` 2) | 4 MB |
| `maintenance_work_mem` | 16 MB | 64 MB |
| `max_connections` | From the class (25 suggested) | From the class (50 suggested) |
| `autovacuum_max_workers`, `io_workers` | 1, 1 | Default |
| `max_parallel_workers_per_gather` | 0 | Default |

Worst case for 256 MiB (*estimate*): 32 + 25 × (2 + 4) + 16 + 15 ≈ 215 MiB.

**Storage:**
- **Pool:**
  - `pvcreate --metadatasize 64m`, or the value Stage 1 sets; VG `pgcf`.
  - Thin pool `pgcf/pgcf_thinpool` with `--chunksize 64K --zero y --errorwhenfull y --poolmetadatasize 1G`.
  - Verify zeroing with `lvs -o zero`.
  - About 95 MiB of pool metadata is needed for 128 GiB at 64 KiB chunks (*estimate*).
- **Per database:**
  - a thin LV with virtual size = storage, tagged `pgcf.db.<id>`;
  - `mkfs.ext4 -J size=8 -i 65536 -m 1 -E lazy_itable_init=0,lazy_journal_init=0`;
  - mounted 0700 without `discard`, with `fstrim` after each clean sleep.
- **Full-volume recovery:** `tune2fs -m 0` once, and back to `-m 1` after the next resize or when use drops.
- **Sampling:** commands use `--reportformat json`. Pool status every 5 s (`dmsetup status`, or the read-only `devicemapper` crate). Per-LV `data_percent`, and `df` space and inodes, every 60 s.

**Barman jobs:**
- Started with `systemd-run --uid=pgcf-<id> --slice=pgcf-backup.slice -p MemoryMax=<per job> -p InaccessiblePaths=<other databases, agent state>`.
- Environment: `AWS_SESSION_TOKEN`, `AWS_DEFAULT_REGION=auto`, `--endpoint-url https://<account>.r2.cloudflarestorage.com`, and TMPDIR on node disk.
- Base backup: `barman-cloud-backup --gzip --immediate-checkpoint -J 2 --host /run/pgcf/<db> -U pgcf_backup -d postgres <dest> database`.

**cloudflared:**
- Command: `cloudflared tunnel --no-autoupdate --protocol quic --metrics 127.0.0.1:20241 run --token-file ${CREDENTIALS_DIRECTORY}/tunnel-token`.
- The token comes from `LoadCredentialEncrypted=`; `--token-file` exists since 2025.4.0.
- Ingress goes to the gateway and to `ssh://localhost:22`, both behind Access.

**Image:**
- mkosi settings: `Distribution=debian`, `Release=trixie`, `Snapshot=<fixed snapshot.debian.org time>`, `Format=disk`, `Bootloader=grub`, `BiosBootloader=grub`, `SourceDateEpoch`, `Seed`; no docs and no recommends.
- Partitions: BIOS boot (1 MiB), ESP (512 MiB), and a writable ext4 root of about 8 GiB that includes `/var`. `systemd-repart` adds the LVM partition over the rest of the disk at first boot.
- Binaries live in `/var/lib/pgcf/bin/<version>/`.
- Firewall: nftables drops inbound traffic except established flows and ICMPv6 neighbour discovery.

**Agent crates** (pinned in `Cargo.lock`, listed in THIRD_PARTY.md): `zbus_systemd`, `sd-notify`, `tokio-postgres`, `postgres-protocol`, and `devicemapper` (MPL-2.0, read-only use).
