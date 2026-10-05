# cloudflare-postgres
Open-source, Neon-style serverless PostgreSQL: Cloudflare control plane, real PostgreSQL on Contabo VPS.
Read PLAN.md first; it is the canonical scope, architecture, phases and status.
Cloudflare is the control plane: Workers, D1, Durable Objects, Workflows, R2, Secrets, Containers.
Only PostgreSQL data lives on VPS; regional components execute desired state and report observations.
All database traffic enters through Cloudflare (edge Worker, Tunnel); VPS expose no PostgreSQL port.
Run unmodified PostgreSQL with CloudNativePG on Talos Linux and Kubernetes with local LVM volumes.
Back up every database to R2 with Barman Cloud: base backups, WAL archiving, point-in-time recovery.
Databases sleep when idle and wake on connect; never lose committed data or replay uncertain writes.
Cloudflare places databases, tracks capacity and adds Contabo VPS through their API within spend caps.
Report usage and infrastructure cost as metrics; prices, credits and wallets belong to integrators.
No budget enforcement, compute autoscaling or branching in v1; integrators call suspend and resume.
Keep APIs and defaults generic; adopter adapters live in adopter repositories (e.g. ohmyho.st).
Build the smallest thing that passes the current phase's live acceptance in Dev.
Add machinery only for an observed problem, never for a hypothetical one.
Delete unused code, files and branches; no parked, held or frozen work. Git history is the archive.
No mocks, stubs or hardcoded data in product code; acceptance only from real Dev systems.
Test the logic you write; write the failing test first for bug fixes; no test matrices; one CI workflow.
Record phase results and measured numbers in PLAN.md Status; no per-change evidence documents.
Repository documentation is written in English; discussion with the owner may be in German.
Docs live in PLAN.md, README.md, THIRD_PARTY.md, infra READMEs, docs/operations runbooks and docs/architecture proposals.
Approved runtime target: native Rust for the regional gateway, controller, bootstrap relay and node reclaimer; Rust/Wasm for the Edge Worker.
TypeScript remains for the management API, Durable Objects and Workflows; CLI and provisioning tools initially remain on Node.js.
Shared zod contracts remain authoritative initially; Rust consumers use generated schemas/constants and behavioral conformance tests.
Read docs/architecture/rust-runtime-and-cold-starts.md for the approved migration sequence and cold-start design; the deployed runtime remains TypeScript until replacement passes Dev acceptance.
Rust is an owner-approved architecture choice; measurements validate its implementation, rather than being a prerequisite for choosing it.
First-party code is Apache-2.0; upstream components keep their own licenses.
Pin upstream versions and digests; record licenses and notices in THIRD_PARTY.md.
The repository is public: never print or commit secrets, .env* files, kubeconfigs or Talos configs.
New paid resources and production writes need the owner's explicit, costed go.
