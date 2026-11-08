# cloudflare-postgres — Plan

The canonical scope, delivery architecture, Done/Open status and execution order are in the
[ULTRA plan](docs/architecture/cloudflare-convergence-and-serverless-plan.md).

Current node stack: **Debian 13 (trixie), systemd, PostgreSQL 18.6, thin LVM and native Rust**.
The image ships `pgcf-agent`, `pgcf-native-gateway`, `pgcf-archive` and `pgcf-wal-fetch`.
Each database has an isolated PostgreSQL instance and retained volume bound to a sandboxed
systemd slot. The owner retired Talos, Kubernetes and CloudNativePG on 2026-10-17; the systemd
slot pool was reinstated on October 20.

Cloudflare is the only control plane. Its management API, Durable Objects, Workflows and
deployed Edge remain TypeScript. Rust/Wasm Edge is built/tested and not deployed. See the
[README stack table](README.md#stack) and [image builder notes](infra/node-image/README.md).

Use the latest dated ULTRA entries for current per-node releases, operating health and accepted
limits. The October 26 cold-latency exception is not a measured subsecond-p95 pass. An older
checkout or proposal must not override later dated architecture and deployment evidence.
