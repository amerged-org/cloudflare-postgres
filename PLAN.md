# cloudflare-postgres — Plan

Status (2026-10-02): **reset.** The project has been redirected toward a lean, Neon-style service.
The first build produced mostly budget-enforcement, signed-execution and evidence machinery but no
database a client could connect to through the API. Those parts are removed. The Talos recipe,
the Flux platform baseline and the R2 backup/PITR recipe stay, because they work in the lab.
Nothing of the architecture below is implemented yet. Phase 0 removes the old code; Phase 1 builds
the first database through the whole chain.

This file is the canonical scope, architecture, roadmap and status. README.md summarizes it,
AGENTS.md is the contributor brief and THIRD_PARTY.md records component licenses.

## 1. Goal

An open-source, Neon-style serverless PostgreSQL service that anyone with a **Cloudflare account**
and **Contabo VPS** can run and scale horizontally:

- Databases are created, resized, suspended, restored and deleted through a versioned API.
- Every database is real, unmodified PostgreSQL (CloudNativePG on Talos/Kubernetes, local NVMe).
- All database traffic enters through Cloudflare. The VPS expose no PostgreSQL port.
- Databases sleep when idle and wake on the next connection.
- Every database is backed up to R2 continuously, with point-in-time recovery.
- Usage and the operator's own infrastructure cost are reported as **metrics**. The integrator
  (for example ohmyho.st) turns them into prices and credits. PGCF contains no pricing or wallets.
- Cloudflare places databases, watches capacity and adds Contabo VPS through the Contabo API.

First adopter: **ohmyho.st** replaces Neon with PGCF. Its plans, prices, credits, wallet and
adapter live in the ohmyho.st repository. The near-term target is OMH Dev, then OMH production
on PGCF.

## 2. Principles

1. **Cloudflare is the control plane.** Workers (API, edge proxy), D1 (state), Durable Objects
   (per-region link, per-database lifecycle), Workflows (long operations), R2 (backups), Secrets
   and Containers (node bootstrap jobs). Nothing on a VPS is authoritative except the PostgreSQL
   data. Regional components execute desired state and report observations.
2. **Cloudflare is the only way in.** Clients connect to an edge Worker. The region keeps an
   outbound Cloudflare Tunnel. No inbound PostgreSQL port exists on any VPS.
3. **Real PostgreSQL.** Upstream PostgreSQL images managed by CloudNativePG, one CNPG Cluster per
   database, local LVM volumes, Barman Cloud to R2.
4. **Metrics, not money.** PGCF reports usage and its own cost. There is no budget enforcement:
   integrators call `suspend`/`resume`.
5. **Generic.** No adopter names, plans or defaults in code. Size classes and policies are
   installation configuration.
6. **Smallest thing that works end to end.** Add machinery only for an observed problem.
7. **Delete, don't park.** Unused code, files and branches are deleted. Git history is the archive.
8. **Real systems.** No mocks or hardcoded data in product code. A phase passes only through its
   live acceptance run in Dev.

## 3. Architecture

The diagrams are in [README.md](README.md#architecture).

| Component | Runs on | Responsibility |
| --- | --- | --- |
| `apps/api` | Cloudflare Worker | `/v1` management API, API keys, D1 state. Durable Objects `RegionLink` (one per region; holds the agent WebSocket) and `DatabaseActor` (one per database; lifecycle, wake coalescing, idle timer, traffic counters). Workflows for create, delete, resize, restore and add-node. Cron for usage rollups, capacity checks and stuck-operation sweeps. |
| `apps/edge` | Cloudflare Worker | Data plane on `*.db.<domain>`: PostgreSQL wire protocol over WebSocket. Resolves the database from the hostname, asks `DatabaseActor` to ensure it is awake, then opens an upstream WebSocket to the region gateway through the Tunnel and pipes bytes. Reports bytes and connection events. |
| `apps/regional` `agent` | Kubernetes Deployment (1 per region) | Holds an outbound WebSocket to `RegionLink` and pulls full desired state every 60 s. Reconciles each database into Kubernetes resources (below), executes hibernate/wake with safety checks, and reports observed state, node capacity and storage samples. |
| `apps/regional` `gateway` | Kubernetes Deployment (2 replicas) | WebSocket-to-PostgreSQL bridge behind `cloudflared`. Verifies the edge's signed routing token, dials the database's `-rw` Service over TLS (CNPG CA), and relays the client stream. |
| `cloudflared` | Kubernetes Deployment (2 replicas) | One named tunnel per region; the only path from Cloudflare into the cluster. |
| `apps/node-bootstrap` | Cloudflare Container image | Turns a Contabo VPS into a Talos node: rescue mode, verified Talos image, machine config, join. Started by the add-node Workflow. |
| `packages/contracts` | shared | zod schemas for the API, the agent protocol and the edge routing token. |
| Platform (Flux) | Kubernetes | Cilium, OpenEBS LocalPV LVM, cert-manager, CloudNativePG, Barman Cloud plugin, cloudflared and the regional image, pinned in `infra/platform`. |

### Per-database Kubernetes resources (agent mapping)

- Namespace `pgcf-db-<id>` with PodSecurity `restricted`, a ResourceQuota and a default-deny
  NetworkPolicy. Ingress is allowed only from the gateway and the CNPG operator; egress only to
  DNS, the Kubernetes API and R2 on 443.
- CNPG `Cluster`:
  - 1 instance, pinned PostgreSQL 18 image.
  - StorageClass `pgcf-lvm` with the size class storage.
  - Memory requests = limits from the size class.
  - `nodeSelector` on the placed node; `enableSuperuserAccess: false`.
  - `initdb` database `app` owned by role `app`; additional roles via `managed.roles`.
  - PostgreSQL parameters derived from the size class.
  - Barman Cloud plugin as WAL archiver.
  - Sleep uses the CNPG hibernation annotation.
- Barman `ObjectStore` writing to `s3://<bucket>/<region>/<db-id>/g<generation>` on the R2 EU
  endpoint, plus a daily `ScheduledBackup`.
- Credentials: generated in the API Worker, stored AES-GCM-encrypted in D1 (key in a Worker
  Secret), delivered to the agent over the authenticated link and written as Kubernetes Secrets.

### Flows

- **Create:** `POST /v1/databases`
  1. The API writes the database row (desired `running`, generation 1) and an operation.
  2. Placement picks a node.
  3. `RegionLink` pushes `apply`, and the agent creates the resources.
  4. The agent reports `ready`, and the operation completes.
- **Connect:**
  1. The client opens `wss://<db-id>.db.<domain>`, either with the Neon serverless driver
     (`Pool`/`Client` WebSocket mode) or through `pgcf connect` for psql and migration tools.
  2. The edge Worker calls `DatabaseActor.ensureAwake()`.
  3. It mints a routing token and connects to `gw-<region>.<domain>` (Tunnel hostname, protected
     by an Access service token).
  4. The gateway relays to PostgreSQL. SCRAM authentication runs end to end with PostgreSQL.
- **Sleep:**
  1. `DatabaseActor` sees no client bytes for the size class `sleep_after_seconds` and asks the
     agent to hibernate.
  2. The agent refuses if `pg_stat_activity` shows active backends or prepared transactions.
     Otherwise it runs `pg_switch_wal()`, waits for the archive, sets hibernation and reports.
  3. Open idle connections are closed. Clients reconnect, which wakes the database.
- **Wake:**
  1. `ensureAwake()` coalesces all waiters into one wake.
  2. `RegionLink` tells the agent to remove the hibernation annotation.
  3. The agent reports ready, and the waiters continue. The server-side wake timeout is 30 s.
- **Suspend/resume:** an integrator call sets desired `suspended`. The edge refuses new
  connections and the database is hibernated. `resume` reverses it.
- **Resize:** `PATCH` the size class. The agent patches resources and CNPG restarts the instance
  (one reconnect). Placement must still fit, otherwise the request is refused.
- **Delete:** desired `deleted`. The agent removes the namespace and PVC. R2 objects follow the
  retention policy.
- **Restore (PITR):** `POST /v1/databases/{id}/restore {target_time}` creates generation g+1 from
  the g archive with a new archive path. The routing swaps to it, and the old generation is
  deleted after verification.
- **Add node:**
  1. The cron sees region headroom below the threshold. Autoscaling must be enabled and within the
     caps for maximum nodes and maximum monthly spend.
  2. The `AddNode` Workflow orders a Contabo instance, or adopts an existing instance ID.
  3. The `node-bootstrap` Container installs Talos and applies the worker config.
  4. The agent sees the Node `Ready` and reports allocatable resources. The node becomes
     schedulable.

### Capacity and placement

A node's allocatable resources are the Kubernetes allocatable values minus a measured platform
reservation. Each database reserves:

- **Storage:** its size class storage.
- **Memory:** its size class memory, multiplied by `sleeping_reservation_factor` while it sleeps.
  The default factor is 1.0, so a wake never fails for capacity reasons. Lowering it is a Phase 4
  density decision, made after measurement and only together with relocation.

Placement picks the node with the most free memory in the region that fits. Contabo contracts are
monthly, so scale-in only cancels at the end of a term, and autoscaling uses hysteresis.

## 4. Data model and API v1

D1 tables:

- `api_keys`: scope `admin` or `integrator`; SHA-256 hash with pepper.
- `projects`: integrator grouping with an optional `external_id`.
- `size_classes`:
  - Resources: memory MiB, CPU millicores, storage GiB, max connections.
  - Policies: `sleep_after_seconds` (null = never), `archive_timeout_seconds`,
    `backup_retention_days`, enabled.
- `regions`: provider, provider region, DB domain, tunnel hostname, agent key hash, autoscale
  policy JSON.
- `nodes`: provider instance and product, monthly price and currency, status, allocatable
  resources, Kubernetes node name.
- `databases`:
  - Ownership and placement: project, region, node, name, size class, PostgreSQL major version.
  - State: desired and observed state, generation and observed generation, status message,
    timestamps.
- `roles`: encrypted password with key version.
- `operations`: kind, subject, status, error, idempotency key, timestamps.
- `lifecycle_events`: created, ready, hibernated, woke, resized, suspended, deleted; each with
  node, size class and generation.
- `usage_hourly`: one row per database and hour.

Endpoints:

- Projects: `POST/GET/DELETE /v1/projects[/{id}]`.
- Databases:
  - `POST /v1/databases` (asynchronous; returns an operation), `GET /v1/databases[/{id}]`,
    `PATCH /v1/databases/{id}` (size class), `DELETE /v1/databases/{id}`.
  - `POST /v1/databases/{id}/suspend|resume|restore`.
- Roles: `GET|POST /v1/databases/{id}/roles` and `POST .../roles/{name}/reset-password`. The
  connection URI includes the password only for the `integrator` scope.
- Operations: `GET /v1/operations/{id}`.
- Metrics: `GET /v1/usage` and `GET /v1/costs` (section 5).
- Admin: `GET /v1/size-classes`, `GET /v1/regions`, `GET /v1/nodes` and
  `POST /v1/regions/{id}/nodes`.
- Agent: `/agent/v1/link` (WebSocket), `/agent/v1/desired` and `/agent/v1/observations`.

The OpenAPI document and the TypeScript client are generated from code: Hono with
`@hono/zod-openapi`. Writes accept an `Idempotency-Key`.

## 5. Metrics and cost tracking

Usage is reported per database per UTC hour (`GET /v1/usage?project_id|database_id&from&to&granularity=hour|day`):

| Metric | Source |
| --- | --- |
| `provisioned_seconds`, `awake_seconds` | lifecycle events |
| `memory_mib_seconds`, `cpu_millicore_seconds` | size class × awake time; a separate reserved figure covers sleep |
| `storage_used_bytes_max`, `storage_allocated_bytes` | agent samples (hourly) |
| `backup_bytes_max` | R2 listing of the database prefix (hourly) |
| `ingress_bytes`, `egress_bytes`, `connections`, `connection_seconds` | edge Worker via `DatabaseActor` |

Rows can change until `final: true`, which is set two hours after the hour ends. Missing samples
are reported as gaps, never as zero.

`GET /v1/costs` shows the operator's own cost:

- Node cost per hour (the Contabo price recorded at purchase) is attributed to databases by their
  share of reserved memory.
- R2 storage cost covers backup bytes. Prices are installation config.
- Unreserved capacity appears as `idle_capacity_cost`.

The cost view answers "what does each database cost us" and shows utilization. Integrators keep
their own price lists. For example, ohmyho.st may charge a fixed credit amount per month per size
class (512 MiB, 2 GiB).

## 6. Security and isolation

- The VPS firewall allows no inbound traffic except the Talos API (50000) and Kubernetes API
  (6443), only from the operator and bootstrap addresses. Moving these behind the Tunnel or Access
  is a Phase 4 item.
- Database hostnames use random 20-character IDs. The edge refuses unknown, deleted and suspended
  databases, and wakes are rate-limited per database.
- **Edge to gateway:**
  - Cloudflare Tunnel plus an Access service token.
  - An HMAC-SHA256 routing token: database ID, connection ID, expiry ≤ 60 s, signed with a
    per-region key.
  - The gateway derives the target only from the database ID.
  - Phase 1 tests whether a Workers VPC HTTP service carries WebSockets. If it does, it replaces
    the public Tunnel hostname. Workers VPC TCP services work only through Hyperdrive and are not
    used.
- PostgreSQL:
  - Customer roles are non-superusers; superuser access is disabled.
  - `scram-sha-256`; extensions limited to the image allowlist.
  - Traffic only from gateway Pods.
- Kubernetes: one namespace per database, default-deny NetworkPolicy, hard LVM volume limits, CPU
  and memory limits, PodSecurity `restricted`.
- Secrets:
  - Worker Secrets hold the API key pepper, the credential encryption key, region HMAC keys,
    Contabo API credentials, R2 S3 credentials and the encrypted Talos secrets bundle.
  - Nothing secret is committed, printed or placed in Image Factory schematics.
- The wake-before-authentication risk (an attacker who knows a hostname can wake a database) is
  bounded by unguessable IDs and wake rate limits. Edge-side SCRAM verification is a later option.

## 7. Phases

Each phase ends with its live acceptance run in Dev. The result and the measured numbers go into
section 11.

### Phase 0 — Reset

1. Remove the old implementation from the repository:

   ```sh
   git rm -r -q apps components packages docs .github .dockerignore pnpm-lock.yaml \
     infra/telemetry infra/telemetry-qualification infra/qualification \
     infra/kubelet-serving-certificates infra/kubelet-serving-certificates-dev \
     infra/pooling infra/platform/overlays infra/talos/kubelet-serving-tls.patch.yaml \
     infra/platform/bootstrap/flux-sync-existing-*.example.yaml
   ```

2. Remove all local worktrees and `codex/*` branches; only `main` remains. A local safety bundle
   is in the ignored `.local/backups/20261002-reset/`.
3. Decommission the old Dev deployment. The Cloudflare account is shared: touch only `pgcf-*`
   resources.
   - Inventory first.
   - Delete the Worker `pgcf-control-dev` and its D1 database, the usage-custody R2 bucket and
     obsolete Worker Secrets (for example the runtime permit signing keys).
   - Keep the EU backup bucket, but empty its old lab prefixes.
4. Rebuild the lab Talos node from the repository recipes: Talos, Cilium, then the Flux platform.
   This removes the old controller, collectors, telemetry and adoption overlays, and proves the
   recipe on fresh infrastructure. The second VPS stays untouched for Phase 3.

Acceptance:

- `git ls-files` shows only the target layout (section 10).
- `git worktree list` and `git branch` show only `main`.
- No stale `pgcf-*` Dev resources remain.
- The fresh lab node is Ready and all five Flux releases are Ready.

### Phase 1 — One database through the whole chain

Build:

- `apps/api`: keys, projects, size classes, databases, roles, operations; D1 migrations;
  `RegionLink`.
- `apps/regional`: agent create/delete reconcile with Barman to R2 from creation, plus the
  gateway.
- `cloudflared` and the regional image in the Flux platform; public GHCR images.
- `apps/edge`.
- `scripts/e2e` (TypeScript).

Live acceptance (`scripts/e2e` against Dev):

1. Create a project and a `small` database through the API. Measure ready time.
2. Fetch the connection URI.
3. From a deployed test Worker using `@neondatabase/serverless` (`Pool`, WebSocket mode), run
   DDL, a transaction, a rollback and reads through `wss://<id>.db.<domain>`.
4. Find the base backup and WAL objects in R2.
5. Delete the database. The namespace and PVC are gone and D1 shows `deleted`.
6. A port scan of the VPS shows no reachable PostgreSQL port.

### Phase 2 — Serverless behavior and metrics

Build:

- `DatabaseActor`: idle timer, coalesced wake, traffic counters.
- Agent hibernate/wake with safety checks; suspend/resume.
- `pgcf connect` local TCP bridge.
- Lifecycle event log, agent samples, hourly rollups, `/v1/usage`, `/v1/costs`.
- Manual resize.

Live acceptance:

- The database hibernates after its idle window.
- 20 cold connects: p50/p95/max are recorded, with a target p95 ≤ 8 s so that a 10 s client
  timeout holds. If the target is missed, reduce startup time (pre-pulled images, probe tuning)
  before changing defaults.
- 10 parallel connects to a sleeping database cause exactly one wake.
- Usage `awake_seconds` matches the lifecycle within 60 s per hour.
- `/v1/costs` attributes node and R2 cost.
- Resize applies with one reconnect.
- psql works through `pgcf connect`.

### Phase 3 — Horizontal scaling across VPS

Build:

- Node inventory and placement.
- The `AddNode` Workflow: adopt an existing instance or order a new one.
- The `node-bootstrap` Container. It runs the verified rescue path: per-node Image Factory
  schematic with static network arguments, checksum-verified NoCloud raw image, GPT relocation,
  `apply-config` worker.
- Capacity cron with an autoscale policy and hard caps.

Live acceptance:

- The second existing VPS joins through the API, with no manual console step.
- New databases are placed on it.
- Databases on both nodes are reachable.
- An autoscale dry run logs the decision.
- One real purchase happens only after the owner's costed go.

### Phase 4 — Production readiness

- PITR restore through the API, retention enforcement, backup freshness checks.
- Health reporting and alerting through Cloudflare: WAL archive age, disk usage, failed backups,
  node down.
- Production region with three schedulable control-plane nodes; etcd snapshots; regular D1
  export to R2; documented recovery of Worker Secrets.
- Isolation tests: cross-tenant network and SQL, disk-full containment, CPU noisy neighbor.
- Credential and API key rotation.
- Density measurement per size class, which decides `sleeping_reservation_factor` and relocation
  of sleeping databases.
- Security review and public-image secret scan.
- OMH Dev on PGCF (adapter in the OMH repository) for one week, then the OMH production cutover
  after the owner's go.

Acceptance:

- PITR to a timestamp through the API, including after the source is deleted.
- In a three-node region, one node reboot leaves databases on the other nodes unaffected.
- OMH Dev is stable for a week.

### Phase 5 — Open-source release

Build:

- An install path (`pgcf install` or a scripted guide): a Cloudflare account with a zone, plus
  Contabo API credentials, give a first region.
- Generated API reference and operator runbooks in `docs/operations/`.
- Versioned releases with signed public images.

Acceptance: a fresh Cloudflare account and a fresh VPS reach Phase 1 acceptance by following only
the docs.

### Later

Synchronous standby for larger size classes, relocation of sleeping databases, branching,
multiple regions, other VPS providers, an HTTP SQL endpoint, PostgREST, a Studio workbench.
Edge-side SCRAM before wake.

## 8. Known facts from the lab (2026-09-27 to 2026-10-01)

**Hardware:**

- Two Contabo Cloud VPS Plus 4 (4 vCPU, 8 GiB RAM, ~150 GB disk, EU 2, €13.07/month each).
- No nested virtualization.
- No custom-image storage in the account. Talos was installed with Contabo rescue mode and `dd`
  of a checksum-verified Image Factory NoCloud raw image, followed by backup-GPT relocation. Static
  network kernel arguments are needed (`net.ifnames=0`, `eth0`).

**Versions that worked together:**

- Talos 1.14.1, Kubernetes 1.36.3, Cilium 1.20.2.
- OpenEBS 4.6.1 (LocalPV LVM 1.10.1 only), cert-manager 1.21.2.
- CNPG 1.30.1 (chart 0.29.1), Barman Cloud plugin v0.15.0 (chart 0.8.0).
- Flux 2.9.5, PostgreSQL 18.4.

**Storage:**

- A raw partition holds the LVM volume group `pgcf`. StorageClass `pgcf-lvm` is thick, uses
  `WaitForFirstConsumer` and has `Retain`. Volume limits are hard.
- Cap the Talos EPHEMERAL volume before first provisioning.
- A WAL-full PANIC was recovered by online volume expansion without losing committed transactions.
  Failed archiving fills the disk, so alert on archive age and disk use.

**Backups:**

- Base backup, WAL archiving, full restore and PITR passed: CNPG plus Barman plugin to R2 at the
  EU endpoint `https://<account>.eu.r2.cloudflarestorage.com`, region `auto`.
- Every restore target needs its own archive path and `serverName`; reused names break restore
  (plugin issue #411).
- The plugin's `enabled: true` default matters.
- The lab sidecar used 128 MiB request / 512 MiB limit. Size it for 512 MiB databases.

**Images:** private GHCR packages forced `imagePullPolicy: Never` with Talos image import.
Publish public images instead.

**Cloudflare:**

- Workers VPC is beta. HTTP services work through `fetch`; TCP services work only through
  Hyperdrive. Only public CAs and Origin CA are trusted.
- Hyperdrive allows 25 configurations per account, so there is no Hyperdrive per database.
- D1 strings and rows are limited to 2 MB.
- Some tokens failed Wrangler D1 queries with error 7403 while REST and the dashboard worked.

**Upstreams:**

- The public Neon repository is effectively dormant (last code change May 2026). Neon storage,
  proxy and NeonVM are not used.
- The Neon serverless driver (MIT) speaks PostgreSQL over WebSocket. Use `Pool`/`Client` mode with
  `pipelineConnect = false` for SCRAM. Its HTTP `neon()` query mode needs Neon's proxy and is not
  supported.
- Xata OSS (Apache-2.0, CNPG-based) is active. Its SNI gateway is not needed in this design.

## 9. Decisions (do not reopen without a measured reason)

| Topic | Decision |
| --- | --- |
| Language | TypeScript everywhere (Workers, agent and gateway on Node 24), shared zod contracts |
| API | Hono + `@hono/zod-openapi`; OpenAPI and client generated from code |
| Region link | Agent opens an outbound WebSocket to `RegionLink`, plus a 60 s full-state pull; desired state in D1 is the truth |
| Client protocol | PostgreSQL over WebSocket via the edge Worker; native tools through `pgcf connect` |
| Edge to region | Cloudflare Tunnel + Access service token + HMAC routing token (Workers VPC HTTP if it carries WebSockets) |
| Database topology | One CNPG Cluster with 1 instance per database, namespace per database, pinned to a node |
| Sleep | CNPG declarative hibernation |
| Backups | Barman Cloud plugin to R2; daily base backup, continuous WAL, retention per size class |
| Metering | Hourly; derived from lifecycle events, samples and edge counters; no per-minute billing |
| Budgets | None in PGCF; integrators suspend and resume |
| Compute autoscaling | None; manual resize by size class |
| Cluster | One Talos/Kubernetes cluster per region |
| Lab topology | One node (control plane + worker); production uses three schedulable control-plane nodes |
| Tests | vitest with the Workers pool for Workers, `node:test` for regional code, `scripts/e2e` live against Dev |

Open questions with defaults:

- **Wake time:** measure in Phase 2.
- **`archive_timeout`:** default 300 s for the smallest class and 60 s for larger ones. R2 Class A
  operations scale with WAL segments.
- **Sleeping reservation factor:** 1.0 until Phase 4 measurement.
- **Production control plane:** 3 nodes.

## 10. Working rules and repository layout

- Work phase by phase. Make the smallest change that moves the current phase.
- Test the logic you write: state machines, placement, metering math, token signing and resource
  mapping. Write the test first when fixing a bug.
- Run `scripts/e2e` against Dev for anything that touches infrastructure.
- One CI workflow: lint, typecheck, unit tests, image build.
- No per-change evidence documents, contracts or "held" work. Record phase results in section 11.
- No mocks, stubs or hardcoded data in product code. Never claim a phase passed without its live
  run.
- The repository is public. Never print or commit secrets, `.env*`, kubeconfigs or Talos configs.
- New paid resources (VPS, plans) and production writes need the owner's explicit, costed go.
- Documentation lives in PLAN.md, README.md, AGENTS.md, THIRD_PARTY.md, the infra READMEs and,
  later, `docs/operations/` runbooks.

Target layout:

```text
apps/api              Cloudflare Worker: /v1 API, Durable Objects, Workflows, cron
apps/edge             Cloudflare Worker: database WebSocket proxy
apps/regional         Node image: `agent` and `gateway` commands
apps/node-bootstrap   Cloudflare Container image: Contabo → Talos node bootstrap (Phase 3)
packages/contracts    shared zod schemas
scripts/e2e           live end-to-end acceptance
infra/talos           Talos patches and Contabo rescue install recipe
infra/platform        Flux platform baseline (pinned)
infra/backups         CNPG/Barman/R2 backup and restore reference
```

## 11. Status

| Date | Phase | Result |
| --- | --- | --- |
| 2026-10-02 | 0 | Plan rewritten. Repository deletion, branch cleanup, Dev decommission and lab rebuild pending. |
