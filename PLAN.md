# cloudflare-postgres — Plan

Status (2026-10-03): **CI-qualified build; live acceptance pending.** Phase 1 services and the
approved native WebSocket path are implemented. CI run `37074208451` for `c3dcfd6` passed the code
and image jobs, including complete image qualification and authenticated registry verification.
The `c3dcfd6` regional image passed anonymous registry verification by immutable digest, including
source revision, config, RootFS and layer binding. Image signing remains pending. Local PostgreSQL
stream wire checks passed; the original default decoded-binary client assertions still fail.
The first build produced mostly budget-enforcement, signed-execution and evidence machinery but no
database a client could connect to through the API. Those parts are removed. The Talos recipe,
the Flux platform baseline and the R2 backup/PITR recipe stay, because they work in the lab.
The old implementation has been removed and the workspace scaffolded. Dev decommission and
independent re-inventory completed. The first EU firewall corrections are applied, and operator
access plus mandatory foreign IPv4 and IPv6 refusal checks passed. The Talos image is verified,
and the first EU node entered rescue with pinned host identity and validated memory-root, disk
and network assertions. Installation stopped when signature cleanup reported a busy disk;
partition rewriting and image writing did not run. The observed LVM preparation correction is
under review. Bootstrap, platform release, storage proof and custom-domain setup remain pending.
Phase 0 and Phase 1's complete database chain have not passed live acceptance, and Phase 2 has
not begun.
The owner has requested delivery through Phase 5 and full Neon replacement.

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

First adopter: **ohmyho.st** replaces Neon with PGCF. Its provider adapter and commercial logic
live in the adopter repository. Customer databases and internal platform databases are both in
scope, first in Dev and then in production. US remains the default and EU remains selectable.

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
6. **Initial topology and recovery.** Two existing EU VPS and one new US VPS. EU has one
   control-plane/worker node and a second worker; US has one control-plane/worker node. Both
   control-plane/worker nodes host customer databases after reserving system and platform
   resources. Recover a lost node and its databases from R2.
7. **Smallest thing that works end to end.** Add machinery only for an observed problem.
8. **Delete, don't park.** Unused code, files and branches are deleted. Git history is the archive.
9. **Real systems.** No mocks or hardcoded data in product code. A phase passes only through its
   live acceptance run in Dev.

## 3. Architecture

The diagrams are in [README.md](README.md#architecture).

| Component                 | Runs on                              | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                | Cloudflare Worker                    | `/v1` management API, API keys, D1 state. Durable Object `RegionLink` (one per region; holds the agent WebSocket); `DatabaseActor` (one per database; lifecycle, wake coalescing, idle timer, traffic counters) arrives in Phase 2. Workflows for restore and add-node arrive in Phase 3 and later. Phase 1 has neither `DatabaseActor` nor Workflows: an operation closes when the agent's observation arrives, and a cron marks stuck operations failed. Cron also covers usage rollups and capacity checks from their phases on.            |
| `apps/edge`               | Cloudflare Worker                    | Data plane on **one endpoint hostname**, `db.<domain>`: PostgreSQL wire protocol over WebSocket. The approved path admits untrusted `database` and `user` URL hints against D1, signs a v2 routing token with mandatory `user`, and returns the unopened upstream WebSocket for native forwarding. Phase 1 routes only databases observed `ready`. `ensureAwake` through `DatabaseActor` is Phase 2. Records admission and upgrade events; the gateway measures stream bytes. |
| `apps/regional` `agent`   | Kubernetes Deployment (1 per region) | Holds an outbound WebSocket to `RegionLink` that only carries hints, and pulls full desired state (every 5 s while an operation is open, otherwise every 60 s, or immediately on a hint). Reconciles each database into Kubernetes resources (below) and reports observed state, node capacity and archive health. Hibernate/wake with safety checks and storage samples arrive in Phase 2.                                                                                                                                                    |
| `apps/regional` `gateway` | Kubernetes Deployment (2 replicas)   | WebSocket-to-PostgreSQL bridge reached through the edge-to-region transport (section 6). Verifies the signed v2 token; handles SSL/GSS preludes, CancelRequest, startup parsing and the startup deadline; requires the actual StartupMessage database and user to match the token before dialing PostgreSQL. Negotiates TLS with the database's `-rw` Service (SSLRequest, then TLS with the CNPG CA), relays the raw stream, and measures bytes and connection events. |
| `cloudflared`             | Kubernetes Deployment (2 replicas)   | The region's outbound Cloudflare Tunnel; the only path from Cloudflare into the cluster.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/node-bootstrap`     | Cloudflare Container image           | Turns a Contabo VPS into a Talos node: rescue mode, verified Talos image, protected network, machine config, and worker join for an existing region or control-plane/worker bootstrap for a new region. Started by the add-node Workflow. |
| `packages/contracts`      | shared                               | zod schemas for the API, the agent protocol and the edge routing token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Platform (Flux)           | Kubernetes                           | Cilium, OpenEBS LocalPV LVM, cert-manager, CloudNativePG, Barman Cloud plugin, cloudflared and the regional image, pinned in `infra/platform`.                                                                                                                                                                                                                                                                                                                                                                                                 |

### Per-database Kubernetes resources (agent mapping)

- Namespace `pgcf-db-<id>` with PodSecurity `restricted`, a ResourceQuota, a default-deny
  NetworkPolicy and a `CiliumNetworkPolicy`. Ingress is allowed only from the gateway and the CNPG
  operator and plugin, plus the agent on authenticated readiness port 5432 and metrics port 9187; egress only to DNS, the Kubernetes API and the R2 host on 443 (the R2 rule
  needs an FQDN match, which plain NetworkPolicy cannot express).
- CNPG `Cluster`:
  - 1 instance, pinned PostgreSQL 18 image.
  - StorageClass `pgcf-lvm` with the size class storage.
  - Memory requests = limits from the size class.
  - `nodeSelector` on the placed node; `enableSuperuserAccess: false`.
  - `initdb` database named after the database ID (the PostgreSQL database name equals the ID),
    owned by role `app`; additional roles via `managed.roles`.
  - PostgreSQL parameters derived from the size class.
  - Barman Cloud plugin as WAL archiver.
  - Sleep uses the CNPG hibernation annotation.
- Barman `ObjectStore` writing to `s3://<bucket>/<region>/<db-id>/g<storage-generation>-<opid>` on the region's R2
  endpoint (storage generation is 1 until a Phase 4 restore; `<opid>` is the operation that created
  that storage generation), plus a daily
  `ScheduledBackup`.
  EU backups use an EU-jurisdiction bucket and EU endpoint. US backups use a separate bucket on
  the general endpoint with a North America location hint; a hint is not a jurisdiction guarantee.
- Credentials: generated in the API Worker, stored AES-GCM-encrypted in D1 (key in a Worker
  Secret), delivered in the agent's authenticated desired-state pull and written as Kubernetes
  Secrets.

### Flows

- **Create:** `POST /v1/databases`
  1. The API writes the database row (desired `running`, configuration revision 1) and an operation.
  2. Placement picks a node.
  3. `RegionLink` sends a hint, the agent pulls the desired state and creates the resources.
  4. The agent reports `ready` (cluster ready and continuous archiving working), and the operation
     completes.
- **Connect:**
  1. The client opens `GET /v2?database=<id>&user=<role>` on `wss://db.<domain>` with the Neon
     serverless driver (`Pool`/`Client`, WebSocket mode). Its `wsProxy` configuration supplies
     these URL-encoded hints from the connection settings. The connection URI remains
     `postgres://<role>:<password>@db.<domain>/<db-id>`. Customers must set
     `pipelineConnect=false`. `pgcf connect` for psql and migration tools is Phase 2.
  2. The edge treats the hints as untrusted, applies connection admission, and looks up the role
     and database in authoritative D1 state. Unknown roles and unknown, deleted or unavailable
     databases are refused before any gateway upgrade or PostgreSQL dial. Admission failures
     return a small failure-only `101` WebSocket carrying a PostgreSQL SQLSTATE error. Both hints
     are required; missing or invalid hints are refused, and the bare `/v2` endpoint is
     unsupported. Phase 2 inserts `DatabaseActor.ensureAwake()` here.
  3. It signs a v2 routing token binding the admitted database and user, opens the regional
     WebSocket through the transport seam (section 6), and returns that WebSocket unopened.
     Cloudflare forwards the stream natively; Edge does not accept it for a JavaScript relay.
  4. The gateway verifies the token and reads the actual PostgreSQL StartupMessage. Its database
     and user must exactly match the signed claims before any PostgreSQL dial. SSL/GSS preludes,
     CancelRequest, startup parsing and the startup deadline belong to the gateway.
  5. The gateway negotiates verified TLS to PostgreSQL and forwards the original startup and raw
     stream. SCRAM authentication runs end to end with PostgreSQL; uncertain writes are never
     replayed. Stream bytes and connection lifecycle measurements come from the gateway.
- **Sleep (Phase 2):**
  1. `DatabaseActor` uses gateway client-activity measurements and the size class
     `sleep_after_seconds` to ask the agent to hibernate after the idle window.
  2. The agent refuses if `pg_stat_activity` shows active backends or prepared transactions.
     Otherwise it runs `pg_switch_wal()`, waits for the archive, sets hibernation and reports.
  3. Open idle connections are closed. Clients reconnect, which wakes the database.
- **Wake (Phase 2):**
  1. `ensureAwake()` coalesces all waiters into one wake.
  2. `RegionLink` tells the agent to remove the hibernation annotation.
  3. The agent reports ready, and the waiters continue. The server-side wake timeout is 30 s.
- **Suspend/resume (Phase 2):** an integrator call sets desired `suspended`. The edge refuses new
  connections and the database is hibernated. `resume` reverses it.
- **Resize (Phase 2):** `PATCH` the size class. The agent patches resources and CNPG restarts the instance
  (one reconnect). Placement must still fit, otherwise the request is refused.
- **Delete:**
  1. The API sets desired `deleted` (an explicit tombstone; absence from a pull never deletes).
  2. The agent patches the PersistentVolume reclaim policy to `Delete`, because `pgcf-lvm` is
     `Retain`.
  3. It deletes the namespace, then waits until the PV and the `LVMVolume` are gone, so the logical
     volume is not leaked, and reports `deleted`. R2 objects follow the retention policy.
- **Restore (PITR, Phase 4):** `POST /v1/databases/{id}/restore {target_time}` creates storage generation
  g+1 from the g archive with a new archive path. Verify the restored database before changing
  its active route; retire the old storage generation afterward. Configuration revision is separate.
- **Add node (Phase 3):**
  1. The cron sees region headroom below the threshold. Autoscaling must be enabled and within the
     caps for maximum nodes and maximum monthly spend.
  2. The `AddNode` Workflow orders a Contabo instance, or adopts an existing instance ID.
  3. The `node-bootstrap` Container installs Talos, applies peer-only network protection and
     ensures the encrypted Cilium overlay is configured before joining. It applies the worker
     configuration for an existing region or bootstraps a control-plane/worker for a new region.
  4. The agent sees the Node `Ready` and reports allocatable resources. The node becomes
     schedulable after network verification and system/platform reservations.

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
- `regions`: provider, provider region, gateway URL and optional gateway binding, backup bucket and
  endpoint, agent key hash and last-seen time, autoscale policy JSON. A region has no database
  domain; the single endpoint hostname is installation configuration and the region is routing
  data behind it.
- `nodes`: provider instance and product, monthly price and currency, status, allocatable
  resources, Kubernetes node name.
- `databases`:
  - Ownership and placement: project, region, node, name, size class, PostgreSQL major version.
  - State: desired and observed state, configuration revision (`generation`) and observed
    configuration revision (`observed_generation`), status message, timestamps. Storage generation
    is separate and remains 1 until Phase 4 restores.
- `roles`: encrypted password with key version; unique on `(database_id, name)`, which is the
  edge's routing index.
- `operations`: kind, subject, configuration revision, status, error, timestamps.
- `idempotency_keys`: API-key-scoped request hash, state, resulting resource ID and response status;
  never credential-bearing response bodies.
- `lifecycle_events`: created, ready, hibernated, woke, resized, suspended, deleted; each with
  node, size class and generation.
- `usage_hourly`: one row per database and hour.

Endpoints:

- Projects: `POST/GET/DELETE /v1/projects[/{id}]`.
- Databases:
  - `POST /v1/databases` (asynchronous; returns an operation), `GET /v1/databases[/{id}]`,
    `PATCH /v1/databases/{id}` (size class), `DELETE /v1/databases/{id}`.
  - `GET /v1/databases/{id}/archive` lists base backups and WAL in R2 through the Worker's R2
    binding.
  - `POST /v1/databases/{id}/suspend|resume|restore`.
- Roles: `GET|POST /v1/databases/{id}/roles`, `POST .../roles/{name}/reset-password` and
  `GET /v1/databases/{id}/roles/{name}/connection-uri`. The connection URI includes the password
  only for the `integrator` scope.
- Operations: `GET /v1/operations/{id}`.
- Metrics: `GET /v1/usage` and `GET /v1/costs` (section 5).
- API keys: `POST|GET /v1/api-keys` and `DELETE /v1/api-keys/{id}`. The bootstrap token creates the
  first `admin` key and works only while no admin key exists. API and agent credentials are returned
  once; idempotency replays neither reissue nor replace them.
- Admin: `GET /v1/size-classes`, `PUT /v1/size-classes/{id}`, `GET /v1/regions`,
  `POST /v1/regions`, `GET /v1/nodes` and `POST /v1/regions/{id}/nodes`.
- Agent: `/agent/v1/link` (WebSocket), `/agent/v1/desired` and `/agent/v1/observations`.

The OpenAPI document and the TypeScript client are generated from code: Hono with
`@hono/zod-openapi`. Writes accept an `Idempotency-Key`.

## 5. Metrics and cost tracking

Usage is reported per database per UTC hour (`GET /v1/usage?project_id|database_id&from&to&granularity=hour|day`):

| Metric                                                               | Source                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `provisioned_seconds`, `awake_seconds`                               | lifecycle events                                                 |
| `memory_mib_seconds`, `cpu_millicore_seconds`                        | size class × awake time; a separate reserved figure covers sleep |
| `storage_used_bytes_max`, `storage_allocated_bytes`                  | agent samples (hourly)                                           |
| `backup_bytes_max`                                                   | R2 listing of the database prefix (hourly)                       |
| `ingress_bytes`, `egress_bytes`, `connections`, `connection_seconds` | gateway stream counters and connection events; Phase 2 rollups |

Rows can change until `final: true`, which is set two hours after the hour ends. Missing samples
are reported as gaps, never as zero.

`GET /v1/costs` shows the operator's own cost:

- Node cost per hour (the Contabo price recorded at purchase) is attributed to databases by their
  share of reserved memory.
- R2 storage cost covers backup bytes. Prices are installation config.
- Unreserved capacity appears as `idle_capacity_cost`.

The cost view answers "what does each database cost us" and shows utilization. Integrators keep
their own price lists and billing logic.

## 6. Security and isolation

- The VPS firewall denies inbound traffic by default. Operator and bootstrap addresses may reach
  the Talos API (TCP 50000) and Kubernetes API (TCP 6443) only. From Phase 3, exact peer-node
  addresses may additionally reach the required Kubernetes API, Talos (TCP 50000/50001), kubelet
  (TCP 10250), control-plane etcd ports and CNI ports. No cluster port becomes world reachable.
  Apply the peer allowlist before joining a node. Cilium 1.20.2 uses WireGuard transparent
  encryption for inter-node Pod traffic (`encryption.enabled: true`, `encryption.type: wireguard`),
  with UDP 51871 reachable only between peers; the VXLAN overlay and health paths are peer-only
  too. Configure encryption before join, then verify it before placing databases on the new node.
  Host control-plane traffic still uses its native TLS; Pod encryption is not a claim that all
  host traffic uses WireGuard. These are Phase 3 requirements, not deployed evidence.
  See [Cilium WireGuard](https://docs.cilium.io/en/stable/security/network/encryption-wireguard/),
  [Cilium firewall requirements](https://docs.cilium.io/en/stable/operations/system_requirements/#firewall-rules)
  and the [pinned Talos port constants](https://github.com/siderolabs/talos/blob/v1.14.1/pkg/machinery/constants/constants.go).
  Moving operator access behind the Tunnel or Access is a Phase 4 item.
- Database IDs are random 20-character strings (`^[a-z][a-z0-9]{19}$`, a letter first) and are
  also the PostgreSQL database name. There is no per-database hostname. The edge refuses unknown,
  deleted, suspended and not-ready databases and rate-limits connections per database.
- The edge admits URL hints against D1 before any gateway upgrade or PostgreSQL dial. Admission
  failures use a small failure-only `101` WebSocket carrying a PostgreSQL SQLSTATE error. The
  gateway parses the actual
  StartupMessage and rejects a database or user mismatch before a PostgreSQL dial. Startup
  protocol majors other than 3 and replication requests receive SQLSTATE `0A000`; a missing
  startup user receives `28000`. The gateway declines client SSL/GSS requests and silently closes
  CancelRequest connections without dialing PostgreSQL. Phase 2 adds the decoy SCRAM exchange.
- **Edge to gateway:**
  - A v2 HMAC-SHA256 routing token with a per-region key: database ID, mandatory user, connection
    ID, region, key ID, issued-at and expiry, with expiry minus issued-at ≤ 30 s. It is single use
    per gateway replica: each gateway keeps a connection-ID replay cache and rejects a reused
    token.
  - The gateway derives the target only from the admitted database ID, after the actual startup
    database and user exactly match the token. The token admits a route; PostgreSQL still
    authenticates the user's password through SCRAM.
  - The transport is chosen by a Phase 1 spike behind one seam, preferring the existing path with
    the fewest parts that keeps TLS to PostgreSQL: Workers VPC TCP (`vpc_networks` binding), else
    a Workers VPC HTTP service to the gateway, else a Tunnel hostname with the routing token.
    Every candidate must preserve the approved unopened-WebSocket native forwarding path; raw
    TCP support alone does not prove that path. No live transport has been selected. An Access
    service token on a public Tunnel hostname needs the owner's consent to a Zero Trust
    organization first.
- PostgreSQL:
  - Customer roles are non-superusers; superuser access is disabled.
  - `scram-sha-256`; extensions limited to the image allowlist.
  - TLS only (`hostnossl` is rejected); the gateway negotiates it itself.
  - Gateway Pods carry customer connections. The agent verifies desired role credentials through
    authenticated TLS readiness probes before reporting ready.
- Kubernetes: one namespace per database, default-deny NetworkPolicy plus a
  `CiliumNetworkPolicy`, hard LVM volume limits, CPU and memory limits, PodSecurity `restricted`.
  The agent has no `pods/exec` permission.
- Secrets:
  - Worker Secrets hold the API key pepper, the credential encryption keys, the region route
    master keys and the bootstrap token. Contabo API credentials and the encrypted Talos secrets
    bundle follow in Phase 3.
  - Workers reach R2 through bindings, so no R2 S3 credentials are stored in Workers. The S3
    credentials Barman needs exist only as Kubernetes Secrets in the region.
  - Nothing secret is committed, printed or placed in Image Factory schematics.
- **Wake before authentication:** in Phase 1 databases always run, so no connection wakes
  anything. From Phase 2 an unauthenticated client that knows a database ID and a role name could
  wake a sleeping database. That is bounded by unguessable IDs, the D1 role lookup before any wake,
  per-database rate limits and counting traffic only after `AuthenticationOk`. Phase 2 adds a
  decoy SCRAM exchange so that unknown databases and roles look like a wrong password. Edge-side
  SCRAM verification before a wake is a Phase 4 decision.

## 7. Phases

Each phase ends with its live acceptance run in Dev. The result and the measured numbers go into
section 11.

### Phase 0 — Reset

1. **Completed:** the old implementation was removed in commit `77ac865` and the new TypeScript
   workspace was scaffolded. Do not repeat the removal command: it would delete the new workspace.

2. Remove completed implementation worktrees and branches; only `main` remains after integration.
   Keep any local recovery bundle outside tracked files.
3. Decommission the old Dev deployment after a complete inventory and the required approval.
   Operate only on inventory-bound PGCF Dev resources; remove obsolete Workers, D1 databases,
   backup prefixes and Worker Secrets according to that reviewed inventory.
   Preserve the regional backup bucket selected for the new installation.
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

- `apps/api`: keys, projects, size classes, regions, databases, roles, operations, the archive
  endpoint, agent routes; D1 migrations; `RegionLink`; a cron that sweeps stuck operations. No
  `DatabaseActor` and no Workflows: databases always run.
- `apps/regional`: agent create/delete reconcile with Barman to R2 from creation, plus the
  gateway. `ready` requires `ContinuousArchiving=True`; if archiving stays failed for more than
  10 minutes, the agent reports `health.archiving=failing`, which `GET /v1/databases/{id}` shows.
  The agent has no `pods/exec`.
- `cloudflared` and the regional image in the Flux platform; public GHCR images.
- `apps/edge` on the single endpoint: D1 admission of URL hints, signed v2 database/user route,
  and unopened-WebSocket native forwarding. The gateway owns startup validation, preludes and
  the startup deadline. `CancelRequest` is not routed in Phase 1; the gateway closes it silently
  without a PostgreSQL dial.
- `scripts/e2e` (TypeScript).

Live acceptance (`scripts/e2e` against Dev):

1. Create a project and a `small` database through the API with an `Idempotency-Key`. Measure
   ready time.
2. Fetch the connection URI (`postgres://<role>:<password>@db.<domain>/<id>`; the password only
   for the `integrator` scope).
3. From a deployed test Worker using `@neondatabase/serverless` (`Pool`, WebSocket mode,
   `pipelineConnect=false`), run DDL, a transaction, a rollback and reads through
   `wss://db.<domain>/v2?database=<id>&user=<role>`. A wrong password, database ID and user are
   each refused. A StartupMessage database or user that differs from the admitted hints is
   rejected before a PostgreSQL dial.
4. Find the base backup and WAL objects in R2.
5. Delete the database. D1 shows `deleted`; the namespace, PVC, PV and `LVMVolume` are gone, the
   volume group's free space is back to its baseline and the edge refuses the ID.
6. A TCP port scan of every node address from a source outside the firewall allowlist finds no
   reachable port; from the operator address only the Talos (50000) and Kubernetes (6443) APIs
   answer. The cluster has no PostgreSQL listener, NodePort, LoadBalancer, `hostPort` or
   `hostNetwork`.
7. The credential expiry inventory lists the expiry date of every credential the run depends on,
   by variable name and without values.
8. Create and delete five databases with the agent killed mid-run: no released PV or `LVMVolume`
   remains. An empty, stale or failed pull never deletes anything and no generation decreases.

### Phase 2 — Serverless behavior and metrics

Build:

- `DatabaseActor`: idle timer, coalesced wake, traffic counters.
- Agent hibernate/wake with safety checks; suspend/resume.
- `pgcf connect` local TCP bridge.
- Lifecycle event log, agent samples, hourly rollups, `/v1/usage`, `/v1/costs`.
- Manual resize.
- Decoy SCRAM for unknown databases and roles.

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
  `apply-config` worker for an existing region, or bootstrap a control-plane/worker for a new region.
  Control-plane/worker nodes host customer databases with measured system/platform reservations.
- Before join, apply the peer-address firewall allowlist for API, Talos, kubelet, control-plane
  etcd and CNI traffic, and configure Cilium WireGuard Pod encryption. Keep the new node out of
  database placement until the encrypted inter-node path and network isolation are verified.
- Capacity cron with an autoscale policy and hard caps. Initial node caps are EU = 2 and US = 1.
- Reconcile uncertain provider responses before retrying; a replay must never buy another node.
- Node caps count live nodes. Marking a node lost frees its slot for a replacement; the replacement
  order still needs the owner's costed approval. Reinstalling the same VPS in place needs no purchase.

Live acceptance:

- Real database reservations exhaust EU headroom and the second existing VPS joins through the
  capacity path and API, with no manual console step.
- New databases are placed on it.
- Databases on both nodes are reachable.
- Inter-node Pod traffic between the two EU nodes is proven encrypted on the public network;
  WireGuard peers and handshake health match the inventory. An outside-allowlist IPv4/IPv6 scan
  proves that joining added no world-reachable cluster port.
- An autoscale dry run logs the decision.
- A pending US database with no allocatable capacity triggers a real US VPS order and the full
  install/bootstrap path, after the owner's costed go. Interrupt and resume without a duplicate order.

### Phase 4 — Production readiness

- PITR restore through the API, retention enforcement, backup freshness checks.
- Health reporting and alerting through Cloudflare: WAL archive age, disk usage, failed backups,
  node down.
- Production uses the initial two-EU/one-US topology. Keep etcd snapshots, regular D1 exports to
  R2 and documented recovery of Worker Secrets and regional infrastructure.
- Restore uses a separate storage generation; configuration revision and storage generation are
  distinct. Verify the restored database before atomically changing its active route.
- Isolation tests: cross-tenant network and SQL, disk-full containment, CPU noisy neighbor.
- Credential and API key rotation.
- Density measurement per size class, which decides `sleeping_reservation_factor` and relocation
  of sleeping databases.
- Decision on edge-side SCRAM verification before a wake, based on observed wake abuse.
- Security review and public-image secret scan.
- OMH Dev on PGCF (adapter in the OMH repository) for one week, then migrate customer and internal
  platform databases during a maintenance window: stop writes, dump/restore, compare data and roles,
  verify the target, switch connections, then reopen writes. Preserve US/EU and shared/isolated data
  scopes. Retire Neon only after successful verification; never switch back to an older source after
  the target has accepted writes.
- The provider adapter lives only in the adopter repository and replaces database and role
  provisioning, resize, suspend/resume, deletion, usage import and customer/platform connections
  with PGCF contracts. The MIT WebSocket driver may remain as a client library without a Neon
  service dependency.

Acceptance:

- PITR to a timestamp through the API, including after the source is deleted.
- Recover a database and its regional infrastructure from R2 after a node-loss exercise; record
  recovery time and the last recoverable transaction.
- OMH Dev is stable for a week.

### Phase 5 — Open-source release

Build:

- An install path (`pgcf install` or a scripted guide): a Cloudflare account with a zone, plus
  Contabo API credentials, give a first region.
- Generated API reference and operator runbooks in `docs/operations/`.
- Versioned release metadata on main and signed public images pinned by digest; no extra Git refs.
- Reuse the new US VPS before production data for the fresh-account installation acceptance.
- Remove unused Neon code, credentials, connections and provider resources after verified cutover.

Acceptance: a fresh Cloudflare account and a fresh VPS reach Phase 1 acceptance by following only
the docs.

### Later

Extend backup and replication later so a server loss cannot lose acknowledged writes.
Relocation of sleeping databases, branching, other VPS providers, an HTTP SQL endpoint, PostgREST,
a Studio workbench.

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

- Workers VPC is beta. HTTP services work through `fetch`. Raw TCP is documented through a
  `vpc_networks` binding and `connect()`, which is plaintext, so TLS to PostgreSQL must be
  negotiated by the caller; Hyperdrive is not required. Neither path has been tested in this
  project yet; the Phase 1 transport spike decides. Only public CAs and Origin CA are trusted.
- Hyperdrive allows 25 configurations per account, so there is no Hyperdrive per database.
- D1 strings and rows are limited to 2 MB.
- Some tokens failed Wrangler D1 queries with error 7403 while REST and the dashboard worked.

**Tooling:**

- `@cloudflare/vitest-pool-workers` was replaced by `@cloudflare/vitest-plugin`; the workspace uses
  vitest 4.1.x with the plugin.
- Node 24 enters maintenance on 2026-10-20 and stays supported; images pin a Node 24 release by
  digest.

**Upstreams:**

- The public Neon repository is effectively dormant (last code change May 2026). Neon storage,
  proxy and NeonVM are not used.
- The Neon serverless driver (MIT) speaks PostgreSQL over WebSocket. Use `Pool`/`Client` mode with
  `pipelineConnect = false` for SCRAM; its documented default (`"password"`) pipelines the startup
  and only works with cleartext password authentication. Its HTTP `neon()` query mode needs Neon's proxy and is not
  supported.
- Xata OSS (Apache-2.0, CNPG-based) is active. Its SNI gateway is not needed in this design.

## 9. Decisions (do not reopen without a measured reason)

| Topic               | Decision                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language            | TypeScript everywhere (Workers, agent and gateway on Node 24), shared zod contracts                                                                                               |
| API                 | Hono + `@hono/zod-openapi`; OpenAPI and client generated from code                                                                                                                |
| Region link         | Agent opens an outbound WebSocket to `RegionLink`, plus a 60 s full-state pull; desired state in D1 is the truth                                                                  |
| Endpoint            | One hostname, `db.<domain>` (Worker custom domain). No per-database or per-region hostnames, no wildcard DNS; the region is routing data in D1                                    |
| Routing             | Edge admits untrusted `database`/`user` URL hints against D1 and signs a v2 token with mandatory user; gateway requires the actual StartupMessage to match before PostgreSQL dial |
| Client protocol     | PostgreSQL over WebSocket (`GET /v2?database=<id>&user=<role>`) via native Edge forwarding with `pipelineConnect=false`; native tools through `pgcf connect` (Phase 2) |
| Edge to region      | Phase 1 spike behind one seam: Workers VPC TCP, else VPC HTTP, else Tunnel hostname; every candidate must preserve unopened-WebSocket native forwarding and signed v2 routing; live choice pending |
| Desired state       | Deletion is an explicit tombstone; absence from a pull never deletes; generations only increase and the agent ignores older ones                                                  |
| Database topology   | One CNPG Cluster with 1 instance per database, namespace per database, pinned to a node                                                                                           |
| Sleep               | CNPG declarative hibernation                                                                                                                                                      |
| Backups             | Barman Cloud plugin to R2; daily base backup, continuous WAL, retention per size class                                                                                            |
| Metering            | Hourly; derived from lifecycle events, samples and gateway stream counters; no per-minute billing |
| Budgets             | None in PGCF; integrators suspend and resume                                                                                                                                      |
| Compute autoscaling | None; manual resize by size class                                                                                                                                                 |
| Cluster             | One Talos/Kubernetes cluster per region                                                                                                                                           |
| Initial topology    | Two EU VPS (control plane + worker, plus worker) and one US VPS (control plane + worker); recovery from R2                                                                        |
| Tests               | vitest with the Cloudflare vitest plugin for Workers, `node:test` for regional code, `scripts/e2e` live against Dev                                                               |

Open questions with defaults:

- **Wake time:** measure in Phase 2.
- **`archive_timeout`:** default 300 s for the smallest class and 60 s for larger ones. R2 Class A
  operations scale with WAL segments.
- **Sleeping reservation factor:** 1.0 until Phase 4 measurement.
- **Production control plane:** one per region in the initial two-EU/one-US topology.

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

Entries are chronological; later results supersede earlier pending work.

| Date       | Phase | Result                                                                                                                                                                                                                                                                                                                   |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-02 | 0     | Plan rewritten. Old repository implementation was removed; completed-track worktrees are removed after integration. Dev decommission and lab rebuild remain pending. |
| 2026-10-02 | 0     | Old implementation removed from the repository and the TypeScript workspace scaffolded. Documents aligned with the single-endpoint design and the Phase 1 scope; Flux release timeouts and retries raised for a fresh install. Nothing of this is verified live: Dev decommission, lab rebuild and Phase 1 have not run. |
| 2026-10-02 | 0–5   | Owner scope: full Neon replacement for customer and platform databases; US default and EU selectable; initial two-EU/one-US topology with R2 recovery. Vetted live preparation kits are available, but the read-only inventory stopped on incomplete VPC-services pagination. No decommission or rebuild has passed. |
| 2026-10-02 | 1 local | Management API, shared contracts, regional agent, gateway and edge are implemented at local revision `167a6ff`. Local AMD64 image build took 35.7 s; the forbidden-file scan found zero files, and both entry points loaded their modules and rejected missing configuration. These local checks are not Phase 1 live acceptance. M-A corrections, T10 harness review and the real E0–E6 run remain pending. |
| 2026-10-02 | 1 local | Reviewed source integrated at local revision `24e99cb`; M-A corrections fulfilled. Selected suites passed: 88 contracts, 51 API, 26 gateway and 34 edge tests. Lint, formatting, types and root gates passed. CI passed for the earlier push at `7a7d4d4`; the current full source has not yet been pushed. |
| 2026-10-02 | 1 local | Local AMD64 image built in 23.31 s: zero forbidden file paths, both entry-point modules loaded, agent help exited 0 and missing configuration produced the expected failure event in each entry point. The bundled zod MIT notice was verified at 1,072 bytes. Image enumeration covered 10 layers and 10,207 regular files; the detector used default path and MIME exclusions, so this was not complete detector coverage. Raw scan exit 1 identified one V8 compile-time integer in the official public Node base-image layer, independently verified by layer hash as noncredential. The scanner was unchanged; complete image qualification was not established. This image had no published registry digest. |
| 2026-10-02 | 0 | Read-only Dev inventory passed in 143.86 s after the pagination fix, with complete fingerprints for 174 foreign resources. Decommission planning passed in 215.01 s, including a 99,404-byte D1 export and guards. The exact destructive supervisor gate remains pending; no Dev resources were deleted and the lab was not rebuilt. |
| 2026-10-02 | 0–5 | Harness review, real E0–E6 acceptance and the transport spike remain pending. Phase 0 and Phase 1 have not passed live acceptance; Phases 2–5 remain unaccepted and no Neon migration has taken place. |
| 2026-10-02 | 1 local | Selected local suites passed: 66 E2E harness, 35 Edge, 67 regional and 21 infrastructure proof tests. These checks are local preparation, not live Dev acceptance. |
| 2026-10-02 | CI | CI for `da6dd385` failed on an Ubuntu OpenSSL fixture. The portability fix passed locally; a new CI result remains pending. Earlier successful CI rows refer to their recorded revisions. |
| 2026-10-02 | 1 local | Original manual-relay 100 MiB and 1 GiB stream trials failed under the unchanged local memory guard. A test-only native 1 GiB stream passed incremental hash verification. The guard and original failed assertions remain retained; local workerd RSS is not Cloudflare isolate-limit accounting. This control is not product or live acceptance. |
| 2026-10-02 | 1 | Owner approved `GET /v2?database=<id>&user=<role>` with untrusted hints admitted by authoritative D1, a signed v2 token with mandatory user, unopened-WebSocket native forwarding, and gateway validation of the actual startup before PostgreSQL dial. Gateway owns SSL/GSS/cancel handling, startup parsing/deadline and stream measurements. Implementation is in progress; live transport and Phase 1 acceptance remain pending. |
| 2026-10-02 | CI | CI for `dc6ada6` passed both the check and image jobs. The public GitHub tree matched the pushed source across 196 blobs. This confirms the portability fix in CI; it is not live Dev acceptance. |
| 2026-10-02 | 0 partial | The first bounded decommission run timed out after 600 s. Worker, D1, custody bucket and control-recovery prefix deletion were confirmed; qualification prefix deletion still has a pending intent. The same owner-approved plan is resuming with fresh guards. Foreign-resource preservation readback remains pending, and no owned orphans remain. This partial result does not complete Phase 0 or the lab rebuild. |
| 2026-10-02 | 0 | Decommission resumed with the identical owner-approved plan hash and exited 0. Worker, D1 and custody bucket absence were confirmed; 27 owned backup keys were removed. All 174 foreign-resource fingerprints matched the inventory, and only the retained EU backup bucket remains in the owned scope. Independent re-inventory is running. The lab has not been rebuilt, so Phase 0 remains unaccepted. |
| 2026-10-02 | 1 local / CI | Native forwarding is implemented locally at `344fd4d`. Independent local suites passed: 91 contracts, 39 Edge including entry checks, 89 regional, 75 E2E harness and 21 infrastructure proof tests. CI run `37042980656` for this revision passed both check and image jobs. Live Cloudflare transport and Phase 1 acceptance remain pending. |
| 2026-10-02 | 1 local | Against real PostgreSQL 18.4, the native path completed 100 MiB and 1 GiB COPY streams and the original SELECT wire-hash checks with unchanged 192 MiB local memory-growth guards. Local p95 was 1.344 ms direct, 2.725 ms through Edge and 1.3805 ms overhead; disconnect cleanup took 39.57 ms. Default Neon decoded-binary assertions still fail because of upstream result parsing; they remain unchanged and unsolved. Wire integrity and local guards do not establish Cloudflare isolate-limit accounting or live acceptance. |
| 2026-10-02 | 0 | Standalone re-inventory confirmed all 174 foreign resources unchanged after decommission and removal of 27 owned old backup keys; the retained EU backup bucket is empty. The Dev probe was deployed, and first-EU identify, dry-run and recovery-point preparation passed. Firewall rule insertion then failed with HTTP 400 because the Drop-any rule must be last. No rescue, disk wipe, second-EU change, US order or production write occurred. Phase 0 remains unaccepted. |
| 2026-10-02 | 0 / image | A vetted firewall tool fix remains required, and long bootstrap steps need a reviewed interface within the 600 s command cap. GHCR read-access checks returned HTTP 401/403; working registry read access remains required. The lab has not been rebuilt, and no published image has been qualified. |
| 2026-10-02 | image local | An unlanded CI guard byte-counted scan processed exactly 657,363,315 bytes across 10,445 inputs, including 10 layers and 10,207 files, and returned 26 raw findings. Independent review matched all 26 to exact upstream noncredentials: self-test inputs, public keys, examples or expressions. Raw detector findings were not suppressed. A hash-bound classifier and the full guard rerun remain pending; this is not published-image qualification. This corrects the earlier detector-coverage overstatement. |
| 2026-10-02 | review | The author-reported E2E Startup-mismatch harness suite passed 111 local tests; fresh review and an additional defensive specification correction remain pending. S4, S56 and collector candidate fixes also await fresh reviews. None is live acceptance, and Phase 2 has not begun. |
| 2026-10-02 | 0–1 local | Reviewed source and acceptance harness integrated at `9117de3`. All root gates passed, including 38 CI qualification tests and 121 live-harness unit tests. CI passed the code, test, manifest, image-build and runtime checks, then stopped before publication because Docker 28.0.4 does not support the image-inspection platform flag. The portability correction retains explicit image-platform and identity checks and remains pending CI verification. |
| 2026-10-02 | 1 local | Private operational preparation passed two fresh reviews: 39 database/storage-helper tests and 37 measurement-helper tests. These are local checks only. The unapplied firewall-order correction passed 61 correctness and 20 security checks; modifying the vetted tool still needs explicit approval. Dev rebuild, transport selection and Phase 1 live acceptance remain pending. |
| 2026-10-02 | CI / image | CI run `37064926148` for `a11e0c3` passed both code and image jobs. Actual Linux full-image qualification scanned exactly 657,429,499 bytes across 10,447 inputs, 10 layers and 10,207 regular files. All 26 findings matched exact reviewed upstream noncredentials; zero remained unresolved, without weakening the detector. Forbidden-path and runtime checks, authenticated registry SHA/config/RootFS binding and immutable latest promotion passed. Published regional image `sha-a11e0c3930b6` has registry manifest digest `sha256:b358c579bbd58cb7f74dd3aa047483ad9d9f71495f5f9902c72aa00450c7b9f5`. The package was initially private; public visibility was pending at this point. Image signing and production acceptance remain pending. |
| 2026-10-02 | 0 live | Both exact owner-approved first-EU firewall corrections are applied. The strict terminal-DROP correction passed 87 checks in each independent review. The actual firewall-prune step exited 0 with operator access and mandatory foreign IPv4 and IPv6 positive controls and refusal checks. No rescue, disk wipe or rebuild has started. Image preparation and custom-domain setup remain pending; Phase 0 is unaccepted. |
| 2026-10-02 | 1 preparation | In-process default-text result compatibility preparation passed 14 checks; this is not a driver change or end-to-end acceptance. The original decoded-binary assertions still fail and remain retained. Live transport selection and the complete E0–E6 Dev run remain pending; Phase 2 has not begun. |
| 2026-10-03 | image public | Regional image publication completed. Anonymous authorization and both `sha-a11e0c3930b6` and `latest` manifest reads returned HTTP 200 with the exact recorded immutable manifest digest. Real registry validation confirmed source revision, config, RootFS and layer binding. Organization creation defaults were restored after publication. Image signing and production acceptance remain pending. |
| 2026-10-03 | 0 image | The first-EU Talos image download exited 124 after 585 s, retaining 120,717,312 bytes of the expected 231,195,631-byte artifact. An actual range request returned HTTP 206, confirming resume support; resume-tool preparation is offline only. Image checksum verification, rescue, disk wipe and rebuild have not completed. |
| 2026-10-03 | CI / image | CI run `37074208451` for `c3dcfd6` passed both code and image jobs. Complete qualification expected and scanned exactly 657,429,509 bytes across 10 layers, 10,207 regular files and 10,447 inputs; all 26 exact reviewed upstream noncredentials were resolved, with zero unresolved findings. The published regional image `sha-c3dcfd62d9b0` has registry manifest digest `sha256:c8f87dc787ee7197c3fe370196dbd40536730eaf9bc6bf8ae24146a016a08bcc`. Anonymous authorization and both this SHA tag and `latest` manifest reads returned HTTP 200 with the same digest; actual validation confirmed source revision, config, RootFS and layer binding. Image signing and production acceptance remain pending. |
| 2026-10-03 | 0 image | The resumed Talos image step exited 0 with all 231,195,631 bytes. SHA-256 matched the trusted pinned digest `515034e3b138902062687f9cf9d6a2da1504768febb2929f6fa70503dc8df4ac`; GPT inspection found exactly four partitions labeled EFI, BIOS, BOOT and META, and network settings matched the private inventory. This verifies the install artifact, not the rebuilt node. |
| 2026-10-03 | 0 live | First-EU rescue and host-key pinning passed, followed by assertions for a memory-root environment, one unmounted writable 150 GiB physical disk and matching network inventory. The first `wipefs` command exited 1 with Device or resource busy; partition zap and image writing never ran. Read-only inspection found one owned, unmounted PGCF volume group with all physical volumes on the asserted disk and six active unmounted logical volumes. No force, volume deactivation or retry has occurred; the preparation correction is under review. Phase 0 remains unaccepted until bootstrap, platform release and storage proof; Phase 1 transport and E0–E6 acceptance remain pending, and Phase 2 has not begun. |
