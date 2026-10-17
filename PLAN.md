# cloudflare-postgres — Plan

The canonical scope, delivery architecture, Done/Open status and execution order are in the
[ULTRA plan](docs/architecture/cloudflare-convergence-and-serverless-plan.md).

Current focus (owner decision 2026-10-17): PGCF runs without Kubernetes. Each VPS is a
self-contained Debian node with one sandboxed PostgreSQL service per database and one Rust node
agent; Cloudflare is the only control plane; thin-slice overbooking carries density. The previous
Kubernetes-era plan and its work are on branch `archive/kubernetes-runtime`.
