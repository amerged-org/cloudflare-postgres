# cloudflare-postgres — Open-source implementation plan

Status: revised approved direction, 2026-09-27. M0 (repository foundation) is complete. All runtime, infrastructure, integration, and operational acceptance work remains pending.

This file is the canonical scope and roadmap. README.md summarizes it; AGENTS.md is the 25-line contributor brief; THIRD_PARTY.md records component provenance and adoption status. A documented target is not evidence of implemented behavior.

## 1. Product scope and decisions

Build an independent, Apache-2.0-licensed open-source PostgreSQL management platform. Adopters deploy the management layer and authoritative control state into their own Cloudflare account and operate real PostgreSQL on Contabo infrastructure. All adopters use the same public contracts and execution paths. ohmyho.st is an early adopter; its adapter and migration work belong in its own repository.

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

Cloudflare placement of control state is a user decision. The D1/Durable Objects/R2/Secrets mapping below is the selected design assumption to validate before management implementation. Talos on Contabo, the exact local-volume integration, gateway implementation, isolation runtime, and production failure-domain guarantees still require their stated evidence. No servers have been ordered and no production data has been migrated.

## 2. Generic product boundary and early acceptance path

Build reusable PostgreSQL management software, not a custom backend for a named adopter. Domain models, defaults, quotas, budget units, error contracts, routes, and execution paths must remain customer-independent. Do not encode consumer-specific plan names, driver versions, timeout constants, billing conventions, identifiers, or polling schedules in the platform.

Run an early native PostgreSQL pilot ahead of the full gateway, serverless lifecycle, and workbench. Start with one disposable, always-on CNPG environment over verified TLS, with ordinary scoped roles, transactions, backup, and independent restore. Use generic public interfaces and a small representative workload; an early adopter may exercise the same path. The pilot is an operational baseline, not an exemption from v1 sleep/wake or autoscaling.

### Platform versus consumer responsibilities

| Capability | Generic platform responsibility | Consumer responsibility |
|---|---|---|
| Lifecycle | Versioned create/observe/delete operations, stable identities, safe handling of uncertain outcomes. | Map local project/environment identities and reconcile the platform's operations. |
| PostgreSQL access | Document native/direct/pooled endpoints, TLS, role boundaries, transaction semantics, and supported connection behavior. | Configure its drivers, migration tools, application pools, cancellation, and reconnect handling. |
| Resource policy | Publish supported size ranges, idle policy, scaling limits, and observed state. | Map its service plans into supported configuration without asking for named-plan exceptions. |
| Timeouts and recovery | Declare measured startup, interruption, and recovery behavior and supported configuration. | Reconcile its client deadlines and recovery requirements with that contract. |
| Usage | Offer documented units, time windows, granularity, freshness, revisions, and completeness. | Map those facts into its own usage model and choose an appropriate polling cadence. |
| Budgets | Authorize and enforce scoped limits/allowances with explicit units and stop/resume behavior. | Allocate its database allowance from any wider wallet and provide authorized conversion policy where required. |

Consumer-specific compatibility snapshots and TODOs belong in the consumer's PLAN.md. In particular, ohmyho.st owns its PGCF adapter, Neon-specific registration removal, timeout/profile mapping, usage ingestion, wallet allocation, and migration tasks. Do not make those private implementation details universal platform requirements or an upstream release dependency. A missing shared capability may be proposed here only with a general use case, rather than an adopter-specific branch.

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

Deduplicate repeated delivery, preserve original evidence, and expose corrections. Verify the documented aggregation, query-window, and correction contract; individual consumers choose and test their own polling cadence. No price, invoice, or monthly charge is fabricated from incomplete facts.

### Budget management and enforcement

Provide ordinary authenticated APIs to set/read/update a scoped project or database budget, inspect usage and remaining allowance, receive threshold/exhaustion events, and resume after an authorized allowance change. Keep hard enforcement and advisory reporting distinguishable.

Budget-unit semantics must be explicit. Resource-unit limits can be evaluated directly; integrator-defined usage-credit limits require an operator-authorized, versioned conversion/allocation policy. This is enforcement configuration, not a platform-owned retail price catalog. The integrator owns its customer prices and aggregate wallet and assigns only the intended database allowance. Untrusted application callers cannot grant themselves budget authority.

Track granted, consumed, and reserved allowance separately. Reserve or lease bounded execution authority before budget-consuming work; reconcile actual usage and release unused reservations with stable identities. Define the maximum enforcement delay/overshoot and the behavior of running sessions, new connections, wake, and resize. A delayed usage API alone cannot implement a hard cap.

For an enforcing stop, prevent new admissions and resource increases and perform the documented drain/suspend policy. Preserve data and retained backups; stopping compute does not remove persistent storage or guarantee zero infrastructure cost. Resumption requires an authorized policy/allowance update. Technical resource quotas remain distinct from monetary or credit-denominated budgets.

Test concurrent reservations, duplicated grants/events, period rollover, revisions, revocation, exhaustion during execution, stop/resume, offline regional allowances, and replay after recovery. No payment processor, subscription engine, checkout, or invoice service is needed for these v1 capabilities.

## 8. Delivery sequence and evidence

| Milestone | Deliverable | Required evidence |
|---|---|---|
| **M0 — Repository foundation: complete** | Apache-2.0, project guidance, canonical roadmap, component inventory. | Initial public commit `b7d790d`; documentation changes remain distinct from runtime progress. |
| **M1 — Infrastructure and control-state feasibility** | Talos/Contabo/volumes/CNPG/R2 proofs; validate the Cloudflare state, secret, and recovery design. | Unattended boot, persistent/enforced storage, database/backup recovery, benchmark baseline, and control-state design ready before M3. |
| **M2 — Early generic PostgreSQL pilot** | One disposable always-on environment through the ordinary platform interface, without a custom gateway or workbench dependency. | Representative application queries/transactions/migrations, scoped roles, lifecycle, usage, backup, and independent restore; adopter-specific integration remains in its own repository. |
| **M3 — Cloudflare management, usage, and budget APIs** | D1-backed authority, scoped API/SDK, operation tracking, usage ingestion/query, budget policy/reservations, and regional protocol. | Authorization, idempotency, concurrent updates/reservations, correction/replay, stop/resume commands, and recovery reconciliation. |
| **M4 — Secure fleet operations** | Provisioning, staged updates, replacement, isolation decision, and observability. | Node maintenance/failure, disk-full containment, cross-tenant tests, credential/key recovery, and restore onto fresh infrastructure. |
| **M5 — Gateway and connection ownership** | Select a maintainable native gateway, validate endpoint failover, and set pool/queue limits. | Maintainer/update ownership, authentication/invalidation, cancellation, direct/pooled semantics, gateway/node/network failures, and client reconnect behavior. |
| **M6 — Serverless lifecycle** | Automatic sleep/wake, manual resize, bounded automatic compute scaling, and end-to-end budget enforcement. | Cold-request deadlines, concurrent wake, long transactions, cooldowns, capacity exhaustion, allowance exhaustion, and management-outage behavior. |
| **M7 — Developer experience and integration qualification** | Complete API/CLI docs and usage/budget examples; evaluate optional HTTP/WS, Data API, and workbench integrations. | Repeatable installation and operator workflows; any shipped optional interface has its own compatibility/security evidence. No hosted billing dependency. |
| **M8 — Open-source production readiness** | Rehearsed operational release usable by independent adopters. | Sustained workloads, recovery and upgrade evidence, measured service limits, generic migration guidance, and repeatable installation documentation; consumer rollouts are separately owned. |

### Operational acceptance evidence

Publish the workload, versions, topology, sample counts, and pass/fail thresholds before each implementation acceptance run. These are operational measurements; a pricing or break-even study is not required. The table lists milestone evidence areas, not instructions to generate test matrices or permutations: select only the concrete cases needed for the current change, subject to section 10.

| Test | Measure | Acceptance rule |
|---|---|---|
| Talos bootstrap | Provision-to-ready duration, failed/repeated boots, operator interventions. | Reproducible authenticated bootstrap without manual console fixes; failed attempts recover without duplicate resources. |
| Disk and competing tenants | Durable write/read latency, throughput, p95/p99 under realistic concurrent workloads. | Meet the declared workload target without cross-tenant disk exhaustion or loss of durability. |
| Database density | Idle/active memory, reserved CPU, connection counts, and recovery headroom. | Demonstrate a safe capacity envelope, including a node failure/maintenance case; do not derive density from nominal RAM alone. |
| Native and cold access | Connection-ready and end-to-end query p50/p95/p99, maxima, and timeout/error counts. | Meet the declared platform latency target and configured deadline behavior; consumers validate their own client timeout budgets separately. |
| Resize and maintenance | Drain duration, reconnect window, failed/uncertain transactions, replica catch-up. | Bound interruption and prove correct error handling without blind write replay. |
| Recovery and retention | Recoverable timestamps, recovered content, restore time, archive continuity, deleted objects. | Prove the declared history window, safe deletion, and recovery on a fresh cluster with distinct archive identity. |
| Usage and budgets | Coverage, freshness, duplicate/correction handling, reservation accuracy, enforcement delay. | Reproducible reporting, no double consumption, bounded stop behavior, and explicit gaps rather than invented usage. |
| Gateway/control outage | New/existing connection behavior, policy validity, usage-buffer recovery, allowance exhaustion. | Demonstrate the documented degraded behavior, failover and reconciliation without granting unlimited authority or deleting data. |

## 9. Decisions to deepen before implementation and release

- Before M1/M3: finalize Cloudflare schema and retention, backup/key custody, management auth, and the state/operation/allowance reconciliation model.
- Before M2: define the generic native-PostgreSQL pilot contract and disposable migration/restore procedure; track consumer adapter work in the consumer repository.
- Before M4/M5: approve the tenant isolation guarantee, maintenance responsibility, gateway choice and native endpoint failover design.
- Before M6: freeze sleep eligibility, cold-start/reconnect deadlines, scaling thresholds, budget units/periods, enforcement bounds, and disconnected-region policy.
- Before M8: verify replica topology, synchronous-commit behavior, actual failure domains, recovery objectives, installed-version support, and safe capacity reserves.

Implementation assumptions must be resolved with evidence, not advertised as existing guarantees. Hosted SaaS/reselling and branching require later plans; neither is a gate for this open-source delivery.

## 10. Bounded TDD and verification discipline

Use test-driven development for concrete behavior changes: identify the intended behavior or observed defect, demonstrate a meaningful failing test, implement the smallest complete correction, and check the affected behavior again. Keep the task scope fixed; tests are evidence for that change, not a reason to build additional features or infrastructure.

### Test budget and red-first proof

- Add or materially expand **at most three top-level tests per fix**, each failing first for the intended missing behavior or defect before the implementation change. Preserve the red/green result in the work report; a harness/setup failure is not the required red proof.
- The limit applies across files, packages, agents, and commits for the same fix. Count independently reported test cases; nesting, a new describe block, parameter rows, loops, renaming, or splitting a fix must not hide extra cases or reset the limit.
- Never generate test matrices, permutations, or speculative edge-case suites. Prefer the observed failing example and the smallest necessary regression; reuse existing coverage without weakening valid tests.
- Define the current task's test-count baseline before iteration. Do not grow the task into unrelated cleanup or split it into artificial fixes to evade its limits.

### Iteration and one final gate

During iteration, run only explicitly named test files in packages changed by the task, for example `pnpm vitest run <path>`. Do not use unfiltered package-wide or repository-wide test discovery. Rebuild affected artifacts when needed to avoid testing stale outputs; this does not authorize a broader test suite.

After freezing the final candidate, run the full gate **exactly once**: format, lint, typecheck, Vitest, and `test:node`. Use the repository's canonical commands (`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm vitest run`, `pnpm test:node`) once the runtime/tooling scaffold exists. Do not run the full gate during iteration, repeat it for reassurance, or silently change the candidate and restart a broad verification loop. If the final gate fails, stop and report the result and required next step.

Documentation-only work checks the edited documents, links, and diff; do not invent runtime tests or package tooling just to test prose. This documentation-only repository has no executable full gate yet; record that fact rather than claiming a test pass.

### Mandatory stop conditions

Stop and report instead of widening the change when any of the following occurs:

- The same test remains red after **two fix attempts**. An attempt is an implementation correction followed by checking the same failure; renaming the test/task or creating a commit does not reset the count.
- Any test/check run takes **more than 10 minutes**. Monitor elapsed wall time and stop the running invocation at that bound; do not keep it running in the background to evade the limit.
- The test count grows by **more than a few dozen** relative to the current task's baseline. This is a guard against accumulated/generated cases, not a cap on the pre-existing tests executed by the expressly allowed final full gate; the per-fix three-test cap still applies.

The stop report states the failing behavior or run, attempts, elapsed time, test-count change, evidence, and smallest proposed next step. Do not weaken assertions, mark a failed run green, or broaden implementation scope to finish the gate.
