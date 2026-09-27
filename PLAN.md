# cloudflare-postgres — High-level implementation plan

Status: approved product direction; repository foundation only. No runtime, infrastructure deployment, or component integration has been implemented or verified.

## Product and approved scope

Build an independent, open-source PostgreSQL platform with a hosted SaaS offering. Cloudflare hosts the management layer; Contabo supplies database infrastructure. ohmyho.st is the first customer and the first migration acceptance case.

Version one includes:

- Organizations, projects, databases, roles, credentials and regional placement.
- Native PostgreSQL connectivity, pooling and interactive transactions.
- Attributable usage, pricing, budgets and hosted billing.
- Automatic sleep/wake, manual resizing and automatic compute scaling.
- Physical backups, WAL archiving and point-in-time recovery.
- Automated infrastructure maintenance, observability and recovery procedures.

Short reconnects during resizing are accepted. **Database branching is deferred.** Full Supabase Auth, Storage, Realtime and Functions are outside the currently approved database scope.

This document establishes the architecture and work packages. Detailed contracts, capacity targets and operating procedures will be added before their implementation.

## A. Reuse strategy: configure and integrate first

| Component | Decision | Engineering avoided / integration required |
|---|---|---|
| **CloudNativePG — Apache-2.0** | Core database operator | Reuse provisioning, replication, failover, roles, databases, rolling updates, hibernation and recovery integration. Our controller translates product policy into its resources. |
| **PgBouncer — ISC** | Default pooler through CNPG | Reuse connection pooling and its operator integration. Do not implement a pooler or deploy two competing pooling layers. |
| **Supabase postgres-meta — Apache-2.0** | Private database administration service | Reuse schema introspection, table/role operations, SQL administration and type generation. Add our authorization and project routing around it. |
| **Supabase Studio — Apache-2.0** | Adapt its database workbench | Reuse table and SQL editors. Build the organization, project, usage and billing shell around a selected database context. |
| **PostgREST — MIT** | Optional per-database REST/RPC Data API | Reuse table/view/function exposure, grants, JWT role mapping and RLS behavior. It remains separate from the platform management API. |
| **Neon proxy — Apache-2.0** | Preferred gateway adaptation candidate | Reuse PostgreSQL TCP, WebSocket and SQL-over-HTTP handling, authentication machinery and the compute wake hook. Prove the production backend adapter before adopting it. |
| **Neon serverless driver — MIT** | Reuse as a supported client | Verify its HTTP and WebSocket modes against our gateway alongside ordinary PostgreSQL drivers. |
| **Barman Cloud plugin and Barman** | Backup and recovery implementation | Reuse physical backup/WAL tooling. Preserve the plugin's Apache-2.0 and Barman's GPL licensing separately. |

Sources: [CloudNativePG](https://github.com/cloudnative-pg/cloudnative-pg), [PgBouncer](https://github.com/pgbouncer/pgbouncer/blob/master/COPYRIGHT), [postgres-meta](https://github.com/supabase/postgres-meta), [Studio](https://github.com/supabase/supabase/tree/master/apps/studio), [PostgREST](https://github.com/PostgREST/postgrest), [Neon proxy](https://github.com/neondatabase/neon/tree/main/proxy), [serverless driver](https://github.com/neondatabase/serverless), [Barman plugin](https://github.com/cloudnative-pg/plugin-barman-cloud).

Important integration boundaries:

- Self-hosted Supabase does not include its hosted multi-project management, billing or managed PITR platform. Studio supplies valuable database tooling, not the complete SaaS product. [Supabase self-hosting](https://supabase.com/docs/guides/self-hosting)
- `postgres-meta` explicitly requires a trusted environment. Clients must never select arbitrary backend URLs or supply administrative connection credentials.
- Neon's proxy already exposes access-control lookups and `wake_compute`. Its ordinary-Postgres example is a testing path; production integration requires a real backend adapter or compatible private control API. [Proxy interface](https://github.com/neondatabase/neon/blob/main/proxy/src/control_plane/mod.rs)
- Neon's pageservers, safekeepers and patched PostgreSQL form a different storage architecture. They are not add-on branching features for CNPG. Keep that architecture outside v1.
- NeonVM introduces substantial virtualization and scheduling infrastructure. Accepted reconnects make it unnecessary for the initial autoscaler.
- Supavisor remains an alternative if measured fleet requirements justify shared multi-tenant pooling. It is not an additional default layer.

Prefer pinned upstream packages and images. Keep necessary forks narrow, preserve notices and record upstream revisions. Apache-2.0 covers our original code; it does not relabel third-party components. See [THIRD_PARTY.md](THIRD_PARTY.md) for the candidate and license inventory.

## B. Architecture and ownership

### Cloudflare management layer

Own authentication, organizations, projects, API keys, desired configuration, operation history, customer usage and billing. Expose REST `/v1`, OpenAPI and generated clients.

Long-running operations return an operation resource and report observed progress. Provisioning, resize, suspend, restore and deletion must survive retries and uncertain outcomes.

### Regional execution layer on Contabo

A regional controller receives authenticated, versioned operations and reconciles them with Kubernetes, CNPG and Talos. It also maintains regional routing information and collects resource usage.

Use explicit ownership:

- Flux owns platform components and their release versions.
- Our controller owns dynamic customer database resources and policy.
- CloudNativePG owns PostgreSQL instances and their lifecycle.
- Talos lifecycle operations own OS and Kubernetes upgrades.

These controllers must not continuously overwrite one another's fields.

### Database access

Run redundant regional gateways for native PostgreSQL. Route HTTPS/WebSocket access through Cloudflare where appropriate. Ordinary Workers HTTP ingress is not a native PostgreSQL listener.

Keep routing and permitted wake operations regional so existing customers are not dependent on a Cloudflare API call for every database connection.

### Isolation and storage

Use a separate CNPG cluster for each independently managed database environment. This provides independent sleep, resize, restore and lifecycle boundaries.

Use local persistent volumes, PostgreSQL replication and external backups. Evaluate OpenEBS LocalPV LVM for enforced volume sizes and expansion. Avoid adding a second distributed storage replication layer by default.

Enforce tenant boundaries through credentials, namespaces, network policies, resource limits, storage limits and extension policy. Customers receive no operator superuser or Kubernetes privileges.

## C. Server security, patches and orchestration

| Responsibility | Component | What our software must coordinate |
|---|---|---|
| Hardware and hypervisor maintenance | Contabo | Provider incident handling and VM replacement |
| VM creation, networking and replacement | Contabo API | Inventory, capacity requests, bootstrap and operation tracking |
| Guest OS, kernel and container runtime | Talos Linux | Approved image versions and sequential node upgrades |
| Kubernetes lifecycle | Talos tooling | Supported upgrade sequence, quorum checks and etcd recovery |
| Platform releases and configuration drift | Flux | Version promotion, health checks and deployment ownership |
| PostgreSQL maintenance | CloudNativePG | Approved versions, maintenance policy and customer-visible status |
| Backups and PITR | Barman integration | Retention, freshness checks and independent restore drills |
| Pod network isolation | Cilium | Default-deny tenant policies and permitted service paths |
| Host network isolation | Talos firewall | Explicit ingress policy and management-network restrictions |
| Certificates | CNPG PKI and cert-manager | Renewal, expiry monitoring and separate trust boundaries |
| Metrics and alerting | Prometheus, Alertmanager, OpenTelemetry | Service objectives, actionable alerts and incident evidence |

Talos is an API-managed, immutable OS without normal SSH administration. Flux manages Kubernetes workloads; it does **not** patch the host OS. Our regional lifecycle controller orchestrates Talos upgrades. [Talos](https://github.com/siderolabs/talos), [Flux](https://github.com/fluxcd/flux2)

Talos remains separately MPL-2.0 licensed. Omni is not a required dependency: its production licensing differs from the open-source baseline. [Talos license](https://github.com/siderolabs/talos/blob/main/LICENSE), [Omni license](https://github.com/siderolabs/omni/blob/main/LICENSE)

The update sequence is:

1. Detect an available or security-relevant update and pin exact versions/digests.
2. Run compatibility, database and restore tests in staging.
3. Check quorum, replication health, backup freshness and spare capacity.
4. Promote one canary; move PostgreSQL primaries where necessary.
5. Drain and upgrade one node, verify storage/network/database health, then continue.
6. Stop automatically on failed probes or degraded replication.

OS rollback, Kubernetes recovery and database rollback are different procedures. A Git revert is not a universal rollback mechanism. PostgreSQL major upgrades require their own migration and cutover plan.

## D. Serverless behavior and accounting

### Sleep/wake

Reuse CNPG hibernation. Our policy determines idleness and coordinates incoming requests, active transactions, direct sessions and background activity.

Authenticate and rate-limit connection attempts before costly wake operations. Collapse concurrent requests into one wake operation, wait for readiness and enforce a startup deadline. Never replay potentially committed writes after an ambiguous disconnect.

### Autoscaling

Implement two separate controllers:

- Database scaling adjusts a tenant's resources within configured minimums, maximums and budgets.
- Fleet scaling adds Contabo machines before aggregate capacity becomes exhausted.

Use sustained load, memory pressure and queue signals, with cooldowns and capacity reservations. CNPG performs actual resource changes. Public status must distinguish requested, applying and effective size.

Contabo fleet expansion should use documented VM creation APIs. Do not assume an existing VM can be resized automatically through an undocumented API.

### Usage and billing

Record successful allocation and lifecycle facts near the resources. Charge documented resource-time and storage units rather than treating CPU utilization as the invoice.

Use durable event identities, deduplication, versioned rates, integer accounting and explicit correction entries. Separate customer charges from infrastructure costs and idle-capacity allocation.

Hosted payments use an adapter; self-hosting must not require an ohmyho.st account or a paid billing service. OpenMeter can be added as an integration if its benefits justify operating its additional infrastructure. OpenCost can support internal margin reporting.

Hard budgets require admission/reservation enforcement near the workload. Delayed monitoring and payment-provider aggregates are insufficient.

## E. Delivery sequence and acceptance gates

All implementation milestones remain pending. M0 is the scope of the initial documentation and license delivery; M1-M8 require their own implementation evidence.

| Milestone | Deliverable | Required evidence |
|---|---|---|
| **M0 — Repository foundation** | License, project guidance, roadmap and component inventory | Public repository, exact 25-line AGENTS.md, correct license and no private material |
| **M1 — Infrastructure feasibility** | Talos on Contabo, local volumes, CNPG and R2 backup path | Unattended bootstrap, reboot persistence, enforced volume limits and full PITR restore |
| **M2 — Gateway reuse** | Adapted Neon proxy before ordinary CNPG PostgreSQL | Native, HTTP and WebSocket access; cancellation, credential rotation, concurrent wake and tenant-isolation tests |
| **M3 — Secure fleet operations** | Repeatable server provisioning, updates, replacement and monitoring | One-node maintenance, failed update, lost node and recovery from fresh infrastructure |
| **M4 — Management API** | Organizations, projects, databases, roles and durable operations | Retry/uncertain-outcome tests and cross-tenant authorization tests |
| **M5 — Serverless lifecycle** | Sleep/wake, manual resize and autoscaling | Active-transaction handling, capacity exhaustion, scale cooldowns and documented reconnect behavior |
| **M6 — Usage and billing** | Metering, tariffs, budgets, payment adapter and usage export | Duplicate/out-of-order events, collector outages, price changes, corrections and budget races |
| **M7 — Developer experience** | API clients, project console, Studio-derived workbench and optional Data API | End-to-end project creation, SQL use, restore and usage visibility |
| **M8 — ohmyho.st migration and hosted launch** | Provider integration, migration tooling and operational readiness | Application compatibility, rehearsed cutover, recovery and sustained workload measurements |

Three early uncertainties are explicit implementation gates:

- **Talos bootstrap:** Contabo supports custom images, but cloud-init `userData` does not automatically configure Talos. Prove secure first-boot identity and machine-configuration delivery. [Contabo API](https://api.contabo.com/)
- **Gateway adaptation:** establish the maintainable production integration with Neon's proxy before promising protocol parity.
- **R2 restore:** test pinned CNPG/Barman versions against R2. An open report describes backups succeeding while restores fail; it does not prove all current combinations fail. [Upstream issue](https://github.com/cloudnative-pg/plugin-barman-cloud/issues/411)

## F. Reliability decisions to deepen next

Before customer production, specify:

- Replica topology, synchronous-commit policy and behavior when a standby is unavailable.
- Verified failure domains; three Contabo VMs do not establish three independent physical hosts.
- Backup retention, recovery-point and recovery-time targets.
- Wake latency, resize interruption and concurrent-connection limits.
- Regional behavior during Cloudflare/R2 outages, including buffered usage and WAL growth.
- Control-state storage, secret/key recovery and disaster bootstrap.
- Capacity models, minimum viable server pool and measured cost per workload.

Existing databases should continue serving under the last validated regional configuration during management outages. New administrative changes wait safely. Budget enforcement must not delete customer data.

Database branches remain a later milestone. Their storage architecture will be evaluated separately after v1 workload and cost evidence exists.
