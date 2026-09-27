# cloudflare-postgres — Open-source implementation plan

Status: revised approved direction, 2026-09-27. M0 (repository foundation) is complete. All runtime, infrastructure, integration, and operational acceptance work remains pending.

This file is the canonical scope and roadmap. README.md summarizes it; AGENTS.md is the 25-line contributor brief; THIRD_PARTY.md records component provenance and adoption status. A documented target is not evidence of implemented behavior.

## 1. Product scope and decisions

Build an independent, Apache-2.0-licensed open-source PostgreSQL management platform. Adopters deploy the management layer and authoritative control state into their own Cloudflare account and operate real PostgreSQL on Contabo infrastructure. ohmyho.st is our first adopter and integration customer, using ordinary APIs without privileged runtime exceptions.

### Open-source v1

- Organizations/workspaces, projects, database environments, roles, credentials, and regional placement.
- Versioned management APIs, OpenAPI, generated clients, auditable operations, and explicit resource status.
- Native PostgreSQL access, pooling, interactive transactions, migrations, and portable exports.
- Attributable usage reporting and APIs with documented units, freshness, completeness, and corrections.
- API-controlled project/database budgets, usage status, limit events, and enforceable stop/resume behavior.
- Automatic sleep/wake, manual resizing, and **bounded automatic compute scaling**.
- Physical backups, WAL archiving, point-in-time recovery, retention, and safe backup deletion.
- Tenant isolation, repeatable server maintenance, monitoring, and recovery procedures.

Budget management and enforcement are part of v1. Payment processing, subscriptions, invoices, checkout, and a platform-owned retail pricing catalog are not. ohmyho.st remains responsible for its own customer billing and whole-project wallet; this platform reports database usage and enforces the database allowance assigned through its APIs.

Short reconnects during resizing are accepted. This does not permit routine cold-start requests to exceed the customer's timeout or allow uncertain writes to be replayed.

Native PostgreSQL is the first integration path. HTTP/WebSocket SQL, PostgREST, postgres-meta, and a Studio-derived workbench remain optional developer-experience integrations after the native pilot; they are not prerequisites for testing the first customer. Their later evaluation does not establish a production gateway choice now.

### Later or excluded scope

- Hosted SaaS, reselling, payment collection, subscriptions, invoicing, and commercial account onboarding are a later phase.
- Database branching is deferred until after the initial open-source production release.
- Full Supabase Auth, Storage, Realtime, and Functions remain outside the approved database scope.
- A Neon-versus-Contabo cost study, break-even calculation, margin project, or economic adoption gate is not part of this revision. Capacity and performance measurements are required for safe operation, not as a disguised pricing workstream.
- A Cloudflare-independent management deployment is not promised by v1. Self-hosting requires the adopter's own Cloudflare account and the relevant infrastructure accounts.

### Design assumptions to validate

Cloudflare placement of control state is a user decision. The D1/Durable Objects/R2/Secrets mapping below is the selected design assumption to validate before management implementation. Talos on Contabo, the exact local-volume integration, gateway implementation, isolation runtime, and production failure-domain guarantees still require their stated evidence. No servers have been ordered and no production data has been migrated.

## 2. First customer and early acceptance path

Move the first real ohmyho.st development integration ahead of the full gateway, serverless lifecycle, and developer workbench. Start with one disposable, always-on CNPG database environment over native PostgreSQL/TLS, with backup and independent restore. Use a scoped development adapter or harness through the ordinary project flow; do not add behavior keyed to a test customer or project ID.

This pilot establishes a working database path and an always-on performance baseline. It does not remove sleep/wake or autoscaling from v1. Public gateway and full serverless acceptance follow as separate work packages.

### Current ohmyho.st acceptance profile

This is an integration profile verified against source on 2026-09-27, not a universal product API or an assertion about every live deployment. Reverify it before implementation; keep private source and credentials out of this public repository.

| Area | Required integration behavior and current reference |
|---|---|
| Project lifecycle | Create, observe, and delete a database environment; track uncertain outcomes and provider operations without duplicating resources. |
| SQL identity | Separate runtime, migration, and read-only roles; credentials and direct/pooled connection paths; role revocation and rotation. |
| Driver and transactions | Ordinary `pg` 8.22.0 over TCP with verified TLS; single queries, batches, interactive transactions, cancellation, rollback, and migration compatibility. |
| Existing time budgets | Connection/pool acquisition: 10 seconds; server statement limit: 10 seconds; client query limit: 12 seconds. Measure the whole path, not just Pod startup. |
| Compute configuration | Fixed-size reference profiles plus idle-suspend configuration and observed operation status. Current suspend defaults are 60 seconds for Free/Standard and 300 seconds for Performance; the new platform still requires bounded automatic compute scaling. |
| Environment isolation | Preserve the customer's shared-versus-isolated environment choice. Each independently managed environment must retain separate lifecycle, credentials, restore, and usage attribution. |
| Usage export | The current integration polls every 15 minutes and consumes completed hourly buckets. Polling frequency is not measurement resolution; report late observations and corrections explicitly. |
| Recovery history | The existing provisioning request asks for seven days of history. The pilot must prove actual restore and retention rather than treating a configured value as recovery evidence. |
| Budget integration | ohmyho.st currently exposes `GET/PUT /v1/projects/{project_id}/credit-budget` in its own Control API. It does not forward this to a Neon spending-limit endpoint. The new adapter will assign a database-specific budget or allowance through this platform's API. |

ohmyho.st's current project budget covers all of its billable resources, not only PostgreSQL. Never copy its full wallet balance into a database budget without explicit allocation. Existing local enforcement and credential sweeps are not proof of immediate provider suspension or zero overshoot.

## 3. Reuse strategy and adoption gates

Prefer maintained upstream packages, images, and APIs. Preserve licenses and notices, pin releases and artifact digests when integrating, and keep necessary adapters or forks narrow. Apache-2.0 covers first-party work; it does not relicense third-party components. See [THIRD_PARTY.md](THIRD_PARTY.md).

| Component | Planned decision | Reuse and boundary |
|---|---|---|
| CloudNativePG | Core operator | Delegate database lifecycle, replication, failover, roles, databases, resource changes, hibernation, and recovery integration. |
| PgBouncer through CNPG | Default pooling candidate | Reuse pooling; document client/backend budgets and the direct path. Do not implement another pooler. |
| Barman Cloud plugin and Barman | Backup/recovery tooling | Reuse physical backups and WAL tooling; prove R2 upload, recovery, retention, and deletion independently. |
| Talos, Kubernetes, Flux | Target operations foundation | Reuse declarative host/cluster operations and platform release reconciliation. Contabo bootstrap and maintenance remain unverified. |
| OpenEBS LocalPV LVM | Local-volume candidate | Prove hard volume sizes, expansion, persistence across upgrades, and node-loss rebuild. |
| Neon proxy | Evaluation candidate, not preferred or selected | Evaluate existing native/HTTP/WS protocol handling and wake integration against both technical and maintenance criteria. |
| Neon serverless driver | Optional client integration | Test only against the protocols actually supplied by the selected gateway. |
| Supabase postgres-meta | Optional private administration tooling | Reuse metadata, SQL administration, and type generation behind our authorization and routing. |
| Supabase Studio | Optional selected-database workbench | Prefer narrow integration before a persistent fork. It is not a prerequisite for the pilot or a ready-made multi-project SaaS console. |
| PostgREST | Optional database REST/RPC API | Preserve grants, RLS, and JWT role boundaries; keep it separate from the management API. |

### Gateway maintenance gate

The public Neon proxy history shows very limited recent activity, including a functional [authentication fix on 2026-05-25](https://github.com/neondatabase/neon/commit/8f60b04da47ffefe0e52bda2440134b42874eb75). This is a maintenance concern, not evidence that the repository is officially discontinued or that a specific vulnerability exists.

Before adopting it, identify a maintainer, an upstream/dependency update process, security-response ownership, supported protocol behavior, and the size of the local patch surface. Technical acceptance must cover native clients, each offered HTTP/WS mode, authentication, credential invalidation, cancellation, timeout handling, tenant isolation, and coalesced wake operations.

Neon's [control-plane interface](https://github.com/neondatabase/neon/blob/main/proxy/src/control_plane/mod.rs) supplies useful access-control and `wake_compute` seams, but its ordinary-Postgres testing backend is not a production adapter. Passing a connection test is insufficient. Do not automatically replace a rejected candidate with a new protocol implementation; record and review the alternative architecture.

Neon's storage engine and NeonVM remain outside CNPG v1. Supavisor is an alternative only if measured connection requirements justify it. OpenMeter/OpenCost do not become prerequisites for usage reporting, budget enforcement, or this revision.

## 4. Cloudflare control state and regional execution

### Authoritative state on Cloudflare

| Responsibility | Selected design assumption |
|---|---|
| Management API | Workers expose REST `/v1`, validate identity and scope, and serve generated-client contracts. |
| Canonical control data | D1 stores organizations, projects, desired state, mappings, operation records, idempotency identities, accepted usage facts, budget policies, and allowance reservations. |
| Coordination | Durable Objects serialize resource operations and schedule checks. They reconstruct authority from D1 instead of maintaining a competing desired-state database. |
| Large artifacts | R2 stores database backups/WAL, exports, and archived usage evidence. D1 holds their identities, checksums, status, and references. |
| Secrets | Worker Secrets hold provider credentials and root/signing/encryption keys. Dynamic credentials are encrypted before D1 persistence with scoped context and key-version metadata; verification-only API tokens are hashed. |

D1 batches are atomic inside one D1 database. Use primary reads for authorization and resource-changing decisions, with conditional versions and unique operation identities for concurrency. Do not assume a transaction spans D1, a Durable Object, R2, Kubernetes, or Contabo. Persist intentions and results, reconcile uncertain outcomes, and make regional steps idempotent. [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 read consistency](https://developers.cloudflare.com/d1/best-practices/read-replication/), [Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

Before implementing this layer, complete the logical data model, retention/archival limits, credential/key recovery, access policy, and the D1-to-region reconciliation protocol. Cloudflare is already selected; these tasks must not reopen control-state placement as an undecided provider choice. [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

### Regional responsibility and outage behavior

A regional controller accepts authenticated, versioned operations and reconciles them with Kubernetes, CNPG, and Talos. It holds observed execution state, last-authorized routing/policy snapshots, and a bounded durable usage buffer. These are operational copies, not a second authority for project ownership or budget grants.

- Flux owns platform component versions.
- Our controller owns dynamic database resources and product policies.
- CNPG owns PostgreSQL instances, replication, and database lifecycle.
- Talos lifecycle jobs own OS and Kubernetes upgrades.

Existing connections, local health decisions, and failover should continue without continuous Cloudflare management calls. New provisioning, ownership changes, and credential issuance wait during a control outage. Permitted wake and continued execution use previously authorized regional policy and bounded budget allowances; exhausted or expired allowances must not silently create unlimited authority.

Usage replay is deduplicated after reconnection. Buffer overflow or unrecoverable evidence is reported as a coverage gap, never as complete zero usage. A D1 restore does not rewind Contabo, R2, or regional state: reconcile those systems and invalidate stale operation/allowance epochs before replay. Test key recovery and a clean control-plane rebuild independently of the managed customer databases. [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

## 5. Connectivity, pooling, and isolation

### Connection ownership

| Layer | Responsibility and limits |
|---|---|
| Application `pg.Pool` | Bounds application client concurrency and idle sessions; it does not replace server-side database pooling. |
| Regional gateway | Authenticates, routes, coordinates wake, and enforces admission. Do not assume it is another pooler; any protocol-specific pooling must have an explicit purpose and budget. |
| CNPG PgBouncer | Owns backend pooling for the pooled endpoint, with per-environment and fleet-wide connection/queue bounds. |
| PostgreSQL | Owns sessions, transactions, statement limits, and database connection limits. |

The direct endpoint bypasses PgBouncer for migrations and session-dependent operations while retaining appropriate authentication, routing, and admission. Test prepared statements, transaction/session semantics, query cancellation, connection bursts, credential rotation, and error propagation along each offered path. Record how idle application/pooler connections interact with sleep decisions.

### Gateway availability

Native PostgreSQL requires a regional TCP endpoint; ordinary Workers HTTP ingress is not a PostgreSQL listener. Define endpoint discovery, TLS certificates, public/private routing, and client reconnect behavior before calling a gateway redundant.

Contabo's [VIP API](https://api.contabo.com/#tag/VIP) describes resource assignments as documentation rather than automatic OS-level network configuration. It is not proof of public-IP failover. Validate the selected load-balancing/failover mechanism under gateway process failure, node loss, partial network failure, and stale routing. Measure new-connection recovery and describe what happens to existing sessions and in-flight transactions.

### Isolation model

Use one CNPG cluster per independently managed environment, with separate credentials, namespace policy, resource/connection quotas, volumes, and backup identity. Local storage and PostgreSQL replication are the baseline; a second replicated block-storage layer is not the default.

Before untrusted production use, document the threat model and isolation guarantee: customers may issue SQL using restricted roles and approved extensions, but receive no Kubernetes access, arbitrary container execution, database superuser, server-program execution privilege, or unrestricted native extension installation.

Namespaces and network policy do not create a separate kernel. Evaluate remaining PostgreSQL/extension and container-escape risks before choosing shared nodes, node isolation, gVisor, or Kata. No sandbox runtime is mandated by this document. Record and approve the chosen boundary, including its compatibility/performance evidence. [Kubernetes multi-tenancy](https://kubernetes.io/docs/concepts/security/multi-tenancy/)

Three VMs do not prove three independent physical hosts. Verify placement guarantees before advertising host-failure isolation. Test noisy neighbors, disk-full isolation, privilege boundaries, cross-tenant routing, and restore separation.

## 6. Server maintenance, bootstrap, and recovery

| Responsibility | Component | Platform coordination |
|---|---|---|
| Hardware/hypervisor | Contabo | Provider incident handling and VM replacement. |
| VM provisioning/networking | Contabo API | Inventory, capacity requests, machine identity, bootstrap, and tracked operations. |
| Guest OS/kernel/runtime | Talos | Approved images, one-node-at-a-time upgrades, and recovery. |
| Kubernetes lifecycle | Talos tooling | Supported version progression, quorum checks, and etcd recovery. |
| Platform components | Flux | Pinned releases, staged promotion, and drift reconciliation. |
| PostgreSQL | CNPG | Version policy, rolling changes, replication health, and maintenance status. |
| Backups/WAL/PITR | Barman integration | Retention, freshness, restore drills, and safe deletion. |
| Pod/host networking | Cilium / Talos firewall | Explicit ownership and default-deny policies without competing host-firewall controllers. |
| Certificates | CNPG PKI and cert-manager | Renewal, expiry monitoring, and separate trust domains. |
| Operational telemetry | Prometheus, Alertmanager, OpenTelemetry | Measurements, actionable alerts, and incident evidence. |

Talos is separately MPL-2.0 licensed. Omni is not required. Flux reconciles Kubernetes workloads; it does not patch the host OS. Regional lifecycle jobs invoke the existing Talos mechanisms and coordinate their database consequences.

### Unattended Talos bootstrap

Test Talos's existing [NoCloud implementation](https://docs.siderolabs.com/talos/v1.12/platform-specific-installations/cloud-platforms/nocloud) first. It can obtain Talos machine configuration through NoCloud `user-data`; it does not execute arbitrary cloud-init scripts. Contabo's actual delivery mechanism and the selected Talos image must be proven together. [Contabo API](https://api.contabo.com/)

Prove per-machine identity/configuration delivery, network persistence, first boot, local-volume sizing/expansion, reboot, and node replacement without shared admin credentials in a reusable image. Retain a documented rescue path when the management layer is unavailable.

### Update sequence

1. Pin exact component versions and artifact digests for a proposed update.
2. Run compatibility, SQL, backup/restore, and maintenance tests in staging.
3. Check quorum, replication health, backup freshness, and spare capacity.
4. Promote one canary and switch affected PostgreSQL primaries where required.
5. Drain/upgrade one node; verify networking, volumes, SQL health, and replica catch-up before continuing.
6. Stop on failed probes or degraded replication; use the layer-specific recovery procedure.

OS rollback is not database rollback. PostgreSQL major upgrades and Kubernetes/etcd recovery require their own rehearsed procedures rather than a generic Git revert.

### Backup, PITR, retention, and deletion

Use Barman/CNPG for base backups and WAL. R2 is archive storage, not PostgreSQL's live data volume. For pinned versions, separately test upload, WAL continuity, exact-time recovery, retention expiration, object deletion, interruption/resumption, and restore after the original database cluster has been removed while retained backups remain.

Give restored clusters distinct target archive identities and preserve the source archive until validation. Do not bypass non-empty-WAL checks as a general workaround. Verify that retention never deletes a required base backup or breaks the retained recovery window, and never crosses project boundaries.

The original R2 reporter in [issue #411](https://github.com/cloudnative-pg/plugin-barman-cloud/issues/411#issuecomment-3572945793) later resolved the restore failure as a server/archive naming conflict. Other comments discuss retention/deletion failures with other S3 systems. The issue justifies complete provider/version-specific testing; it does not establish that R2 restoration is fundamentally broken.

## 7. Serverless lifecycle, usage, and budget APIs

### Sleep/wake and scaling

Reuse CNPG hibernation and resource reconciliation. The platform supplies idle detection, admission, wake coalescing, startup deadlines, and scaling policy. Monitoring and empty pool connections must not accidentally keep every database awake; active transactions and session-dependent work must be respected.

Measure the whole cold connection path against the adopter's actual timeout. A generic 10-30 second Pod-start estimate is neither an accepted target nor evidence. The early always-on pilot is a baseline; v1 acceptance still requires successful cold requests under the declared deadline.

Bounded automatic compute scaling uses minimum/maximum size, sustained load, memory/queue signals, cooldowns, and capacity reservations. CNPG performs the resource change; report requested, applying, and effective state. Database scaling and fleet capacity expansion are separate policies. Use documented VM creation for fleet growth rather than assuming a Contabo VM-resize API.

### Usage reporting

Provide a versioned, tenant-scoped usage API and machine-readable export, independent of invoicing. The contract must specify resource units, time windows, aggregation granularity, pagination, source identity, revisions, and how provisional/incomplete observations become finalized or corrected.

Record successful allocations and lifecycle transitions near resources, with durable checkpoints. Report allocated CPU-time, RAM-time, data-volume storage-time, backup/WAL storage-time, and measured transfer where available. Separate primary, replica, and platform overhead attribution; operational CPU utilization is not allocated CPU-time.

Deduplicate repeated delivery, preserve original evidence, and expose corrections. Test hourly aggregation and 15-minute polling for ohmyho.st without making that its only supported query pattern. No price, invoice, or monthly charge is fabricated from incomplete facts.

### Budget management and enforcement

Provide ordinary authenticated APIs to set/read/update a scoped project or database budget, inspect usage and remaining allowance, receive threshold/exhaustion events, and resume after an authorized allowance change. Keep hard enforcement and advisory reporting distinguishable.

Budget-unit semantics must be explicit. Resource-unit limits can be evaluated directly; integrator-defined usage-credit limits require an operator-authorized, versioned conversion/allocation policy. This is enforcement configuration, not a platform-owned retail price catalog. ohmyho.st owns its customer prices and whole-project wallet and assigns only the intended database allowance. Untrusted application callers cannot grant themselves budget authority.

Track granted, consumed, and reserved allowance separately. Reserve or lease bounded execution authority before budget-consuming work; reconcile actual usage and release unused reservations with stable identities. Define the maximum enforcement delay/overshoot and the behavior of running sessions, new connections, wake, and resize. A delayed usage API alone cannot implement a hard cap.

For an enforcing stop, prevent new admissions and resource increases and perform the documented drain/suspend policy. Preserve data and retained backups; stopping compute does not remove persistent storage or guarantee zero infrastructure cost. Resumption requires an authorized policy/allowance update. Technical resource quotas remain distinct from monetary or credit-denominated budgets.

Test concurrent reservations, duplicated grants/events, period rollover, revisions, revocation, exhaustion during execution, stop/resume, offline regional allowances, and replay after recovery. No payment processor, subscription engine, checkout, or invoice service is needed for these v1 capabilities.

## 8. Delivery sequence and evidence

| Milestone | Deliverable | Required evidence |
|---|---|---|
| **M0 — Repository foundation: complete** | Apache-2.0, project guidance, canonical roadmap, component inventory. | Initial public commit `b7d790d`; documentation changes remain distinct from runtime progress. |
| **M1 — Infrastructure and control-state feasibility** | Talos/Contabo/volumes/CNPG/R2 proofs; validate the Cloudflare state, secret, and recovery design. | Unattended boot, persistent/enforced storage, database/backup recovery, benchmark baseline, and control-state design ready before M3. |
| **M2 — Early ohmyho.st development pilot** | One disposable always-on native PostgreSQL environment through an ordinary development integration, without a custom gateway or workbench dependency. | Actual application queries/transactions/migrations, scoped roles, basic lifecycle, usage export, backup, and independent restore. This is not a production migration. |
| **M3 — Cloudflare management, usage, and budget APIs** | D1-backed authority, scoped API/SDK, operation tracking, usage ingestion/query, budget policy/reservations, and regional protocol. | Authorization, idempotency, concurrent updates/reservations, correction/replay, stop/resume commands, and recovery reconciliation. |
| **M4 — Secure fleet operations** | Provisioning, staged updates, replacement, isolation decision, and observability. | Node maintenance/failure, disk-full containment, cross-tenant tests, credential/key recovery, and restore onto fresh infrastructure. |
| **M5 — Gateway and connection ownership** | Select a maintainable native gateway, validate endpoint failover, and set pool/queue limits. | Maintainer/update ownership, authentication/invalidation, cancellation, direct/pooled semantics, gateway/node/network failures, and client reconnect behavior. |
| **M6 — Serverless lifecycle** | Automatic sleep/wake, manual resize, bounded automatic compute scaling, and end-to-end budget enforcement. | Cold-request deadlines, concurrent wake, long transactions, cooldowns, capacity exhaustion, allowance exhaustion, and management-outage behavior. |
| **M7 — Developer experience and integration qualification** | Complete API/CLI docs and usage/budget examples; evaluate optional HTTP/WS, Data API, and workbench integrations. | Repeatable installation and operator workflows; any shipped optional interface has its own compatibility/security evidence. No hosted billing dependency. |
| **M8 — Open-source production readiness** | Rehearsed operational release and staged ohmyho.st rollout after dev acceptance. | Sustained workloads, full recovery and upgrade drills, measured service limits, migration/cutover rehearsal, and independently usable installation documentation. |

### Measurement and acceptance matrix

Publish the workload, versions, topology, sample counts, and pass/fail thresholds before each implementation acceptance run. These are operational measurements; a pricing or break-even study is not required.

| Test | Measure | Acceptance rule |
|---|---|---|
| Talos bootstrap | Provision-to-ready duration, failed/repeated boots, operator interventions. | Reproducible authenticated bootstrap without manual console fixes; failed attempts recover without duplicate resources. |
| Disk and competing tenants | Durable write/read latency, throughput, p95/p99 under realistic concurrent workloads. | Meet the declared workload target without cross-tenant disk exhaustion or loss of durability. |
| Database density | Idle/active memory, reserved CPU, connection counts, and recovery headroom. | Demonstrate a safe capacity envelope, including a node failure/maintenance case; do not derive density from nominal RAM alone. |
| Native and cold access | Connection-ready and end-to-end query p50/p95/p99, maxima, and timeout/error counts. | Meet the customer's actual deadline; for the current ohmyho.st profile preserve headroom within 10-second connection and 12-second query limits. |
| Resize and maintenance | Drain duration, reconnect window, failed/uncertain transactions, replica catch-up. | Bound interruption and prove correct error handling without blind write replay. |
| Recovery and retention | Recoverable timestamps, recovered content, restore time, archive continuity, deleted objects. | Prove the declared history window, safe deletion, and recovery on a fresh cluster with distinct archive identity. |
| Usage and budgets | Coverage, freshness, duplicate/correction handling, reservation accuracy, enforcement delay. | Reproducible reporting, no double consumption, bounded stop behavior, and explicit gaps rather than invented usage. |
| Gateway/control outage | New/existing connection behavior, policy validity, usage-buffer recovery, allowance exhaustion. | Demonstrate the documented degraded behavior, failover and reconciliation without granting unlimited authority or deleting data. |

## 9. Decisions to deepen before implementation and release

- Before M1/M3: finalize Cloudflare schema and retention, backup/key custody, management auth, and the state/operation/allowance reconciliation model.
- Before M2: reverify the current ohmyho.st adapter contract and define the disposable dev migration/restore procedure.
- Before M4/M5: approve the tenant isolation guarantee, maintenance responsibility, gateway choice and native endpoint failover design.
- Before M6: freeze sleep eligibility, cold-start/reconnect deadlines, scaling thresholds, budget units/periods, enforcement bounds, and disconnected-region policy.
- Before M8: verify replica topology, synchronous-commit behavior, actual failure domains, recovery objectives, installed-version support, and safe capacity reserves.

Implementation assumptions must be resolved with evidence, not advertised as existing guarantees. Hosted SaaS/reselling and branching require later plans; neither is a gate for this open-source delivery.
