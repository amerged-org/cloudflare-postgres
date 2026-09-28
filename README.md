# cloudflare-postgres

An independent, open-source PostgreSQL platform with a Cloudflare management layer and self-operated PostgreSQL infrastructure on Contabo.

**Open source first.** The initial product gives adopters management APIs, database operations, usage reporting, and API-controlled budgets. Hosted SaaS and reselling come later. [ohmyho.st](https://ohmyho.st) is our first adopter and integration customer.

## Development status

**Early development.** The deployed [control API](apps/control-api/README.md) provides authenticated organization bootstrap, paginated recovery listing, region registration with scoped tokens, and global logical projects with completed D1 audit operations. The [environment execution slice](docs/evidence/m3-environment-execution-2026-09-28.md) implements immutable regional catalogs, explicit operator admission, database-environment intents, leased regional execution, and a [CloudNativePG controller](apps/regional-controller/README.md). Live checks verified closed admission and regional claim authorization. Local tests, the controller package build, and container build passed. Its reviewed image is published to GHCR, but anonymous pulling, controller deployment, and API-to-CNPG qualification remain pending. No catalog or API-managed environment has been created; lab admission is closed. A controller-ready result supplies no customer endpoint or credentials.

The [M3 usage and budget authority checkpoint](docs/evidence/m3-usage-budget-authority-2026-09-28.md) adds exact usage revisions, fixed-snapshot exports, separate meter/grantor credentials, scoped budget policies, and fenced allowance accounting. Migrations `0006`–`0007` and the Worker are deployed in Dev. Live checks verified empty exports with unknown coverage, credential boundaries, exact decimal grants, conditional updates, and requested pause/resume. Local ledger/settlement tests passed; actual usage ingestion, receipt encryption/replay, settlement, collection, and runtime stop behavior remain unverified live. Budget resources report `runtimeEnforced: false` and `enforcementStatus: pending_runtime`. This does not complete M3 or the v1 enforcement requirement.

The [M1 lab checkpoint](docs/evidence/m1-2026-09-28.md) verifies Talos, Kubernetes, Cilium, bounded local volumes, and one manually created PostgreSQL instance on a disposable Contabo node. SQL transactions and a node-restart readback passed. Public [Talos bootstrap assets](infra/talos/README.md) and a [pinned Flux platform baseline](infra/platform/README.md) now package the installation configuration. The [M4 adoption checkpoint](docs/evidence/m4-platform-adoption-2026-09-28.md) verifies live Flux ownership of the existing Cilium/OpenEBS releases and restoration of a nonsemantic ConfigMap drift while SQL markers remained readable; cert-manager, CNPG, and Barman releases remain outside Flux adoption. Automated provider bootstrap, upgrades/recovery, gateway, and the production service remain unqualified. The manual lab database was not provisioned by the management API.

The first implementation steps are infrastructure/recovery proofs and an early generic pilot using one always-on database over native PostgreSQL. Adopter-specific adapters and migration TODOs belong in their own repositories. Gateway selection follows technical and maintenance evaluation. Sleep/wake and bounded automatic compute scaling remain v1 requirements after that baseline.

## Self-hosting model

Adopters need their own Cloudflare account for the management deployment, authoritative control state, secrets, and R2 archives, plus Contabo infrastructure for PostgreSQL. This is not a Cloudflare-independent deployment. Initial [infrastructure](infra/README.md) and controller setup recipes are published; a complete, independently verified installation procedure remains a release gate.

The selected control-state mapping uses Workers for APIs, D1 for canonical management/usage/budget data, Durable Objects for coordination, and R2 for large artifacts. The current development implementation supplies conditional execution leases and D1-backed usage/budget authority. Durable Object coordination, regional usage buffers, runtime collection/enforcement, and control-state recovery remain to be implemented and qualified.

## Planned architecture

```mermaid
flowchart TB
    Adopters["Independent adopters"] --> API["Cloudflare Workers: management, usage and budget APIs"]
    API --> State["D1: authoritative control state"]
    API --> Coordination["Durable Objects: coordination"]
    Coordination --> Controller["Contabo regional controller"]
    Controller --> Fleet["Talos and Kubernetes"]
    Controller --> CNPG["CloudNativePG"]
    CNPG --> Databases["Isolated PostgreSQL environments and local volumes"]
    Adopters --> Access["Native PostgreSQL access; gateway selection pending"]
    Access --> Databases
    Databases --> Backups["Barman backups and WAL to R2"]
    Flux["Flux platform releases"] --> Fleet
```

CloudNativePG manages PostgreSQL lifecycle and replication. Talos provides the declarative server foundation; Flux manages platform components. The product supplies project management, usage reporting, budget enforcement, policy, and orchestration between those components.

Native PostgreSQL uses regional TCP endpoints. Ordinary Workers HTTP ingress is not a PostgreSQL listener. Gateway failover, pooling ownership, and regional operation during Cloudflare outages require explicit acceptance evidence.

## Initial scope

- Organizations, projects, databases, roles, credentials, and regional placement through versioned APIs.
- Native PostgreSQL, connection pooling, and interactive transactions.
- Attributable usage reporting, machine-readable exports, and API-controlled budgets with enforcement.
- Automatic sleep/wake, manual resizing, and bounded automatic compute scaling.
- Physical backups, WAL archiving, point-in-time recovery, retention, and safe deletion.
- Repeatable maintenance, tenant isolation, monitoring, and recovery procedures.

Budget APIs remain in v1; payment processing, subscriptions, invoicing, and a retail pricing catalog are deferred with the hosted offering. Each integrator retains its own aggregate wallet and customer billing and assigns the database allowance through the same generic API.

Short reconnects during resizing are accepted. Branching is deferred. Supabase Auth, Storage, Realtime, and Functions remain outside scope. HTTP/WebSocket access, PostgREST, postgres-meta, and a Studio-derived workbench are optional follow-on integrations after the native pilot.

## Development discipline

Use the [bounded TDD policy](PLAN.md#10-bounded-tdd-and-verification-discipline): at most three new or expanded top-level tests per fix, each red first; targeted test files during iteration; one final full gate; and mandatory stop/report limits. Do not generate test matrices or speculative suites. Consumer-specific defaults, adapters, and compatibility TODOs belong in consumer repositories.

## Project documents

- [PLAN.md](PLAN.md): canonical scope, assumptions, architecture, delivery sequence, and acceptance gates.
- [AGENTS.md](AGENTS.md): the 25-line contributor and coding-agent brief.
- [THIRD_PARTY.md](THIRD_PARTY.md): upstream candidates, licenses, integration decisions, and provenance requirements.

## License and independence

Original project code and documentation are licensed under [Apache License 2.0](LICENSE). Third-party components retain their own licenses and notices; evaluated upstream projects have not been vendored into this repository.

This is an independent project, not an official product of or affiliated with Cloudflare, Contabo, Neon, Supabase, or the CloudNativePG project. Product and project names identify the technologies being evaluated and remain the property of their respective owners.
