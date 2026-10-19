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
- **Disk is overbooked by thin volumes.** Each database gets a volume of its sold size, but disk is used only as it is written. An empty database uses about 69 MiB of its volume when it is ready (*measured (EU1)*, Stage 1). So 300 databases sold at 1 GiB each need 300 GiB on paper but about 20 GiB in reality.
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

**What to expect** (section 5.9; the node part measured on EU1 in Stage 1, the rest *estimates*):
- **Node path** (from the wake to PostgreSQL ready and released), volumes kept mounted, warm cache, over all Stage 1 sets (two sessions on EU1, 40 starts per set, p50 / p95): 123–167 / 157–226 ms with the unit as first written for the image; 99–132 / 121–184 ms without its `ExecStartPre=`, which Lane C removes; release 23 measured 469 ms. The 150 ms p95 target is missed by 7–76 ms with the unit as written; without `ExecStartPre=` it is missed by 34 ms in the first session and met in the rerun about 75 minutes later (the same unit ran 36–44 % slower in the first session; cause unknown; 11.1).
- **First answer** of a cold request: p95 of about 0.57–1.1 s (release 24: 1,080 ms).
- **Whole five-statement request:** p95 of about 0.84–1.57 s (release 24: 1.50 s). The four later statements cost 0.27–0.46 s through Cloudflare, whatever the node does (OP L399).
- **So option C alone does not reach the whole-request gate.** Cloudflare-side work is also needed: at today's cost per statement, a connect p95 of about 0.10–0.34 s instead of up to 0.67 s; or cheaper round trips per statement (3.1). That work is Lane E of Stage 3, measured from Stage 1 on. The owner decides which number gates go-live (D1), knowing this.

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
- D12: the Rust/Wasm Edge target;
- D13: decided 2026-10-18 (keep the full sandbox; see 11.3).

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

| Part | Release 24 (*measured (EU1)*) | Option C without Cloudflare work (*Stage 1 re-estimate*) | Budget for a whole request under 1 s (*target*) |
| --- | --- | --- | --- |
| 1. Cloudflare connect: client Worker → Edge (TLS, upgrade, limiters, admission, ticket) → Tunnel → gateway | 182–670 ms (PROP) | unchanged, 182–670 ms | p95 ≤ 250 ms |
| 2. Node path: admission, start, release (partly hidden behind part 1) | 469 ms (release 23) | p95 121–226 ms (*measured (EU1, Stage 1)*, 11.1) | p95 ≤ 150 ms |
| 3. Login and first statement, including a cold cache | about 100–200 ms (implied) | p95 about 20–65 ms (*measured (EU1, Stage 1)*) | p95 ≤ 150 ms |
| **First answer** | p50 693 ms, p95 1,080 ms | p95 about 0.57–1.1 s | p95 ≤ 0.55 s |
| 4. Statements 2–5: four round trips through Cloudflare plus execution | +0.27–0.46 s (releases 23 and 24, first pool hit) | unchanged | ≤ 0.40 s |
| **Whole request** | p50 1.15 s, p95 1.50 s | p95 about 0.84–1.57 s | p95 < 1.0 s |

What this means:
- With today's statement round trips, the whole-request gate needs a first-answer p95 of about 0.55 s.
- Option C alone does not reliably bring the node part (part 2) into budget: Stage 1 measured a p95 of 121–226 ms against 150 ms. Without `ExecStartPre=` the budget was met in the rerun and missed by 34 ms in the first session (11.1).
- The connect tail (part 1) and the statement round trips (part 4) are Cloudflare's. Only Lane E (Stage 3) works on them.
- Service bindings help little. Release 24 measured a p95 of 1,007 ms through a service binding against 1,073 ms public, and bindings work only for Workers on the same Cloudflare account (OP L399).

**Stage 1 re-estimate (2026-10-17, measured parts in 11.1).** Volume kept mounted, the unit as first written for the image (`lane-c/node-image` `7e3375eb`), and the database's own files evicted from the page cache while the binaries every database shares stay cached. p95 values are summed, so they are upper bounds:
- **Node part** (node path, login and first statement, measured end to end on the node): p50 0.22 s, p95 0.32 s in the first session and 0.17 / 0.22 s in the rerun. With the whole page cache dropped (worst case, first session): 0.31 / 0.41 s. Without the unit's `ExecStartPre=` (Appendix C): the committed unit measured 0.14 / 0.18 s in the rerun. The first session measured this case only on the lab unit of the first runs, a different unit (11.1): 0.17 / 0.27 s. The estimates below use the slowest set, 0.32 s.
- **At today's Cloudflare cost per statement:** releases 23 and 24 measured statements 2–5 at +0.27–0.46 s through Cloudflare, so 68–115 ms per round trip including execution. The first answer needs one more such round trip. Whole request at p95: 0.32 + 0.07–0.12 + 0.27–0.46, about **0.66–0.90 s plus the connect**. **The 1 s gate then needs a connect p95 of at most about 0.10–0.34 s** (release 24: 182–670 ms). Without the `ExecStartPre=`: 0.24–0.48 s with the committed unit's rerun figure (0.18 s), 0.15–0.39 s with the lab unit's 0.27 s.
- **Lane E's lower bound:** if a round trip costs only the Tunnel leg (Workers VPC 18 / 28 ms), the five round trips add at most 0.14 s and statements 2–5 execute in 0.03 / 0.09 s on the node: about 0.55 s plus the connect, so the connect p95 could take up to about 0.45 s. The first version of this estimate assumed this lower bound for every statement.
- The Tunnel leg's connect alone measured 74 ms (Workers VPC) and 110 ms (public hostname) at p95. The rest of the connect tail and of each statement's round trip lies in the Edge's own work and in the hop from the client Worker to the Edge: Lane E's work.

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
- **Volume group `pgcf`** on the LVM partition, with a large LVM metadata area so that hundreds of volumes fit. Stage 1 measured that the default area (1,020 KiB) holds 1,000 volumes and would run out near 1,450; the installer uses 64 MiB, enough for about 95,000. The technical bound is 1,000 volumes per node (4.11).
- **One thin pool over the whole partition.** It holds the data, 1 GiB of pool metadata, and an equal spare for repair.
  - EU1's disk is 300 GiB (Stage 1). With the image's 8 GiB root that leaves about 289 GiB of data (*estimate*; the lab pool beside a 40 GiB root held 257.8 GiB).
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
- An empty database uses 68.6 MiB of its volume when it is ready, after its first base backup (*measured (EU1)*, Stage 1).

**Three pool rules.** Thresholds are operator configuration.

| Rule | Data | Metadata | Effect |
| --- | --- | --- | --- |
| Placement closed | Actual use ≥ 80 % (the owner's number), or the logical cap reached | ≥ 50 % | No new database or restore is placed on the node; warning alert |
| No room | Free data below the reserve | ≥ 75 % | Wakes, creates and restores on the node are refused with `57P03` "storage"; critical alert; running databases keep running |
| Full | No free data | — | Writes fail at once; affected databases stop; recovery below |

- **Logical cap** (plan default, from the research). The sum of nominal volume sizes stays at or below 4 × the pool's data size. It bounds how much sold storage a full pool can hurt. On EU1's pool of about 289 GiB that is about 1,150 GiB, or about 1,150 databases of 1 GiB; the technical volume bound (1,000, 4.11) binds first.
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
- **CPU:** a weight proportional to the database's CPU size. There is no quota while PostgreSQL starts, because a quota would stretch the start by up to 4×. The quota of its size is set right after ready, which takes 4.6 ms (*measured (lab)*; on EU1 2.1–3.0 / 3.0–5.3 ms over D-Bus, Stage 1). A quota set this way stays on the unit after it stops and throttles its next start (Stage 1: a 50 % quota slowed the start from 109.6 / 157.3 to 161.2 / 215.1 ms). The agent therefore clears it (`CPUQuota=` infinity) whenever a database's unit stops, and for every stopped unit when the agent itself starts.
- **Out of memory:** the kernel kills a backend, never the postmaster first. PostgreSQL then runs crash recovery for that database only. Acknowledged commits survive, and it is never a node event.
- **No swap and no zswap** in v1. Revisit only on an observed problem.

### 4.5 Node budget: 12 GB, 6 vCPU (EU1: 11,967 MiB visible, Stage 1)

All values are operator configuration. Stage 1 set the backup line; the others remain *estimates* until Stage 5 measures them (OB model).

| Item | MiB | Note |
| --- | --- | --- |
| System: kernel, systemd, journald, sshd, cloudflared, gateway, agent | 768 | Agent and gateway are protected from reclaim. In the Kubernetes era: 1 GiB kubelet reserve plus about 1,041 MiB idle platform |
| Kernel memory of mounted sleeping volumes | 150 | About 0.5 MiB per mounted volume (*measured (lab)*: 0.13–0.55 MiB), so 150 MiB at 300 volumes. Stage 5.6 measures it at scale |
| Backup jobs | 512 | Two WAL uploads (`MemoryMax` 128 MiB each) and one base backup or restore (256 MiB) at once, set from Stage 1's measurements (section 7.5). This line is separate from the awake-database budget only if the backup slice sits outside `pgcf.slice` (Appendix C) |
| Kernel and page-cache floor | 600 | About 5 % |
| **Awake-database budget** (hard limit on all databases together) | **9,937** | 11,967 MiB visible minus the four lines above. Enforced by the kernel on the database slice; admission per D3 |

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
   - (b) reserved: the reservations of awake and starting databases, plus *m* + 8 MiB, stay within the 9,937 MiB budget.
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

An early sleep is a full sleep proof: checkpoint, WAL switch, upload and stop. A waiting wake therefore takes seconds, not milliseconds: Stage 1 measured a full sleep proof at 1.02 / 1.08 s (p50 / p95), most of it the archive wait (11.1). Such wakes miss the one-second target and are counted in the p95.

### 4.8 Placement in Cloudflare

At create, restore and move, a node is **eligible** when all of these hold:
- it is online with fresh samples, and its room rule passes;
- its pool is open for placement (4.3: data below 80 %, metadata below 50 %, below the logical cap);
- **owner rule:** the peaks of the 30-minute averages of active RAM and of CPU load are both below 80 %;
- the database's memory fits the node's maximum;
- the node holds fewer volumes than the technical volume bound (1,000, 4.11).

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

- **Disk.** At about 0.3 GiB written per database (*estimate*), placement closes at about 770 databases (80 % of about 289 GiB). So disk binds well after RAM under (b); under (a) it binds at about 770, before the volume bound.
- **LVM.** Technical volume bound: **1,000 volumes per node**, the largest count Stage 1 measured. At 1,000 volumes lvcreate took 270 / 335 ms (p50 / p95) and a JSON listing 150–186 ms; neither is on the wake path, and the 64 MiB metadata area would hold about 95,000. The bound rises only after a measurement at a higher count. It is a technical placement bound (4.8), not a sales limit.
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
- **API Worker** product core: databases, roles, lifecycle, restore and the restore catalog, archives and retained archives, usage, costs, resource profiles, alerts and cron health, the Contabo provider, API keys, projects, size classes, idempotency, the OpenAPI documents and the CronWatchdog DO.
- **D1** as the authority: placement, generations, routing and desired state. Partial pulls never mean delete.
- **DatabaseActor admission:**
  - `admitWake` reads only Durable Object state.
  - A read runs no statement SQLite counts as a write: the tables of the snapshot and the ticket are created by the write that first needs them, and a read of a table that is not there finds nothing (11.1).
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
| Gateway URL | One per region, reached with a plain public fetch (`apps/edge/src/gateway.ts` L18-45) | One per node, on its own Tunnel, behind Cloudflare Access or a private binding (section 5.8). `nodes.gateway_url` is the node's public hostname, which the API writes when it makes the node's Tunnel; the Edge dials it, and the region's gateway only for a node that has none. Access or the binding is Lane E's and open |
| Route token | v2–v4 carry a Pod target | One new version, v6, carries node and instance (systemd InvocationID); v2–v4 are deleted; v5 wake tickets stay. The route key is derived per node, so a node can verify only its own tokens |
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
| `cloudflared` | Sandboxed system user | One remotely managed Tunnel per node, carrying the gateway on loopback and, once Access exists, the operator shell (section 8) |
| `pgcf-gateway` | Own user | Today's native gateway in local mode (section 5.7) |
| `pgcf-agent` | root (LVM, mounts, systemd) | The only local actor (section 5.6) |
| `pgcf-pg@<id>` | `pgcf-<id>`, a fixed uid per database | One PostgreSQL per database (section 5.5) |
| barman-cloud jobs | `pgcf-<id>` of the database they serve | Started by the agent in the backup slice (section 7.4) |
| `sshd` | root | Bound to loopback only; reachable only through the Tunnel with Cloudflare Access, and not at all while the shell hostname is off (section 8) |

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
9. **Metrics and diagnostics:** usage deltas (existing arithmetic), archive lag, pool %, after every reboot the sanitized tail of the previous boot's journal, and, when an administrator asks, one of eight read-only probes (section 9.9).
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
  - One self-hosted application, `pgcf node gateways`, covers the wildcard `pgcf-node-*.<domain>` with one Service Auth policy that names the Edge's token and nothing else. A request without credentials gets 401, never a login page. `scripts/operations/setup-access.ts` makes and checks it and puts a rotated secret into the Edge Worker's secrets (`docs/operations/operator-installation.md`). The token lasts 8760h and rotation does not move that date: `--refresh-service-token` does, and the script warns 30 days before and refuses an expired token, because Access would then refuse the Edge at every gateway.
  - The shell's hostname is `pgcf-shell-<id>.<domain>`, a family of its own: Cloudflare does not say which of two overlapping wildcard applications wins, so the two wildcards must not overlap.
- **Alternative:** a private Worker-to-Tunnel binding (Cloudflare's Workers VPC). If the account has it and it measures at least as fast, Lane E uses it instead, and the public hostname goes away.
- **Check:** Stage 4 verifies that a direct request to the node hostname without Access credentials is refused at Cloudflare (`setup-access.ts --verify`: only 401 or 403 pass).

### 5.9 A cold wake, step by step

| # | Step | Basis | Value |
| --- | --- | --- | --- |
| 1 | The client Worker opens the WebSocket. The Edge runs both limiters and `admitWake` from DO state, signs a v5 wake ticket and opens the gateway socket through the node's Tunnel | *measured (EU1)*, release 24 "Cloudflare connect"; unchanged by option C; Lane E works on it | 182–670 ms |
| 2 | The gateway verifies the token, checks the replay cache and queues the wake with the agent **before** answering the upgrade. It holds the StartupMessage and the pipelined password | *estimate* | 0.1–0.5 ms |
| 3 | The agent applies the room and memory rules, checks that the volume exists and is not suspect, and reads `pg_control` with its checksum: state "shut down", identity and checkpoint against the proven-sleep record. The volume checks run no process: a yes comes from the last `lvs` list and the kernel (device node, ext4 error count); anything else is read from lvm2 | *estimate* 1–5 ms; *measured (EU1, 2026-10-18)* 99–208 ms, p50 about 140, while each check ran `lvs`; *measured (lab, branch `wake-node-path`)* the two checks 65 ms before and 0.03 ms after with one volume, 217 ms before and 0.02 ms after with 1,000 (11.1) | 1–5 ms |
| 4 | Mount, only if not mounted | Kept mounted: 0; at wake: *measured (EU1, Stage 1)* 96–122 / 117–165 ms (p50 / p95) | 0 or 96–165 ms |
| 5 | Start the unit until PostgreSQL reports ready | *measured (lab)* 54.0 / 60.7 ms (p50/p95); *measured (EU1, Stage 1)*, unit as first written for the image: 167.3 / 225.7 ms warm and 168.9 / 244.6 ms with the database's files cold in the first session, 122.5 / 156.9 and 132.2 / 170.2 ms in the rerun; the committed unit without its `ExecStartPre=` 99.3 / 121.2 and 103.5 / 125.0 ms warm in the rerun (the lab unit of the first runs, a different unit: 122.7 / 146.8 ms warm in the first session) | 99–245 ms |
| 6 | Release to the gateway with uid and main PID; peer check | *estimate* | < 1 ms |
| 7 | Unix dial, forward the held startup, SCRAM login | *measured (lab)* 4.3 / 5.0 ms; *measured (EU1, Stage 1, libpq over the socket)* 17.2 / 37.2 ms warm, 25.3 / 38.5 ms with the database's files cold | 17–39 ms |
| 8 | First SaaS statement | *measured (EU1, Stage 1, 509 MB dataset)*: 5.0 / 11.1 ms warm, 21.4 / 25.1 ms with the database's files cold, 29.5 / 37.6 ms with the whole page cache dropped (the Kubernetes runtime measured 88–149 ms cold) | 5–38 ms |
| 9 | Answer back to the client Worker | *measured (EU1)*: the Tunnel leg alone 18 / 28 ms (Stage 1); a whole round trip through the Edge 68–115 ms (releases 23 and 24) | 20–115 ms |
| 10 | After the answer, off the path: D1 claim, observation, usage, CPU quota | — | 0 ms |
| 11 | Statements 2–5, each one round trip through Cloudflare | *measured (EU1)*, releases 23 and 24 | +0.27–0.46 s |

- **Node path (steps 2–6):** *estimate* 85–155 ms with volumes kept mounted, 155–275 ms when mounting at wake. Release 23 measured 469 ms. *Target:* p95 ≤ 150 ms with volumes kept mounted. *Measured (EU1, Stage 1, no CPU quota, first session):* with the unit as first written for the image 167.5 / 226.4 ms kept mounted with a warm cache, 169.5 / 271.3 ms with the database's files cold, 253.2 / 351.3 ms with the whole page cache dropped, and 286.9 / 366.7 ms mounting at wake (warm). The lab unit of the first runs, a different unit (11.1), measured 123.0 / 152.7 ms kept mounted, warm. *Rerun about 75 minutes later, kept mounted, warm:* the unit as written 122.7 / 157.1 ms, the committed unit without its `ExecStartPre=` 99.5 / 121.4 and 103.7 / 125.2 ms, the lab unit 99.1 / 114.9 ms. The first session's interleaved set measured the committed unit without its `ExecStartPre=` at 132.4 / 184.0 ms start to READY. The target is missed by 7–76 ms with the unit as written; without `ExecStartPre=` it is missed by 34 ms in the first session and met in the rerun; the analysis is in 11.1.
- **First answer:** *estimate (Stage 1)* p95 about 0.57–1.1 s: release 24's connect, the node part measured in Stage 1, and one round trip through Cloudflare (3.1).
- **Whole request:** *estimate (Stage 1)* p95 about 0.84–1.57 s with today's Cloudflare path (section 3.1).
- **Overlap:** the wake starts before the upgrade is answered. This hides about one Worker-to-gateway round trip of the node path.
- **Redelivery:** a wake the agent has not answered is delivered again after 3 s. The agent answers a delivery of a wake it already serves with `wake_in_progress`, which is not a result: the held connections keep waiting for the first delivery's answer, and every other refusal ends them with 57P03.

**What still decides the p95** is not the node:
- **The Cloudflare path:** the connect tail (up to 670 ms) and the four later round trips. Lane E works on both.
- **A cold page cache** for a database idle for days. Stage 1 measured +16 / +14 ms on the first statement and +2 / +45 ms on the node path (p50 / p95, the database's files evicted, 509 MB dataset); the Kubernetes runtime saw 70–130 ms more on the first statement.
  - Volumes stay mounted while asleep, so a stopped database's files stay cached until the memory is needed. Only an unmount drops them (*measured (lab)*: a 64.3 MB table stayed fully cached after stop; unmounting dropped it to 0).
  - Under memory pressure, that cache goes first.
  - If a measured p95 misses because of it, the next step is `pg_prewarm` with `autoprewarm` (Neon found the same). This is added only on that observed problem.

### 5.10 Create, sleep, delete, resize, move

**Create:**
1. Cloudflare places the database (section 4.8) and writes the desired state.
2. The agent creates the user, the volume and the filesystem, mounts it, runs `initdb` and writes the configuration.
3. It checks that the database's R2 prefix is empty, and refuses otherwise.
4. It starts PostgreSQL through admission, applies the roles and takes the first base backup.
5. It reports **ready only when that backup is DONE**; only then does the Edge route traffic. WAL without a base backup cannot be restored, so a database is never writable before it is restorable. An empty cluster's first base backup took 7.35 s, and create to ready 9.4 s (Stage 1).

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
  - The heaviest are `fleet-releases.ts`, `infrastructure-backups.ts`, `storage-capacity.ts`, `startup-admission.ts`, `platform/nodes.ts` and `observations.ts`.
  - `fleet-rollouts.ts` is not kept: it was built on fleet patches and goes with them (Stage 2, agreed deviation 5).
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

From `apps/node-bootstrap/src/thin-storage.ts` 537-700: the thin-pool command decision logic (about 100 lines), ported to Rust. Stage 2 deletes `apps/node-bootstrap`, so the source is `archive/kubernetes-runtime@6761e7f0:apps/node-bootstrap/src/thin-storage.ts`; the port drops pool growth (4.12).

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
- `node_network_preparations`, `node_network_mutations` and `node_network_firewalls`, which go with the network-proof path;
- `infrastructure_backup_deferrals`, the backup hold of thin starts.

Columns tied to Kubernetes, the sidecar, the compute pool, warm reclaim, thin turns and fleet patches are dropped:
- `nodes.warm_reclaim_qualification_json`; `regions.bootstrap_material_revision` and `bootstrap_material_provenance_sha256`;
- `node_region_policies.compute_pool_json` and `thin_storage_json`; `databases.warm_reclaim_policy_json`;
- `fleet_releases.thin_continuity` and `thin_sampling_version`; `fleet_region_releases.rollout_json` with its index `fleet_region_rollout`, so stored rollout intents are gone;
- `infrastructure_backup_artifacts.node_id`, `node_uid`, `cluster_uid` and `material_revision`;
- `node_thin_storage` is rebuilt without the relay address, cluster, custody material, host lease, pool turns and qualification.

`fleet_node_releases.role` (`control_relay` or `customer`) stays with the release spec until Stage 3 replaces it.

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
| WAL and base backups of one database generation | Prefix `<region>/<db>/g<gen>-<op>/`; actions Get, Head, Put, ListObjectsV2 and multipart; **no DeleteObject(s)** | 7 days (plan default; R2 accepts it, Stage 1). Renewed after at most a third of the lifetime; an alert fires when less than 25 % is left |
| Restore source | Read-only on the source prefix | For the operation |

- **No delete rights on nodes.** Nodes never hold a delete right or the bucket-wide key. Retention runs in the Worker (section 7.7).
- **Margin for outages.** The 7-day lifetime leaves days of margin for a Worker, link or renewal outage. If a credential does expire, archiving fails, databases stay awake and WAL grows. The renewal alert fires long before that.
- **Overwrites stay possible.** A credential still allows overwriting objects inside its own generation's prefix. This is accepted, because that prefix belongs to that database and generation only.
- **HeadBucket.** Barman needs HeadBucket only for `--test` and for `barman-cloud-check-wal-archive`, and we use neither. Stage 1 verified this: WAL archive, base backup, restore and WAL restore all ran with credentials that cannot call HeadBucket.

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

Stage 1 ran the backup test with exactly these users and modes (Block 2, 11.1).

### 7.5 WAL archiving

1. PostgreSQL's archiver calls `pgcf-archive %p`, which connects to the agent socket inside the sandbox.
2. The agent identifies the database by the caller's uid. It checks the file name: 24 hex characters, `.history`, `.partial` or `.backup`.
3. It runs `barman-cloud-wal-archive --gzip` as the database's user (7.4). A 16 MiB segment is one synchronous PUT, and R2 answers 200 only once the data is durable.
4. On success, the agent appends the segment to the database's **upload log** and replies OK. The log is fsynced per entry, so it survives agent restarts. PostgreSQL then marks the segment done.
5. Any error, or a 60 s timeout, returns failure, and PostgreSQL retries.
6. Uploads are serial per database. Node-wide limits, set from Stage 1's measurements (11.1):
   - per-job `MemoryMax`: **128 MiB for a WAL upload** (cgroup peak at most 75.7 MiB over 107 calls); **128 MiB for a WAL fetch** with `wal-restore -p 4` (peak at most 117.6 MiB over 83 calls); **256 MiB for a base backup or restore**. A base backup or restore holds only 63–72 MiB of process memory, but its file reads and writes fill any limit with reclaimable page cache (both reached the lab's 400 MiB limit), so that limit caps cache, not need (*estimate*: gzip, not IO, bounds a base backup, so the smaller cache does not slow it; Stage 5 confirms the duration);
   - concurrency = (backup budget 512 MiB − one base backup or restore 256 MiB) ÷ one upload 128 MiB = **2 uploads plus 1 base backup or restore** at once. A WAL fetch takes a WAL slot like an upload, so the busiest mix is 2 × the larger of the two limits plus the base backup, and the fetch limit stays at 128 MiB to keep it at 512 MiB, the `MemoryMax` of the backup slice. A restore's WAL fetches run one at a time inside its own slot;
   - all limits sit in one place in operator configuration. The native WAL PUT of the cost trigger below sets the upload limit again from its own measurement.
7. Metrics: duration, failures and the `.ready` backlog. A sustained backlog raises `database_archive_failing`.

**Cost trigger.** Each call forks Python and boto3 (*measured (EU1, Stage 1)*: 61–71 MiB RSS and 0.45–1.04 CPU-s per call). The WAL path switches to a native Rust PUT in the same Barman layout if either holds:
- a call costs more than 0.25 CPU-s or 80 MiB;
- a backlog persists at target density.

Stage 1 measured more than 0.25 CPU-s for every call, so the first condition holds.

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

The job runs as the database's user, with low CPU and IO weight. It runs `barman-cloud-backup --gzip --immediate-checkpoint` over the database's socket, as the backup role. That role has `pg_backup_start`, `pg_backup_stop`, `pg_switch_wal`, `pg_create_restore_point`, `pg_checkpoint` and `pg_monitor`; barman checks all of them before it finishes a backup (Stage 1). A backup counts only when `backup.info` says DONE.

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
   - `max_worker_processes = 8` and `max_wal_senders = 10` until the settings are removed: a recovery with hot standby aborts when these are below the values of its source's control file and WAL (checked against PostgreSQL 18.6), and a small database runs fewer (Appendix C);
   - `hot_standby = off` until promotion: a target class with a lower `max_connections` than the source otherwise aborts recovery (Stage 1). Not written yet: hot standby stays on, because the restore's start and `Rebuild::promoted` rely on it (11.2 Stage 5, found while testing);
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

   The checkpoint's own segment holds only what was written after the switch, with clients already locked out: the checkpoint, hint bits and autovacuum work, never a client commit. PostgreSQL 18 enables data checksums by default and therefore writes full-page images. Stage 1 found the shutdown checkpoint in segment S+1: as its first record when idle, or after 334 `FPI_FOR_HINT` records when reads set hint bits after the switch (11.1).
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
  - Before any generation moves, its Tunnel is deleted and its Tunnel token revoked, its node key is restricted to the fenced scope (section 9.4), and it is powered off through the Contabo API.
  - If it comes back, the agent receives its `fence` and "superseded generation" orders and never starts or archives those databases again.
- **Reinstall guard.** The API refuses to reinstall an instance, or to run AddNode in recover mode on it, while any database's current generation on it lacks a proven-sleep record. Only an explicit owner override bypasses this. A reinstall overwrites the disk, and with it any unarchived WAL.

---

## 8. Security and isolation

**No inbound surface:**
- The firewall drops inbound traffic, nothing listens on a public address, and root has no password.
- Every node sits behind one Contabo firewall with no inbound rule, created once by the operator (`CONTABO_NODE_FIREWALL_ID`, `docs/operations/operator-installation.md`). The install is when it matters: the rescue system runs `sshd` on the public port 22, Contabo's merged cloud-config sets `ssh_pwauth: true` and a root password, and the rescue receives the operator's keys (`CONTABO_ORDER_SSH_KEY_IDS`), until the installer turns password login off (11.1, Stage 1 Block 3). AddNode therefore requests no rescue until the firewall is confirmed (9.2). The Kubernetes-era firewall that opened TCP 22, 50000, 6443, 50001, 10250 and 4240 and UDP 8472 and 51871 is retired with the Kubernetes runtime.
- All traffic arrives through the outbound Tunnel.
- The CI boot test and an external scan of the public address assert that nothing listens outside loopback.
- A Dev install or reinstall checks that an external TCP connect to port 22 of the public IPv4 address times out during the rescue and after the reboot.

**Operator shell:**
- `sshd` listens on loopback only.
- It takes a user certificate for root and nothing else (no password, no `authorized_keys`): the CA public key is `/etc/ssh/pgcf_user_ca.pub`, which the public image does not ship, so no login is possible until a CA key is written there (nothing writes one yet, 11.2). The principal is `pgcf-break-glass`; two tries, no forwarding, an empty revocation list.
- No other socket reaches it: systemd 257's ssh generator, which would bind sshd to a Unix socket any local user can connect to and to vsock, is masked and off on the kernel command line.
- The operator reaches it through the node's Tunnel, with Cloudflare Access and short-lived SSH certificates. Which CA signs them (Access's or one the operator holds) and how its principal maps to `pgcf-break-glass` is open (11.2, Stage 4).
- A second self-hosted application, `pgcf node shells`, covers `pgcf-shell-*.<domain>` with one policy: it allows the named operator emails through the one-time PIN identity provider when the organization has one (without it the policy names no login method and the script says so), with a session of one hour. `setup-access.ts --shell` makes it, and the native client is `cloudflared access ssh`. The browser-rendered SSH application type is not used.
- The shell hostname (`pgcf-shell-<id>.<domain>`) is off until that application exists: without Access, anyone who can run cloudflared could reach it. The API makes the hostname, its DNS record and the Tunnel's ingress rule only while the Worker variable `NODE_SHELL_HOSTNAME` is `"true"` (default off), and its next credentials call for a node removes a record and rule the node already has. Create the application first, then set the variable; turn the variable off before the application goes.
- The shell was called `<gateway label>-ssh` before 2026-10-18, a name inside the gateways' wildcard. The credentials call deletes a DNS record under that name whatever the variable says.
- This keeps "no inbound port" and "all traffic through Cloudflare", while giving the fix-until-it-works loop a real shell.
- The Contabo VNC console plus rescue stays the last resort.
- Whether to keep the shell is revisited at the canary.

**Gateway behind Access** (section 5.8): the Edge is the only client that can reach a node's gateway.

**Per-database isolation** on a shared kernel. Each database has:
- its own Linux user;
- no network;
- a read-only system and private `/tmp`, devices and `/dev/shm` (no code, no setuid file, no device node in it);
- seccomp without io_uring, userfaultfd, the kernel keyring, the message queues and the SysV semaphores, and no capabilities;
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

A reinstall issues a new token, and a lost node's key is restricted to the fenced scope (section 9.4).

**Route keys per node.** A node holds only its own derived key, so a compromised node cannot forge tokens for other nodes.

**Integrator keys:**
- Format `pgcf_sk_<12>_<43>`, stored only as an HMAC.
- Scoped to a project: another project's resource answers 404.
- Exercised live in Stage 5.8.

**Kernel security.** Isolation rests on the shared kernel, so kernel fixes reach nodes on a fixed schedule (section 9.3). The image also shrinks what a database's user can ask of that kernel: `kernel.io_uring_disabled = 2`, `dev.tty.ldisc_autoload = 0`, and `/var/lib/pgcf/db` at 0711, so that directory cannot be listed. A database's ID stays readable to every database's user elsewhere: the account name `pgcf-<id>` in `/etc/passwd` and `/etc/group`, the `/run/pgcf/<id>` directories under the 0755 `/run/pgcf`, and the mount table in `/proc/self/mountinfo`; the mode does not hide it.

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
   - nothing listens except on loopback, and no ssh socket exists;
   - the kernel surface, the database unit's system-call filter and the certificate-only sshd are as sections 5.5 and 8 and Appendix C describe;
   - the journal syncs every 15 s.
5. Compress with zstd (Stage 1: the Contabo rescue system has zstd and gzip but no `xz` binary), and write the sha256 sums and `pgcf-node.json` (with the digests of the four binaries baked into the image). Then it collects the files a registration takes (the compressed image, `pgcf-node.json`, `packages.lock.json`, the four binaries and their sums, never the raw image) and runs the registration script's `--dry-run` on them; on a push to `main` of this repository (not of a fork) it keeps them for 7 days as the workflow artifact `pgcf-node-release-<commit sha>-<run attempt>`. The job holds no R2 or API credential, so it uploads nothing to R2 and registers nothing; the operator does (below).

**Registering a release.** `scripts/operations/register-node-image.ts` takes a build's output and the binaries it was built with:
- It checks that the compressed image, the package lock and the four binaries are the ones `pgcf-node.json` describes (a node installed from the image runs the binaries baked into it, so the release must pin those and no others), and uploads the six files (image, `packages.lock.json`, the four binaries) to `node-images/<version>/` in the archive bucket, each with `x-amz-checksum-sha256`, so R2 verifies the digest. A file already there with the same content and the sha256 R2 reports for it is skipped; one with the same size and md5 that R2 holds no sha256 for is sent again, because the API refuses a file without it; one that differs is refused, because a release is never overwritten.
- It then calls `PUT /v1/fleet/releases/<version>` with the digest and size of each file. The API accepts the registration only when the bucket holds every file at that size with that sha256, and names every URL of the stored spec itself: `/node/v1/releases/<version>/<file>` on its own origin. The spec is immutable, the same for every node and every region, and the version is also the image version a node enrolls as. The script parses the answer as the whole stored release and fails unless it is this version and pins the registered digests.
- `PUT /v1/regions/<region>/release` then makes the region's nodes pull that release; it is also the release AddNode installs.
- The Worker streams the files from its R2 binding (HEAD, `Range`). The image needs the install's progress token; the binaries and the lock are open artifacts that the agent reads without a credential and checks against the size and sha256 its signed page pins.

v1 has no nightly reproducibility build, no A/B slots and no image signing. Integrity comes from sha256 values delivered over authenticated channels: the installer's userData and the agent's link. More is added only after an update has actually broken a node.

### 9.2 Installing a node on Contabo (no relay, no SSH)

Stopping the control server removes the old installer's transport: the bootstrap relay was the only way to reach rescue SSH. The new path is a **pull install**:

1. Order a VPS (`POST /v1/compute/instances`, existing code), or reuse an instance.
2. Call `POST /v1/compute/instances/{id}/actions/rescue` with `userData` set to the pinned `#cloud-config` installer, under 32 KiB. It carries:
   - the image URL, the Worker's route `/node/v1/releases/<version>/pgcf-node.raw.zst`, which streams the image from R2 to the installer when it carries the install's progress token in a header (no presigned URL and no bucket key is ever in the userData, and the installer refuses a URL with a query);
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

**Before step 2** AddNode confirms the node firewall (section 8). The rescue system's `sshd` is reachable on the public port 22 until the installer turns password login off, so the instance must sit behind the firewall first. AddNode reads the firewall, requires status `active` and no inbound rule that accepts traffic (a rule that drops admits nothing), assigns the instance if the firewall does not list it, reads the firewall back and requires the instance in its `instances` with the status `ok` in its `instanceStatus` (an instance that is listed and still `processing` is waited for, not assigned again). Otherwise it requests no rescue and issues no tokens, records `node_firewall_unconfirmed` as the addition's `install_blocker`, and asks again on the next cycle: Contabo applies an assignment on its own time, so the read right after it may not list the instance yet. The operator creates the firewall once; the owner assigns EU1 to it by hand. AddNode never unassigns: an addition that is cancelled or fails after the assignment leaves the instance on the firewall, and the operator unassigns an adopted server by hand if it should be reachable again.

This needs no inbound port, no relay, no SSH key and no operator firewall sources; an empty inbound rule set keeps it working, because the installer and the Tunnel only connect outward (Stage 1 measured outbound HTTPS and the Tunnel's QUIC while a Contabo firewall admitted only TCP 22). Stage 1 confirmed that rescue cloud-init runs `write_files` and `runcmd`. Contabo merges its own cloud-config, which turns SSH password login on, so the installer turns it off.

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
1. Cloudflare closes placement on the node (`POST /v1/nodes/{id}/maintenance`, below), and the node holds new wakes with `57P03`.
2. The agent puts every awake database to sleep with the proof, so no running PostgreSQL ever sees replaced binaries.
3. The agent installs exactly the pinned versions with apt. When nothing needs a reboot it then purges the installed packages the lock no longer names (`dpkg --purge`; never a kernel image, an essential or protected package or a name that is not a package name, and nothing for a lock that names no kernel image), so that the node holds the lock's packages and its hello says the release's digest.
4. It reboots if the kernel or core libraries changed (*measured (EU1, 2026-10-19)*: about 13 s from the last shutdown line to the new boot and 31 s to the agent's start; 67 s for the whole cycle). The reboot comes straight after the install, before anything that can fail: the agent runs the cycle again for the order that is still open once it is up, finds nothing to install, and purges there. A purge that dpkg refuses fails the order (`packages_not_installed`) on the new kernel.
5. The agent runs its health check and reports.
6. Cloudflare reopens the node when the agent's result is `done`, unless an operator closed placement in the meantime. Each database picks up a new PostgreSQL minor version at its next start.

**The route.** `POST /v1/nodes/{id}/maintenance` (admin scope, required `Idempotency-Key`, body `{expected_node_uid}`) runs steps 1 to 6 on one node and answers 202 with the operation; `GET /v1/nodes/{id}/maintenance/{operation}` returns `open`, `done` or `failed` with `result_reason` and the times `placement_closed_at`, `created_at` and `closed_at`. One D1 batch sets `nodes.database_placement_closed_at` if it is null and inserts one open `maintenance` order (`lifecycle_orders`) that remembers in `placement_closed_at` the close time it wrote, or null if placement was closed already; then the node is hinted to pull its page. While an order is open, every request answers that operation. The route is refused with 409 for a lost or fenced node and for a node whose reported release is not the release of its region: the cycle installs the packages of the release with the agent the node runs, so the binaries converge first. When the node reports the order `done`, the batch that ends the order reopens placement only if `database_placement_closed_at` still equals the order's `placement_closed_at`; a placement an operator closed before or during the cycle stays closed. The node holds its wakes until it pulls a whole page without the order, so the API hints the node, with no ids, as soon as it records the result that ends the order, rather than leaving the node to its next full pull (at most 60 s). After `failed`, placement stays closed and the node serves wakes again; the next cycle takes over the closure the failed one left, so that its `done` reopens it. The runbook is in [docs/operations/recovery.md](../operations/recovery.md#node-maintenance-cycle).

Debian keeps the previous kernel. A bad kernel is recovered from the boot menu over VNC, or with a one-shot GRUB entry.

**Read-back (SEC-03).** A node has no shell to look at, so its hello reports its boot ID and boot time, its kernel (`uname -r`) and the sha256 of its installed packages (the lines `name=version\n` of every package dpkg lists as `ii`, sorted as lines; of the kernel images only the running one counts, because the previous kernel stays installed). The agent computes the digest when it starts and after a maintenance cycle that did not reboot. A release states the kernel and the digest of its lock (`packages` and `extra`), and `GET /v1/nodes/{id}` shows `os` and `os_converged`: true when the node's kernel and packages are its region's release's, false after a cycle that did not reach it or when its packages drifted, null while it has not reported or its region has no release.

**Kernel security policy.** Every Debian security advisory that fixes the kernel triggers the maintenance cycle within 7 days (plan default), in an announced window. The owner pre-approves such security reboots ([D10](#115-decisions-open-for-the-owner)). Stage 4 measures the whole cycle.

**PostgreSQL majors.** v1 ships 18 only, and each database's record pins its major version. Adding a major is an image change. Moving to a new major is a restore into a new database.

**Production rule**, from the canary on: reboots need an announced window. Apart from pre-approved security reboots, they also need the owner's go.

### 9.4 Node loss and recovery

1. A node that misses its link for 180 s raises `regional_node_stale`. **Staleness alone never declares a node lost.**
2. The operator declares the node lost (later the API may, under an explicit rule). Fencing comes first, in this order:
   1. Delete the node's Tunnel, revoke its Tunnel token, and restrict its node key to the fenced scope: the key still signs `GET /node/v1/desired` and `POST /node/v1/observations` and nothing else, so it can fetch no credential and join no link. Every other signed request is answered `403 {"error":"node_fenced"}`, which the agent treats as a fence.
   2. Power it off with the Contabo API (`actions/stop`), and confirm the instance status.
   3. Only then bump each database's generation and restore it from R2 onto another node.
3. IDs follow [D4](#115-decisions-open-for-the-owner). Each database's recovery point is reported.
4. If the old node comes back, its desired page holds a `fence` order and the "superseded generation" orders, and no database. The agent writes them to disk (fsync) before it acts, never lifts one because it left the page, and checks them before any recovery start at boot. It neither starts nor archives those databases, and their volumes are deleted after the operator confirms (`remove_volume`). A fence ends only with a reinstall, which is a new install with a new key.
5. The replacement VPS comes from AddNode (a purchase under the costed policy), or from a reinstall of the same instance through 9.2. Either is subject to the reinstall guard (section 7.11).

There is no control server, so there is no control-loss procedure.

### 9.5 Moves

A move is one operation, triggered through the API (admin) or by the operator. One database moves by R2 restore and **keeps its ID**:
1. Proven sleep on the source. The source holds its wakes until the move ends.
2. D1 checks that R2 holds the backup and the WAL through the proof, and that the target is still eligible (section 4.8). It then stages the next generation with a new archive path. The database stays what D1 says it is, served by the source.
3. The target restores from the source's last backup plus WAL, through admission. The move order carries the source's proven-sleep record (`end`). The target lets recovery end only after every segment through the record's last archived segment was fetched and replayed, and reports `ready` only after it promoted a database with the record's `system_identifier` on a later timeline. Otherwise it reports an error such as `no_recovery_point`, the move fails and the source serves again; a target on another node is told to remove what it staged.
4. The target takes its first base backup.
5. D1 switches the database to the target with the staged generation (mutation barrier).
6. The source retires its generation and deletes its volume.

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

- **Wake timing events per phase**, so every p95 can be broken down, including capacity waits. The phases: Edge admission, Tunnel, agent admission and wait, mount, start, roles, release, login, and each statement. About 2 s after the release of every wake that started the unit the agent adds one `wake_detail` event with the split of the start (systemd's job to the fork of the main process, the fork to the handoff to postgres, which is the executor's sandbox, and the handoff to PostgreSQL's three start messages), the CPU quota's throttling and the stolen CPU time (11.1).
- **Usage metrics** as in section 3.4. Sleeping databases emit no samples.
- **Node rollups** (section 4.9) and infrastructure cost per node.
- **Boot report (SEC-05).** The node has no shell, so a node that stopped answering could not say why. After every reboot (the kernel's boot ID differs from the one the agent stored in `agent/boot-id`) the agent posts the last 1,000 lines of the previous boot's journal from `pgcf-agent`, `pgcf-gateway`, `pgcf-cloudflared`, `systemd-networkd`, PID 1 and the kernel to `POST /node/v1/diagnostics`. Each line keeps its time, unit, program, transport, priority and text (at most 2,048 bytes); an event line of `pgcf-agent` keeps what the observation report keeps of an event (never error text, a path or an address), and any other line, such as a panic, is kept as written; the lines of a database's unit (`pgcf-pg@…`) and of a backup job (`pgcf-job-…`, whose lines in PID 1's name carry the job's whole command line) are never reported, the oldest lines go when the body passes 1 MiB, and the agent stores the new boot ID only after Cloudflare answered. A post that Cloudflare could not take (the network, 408, 429, 5xx) is repeated within the boot, waiting 2 s and doubling to 60 s, and at the next start if the agent stopped first; any other refusal ends the attempt for that start. A report that reaches the API before the hello of its boot is stored is refused with 503 (`capacity_exhausted`, reason `not_ready`) and sent again, because the verdict reads the sample that hello stores as the end of the previous boot. The API keeps the report for 30 days (`node_diagnostics`), and `GET /v1/nodes/{id}/diagnostics` shows it to an administrator only. The API keeps one report per boot of a node: a report sent again, because its answer was lost, is answered with the stored one. `expected_reboot` is true when a maintenance order of the node was open when its last sample of the previous boot arrived, or closed after it; otherwise it is false and the alert `node_unexpected_reboot` stands for 24 h. An agent that stored no boot (just installed or updated) claims no reboot: `expected_reboot` is null and nothing is raised.
- **Probes on request (SEC-09).** The sshd of section 8 has no CA and its hostname is off, so an administrator reads a node through the link, with no shell and no port. `POST /v1/nodes/{id}/diagnostics` (admin key; any other key is told 404) names one of eight probes and `boot` (0 or -1), `since_seconds` (60 to 86400) and `lines` (1 to 2000), answers `202 {diagnostic_id}`, stores the request with the id of the key that made it in `node_diagnostic_requests`, and hints the node to pull its page. The desired page carries the open requests as `diagnostics` (at most 8, the oldest first, unanswered and younger than 10 minutes; left out when there are none, and on the first page of a full pull only, so the pull of named databases that a wake makes costs no query more). The agent runs each once, in the background. The argv of each probe is built by one pure function from the probe and the three integers, which it checks (an integer out of range is refused, never clamped, and nothing else of a request reaches a command line); it is run through the `Machine` trait with no shell, `LC_ALL=C`, nothing on stdin and 30 s to end: `journal` is the boot report's `journalctl` with `--boot=<b>`, `--since=-<s>s` and `--lines=<n>`; `kernel` is `journalctl --no-pager --output=json -k --boot=<b> --lines=<n>`; `boots` is `journalctl --list-boots --no-pager`; `failed_units` is `systemctl --failed --no-legend --plain`; `sockets` is `systemctl list-sockets --all --no-legend --plain`; `listeners` is `ss --listening --numeric --tcp --udp --unix --no-header`; `pool` is `lvs --reportformat json -o lv_name,lv_attr,data_percent,metadata_percent pgcf/pgcf_thinpool`; `pressure` reads `/proc/pressure/{cpu,memory,io}`, `/proc/meminfo`, `/proc/loadavg` and the total CPU line of `/proc/stat`. The result (`NodeProbeResult`, `kind` probe, posted to `POST /node/v1/diagnostics`) holds `entries` for `journal` and `kernel`, reduced as the boot report's are (no line of a `pgcf-pg@` or `pgcf-job-` unit, nor PID 1's about them), and `text` for the rest, from which every line that names such a unit is left out. It is at most 1 MiB: the oldest entries go first, or the end of the text, marked `[truncated]`. `status` is `failed` with the exit status and the output when a command ends with a status other than 0, cannot be run or does not end; of `journal` and `kernel` the output is stderr only, because the lines they printed before they failed are whole journal fields that the sanitizer has not reduced. After Cloudflare took the result the agent remembers the identifier (the last 64, in `agent/probes-done`), so a page that still lists the request does not run it again; a result that did not arrive runs again with the next page. `GET /v1/nodes/{id}/diagnostics/{diagnostic_id}` says `requested`, `received` with the `body`, or `expired` (10 minutes without a result; a result that comes later is still kept). A request and its result older than 30 days are deleted by the next request for a probe, of any node: the minute cron has no statement to spare (its test holds it to 850).
- **Logs** are sampled. Sanitized journal excerpts are available through the agent link (the boot report and the probes) and the operator shell: the agent's log lines travel in the observation report as events (at most 64 a report, each a name, a database and fields that are numbers or short tokens, never error text, a path or an address), and the API writes each as a `node_event` line to Workers Logs and stores nothing. Delivery is at least once: a report whose answer was lost is sent again, so a query that counts events (the p95 of a wake) counts identical lines once. Events leave without waiting for an observation: a node whose databases do not change sends them in a report of their own (no database, no order), at most one such report a second. The gateway adds one event per connection that waited for a wake, `conn_stages` (the outcome, how the wait ended and the milliseconds of `upgrade_ms`, `startup_ms`, `dial_ms`, `first_backend_ms`, `wake_wait_ms` and `session_ms`), stamped when that connection ends; the wait a client sees for a cold wake is its `wake_wait_ms` (upgrade to release), followed by `dial_ms` and `first_backend_ms` (the login), while `startup_ms` is how long the client took to send its startup message. Error codes are never swallowed.

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
   - Done in Stage 2: after the owner had read this plan, AGENTS.md was amended further (line numbers as on `4bfbe546`):
     - line 4: the Cloudflare control plane is Workers, D1, Durable Objects, Workflows, R2, Secrets, Tunnel and Access (Containers removed);
     - line 5: "Only PostgreSQL data lives on VPS; nodes execute Cloudflare's desired state and report observations; a node decides only wake admission, early sleep and recovery starts, from local facts under rules Cloudflare sets, and reports each decision.";
     - lines 14 and 17: "Dev" becomes "the EU1 stack";
     - line 19: drop the Talos and kubectl clauses;
     - line 24: "Approved runtime: native Rust for the node agent, the gateway and the archive clients; Rust/Wasm for the Edge Worker (open decision D12).";
     - line 27: replaced by a pointer to this plan and to the `infra/node-image` and `apps/node-agent` READMEs;
     - line 31: add node keys, Tunnel and enrollment tokens, and R2 keys.
   - Done in Stage 2: delete `docs/architecture/rust-runtime-and-cold-starts.md`, `wake-path-v2-and-scale.md` and `region-controller.md`, and `docs/operations/fleet-patches.md`. They live on the archive branch.
   - Done in Stage 2: run the pinned mermaider `update`, then `check`.
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
1. Move these into `packages/contracts`: `SLEEP_SQL`, `SLEEP_REFUSALS`, `WAKE_PHASES`, and the frame-budget, activity, telemetry and measurement constants. The Rust and CI lock sections stay in `infra/platform/versions.lock.json` (6.6), where CI reads them.
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

**Agreed deviations (2026-10-17):**
1. `apps/native-gateway` keeps `targets.rs` and `kubernetes.rs` until the gateway local mode replaces them (Stage 3, lane B); the gateway builds as it is.
2. The reusable parts of `apps/native-controller` (6.4) moved into the library crate `apps/node-agent`, with their unit tests and no binary yet; the rest of the controller is deleted.
3. The region rename (D5) waits.
4. Migration `0062` drops the tables and columns of 6.6 and deletes no rows; the test and US rows stay for a later migration.
5. The fleet rollout module (`fleet-rollouts.ts` in the API and in contracts, the `fleet_rollouts` cron step, `POST /v1/fleet/rollouts` and `GET /v1/fleet/rollouts/{id}`) is deleted although 6.3 listed it as kept: it was built on fleet patches and bootstrap jobs. A release reaches nodes by assignment per region (`/v1/regions/{id}/release`) or per node (`/v1/nodes/{id}/release`) until Stage 3 decides on rollouts.

**Done with the deletion:**
- The daily D1 backup runs inside the API Worker's `InfrastructureBackup` Workflow: it reads the signed export twice, streams it through AES-256-GCM into R2 multipart parts and reads the whole object back (needs `nodejs_compat`). The etcd artifact and the thin-start deferral are gone.
- Route token v3 and admission snapshots require every current member of the region to be assigned to the region's release; fleet patches and fleet rollouts no longer exist (agreed deviation 5).
- The contract generators emit only what the Rust crates read. The measurement checkpoint cases recorded from the TypeScript agent are a node-agent test fixture.
- AddNode stops at `audited`. The Talos checkpoint, network and capacity proofs and the `ready` write are gone; `NodeAddition` still parses their stored columns until Stage 3's pull installer defines its own stages.
- `thin_pool_growth_exhausted` and the pool growth rule are gone (4.10); the alert actions say the pool does not grow.

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
1. AddNode in recover mode, for the existing EU1 instance, runs the pull install. EU1 is assigned to the node firewall by hand before (section 8); AddNode requests no rescue until the firewall lists it.
2. Enrollment, Tunnel, first samples.
3. From outside, try TCP port 22 of the public IPv4 address during the rescue and after the reboot: both time out.
4. Open placement.
5. Update the agent and gateway to a second build. Then run one maintenance cycle that includes a kernel update (9.3).

**Acceptance:**
- The time from rescue to enrolled is recorded.
- Fresh RAM, CPU and pool samples arrive in Cloudflare.
- An external scan finds no open port on the public address.
- A direct request to the node's gateway hostname without Access credentials is refused at Cloudflare.
- The operator shell works through Access. This needs the Zero Trust organization (it exists since 2026-10-18), `setup-access.ts --shell` and then `NODE_SHELL_HOSTNAME` set to `"true"`; until then the shell hostname is off (section 8).
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
| Stage 1 preparation: EU1 on stock Debian 13 (2026-10-17) | EU1's Contabo instance (`pgcf-eu1`, product V160; the D1 node row's provider instance) confirmed through the API, reinstalled from image `debian-13`: lab key only, root password locked, `PasswordAuthentication no`; nftables drops all inbound traffic except TCP 22 from the operator and IPv6 neighbour discovery; a lab Contabo firewall allows only TCP 22 from the operator (the Kubernetes-era firewall is detached, not deleted). SSH answered 65 s after the reinstall call. Contabo's merged cloud-config upgrades all packages (kernel 6.12.38 → 6.12.113) and its own `bootcmd` fails harmlessly; nftables needs `--force-confold` when `/etc/nftables.conf` is written first. Root shrunk to 40 GiB in rescue for a 259.9 GiB LVM partition. Versions: systemd 257.13, lvm2 2.03.31, thin-provisioning-tools 1.1.0, PGDG PostgreSQL 18.6-1.pgdg13+2, pgvector 0.8.7, barman-cli-cloud 3.20.1, boto3 1.37.9 |
| Stage 1 Block 3: Contabo facts | Firmware **BIOS** (no `/sys/firmware/efi`); disk 300 GiB (322,122,547,200 B); network **static** (cloud-init NoCloud: IPv4 /23 with gateway, IPv6 /64 via `fe80::1`; the installed image uses netplan and networkd; the rescue's extra DHCP stanza got no offer in 162 s); 6 vCPU AMD EPYC family 23 model 1 (Zen 1) with software retbleed and SRSO mitigations; 11,967 MiB RAM visible. Rescue system: Debian 12, kernel 6.1, cloud-init 22.4.2, 11,960 MiB RAM; sgdisk, sfdisk, wipefs, partprobe, curl, wget, gzip, zstd, sha256sum and python3 (with `lzma`) present, **no `xz` binary** |
| Stage 1 Block 3: rescue cloud-init | **Yes:** rescue cloud-init runs our `write_files` and `runcmd` (two rescue boots; `runcmd` ran 1 min 53 s after the API call; SSH answered after 1 min 47–49 s; HTTPS out works). Contabo merges its own cloud-config into `userData`: its `runcmd` entries run first, and it sets `ssh_pwauth: true` and a root password through `chpasswd` even when only SSH keys are given, so the installer turns password login off itself |
| Stage 1 Block 3: Cloudflare path (temporary Tunnel, VPC service and Worker, deleted afterwards) | cloudflared 2026.10.0 (sha256 checked) runs a remotely managed Tunnel with `--token-file` over QUIC, 4 connections in FRA. The probe Worker ran in AMS: 3 × 30 WebSocket connects to a loopback echo, each with 5 sequential round trips (p50 / p95). **Workers VPC binding** (available on the account; the WebSocket upgrade works): connect 52.5 / 73.6 ms, round trip 18.0 / 28.0 ms, connect plus 5 round trips 146 / 195 ms. **Public hostname without Access** (a TryCloudflare quick tunnel, because the account token has no DNS permission): connect 65.0 / 109.6 ms, round trip 17.0 / 26.0 ms, connect plus 5 round trips 160 / 219 ms. Plain HTTP through the VPC binding: 46 ms per request. **With Access: not measured**: the account has no Zero Trust organization and the token no Access permission (API error 9999) |
| Stage 1 Block 1: start path (256 MiB class, 509 MB SaaS dataset, start over D-Bus as the agent will; 40 runs each; p50 / p95 ms; no CPU quota on the unit or the slice, `cpu.max` read in every run) | **The unit as first written for the image** (`pgcf-pg@.service` on `lane-c/node-image` `7e3375eb`), kept mounted, warm cache: `pg_control` read with CRC 0.2 / 0.6, start to READY 167.3 / 225.7, **node path 167.5 / 226.4**, SCRAM login (libpq over the socket) 17.2 / 37.2, first SaaS statement 5.0 / 11.1, first answer 185.4 / 283.1, statements 2–5 21.4 / 70.6. Kept mounted, only the database's own files evicted (fadvise; the shared binaries stay cached): **node path 169.5 / 271.3**, login 25.3 / 38.5, first statement 21.4 / 25.1, first answer 216.8 / 322.0. Kept mounted, whole page cache dropped (`drop_caches`): node path 253.2 / 351.3, login 30.2 / 38.5, first statement 29.5 / 37.6, first answer 314.4 / 414.8. Mounted at wake: mount 100.9 / 163.8 (warm) and 111.3 / 151.8 (cold); node path 286.9 / 366.7 and 342.5 / 422.6. Fast stop 56.3–66.2 / 82.9–101.9. **The lab unit of the first runs**, in the same session, is a different unit and not the committed unit without its `ExecStartPre=`: it also lacks `CPUWeight=100`, `RemoveIPC=yes`, `After=var-lib-pgcf-db-%i.mount` and the `-c` arguments of `ExecStart=`, and it has `DefaultDependencies=no` with `Conflicts=` and `Before=shutdown.target`. Its node path was 123.0 / 152.7 warm, 126.7 / 212.3 with the database's files evicted, 198.6 / 318.8 with the whole cache dropped, 231.3 / 288.9 and 324.9 / 387.0 mounted at wake; login 18.5 / 29.4 warm. With the whole cache dropped, the node reads the binaries from disk and the sets vary widely. **The node-path target (p95 ≤ 150 ms kept mounted, warm) is missed in the first session:** by 76 ms with the unit as written and by 3 ms with the lab unit; the committed unit without its `ExecStartPre=` was measured only in the interleaved set of the next rows, where it misses by 34 ms. **Rerun about 75 minutes later** (same session for all units, 40 starts per set, kept mounted, warm cache, start over D-Bus, `cpu.max` unlimited in every run): the unit as written 122.7 / 157.1 (7 ms over); the committed unit without its `ExecStartPre=` 99.5 / 121.4 and, repeated at the end of the session, 103.7 / 125.2 (both under); the lab unit 99.1 / 114.9. With the database's files evicted: node path 132.7 / 171.6, 104.7 / 142.3 and 100.2 / 122.3, first answer 167.9 / 217.4, 138.4 / 183.0 and 130.8 / 156.1 in the same order. The unit as written ran 36 % (p50) to 44 % (p95) slower in the first session than in the rerun; the cause is not known, so the remaining miss without `ExecStartPre=` is stated as a range: 34 ms over to 29 ms under at p95 |
| Stage 1 Block 1: CPU quota left over in the first runs | The first 40-run D-Bus sets ran under a 50 % `CPUQuota` that the live-property test had left as a runtime drop-in (`/run/systemd/system.control/<unit>.d/50-CPUQuota.conf`): the stopped unit kept `CPUQuotaPerSecUSec=500ms`, and at its next start `cpu.max` read `50000 100000`. Those sets are replaced by the runs above. Same lab unit, warm cache, with and without the quota: node path 122.6 / 174.7 and 123.0 / 152.7, login 12.9 / 67.8 and 18.5 / 29.4. Two 20-start sets of the same script: 161.2 / 215.1 with the quota set after each start, 109.6 / 157.3 without. **A quota set with `SetUnitProperties` persists after the stop and throttles the next start**, so the agent clears it at every stop (4.4) |
| Stage 1 Block 1: start-path analysis (no CPU quota) | Variants of the unit as first written for the image, D-Bus start until READY, interleaved, warm cache, 40 starts each (first session; p50 / p95 ms): as written 167.2 / 198.7; without `ExecStartPre=` 132.4 / 184.0; without the per-unit `CPUWeight` 168.1 / 257.0 (no cost at p50; one 654 ms outlier); without `ExecStartPre=` and `ProtectKernel*`/`ProtectControlGroups` 118.2 / 181.2; without `ExecStartPre=` and any mount or network namespace 85.3 / 153.6; the lab unit (a different unit, see the start-path row) 126.3 / 183.9. **The `ExecStartPre=` costs about 35 ms at p50** (one more process spawned through systemd's executor: "Starting" to PostgreSQL's first log line took 124–165 ms, against 65–76 ms for the lab unit), and the mount and network namespaces about 47 / 30 ms (p50 / p95). **Rerun about 75 minutes later** (as written, without `ExecStartPre=` and the lab unit again, plus two new variants, without `ExecStartPre=` and without or with `CPUWeight=50`; the variants without `ProtectKernel*` and without any namespace were not rerun; 2 sets of 40 rounds in rotated order so that no variant always starts first; p50 / p95 over both sets): as written 130.3 / 170.5; without `ExecStartPre=` 104.4 / 133.0 (the two sets 102.6 / 124.4 and 104.5 / 143.6); without `ExecStartPre=` and the per-unit `CPUWeight` 104.6 / 139.2; without `ExecStartPre=` and with `CPUWeight=50` 103.4 / 126.6; the lab unit 101.8 / 135.1. The `ExecStartPre=` cost 26 ms at p50 there. Exec-only units (`/bin/sleep`, p50, 30 each): plain 36.3–40.4 ms, with the lab sandbox 90.4–91.1 ms; alone, the mount options add 40 ms (`ProtectKernel*` with `ProtectControlGroups` alone 41 ms in a second set), the network namespace 20 ms, the IP filter 1.5 ms and the seccomp options 4 ms. An earlier set in the first session, about 66 minutes before the interleaved set above and on the lab unit (the committed unit was not installed yet), also without a quota, 40 starts per variant: full sandbox 111.4 / 151.4, without `ProtectKernel*`/`ProtectControlGroups` 97.9 / 151.4, without any namespace 77.1 / 94.9 (34 / 56 ms for the namespaces). Started directly (runuser, no systemd) 46.2–53.8 / 88.4–90.4 ms. Exec is slow on this vCPU (`postgres -V` 10.8 / 13.7 ms, `postgres -C` 21.6 / 24.2 ms). The owner weighs sandbox depth (D13) against the 150 ms node-path target |
| Stage 1 Block 1: checks | A private `/dev/shm` works only with `TemporaryFileSystem=/dev/shm:size=…,mode=1777` (the default 0755 root mount makes PostgreSQL fail with "could not open shared memory segment"). A parallel vacuum launched 2 workers with up to 5 DSM segments in the unit's own `/dev/shm`; the host's stayed empty. After kill -9 of the postmaster the cgroup was empty within 2–5 ms, with no process or `/dev/shm` file left; `postmaster.pid` stayed until the next start; the restart with crash recovery took 1.77 s. **SysV segment:** the first check counted segments by owner name and was blind, because `ipcs` prints the owner cut to 10 characters and the 25-character user name never matched (it printed 0 while the postmaster ran). The rerun selected segments by uid in `/proc/sysvipc/shm`: while it runs, the postmaster holds one 56-byte SysV segment; after kill -9 the lab unit (no `RemoveIPC=`) left it with no process attached, and the restart replaced it; the unit as first written for the image (`RemoveIPC=yes`) left none; after a clean stop neither unit left one. A per-unit `CPUWeight` inside `pgcf.slice` toggles no controller (`cpu io memory pids` stay enabled with the unit running and stopped); in `system.slice` the `cpu` controller toggles with the unit (`cpu memory pids` running, `memory pids` stopped). Its start cost is in the next row. Live `CPUQuota` change 2.1–3.0 / 3.0–5.3 ms and `MemoryMax` 1.7–2.5 / 2.3–4.0 ms over D-Bus. After `pg_switch_wal()` the shutdown checkpoint lands in the next segment: as its first record when idle, or after 334 `FPI_FOR_HINT` records when reads set hint bits after the switch (checksums on); never after a client commit. `systemd-analyze security`: 0.4 SAFE |
| Stage 1 Block 1: start cost of a per-unit `CPUWeight` | **Unresolved in the first session, none in the rerun.** First session, `cpuw.sh` (lab unit, `CPUWeight=50`, 20 start/stop cycles per variant, variants one after the other; p50 / p95): `pgcf.slice` 109.6 / 157.3 without a weight and 129.7 / 151.6 with it; `system.slice` 120.7 / 156.6 without and 142.4 / 187.9 with it. An earlier run of the same script, recorded in the first version of the checks row, gave 110.0 without and 130.3 with a weight in `pgcf.slice`. That is +20 ms at p50 in `pgcf.slice` in two runs and in `system.slice` in one, and `pgcf.slice` toggles no controller, so the controller toggle does not explain it. The interleaved set of the same session (committed unit, 40 starts each) showed no cost of `CPUWeight=100`: 167.2 with it, 168.1 without. Rerun about 75 minutes later: `cpuw.sh` twice, p50 in `pgcf.slice` 101.5 and 107.4 without a weight, 98.1 and 104.6 with it; in `system.slice` 98.6 and 95.6 without, 99.6 and 100.7 with it; interleaved in rotated order (committed unit without `ExecStartPre=`, 2 × 40 starts, p50 / p95): `CPUWeight=100` 104.4 / 133.0, no per-unit weight 104.6 / 139.2, `CPUWeight=50` 103.4 / 126.6. The first session's +20 ms appeared only in its sequential runs and did not reproduce, in the same script or interleaved; its cause is not known, so the start cost of a per-unit weight is 0–20 ms at p50 over all data and 0 in the rerun. The controller toggle in `system.slice` cost nothing measurable in the rerun either (start +1 and +5 ms at p50) |
| Stage 1 Block 1: LVM at scale (loop-backed pool, 1,000 thin volumes of 1 GiB with 20-character names and tags) | The default metadata area (1,044,480 B) holds 1,000 volumes: free space fell from 519,168 to 160,256 B, 358.9 B per volume, so it would run out near 1,450 volumes (extrapolated). `--metadatasize 64m` gives 68,153,344 B, enough for about 94,900 volumes by the same slope. Metadata text 461 B per volume. lvcreate p50 rose from 144 ms (first 100) to 267–270 ms (900–1,000); all creates 206–224 / 284–307 ms; lvremove 196–198 / 261–266 ms; JSON listing 76 ms at 100 and 148–150 ms at 1,000 volumes (with tags 184–186 ms). Pool metadata use 2.05 % of 1 GiB with 1,000 empty volumes. Each active, unmounted thin volume took 0.23–0.31 MiB of MemAvailable (MemAvailable fell by 231,264 KiB with the 64 MiB area and 317,116 KiB with the default one, over 1,000 volumes). **Technical volume bound: 1,000 volumes per node** (4.11), the largest count measured; the 64 MiB area would hold about 95,000, and LVM command time grows by about 0.13 ms per existing volume. EU1's pool: 276,819,869,696 B of data on the 259.9 GiB partition, zeroing on; lvm2 2.03.31 rejects `--errorwhenfull` at lvcreate for thin pools, so it is set with `lvchange` |
| Stage 1 Block 2: backups under the real permission model | Sandboxed PostgreSQL → archive client on a Unix socket → lab agent (caller identified by `SO_PEERCRED`) → `systemd-run` as `pgcf-<id>` in `pgcf-backup.slice` with `LoadCredential=` → barman-cloud 3.20.1 → R2 with a locally signed credential (explicit actions, no delete, one prefix). wal-archive per call: full segments (57 during a bulk load) 1.448 / 1.986 s, **0.84 / 1.04 CPU-s**, RSS 66.5 / 71.1 MiB (cgroup peak at most 75.7 MiB); near-empty segments 0.754 / 0.903 s, **0.45 / 0.50 CPU-s**, RSS 61 MiB. **The cost trigger of 7.5 holds (above 0.25 CPU-s).** Serial archiving drained a 57-segment bulk load 47.8 s after the load ended. Base backup (gzip, `-J 2`) of 509 MB: 67.2 s, 62.7 CPU-s (gzip-bound), RSS 71.7 MiB, `data.tar.gz` 103,863,748 B in 5 multipart parts, DONE; page cache fills the job's cgroup up to its limit. Restore into a new volume as the new user: barman-cloud-restore 6.5 s, recovery and promotion 7.2 s; PITR: 3.3 s and 6.1 s, stopped before the first commit after the target. Both: `system_identifier` equal to `backup.info`, timeline 2 above 1, data digest equal. `wal-restore -p 4` with a spool directory per operation (empty after success; 3 files left after a failed recovery); one wal-restore call 0.58–0.64 / 0.97–1.0 s, 0.39–0.48 CPU-s, RSS 60 MiB. Job cgroup peaks under the lab's 400 MiB job limit: WAL upload at most 75.7 MiB (107 calls), WAL fetch at most 117.6 MiB (83 calls), base backup and restore at the limit (page cache) with 63–72 MiB of process memory. These set the per-job limits and the concurrency in 7.5. systemd nests `pgcf-backup.slice` inside `pgcf.slice` (control group `/pgcf.slice/pgcf-backup.slice`; Appendix C) |
| Stage 1 Block 2: restore continuity | A plugin-barman-cloud archive of benchmark database `uzytv7ue7kijtl2x5btw` restored into the plain unit with a read-only credential: 79 WAL fetches, redo 97.2 s, promoted, `system_identifier` equal, all 509 MB of SaaS data present. It needs `hot_standby = off` during recovery (a target `max_connections` of 25 below the source's 100 aborts recovery with "insufficient parameter settings"), the CloudNativePG `postgresql.conf`, `custom.conf` and `override.conf` replaced, and the roles reset (the source superuser is `postgres`) |
| Stage 1 Block 2: credentials | Local HS256 signing works on the EU-jurisdiction bucket. DeleteObject and DeleteObjects: 403 AccessDenied. HeadBucket: 403, and never needed (wal-archive, backup, restore and wal-restore all succeeded). Writes and lists outside the prefix: 403. **A 7-day lifetime is accepted** (30 days too). On expiry barman exits 4 after R2 answers "SignatureDoesNotMatch", the same exit code as any refusal, so the agent tracks the expiry time itself; after renewal the archiver's next retry succeeded 48.6 s later, without a restart. A unit's `Environment=` (`systemd-run -E`) is readable by every local user over D-Bus; `LoadCredential=` is not. The backup role also needs EXECUTE on `pg_switch_wal()` and `pg_create_restore_point(text)`; without them barman failed after 68 s of upload |
| Stage 1 Block 2: create and sleep costs | Empty database to ready: user, thin volume, mkfs, mount, initdb and configuration 1.8 s; start 146 ms; roles 59 ms; first base backup 7.35 s (3.2 CPU-s); **9.4 s in total**; 68.6 MiB of its thin volume used. Full sleep proof, 10 runs: **1,016.6 / 1,084.4 ms** (checkpoint 60.8 / 79.2, switch 70.1 / 102.2, archive wait 807.9 / 869.9, stop 57.8 / 89.0, `pg_control` check 3.4 / 5.4 ms) |
| Stage 1 cleanup | Temporary Tunnel, VPC service and Worker deleted; the 113 lab objects (314.7 MB) under the lab prefix deleted; credential files removed from EU1. Locally signed credentials cannot be revoked one by one: the lab's working credentials expire by 2026-10-17 22:52 UTC, and two HeadObject-only probe credentials for one non-existent key expire on 2026-10-24 and 2026-11-16, or earlier when Stage 0 revokes the parent key. EU1 stays on Debian 13 with the lab key and its lab databases stopped, with the lab unit and the unit as first written for the image installed, no runtime unit properties left and no failed units. All raw lab output, including what was only on EU1, is kept with the lab scripts outside the repository |
| Stage 2 steps 1–5 on branch `stage2/clean-main` (2026-10-17) | 269,602 non-lockfile lines deleted and 6,749 added against main `85a2e6e3` (270,670 and 6,767 with the lockfiles). Locally green: lint, format, typecheck, the four contract generator checks, cargo fmt, clippy and tests, the Worker build, every workspace test (API 774, contracts 209, Edge 103, Rust Edge 20), the node-agent kernel test and Mermaider |
| Stage 3 lane D, placement and resources on branch `stage3/d-placement` (2026-10-18) | Migration `0064`: a database's own `own_memory_mib`, `own_cpu_millicores` and `own_storage_gib`, `placed_at`, the view `database_resources`, and the capacity alert kinds. Placement reads only what the node link stores: the node's newest sample (`nodes.last_sample_json`) and its per-minute rollups (`node_minutes`), the volumes in `node_volumes`: online within 180 s, open pool, 30-minute averages with the seven-day peak below 80 % RAM and CPU, fill first, placements of the last 30 minutes at full memory. `PUT /v1/databases/{id}/resources` (admin keys), resources on create. Review fixes: the logical cap counts the storage of databases the node has not finished (open create, restore or resize operations, or finished after the node's newest sample) and the write guard checks it; a sleeping database's storage growth is held to the cap; a 30-minute average needs ten minutes of samples, and a node with less than 30 minutes of history has one average over all of it; the desired state and the admission snapshot carry the effective values; the capacity cron's headroom orders need only the autoscale switch; all lifecycle snapshots reserve exactly the limits; the new alert `regional_node_pool_closed`. Locally green: API 798 tests, contracts 254, CLI 31, Edge 103, lint (except the unused `_` in `packages/contracts/test/node-link.test.ts`, from the contracts commit), format, typecheck, Mermaider |
| Stage 3 lane D integrated on branch `stage3/lane-d` (2026-10-18) | `stage3/d-link`, `stage3/d-placement` and `stage3/d-lifecycle` merged in that order on the node contracts, with migrations `0063`, `0064` and `0065` as reserved. What two modules had written twice has one store: placement and the capacity alerts read the node link's newest sample (`nodes.last_sample_json`), `node_minutes` and `node_volumes`, and the clock skew of a sample is the interval the link takes; orders are `lifecycle_orders` (move, superseded, maintenance; a fence is a lost node and has no row, and a node is fenced when it is marked lost or has a loss row); archive credentials are `archive_credentials`, issued by the desired page in one batch per page, and `GET /node/v1/archive-credentials/{id}` signs one; a move target's page carries the staged entry. The intake of observations records the results of orders, advances the moves and keeps the recovery points, and the nodes of a move are told to pull. A move checks its target with the placement of lane D. Migration `0063` put back every scope fence after the rebuild of `regions`, which failed on any D1 with fences of projects or nodes; only the region fences are put back now. Locally green: API 99 files, 860 tests; contracts 27 files, 263 tests; Edge 100 tests and 2 workerd entry tests; CLI 31; E2E scripts 48; CI scripts 27; Rust 234 tests with fmt and clippy; lint, format, typecheck, the four native generator checks, plan privacy and Mermaider. Not run: the Rust Edge Worker test, which needs the Worker build |
| Stage 3 lane D reviewed as a whole on branch `stage3/lane-d` (2026-10-18) | Fixed test-first: a move completes only when the target's DONE backup lies on a timeline after the source's proof, and a `ready` target without one fails the move (`not_promoted`), so the source serves again; a restore into another region is refused with `region_unavailable` before anything is written, because a node reads only its own region's archives, and the custody of other regions' bucket-wide read keys (its API, table, contracts and runbook sections) is deleted, with migration `0065` dropping `region_archive_sources`; only a request that names an enrolled node's key reads the 4 MiB node body, while the installer's progress and the enrollment keep 64 KiB; `NodeActor.latest()`, which only tests called, is deleted. Locally green: API 97 files, 853 tests; contracts 27 files, 263 tests; Edge 100 tests and 2 workerd entry tests; CLI 31; E2E scripts 48; CI scripts 27; Rust 234 tests with fmt and clippy; lint, format, typecheck, the native generator checks, plan privacy and Mermaider. Not run: the Rust Edge Worker test, which needs the Worker build |
| Stage 3 lanes A, D and C integrated on branch `integrate/stage3` (2026-10-18) | `stage3/lane-a`, `stage3/lane-d` and `lane-c/node-image` merged on main in that order, then six seams closed test-first. (1) A refused wake is answered with the contract's reason: the gateway sends 57P03 with the DETAIL "storage" or "node at awake capacity" and the HINT "retry after <n> s" (`refusalFields`, with vectors), on a WebSocket and in the JSON error of HTTP SQL; the reason `wake_in_progress`, which the agent answers to a ticket it already serves, is no result (`WAKE_AGAIN_REASON`): the held connections keep waiting and the ticket is delivered again after 3 s; the reasons `uuid_mismatch`, `volume_open` and `holder_busy`, which the agent never names, are deleted from the contract. A new test runs the agent core against the real gateway over a real Unix socket and PostgreSQL, and found that without this the gateway ended a wake that waited in admission with a bare 57P03 after 3 s. (2) The node-local vectors of `node-local.ts` (agent and gateway channel, archive socket, refusals) are read by Rust tests in `pgcf-native-protocol` and `pgcf-archive`, which decode and encode every line byte for byte. (3) The installer accepts exactly the contract's node ID (`nod_` and 20 lowercase letters or digits). (4) One route token version, v6, is signed by the API and the Edge (TypeScript and Rust) and verified by the gateway with the key derived for its node (`PGCF_NODE_ID`, `PGCF_ROUTE_KEY`); the v2–v4 and Pod bridge, the per-region keys and the schema validators of the old controller are deleted; TypeScript and Rust share the vectors. (5) The agent meets what the image expects: it writes `gateway.env` with the node ID and the node's keyring and the Tunnel token credential, lifts the CPU quota of every stopped unit and makes the socket directories (`/run/pgcf/<id>`, 0750, `pgcf-<id>:pgcf-gateway`) before it sends READY=1. (6) Deleted: `x509-parser` and `tokio-postgres-rustls` with their THIRD_PARTY rows, the contracts of the old agent, gateway control and activity, reclaim and storage observations, the Kubernetes-era parts of the release contract, the controller generator and its vectors, the API's node storage observation (migration `0066` drops its table) and the legacy part of `memory-capacity.ts`, and the pointers to them in `integrator-handover.md`. Locally green on macOS: Rust 458 tests (workspace 120 and node agent 338 with 6 ignored), fmt, clippy for the workspace and for wasm32; contracts 17 files and 194 tests; API 96 files and 850 tests; Edge 107 tests and 2 workerd entry tests; CLI 31; E2E scripts 66 (64 passed, 2 skipped); CI scripts 27; node image tooling and installer 21; lint, format, typecheck, the four native generator checks, plan privacy and Mermaider. On Linux (the pinned Rust image, aarch64): clippy with `-D warnings` on the gateway, protocol, archive and agent crates, the agent's 342 tests with 7 ignored, and the 7 ignored kernel tests in the CI container. Not run: the Rust Edge Worker test (the Worker build needs `rust-lld`, which this Mac lacks), the QEMU boot test and the image build (CI job `node-image`), the kernel test on `linux/amd64`, and `scripts/ci/toolchain.mjs check` (Linux only) |
| Stage 3 integration reviewed and fixed on branch `integrate/stage3` (2026-10-18) | An independent review of the integration found nine gaps. Each was checked, and the real ones were fixed; where the behavior was new, the failing test was written first (the renames of (9) are held by the existing tests). (1) The agent never sent `instance` with a ready observation, so the API refused every report that held a ready database and no database could be routed: it now names the unit's invocation ID. A Rust verdict on the contract's refinements (`contract_valid`: observations, samples, volume, usage and event reports, the enrollment key) holds the link, the agent's tests and the Cloudflare double to the rules the API holds them to, and the vector test requires it to decide as Zod does for every vector (four more vectors for rules that had none). (2) AddNode sends the installer: an audited server gets its tokens and a rescue whose userData is the pull installer rendered for it (the release's image, the provider's disk, memory, MAC and network), once, and a node that did not enroll after the installer's reboot is restarted once; the renderer moved into the contracts package with the installer's files as a generated module. (3) `GET /node/v1/credentials` hands a node the route keyring derived for it and the token of its Tunnel, which the API makes with its ingress and two DNS records at the first read; a node opens for placement, and its addition becomes ready, only with the first sample that holds the credentials revision D1 holds for it. (4) The Edge dials the gateway of the node that serves a database (`nodes.gateway_url`, the region's for a node that has none). (5) A release on the page installs without a reboot: the four binaries are downloaded, checked against their pinned size and digest, the `current` link moves, the gateway restarts if its binary changed and the agent exits to be restarted if its own did; the maintenance order installs what the package lock pins and `dpkg` lacks through apt from the release's snapshot, reboots for a kernel or a core library, checks the node with `pgcf-agent check` and answers. (6) A fence and a superseded order are acted on again by every process that reads them from the page, and stop the units a restarted agent finds running. (7) The seed's API URL is an origin in the contract, the installer and its renderer. (8) See (1). (9) The Talos-era names went: `nodes.hostname`, `databases.runtime_json`, no bootstrap proofs on the node addition, no sidecar CPU charge, no `PGCF_GATEWAY_MODE`. Rejected: `cluster_uid: null` in the backup envelope stays, because it is part of the authenticated data of every infrastructure backup already written. Locally green on macOS: Rust 472 tests (workspace 120 and node agent 352 with 6 ignored), fmt, clippy for the workspace and wasm32; contracts 17 files and 194 tests; API 99 files and 866 tests; Edge 107 tests and 2 workerd entry tests; CLI 31; E2E scripts 64 (2 skipped); CI scripts 27; node image tooling and installer 22; lint, format, typecheck, `tsc` of `scripts/ci`, the contract generator checks, plan privacy and Mermaider. On Linux (the lab image, aarch64): clippy with `-D warnings` on the workspace and the new update tests. Not run: the Rust Edge Worker test, the QEMU boot test and the image build, and every live step: the Tunnel and DNS calls, the rescue, apt, the reboot and the binary switch ran against doubles and the test machine only |
| Stage 4 install wiring on branch `stage4/install-wiring` (2026-10-18) | Built on `integrate/stage3`, which already had the renderer in the contracts package (one copy, generated from the installer's files), AddNode's tokens, rescue and restart, the reinstall guard for recover mode and the opening of a node by its first sample with credentials. What was missing for Cloudflare to install a node from the image is added. (1) Registry: `PUT /v1/fleet/releases/{version}` takes the digest and size of the six files of a build (image, package lock, four binaries) and no URL; the Worker names every URL of the stored, immutable spec as `/node/v1/releases/{version}/{file}`, the version is the release id, the image version and the binaries' directory, and the registration is refused unless the archive bucket holds each file under `node-images/{version}/` at that size with the sha256 R2 verified at upload (tested for a missing file, another size, another digest, an unverified upload and a Worker without an origin). The region's current release is the existing `PUT /v1/regions/{id}/release`. (2) Delivery: `GET` and `HEAD` of that path stream from the `ARCHIVE` binding and answer one `Range` with 206 or 416; the image needs the install's progress token, which is bound to the node and the version it was issued for and closes with `rebooting`, `failed`, the enrollment and its expiry; the binaries and the lock are open artifacts the agent reads without a credential. (3) The installer reads the image with that token from its header file and follows no redirect; it and the renderer refuse any URL with a query. (4) `scripts/operations/register-node-image.ts` checks a build's files against `pgcf-node.json`, uploads them with `x-amz-checksum-sha256` (a file already there with the same content is skipped, a different one is refused) and registers them; the manual path is in `infra/node-image/README.md`, and the CI job stays secret-free. (5) An API test follows the installer through the userData it was given: the image by token (size, bytes and sha256 as registered), every checkpoint, the closed token and the enrollment. Locally green on macOS: contracts 17 files and 196 tests; API 100 files and 881 tests; Edge 107 tests and 2 workerd entry tests; CLI 31; E2E scripts 64 (2 skipped); CI scripts 27 and operations scripts 10; node image tooling and installer 23; lint, format, typecheck, `tsc` of `scripts/ci`, `scripts/operations` and `infra/node-image`, the contract generator checks, plan privacy and Mermaider. Not run: Rust (nothing in it changed), the Rust Edge Worker test, the QEMU boot test and the image build, and every live step: the upload to R2 (R2 has supported SHA-256 checksums on S3 PutObject since 2023-06-16; the script's signing is checked against the AWS documentation example and its streamed PUT against a local HTTP server, not against R2), the rescue, the image read from the live Worker and the enrollment |
| Stage 4 install wiring reviewed and fixed on branch `stage4/install-wiring` (2026-10-18) | An independent review found five gaps, each checked before it was fixed; the failing test was written first where behavior changed. (1) `register-node-image.ts` parsed the API's answer with a picked, strict `FleetRelease` and so failed after every successful registration (the answer is the whole release with `spec` and `approved_at`); it now parses the whole release, requires the registered version and the registered digests in the stored spec, and prints the id and spec sha256. (2) The binaries a release registered were not tied to the binaries baked into its image: `node-image.ts build` now requires `--binaries`, digests the four before the download and writes them to `pgcf-node.json`, `build.sh` bakes exactly those four, and the registration is refused when a binary differs from the build summary. (3) An object skipped on size and md5 alone could lack the sha256 the API requires: the HEAD sends the signed `x-amz-checksum-mode: ENABLED`, a file is skipped only when R2 reports the file's sha256, one without it is sent again, and a different sha256 is refused (R2's S3 compatibility table does not list `x-amz-checksum-mode` for HeadObject, so whether R2 answers it is open until the first live run; a run that gets no checksum back sends the files again, which is correct and only slower). (4) The README's `curl` put the administrator key in its arguments; it now reads the header from a 0600 file in a 0700 directory, which was run against a local server. (5) `FleetNodeImage.format` is `raw.zst` alone: nothing can store the uncompressed format since the release is built from a registration, so the `raw` member, its refinement, the installer's guard and their tests are deleted. Locally green on macOS: contracts 17 files and 196 tests with the generator checks; API 100 files and 881 tests; CI and operations scripts 37; node image tooling and installer 24; lint, format, typecheck, `tsc` of `scripts/operations` and `infra/node-image`, and Mermaider. Not run: Rust (nothing in it changed), the image build and every live step |
| Stage 4 CI release artifact on branch `stage4/ci-artifact` (2026-10-18) | The `node-image` job collects the files `register-node-image.ts` takes (compressed image, `pgcf-node.json`, `packages.lock.json`, the four binaries, a `SHA256SUMS` of these) in one directory and runs the script's own `--dry-run` on it, so a missing file or a binary that is not the one in the image fails the job; on a push to `main` after the boot test it uploads the directory (stored uncompressed, because the image is already zstd) as `pgcf-node-release-<commit sha>-<run attempt>` with 7 days of retention, with the action pin of the workflow's other uploads. The raw image and every credential stay out. `infra/node-image/README.md` makes `gh run download` plus the script the primary registration path and the local Docker build the alternative. Checked: `actionlint` on the workflow, the staging step run on a build summary with matching digests (accepted) and with a binary rebuilt since (refused), and the `gh run list` and `gh run download --pattern` commands against a past run. Review fixes: the upload step skips a fork (`!github.event.repository.fork`), and the README's run lookup filters on `--event push`, because a later successful `workflow_dispatch` run of the same commit carries no artifact (the unfiltered query returned a dispatch run for a commit with six newer dispatch runs, and `gh run download` on it found nothing; with `--event push` it returns the push run). The first upload happens on the first push to `main` after the merge |
| Stage 4 shell hostname off by default on branch `stage4/shell-off` (2026-10-18) | `apps/api/src/domain/node-tunnel.ts` made two public hostnames for every node, the gateway and `<node>-ssh.<domain>` (`ssh://127.0.0.1:22`), and the account has no Zero Trust organization, so the shell hostname would have been reachable by anyone who can run cloudflared. The shell hostname, its DNS record and its Tunnel ingress rule now exist only while the Worker variable `NODE_SHELL_HOSTNAME` is the string `"true"` (declared in `apps/api/src/env.ts` and `apps/api/wrangler.example.jsonc`, default off); while it is not, `ensureNodeTunnel` writes an ingress of the gateway and the 404 rule alone and deletes a shell CNAME a node already has, so a node that got one is corrected on its next credentials read and a second read changes nothing. The gateway hostname is as before. Tests first: the Tunnel with the shell off, with it on, the removal and its repeat in `node-tunnel.test.ts`, and the variable's reading (unset, `true`, anything else) in `node-credentials.test.ts`; the Cloudflare double learned to delete a DNS record. Locally green on macOS: API 100 files and 884 tests; lint, format, typecheck of `apps/api`, `scripts/ci` and `scripts/operations`, plan privacy and Mermaider. Not run: any live step, so a shell record that exists on the live account stays until the node's credentials are read again |
| Stage 4 Access operations on branch `access-ops` (2026-10-18) | The shell hostname is `pgcf-shell-<id>.<domain>` (`nodeShellHostname` and the two label prefixes in `packages/contracts/src/nodes.ts`), so the wildcards `pgcf-node-*` and `pgcf-shell-*` do not overlap; its former name, `<gateway label>-ssh`, was inside the gateways' wildcard, and `ensureNodeTunnel` now deletes a DNS record under that name whether the shell is on or off (the Tunnel's ingress is replaced whole on every call, so its rule goes with it). `scripts/operations/setup-access.ts` (`plan` by default, `apply`, `--remove`, `--verify`) ensures the application `pgcf node gateways` with one Service Auth policy for the named service token and, with `--shell --operator-email`, the application `pgcf node shells` with one allow policy for the named emails; it creates or rotates the token only with `--edge-worker` and sets ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET through the Workers API without printing them. The shell is a self-hosted application: the native client needs that type, and the SSH type is the browser-rendered terminal. Tests first for the rename (family separation in contracts and API, removal of the former record with the shell on and off); the script's 20 tests run against an in-memory Cloudflare API and assert that a second run only reads, that a policy edited by hand is put back, that a token is refused without `--edge-worker`, that no credential is in any output line, that `--refresh-service-token` (the Cloudflare refresh endpoint) is the only step that moves the token's expiry (a rotation leaves it) and touches nothing else, that an expired token is refused and one within 30 days is warned about, and that a malformed `PGCF_CLOUDFLARE_API_TOKEN` is refused by name before any request instead of being quoted in the runtime's header error (`register-node-image.ts` refuses a malformed `PGCF_API_KEY` and `PGCF_R2_ACCESS_KEY_ID` the same way). Locally green on macOS: contracts 17 files and 197 tests; API 100 files and 892 tests; `scripts/ci` and `scripts/operations` 58 tests; lint, format, typecheck of `apps/api`, contracts and `scripts/operations`, plan privacy and Mermaider. Not run: any live step, so the applications do not exist yet, and the Edge change that presents the token is not part of this branch |
| Rust Edge level with the TypeScript Edge on branch `edge-rust/parity` (2026-10-18) | CI run 39145054111 on main `f12f9da3` failed 6 of the 19 tests of the Rust Edge Worker test; the Worker build, the native Rust tests and clippy were green. The cause was the test, not the Worker: the DatabaseActor admits on the admission snapshot the API publishes, and the test changed the region's route, the project and the database in D1 after seeding without publishing again, so a deleted project got the gateway instead of the decoy, a changed route was not dialed and a suspended database was admitted. The test publishes after each such change, as the TypeScript Edge test does (`updateRegion`). Behind it the e2e test of the benchmark rig (`saas-bench-local`) failed on main as well, hidden because `pnpm test` stops at the first failing package: the rig still bound the `RegionLink` that Stage 3 deleted; it binds the `NodeActor`. The failure was first reproduced in a Linux container (aarch64, Node 24.21.0, Rust 1.99.0, worker-build 0.8.7): the same 6 failures, 88 s; with the fixture fixed alone all 19 passed. The Rust Edge also differed from the TypeScript Edge on origin/main in what no test pinned, and now does what it does: (1) the limiters and the Actor's admission run together, and a caller without `CF-Connecting-IP` counts in `BINDING_CONNECTION_RATE_LIMITER` alone, neither draining nor drained by the public limiters; (2) `conn_admission` logs the `colo`, `edge_ms`, `isolate_requests`, the route version and the milliseconds of each stage that ran (`limiters_ms`, `admit_ms`, `token_ms`, `gateway_connect_ms`), with the pending wait of an interrupted upgrade counted as the gateway's; (3) the DatabaseActor is got at `DATABASE_ACTOR_LOCATION_HINT`; (4) `POST /sql`, the Neon driver's HTTP query mode, is served (`sql.rs`, the part that reads a request, and `sql_host.rs`, the Worker): admitted as a connection is, signed a v6 or v5 route, forwarded once to the gateway of the node, the gateway's JSON and its coded 400 passed on, any other answer an unknown outcome (`08007`), logged as `sql_admission` without password, statement or parameter; (5) the example configuration carries the binding limiter and the hint. The reading of a request is held to the TypeScript Edge by vectors in `conformance.generated.json` (connection strings, transaction headers, bodies, the text of numbers, the forwarded body, the decoding of the bytes), which `generate-edge.ts` makes from `packages/contracts/src/edge-sql.ts`, the pure part of `apps/edge/src/sql.ts` that moved there so that the generator needs no Workers types; `MAX_SQL_REQUEST_BYTES` and `MAX_SQL_STATEMENTS` are generated constants. The vectors found one real difference: the default `serde_json` reads `1.00000000000000011102230246251565404236316680908203125` as `1.0000000000000002` where JavaScript reads `1`, so the Edge builds `serde_json` with `float_roundtrip`. Known differences left: a lone surrogate escape or a number beyond the range of a double in a body is refused as `08P01`, where JavaScript reads it. Locally green: in the container the Rust Edge Worker test, 27 tests (64 s); on macOS the Rust workspace with fmt and clippy (also for wasm32; `pgcf-edge-rust` decoy 4, policy 18, sql 6; the node agent's 352 with 6 ignored need a short `TMPDIR`, because PostgreSQL's Unix socket path is limited to 103 bytes), contracts 17 files and 196 tests with the generator checks, Edge 107 tests and 2 workerd entry tests, CLI 31, E2E scripts 66, CI and operations scripts 37, lint, format, typecheck, plan privacy and Mermaider. CI (workflow dispatch on the branch, run 39149557621, commit `f4840892`): green, with the Rust Edge Worker test at 27 of 27, the E2E scripts at 66 and the node image job. |
| Rust Edge level with the TypeScript Edge reviewed and fixed on branch `edge-rust/parity` (2026-10-18) | An independent review found two gaps; both were real, and each was checked before it was fixed. (1) origin/main had gained 6aec5548 (a gateway's refusal is logged with its status and error code at the Edge), which the Rust Edge lacked, and the branch no longer merged cleanly. The branch now merges origin/main (the Mermaider manifest regenerated, the rows of both sides kept in this plan) instead of being rebased, so the published branch is not rewritten. `refusalCode` and its limit `REFUSAL_BYTES` moved from `apps/edge/src/gateway.ts` into `packages/contracts/src/edge-policy.ts`, which has no Workers types, as the reading of HTTP SQL did; `generate-edge.ts` makes 35 vectors of refusal bodies and the constant from it, and `policy::refusal_code` is held to them. `conn_admission` and `sql_admission` log `gateway_status` and `gateway_error` (absent when the gateway sent no code): `gateway::connect` records them for an upgrade that is answered with anything but 101, and `sql_host::forward` for a 400 that is not a gateway error (the code of its text) and for every other status. The refusal is not read as the TypeScript `readRefusal` reads it: that loop reads until the body ends and awaits its cancel, and a gateway that sends one byte and stalls would hold the client's refusal until the 60 s deadline, which the test "a refusal is prompt even when the upstream body never ends and its cancel never settles" forbids. `read_refusal` reads at most `REFUSAL_BYTES`, waits at most 250 ms for them, does not wait for the end of the body and does not await its cancel. The TypeScript loop has the same stall and no test for it; it is unchanged. The fixture's stalled body is now stalled, not hung: workerd ends a stream that has no pending timer or I/O within a millisecond, so the first version of the test never reached the timeout (measured: the wait ends at 252 to 254 ms, the refusal at 260 ms). (2) The review's other finding was real and deeper than reported. The test harness gives every request it sends the source address of the loopback interface, so the test's "caller without a source IP" was an ordinary public caller, and the branch of `policy::limits` for service bindings was never reached by the Worker test: with `network == "binding"` made unmatchable the Worker test stayed green. The test now sends such a request through a caller Worker over a service binding (`apps/edge-rust/test/binding-caller.ts`), which removes the header. Beside a public limiter of 12000 and a binding limiter of 1 the second connect is refused (53300), and so is the second HTTP query. The scope of the HTTP limiter is pinned by one connection and one query from one address to one database and role on a Worker with a public limit of 1; the location hint cannot be observed in workerd (a hint of `no-such-place` is admitted as well), so that test is named for what it checks. Each mutant was built and run in the container and failed exactly one test: the binding branch unmatchable, an empty scope of the HTTP limiter, a refusal wait of 60 s, no code on a 400; ignoring the location hint stays green. Rejected: the literal port of `readRefusal` (above), and a test of the hint that does not observe it. Known difference left: a number beyond the range of a double in the body of a refusal makes no code in Rust and a code in TypeScript. Locally green: in the container (aarch64, Rust 1.99.0, worker-build 0.8.7) the Rust Edge Worker test, 28 tests (66 s); on macOS the Rust workspace tests with fmt and clippy (also for wasm32; `pgcf-edge-rust` policy 19, sql 6, decoy 4; the node agent's 352 with 6 ignored), contracts 17 files and 196 tests with the generator checks, Edge 107 tests and 2 workerd entry tests, prettier, eslint and Mermaider. CI (workflow dispatch on the branch, run 39154115240, commit `edc549f8`): green, with the Rust Edge Worker test at 28 of 28 (the test of the two stalled refusals took 596 ms) and the node image job. |

| Stage 4 live: EU1 installed from the image (2026-10-18) | AddNode in recover mode, pull install through the Contabo rescue. Rescue requested 17:30:55.9 UTC; installer started 116.3 s later; hardware check +0.7 s; image verified +36.8 s; disk written +13.6 s; configured +0.8 s; rebooting +0.4 s (52.3 s from start to reboot); the node enrolled 28.0 s after the reboot. **196.5 s from the rescue request to enrolled.** Not yet run: the external scan, the refused request without Access credentials, the shell through Access, the binary update and the maintenance cycle |
| SEC-06 AddNode confirms the node firewall before the rescue, on branch `sec-firewall` (2026-10-18) | `driveNodeInstall` reads the firewall `CONTABO_NODE_FIREWALL_ID` names, requires `active` and no inbound rule that accepts, assigns the instance if it is not listed, reads the firewall back for it, and otherwise requests no rescue, issues no tokens and records `install_blocker: node_firewall_unconfirmed` on the audited addition (a new column, migration 0071: `failure_code` ends an addition, and its CHECK cannot grow without rebuilding `node_additions`, which tables with cascading deletes reference). A rule that drops is accepted: the deleted allocation code met Contabo's implicit final deny on an empty definition. Deleted: `node-firewall-allocation.ts` (446 lines) with its test (407), `BOOTSTRAP_FIREWALL_BINDINGS`, the `node_firewall_allocations` table (migration 0070), the allocation check in `cancelAuditedNodeAdoption`, and the Contabo client's `listFirewalls`, `createFirewall` and `putFirewallRules` with their schemas and tests (nothing else called them). The six new installer tests were written first and all fail against the unchanged installer, while its eight existing tests pass. Locally green: the API suite (99 files, 880 tests), contracts (17 files, 196 tests), typecheck, eslint, prettier, plan privacy and Mermaider. CI (workflow dispatch on the branch, run 39168496663, commit `09f699bf`): green. The first run (39167788433) failed in a Rust node-agent timing test of `agent::power` that this branch does not touch, and passed on a rerun of the same commit. Review on 2026-10-19, each finding checked before it was fixed (four new tests written first, all failing before the fix): (1) the read-back counted an instance as held when `instances` listed it, although Contabo reports apart in `instanceStatus` whether it applied the firewall (`ok`, `processing`, `deleting`, `error_processing`, `error_deleting`); the check now requires `ok`, and an instance that is listed and still `processing` is waited for, not assigned again. Whether Contabo lists an instance in `instances` while it is still `processing` is not known, which is why both are required. (2) `install_blocker` stayed set when an addition failed or was cancelled; the failure and both cancellations that can leave `audited` clear it. (3) A cancelled adoption can stay assigned to the deny-all firewall: no machinery was added, since the assignment writes nothing to D1 for a cancel guard to read and no harm has been observed; the operator document and the cancel comments now say so. (4) The Contabo client's `PUT` method and the second name of its mutation result type, left behind by the deleted firewall writes, are gone. (5) origin/main (`af5c5094`) is merged, with the rows of both sides kept in this plan; the migrations `0070` and `0071` of this branch and `0070_maintenance_placement.sql` of the unmerged branch `node-maintenance` collide, and whichever branch merges second renumbers its own. After the merge: API suite 99 files, 890 tests; contracts 18 files, 201 tests; typecheck, eslint, prettier, plan privacy, the native contract checks, `cargo fmt`, `cargo clippy -D warnings` and Mermaider green. CI on the merged tip (workflow dispatch on the branch, run 39170957962, commit `f1bf2cc0`): green (check and node-image). **Not run: the live check** (an external TCP connect to port 22 times out during the rescue and after the reboot; the node still enrolls, baseline 196.5 s from rescue request to enrolled) |
| Stage 5 first live results on EU1 (2026-10-18) | **SQL through Cloudflare** failed at first with 08006 on every connect. The Edge now logs the status and error code of a gateway refusal (`gateway_status`, `gateway_error`; `6aec5548`), which showed 404 `websocket_upgrade_required`: the gateway upgrades at `/pg` only, and the node Tunnel's gateway URL ended at the hostname. Fixed in `74c4c3a0` (the region contract already ended a gateway URL at `/pg`). After it: create to ready 16.8 s; the SaaS dataset (100,000 users, 300,000 sessions, 600,000 tasks, 1,500,000 events) loaded through Cloudflare in 74.1 s; the Edge admission of a connect to an awake database 112 ms (gateway upgrade 94 ms, the Edge's own share 18 ms); archive after the load: 1 base backup, 49 WAL segments, 188.6 MB in R2 |
| Stage 5.1 restore, PITR and delete on EU1 (2026-10-18) | **PITR into a new database:** a marker table of 100 rows, a target time, 100 more rows, a WAL segment archived after them; the restore at the target time holds exactly the first 100, the source 200; the other tables are intact (100,000 users, 600,000 tasks). Ready 154.6 s after the request when alone, **309.5 s with three restores at once**. The first restore request answered 409 `generation_changed` ("retry"); the retry was accepted. A timestamp needs exactly three fractional digits. Delete: the volume row left the node's report 37.9 s after the request |
| Stage 5.8(b) tenant isolation at the SQL layer on EU1 (2026-10-18) | The `app` role is no superuser; `pg_read_file`, `pg_ls_dir`, `COPY ... TO PROGRAM`, `COPY ... FROM` a file, `lo_import`, `ALTER SYSTEM`, `CREATE EXTENSION` of `file_fdw` and `dblink`, and reading `pg_authid` are all refused; `plpython3u` is not installed. The raw-volume check (5.8(a)) needs node access and is open |
| Unplanned VM stall on EU1 and the bug it showed (2026-10-18) | At 18:06 UTC the node stopped reporting (last sample 18:06:25, 164 millicores busy, 11.9 GB available), the Tunnel answered 530 and Contabo reported the instance `unknown`; it came back about 10 minutes later, after a restart call that itself answered HTTP 500, and reported at 18:17:05. **The cause is not known** (there is no node shell and no journal over the link). Recovery: the agent found the awake database unproven, archived and proved its sleep 3 s after its first report. All data was intact (100,000 users, 300,000 sessions, 600,026 tasks, 1,500,026 events, 200 marker rows). The bug: D1 had marked the database provisioning on the `unproven` report, so the later `asleep` report was applied as an observation only; the database stayed running by intent and hibernated by observation, the Actor handed every connect the earlier wake ticket, and no node order backed it. A database D1 knew awake at the reported generation is now recorded as the hibernation it is, ready or found unproven (`54f2127a`, test first). Deployed; the stuck test database, reset to awake in D1, was then hibernated by the next report and woke on the next connect |
| Stage 5.3 first cold rounds from a laptop (2026-10-18) | Two cold rounds right after the sleep, on the SaaS request mix (page cache still warm; **not** the acceptance test, which needs databases idle for at least 1 h): connect usable 0.63 and 0.69 s after the connect began; first answer 0.69 and 0.83 s; first statement 28.4 and 36.9 ms; warm-up tax 20.0 and 24.4 ms |
| Stage 5.2 sleep and wake on EU1 (2026-10-18) | Idle sleep with the per-database value: asleep 67.9 s after the last statement at 60 s, 131.8 s at 120 s, 305.9 s at 300 s (the sleep proof and its report add 6–8 s). An open idle client connection does not keep the database awake (asleep 68 s at 60 s; the client's next statement got "server closed the connection"). Manual suspend: asleep after 2.5 s, a connect answers 57P03 "database is not accepting connections"; resume wakes it in 1.6 s with no client connect. Idle time null falls back to the size class, whose null is always warm |
| Stage 5.4 hard power cut under writes on EU1 (2026-10-18) | One writer committing numbered rows one at a time (each commit acknowledged before the next); the VM was stopped through the Contabo API after acknowledgement 3,000. The last acknowledged commit was 3,040; after the start the table held ids 1 to 3,040 with no gap and no duplicate: **no acknowledged commit lost**. The node reported again 26.8 s after the start request and the database woke on the next connect. The kill of the postmaster, agent and gateway, the R2 block and the systemd reboot are not run yet |
| Stage 5.3 cold first request after 60 min or more of sleep on EU1 (2026-10-18) | **Not the acceptance test** (7–8 samples per arm instead of the 30 or more the plan asks, and a node that had been power-cut 30 minutes before, so its page cache was cold as well). Whole first request (connect plus the SaaS page request of 8 statements) from a Cloudflare Worker through the public hostname, databases asleep 60–63 minutes: 842 / 967 / 1,017 / 1,023 / 1,178 / 1,356 / 1,407 / 1,482 ms (median 1,100 ms); first answer median 852 ms (675–1,256). The same from a Worker through a service binding to the Edge, asleep 60–63 minutes: 733 / 769 / 770 / 807 / 850 / 899 / 943 ms (**median 807 ms, all under 1 s**); first answer median 622 ms (566–748). From the laptop (plain statements, no paired round-trip probes), asleep 102 minutes: first request 0.769 / 0.899 / 0.960 / 0.969 / 0.981 / 1.042 / 1.109 s (median 0.969 s), connect usable 0.609–1.013 s (median 0.746 s). The earlier laptop rounds with a paired `SELECT 1` before every statement (1.22–1.88 s) overstated it and are void. Where the time goes (API log `node_wake`, 42 wakes): the agent's admission p50 130 / p95 203 ms (two `lvs` spawns per wake; the plan estimated 1–5 ms), `pg_control` 1 ms, start p50 183 / p95 362 / max 539 ms, release 0; node path (sum) p50 320 / p95 518 ms. Edge: the DatabaseActor admission 18–37 ms with a warm Actor, 230–549 ms with a cold one; the gateway upgrade 70–110 ms; all cold connects took the wake-ticket route (v5). From a Worker the public hostname costs about 300 ms more than a service binding |
| Both Edges present the Access service token on branch `access-edge` (2026-10-18) | The public gateway hostnames of the nodes are to be guarded by Cloudflare Access, so the TypeScript and the Rust/Wasm Edge now send `CF-Access-Client-Id` and `CF-Access-Client-Secret` when the Worker has the secrets `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`: on the WebSocket upgrade and on an HTTP query, to a gateway reached over the public network only, never over a service binding and never what a caller sends. `accessTokenState` in `packages/contracts/src/edge-policy.ts` decides, and the Rust Edge is held to its vectors: both set sends; neither sends nothing, so an installation without Access works as before; one alone refuses with `08006` before anything is sent and logs `config_error: access_secrets_incomplete` (a name, never a value). An HTTP query refused so is not an unknown outcome (`08007`), because nothing was sent, and its request is now built before the send, so a secret that cannot be a header value is `08006` too. The header names and the log value are generated wire constants. A refusal by Access needed no new code: a 401, 403 or 530, and a 302 to the login page (the redirect stays `manual`), were already failed upgrades and unknown outcomes that log `gateway_status`; both Edges and both entry points now have tests for that. The tests were written first (7 TypeScript tests failed before the code); sentinel values of the token appear in no log line, response or thrown error on the success, refusal and error paths, and a test that sends the headers over a service binding fails (checked by mutation in both Edges). The Rust Worker test reaches a gateway without a service binding through a test entry that sends the Worker's global fetch to the fixture gateway (`apps/edge-rust/test/public-gateway.ts`), because the harness has no outbound service. Locally green: Edge 119 tests (107 before); contracts 18 files and 199 tests with the generator checks; `pgcf-edge-rust` policy 21 and sql 6, fmt and clippy (also for wasm32); in the container (aarch64, Rust 1.99.0, worker-build 0.8.7) the Rust Edge Worker test, 31 tests (28 before) in 66.7 s; lint, format, typecheck, plan privacy and Mermaider. CI (workflow dispatch on the branch, run 39166198325, commit `49c76f2a`): green, with the Rust Edge Worker test at 31 of 31, the Edge at 119 tests, contracts at 199 and the API at 889. The runbook `docs/operations/credentials.md` rotates only the token's secret (the Client ID stays; deleting the token is how Access revokes, and takes the new secret with it) and records that the token expires after its duration and needs a Refresh. Not done: the Access applications and policies themselves, the secrets on the deployed Edge and any live request; until they exist nothing changes on the wire |
| Cloudflare Access in front of the node gateways, live on EU1 (2026-10-18) | The Zero Trust organization (free plan) exists. `scripts/operations/setup-access.ts apply` created the Access application `pgcf node gateways` for `pgcf-node-*.<domain>` with one Service Auth policy for the service token `pgcf-edge-dev`; a second plan changed nothing. The Edge (deployed from `6d899949`) presents the token. Checked from outside: an unauthenticated GET of the gateway hostname answers **401 from Cloudflare** (`/healthz` and `/pg`), and so does a request with a wrong token; SQL through the Edge works. Warm connect time through the probe Worker before and after (14 calls each against one awake database, 1.5 s apart): service binding p50 173.5 → 124.5 ms (max 528 → 180), public hostname p50 248 → 133.5 ms (max 544 → 282): **no measurable cost**; the second run came later on warmer isolates, so this is no speed-up claim. Not done: the operator shell application (`--shell`), the browser or `cloudflared access` login of an operator, the Workers VPC A/B |
| Package lock refreshed past DSA-6568-1 and DSA-6566-1 on branch `sec-lock` (2026-10-18) | `infra/node-image/packages.lock.json` moved from snapshot `20261016T000000Z` to `20261016T133910Z`, the first snapshot.debian.org timestamp whose trixie-security index lists `linux-image-amd64` 6.12.113-1 and `libexpat1` 2.9.0-1~deb13u1 (checked on the 9 timestamps before it: `libexpat1` is 2.9.0 from `20261016T061025Z`, the kernel only from `20261016T133910Z`). Four of the 220 packages differ in version (every one of the 210 snapshot.debian.org URLs carries the new snapshot; the 9 apt-archive.postgresql.org URLs and the cloudflared GitHub URL carry none): `linux-image-amd64` and `linux-image-6.12.113+deb13-amd64` 6.12.113-1 (were 6.12.111-1), `libexpat1` 2.9.0-1~deb13u1 (was 2.8.3-1~deb13u1) and `libpq5` 18.6-1.pgdg13+2 (was `19~rc1-1.pgdg13+1`: apt takes the highest version, and the PGDG archive holds the next major version's release candidates). `mkosi.conf` pins `libpq5=18.6-1.pgdg13+2`; `validateLock` refuses any locked version that contains `~alpha`, `~beta` or `~rc`. `node-image.ts advisories` (builder container, `apt-get update` against the live `trixie-security`, `trixie-updates` and PGDG `trixie-pgdg`, Debian version order) is the new daily CI job `advisories` (05:23 UTC; manual dispatch with the input `advisories`). Checked on the laptop with Docker: against the previous lock (a scratch copy with only the `libpq5` version corrected, because `validateLock` now refuses its pre-release) it listed exactly `libexpat1` 2.8.3-1~deb13u1 → 2.9.0-1~deb13u1 and `linux-image-amd64` 6.12.111-1 → 6.12.113-1 and exited 1; against the new lock it printed "the lock is current". CI on `a69429b8` (workflow_dispatch on the branch): run 39167661690 green, `node-image` in 8 min 14 s with the offline build from the new lock and the boot test (26 s; both boots, the scratch database created in the first and found in the second), run 39167670638 (dispatch with the input `advisories`, only that job) green with "the lock is current". The release is not registered yet: the artifact that `register-node-image.ts` takes exists only for a push to `main`. `advisories` compares a package pinned in `mkosi.conf` only within its own major series: PGDG's `main` component carries `libpq5` from the newest major only (read on 2026-10-18: `main` lists `libpq5` 18.6, 18.4 and 18.3 from `postgresql-18`, component `19` lists 19~rc1, 19~beta4 and 19~beta3), so the PostgreSQL 19 release would have turned the daily job red for the deliberate `libpq5` 18 pin. Replaying the real `main` and `19` indexes through the check reports nothing for the pinned set, and `behindLock` reports `libpq5` 19 for an unpinned lock; the failure message now names both remedies (a newer snapshot for a Debian package, a raised `mkosi.conf` pin and then `resolve` for the PGDG set). CI on `a3a326da` (workflow_dispatch on the branch): run 39170581856 green (`check`, `node-image` in 6 min 48 s); run 39169505965 (dispatch with the input `advisories`, on the commit before it, which holds the same `lock.ts`) green with "the lock is current". Run 39169494725 on that earlier commit failed in `check` at `apps/api` `node-intake.test.ts`: the future usage row sat one hour after the current time, so in the last minute of a UTC hour its interval crossed into the next hour and the whole report failed validation; the test now pins the clock to the last half minute of an hour (red on the old row, green on the new one) |
| Image hardening on branch `sec-image` (2026-10-18; SEC-08 and the access items) | Each change has a test in `units.test.ts` that was red on the old tree. **Database unit:** after `@system-service` it denies `@keyring`, `io_uring_setup`, `io_uring_enter`, `io_uring_register`, `userfaultfd`, `msg*`, `sem*` and `mq_*` (the baseline `systemctl show` on the lab listed every one of them as allowed); `shmget`, `shmat`, `shmdt` and `shmctl` stay; `/dev/shm` is `noexec,nosuid,nodev`. On the lab (systemd 257.13, PostgreSQL 18.6, the image's locked versions) the unit starts, an 8-client pgbench run of 8 s processed 53,069 transactions and a parallel query launched 2 workers, with no SIGSYS; each denied call, tried in a copy of the unit, died with SIGSYS (signal 31), while `shmget` and `getpid` returned. **Kernel and files:** `kernel.io_uring_disabled = 2` and `dev.tty.ldisc_autoload = 0`; tmpfiles keeps `/var/lib/pgcf/db` at 0711 (it set 0755 at every boot while the agent creates it 0711). **Access:** on the lab, systemd's ssh generator had bound sshd to `/run/ssh-unix-local/socket` with mode 666; it is masked in `/etc` and `systemd.ssh_auto=no` is on both kernel lines (the generator emits nothing with it). sshd takes only user certificates: no CA key ships, so no login is possible until one is written (open, 11.2); the principal is `pgcf-break-glass`; an empty revocation list ships, because sshd refuses every key when that file is missing. On the lab a certificate login was refused without the CA, with another principal, with a revoked serial and with the list missing, and accepted with the CA and the shipped files. journald syncs every 15 s. **CI:** run 39167858828 on `8f2ff63d`, `check` and `node-image` green; the boot test passed both boots with the new checks (`database_unit_syscall_filter`, both sysctls, mode 711, `no_ssh_socket`, `sshd_policy`, `sshd_certificate_only`, `journal_sync_interval`) in 29 s. Not on a node yet: EU1 runs the previous image (11.2) |
| Wake node path without a process, on branch `wake-node-path` (2026-10-18) | Live on EU1 the `admission` step of a wake took 99–208 ms (p50 about 140) where the plan estimated 1–5 ms: the wake asked `has_volume` and `needs_repair`, and each ran `lvs`, which reads every volume. `Storage` now keeps the last `lvs` list (the node sample reads it every 15 s; the first question reads it otherwise). **Only a yes comes from it:** the list shows the volume as this database's, the kernel has its device node, and ext4's error count at the device's minor decides repair; a volume the list does not show, a suspect tag, a filesystem that is not mounted, a list older than 20 s, and a list read before an lvm2 command that may change a volume has ended (every `lv*`, `vg*` and `pv*` command but the three reports, and the health check, which tags volumes in a process of its own) are all read from lvm2 as before. A wake result and event name the steps of the admission: `volume_check`, `repair_check`, `config` and `archive` beside `mount`, `pg_control` and the unchanged `admission` (`WAKE_PHASES`; the API's `node_wake` log carries them). Looked at and left alone: `refresh_configuration` already skips the write when the configuration's hash is unchanged (13 µs a call), `ensure_archive` is in memory (2 µs), and the D-Bus start waits for the unit's job with no polling. The user lookup in `/etc/passwd`, twice per wake, no longer allocates for every line: 198 µs to 28 µs with 1,100 users. Tests first: three wakes' worth of questions ran `lvs` six times before the change and once after; the wake events with the new steps failed the contract check, as did the API's `node_wake` test. Lab, privileged Linux container with real LVM on a loop device, 15 runs each, p50: `exists` plus `needs_repair` took 65 ms with 1 volume (30.8 + 34.6), 64 ms with 100, 110 ms with 500 and 217 ms with 1,000 (107.4 + 110.0); with the list in hand 0.03 ms with 1 volume and 0.02 ms with 1,000. All 20 storage lab tests pass, among them one that counts `lvs` runs and one that warms the list before the pool fills and expects the suspect tag to win. **Not measured:** the live `admission` step, which needs a node release, and the API built from this branch must be deployed before it: the API refuses an event with a step it does not know (`invalid_request`), and the agent drops a refused batch, with the `admission` counts in it |
| Cold DatabaseActor measured, and the Worker made lighter for it on branch `wake-actor-cold` (2026-10-18) | **Method.** Scratch Workers on the Dev account (deleted afterwards): a caller Worker with a Durable Object binding to a class in another script and the `weur` hint, which is the Edge's call, and hosts of the class. The real `DatabaseActor` was primed with an idle-sleeper snapshot, so `admitWake` answers a wake ticket from its own SQLite state with one durable write. Every sample is an object idle for 100 s, called once on a version deployed seconds before; 25–30 deploys per variant, two cold objects each, variants interleaved so that drift cancels; differences are the median of paired differences with a 95 % bootstrap interval. **Where the 230–549 ms go.** A minimal Durable Object (2.4 KB script, the same SQL) answers a cold call in 105 / 230 ms (p50 / p95, n=58). The Worker as deployed (1.96 MB, startup report 74–87 ms) takes 184–254 / 317–449 ms across runs (n=48–60), the range of the live logs. 173 of its 198 ms pass before `admitWake` starts (36 of 83 ms for the minimal object); the admission itself is not measurable (the clock does not advance) and the way back is 26 ms. Every cold object ran its own module instance (1,180 cold calls, 1,180 distinct instances), on a version never run before and on one already running alike: a cold actor loads and evaluates the Worker's whole script, it does not download it. Controls over a script of zod alone (85 ms): 1.55 MB of never-called function declarations add +118 ms (CI +100..+156), 450 schemas built at module evaluation add +77 ms (+64..+96), the old Worker +97 ms (+88..+111): the bytes loaded and the code evaluated both cost. **Tried.** The actor's D1 side made lazy, the Worker unchanged: no change (the other exports evaluate the same graph; startup 74 -> 76 ms). The Worker entry made lazy as well (router, cron, Workflow steps, the watchdog's alert domain; startup 80 -> 55–65 ms): -9 ms (-38..+4, n=60). Minify alone (1.96 -> 1.11 MB): -8 ms (-33..+8). **Both: -25 ms (-74..-15, n=60) and -28 ms (-57..-12, n=48)**; p95 369 -> 324 and 351 -> 301 ms; start of the method 173 -> 138 ms. A separate script for the actor, as it would be after the split (1.2 MB, startup 34 ms): -34 ms (-51..-24, n=60); minified (0.63 MB): -44 ms (-58..-19, n=58). **Shipped.** `database-actor.ts` evaluates only the contract modules and the snapshot schema its admission needs (`Timestamp` and `roleExpiryInstant` have their own contract module, `timestamp.ts`); the claim, the snapshot read and the hint load on first use (`database-actor-d1.ts`), so the awake path never evaluates them. The Worker entry exports classes that are light to evaluate: the router and the cron load on the first request or tick, the Workflows load their steps when a run starts (`workflows/entrypoints.ts`), the CronWatchdog loads the alert domain with its first alarm. The example API config sets `minify`, as the Edge's does; the deployed private config needs the same line. `scripts/ci/actor-admission-imports.test.ts` pins the static import graph of the actor and of the entry (red on the previous code); `workflow-entrypoints.test.ts` runs both Workflows through to their steps; the existing actor tests pass unchanged, and the whole API suite also passes with every module minified. CI run 39176047720 on the branch, merged with main, is green. **Correction (2026-10-19, review of `ee1e9e24`).** The first version of the lazy split moved nothing off a cold idle-sleeper answer: the claim starts in the microtask that returns the answer and its first `d1()` evaluates the module graph there, and the answer leaves the isolate only after the microtasks have drained. That graph was 79 modules beyond the Worker entry's own (`database-actor-d1.ts` -> `lifecycle.ts` and `admission-mutations.ts` -> `app.ts` for `ApiError`, and with it the router and the OpenAPI documents). The measured -25 ms came from the modules the path never reaches (cron, alerts, node installer, usage and backup cron, Workflow steps) and from minify, not from the D1 split. Now `ApiError` lives in `api-error.ts` and `powerTransitionStatements` in `domain/power-transition.ts`; the claim graph is 8 small modules beyond the entry's own, and `scripts/ci/actor-admission-imports.test.ts` pins that list (red on the previous tree, which listed 79 modules, `app.ts` among them). Local check, not the Dev scratch Workers: `wrangler dev --local` with a caller Worker and a host Worker whose Durable Object extends the real `DatabaseActor` (imported through the Worker entry, minified), primed with an idle-sleeper snapshot so that `admitWake` issues a ticket and starts the claim; a fresh process per sample, the caller's time of the `admitWake` call, 8 samples per variant, the control evaluating the claim's modules before the call. First answer in a fresh isolate, median (range): previous tree 13 ms (11-14) against control 6 ms (5-8); this tree 6.5 ms (5-7) against control 6 ms (4-7). No timer turn before the first `d1()`: the difference is inside the 1 ms resolution. Not re-measured: the Dev segment from method start to answer (45 ms in the scratch decomposition). CI run 39179280488 on `9a089469` (workflow_dispatch on the branch): `check` and `node-image` green. **Not done: the split** (a measured further -10 to -20 ms, and a production write). A second Worker script would export only `DatabaseActor` and bind `DB`, `DATABASE_ACTOR` (itself) and the API's `NODE_ACTOR` (`script_name`); the API and the Edge would bind `DATABASE_ACTOR` to it by `script_name`. The class and its storage move with Cloudflare's transfer in four deploys, each rolled out before the next: the API Worker with the class live, the new script with `state = "expecting-transfer"` and `transfer_from` the API, the API Worker with `state = "transferred"` and `transferred_to` the new script, then the new script with its binding and a live entry. It replaces `migrations` by `exports`, which cannot be undone for the API Worker, allows no gradual rollout and no rollback to a version from before. **Left.** The floor is 105 ms, and the NodeActor's contract barrel still costs about 20 ms of startup in every isolate; neither moves without a smaller script. |
| Maintenance cycle route (2026-10-18, branch `node-maintenance`) | `POST /v1/nodes/{id}/maintenance` closes placement and orders the cycle in one D1 batch, and `GET /v1/nodes/{id}/maintenance/{operation}` reads it (9.3). Migration `0075` adds `lifecycle_orders.placement_closed_at`; the batch that ends a `done` order reopens placement only if the node's close time is still the one the order wrote. Eight tests against the real D1 migrations (`node-maintenance.test.ts`: one open order that the node's page lists, a repeat while open answers the same operation, `done` reopens and `failed` leaves placement closed, `done` and `failed` each hint the node once to pull its whole page and a repeated answer hints nothing, a closure by an operator stays, a retry after `failed` takes over the closure, refusals for a node with other binaries than its region, no release, lost or fenced, wrong identity). A node whose placement a cycle closed is left out of the regional RAM window, as a node an operator closed is (`infrastructure-alerts.test.ts`). Full API suite 101 files, 904 tests. **Not run on a live node**: the live cycle is in 11.2 (Stage 4) |
| First live binary update of EU1 and the cold request after it (2026-10-19) | Release `sha-c46d838c3162` (main `c46d838c`: no lvm spawn on the wake path, node events, lighter DatabaseActor Worker, refreshed package lock, hardened image, firewall step) was registered (the image 275 MB and four binaries to R2, spec sha256 `ae35eca4…`) and assigned to the region with the compare-and-set `PUT /v1/regions/eu-dev/release`; the API with its two migrations and the Edge were deployed first. **11 s after the assignment the agent restarted** (`agent_started`, node uptime 5.6 h) and the node reported the new release; the node's samples had no gap, and SQL kept working. The first live `node_event` and the new wake phases arrived in Workers Logs. Wake phases (API log `node_wake`, 15 cold wakes after the update): **admission 1–4 ms** (before: p50 130 / p95 203 ms; `volume_check` 1, `repair_check` 1, `config` 1, `archive` 1), start 171–329 ms (p50 about 220), node path (sum) 178–336 ms, p50 about 220 ms (before: 320 ms). Edge admission of a wake ticket: 18–26 ms for 11 of 15 and 112, 130, 152 and 633 ms for the four others (a cold DatabaseActor). Cold first request after at least 2 h of sleep (5 databases per arm, so no p95): Worker through a service binding 556 / 627 / 789 / 1,074 / 1,252 ms (median 789; before 807), Worker through the public hostname 688 / 933 / 989 / 1,072 / 1,182 ms (median 989; before 1,100), laptop (plain statements) 0.652 / 0.680 / 0.796 / 1.021 / 1.133 s (median 0.796; before 0.969), connect usable 0.511–0.668 s (median 0.616; before 0.746). The two binding samples over 1 s are the 633 ms cold actor and a start of 329 ms. **The first request as one HTTP `/sql` transaction (all steps in one request, cold, asleep 60–137 min):** through a service binding 472 / 525 / 590 / 596 / 626 / 630 / 662 / 784 ms (median 611, n=8, all under 1 s), through the public hostname 440 / 547 / 564 / 732 / 966 / 1,070 ms (median 648, n=6); a seventh public sample was refused by the gateway with 57P03 on the HTTP wake path (its cause is not known: the node events of the new release were not yet running) |
| SEC-03 nodes report their boot and OS identity on branch `node-os` (2026-10-19) | The hello carries `os` (`boot_id`, `booted_at`, `kernel_release`, `packages_sha256`); the contract, the Rust schema and shared vectors state the digest once (TypeScript `packagesSha256` and Rust `packages_digest` give the same sha256 for the vector's `dpkg-query` output, which holds an `rc` line and a kept previous kernel). `nodes` has the four `os_*` columns (migration `0072`), the NodeActor writes them with the hello, and `GET /v1/nodes/{id}` (and the list) returns `os` and `os_converged` against the region's release. `register-node-image.ts` computes `packages_sha256` of `packages` and `extra` and the one kernel of the lock, and the API stores both in the immutable spec. Differences from the research text: the page's `release.os` does not carry the two expected values (an agent of an older build refuses a page with unknown fields, so a page that carried them would have cut off the update); `uname -r` is read from `/proc/sys/kernel/osrelease`; kernel images that are not running are left out of the node's digest, because Debian keeps the previous kernel and the cycle does not remove it, so the digest would never match again after the first kernel update; migration `0072` deletes the registered releases and their region assignments, which lack the new facts and cannot be read as the new spec (as `0063` did), so the build is registered again and assigned from revision 0. A maintenance cycle says the digest of what it installed whenever it does not reboot the node, also when it failed after installing (a reboot that fails leaves the new packages on a node that did not boot), because a stale digest could equal the spec of a release the region is rolled back to. An agent of the previous build keeps pulling its page every 60 s while the new API closes its hello without `os` (the link is down for it, the pull is not), so the new binaries still arrive. Locally green: contracts 204 tests, API 891, scripts 59, node agent 367 (`--test-threads=4`; the maintenance tests assert the hello after a cycle without a reboot, after a reboot and after a reboot that failed), lint, format, typecheck, the generator checks, cargo fmt and clippy (also on Linux for the `cfg(linux)` code) and Mermaider |
| SEC-05 nodes report the journal of the previous boot on branch `node-boot-journal` (2026-10-19) | After every reboot the agent posts the tail of the previous boot's journal. When `/proc/sys/kernel/random/boot_id` differs from the boot it stored in `agent/boot-id` (or it stored none), the agent runs through the `Machine` trait, with no shell, `journalctl --no-pager --output=json --boot=-1 --lines=1000 _SYSTEMD_UNIT=pgcf-agent.service _SYSTEMD_UNIT=pgcf-gateway.service _SYSTEMD_UNIT=pgcf-cloudflared.service _SYSTEMD_UNIT=systemd-networkd.service + _PID=1 + _TRANSPORT=kernel`, keeps `at`, `unit`, `identifier`, `transport`, `priority` and `message` (cut at 2,048 bytes) of each line, drops the oldest lines while the body is above 1 MiB, and posts it signed as `NodeBootReport` to `POST /node/v1/diagnostics`; it stores the boot only after a 2xx, so a failed post is repeated at the next start. The API keeps the report in `node_diagnostics` (migration `0073`, which also widens the alert kinds), reads `expected_reboot` from the node's `lifecycle_orders`, raises `node_unexpected_reboot` while a report of the last 24 h says false, deletes reports after 30 days in the `health_alerts` step of the minute cron, and shows them to an administrator at `GET /v1/nodes/{id}/diagnostics` and `…/{diagnostic_id}`. **Checked on a Debian trixie container with systemd 257.13**, the version of the image, started twice over one persistent journal with a different kernel boot ID each time: the argv returned the agent's, PID 1's and the kernel's lines of boot -1 and none of the stdout of a unit outside the matches; on a journal of one boot it exits with status 1 and `No journal boot entry found for the specified boot (-1).`, which the agent reads as no earlier boot; a message that is not UTF-8 is an array of bytes in the JSON. `previous-boot.jsonl`, the fixture of the tests and of the `Local` machine, holds lines of that output. Differences from the research text: (1) `boot_report_due(stored, current)` takes the two arguments the text gave, so whether a previous boot exists is not an input: a node with nothing stored is due, and the journal says there is no boot (status 1), in which case nothing is posted and the boot is stored. (2) `previous_boot_id` is the boot the agent stored, and `expected_reboot` is null (the column is NULL, tied by a CHECK to `previous_boot_id`) when it stored none; otherwise the first report after the agent update of every node would raise the alert for a reboot that may be days old. (3) The lines of a tenant are dropped by `_SYSTEMD_UNIT` and by `UNIT`: with this argv no line of `pgcf-pg@` or `pgcf-job-` comes through `_SYSTEMD_UNIT`, but PID 1 writes about those units as `_SYSTEMD_UNIT=init.scope` with `UNIT=pgcf-pg@…` or `UNIT=pgcf-job-…`; both prefixes are the constants the agent names its units with. (4) An integrator key gets 404 as the text says; the other administrator-only node routes answer 403 (`publicRouteErrors` records the difference). (5) `SyncIntervalSec=15s` was in the image already (`8f2ff63d`, with its unit and boot test), so the drop-in has no diff. (6) The purge is part of the existing `health_alerts` step, not a step of its own. The last sample of the previous boot is the node's newest (`last_observed_at`) until this boot's hello is stored; the hello of a new boot copies it into `nodes.os_previous_observed_at` (migration `0073`), and the report is read against that column from then on, however late it comes; an order made after it, while the node was down, is not blamed. The whole 1,000-line capture (827 of the lines are the lab VM's kernel ring) sanitizes to 990 entries and a report of 176,090 bytes that the contract accepts. Tests written first and failing before the code: eight of the first nine Rust tests (the report due, the sanitizing, the cap, the single upload with a refused first answer, no earlier boot) failed against a skeleton whose bodies were `unimplemented!`, and twelve of the first thirteen API tests failed against the unchanged API; the tests of the `journalctl` outcome, of a journal that lost the boot, of the service wiring and of the largest report came with the code. Mutating the rule (no clamp, no creation bound, only open orders) fails 1, 1 and 2 of the API tests. Locally green: contracts 208 tests in 18 files, API 905 tests in 100 files, node agent 379 tests and 6 ignored kernel tests, Rust workspace 514 tests, scripts and node-image suites, typecheck, eslint, prettier, plan privacy, the generator checks, `cargo fmt`, `cargo clippy -D warnings` (also on Linux, in a Rust container, for the `cfg(linux)` code) and Mermaider. CI (workflow dispatch on the branch, run 39178636443, commit `3f1acde2`): green on the rerun. The first attempt failed in one API test, `node-actor.test.ts` "writes the last minute when its alarm rings, and not twice" (expected 2 samples in the minute, got 1), a wall-clock test of the NodeActor's alarm that this branch does not touch and that passed in five local runs; the rerun of the same commit passed. **Review fixes (2026-10-19).** (a) The backup-job filter matched `pgcfbackup`, which no unit of the agent starts with: the agent names a job `pgcf-job-<kind>-<database>-<sequence>` (`archive::job::UNIT_PREFIX`, now also the filter's prefix) and PID 1 logged `Started pgcf-job-… - [systemd-run] /usr/bin/barman-cloud-…` with the whole barman command line (endpoint, archive path, the `pgcf_backup` role) for every job. On the lab (systemd 257.13), run with the arguments `systemd_run_arguments` builds and a stub in place of barman, a WAL upload that succeeded gave 2 such PID 1 lines and a base backup that failed 3; a job that outlived its `RuntimeMaxSec` gave 3; all carry `UNIT=pgcf-job-…`, and a job's own output goes to `systemd-run` (`--pipe`) and not to the journal. `previous-boot.jsonl` holds those 5 lines in place of the invented unit; the test was red before the fix (15 entries, not 10). (b) A failed job's line in the agent's log (`archive_failed` and its siblings) carries the last 400 bytes of barman's stderr, and the report took it as written; an event line of `pgcf-agent` now goes through `events::sanitize`, as in the observation report, and a panic or another plain line stays as written. (c) The report read the clamp to `os_booted_at` and so counted an order made while the node was down once this boot had said hello and sampled (the test, through a real hello and sample, was red); the hello of a new boot now keeps the previous boot's last sample in `nodes.os_previous_observed_at`, so a late or repeated report gets the same verdict. (d) `node_diagnostics` is unique per node and boot ID and a second send is answered with the stored row (red before: two rows, and the verdicts could differ). The three new tests and the changed fixture were red on the old code. Locally green: contracts 208 tests, API 907, node agent workspace 515 tests and 6 ignored, `cargo fmt`, `cargo clippy -D warnings` (also on Linux in a Rust container, where the 38 tests of the report, the jobs and the archive server passed), the generator checks, typecheck, eslint, prettier, plan privacy and Mermaider. CI (workflow dispatch on the branch, run 39184290727, commit `5b20daf7`): green, `check` and `node-image`. **Not run: the live checks** (11.2) |
| SEC-09 nodes answer read-only probes on request on branch `node-diagnostics` (2026-10-19) | An administrator's `POST /v1/nodes/{id}/diagnostics` (`probe`, `boot` 0 or -1, `since_seconds` 60 to 86,400, `lines` 1 to 2,000) answers `202 {diagnostic_id}` and keeps the request with the id of the asking key in `node_diagnostic_requests` (migration `0074`); an integrator key is told 404 and nothing is kept. The node's desired page lists the open requests as `diagnostics` (at most 8, the oldest first, unanswered and under 10 minutes old; left out when there are none, and from a wake's pull of named databases), the agent runs each once through the `Machine` trait with no shell and posts a `NodeProbeResult` (`kind` probe) to `POST /node/v1/diagnostics`, and `GET /v1/nodes/{id}/diagnostics/{diagnostic_id}` says `requested`, `received` with the `body`, or `expired` (plan 9.9; runbook in `docs/operations/recovery.md`). **Checked on a Debian trixie container with systemd 257.13 as PID 1**, the version of the image: all eight argv ran as built, and the fixtures of the tests and of the `Local` machine (`apps/node-agent/src/diagnostics/probe/`) are their output. What the lab showed: the kernel's boot ID is the host VM's, so the second boot of `journalctl --list-boots` was made by bind-mounting another ID over `/proc/sys/kernel/random/boot_id` and restarting journald; `journalctl --since=-3600s --lines=24` with the matches of the boot report returned the 24 newest lines, 3 of them PID 1's lines about a failing `pgcf-pg@…` unit (`UNIT=`), which the sanitizer drops, and `systemctl --failed` listed that unit too, which the text filter drops; `lvs --reportformat json -o … pgcf/pgcf_thinpool` on a real LVM thin pool on a loop device prints the report on stdout, and for a pool that is not there it exits 5 with the error in the JSON `log` array on stdout and nothing on stderr, so a failed result carries stdout as well as stderr; `journalctl --boot=-1` on one boot exits 1 with `No journal boot entry found`. Differences from the research text: (1) The result is kept in the request's own row (`received_at`, `body`), not in `node_diagnostics`, whose `kind` CHECK allows only `boot` and whose widening is a table rebuild in a migration that is not mine. The upload route therefore has two body shapes, told apart by `kind` (a boot report has none), `GET …/{diagnostic_id}` serves both ids (a probe's first, else a report's), and `GET /v1/nodes/{id}/diagnostics` still lists boot reports only. (2) The migration is `0074`: `0071` is the highest on `origin/main`, but the base branch already holds `0072` (SEC-03) and `0073` (SEC-05); the integration step renumbers if another branch takes `0074` too. (3) `boot`, `since_seconds` and `lines` are optional in the request (defaults 0, 3600 and 200). `journal` uses all three, `kernel` `boot` and `lines`, the others none, as the argv of the research text has it; all three are range-checked for every probe, by the API (400) and again by the agent. (4) A command that ends with a status other than 0, cannot be run or does not end in 30 s gives a result with status `failed` and the status and output as `text` (of `journal` and `kernel` the status and stderr only), so the administrator is answered; the research text did not say. (5) The 30-day deletion is not a step of the minute cron: `usage-cron.test.ts` and `admission-cron-bounds.test.ts` hold the whole cron to 850 statements, it was at 850, and one more DELETE failed both with 851. The next request for a probe deletes the rows older than 30 days in the same batch as its insert. (6) "Never includes `pgcf-pg@` units" is read as in SEC-05: the lines of those units and PID 1's lines about them are dropped, and in a text every line that names one. A kernel line that names a database's cgroup (an out of memory kill) is kept: it holds the database's identifier and nothing of its data. (7) A result that arrives after the request expired is kept (`received`): the node ran the probe, and the page no longer lists the request. The SEC-05 sanitizer gained a `max` (the newest 2,000 lines of a probe, not 1,000), its fitting loop became `newest_within`, shared with the boot report, and `JOURNAL_ARGUMENTS` became `journal_arguments(boot, since, lines)`, which the boot report calls with its own values (the argv of the report is unchanged, its test is the same string). Tests written first and failing before the code: all 13 new API tests failed against the unchanged API (the 16 of SEC-05 passed), and 16 of the first 17 Rust probe tests failed against a skeleton whose bodies were `todo!()` (the 17th tests the shared fitting loop); the service test (a request runs once, is not run again by repeated pages or by a restarted agent, and runs again after a result that was refused) timed out for its result before the wiring; the page parsing, the contract's size rule and the contract tests came with the code. Mutating the rules fails the tests: lines clamped instead of refused 1 Rust test, tenant lines kept 2, the whole `/proc/stat` 1, expired requests on the page 1 API test, any key may ask 2, a second answer replaces the first 1. Locally green: contracts 212 tests in 18 files, API 920 in 100 files, node agent workspace 535 tests and 6 ignored kernel tests (20 new: 18 probe, 1 page, 1 service), CLI 31, scripts 59, node-image 27, typecheck, eslint, prettier, plan privacy, the generator checks, `cargo fmt`, `cargo clippy -D warnings` (also on Linux, in a Rust 1.99.0 container, for the `cfg(linux)` code) and Mermaider. A full API run under load (the Rust suite and a Docker teardown running beside it) failed one SEC-05 test, `node-diagnostics.test.ts` "is not blamed on an order made while the node was down, also when this boot has said hello and sampled, or its agent restarted", with `sample_not_stored` (its helper waits 2 s for the NodeActor to store a sample); the file passed 5 of 5 alone, and the full suite passed in the run before it and in the one after. CI (workflow dispatch on the branch, run 39188932528, commit `a0622d35`): green, `check` and `node-image`. **Review fixes** (tests first where the behaviour changed): (a) a `journal` or `kernel` probe whose `journalctl` ended with a status other than 0 put its whole stdout, the raw JSON lines with `_HOSTNAME`, `_MACHINE_ID`, `_CMDLINE` and an agent event's stderr tail, into `text`, past the SEC-05 sanitizer; the test failed against the unchanged code and now both probes send the status and stderr only (the `Local` machine can damage the journal; its stderr line is from systemd's source, because the lab's `journalctl` read journal files with random damage and ended with status 0, so the trigger itself was not reproduced); (b) the fixture `probe/pool-missing.txt` is captured again with the argv as built (`lvs` of LVM 2.03.31 in a Debian trixie container, on a volume group `pgcf` with no `pgcf_thinpool`), and the test asserts `pgcf/pgcf_thinpool`; (c) the runbook said at most eight requests are open on a node: the API accepts any number, a node's page lists the eight oldest, and later ones wait and may expire; the OpenAPI text said `since_seconds` bounds both journal probes, it bounds `journal` only; (d) a probe for a node whose agent is older than this build makes its full desired pulls fail until the request expires, which the runbook and the live-acceptance row below now say. Locally green: the Rust workspace (536 tests, 6 ignored kernel tests), clippy, `cargo fmt`, API typecheck, eslint, prettier, plan privacy and Mermaider. CI (run 39191874979, commit `97d69dd6`): green, `check` and `node-image`. **Not run: the live checks** (11.2) |
| Node events reach Cloudflare without an observation, and the gateway's cold-wake stage marks, on branch `events-reach` (2026-10-19) | Built from the node-events review (9.9). (1) The report loop waits for the core's changes or for events in the agent's ring; `Core::take_report` returns a report of events alone (no database, no order, which `NodeObservationReport` and the API already accept) when the ring is not empty, and at most one such report goes a second (`events::ALONE_EVERY`; events that wait ride with the next observation report if one comes first; a report that was not accepted gives its events back and still counts toward the window). One report per 200 ms batch stays. (2) A connection held for a wake sends its marks to the agent as the new `FromGateway` message `conn_stages` (`node-local.ts`, regenerated `node-local.generated.json` with 12 new vectors that the TypeScript contract, the protocol crate and the agent's decoder all decide alike; the first Rust decoder accepted `null` for an absent mark and the vectors caught it). The gateway sends through a bounded queue of 64 of its own with `try_send`, and the channel's writer takes a mark from it only when no wake or answer waits (the marks do not share the channel's queue of 256 with them), so a flood of cold connections drops marks and delays neither a wake nor an answer, at most by the one mark being written; the agent logs the message as the event `conn_stages` (numbers and the outcome tokens; `database_id` when valid). Differences from the review's text, checked in the code: `agent_ms` is not forwarded (a nested map the ring drops, and the agent has the same steps in its `wake` event); `session_ms` is forwarded (the line is stamped when the connection ends, which for a long session is hours after the wake, and `session_ms` dates its start); `startup_ms` is how long the client took to send its startup message while held, so the wait for the wake is `wake_wait_ms`, then `dial_ms` and `first_backend_ms`. HTTP SQL requests (`sql_stages`) send nothing. Tests first: the ring window and the loop's wait (paused clock), `take_report` with events alone, the stage message against the shared vectors, the flood, the event's fields against the contract, and the held-wake integration test against PostgreSQL 18 (the two connections that waited for a wake send their marks, no other does). Locally green: fmt, clippy (native and wasm), the contract generator checks, 203 contract tests, 364 node-agent tests and the rest of the workspace; CI run 39174552302 on `events-reach` (commit `f868e015`, after the review fixes: the channel's writer writes wakes and answers ahead of the marks, and the live check (1) of 11.2 needs a node with no databases) green. On a laptop with macOS's 32 SysV shared-memory segments the node-agent suite fails 10 database-building tests at the default thread count and passes with `--test-threads=3` |
| The node observability branches integrated on `integrate-observability` (2026-10-19) | `node-diagnostics` (the chain `node-os`, `node-boot-journal`, `node-diagnostics`), `node-maintenance` and `events-reach` are merged in that order onto main `153ee614`; each branch was reviewed and fixed on its own. **Conflicts.** Plan: the rows of every side are kept, main's newer Stage 3, 4 and 5 rows win, and the maintenance route's live-acceptance sentence of `node-maintenance` is added to the Stage 4 row. The Mermaider files were taken from main and regenerated with the pinned tool, never merged. **Migrations.** The chain keeps `0072` (`node_os`), `0073` (`node_diagnostics`) and `0074` (`node_diagnostic_requests`), which follow main's `0071`; the `0070_maintenance_placement.sql` of `node-maintenance` collided with main's `0070` and is `0075_maintenance_placement.sql`, and the route's row above says so. **Generated files.** The four native generators and the installer generator were run in write mode on the merged tree and changed nothing; their `--check` passes. **One break the textual merge did not show.** Main moved `ApiError` from `app.ts` to `api-error.ts`; `lifecycle-orders.ts` (`node-maintenance`) and `node-diagnostics.ts` still imported it from `app.ts`, so `pnpm typecheck` was red while the merge was clean. Both import it from `api-error.ts` now. **Locally green on the merged tip:** `pnpm typecheck` and `tsc` of `scripts/ci` and `scripts/operations`, eslint, prettier, plan privacy, `cargo fmt`, `cargo clippy -D warnings` (native and wasm), Mermaider update and check, contracts 18 files and 214 tests, API 102 files and 931 tests, `cargo test --workspace --locked` with `TMPDIR=/tmp/na` at the default thread count (550 passed and 6 ignored: node agent 413, native gateway 80, native protocol 16), edge 119, cli 31 and the script tests 63. **Deploy order** for the live-acceptance rows below: the API with migrations `0072` to `0075` first (`0072` deletes the registered releases, so the registration of the SEC-03 row follows at once), then the agent; one `POST /v1/nodes/{id}/maintenance` opens the order that the SEC-03 and SEC-05 checks wait for. CI (workflow dispatch on the branch, run 39194339696, commit `6c5063b0`, the tip before this note): green (check and node-image). Nothing is deployed or accepted live |
| Review fixes of the integrated observability branches on `integrate-observability` (2026-10-19) | The adversarial review of the integration found six things; each was checked in the code and fixed with its failing test first. **(1) The capacity cron during a maintenance cycle (medium).** `startNodeMaintenance` closes placement on an online node, so the headroom check failed and `runNodeCapacity` reserved a node addition (an adoption, or an order once an hour, which a standing approval lets through). It now answers `maintenance` and buys nothing while a node of the region that is not lost holds an open maintenance order whose `placement_closed_at` equals the node's `database_placement_closed_at`. The offline half (the reboot) answers `maintenance` too, ahead of `observations_stale`. A closure an operator set, and the closure a failed cycle leaves, still buy as before. Test: `node-maintenance.test.ts`, which also covers the cron buying again once the cycle is done and for an operator's closure. **(2) Route labels and alert texts.** `DIAGNOSTIC_ROUTES` lacked the three diagnostics routes, so their failures were logged as `unmatched` like an attacker path; the same gap held for eight older routes (`/v1/nodes/:id`, `/v1/nodes/:id/database-placement`, `/v1/regions/:id`, `/v1/fleet/releases`, both `/v1/infrastructure-backups` routes, `/node/v1/archive-credentials/:id` and `/node/v1/openapi.json`); all are labelled, and a test compares every route the app registers with the set. The `node_unexpected_reboot` texts (the alert action, the `InfraAlertKind` description, the operational-health route and `infrastructure-backups.md`) and the reboot line of the probe runbook now send the operator to the list for the report with `expected_reboot` false and then to `GET /v1/nodes/{id}/diagnostics/{diagnostic_id}` for the journal tail, which the list does not hold. **(3) The boot report.** `previous_boot_id` is the boot of the lines (the `_BOOT_ID` of the journal, which journald prints as 32 hex digits), no longer the stored boot: with B1 stored, B2's report refused and the agent restarting at B3, the report now says B2. The stored boot is the fallback where the journal names none, and an agent that stored none still claims none. A report that Cloudflare could not take (network, 408, 429, 5xx) is sent again within the boot, waiting 2 s doubling to 60 s (`report_retry`, `report_retry_maximum`); any other refusal ends the attempt for this start, as before. The API keeps one row per `boot_id` and answers a repeat with the stored one, so the repeat is safe. **The API cannot tell a missed report, and no machinery was added for it:** a report whose `previous_boot_id` has no row of its own is also what the first reboot of a node looks like, because the first start posts nothing. An operator reads a gap from the list: the `previous_boot_id` of a row that is not the `boot_id` of an older row. **(4) `os_previous_observed_at`.** The hello that changes the boot now stores the newer of D1's `last_observed_at` and the newest sample the NodeActor holds (D1 holds the first sample of the running minute until the alarm, up to 65 s older), so a fast cycle is no longer judged unexpected and a crash soon after a cycle without a reboot is no longer expected. Test: `node-actor.test.ts` (two samples in one minute, a new-boot hello before the alarm, then a hello of the same boot). **(5) `os_converged` after a release that drops a package.** The cycle now purges after it installs: the installed packages the lock does not name, with `dpkg --purge` (dpkg refuses a package an installed one depends on, and no cascade removes a locked package), after `dpkg-query` marked the essential ones, which are left alone. Never a kernel image (Debian keeps the previous one for the boot menu and the digest leaves idle ones out), never a name that fails the pattern of `infra/node-image/lock.ts`, and nothing for a lock that names no kernel image, so an empty or truncated lock cannot empty the node. `pgcf-node-base` does not exist; the image has no first-party package, and `compareInstalled` fails the image build unless its installed set equals the lock, so a node from the image holds exactly the lock. A refused purge fails the cycle with `packages_not_installed`. Tests: `update.rs` (the set, the guards, the essential filter) and `service.rs` (lock B drops a package of lock A; after the cycle the digest equals the digest of B's packages, the idle kernel stays, no reboot). `Node::purge_packages` has only run against the Local double, never `dpkg` itself. **Checks run on the tip before this note:** `pnpm typecheck` and `tsc` of `scripts/ci` and `scripts/operations`, eslint, prettier, plan privacy, `cargo fmt`, `cargo clippy -D warnings` (native and wasm), Mermaider update and check (the manifest fingerprint changed with the sources), contracts 18 files and 214 tests (the native generators pass `--check`), API 102 files and 935 tests, `cargo test --workspace --locked` with `TMPDIR=/tmp/na` (556 passed and 6 ignored; node agent 419), edge 119 and its 2 node tests, cli 31, e2e 66 (2 skipped, none failed) and the script tests 63. The `apps/edge-rust` node test needs the Worker build and was not run here; CI builds it. One earlier run of the whole cargo workspace failed `a_start_that_outlasts_its_wake_and_then_fails_leaves_the_database_wakeable` (a 300 ms start deadline) while Prettier and Mermaider ran beside it; alone it passed three times, and the whole workspace passed on the rerun with nothing else running. CI (workflow dispatch on the branch, run 39198959320, commit `9419c195`, the tip before this note): green (check and node-image). Nothing is deployed or accepted live |
| Repair of the second review of the integrated observability branches on `integrate-observability` (2026-10-19) | A second review of the review fixes raised three findings; each was checked before it was fixed, and the code ones were fixed with their failing test first. **(1) A purge that dpkg refuses after a kernel install (confirmed).** `install_packages` installed, re-read the packages and purged before it rebooted. A refused purge therefore failed the order with `packages_not_installed` before the reboot, and the resubmitted cycle planned no reboot (the kernel was installed already), purged, and answered `done` on the old kernel; only `os_converged` false showed it. The reboot now follows the install at once and the cycle returns; the cycle that the agent runs for the order that is still open after the boot finds nothing to install, purges, checks and answers, so a refused purge fails the order on the new kernel and the resubmitted cycle purges and answers `done`. The purge also leaves out the packages whose `${Protected}` is yes. In a Debian trixie container without network (dpkg 1.22.22), `dpkg-query -W -f '${Package}\t${Essential}\t${Protected}\n' login libgcc-s1 bash` printed `login\tno\tyes`, `libgcc-s1\tno\tyes` and `bash\tyes\tno`, and `dpkg --purge login` and `dpkg --purge libgcc-s1` ended with "this is a protected package; it should not be removed"; the filter read `${Essential}` only. Tests: `update.rs` (`without_protected`; red first against the old filter, which kept `bash` and `login` in the list), `service.rs` (`a_kernel_reboots_the_node_before_a_purge_that_dpkg_may_refuse`: dpkg refuses the purge once; red first by timing out for the reboot; then the order fails with `packages_not_installed` on the new kernel and a second order is `done`, the package gone). `Node::purge_packages` has still only run against the Local double; the new query format is the one the container printed. **(2) A boot report that reaches the API before its boot's hello (confirmed).** The agent does not order the two (the link connects in the background, and the report goes after the first pull), so the API judged the report against `nodes.last_observed_at`, which lags the newest sample by up to a minute: with a sample flushed, an order made after it and a newer sample held only by the actor, the verdict was `expected_reboot` false and `node_unexpected_reboot` stood for 24 h. A boot report that claims an earlier boot and arrives while the node's `os_boot_id` is not its `boot_id` is now refused with 503 `capacity_exhausted`, reason `not_ready`, and `Retry-After: 5`; nothing is stored, and the agent's retry (2 s doubling to 60 s) sends it again after the hello, which stores the sample the actor holds as `os_previous_observed_at`. `rebootWasAsked` reads only that column. A report of an agent that knew no earlier boot claims nothing and is not held back. The OpenAPI text and status table of `POST /node/v1/diagnostics` name the 503. Test: `node-diagnostics.test.ts` drives the previous boot's hello, a sample, the order and a second sample (held by the actor) over the link, sends the report before the new hello (503, nothing stored, red first: it was accepted), then after the hello (`expected_reboot` true); the other tests of the file say the hello through the `reboot` helper, as the agent does. **(3) Texts (confirmed).** Plan 9.3 names the purge and the reboot before it, plan 9.9 the retry within the boot and the 503, and the SEC-03 acceptance row the purge after the boot; `infra/node-image/README.md` names protected packages; `docs/operations/recovery.md` says that until a cycle ends the capacity cron buys no node in the region at all, because the guard in `runNodeCapacity` never compares the shortage with the node under maintenance (a waiting database that no node could take, even with that node open, waits too). **Checks run on the tip before this note:** `cargo fmt`, `cargo clippy --workspace --all-targets -D warnings` and clippy of `pgcf-edge-rust` for wasm32, `cargo test -p pgcf-node-agent --locked` with a private `TMPDIR` and `--test-threads=6` (420 passed, 6 ignored), the other workspace crates (all passed in the `--no-fail-fast` run), the seven `packages/contracts/native/generate*.ts --check`, API 102 files and 936 tests, `pnpm lint`, `pnpm typecheck`, `tsc` of `scripts/ci` and `scripts/operations`, Prettier, plan privacy (0 findings), the script tests (63) and Mermaider update and check. Three full workspace runs on this laptop failed 2, 3 and 17 node-agent tests (`build_failed` while a database was built, `ArchiveTimeout`) while other sessions held 10 to 17 of the 32 System V shared-memory segments that macOS allows (`kern.sysv.shmmni`) for their own PostgreSQL servers; the failing tests differed from run to run and passed alone, and the run with six test threads passed whole. Not run here: the `apps/edge-rust` node test (needs the Worker build; CI builds it). CI (workflow dispatch on the branch, commit `24dc7ea2`, the tip before this note): the first run (39204157786) failed `agent::power::tests::a_database_sleeps_with_a_proof_and_wakes_through_admission_against_its_record` (the test gateway's `received()` had not yet seen the last message the agent sent; the test and `power.rs` are not touched by this change), and the rerun (39204855109) was green (check and node-image). Nothing is deployed or accepted live |
| First live maintenance cycle on EU1 (2026-10-19) | Main `5cb2a4e4`, release `sha-5cb2a4e4a97f` (kernel 6.12.113-1 from the refreshed lock, expat 2.9.0, libpq5 18.6, the hardened image files, node OS identity, previous-boot journal upload, read-only diagnostics, the maintenance route). Deploy order: the API with migrations 0072–0075 first (0072 deleted the registered releases), then the registration and the region assignment (revision 0 to 1) at 07:49:28 UTC; the old agent's hello without `os` was refused in between, so the node was without samples for about 7 minutes (the 275 MB registration took most of it). The agent restarted and reported the new release 12 s after the assignment and uploaded its boot report. `POST /v1/nodes/{id}/maintenance` at 07:53:54: placement closed, wakes held, the packages installed from the lock, the node rebooted, the check ran, the order was `done` at 07:55:02, **67 s in all**; the node reported kernel 6.12.113+deb13-amd64 and `os_converged` true 56 s after the call (the shutdown line of the journal is 07:54:27.6, the agent's start 17 s into the new boot) and placement reopened by 07:55:08. The reboot was recognised as asked for (`expected_reboot` true) and its report carried the previous boot's journal tail, 467 entries (pgcf-gateway 147, pgcf-agent 57, pgcf-cloudflared 31, kernel 16, init 212), which is the evidence the VM stall of 2026-10-18 lacked. Afterwards SQL through Cloudflare worked on a cold database (the ledger of the power-cut test intact: 3,040 rows) and the gateway hostname answered 401 without the token. The purge of packages a lock drops (`dpkg --purge`) was not exercised: this lock dropped none. Not yet run: the cold-wake comparison after the reboot, and the hardened image files (they reach a node only through a reinstall or the base package, SEC-07) |
| Wake attribution on branch `wake-attribution` (2026-10-19) | After `wake-node-path` the start (97–539 ms live, 99–184 ms in Stage 1) is the largest part of the node's time and had no split; `release` was written as 0 on every wake, and `refresh_roles` and `after_ready` were in no phase. **Phases.** `WAKE_PHASES` has `roles` (the page's roles written before anyone logs in, timed on its own); `release` is measured, from the end of `start` to the writer in the gateway's table, and holds `roles`, so `admission`, `queue_wait`, `start` and `release` are the top-level parts of a wake and `roles` is part of `release`. A wake of a database that already runs has no phases (it carried `release` 0). The CPU quota (`after_ready`) is set after the writer is published and is in no phase. **`wake_detail`.** For every wake that starts the unit (not a late start, not a running database) the agent spawns a task that is never awaited on the wake path; `Timing::detail` (2 s) after the release it emits one event through the node-events ring (`crate::timing::emit_event`, so it reaches Workers Logs as `node_event`), numbers only, 9 fields of the 16 the contract allows: `job_to_fork_us` (the service's `ExecMainStartTimestampMonotonic`, read over the agent's zbus connection, minus the agent's `CLOCK_MONOTONIC` just before `StartUnit`; systemd records there when it creates the main process, which is `systemd-executor` until it executes postgres, not when postgres is executed), `fork_to_handoff_us` (to `ExecMainHandoffTimestampMonotonic`, systemd 256 and later, read over the same proxy; it is when the executor is about to execute postgres, so this is the time of the unit's sandbox that systemd sets up: the new network namespace, the mount namespace of `ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`, the `/dev/shm` tmpfs, `ProtectProc`, the seccomp filter and the switch to the database's user), `handoff_to_starting_us`, `starting_to_shut_down_us` and `shut_down_to_ready_us` (journald's `__MONOTONIC_TIMESTAMP` of the lines of this invocation, from `journalctl -o json --output-fields=MESSAGE,__MONOTONIC_TIMESTAMP _SYSTEMD_INVOCATION_ID=<id>`, matching only `starting PostgreSQL`, `database system was shut down at` and `database system is ready to accept connections`; `units/journal.rs` returns the gaps and no message text, and a start that was a crash recovery writes no `shut down at` line and gives no gaps), `nr_throttled` and `throttled_usec` (the deltas of `/sys/fs/cgroup/pgcf.slice/pgcf-pg@<id>.service/cpu.stat` between the release and the read), and `steal_ms` with `steal_window_ms` (the delta of the `steal` column of the first `/proc/stat` line, summed over the cores, from just before `StartUnit`, after the admission queue, to the read, and the milliseconds in between; one clock tick is 10 ms). A field that could not be read is left out; a unit that started again in the 2 s has no gaps. The one addition on the wake path is a read of `/proc/stat` just before `StartUnit`, after admission (`start_unit` takes it, so the start of a new or a recovered database reads it too). **Lab, not EU1.** The journal fixtures (`apps/node-agent/src/units/fixtures/`) and the `cpu.stat` text of the sample test were recorded in a Debian 13 container with systemd 257.13 as PID 1 (arm64, the laptop's Docker VM, 6 vCPUs; `--privileged` with the container's own cgroup namespace, because the host's puts the units under a path other than the `/sys/fs/cgroup/pgcf.slice` that `cpu_stat_path` reads), the repository's own `pgcf-pg@.service` and PostgreSQL 18.6: a start after a clean stop (four lines) and one after `SIGKILL` of the postmaster (nine lines, no `shut down at`). The new lab test `a_start_has_a_timeline_of_the_fork_the_handoff_and_the_journals_three_messages` runs `Units::timeline` against that systemd and journal; each gap is a subtraction that gives nothing when the request, the fork, the handoff and `starting PostgreSQL` are not in that order, so the test's `Some` is the order (7 of 7 `units::lab` tests pass there, in three runs). Five starts: job to fork 12.5 / 2.4 / 2.2 / 2.5 / 2.2 ms, fork to handoff 15.0 / 27.2 / 30.5 / 33.8 / 22.4 ms, handoff to `starting PostgreSQL` 10.2 / 11.6 / 11.3 / 11.5 / 10.7 ms, then 2.9 / 1.6 / 1.5 / 1.6 / 1.4 ms to `shut down at` and 0.04 / 1.4 / 1.3 / 1.4 / 1.3 ms to ready. Of the 25–45 ms from the fork to the postmaster's first log line, 60–75 % (15–34 ms) are the executor's sandbox and about 11 ms are PostgreSQL's way to its first line, which is why the fork is not read as the exec: counted from `ExecMainStartTimestampMonotonic` alone, systemd's sandbox would be charged to PostgreSQL. These are laptop-VM numbers; they say that the instrument works and that the sandbox is the larger part there, not what Contabo's vCPU does. The gaps are journald's receive times: two lines PostgreSQL wrote in the same millisecond were 0.2 and 5.4 ms apart in the journal in two captures, so a gap of a few ms is not resolved. **Tests.** Red on `main`: the parser over the recorded journals (gaps of the clean start, none for the crash, none when any one of the three lines is missing, lines that are no JSON or whose message is bytes skipped, a handoff after the first line gives none); the wake with a changed password records `roles` > 0 and a `release` that holds it (`roles` was not a phase; the publish of the writer is real and too fast in that test to show that the `release` timer stops after it, so the test shows the writer in the table and `release` holding `roles`, not the order of the timer and the publish); a wake that waited 2 s in the admission queue has a `steal_window_ms` below its `queue_wait` (red before the baseline moved: 2512 ms against 2387 ms); the API's `node_wake` test, which gets 400 for `roles` on the old contract. Also: the `cpu.stat` parser on the text of a unit throttled by `CPUQuota=10%` in the lab (46 of 47 periods), the deltas (counters that went back give none), the line of the event through the node-events contract, and a wake that emits exactly one `wake_detail`, not before its delay, and none for a wake of a running database. **Deploy order:** the API with the new `WAKE_PHASES` first (it refuses a `roles` phase it does not know with `invalid_request`, and the agent drops a refused batch), then the node release. CI run 39189853499 (`workflow_dispatch` on `1b0f31da`): `check` and `node-image` green. **Not measured:** everything on EU1; see Open, Stage 5 |
| DatabaseActor admission without DDL on the read path, and one `actor_admit` line per admission, on branch `actor-admit` (2026-10-19) | **Found.** `admissionState()` ran `CREATE TABLE IF NOT EXISTS database_snapshot` on every call and `storedTicket()` ran `CREATE TABLE IF NOT EXISTS database_ticket` on every call (`saveTicket` called it again), so every `admitWake`, an awake one that writes nothing included, executed DDL. `sqlite3_stmt_readonly()` returns 0 for `CREATE TABLE IF NOT EXISTS` when the table exists and 1 for a `SELECT` on `sqlite_master` (checked on SQLite 3.51.0 through the C API). The workerd half is taken from the research synthesis and not re-read here: `ActorSqlite::onWrite` starts an implicit transaction and holds the output gate on the commit, so such an Actor answers only after a commit. **Changed.** Each instance keeps which of the two tables it has seen, read once with a `SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`; `admissionState()` finds no snapshot and `storedTicket()` no ticket when the table is not there, and `CREATE TABLE IF NOT EXISTS` runs only in `saveAdmissionState` and `saveTicket`, once per instance. What is written and when is unchanged. **Logged.** `admitWake` writes one `actor_admit` line after its result is known: `database_id`, `waiter_id` (the Edge's connection id, so it joins `conn_admission` on `cid`), `path` (`snapshot`, `ticket`, `ensure_awake` or `refused`), `reused` (for a ticket; null otherwise), `instance_age_ms` (the time since the instance was constructed: 0 when this call built it, the time since an earlier call did otherwise, which is usually a node report's publish), `isolate_actors` (Actors constructed in the isolate so far, this one included) and `at_ms`; never the role, a password or a token. **Correction (review of `6a2ddddb`).** The first version logged `fresh_instance` and `fresh_isolate`, which marked the first `admitWake` of the instance and of the isolate; a node report publishes the snapshot before any connect and builds the Actor, so a connect to a warm instance logged both as true (the branch's own test showed it: the awake database's snapshot was published before its first `admitWake`, and the test expected `fresh_instance` true). They are gone. There is no isolate age: `Date.now()` and `performance.now()` are 0 in the global scope of workerd (measured with `wrangler dev --local` and a scratch Worker; the handler's `Date.now()` was the wall clock), so a module-evaluation timestamp cannot be taken. `isolate_actors` 1 says the isolate had no DatabaseActor before this one; the isolate may have served other classes, so it is not proof of a new isolate. **Tests.** In `admit-wake.test.ts`, red on `c46d838c` and green now: an awake admission and a reused ticket run no `CREATE`, `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `DROP` or `ALTER` through `SqlStorage.exec` (the red run listed `CREATE TABLE IF NOT EXISTS database_snapshot` three times); an Actor with a presence and no snapshot or ticket answers and creates neither table; the `actor_admit` lines carry the expected `path` and `reused` and exactly the listed fields; a second test fakes `Date` and pins `instance_age_ms` (5000 for an Actor a publish built 5 s earlier, 0 for one the admission built, 7 after 7 ms) and `isolate_actors` (one more when a new Actor is built, unchanged otherwise), and was red against a constant age and against a counter that skips. The real Actor shares the isolate with the Edge in `apps/edge/test/edge.test.ts`, so its seven line counts now count every line but the `actor_admit` ones (a filter on `conn_admission` alone made the event assertion pass whatever the line was and stopped the counts from seeing any other line). Local: the API suite (100 files, 896 tests), the Edge suite (2 node tests, 119 Vitest tests), `pnpm typecheck`, lint, format and the `scripts/ci` tests pass; the Rust Edge Worker test needs `worker-build`, which is not installed locally, and ran only in CI. CI run 39186689253 on `85683239` (workflow_dispatch on the branch): `check` and `node-image` green. After the review (the age fields, the Edge filter, `origin/main` merged in): CI run 39189545213 on `21b21ca7` (workflow_dispatch on the branch): `check` and `node-image` green. **Not measured.** The effect on `admit_ms` (11.2, Stage 5). |
| Bench arms for a batched first request, on branch `bench-arms` (2026-10-19) | **Code and tests only; no live number yet (the measurement is in 11.2).** **Checked against the repository first.** Confirmed: the Edge serves `POST /sql` (`apps/edge/src/sql.ts`, the Neon driver's `neon()` and `transaction()`); the gateway holds a request that carries a v5 wake ticket through the wake (`wake()` in `apps/native-gateway/src/sql.rs`, logged as `wake_path` `cold`); `conn_admission` and `sql_admission` both log the Edge's `colo`; `GET /healthz` is answered before any admission. Different from the brief: the repository's probe Worker had no benchmark route (the header of `saas-bench` described a privately deployed Worker), so `/saas-bench` is new there, the `ws` arm included; the figures "statements 2–5 cost 96–324 ms" and "the public hostname costs 66–135 ms more than a service binding" are in neither the plan nor the code (the plan has +0.27–0.46 s for statements 2–5, about 300 ms more for the public hostname on a whole first request, and no measurable cost on warm connects), so nothing here relies on them; the driver's README documents `transaction()` as the way to send several queries in one non-interactive transaction and does not call it the fastest. **Built.** `saas-bench run --mode ws,http-batch,http-auth-then-batch` (default `ws`, `call` takes one): a database is cold once per idle period, so each round gives each database one arm and the arms take turns by round and by database; `--rounds` must be a whole number of turns, so each database meets each arm equally often. `ws` is unchanged (five round trips on `/v2`); `http-batch` is one `sql.transaction()` of the five statements, without the BEGIN and COMMIT that statements 4 and 5 carry on the WebSocket, because the driver supplies them (one round trip: first answer equals whole request, and there is no connect time); `http-auth-then-batch` is the session lookup as `sql.query()` and one `sql.transaction()` of the other four. `statements_ms` has one entry per round trip. Over HTTP, which has no connect step, a first request that fails in a way that tells of the connection (an admission refusal `53300`, a wake not ready `57P03`, a wrong password `28P01`, class `08`, or no SQLSTATE: a network or server error) is `failed_at` `connect`, as on the WebSocket, so failure locations compare across arms; a statement's own error names the statement (the first of a transaction). The request now ends at the last answer, not one clock reading later (the existing test's 120 ms became 110 ms on the same fake clock). The last line holds `arms`: per arm the summary and the verdict `{n, over_1s, allowed_over_1s, result}` on the whole request. Misses are failed calls (a call skipped because the database was awake included) and requests not under 1 s; `allowed_over_1s` is the exact binomial rule, the most misses that a p95 of 1 s would show with at most 5 % chance (59 samples allow 0, 93 allow 1, 124 allow 2, 153 allow 3, 181 allow 4); `too_few` below 59. On the laptop the HTTP arms use `neon()` with `fetchEndpoint` at `/sql` on connections of their own per call (a call's requests share one, none borrows a socket a neighbour warmed, as a WebSocket never does). The probe Worker (`scripts/e2e/probe/worker.ts`, route `/saas-bench`) takes `mode`, records its own `colo` (`request.cf.colo`) in every answer and `ws_open_ms` (when the socket opened) for a WebSocket call, and with `mode=healthz` makes two back-to-back GETs of `/healthz` on the public hostname and on an optional `EDGE` service binding (odd calls start with the binding; `ray_colo` is read from the `cf-ray` of each answer); `saas-bench healthz --samples n --idle-s s` drives it and prints the p50 and p95 of the first and the second GET per path; a sample with a GET not answered 200 (an error page answers fast) is not ok, counts in `failures`, stays out of the percentiles and makes the exit code 1. The session code the laptop and the Worker share is `scripts/e2e/src/saas-session.ts` (it replaced the laptop's own `open`); `safeProbeError` keeps `NeonDbError`, the driver's class for an error answered over HTTP. The rig's `/sql` shim (`apps/edge/bench/rig.ts`) answers a transaction as the gateway does (`{"results":[…]}` inside BEGIN and COMMIT, a 400 with the error fields on failure), so the HTTP arms run end to end through the production Edge on a real PostgreSQL; the shim still runs in the database "postgres", not in the one a startup message names, so the test loads the dataset there too. **Rate limits.** HTTP requests count in the buckets `["sql", database, role, network]` (120 per 60 s per Cloudflare location in the example configuration), `["sql", database]` (120 per 60 s) and, from a service binding, 1,200 per 60 s. One cold sample is 1 admission for `http-batch` and 2 for `http-auth-then-batch`, once per idle period of an hour or more, plus 1 or 2 per follow-up; `/healthz` takes none. The example limits would not refuse a run, so nothing is raised; Dev's configured values are private and were not read (11.2 says to check them). **Tests first** (each seen failing before the code): the batch (same five statements and row counts, no BEGIN or COMMIT), the round trips of each arm, a batch's `Timed` (first answer equals request, no connect time), the thresholds 59/0, 93/1, 124/2, an arm's verdict with failures as misses, the rotation, `--mode` and its balanced-design check, the Worker's answer (`colo`, `ws_open_ms`), the healthz pair and its summary, and the error class. **Locally green:** E2E scripts 89 tests (66 before the branch), among them the rig test through the production Edge in workerd on PostgreSQL 18 (the three arms from the command line, and the probe Worker's own code with Node's WebSocket and fetch); typecheck, eslint, prettier, plan privacy, Mermaider update and check (the manifest fingerprint moved). CI (workflow dispatch on the branch, run 39186783796, commit `b57c208c`): green, `check` in 17 min 30 s and `node-image` in 8 min 6 s. **Review on 2026-10-19, each finding checked before it was fixed:** (1) `healthz` took the time of any answer: a run in which the public hostname answered 403, 502 or 530 printed `ok: true`, exited 0 and put the error pages' times into the p50 and p95 that step (5) of 11.2 records; a sample with a GET not answered 200 is now a failure (not ok, out of the percentiles, exit 1), with a summary test and a command-line test with a 502, both red before. (2) Step (3) of 11.2 told to read the Edge's `colo` from `conn_admission` during the `healthz` runs, which write none (`/healthz` is answered before any admission); the step is reworded. (3) The threshold for 4 misses is 181 samples, not 182 (the rule first allows 4 at 181; 180 allows 3): the code was right and the row wrong, and the test now pins 152, 153, 180 and 181. (4) Nothing guarded the laptop's own connection per call of the HTTP arms (the suite stayed green with the driver's shared `fetch`); a test with a local `/sql` server now records the connection of each request and requires one connection per call and another for each follow-up, and it goes red when the per-call agent is removed. (5) The HTTP arms named `auth` for a refusal, a wake not ready or a network error on the first request, where the WebSocket arm names `connect`; they now name `connect` for those and keep the statement for its own errors (test red before). (6) origin/main (`153ee614`) is merged, both rows of 11.1 kept; E2E scripts 89 tests, typecheck, eslint, prettier, plan privacy and Mermaider green. CI on the fixed tip (workflow dispatch on the branch, run 39189635060, commit `14b9dde3`): green, `check` in 13 min 6 s and `node-image` in 8 min 26 s. |

### 11.2 Open

| Stage | Status | Next step |
| --- | --- | --- |
| 0 Wind down | In progress: documents and AGENTS.md done; the owner is stopping the control server | Credential rotation, test leftovers, worktrees (steps 4–6) |
| 1 Lab on EU1 | Done 2026-10-17 (11.1); the start path was rerun after review without a leftover CPU quota. Access not measured (the Zero Trust organization exists since 2026-10-18) | Lane C removes `ExecStartPre=` from `pgcf-pg@.service` and gives the backup slice a top-level name (Appendix C). The owner decides on the remaining node-path miss (up to 34 ms at p95 without `ExecStartPre=`, none in the rerun; sandbox depth, D13) and on D1 with the re-estimate in 3.1 (at today's cost per statement, the connect p95 may take at most about 0.10–0.34 s). The Access measurement can be made once the applications exist (connect p95 through Access against without) |
| 2 Clean main | In progress: steps 1–5 done on `stage2/clean-main`. Kubernetes-shaped names stay in the release spec, node observations, runtime attestation, the CNPG route target, the gateway and parts of the node agent until Stage 3 replaces them | Merge to main and one green CI run; then deploy the API with migration `0062` once the private Worker configuration has the same binding changes (step 6) |
| 3 Build | In progress: lanes A, C, D and E are on `integrate/stage3` (11.1); the gateway runs in local mode; AddNode sends the installer, the API serves the node's credentials and makes its Tunnel, and a node opens only with them | The hostnames of the nodes' gateways are public: Cloudflare Access (service token and application) or a Workers VPC binding in front of them is Lane E's choice by measurement; the account has a Zero Trust organization since 2026-10-18, and Access guards the gateways since 2026-10-18 (11.1; the Workers VPC alternative is not measured). A binary update restarts the gateway without draining it first (9.3). The apt, reboot and check steps of the maintenance cycle and the restart after the installer's reboot are tested against the Debian lab double and the Local machine, never on a live node (Stage 4). The RAM window of placement has no producer outside tests; `apps/node-agent/README.md` is not written (Appendix C); the holder rule for mounts of 7.11 (an exclusive holder file) is not in the agent; then the QEMU boot test and the release (Stage 3 acceptance) |
| 4 Install EU1 | Installed live 2026-10-18 (11.1); the node firewall check before the rescue is built and not yet run live (11.1, SEC-06) | The next Dev install or reinstall with the node firewall: external TCP port 22 times out during the rescue and after the reboot, the node enrolls, the Tunnel connects; External scan, the operator shell through Access (`setup-access.ts --shell`, with the break-glass sshd design), the binary update and the maintenance cycle with a kernel update. The maintenance cycle ran live on 2026-10-19 (11.1: 67 s for the whole cycle with a kernel install). Still to record: the first `57P03` "maintenance" refusal and the first wake served after the order ended (the first run took no client connection during the cycle), and the purge of a package a lock drops (this lock dropped none). **Operator shell CA:** nothing in the installer or the cloud-config writes `/etc/ssh/pgcf_user_ca.pub`, and the image trusts only a CA there with the principal `pgcf-break-glass`; the choice of CA and the principal mapping belong with the Access measurement. **Image hardening live:** the `sec-image` release reaches EU1 through the binary update (SEC-07) or a reinstall, plus a maintenance (SEC-02); then the Stage 5.1 acceptance (create, SQL, backup, PITR, delete) again, and at least 30 cold wakes before and after, read from the API's wake timing events: the `start` phase of `phases_ms` no worse than +2 ms at p50 and +5 ms at p95; both recorded in 11.1 |
| SEC-03 live acceptance | Code, tests and shared vectors are done (11.1); not deployed | Deploy the API with migration `0072` first, then at once register the build with `register-node-image.ts` and assign it to the region from revision 0 (the old releases are gone); until the new agent runs, the link of the previous build is refused, so the node sends no samples, shows stale after 180 s and takes no new database. Check `GET /v1/nodes/{id}` of EU1: `os.kernel_release` is `6.12.111+deb13-amd64` and `os_converged` is false against the SEC-01 release (its kernel differs); the agent of the previous build still pulls its page, takes the new binaries and then says the new hello. After the maintenance cycle of SEC-02: a new `boot_id` and `booted_at`, `os.kernel_release` `6.12.113+deb13-amd64` and `os_converged` true. The cycle purges the installed packages the lock does not name (11.1, review fixes), so a release that drops a package converges, after the reboot when the cycle installs a kernel; `dpkg --purge` has run only against the Local double, so watch the first cycle for `packages_not_installed` (a purge dpkg refused) and read the agent's journal. If `os_converged` stays false with the right kernel, compare `os.packages_sha256` with the release's `spec.os.packages_sha256`: the node holds an essential package the lock lacks (never purged) or lacks one the lock names |
| SEC-05 live acceptance | Code and tests are done (11.1); not deployed | Deploy the API with migrations `0072` and `0073`, then the agent of this build through the release registration of the SEC-03 row (the build contains SEC-03). The first start of the new agent has stored no boot: if EU1's journal holds an earlier boot it posts a report with `previous_boot_id` null and `expected_reboot` null, and nothing is raised. Then the maintenance cycle of SEC-02 reboots EU1 while its order is open: `GET /v1/nodes/{id}/diagnostics` lists a report with `expected_reboot` true whose entries hold the previous boot's kernel and `pgcf-agent` lines, and `node_unexpected_reboot` is not raised. The Stage 5.4 'reboot under writes' (a power cut with no order) must give a report with `expected_reboot` false and `node_unexpected_reboot` in `GET /v1/operational-health?scope=regions` within a minute; read the lines it holds. The report is sent again within the boot while Cloudflare cannot take it (2 s doubling to 60 s), and its `previous_boot_id` is the boot of its lines, not the stored one; block the API for one reboot (or refuse the first post) and check that one report arrives without an agent restart. Record both in 11.1. The 15 s journal sync is in the image since `8f2ff63d` and reaches EU1 only with SEC-07 or a reinstall; until then the report of a freeze on EU1 holds the journal as of the last five-minute sync. Read the first report of a node that archives WAL often: PID 1 writes 2 or 3 lines per backup job, and `journalctl --lines=1000` counts them before the agent drops them, so the report can hold far fewer than 1,000 useful lines; if it does, narrow the PID 1 match to the four reported units (`_PID=1 UNIT=…`), which also drops PID 1's lines without a unit |
| SEC-09 live acceptance | Code and tests are done (11.1); not deployed | Deploy the API with migration `0074` (after `0072` and `0073`), then the agent of this build through the release registration of the SEC-03 row (the build contains SEC-03 and SEC-05). Do not POST a probe for a node before its agent runs this build: an older agent's generated `NodeDesiredPage` has no `diagnostics` key and refuses the page (`Cloudflare desired page invalid`), so until the request expires, ten minutes later, the node takes no order from a full pull, the release that would update it included. Then on EU1, with an admin key: `POST /v1/nodes/{id}/diagnostics` for `boots`, `kernel`, `sockets` and `listeners`, each read with `GET …/{diagnostic_id}`, must be `received` with status `ok` within two pulls of the desired page (the hint makes the first, the full pull is the second); `failed_units`, `pool` and `pressure` too. `listeners` must show loopback TCP listeners and Unix sockets only, and its Unix sockets and `sockets` must say whether `/run/ssh-unix-local/socket` exists and whether `sshd-unix-local` or `sshd-vsock` are socket units (the image masks the generator that binds them, so none should be). An integrator key asking must get 404 and nothing runs. Record the outputs (the lines, never a database's identifier) and the time from `requested_at` to `received_at` in 11.1. If a probe is `failed` for a reason of the unit (the agent runs as root in the host namespace, so none is expected), `text` says which |
| 5 Acceptance | In progress (11.1): 5.1 create, SQL, backup, PITR and delete passed; 5.2 passed; 5.4 hard power cut passed; 5.8(b) passed; first cold data measured (median under 1 s through a service binding, about 1.1 s through the public hostname, p95 not yet claimable) | 5.1 roles, resize, full restore compare; 5.3 the gate: at least 59 cold samples per stratum with none over 1 s, from a Worker and a laptop, after the agent fixes of the wake path; 5.4 postmaster, agent and gateway kills, R2 blocked, systemd reboot; 5.5 storage; 5.6 overbooking and density; 5.8(a) raw volume. The unexplained VM stall needs the node events and diagnostics over the agent link; the live `admission` step again, with a node release that carries `wake-node-path`, after the API with the new `WAKE_PHASES` is deployed; **Wake attribution (`wake-attribution`, 11.1), live on EU1:** deploy the API with `roles` in `WAKE_PHASES` to Dev, then the node release built from the branch to EU1. Make at least 20 cold wakes of databases that slept at least a few minutes (from a Worker through the public hostname, as in 5.3; 20 more after 60 min or more of sleep if the cold page cache is to be told apart). For each wake read the `node_event` lines of Workers Logs: the `wake` line of the database (`step_start`, `step_roles`, `step_release`, `total_ms`) and the `wake_detail` line that follows it by about 2 s (same `database_id`). Record in 11.1 the p50 and p95 of `job_to_fork_us`, `fork_to_handoff_us` (systemd's sandbox), `handoff_to_starting_us` (PostgreSQL's part), `starting_to_shut_down_us` and `shut_down_to_ready_us` against `step_start`, and the share of wakes with `steal_ms` above 0, with the largest `steal_ms` and its `steal_window_ms`. State in that row whether the CPU quota throttled the login (`nr_throttled` above 0 within the first 2 s, and the `throttled_usec` of those wakes), and whether the slow wakes are the ones with steal. Without these numbers D13 is not reopened. A wake with no gaps is a crash recovery or a unit that started again within 2 s; **Small node changes (branch `node-small`, built and tested; the live measurements remain):** (1) the small-class trim: the boot test `pgcf-agent check` starts its 256 MiB scratch database with it, so a setting that PostgreSQL 18.6 refuses fails the check; then `SHOW` of the nine settings on a small database, the child processes of its idle postmaster (the logical replication launcher no longer runs), the `start` phase of `phases_ms` over at least 30 cold wakes before and after the release (p50 and p95), and the 5.1 PITR of a database that was backed up before the release into a small class, which needs the recovery settings of 7.8; (2) `noatime`: `/proc/self/mountinfo` shows it on a volume mounted by the release (a new database at once, an older one after the next reboot, as a mounted volume keeps its options), and the write bytes of the volume's device in `/proc/diskstats` over 5 minutes of the same read-only workload on a `noatime` and on a `relatime` volume; (3) `--noflush`: the write counters (writes completed and sectors written) of the pool's metadata device, the `pgcf-pgcf_thinpool_tmeta` device-mapper device with its `dm-N` line in `/proc/diskstats`, over an idle hour before and after the release, and optionally over a steady small write load on one awake database (not the pool's transaction ID, which only LVM changes), and one status call with and one without the flag, taken back to back, whose block counts must agree; (4) the reboot path: after a maintenance reboot, `fincore` of `/usr/lib/postgresql/18/bin/postgres` and `/usr/lib/systemd/systemd-executor` right after the `agent_started` event, the `start` phase of the first cold wake of each database after the reboot against the one after the earlier power cut, and no `start_path_not_warmed` event in the node reports. **Found while testing:** 7.8 lists `hot_standby = off` for a restore, but `recovery::settings` does not write it, so a restore into a class with a lower `max_connections` than its source aborts (reproduced against PostgreSQL 18.6); turning hot standby off is not a free change, as the restore's start returns when the postmaster reports `ready` and `Rebuild::promoted` then queries the recovering server; **Actor admission without DDL (branch `actor-admit`, 11.1), live part open:** on Dev, from the probe Worker through the Edge, 30 connects (one at a time, each closed before the next) to one awake database before the API deploy and 30 after, in the same colo (`colo` of `conn_admission`). Read `conn_admission` `admit_ms` p50 and p95 of each arm from Workers Logs and record both in 11.1; keep the change whatever the delta, because it removes a write. The first connect after the deploy meets a cold Actor unless a node report's publish built it first: read `instance_age_ms` in its `actor_admit` line (about 0 when the connect built the Actor) and report that sample apart from the 29 others. Then join the `actor_admit` lines of the second arm to their `conn_admission` lines with `waiter_id` = `cid`, and check that every line shows `path` `snapshot`; for a slow admission, `instance_age_ms` about 0 says it met a new instance and `isolate_actors` 1 that it met the isolate's first DatabaseActor; **Bench arms, live (code on `bench-arms`; nothing measured yet):** (1) deploy the probe Worker privately from `scripts/e2e/probe` (a `RUN_EXPIRES_AT` within 24 h, the `EDGE` service binding to the Edge Worker, deleted afterwards) and point `PGCF_BENCH_PROBE_URL` at its `/saas-bench` route. (2) Read Dev's limiter values (non-secret configuration): an arm run asks 1 or 2 `/sql` admissions per database per idle period (3.7 of the handover), far under the example's 120 per 60 s; a refusal shows in a line as `error.sqlstate` `53300` with `failed_at` `connect` and counts as a miss, and the limit is reported, not raised. (3) `saas-bench healthz --samples 30 --idle-s 0`, then `--samples 30 --idle-s 20`: the second run shows whether the first GET pays for a connection the second does not; the public path's location is the `ray_colo` of its answers and a binding call runs in the probe's own `colo`, which shows whether the public hostname leads to another location than the binding (`/healthz` is answered before any admission, so the Edge logs no `conn_admission` line for it; the Edge's `colo` in `conn_admission` and `sql_admission` comes from the runs of step (4), which reach the Edge by its public hostname). (4) `saas-bench run --databases <ids> --rounds <R> --idle-s 3600 --mode ws,http-batch,http-auth-then-batch` with `--via probe`, and again with `--via local` on another set of databases or on alternating idle periods (a database is cold once per idle period); the dataset has one scale, recorded; `--rounds` is a multiple of 3 and databases times rounds divided by 3 is the samples per arm and vantage: 59 allow no miss, 93 one, 124 two (60 databases and 3 rounds give 60). `--followups 2` adds the warm requests. (5) Record in 11.1, per arm and vantage: n, misses, the verdict, cold first-answer and whole-request p50 and p95; and the healthz first and second GET per path; then replace the note of 3.7 ("not yet verified") and the estimates of 3.8 in `docs/operations/integrator-handover.md` with the measured recommendation (HTTP `transaction()` for the first non-interactive request and WebSocket for interactive sessions, if the numbers say so) |
| 5 Acceptance: node events reach (live) | Built on `events-reach` (11.1), not deployed | After the next release on EU1: (1) restart the agent on a node with no databases (a freshly enrolled node, or one emptied for the test); Workers Logs shows `node_event` `agent_started` within about 1.2 s of the restart, which before this change never left such a node. On a node with databases the check cannot tell the new path from the old: the boot and the first pull queue an observation of every database, and `agent_started` rides with them, as does every full pull of the page (every 60 s). `observation_not_posted` does not repeat; (2) after a cold wake from 60 minutes of sleep, one `node_event` `conn_stages` per cold connection with `held_outcome` `released` and `wake_wait_ms`, `dial_ms` and `first_backend_ms`, joined to the `wake` event of the same `database_id`; a client that holds its connection open reports at its close; (3) a burst of cold connections does not raise the wake time and the agent's journal shows no dropped channel |
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
| 2026-10-18 | D13 settled: the full systemd sandbox stays (own mount and network namespaces, `ProtectKernel*`); a few milliseconds above the node-path target of 150 ms are accepted without rework, and the target is measured in Stage 5, not a gate. Go: execute the plan, then the owner looks at everything again |

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
| D1 | What gates go-live: the whole 5-statement request, or the first answer? By Stage 1's re-estimate, option C reaches a first-answer p95 of about 0.57–1.1 s and a whole-request p95 of about 0.84–1.57 s, depending on the Cloudflare connect. The whole-request gate also needs Lane E's Cloudflare work (3.1) | The whole request ("executed"). Both are reported, and the Stage 1 and Lane E numbers go to the owner before Stage 5 |
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
| Contabo vCPUs start PostgreSQL slower than the lab | Node path above 150 ms (Stage 1: p95 121–226 ms depending on the unit and the session, 11.1) | No `ExecStartPre=` in the unit; no CPU quota during start, cleared at every stop because a set quota persists; sandbox depth is D13; at most 4 starts at once |
| Cold page cache after days idle, especially at high density | A slower first statement and node path (Stage 1: +14 and +45 ms at p95 with the database's files evicted) | Volumes stay mounted; 5.3 runs at the 5.6 density; `pg_prewarm` only on an observed miss |
| Awake databases grow together under D3 (a) | An out-of-memory kill of a backend inside the slice; one database's sessions drop | Placement keeps 20 % headroom on measured peaks; per-database ceilings; crash recovery loses nothing; counted in 5.6; switch to (b) if it happens too often |
| Rescue cloud-init does not run `runcmd` | The pull install is impossible | Stage 1 confirmed that it runs `write_files` and `runcmd`; the fallbacks in 9.2 stay in case Contabo changes it |
| Firmware or network unknown | The image does not boot | Hybrid BIOS and UEFI image; static network settings; QEMU boot test with SeaBIOS |
| A bad kernel or package update | A node does not come back | One node at a time; previous kernel kept; VNC and rescue |
| LVM metadata area too small for many volumes | Volume creation fails (the default area fills near 1,450 volumes, Stage 1), and the area cannot be fixed in place | 64 MiB area at install (about 95,000 volumes); technical volume bound of 1,000 per node in placement (4.11) |
| barman too costly per WAL segment at density | Memory pressure in backup jobs; archive backlog | Per-job limits and 2 uploads plus 1 base backup or restore, set from Stage 1; the cost trigger holds, so the WAL path moves to a native PUT (7.5) |
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
- **Slice:** `Slice=pgcf.slice`. Weights and limits on the slice avoid the +20 ms per start and +58 ms per stop caused by toggling the cgroup `cpu` controller in `system.slice` (*measured (lab)*; the Stage 1 rerun on EU1 measured no such cost, 11.1).
- **Mount check:** `AssertPathIsMountPoint=/var/lib/pgcf/db/%i`. With `Condition…`, a start on an unmounted volume "succeeds" with the unit inactive (*measured (lab)*).
- **Stop and restart:** `KillMode=mixed`, `KillSignal=SIGINT`, `TimeoutStopSec=30`, `Restart=no`.
- **Limits:**
  - `MemoryMax` = memory, `MemoryHigh` = 90 %, `MemorySwapMax=0`, `TasksMax=64`;
  - `CPUWeight` by size (start cost: none in the Stage 1 rerun, at most 20 ms at p50 in the first session's sequential runs, 11.1);
  - `CPUQuota` set after ready and cleared (`CPUQuota=` infinity) when the unit stops: a set quota persists and throttles the next start (Stage 1);
  - `IOWriteBandwidthMax` and `IOWriteIOPSMax` by size.
- **OOM:** `OOMPolicy=continue`, `OOMScoreAdjust=-900`, `PG_OOM_ADJUST_FILE=/proc/self/oom_score_adj`, `PG_OOM_ADJUST_VALUE=0` (*measured (lab)*: postmaster -900, children 0).
- **Sandbox:**
  - network: `PrivateNetwork=yes`, `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`;
  - filesystem: `ProtectSystem=strict` with `ReadWritePaths` limited to its data and socket directories; `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `TemporaryFileSystem=/dev/shm:size=<from memory size>,mode=1777,noexec,nosuid,nodev` (without the mode PostgreSQL cannot create its segments; Stage 1);
  - kernel and processes: `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectControlGroups`, `ProtectProc=invisible`, `ProcSubset=pid`;
  - privileges: `RestrictNamespaces`, `RestrictSUIDSGID`, `NoNewPrivileges`, empty `CapabilityBoundingSet`;
  - system calls and memory: `SystemCallFilter=@system-service`, then `~@privileged @resources`, then `~@keyring io_uring_setup io_uring_enter io_uring_register userfaultfd msgget msgsnd msgrcv msgctl semget semop semtimedop semctl mq_open mq_unlink mq_timedsend mq_timedreceive mq_notify mq_getsetattr` (`@system-service` allows these, they are the usual second stage of a kernel exploit, and PostgreSQL uses none: `io_method=worker`, SysV shared memory, unnamed POSIX semaphores; `shmget`, `shmat`, `shmdt` and `shmctl` stay), `MemoryDenyWriteExecute=yes` (needs `jit=off`), `UMask=0077`;
  - IPC: `RemoveIPC=yes`, which removes the SysV segment a killed postmaster leaves behind (Stage 1 rerun, segments selected by uid, 11.1).
- **Start cost** (Stage 1, EU1, 11.1): the mount and network namespaces add about 47 / 30 ms (p50 / p95) per start on the committed unit without its `ExecStartPre=` and 34 / 56 ms on the lab unit (both in the first session, in separate sets about 66 minutes apart); every `ExecStartPre=` adds about 26–35 ms (p50; two interleaved sets in two sessions), because systemd spawns one more process through its executor; a per-unit `CPUWeight` in `pgcf.slice` cost nothing in the rerun and at most 20 ms at p50 in the first session.
- **Not set:**
  - `PrivatePIDs` and `PrivateIPC`: PostgreSQL's `postmaster.pid` interlock needs them off. The lab showed a second unit on the same directory being refused.
  - `unix_socket_group`: PostgreSQL would call chown, which the filter kills with SIGSYS.
- **Applying limits:** persistent `SetUnitProperties` at create and resize; never `daemon-reload`.

**PostgreSQL configuration:**
- `listen_addresses=''`.
- Socket directory `/run/pgcf/<id>`, owned by `pgcf-<id>`, mode 0750, with the gateway's group. The agent creates it at create and, because `/run` is empty after a reboot, for every database when the agent starts; never in the unit's `ExecStartPre=` (Stage 1: about 35 ms per start).
- A reboot empties the page cache, so when the agent starts it has the kernel read `postgres` and `systemd-executor` ahead (`posix_fadvise` `WILLNEED`) and runs `postgres -V` once, in a task of its own with a bound of 30 s; a failure is the event `start_path_not_warmed` with its class, never a delayed start. Kept volumes are still mounted at boot as before.
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
| `autovacuum_max_workers`, `autovacuum_worker_slots`, `io_workers` | 1, 2, 1 | Default |
| `max_parallel_workers_per_gather`, `max_parallel_maintenance_workers` | 0, 0 | Default |
| `max_worker_processes` | 2 | Default (8) |
| `max_logical_replication_workers`, `max_wal_senders`, `max_replication_slots` | 0, 0, 0 | Default |

Worst case for 256 MiB (*estimate*): 32 + 25 × (2 + 4) + 16 + 15 ≈ 215 MiB.

**Storage:**
- **Pool:**
  - `pvcreate --metadatasize 64m` (Stage 1: about 95,000 volumes, far above the technical bound of 1,000); VG `pgcf`.
  - Thin pool `pgcf/pgcf_thinpool` with `--chunksize 64K --zero y --poolmetadatasize 1G`, then `lvchange --errorwhenfull y` (lvm2 2.03.31 rejects that option at lvcreate for thin pools; Stage 1).
  - Verify zeroing with `lvs -o zero`.
  - About 95 MiB of pool metadata is needed for 128 GiB at 64 KiB chunks (*estimate*).
- **Per database:**
  - a thin LV with virtual size = storage, tagged `pgcf.db.<id>`;
  - `mkfs.ext4 -J size=8 -i 65536 -m 1 -E lazy_itable_init=0,lazy_journal_init=0`;
  - mounted 0700 `nosuid,nodev,noexec,noatime`, without `discard`, with `fstrim` after each clean sleep.
- **Full-volume recovery:** `tune2fs -m 0` once, and back to `-m 1` after the next resize or when use drops.
- **Sampling:** commands use `--reportformat json`. Pool status every 5 s (`dmsetup status --noflush`, so that the poll forces no commit of the pool's metadata, or the read-only `devicemapper` crate). Per-LV `data_percent`, and `df` space and inodes, every 60 s.

**Barman jobs:**
- Started with `systemd-run --uid=pgcf-<id> --slice=<backup slice> -p MemoryMax=<per job> -p InaccessiblePaths=<other databases, agent state>`, with `MemoryMax` 128M for a WAL upload, 128M for a WAL fetch and 256M for a base backup or restore (7.5).
- **Backup slice:** a top-level name without a dash, such as `pgcfbackup.slice`. systemd reads a dash in a slice name as nesting, so `pgcf-backup.slice` sits inside `pgcf.slice` (Stage 1: control group `/pgcf.slice/pgcf-backup.slice`); its jobs would then count against the awake-database limit, which 4.5 budgets separately. The agent's `BACKUP_SLICE` is `pgcfbackup.slice` (it was `pgcf-backup.slice`, a slice the image has no unit for, until 2026-10-19); a node-agent test reads the image's unit directory for the name and the `MemoryMax`, and the boot test reads the loaded slice's `MemoryMax`.
- Credentials: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `AWS_DEFAULT_REGION=auto` through `LoadCredential=`, read by a wrapper into the job's environment. Never `systemd-run -E` or `Environment=`: every local user can read those over D-Bus (Stage 1).
- `--endpoint-url https://<account>.eu.r2.cloudflarestorage.com` for the EU-jurisdiction bucket, and TMPDIR on node disk.
- Base backup: `barman-cloud-backup --gzip --immediate-checkpoint -J 2 --host /run/pgcf/<db> -U pgcf_backup -d postgres <dest> database`.

**cloudflared:**
- Command: `cloudflared tunnel --no-autoupdate --protocol quic --metrics 127.0.0.1:20241 run --token-file ${CREDENTIALS_DIRECTORY}/tunnel-token`.
- The token comes from `LoadCredentialEncrypted=`; `--token-file` exists since 2025.4.0.
- Ingress goes to the gateway and, only while the shell hostname is on (section 8), to `ssh://localhost:22`, both behind Access.

**Image:**
- mkosi settings: `Distribution=debian`, `Release=trixie`, `Snapshot=<fixed snapshot.debian.org time>`, `Format=disk`, `Bootloader=grub`, `BiosBootloader=grub`, `SourceDateEpoch`, `Seed`; no docs and no recommends.
- Partitions: BIOS boot (1 MiB), ESP (512 MiB), and a writable ext4 root of about 8 GiB that includes `/var`. `systemd-repart` adds the LVM partition over the rest of the disk at first boot.
- Binaries live in `/var/lib/pgcf/bin/<version>/`.
- Firewall: nftables drops inbound traffic except established flows and ICMPv6 neighbour discovery.

**Agent crates** (pinned in `Cargo.lock`, listed in THIRD_PARTY.md): `zbus_systemd`, `sd-notify`, `tokio-postgres`, `postgres-protocol`, and `devicemapper` (MPL-2.0, read-only use).
