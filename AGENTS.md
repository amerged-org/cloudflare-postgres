# cloudflare-postgres
Build an independent PostgreSQL platform with Apache-2.0-licensed first-party code.
Deliver the open-source solution first; hosted SaaS and reselling come later.
Treat ohmyho.st as the first ordinary API adopter, never as a privileged runtime case.
Run management APIs and authoritative control state in the adopter's Cloudflare account.
Run real PostgreSQL on Contabo infrastructure with persistent local storage.
Use CloudNativePG for database lifecycle, replication, failover, and resource changes.
Use Talos Linux and Kubernetes as the target declarative server foundation.
Use Flux for platform components and explicit lifecycle jobs for host upgrades.
Reuse maintained upstream components before writing equivalent infrastructure.
Evaluate gateway candidates for technical fit, security maintenance, and bounded adaptation.
Reuse Supabase database tooling where it fits the selected trust boundaries.
Preserve upstream licenses, attribution, notices, and separately licensed modifications.
Expose a versioned management API with generated clients and auditable operations.
Support organizations, projects, databases, roles, credentials, and regional placement.
Deliver attributable usage reporting and API-controlled budgets with enforcement in v1.
Deliver automatic sleep and wake without discarding committed customer data.
Deliver manual resizing and bounded automatic compute scaling in v1.
Allow documented reconnects during resizing; never replay uncertain writes blindly.
Deliver physical backups, WAL archiving, tested point-in-time recovery, and safe retention.
Defer database branching until after the initial open-source production release.
Document tenant isolation guarantees and enforce identity, network, compute, and storage limits.
Keep regional operation independent of continuous management access within authorized limits.
Automate staged updates, monitoring, recovery drills, and secure credential rotation.
Maintain PLAN.md as canonical scope and roadmap; distinguish proposals from verified behavior.
