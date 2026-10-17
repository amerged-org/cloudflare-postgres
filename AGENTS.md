# cloudflare-postgres
Open-source, Neon-style serverless PostgreSQL: Cloudflare control plane, real PostgreSQL on Contabo VPS.
Read PLAN.md first; it links to the canonical ULTRA scope, delivery architecture and Done/Open status.
Cloudflare is the control plane: Workers, D1, Durable Objects, Workflows, R2, Secrets, Tunnel and Access.
Only PostgreSQL data lives on VPS; nodes execute Cloudflare's desired state and report observations; a node decides only wake admission, early sleep and recovery starts, from local facts under rules Cloudflare sets, and reports each decision.
All database traffic enters through Cloudflare (edge Worker, Tunnel); VPS expose no PostgreSQL port.
Run unmodified PostgreSQL under systemd on a minimal Debian image: one sandboxed unit per database on its own thin LVM volume and one Rust node agent per VPS; no Kubernetes, no control server.
Back up every database to R2 with Barman Cloud: base backups, WAL archiving, point-in-time recovery.
Databases sleep when idle and wake on connect; never lose committed data or replay uncertain writes.
Cloudflare places databases, tracks capacity and adds Contabo VPS through their API under the operator-configured purchase policy.
Report usage and infrastructure cost as metrics; prices, credits and wallets belong to integrators.
No budget enforcement, compute autoscaling or branching in v1; integrators call suspend and resume.
Keep APIs and defaults generic; adopter adapters live in adopter repositories (e.g. ohmyho.st).
Build the smallest thing that passes the current phase's live acceptance on the EU1 stack.
Add machinery only for an observed problem, never for a hypothetical one.
Delete unused code, files and branches; no parked, held or frozen work. Git history is the archive.
No mocks, stubs or hardcoded data in product code; acceptance only from the real EU1 stack.
Test the logic you write; write the failing test first for bug fixes; no test matrices; one CI workflow.
At native CLI boundaries, materialize filename-flag payloads as real 0600 files in 0700 temporary directories and clean them up; never reopen stdin through /dev/stdin or /proc/self/fd. Never log payload contents.
Record completed steps and measured numbers in the ULTRA plan linked by PLAN.md; no per-change evidence documents.
Never give effort or duration estimates (weeks, days, hours or any other unit) for planned work, in plans, designs, reports or replies.
Repository documentation is written in English; discussion with the owner may be in German.
Docs live in PLAN.md, README.md, THIRD_PARTY.md, infra and app READMEs, docs/operations runbooks and docs/architecture proposals.
Approved runtime: native Rust for the node agent, the gateway and the archive clients; Rust/Wasm for the Edge Worker stays the approved target (open decision D12).
TypeScript remains for the management API, Durable Objects and Workflows; the CLI and operator scripts remain on Node.js.
Shared zod contracts remain authoritative initially; Rust consumers use generated schemas/constants and behavioral conformance tests.
Read docs/architecture/cloudflare-convergence-and-serverless-plan.md for the runtime design and delivery stages; the infra/node-image and apps/node-agent READMEs hold the builder notes (until Stage 3 writes them, the plan's Appendix C).
Rust is an owner-approved architecture choice; measurements validate its implementation, rather than being a prerequisite for choosing it.
First-party code is Apache-2.0; upstream components keep their own licenses.
Pin upstream versions and digests; record licenses and notices in THIRD_PARTY.md.
The repository is public: never print or commit secrets, .env* files, node keys, Tunnel and enrollment tokens, R2 keys, kubeconfigs or Talos configs.
Never content-search private files or bypass the private-file search exclusions. Load a known required credential file only in memory, and output only explicitly selected nonsecret metadata.
New paid resources and production writes need the owner's explicit, costed go.
