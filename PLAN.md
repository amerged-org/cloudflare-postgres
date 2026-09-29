# cloudflare-postgres — Open-source implementation plan

Status: revised approved direction, updated 2026-09-29. M0 is complete. M1 has live single-node Talos, Kubernetes, Cilium, bounded-volume, and PostgreSQL transaction evidence; backup/recovery gates remain open. The Dev control API includes environment intents, leased execution, usage/budget authority and scoped database roles with encrypted credential versions and conditional rotation. The Dev role executor has image/client/journal/state-preservation evidence; real customer password application and end-to-end native access still require positive installation evidence. Live checks verify closed admission, authorization, unknown empty exports, exact grants, and conditional requested pause/resume. The regional controller and provisional usage collector now run in Dev through a verified Talos local-image import. Stable allocation continuity is implemented and the updated collector preserves its journal across one image replacement; positive managed usage and final accounting remain open. Installation-owned maintenance preparation is implemented and deployed with additive migration `0008`; a real single-node rehearsal persists a blocked assessment without starting a Talos Job or authorizing an upgrade. Scoped client authentication, empty owned inventory, private journal modes and persistence across one Pod replacement are verified. Positive managed usage, complete/final accounting, allowance settlement, runtime enforcement, anonymous image pulling and API-to-CNPG qualification remain open. Flux now owns Cilium, OpenEBS, cert-manager and the same-version CNPG release in Dev; Barman remains suspended. Host maintenance, upgrades, recovery and the remaining M4/M8 qualification are incomplete. No catalog or API-managed environment has been created; lab admission stays closed.

This file is the canonical scope and roadmap. README.md summarizes it; AGENTS.md is the 25-line contributor brief; THIRD_PARTY.md records component provenance and adoption status. A documented target is not evidence of implemented behavior.

## 1. Product scope and decisions

Build an independent, Apache-2.0-licensed open-source PostgreSQL management platform. Adopters deploy the management layer and authoritative control state into their own Cloudflare account and operate real PostgreSQL on Contabo infrastructure. All adopters use the same public contracts and execution paths. ohmyho.st is an early adopter; its adapter and migration work belong in its own repository.

Projects are global logical containers. Each independently managed database environment selects its region and a versioned configuration profile explicitly; an active project does not imply a database or connection endpoint.

### Open-source v1

- Organizations/workspaces, projects, database environments, roles, credentials, and regional placement.
- Versioned management APIs, OpenAPI, generated clients, auditable operations, and explicit resource status.
- Native PostgreSQL access, pooling, interactive transactions, migrations, and portable exports.
- Attributable usage reporting and APIs with documented units, freshness, completeness, and corrections.
- API-controlled project/database budgets, usage status, limit events, and enforceable stop/resume behavior.
- Automatic sleep/wake, manual resizing, and **bounded automatic compute scaling**.
- Physical backups, WAL archiving, point-in-time recovery, retention, and safe backup deletion.
- Tenant isolation, repeatable server maintenance, monitoring, and recovery procedures.

Budget management and enforcement are part of v1. Payment processing, subscriptions, invoices, checkout, and a platform-owned retail pricing catalog are not. Integrators retain their customer billing and aggregate wallets; this platform reports database usage and enforces the scoped allowance assigned through its generic APIs.

Short reconnects during resizing are accepted. This does not permit routine cold-start requests to exceed the customer's timeout or allow uncertain writes to be replayed.

Native PostgreSQL is the first integration path. HTTP/WebSocket SQL, PostgREST, postgres-meta, and a Studio-derived workbench remain optional developer-experience integrations after the native pilot; they are not prerequisites for testing the first customer. Their later evaluation does not establish a production gateway choice now.

### Later or excluded scope

- Hosted SaaS, reselling, payment collection, subscriptions, invoicing, and commercial account onboarding are a later phase.
- Database branching is deferred until after the initial open-source production release.
- Full Supabase Auth, Storage, Realtime, and Functions remain outside the approved database scope.
- A Neon-versus-Contabo cost study, break-even calculation, margin project, or economic adoption gate is not part of this revision. Capacity and performance measurements are required for safe operation, not as a disguised pricing workstream.
- A Cloudflare-independent management deployment is not promised by v1. Self-hosting requires the adopter's own Cloudflare account and the relevant infrastructure accounts.

### Design assumptions to validate

Cloudflare placement of control state is a user decision. The D1/Durable Objects/R2/Secrets mapping below is the selected design assumption; a development Worker, D1 database, and EU R2 bucket have partial live evidence, while coordination and secret recovery remain unproven. Talos, Cilium, and bounded local volumes have one-node lab evidence. Gateway implementation, tenant isolation, recovery, and production failure-domain guarantees still require their stated evidence. No additional servers have been ordered and no production data has been migrated.

## 2. Generic product boundary and early acceptance path

Build reusable PostgreSQL management software, not a custom backend for a named adopter. Domain models, defaults, quotas, budget units, error contracts, routes, and execution paths must remain customer-independent. Do not encode consumer-specific plan names, driver versions, timeout constants, billing conventions, identifiers, or polling schedules in the platform.

Run an early native PostgreSQL pilot ahead of the full gateway, serverless lifecycle, and workbench. Start with one disposable, always-on CNPG environment over verified TLS, with ordinary scoped roles, transactions, backup, and independent restore. Use generic public interfaces and a small representative workload; an early adopter may exercise the same path. The pilot is an operational baseline, not an exemption from v1 sleep/wake or autoscaling.

### Platform versus consumer responsibilities

| Capability            | Generic platform responsibility                                                                                          | Consumer responsibility                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Lifecycle             | Versioned create/observe/delete operations, stable identities, safe handling of uncertain outcomes.                      | Map local project/environment identities and reconcile the platform's operations.                              |
| PostgreSQL access     | Document native/direct/pooled endpoints, TLS, role boundaries, transaction semantics, and supported connection behavior. | Configure its drivers, migration tools, application pools, cancellation, and reconnect handling.               |
| Resource policy       | Publish supported size ranges, idle policy, scaling limits, and observed state.                                          | Map its service plans into supported configuration without asking for named-plan exceptions.                   |
| Timeouts and recovery | Declare measured startup, interruption, and recovery behavior and supported configuration.                               | Reconcile its client deadlines and recovery requirements with that contract.                                   |
| Usage                 | Offer documented units, time windows, granularity, freshness, revisions, and completeness.                               | Map those facts into its own usage model and choose an appropriate polling cadence.                            |
| Budgets               | Authorize and enforce scoped limits/allowances with explicit units and stop/resume behavior.                             | Allocate its database allowance from any wider wallet and provide authorized conversion policy where required. |

Consumer-specific compatibility snapshots and TODOs belong in the consumer's PLAN.md. In particular, ohmyho.st owns its PGCF adapter, Neon-specific registration removal, timeout/profile mapping, usage ingestion, wallet allocation, and migration tasks. Do not make those private implementation details universal platform requirements or an upstream release dependency. A missing shared capability may be proposed here only with a general use case, rather than an adopter-specific branch.

## 3. Reuse strategy and adoption gates

Prefer maintained upstream packages, images, and APIs. Preserve licenses and notices, pin releases and artifact digests when integrating, and keep necessary adapters or forks narrow. Apache-2.0 covers first-party work; it does not relicense third-party components. See [THIRD_PARTY.md](THIRD_PARTY.md).

| Component                                  | Planned decision                                | Reuse and boundary                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| CloudNativePG                              | Core operator                                   | Delegate database lifecycle, replication, failover, roles, databases, resource changes, hibernation, and recovery integration.             |
| PgBouncer through CNPG                     | Default pooling candidate                       | Reuse pooling; document client/backend budgets and the direct path. Do not implement another pooler.                                       |
| Barman Cloud plugin and Barman             | Backup/recovery tooling                         | Reuse physical backups and WAL tooling; prove R2 upload, recovery, retention, and deletion independently.                                  |
| Talos, Kubernetes, Flux                    | Target operations foundation                    | Reuse declarative host/cluster operations and platform release reconciliation. Contabo bootstrap and maintenance remain unverified.        |
| OpenEBS LocalPV LVM                        | Local-volume candidate                          | Prove hard volume sizes, expansion, persistence across upgrades, and node-loss rebuild.                                                    |
| Neon proxy                                 | Evaluation candidate, not preferred or selected | Evaluate existing native/HTTP/WS protocol handling and wake integration against both technical and maintenance criteria.                   |
| [Xata OSS](https://github.com/xataio/xata) | Evaluation candidate for gateway and sleep/wake | Inspect its SQL gateway, CNPG scale-to-zero plugin, and management services for bounded reuse before implementing equivalent capabilities. |
| Neon serverless driver                     | Optional client integration                     | Test only against the protocols actually supplied by the selected gateway.                                                                 |
| Supabase postgres-meta                     | Optional private administration tooling         | Reuse metadata, SQL administration, and type generation behind our authorization and routing.                                              |
| Supabase Studio                            | Optional selected-database workbench            | Prefer narrow integration before a persistent fork. It is not a prerequisite for the pilot or a ready-made multi-project SaaS console.     |
| PostgREST                                  | Optional database REST/RPC API                  | Preserve grants, RLS, and JWT role boundaries; keep it separate from the management API.                                                   |

### Gateway and component reuse gate

Xata OSS is [Apache-2.0 licensed](https://github.com/xataio/xata/blob/main/LICENSE) and builds on CloudNativePG. Evaluate the actual component boundaries, dependencies, maintenance, and fit with Cloudflare as the authoritative control plane. Copy or adapt a component only after its license notices, integration cost, and tenant isolation pass the relevant M5/M6 acceptance checks. [Xata explicitly advises against using its OSS release unchanged for a public Postgres service](https://github.com/xataio/xata#readme), because some protections for adversarial multi-tenancy remain closed-source; do not assume its gateway is safe for unrelated customers without resolving that gap.

The public Neon proxy history shows very limited recent activity, including a functional [authentication fix on 2026-05-25](https://github.com/neondatabase/neon/commit/8f60b04da47ffefe0e52bda2440134b42874eb75). This is a maintenance concern, not evidence that the repository is officially discontinued or that a specific vulnerability exists.

Before adopting it, identify a maintainer, an upstream/dependency update process, security-response ownership, supported protocol behavior, and the size of the local patch surface. Technical acceptance must cover native clients, each offered HTTP/WS mode, authentication, credential invalidation, cancellation, timeout handling, tenant isolation, and coalesced wake operations.

Neon's [control-plane interface](https://github.com/neondatabase/neon/blob/main/proxy/src/control_plane/mod.rs) supplies useful access-control and `wake_compute` seams, but its ordinary-Postgres testing backend is not a production adapter. Passing a connection test is insufficient. Do not automatically replace a rejected candidate with a new protocol implementation; record and review the alternative architecture.

Neon's storage engine and NeonVM remain outside CNPG v1. Supavisor is an alternative only if measured connection requirements justify it. OpenMeter/OpenCost do not become prerequisites for usage reporting, budget enforcement, or this revision.

## 4. Cloudflare control state and regional execution

### Authoritative state on Cloudflare

| Responsibility         | Selected design assumption                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Management API         | Workers expose REST `/v1`, validate identity and scope, and serve generated-client contracts.                                                                                                                             |
| Canonical control data | D1 stores organizations, projects, desired state, mappings, operation records, idempotency identities, accepted usage facts, budget policies, and allowance reservations.                                                 |
| Coordination           | Durable Objects serialize resource operations and schedule checks. They reconstruct authority from D1 instead of maintaining a competing desired-state database.                                                          |
| Large artifacts        | R2 stores database backups/WAL, exports, and archived usage evidence. D1 holds their identities, checksums, status, and references.                                                                                       |
| Secrets                | Worker Secrets hold provider credentials and root/signing/encryption keys. Dynamic credentials are encrypted before D1 persistence with scoped context and key-version metadata; verification-only API tokens are hashed. |

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

| Layer                 | Responsibility and limits                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application `pg.Pool` | Bounds application client concurrency and idle sessions; it does not replace server-side database pooling.                                                                   |
| Regional gateway      | Authenticates, routes, coordinates wake, and enforces admission. Do not assume it is another pooler; any protocol-specific pooling must have an explicit purpose and budget. |
| CNPG PgBouncer        | Owns backend pooling for the pooled endpoint, with per-environment and fleet-wide connection/queue bounds.                                                                   |
| PostgreSQL            | Owns sessions, transactions, statement limits, and database connection limits.                                                                                               |

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

| Responsibility             | Component                               | Platform coordination                                                                     |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Hardware/hypervisor        | Contabo                                 | Provider incident handling and VM replacement.                                            |
| VM provisioning/networking | Contabo API                             | Inventory, capacity requests, machine identity, bootstrap, and tracked operations.        |
| Guest OS/kernel/runtime    | Talos                                   | Approved images, one-node-at-a-time upgrades, and recovery.                               |
| Kubernetes lifecycle       | Talos tooling                           | Supported version progression, quorum checks, and etcd recovery.                          |
| Platform components        | Flux                                    | Pinned releases, staged promotion, and drift reconciliation.                              |
| PostgreSQL                 | CNPG                                    | Version policy, rolling changes, replication health, and maintenance status.              |
| Backups/WAL/PITR           | Barman integration                      | Retention, freshness, restore drills, and safe deletion.                                  |
| Pod/host networking        | Cilium / Talos firewall                 | Explicit ownership and default-deny policies without competing host-firewall controllers. |
| Certificates               | CNPG PKI and cert-manager               | Renewal, expiry monitoring, and separate trust domains.                                   |
| Operational telemetry      | Prometheus, Alertmanager, OpenTelemetry | Measurements, actionable alerts, and incident evidence.                                   |

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

The [manual base-backup source](docs/contracts/manual-backups-v1.md) adds
generic scoped intent, collection/item reads, durable regional dispatch and
operator-reported artifact custody. A successful response accepts an operation;
it does not establish archive or recovery verification. Physical execution is
an explicit installation opt-in, disabled until the selected archive path is
qualified. Dispatch replay and lease reclaim are observation-only; an uncertain
or missing recorded Backup cannot authorize a second physical backup. Manual
suspend waits for pending backup operations, while hard budget stopping remains
independent. Backup identities, dispatches and terminal metadata belong to the
canonical Cloudflare control-state recovery artifact.
The [source checkpoint](docs/evidence/m3-manual-backups-2026-09-29.md) retains
the three bounded red-first cases and the original final-gate stop. A resumed
constructor-only compatibility correction passes all four affected existing CLI
cases without new cases or another full gate. Source delivery and Dev migration
are recorded separately; physical provider/recovery qualification remains open.

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

Deduplicate repeated delivery, preserve original evidence, and expose corrections. Verify the documented aggregation, query-window, and correction contract; individual consumers choose and test their own polling cadence. No price, invoice, or monthly charge is fabricated from incomplete facts.

### Budget management and enforcement

Provide ordinary authenticated APIs to set/read/update a scoped project or database budget, inspect usage and remaining allowance, receive threshold/exhaustion events, and resume after an authorized allowance change. Keep hard enforcement and advisory reporting distinguishable.

Budget-unit semantics must be explicit. Resource-unit limits can be evaluated directly; integrator-defined usage-credit limits require an operator-authorized, versioned conversion/allocation policy. This is enforcement configuration, not a platform-owned retail price catalog. The integrator owns its customer prices and aggregate wallet and assigns only the intended database allowance. Untrusted application callers cannot grant themselves budget authority.

Track granted, consumed, and reserved allowance separately. Reserve or lease bounded execution authority before budget-consuming work; reconcile actual usage and release unused reservations with stable identities. Define the maximum enforcement delay/overshoot and the behavior of running sessions, new connections, wake, and resize. A delayed usage API alone cannot implement a hard cap.

For an enforcing stop, prevent new admissions and resource increases and perform the documented drain/suspend policy. Preserve data and retained backups; stopping compute does not remove persistent storage or guarantee zero infrastructure cost. Resumption requires an authorized policy/allowance update. Technical resource quotas remain distinct from monetary or credit-denominated budgets.

Test concurrent reservations, duplicated grants/events, period rollover, revisions, revocation, exhaustion during execution, stop/resume, offline regional allowances, and replay after recovery. No payment processor, subscription engine, checkout, or invoice service is needed for these v1 capabilities.

## 8. Delivery sequence and evidence

| Milestone                                                   | Deliverable                                                                                                                        | Required evidence                                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 — Repository foundation: complete**                    | Apache-2.0, project guidance, canonical roadmap, component inventory.                                                              | Initial public commit `b7d790d`; documentation changes remain distinct from runtime progress.                                                                                               |
| **M1 — Infrastructure and control-state feasibility**       | Talos/Contabo/volumes/CNPG/R2 proofs; validate the Cloudflare state, secret, and recovery design.                                  | Unattended boot, persistent/enforced storage, database/backup recovery, benchmark baseline, and control-state design ready before M3.                                                       |
| **M2 — Early generic PostgreSQL pilot**                     | One disposable always-on environment through the ordinary platform interface, without a custom gateway or workbench dependency.    | Representative application queries/transactions/migrations, scoped roles, lifecycle, usage, backup, and independent restore; adopter-specific integration remains in its own repository.    |
| **M3 — Cloudflare management, usage, and budget APIs**      | D1-backed authority, scoped API/SDK, operation tracking, usage ingestion/query, budget policy/reservations, and regional protocol. | Authorization, idempotency, concurrent updates/reservations, correction/replay, stop/resume commands, and recovery reconciliation.                                                          |
| **M4 — Secure fleet operations**                            | Provisioning, staged updates, replacement, isolation decision, and observability.                                                  | Node maintenance/failure, disk-full containment, cross-tenant tests, credential/key recovery, and restore onto fresh infrastructure.                                                        |
| **M5 — Gateway and connection ownership**                   | Select a maintainable native gateway, validate endpoint failover, and set pool/queue limits.                                       | Maintainer/update ownership, authentication/invalidation, cancellation, direct/pooled semantics, gateway/node/network failures, and client reconnect behavior.                              |
| **M6 — Serverless lifecycle**                               | Automatic sleep/wake, manual resize, bounded automatic compute scaling, and end-to-end budget enforcement.                         | Cold-request deadlines, concurrent wake, long transactions, cooldowns, capacity exhaustion, allowance exhaustion, and management-outage behavior.                                           |
| **M7 — Developer experience and integration qualification** | Complete API/CLI docs and usage/budget examples; evaluate optional HTTP/WS, Data API, and workbench integrations.                  | Repeatable installation and operator workflows; any shipped optional interface has its own compatibility/security evidence. No hosted billing dependency.                                   |
| **M8 — Open-source production readiness**                   | Rehearsed operational release usable by independent adopters.                                                                      | Sustained workloads, recovery and upgrade evidence, measured service limits, generic migration guidance, and repeatable installation documentation; consumer rollouts are separately owned. |

M1 has a [live single-node infrastructure checkpoint](docs/evidence/m1-2026-09-28.md). Talos boot, node restart, Kubernetes networking, bounded local volumes, and a CloudNativePG SQL transaction with verified TLS and post-reboot readback were observed. R2 backup, independent restore, and production topology gates remain open.

The [backup/recovery preflight](docs/evidence/m1-backup-preflight-2026-09-29.md) verifies the existing unchanged manual Barman plugin, available local storage/request capacity and installed-API acceptance of the generic [recovery examples](infra/backups/README.md). No backup, WAL upload, restore or new credential is claimed. A specific single-bucket, 30-day R2 credential is prepared in the browser and awaits the security-policy confirmation required at its final creation action. The stopped Flux handoff remains stopped; ordinary database qualification must not disguise a new repair of that installation. Actual backup/PITR, retention/deletion and independent recovery remain M1 gates.

M3 has a [deployed Dev control API foundation checkpoint](docs/evidence/m3-logical-projects-2026-09-28.md): organization bootstrap, paginated recovery listing, region registration with a scoped token, and global logical project creation with a completed D1 audit operation. The [environment execution checkpoint](docs/evidence/m3-environment-execution-2026-09-28.md) records implemented immutable catalogs, explicit region admission, idempotent environment intents, fenced regional leases/results, and a CNPG controller that reconciles deterministic internal resources. Migration `0005` and the updated Worker are deployed; live readback verified closed admission, regional claim authorization, and preserved logical-project state. Local Worker/Node tests, package build, and container checks passed; the reviewed controller image was published to GHCR. The initial execution-only Dev deployment used source revision [8dc14f8](https://github.com/amerged-org/cloudflare-postgres/commit/8dc14f8e9e9b65e9a7853ce9cd33ebede6a10bb2), imported through Talos `ImageService.Import` and selected with `imagePullPolicy: Never`. A direct compiled `ControlClient` invocation from its running Pod authenticated to the control API and returned `{ claim: null }`. Anonymous registry pulling and API-to-CNPG qualification remain pending. No catalog or API-managed environment has been created. A ready observation does not yet supply a usable customer endpoint or credentials. The subsequent collector deployment and its limited runtime evidence are recorded below; neither deployment establishes complete coverage or enforcement.

The [usage and budget authority checkpoint](docs/evidence/m3-usage-budget-authority-2026-09-28.md) records additive migrations `0006`–`0007`, immutable exact usage revisions, fixed-watermark JSON/NDJSON pages, purpose-specific meter/grantor tokens, conditional policy periods/revisions, and project/environment allowance accounting with protected replay fences. The [implementation contract](docs/contracts/usage-budget-authority-v1.md) fixes their current wire shapes and authority boundaries. Fifteen Worker cases and one Node case passed after a reported, narrowly repaired typecheck stop; this was not an uninterrupted clean full gate. The Dev Worker and both migrations are deployed. Live readback verified unchanged pre-existing counts, no foreign-key violations, closed admission, empty exports with unknown coverage, separate token purposes, exact decimal grants, stale-write rejection, and requested pause/resume. There are still zero API-managed environments, accepted usage facts, and allowance receipts. A dedicated fence-key Worker Secret is configured, but receipt encryption/replay, real ingestion, settlement, and corrections remain unverified live. Budget and receipt resources report `runtimeEnforced: false` and `enforcementStatus: pending_runtime`. SDK/recovery qualification and the rest of M3 remain incomplete; M6 still requires complete/final usage, journal node-loss recovery, the allowance supervisor, independent expiry guard, and qualified stop/overshoot behavior. Admission stays closed until the region passes qualification.

The [owned logical database checkpoint](docs/evidence/m3-owned-databases-2026-09-29.md) adds scoped SQL-database creation under an applied role, current owner-credential disclosure and a separate fenced regional CNPG Database lane. Queued/running creation blocks owner rotation atomically; uncertain leases retain the same task. CNPG create-or-adopt behavior requires complete competing-manager/SQL-name absence preflight and an explicit trusted-admin writer boundary. Three red-first cases and one uninterrupted full gate passed all 37 tests. Migration `0010`, the Dev API and regional database lane are deployed with unchanged counts and closed admission. Runtime checks match compiled image code and preserve journal/Node/Pod/volume/SQL identities; live clients authenticate with empty queues. Real customer SQL ownership/migration, external access and backup/recovery remain required.

The [customer recovery checkpoint](docs/evidence/m3-recovery-reads-2026-09-29.md) adds bounded scoped project/environment/role/database discovery and canonical reads across all three operation stores. Resource lists expose current task IDs with signed parent-bound cursors; full task metadata keeps separate read authority and historical visibility without credential/lease disclosure. Three meaningful red-first cases passed candidate one. The single full gate passed format/lint/typecheck and 22 Worker cases, then stopped on missing regional build artifacts; compiling unchanged source and rerunning only the affected three-case Node file supplies passing evidence for all 40 cases without a second broad gate. Migration `0011` and the Dev Worker are deployed. Ten read-only API checks, preserved eight Secret names and one bounded post-auth D1 readback verify original resource recovery, unchanged counts, five indexes and closed admission. Positive regional SQL, SDK, production recovery and remaining M3 gates stay open.

The [real-SQL preflight](docs/evidence/m2-sql-verifier-preflight-2026-09-29.md) verifies the official PostgreSQL 18.4 image and explains Docker 29’s index/manifest/config identity representation. Its bounded fixture setup stopped after two observation corrections before any network, credential, SQL server or verifier invocation. A read-only OCI export confirms the exact configuration blob without resuming the qualifier. Real TLS/password/ownership/migration qualification remains open; no product source, new tests or broad-gate reruns accompanied this preflight.

The [native pooling checkpoint](docs/evidence/m2-native-pooling-2026-09-29.md) deploys one internal CNPG/PgBouncer session Pooler with independent frontend PKI, required client TLS, verified backend TLS and bounded resources/connections. One guarded five-object installation and one real SQL probe pass identity, transaction rollback, session state, plaintext/password refusal, protocol cancellation and fresh reconnection. Existing Node/Pod/volume/database/SQL identities are preserved. This is manual lab evidence: public endpoints, API pooling policy, quota/usage/stop integration, tenant network isolation, rotation/failover and production limits remain open. A supplemental effective-parameter observer stopped after two path errors without weakening the successful wire-level evidence. No application source/test/full-gate change or stopped SQL/Barman/R2 workflow resumption occurred.

The [managed pooling checkpoint](docs/evidence/m3-managed-pooling-2026-09-29.md) implements optional immutable session policies, derived CNPG certificate SANs, separate Pooler quota headroom, complete owned workload readiness, attributable platform compute and fenced normal stop covering Pooler convergence and all namespace Pods. Three meaningful red-first cases and narrowly repaired pre-freeze guards precede one uninterrupted full gate passing all 43 tests. The Dev API and sealed regional image are deployed; seven API probes, compiled Apps SDK/live empty claims, persistent journal progress and database/Pod/volume preservation pass. No pooled catalog/environment is admitted and no positive API-managed pooling/accounting/stop is claimed. Actual SQL/PKI, public gateway, isolation, independent expiry/final accounting, backups/recovery and the remaining M3/M5/M6 gates stay open.

The [explicit suspension checkpoint](docs/evidence/m6-environment-suspend-2026-09-29.md) implements manual desired/observed runtime state, durable scoped intentions, database-work/funding interlocks and a leased regional executor with identity sealing before shared owned stop. Three meaningful red-first cases and focused closure repairs precede one reported lint-gate stop; affected repairs and previously unrun stages supply passing evidence for all 46 cases without a second broad gate. Migration `0012`, Dev routes and the sealed image are deployed; empty-lane CLI/client, private journal progress and unchanged database/Pod/volume/permission evidence pass. No customer suspension is executed or executor activated automatically. Funded resume requires final settlement and exclusion of old stoppers; automatic idle/wake, real lifecycle qualification, independent expiry, scaling and recovery remain open.

The [execution-identity checkpoint](docs/evidence/m6-execution-fencing-2026-09-29.md) adds an opted-in initial run epoch to new immutable profiles and propagates it through readiness, suspend claims and sealed journals. Updated stop writers reject stale/legacy/mixed observed epochs and test the target epoch with UID/resourceVersion before mutation. Three meaningful red-first cases pass; one fixture-only lint repair after the single gate supplies passing evidence for all 49 cases without a second broad gate. Migration `0013`, Dev API and sealed image are deployed with unchanged counts, closed admission and preserved state. No fenced environment or later epoch is activated. Multi-object reads are non-atomic and old privileged binaries remain an operational exclusion/admission gate; actual handoff, final settlement, funded wake, scaling and recovery stay open.

The [accepted-usage checkpoint](docs/evidence/m3-accepted-usage-ledger-2026-09-29.md) retains exact server receipts and original payloads before outbox removal, upgrades legacy history conservatively and adds bounded pages plus verified private archive retirement. Three meaningful red-first cases cover metadata/refusal, restart, capacity, v1 upgrade and archive crash/idempotency; one uninterrupted full gate passes all 52 cases. The public-source image is deployed with a prior consistent journal restore sample, actual schema-two/source-identity/private-mode/progress evidence and preserved database/Pod/volume state. Control API/D1/Secrets are unchanged and live accepted inventory remains empty. No final facts, corrections or settlement are produced; physical final accounting, off-node custody, funded wake and recovery remain open.

The [direct runtime observer checkpoint](docs/evidence/m6-node-runtime-observer-2026-09-29.md) adds a maintained CRI client adapter with complete all-state enumeration, exact identity/nanosecond retention, bounded collection and conservative refusal. Exactly three meaningful red-first cases and one uninterrupted workspace/Go gate pass all 55 cases. Public-source image import is verified, but the one-shot live qualifier is held after two preparation corrections: its digest-addressed image was not resolvable locally and no observer process started. The temporary namespace is removed with original Node, 28 active Pod, four PV/PVC and both SQL-marker state preserved. Existing suspend receipts still establish Kubernetes convergence only; durable physical-stop proof, final usage, node-loss recovery and enforcement remain open. The running controller, Worker, D1 and Secrets are unchanged.

The [Talos image-reference procedure](docs/operations/talos-image-references.md) verifies the observer's missing exact digest alias independently of its held qualifier. One maintained cached Pull creates the alias in 0.165 seconds and exact-name readbacks preserve the approved image digest. No Pod, rebuild or repeated import occurs; the original runtime qualification is still held. Anonymous GHCR distribution remains open pending package-management access and actual unauthenticated retrieval.

The [stop-completion correction](docs/evidence/m6-stop-completion-truth-2026-09-29.md) prevents current suspend/allowance execution from treating Kubernetes convergence or historical journal success as physical termination. Explicit suspend defers promptly; allowance stays stopping, with no new physical timestamp or completion record and unchanged legacy evidence. Three existing cases fail first and pass on implementation attempt one. The one-time full gate stops on a predecessor Pooler result expectation; one literal expectation alignment, its named-file verification and the previously unrun Go check provide passing evidence for all 55 cases without a second broad gate. Source is published and deployed by one verified image import and one guarded image-only patch. All 46 compiled modules, private schema-two journal, Node/boot, 27 other active Pods, four PV/PVCs, RBAC, database/Pooler and SQL-marker preservation pass after one disclosed readback-selector correction. No customer stop is qualified; actual node-backed completion and every remaining v1 gate remain required.

The [original-node cohort checkpoint](docs/evidence/m6-execution-node-cohort-2026-09-29.md) records an optional immutable tracking policy, canonical ready reference, additive D1 migration `0014`, immutable stop claim, durable regional birth reservation before any Namespace effect, one-way Namespace/ConfigMap bindings and required CNPG/Pooler placement. Exactly three new red-first cases and scoped review corrections precede one uninterrupted full gate passing all 58 cases. The Dev API/migration and sealed regional image are deployed; 48 compiled modules, schema-two collector journal, unchanged control counts/eight Secret names, Node/boot, 27 other Pods, four PV/PVCs, RBAC/database/Pooler and SQL-marker preservation pass. Current operator Node-read authorization is absent and tracked configuration remains inactive: no positive tracked environment or physical stop is qualified. Missing/replaced history fails closed; final runtime evidence, journal node-loss recovery and all remaining v1 gates remain required.

The [database roles and credential rotation checkpoint](docs/evidence/m3-database-roles-2026-09-29.md) adds encrypted D1 credential versions, scoped customer role/create/reveal/rotate routes and a separate leased regional CNPG DatabaseRole lane. Fresh password-authenticated TLS and old-password rejection are required before disclosure; roles do not automatically receive table privileges or database ownership. Three red-first cases passed with disclosed narrow type/startup repairs after the single canonical gate; all 34 cases have passing evidence without a second full gate. Migration `0009`, a dedicated Worker key and the API are deployed in Dev. An application SQL-state snapshot restores exactly locally; standard D1 export permission and full Cloudflare/key recovery remain open. The sealed role image runs in Dev with authenticated empty-queue readback and preserved journal, Node/Pod/volume identities and SQL markers. Live probes verify authorization and an empty queue only. No API-managed database/role exists, admission remains closed, and positive CNPG/endpoint qualification is still required.

The [current allowance authority and normal stop checkpoint](docs/evidence/m6-current-allowance-authority-2026-09-28.md) adds a deployed read-only current-authority API and a separate durable regional supervision/normal-stop mode. Three meaningful red-first cases and one uninterrupted canonical gate passed all 31 tests. Current authority includes trusted project/spec/epoch bindings and every limited dimension; historical receipt replay cannot extend permission. Local tests verify uncertain reservation replay and an unfunded RAM stop with retained volumes. Dev route/credential probes passed with unchanged counts and closed admission. The regional mode is not deployed or activated automatically, and there are still no live allowances or API-managed environments. Independent workload-local expiry, ingress/draining, final accounting/settlement and real stop/overshoot evidence remain open; enforcement flags remain false.

The [regional provisional collector checkpoint](docs/evidence/m3-regional-usage-collector-2026-09-28.md) adds bounded actual request/PV observations, a source-sealed SQLite checkpoint/outbox, explicit unknown ranges and matching-receipt delivery. Exactly three new Node cases failed meaningfully first. One broad gate passed 19 cases; a later test-entry-path portability correction passed only its named file and is disclosed in the checkpoint. The pinned Node 24.21.0 Dev image is running with one writer and a persistent private journal. Live evidence verifies compiled client authorization, exclusion of the manual lab database, zero managed allocations, and persistent identity/modes plus a restart gap after one Pod replacement, while SQL markers remained readable. There is no positive customer measurement/delivery evidence or final/correction producer; the collector does not reserve/settle allowances or supervise PostgreSQL. Public image distribution, journal node-loss recovery, complete coverage and runtime enforcement remain gates.

The public [Talos bootstrap recipe](infra/talos/README.md) and [Flux platform baseline](infra/platform/README.md) record pinned releases and ownership boundaries. The [initial M4 platform adoption checkpoint](docs/evidence/m4-platform-adoption-2026-09-28.md) verifies live Flux controllers, source/Kustomization readiness at its reviewed commit, adoption of the existing Cilium/OpenEBS Helm releases, and restoration of one nonsemantic ConfigMap drift. That historical checkpoint preserved SQL markers without changing Helm settings.

The [cert-manager handoff checkpoint](docs/evidence/m4-cert-manager-adoption-2026-09-28.md), promoted in public commit [814bba1](https://github.com/amerged-org/cloudflare-postgres/commit/814bba19c47407355db1dbd35508a4750d2f18f4), verifies same-version `v1.21.2` adoption after 46 guarded ownership-metadata patches, using explicit SSA and `disableTakeOwnership: true`. Its Helm release and all three Deployments became current-generation Ready, and the startup API-check Job completed. CA hashes and the injector's CA-field ownership, SQL markers and node health were preserved. At that checkpoint three releases were active; CNPG/Barman remained suspended.

The [subsequent CNPG checkpoint](docs/evidence/m4-cnpg-adoption-2026-09-28.md), promoted in public commit [7abd879](https://github.com/amerged-org/cloudflare-postgres/commit/7abd8798a21d606c0ed8733e816e14a73fafae30), verifies 19 UID/resourceVersion-guarded ownership patches and one same-version `1.30.1` operator activation through the opt-in official-manifest compatibility overlay. Principal permissions, immutable selectors, configuration/TLS references and upstream query content are preserved. The current-generation release/Deployment, real webhook admission, all nine CA contents/leaf owners, PostgreSQL Pod identities/restart counts and SQL markers pass. Four releases and four Kustomization health checks are active; Barman remains suspended and manual. M4 remains incomplete: unattended provider provisioning, host maintenance, staged upgrades, failure recovery, restore, and independently reproducible production installation remain open M4/M8 gates.

The [Barman preflight checkpoint](docs/evidence/m4-barman-preflight-2026-09-28.md) records public prepared stage/activation assets in commit [c621a2a](https://github.com/amerged-org/cloudflare-postgres/commit/c621a2a7cc98a46d9f11604c62ed16df202f575a), matched eleven-object ownership inventory, strict metadata/certificate/dependency checks, and one failed twelve-object SSA dry-run. The old Secret and new ConfigMap `SIDECAR_IMAGE` references coexist during initial SSA. Two private observation corrections were used; the whole bounded preflight remains stopped. A precise field-migration proposal is unapplied and requires one explicit additional-attempt exception. No source promotion, ownership transfer, new runtime ConfigMap or Barman rollout occurred. One independent first-attempt Contabo auth/inventory read confirmed both authorized VPS running at provider level; guest deployment/maintenance and backup/PITR remain unqualified.

The [platform inspection checkpoint](docs/evidence/m4-platform-inspection-2026-09-28.md) implements generic `inspect-platform` mode in the regional package, using explicit operator configuration and the existing bounded Kubernetes inventory reader. It reports current generation/deployed history/source pins, aggregate Node observations and explicit unverified SQL/recovery/quorum/capacity/isolation/runtime-image gates. Exactly three new cases failed first; the frozen one-time full gate passed 15 Worker and seven Node cases. Live readback correctly reports four Ready releases and suspended Barman at the reviewed active source. It creates no database, reads no Secret and starts no controller/meter work. This is observation tooling; maintained telemetry, lifecycle jobs and M4/M8 operational qualification remain open.

The [telemetry preparation checkpoint](docs/evidence/m4-telemetry-preparation-2026-09-28.md) supplies standalone, suspended [maintained monitoring configuration](infra/telemetry/README.md): one checksum-pinned chart, six verified image manifest pins, bounded local storage/resources, current-generation Flux state rules and a null alert receiver. The pinned Promtool validated 32 unchanged rule files / 227 expressions; no new runtime tests or full workspace gate were run. Fresh read-only observations establish request/storage fit and configured external TCP9100 denial, while existing limits remain oversubscribed and Pod-to-host denial is absent. The configuration is not installed or included in the active source. Generic tenant/host isolation is the next rollout gate; API/PSA, actual metrics/TLS/PVC stats and sustained operational qualification remain pending.

The [telemetry boundary checkpoint](docs/evidence/m4-telemetry-boundary-2026-09-28.md) qualifies actual default PodSecurity enforcement under the CNPG principal and live read-only KSM scalar generation/identity behavior. It adds a separate, commit-pinned stage source with a narrow managed-Pod TCP9100 deny and operator-namespace ingress policy; no CNI/host-firewall rollout or existing platform-source change is proposed. The independent source and eight Flux-owned stage resources are live at their reviewed commit, with the release held and zero metrics Pods/PVCs. Matching non-audit revision6 maps and one actual TCP9100 attempt prove the selected managed-Pod deny path; permitted Prometheus scraping, namespace API isolation and full telemetry still need controlled runtime qualification. Host/hostNetwork/unmanaged actors and protected namespace/SA creation remain explicit trusted-operator boundaries.

The [controlled telemetry install checkpoint](docs/evidence/m4-telemetry-install-2026-09-28.md) records the initial duplicate-label failure and its one minimal correction, calibrated configuration-digest proof, and a stopped read-only preflight for a valid null empty list. The latter was corrected without resetting its conservative two-repair limit or activation ledger. One actual corrected install passed rendering but failed on PrometheusRule webhook admission; independent reconciliation is held after 29.059 seconds. Five Pods, two bound PVCs and four ready certificates/issuers exist, but all 30 chart rules are absent and runtime image IDs establish only index pins. One later server-side dry-run of the exact failing Rule passes its selected admission/TLS path at the Ready Operator without persisting it; this does not prove the original cause or repeatable bootstrap. The original source, four platform releases, Node/database and SQL markers remain healthy. Next establish bootstrap readiness ordering and account for existing failed-release state before a new controlled operation. Full telemetry and permitted scraping remain unqualified; no security relaxation, cleanup, test-count reset or SDK/Barman/R2 resumption accompanies this checkpoint.

The [ordered bootstrap checkpoint](docs/evidence/m4-telemetry-bootstrap-order-2026-09-28.md) separates the complete 30-Rule upstream bundle from the core Helm action without changing expressions, selection labels, pins or retained storage. One actual SDK4/calibration check passes with controller-decorated metadata and 39 unchanged core payloads, ten preserved CRDs and 30 omitted Rules. The guarded warm upgrade reaches deployed revision two and current readiness under ten named health resources in 20.708 seconds; retained core/CRD/PVC/Pod identities and restart counters pass. The separate same-source Rule stage reaches Ready in 6.412 seconds, with all 30 exact specs/labels and Kustomize ownership verified. One bounded API observation and offline comparison bind all 30 groups/220 Rules to their source UIDs and metadata; all evaluate healthy without errors. Twenty-five query display forms differ, so full text equivalence is not claimed; Kubernetes specs independently match. The owned Node-exporter scrape succeeds. All three owned kubelet targets fail because their certificate lacks IP SANs; verification remains enabled and this is the next concrete diagnosis. Volume/platform metrics, alert/isolation/recovery and fresh cold bootstrap remain gates. The previous consumed observer and two-repair null-list limit are preserved; no security relaxation or SDK/Barman/R2 resumption accompanies this meaningful continuation.

The [serving-TLS correction](docs/evidence/m4-kubelet-serving-tls-2026-09-28.md) verifies the actual native Talos KubeletConfig and qualifies the one-bit serverTLSBootstrap correction in single-node Dev. A pinned upstream automatic approver is reused with a narrow Node/enrollment adaptation, post-SAR revalidation and duplicate-JSON rejection. Exactly three meaningful red-first cases pass after two corrections; the final isolated canonical/Go gate passes once in 131.643 seconds without changing frozen source or stopped SDK candidates. The adapted AMD64/non-root image is authenticated and imported; independently verified private enrollment and a separate commit-pinned Dev source are deployed and Ready. Exact signer authorization passes. One guarded patch returns no-reboot mode; an immediate JSON-stream observer failure is retained and resolved through read-only explicit active/persistent selection, without repeating the write. All 30 documents preserve only the intended change, effective bootstrap is enabled, and the authentic node CSR is automatically approved and signed. Certificate CA/server-purpose/DNS/IP/key checks and all three fresh verified HTTPS kubelet targets pass. Node UID/boot ID, seven selected Pod identities/restart counts, four PVC identities/bindings and both SQL markers are preserved. Later renewal, automated fleet-enrollment maintenance, public image distribution and fresh cold bootstrap remain gates; TLS verification stays enabled. There are no new tests or broad gate reruns for the infrastructure readbacks, and SDK/Barman/R2 stopped work remains untouched.

The [platform telemetry continuation](docs/evidence/m4-platform-telemetry-2026-09-28.md)
adds a separately owned target stage under the unchanged pinned telemetry source.
Its two existing PodMonitors and two platform Rules pass admission and become
Ready after one guarded create in 3.814 seconds, preserving all 30 default Rule
identities/specs. A completed old Pod is excluded from active target expectations,
with the initial observer stop retained. Five controller targets are UP with
exact Pod UID/port binding; seven selected Rules evaluate healthy with source
UID/metadata checks. Real API comparison binds nineteen Flux generations and
eighteen active condition generations, matching both recording sets. Four PVCs
have coherent filesystem values when mapped through `exported_namespace`;
the initial direct namespace join was an observer error, not absent samples.
Authenticated running `1m0s`, mapped summaries and raw samples also correct a
premature inference from rendered Talos `0s`, without another machine change.
The actual null-only Alertmanager configuration has no integration; its name
label metadata is accepted after two offline observer corrections, without a
refetch or notification. A concrete namespace join defect still causes four
incorrect pending PVC-missing alerts; operational acceptance remains incomplete.
The next bounded two-case repair must normalize that alert's operands while
preserving global settings. One firing TargetDown and one firing sample-limit
alert have separate unresolved causes, and other namespace-filtered rules still
need useful-input evidence. No new tests, gate reruns, source promotion or
SDK/Barman/R2 resumption accompanies this checkpoint.

The [PVC namespace correction](docs/evidence/m4-pvc-alert-namespace-2026-09-28.md)
changes only the missing-metrics alert's operands, preserving global settings
and its existing delay/join/metadata. Two meaningful cases fail first and pass
after one correction; the frozen isolated canonical/Promtool gate passes exactly
once in 16.390 seconds. Source review and stopped-candidate hash preservation
pass. One guarded target-only source handoff is Ready in 5.224 seconds while
preserving all 32 Rule/two PodMonitor UIDs and protected original source specs.
The loaded same-UID Rule evaluates the correction with zero false alerts;
Node/boot identity, seven Pod identities and regular-container restart counts, four PVC bindings and
both SQL markers are preserved in an 18.069-second read-only observation.
Adopter assets use a separate pinned source and retain a held default. No
frozen source changes, extra cases or gate reruns follow qualification.
A separate fresh API-server observation
measures 32,251 post-filter samples against the 20,000 cap; it requires its own
capacity correction, not a speculative global change in this candidate.

The [API scrape-capacity correction](docs/evidence/m4-api-sample-capacity-2026-09-28.md)
measures 32,254 retained samples against 20,000 and introduces one bounded API
allowance of 40,000 while preserving the other thirteen effective limits at
20,000. One named maintained-Operator test reaches meaningful RED after two
recorded setup corrections, then passes after one implementation correction.
Calibrated production SDK4 preserves 37 core payloads/ten CRDs and changes only
the two intended resources. The frozen canonical/Go gate passes once in 141.276
seconds using exact production inputs. Core-only revision-three promotion and
two-scrape memory/head-series/storage/state-preservation evidence now pass. The
single revision-three upgrade succeeds, but its history observer stops after
27.347 seconds and safely holds the writers. Metadata-only readback preserves
all three Helm storage records; the missing status entry is the controller's
bounded projection. A 90.199-second window proves API Up, 32,321 retained
samples within 40,000, thirteen unchanged limits, stable failure counter and
measured memory/head/filesystem effects below the declared bounds. Node/boot,
seven Pod identities/regular restart maps, four PVC bindings and SQL markers
remain healthy. A separate same-revision unhold reaches Ready in 8.742 seconds
without another upgrade, preserving the failed observer record and original
ledgers. Default/target/platform/kubelet sources and all stopped work remain
protected; sustained production capacity and other operational gates are open.

### Operational acceptance evidence

Publish the workload, versions, topology, sample counts, and pass/fail thresholds before each implementation acceptance run. These are operational measurements; a pricing or break-even study is not required. The table lists milestone evidence areas, not instructions to generate test matrices or permutations: select only the concrete cases needed for the current change, subject to section 10.

| Test                       | Measure                                                                                         | Acceptance rule                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Talos bootstrap            | Provision-to-ready duration, failed/repeated boots, operator interventions.                     | Reproducible authenticated bootstrap without manual console fixes; failed attempts recover without duplicate resources.                     |
| Disk and competing tenants | Durable write/read latency, throughput, p95/p99 under realistic concurrent workloads.           | Meet the declared workload target without cross-tenant disk exhaustion or loss of durability.                                               |
| Database density           | Idle/active memory, reserved CPU, connection counts, and recovery headroom.                     | Demonstrate a safe capacity envelope, including a node failure/maintenance case; do not derive density from nominal RAM alone.              |
| Native and cold access     | Connection-ready and end-to-end query p50/p95/p99, maxima, and timeout/error counts.            | Meet the declared platform latency target and configured deadline behavior; consumers validate their own client timeout budgets separately. |
| Resize and maintenance     | Drain duration, reconnect window, failed/uncertain transactions, replica catch-up.              | Bound interruption and prove correct error handling without blind write replay.                                                             |
| Recovery and retention     | Recoverable timestamps, recovered content, restore time, archive continuity, deleted objects.   | Prove the declared history window, safe deletion, and recovery on a fresh cluster with distinct archive identity.                           |
| Usage and budgets          | Coverage, freshness, duplicate/correction handling, reservation accuracy, enforcement delay.    | Reproducible reporting, no double consumption, bounded stop behavior, and explicit gaps rather than invented usage.                         |
| Gateway/control outage     | New/existing connection behavior, policy validity, usage-buffer recovery, allowance exhaustion. | Demonstrate the documented degraded behavior, failover and reconciliation without granting unlimited authority or deleting data.            |

The [allocation continuity checkpoint](docs/evidence/m3-allocation-continuity-2026-09-28.md) separates stable ownership/rate proof from volatile observations, shares direct/retained PV identity and conservatively transitions legacy checkpoints without rewriting queued facts. Three new cases failed first. The original TypeScript gate stop remains documented; a focused guard repair and previously unrun stages complete qualification without a second full gate. The integrated public source is deployed in Dev through one sealed image build/import and one conditional collector image replacement. All 17 compiled modules, journal identity/session/checkpoint/private modes, existing empty outbox, Node/non-collector Pod/PVC identity and both SQL markers are verified. Live managed inventory remains empty; complete/final accounting and runtime budget enforcement stay open.

The [maintenance preparation checkpoint](docs/evidence/m4-maintenance-preparation-2026-09-28.md) implements a separate installation/region-owned API, hashed preparer credentials, immutable plans, scoped idempotency, fenced leases and durable assessments. Three bounded red-first cases cover authority/replay, standalone refusal and a lost committed Job response. Its original lint stop remains documented; a one-word repair and previously unrun stages complete qualification. The same Dev Worker and migration `0008` are deployed. A compiled CLI reads real inventory and persists six blockers for the standalone rehearsal; no Job, drain, upgrade, reboot or execution authorization occurs. Actual maintenance, recovery, staging, spare capacity, connected dry-run/artifact qualification and unattended fleet policy remain M4 gates. These changes do not resume the stopped SDK or Barman work.

## 9. Decisions to deepen before implementation and release

- Before M1/M3: finalize Cloudflare schema and retention, backup/key custody, management auth, and the state/operation/allowance reconciliation model.
- Before M2: define the generic native-PostgreSQL pilot contract and disposable migration/restore procedure; track consumer adapter work in the consumer repository.
- Before M4/M5: approve the tenant isolation guarantee, maintenance responsibility, gateway choice and native endpoint failover design.
- Before M6: freeze sleep eligibility, cold-start/reconnect deadlines, scaling thresholds, budget units/periods, enforcement bounds, and disconnected-region policy.
- Before M8: verify replica topology, synchronous-commit behavior, actual failure domains, recovery objectives, installed-version support, and safe capacity reserves.

Implementation assumptions must be resolved with evidence, not advertised as existing guarantees. Hosted SaaS/reselling and branching require later plans; neither is a gate for this open-source delivery.

The [node runtime transport checkpoint](docs/evidence/m6-node-runtime-transport-2026-09-29.md) adds a resident Go agent, challenged self identity and a bounded verified-TLS Kubernetes Exec adapter with explicit operator configuration. Exactly three new top-level cases fail first and the single frozen full gate passes all 61 cases. Contabo credentials are confirmed as Dev Worker Secret names; local credentials remain private. Live resident execution is not yet qualified; stop completion, original cohort coverage, independent expiry and finalized accounting remain open.

The [runtime image identity repair](docs/evidence/m6-runtime-imageid-repair-2026-09-29.md) addresses a concrete post-rollout mismatch: repository-index-pinned Pods report the exact index reference rather than only the configuration digest. One existing case fails first and passes the narrow correction; no cases are added. Its separate frozen workspace gate passes once, with unchanged Go evidence retained. The corrected source is deployed; exactly one protected resident CLI invocation reports 59 containers and 37 sandboxes with validated identities, and all pre-existing resources remain unchanged. Original-cohort completeness, a durable node-local start/restart fence or quiescence acknowledgement, independent expiry and final accounting remain open.

The [local execution deadline guard](docs/evidence/m6-execution-guard-2026-09-29.md) wraps the unchanged manager command with an immutable boot/run window, absolute CLOCK_BOOTTIME expiry and complete private-namespace cleanup. Two Go cases and one real Linux case fail first, then pass; the single frozen gate passes, with 63 automated cases plus the Linux qualification and no matrix growth. It is not yet activated for CNPG: secure funded renewal/admission, native retained-Pod acknowledgements, Pooler/sidecar coverage and final accounting remain required. The next physical-stop path retains each Pod UID before deletion, validates complete kubelet container termination plus original-node CRI evidence, and durably records each acknowledgement before releasing only its retention finalizer; phase alone is insufficient.

The [native Pod retirement checkpoint](docs/evidence/m6-pod-retirement-2026-09-29.md) adds an explicit default-off operator lane: durable original Pod roster, guarded retention, complete native terminal/CRI receipts and current-state revalidation before guard removal. Two Node cases and one isolated Talos/CNPG lifecycle fail first, then pass; the single frozen gate passes with 65 automated cases and unchanged Go evidence retained. The committed marker survives native hibernation and a separately manual fixture restart; 29 original active Pods and four volumes remain preserved. The [contract](docs/contracts/pod-retirement-v1.md) keeps whole-environment birth/admission completeness, independent funded expiry, run handoff and final accounting open; Suspend still reports physical_verification_pending.

The [Pod birth admission candidate](docs/evidence/m6-pod-birth-held-2026-09-29.md) is held after two native qualification preparation corrections. Its two new targeted source cases pass and actual guard assignment/unauthorized-removal/label-opt-out checks have evidence; the dedicated release remains unqualified. The draft is preserved without merge, activation, full-gate execution or completion claim. Safety cleanup restores original resources. Whole birth history, guard handoff, funded expiry and final accounting remain open.

## 10. Bounded TDD and verification discipline

The [disk-full neighbor checkpoint](docs/evidence/m4-disk-full-containment-2026-09-29.md)
passes one native same-Node/VG two-volume exercise in 33.184 seconds. Target
`ENOSPC`, sibling durable writes, original PostgreSQL reads, 29 Running Pod
identities and five original volumes are preserved; exact owned cleanup restores
physical LVM capacity. No runtime source or held qualifier changes. This advances
filesystem containment only; PostgreSQL own-volume recovery, complete tenant
isolation, backups/PITR and production readiness remain open.

The [fleet inventory checkpoint](docs/evidence/m4-fleet-inventory-2026-09-29.md)
adds an installation-only Contabo read path and explicit provider/Node correlation
for maintenance exclusion. Two red-first local cases pass. After the original
lint stop and the user's explicit resumption, only equivalent validators receive
targeted corrections; previously unrun typecheck/Vitest/Node stages pass once with
27 Worker and 34 Node cases, retaining six unchanged Go cases. No full gate is
repeated. The Dev Worker and compiled inspector now qualify both authorized
instances, one explicit Node binding and one unmanaged builder, with private
output and unchanged schema/Secret/infrastructure/SQL state. Association cannot
grant machine identity, reserved capacity or update authority. Other held
workflows remain untouched; M4 is still incomplete.

The [control recovery checkpoint](docs/evidence/m3-control-recovery-2026-09-29.md)
qualifies a bounded one-read Dev D1 capture, encrypted bundle and exact quarantined
offline reconstruction. The user's explicit resumption preserves the original
[stopped attempts](docs/evidence/m3-control-recovery-held-2026-09-29.md); a balanced
SQL composition resolves the compound-SELECT and expression-depth limits within
two resumed corrections. The same two meaningful red-first local cases pass and
one final full gate passes 69 automated cases, including six unchanged Go cases.
Actual capture/seal/restore verifies 40 tables, 47 rows, 121 schema objects and all
14 migrations; both existing private keyrings are recovered exactly. Dev retains
zero encrypted credential/fence rows; positive historical crypto uses actual
Worker-generated fixtures. No control activation, provider write, key rotation,
server rollout or D1 migration occurs. Independent off-node custody, global
fencing, fresh Cloudflare bootstrap and safe service reactivation remain open.

The [customer lifecycle contract checkpoint](docs/evidence/m3-api-lifecycle-contracts-2026-09-29.md)
adds seven already shipped role/database methods to OpenAPI and supplies generic
[adopter examples](docs/guides/database-lifecycle-v1.md). Exact scopes, bodies,
replays, current credentials and conflicts are source-checked; 45 prior methods,
existing schemas and held SDK remain unchanged. This is contract completion,
not new runtime behavior or a qualified end-to-end installation.

The [verifier namespace guard checkpoint](docs/evidence/m4-verifier-namespace-guard-2026-09-29.md)
closes an operator label override before credential/Kubernetes access, with one
meaningful red-first regression and one final passing gate covering 70 automated
cases including six unchanged Go cases. A public-source-only image is imported
once and the Dev controller receives one guarded image-only update. All 59
compiled modules, the actual guard, Node/28 other Running Pods/four PVCs/five PVs/
SQL markers and eight Cloudflare Secret names pass readback. The existing private
journal retains all 4,096 pending facts and five coverage-gap codes; D1 still has
zero accepted facts and closed admission. Unreconciled saturated usage remains
an accounting/admission gate. This is not native traffic isolation, final usage
or runtime budget enforcement, and no held workflow is resumed.

The [complete usage-journal custody checkpoint](docs/evidence/m3-usage-journal-custody-2026-09-29.md)
traces all 4,096 refused facts to a noncanonical prior Pod-retirement fixture and
its preserved Released/Retain volume. Actual HTTP 404, matching active meter/
source/epoch and zero D1 environments establish the authority gap; no customer
mapping or weak acknowledgement is fabricated. A generic explicit full SQLite
snapshot lane passes two meaningful red-first cases and one final gate with 72
automated cases including six unchanged Go cases. One live 3,076,096-byte snapshot
is verified off-node with exact nine-table schema, identity, integrity, queue
hashes and preserved original infrastructure/SQL state. The snapshot stays
inactive. The original queue/volume remain retained; explicit evidence disposition,
qualification ownership, delivery visibility, scheduled custody, node-loss recovery
and fenced replay remain open before customer admission.

The [same-node network policy checkpoint](docs/evidence/m4-network-isolation-2026-09-29.md)
qualifies one client-to-foreign-namespace TCP 5432 denial using four matching
Cilium policy-drop events and successful nonce controls before/after. Exact
production-generated policies, Pod/Namespace/policy UIDs and realized rule
provenance are verified. The original failed revision-equality observer remains
archived; one upstream-verified private correction passes the same case in
33.707 seconds. Fresh Restricted/no-token/no-volume fixtures omit billing labels
and are removed with UID guards. Original Node/29 Running Pods/four PVCs/five PVs/
SQL markers/global policy and all 4,096 pending usage hashes remain preserved.
No runtime source/tests/full gate change occurs. Reverse/all-protocol, SQL/TLS,
verifier/gateway, multi-node and kernel/host isolation remain separate gates;
this limited proof does not establish complete production tenancy.

The [durable delivery diagnostic checkpoint](docs/evidence/m3-usage-delivery-diagnostics-2026-09-29.md)
adds one bounded source/fact-bound last-failure record, safe paired HTTP codes and
atomic matching clear only on strict accepted receipts. Two meaningful red-first
cases pass on attempt one; one final gate passes 74 automated cases including six
unchanged Go cases. The public-source Dev image is imported once and receives one
guarded image-only rollout; all 63 compiled modules and actual 383-byte background
`404/not_found` diagnostic pass readback. Original Node/28 other Running Pods/
volumes/SQL and all 4,096 outbox hashes remain preserved. No acceptance, source
rewrite, D1 migration, Secret/Worker change or fake customer authority occurs.
This supplies failure visibility only; explicit fixture evidence disposition,
complete accounting, safe replay and runtime enforcement remain open.

The [restricted-role checkpoint](docs/evidence/m4-postgres-role-boundary-2026-09-29.md)
fixes a real CNPG typed-readback mismatch with only documented omitted false/empty
role defaults, keeping privilege/membership/inherit and identity fences strict.
Two existing cases fail first and pass on attempt one; one final gate retains the
74-case total. A distinct manual TLS role probe passes selected flags/membership,
TEMP transaction rollback and four exact `42501` refusals on same-case attempt two,
with original failed preparation preserved. Exact ephemeral role/Secret/client
cleanup restores all 21 original SQL roles and operator Role permissions.
The verified public-source image reaches Dev after one terminally canceled transfer
and one bounded same-archive retry, then one guarded image-only rollout. All 64
compiled modules, original infrastructure/SQL and 4,096 usage hashes/diagnostic are
preserved. No API-managed verifier/rotation/customer endpoint is qualified by this
manual proof; physical recovery and other v1 gates remain open.

The [offline custody verification checkpoint](docs/evidence/m3-usage-snapshot-verification-2026-09-29.md)
adds the generic `verify-usage-snapshot` operator command. It binds a recovered
complete journal to an independently retained identity and SHA-256, checks the
existing manifest, private files, integrity and pending count, and uses the same
bounded child with immutable read-only SQLite exclusively for a quiescent copy.
Two meaningful red-first cases pass on attempt one; one canonical gate passes
27 Worker and 43 Node cases, retaining six unchanged Go cases for 76 total evidence.
One built-command invocation verifies the existing 3,076,096-byte off-node copy
and 4,096 pending facts without changing either artifact or creating auxiliary files.
No provider/runtime/control-state change or stopped case resumption occurs.
Verification permits no replay, settlement or customer admission; complete
node-loss recovery, final accounting and the other v1 gates remain open.

The [private native-access preflight](docs/evidence/m3-private-native-access-preflight-2026-09-29.md)
prepares an opt-in protected application ingress and scoped internal endpoint API.
All three new cases fail first and pass on implementation attempt one; independent
source/contract review passes. The one canonical gate stops in 9.896 seconds on
two Worker fixture type errors after passing format and lint. That failed gate is
preserved. The [subsequent delivery](docs/evidence/m3-private-native-access-delivery-2026-09-29.md)
applies only the prepared test correction, passes its named checks and previously
unrun stages (28 Worker, 45 Node; six unchanged Go retained, 79 total evidence).
Source `811153c`, one Dev Worker deployment, four guarded read capabilities and
one verified regional image import/rollout are delivered. All 66 compiled modules,
eight Secret names, dashboard D1 counts, Node/other Pods/volumes/SQL and every
4,096 journal entry are verified. CLI D1 query 7403 remains unresolved; successful
authenticated dashboard reads supply independent before/after evidence without
new credentials or permissions. There is no second full gate, native profile
activation, customer admission, fabricated authority or held-case resumption.
Packet/TLS/SQL, public routing and end-to-end customer qualification remain gates.

The [native readback-shape checkpoint](docs/evidence/m3-native-readback-shapes-2026-09-29.md)
corrects two real integration mismatches observed through an operator lab and a
read-only existing-database audit: stock CNPG port name `postgres`, and omitted
Pod TypeMeta in SDK list results. One existing case is expanded and one new case
fails first; bounded targeted checks and one complete canonical gate pass
28 Worker/46 Node cases, retaining six unchanged Go cases for 80 total evidence.
Source `6daa265` and one verified regional build/import/image-only rollout are
delivered with all 66 modules, original infrastructure/SQL/config/RBAC and 4,096
entries preserved. No Worker, D1, secret, admission or budget change occurs.
The same actual private-native qualifier has two failed attempts, both before
credential copy/client Pods/SQL; the second creates an exact native policy but
withholds its final proof as `native_proof_unavailable`. It remains stopped with
no third attempt or relaxed identity fence. Both disposable databases are cleaned
up through recorded UIDs and owned volume reclamation; independent API/Talos
readbacks verify original 29 Pods, four PVCs, five PV/LV identities/free space,
SQL markers, Cilium and all 4,096 entries restored. Actual client access and
API-managed pilot acceptance remain unproven; read-only diagnosis of the final
identity/version comparison is the proposed next step.

The [native reference-diagnostic checkpoint](docs/evidence/m3-native-readback-diagnostics-2026-09-29.md)
records that the original final comparison cannot be identified from the archive;
later version churn does not prove its cause. Existing-system read-only parity
checks pass. Production `null` is a retryable deferral of the same owned operation,
so the one-pass operator result does not establish permanent provisioning failure.
Source `3b3bd73` adds one fixed operator-only category for the first failed existing
reference fence, preserving all reads, comparison order, null/owned-retry behavior
and acceptance checks. One existing case is expanded and one new case fails first;
one canonical gate passes 28 Worker/47 Node cases, retaining six unchanged Go
cases for 81 total evidence. One public-only image build/import/guarded rollout
delivers all 66 matching modules with original Node/Pods/volumes/SQL, 4,096 entries,
configuration and 16 RBAC rules preserved. No private metadata, credentials or
raw errors enter the diagnostic. No third physical case, native profile/customer
activation, CF/Worker/D1 change or original-cause claim occurs. The qualifier stays
stopped and native/backup/production acceptance remains open.

The [Cloudflare private-path assessment](docs/research/cloudflare-private-native-path-2026-09-29.md)
records the documented Hyperdrive/Workers VPC/Tunnel integration and its current
private-CA trust limitation. It selects no gateway, creates no provider resource
and keeps full origin certificate/hostname verification as an integration gate.

The [remote control archive checkpoint](docs/evidence/m3-control-archive-2026-09-29.md)
qualifies one upload of the existing encrypted bundle into the private EU R2
bucket, exact remote download and offline reconstruction from those downloaded
bytes. Existing operator access is reused; no new credential or runtime change
is made. The retained aggregate bucket metrics remain zero and do not supply
object-existence proof; the successful authenticated byte download does. The
ciphertext now has off-node custody, while independently recoverable key/receipt/
source custody, retention safety, fresh bootstrap and activation remain open.
The generic [operator workflow](docs/guides/control-archive-v1.md) preserves
historical migration sets and keeps key material outside the archive store.
PostgreSQL backups/PITR and the pending dedicated S3-access confirmation remain
separate required gates; the held Budget and other stopped candidates are unchanged.

The [portable PostgreSQL candidate checkpoint](docs/evidence/m2-postgres-portability-held-2026-09-29.md)
records a separate generic export/import draft using maintained PostgreSQL 18
tools and exactly three real local TLS cases. Privacy/protection checks pass, but
the data roundtrip remains red after two attempts and the workflow is held. A
single-request fixture rollback removes setup objects; the narrow fixture repair
is identified but unapplied. No full gate, source merge, deployment or logical
portability completion is claimed; physical backup/WAL/PITR remain independent
required work.

The [budget history candidate checkpoint](docs/evidence/m3-budget-history-held-2026-09-29.md)
retains the original strict-typecheck gate stop and the user's subsequent narrow
resumption. The two unchanged named Worker cases and focused type checks pass.
Only the previously unrun Vitest/Node stages run: 29 Worker cases pass, then Node
stops with 35 of 36 passing because the existing recovery case fixes its migration
count at 14 while the draft index makes 15. The proposed independent file-count
expectation remains unapplied. No broad gate repeats, source merge, D1 migration
or Worker deployment follows; six draft files remain sealed privately. The native
route remains its original red proof. Runtime budget enforcement, customer
inventory changes and milestone completion are not claimed.

Use test-driven development for concrete behavior changes: identify the intended behavior or observed defect, demonstrate a meaningful failing test, implement the smallest complete correction, and check the affected behavior again. Keep the task scope fixed; tests are evidence for that change, not a reason to build additional features or infrastructure.

### Test budget and red-first proof

- Add or materially expand **at most three top-level tests per fix**, each failing first for the intended missing behavior or defect before the implementation change. Preserve the red/green result in the work report; a harness/setup failure is not the required red proof.
- The limit applies across files, packages, agents, and commits for the same fix. Count independently reported test cases; nesting, a new describe block, parameter rows, loops, renaming, or splitting a fix must not hide extra cases or reset the limit.
- Never generate test matrices, permutations, or speculative edge-case suites. Prefer the observed failing example and the smallest necessary regression; reuse existing coverage without weakening valid tests.
- Define the current task's test-count baseline before iteration. Do not grow the task into unrelated cleanup or split it into artificial fixes to evade its limits.

### Iteration and one final gate

During iteration, run only explicitly named test files in packages changed by the task, for example `pnpm vitest run <path>`. Do not use unfiltered package-wide or repository-wide test discovery. Rebuild affected artifacts when needed to avoid testing stale outputs; this does not authorize a broader test suite.

After freezing the final candidate, run the full gate **exactly once**: format, lint, typecheck, Vitest, and `test:node`. Use the repository's canonical commands (`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm vitest run`, `pnpm test:node`) once the runtime/tooling scaffold exists. Do not run the full gate during iteration, repeat it for reassurance, or silently change the candidate and restart a broad verification loop. If the final gate fails, stop and report the result and required next step.

Documentation-only work checks the edited documents, links, and diff; do not invent runtime tests or package tooling just to test prose. The executable workspace gate is for frozen runtime candidates, not a reason to rerun all tests for document edits.

For the Go node-runtime observer, the frozen candidate also runs `pnpm check:node-runtime` once: formatting, vet and its bounded concrete cases, including command behavior when changed. This does not add matrix cases or repeat the workspace gate. During iteration, explicitly select the named observer cases. The separate execution guard uses `pnpm check:execution-guard` once when that component changes; unchanged observer cases retain their earlier evidence.

### Mandatory stop conditions

Stop and report instead of widening the change when any of the following occurs:

- The same test remains red after **two fix attempts**. An attempt is an implementation correction followed by checking the same failure; renaming the test/task or creating a commit does not reset the count.
- Any test/check run takes **more than 10 minutes**. Monitor elapsed wall time and stop the running invocation at that bound; do not keep it running in the background to evade the limit.
- The test count grows by **more than a few dozen** relative to the current task's baseline. This is a guard against accumulated/generated cases, not a cap on the pre-existing tests executed by the expressly allowed final full gate; the per-fix three-test cap still applies.

The stop report states the failing behavior or run, attempts, elapsed time, test-count change, evidence, and smallest proposed next step. Do not weaken assertions, mark a failed run green, or broaden implementation scope to finish the gate.
