# cloudflare-postgres
Build an independent PostgreSQL platform with Apache-2.0-licensed first-party code.
Offer the same core software for self-hosting and a hosted SaaS service.
Treat ohmyho.st as the first ordinary API customer, never as a privileged runtime case.
Run the management API, customer console, and orchestration entry points on Cloudflare.
Run real PostgreSQL on Contabo infrastructure with persistent local storage.
Use CloudNativePG for database lifecycle, replication, failover, and resource changes.
Use Talos Linux and Kubernetes as the target declarative server foundation.
Use Flux for platform components and explicit lifecycle jobs for host upgrades.
Reuse maintained upstream components before writing equivalent infrastructure.
Evaluate Neon's proxy for native PostgreSQL, HTTP, WebSocket, and wake integration.
Reuse Supabase database tooling where it fits the selected trust boundaries.
Preserve upstream licenses, attribution, notices, and separately licensed modifications.
Expose a versioned management API with generated clients and auditable operations.
Support organizations, projects, databases, roles, credentials, and regional placement.
Deliver attributable usage, versioned pricing, budgets, and hosted billing in v1.
Deliver automatic sleep and wake without discarding committed customer data.
Deliver manual resizing and bounded automatic compute scaling in v1.
Allow documented reconnects during resizing; never replay uncertain writes blindly.
Deliver physical backups, WAL archiving, and tested point-in-time recovery.
Defer database branching until after the initial production release.
Isolate untrusted tenants across identities, networking, compute, and storage limits.
Keep regional database operation independent of continuous management-plane availability.
Automate staged updates, monitoring, recovery drills, and secure credential rotation.
Maintain PLAN.md as the roadmap and distinguish proposals from verified behavior.
