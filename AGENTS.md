# cloudflare-postgres
Open-source, Neon-style serverless PostgreSQL: Cloudflare control plane, real PostgreSQL on Contabo VPS.
Read PLAN.md first; it links to the canonical ULTRA scope, delivery architecture and Done/Open status.
Cloudflare is the control plane: Workers, D1, Durable Objects, Workflows, R2, Secrets, Tunnel and Access.
Only PostgreSQL data lives on VPS; nodes execute Cloudflare's desired state and report observations; a node decides only wake admission, early sleep and recovery starts, from local facts under rules Cloudflare sets, and reports each decision.
All database traffic enters through Cloudflare (edge Worker, Tunnel); VPS expose no PostgreSQL port.
Run unmodified PostgreSQL 18.6 under systemd on Debian 13 (trixie): one isolated instance and thin LVM volume per database in a sandboxed slot, with a Rust node agent and gateway. Talos, Kubernetes and CloudNativePG were retired on 2026-10-17; the systemd slot pool was reinstated on October 20.
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
Deployed first-party node binaries are native Rust: pgcf-agent, pgcf-native-gateway, pgcf-archive and pgcf-wal-fetch. PostgreSQL, Barman Cloud, cloudflared and OS packages retain their upstream implementations; the node image requires no Node.js runtime.
TypeScript remains deployed for the management API, Durable Objects, Workflows and Edge Worker; the CLI and operator scripts remain on Node.js. Rust/Wasm Edge is built/tested but not deployed and remains the approved target under open decision D12.
Shared zod contracts remain authoritative initially; Rust consumers use generated schemas/constants and behavioral conformance tests.
Read docs/architecture/cloudflare-convergence-and-serverless-plan.md for the runtime design and delivery stages; the infra/node-image and apps/node-agent READMEs hold the builder notes (until Stage 3 writes them, the plan's Appendix C).
Rust is an owner-approved architecture choice; measurements validate its implementation, rather than being a prerequisite for choosing it.
First-party code is Apache-2.0; upstream components keep their own licenses.
Pin upstream versions and digests; record licenses and notices in THIRD_PARTY.md.
The repository is public: never print or commit secrets, .env* files, node keys, Tunnel and enrollment tokens, R2 keys, kubeconfigs or Talos configs.
Whenever a token or key is created, received or deployed, also append it to the repository's untracked `.env.local`, alongside Cloudflare or whichever secret store holds the deployed value; never print or commit the file.
Treat `.env.local` as append-only: never delete the file or any entry, and never truncate or replace the file; update an existing entry only when the owner expressly requests that exact update, then ask again and proceed only after the owner explicitly confirms it.
Never content-search private files or bypass the private-file search exclusions. Load a known required credential file only in memory, and output only explicitly selected nonsecret metadata.
New paid resources and production writes need the owner's explicit, costed go.
