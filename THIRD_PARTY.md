# Third-party components

Reviewed: 2026-10-02 (reset). The repository's [Apache License 2.0](LICENSE) covers original
project work only. Upstream components keep their own licenses, notices and source obligations.
No upstream source is vendored. Direct application dependencies are listed below at the version
resolved in `pnpm-lock.yaml`. Their transitive dependencies are recorded only in the lockfile.
Recheck the exact release and its dependencies before upgrading or redistributing.

## Selected stack

Pinned platform versions are in [infra/platform/versions.lock.json](infra/platform/versions.lock.json).

| Component | License | Role |
| --- | --- | --- |
| [PostgreSQL](https://www.postgresql.org/) | [PostgreSQL License](https://www.postgresql.org/about/licence/) | The database engine, unmodified upstream images (18.x). |
| [CloudNativePG](https://github.com/cloudnative-pg/cloudnative-pg) | [Apache-2.0](https://github.com/cloudnative-pg/cloudnative-pg/blob/main/LICENSE) | Operator: one Cluster per database, roles, hibernation, recovery. |
| [Barman Cloud CNPG-I plugin](https://github.com/cloudnative-pg/plugin-barman-cloud) | [Apache-2.0](https://github.com/cloudnative-pg/plugin-barman-cloud/blob/main/LICENSE) | Base backups, WAL archiving and PITR to R2. |
| [Barman / barman-cloud](https://github.com/EnterpriseDB/barman) | [GPL-3.0](https://github.com/EnterpriseDB/barman/blob/REL_3_X_master/LICENSE) (see note) | Backup tooling inside the plugin sidecar; used unmodified, not relicensed. |
| [Talos Linux](https://github.com/siderolabs/talos) | [MPL-2.0](https://github.com/siderolabs/talos/blob/main/LICENSE) | Node operating system and Kubernetes lifecycle. |
| [Kubernetes](https://github.com/kubernetes/kubernetes) | [Apache-2.0](https://github.com/kubernetes/kubernetes/blob/master/LICENSE) | Scheduling and resource limits in each region. |
| [Flux](https://github.com/fluxcd/flux2) | [Apache-2.0](https://github.com/fluxcd/flux2/blob/main/LICENSE) | Reconciles pinned platform releases. |
| [Cilium](https://github.com/cilium/cilium) | [Apache-2.0](https://github.com/cilium/cilium/blob/main/LICENSE); BPF parts [dual GPL-2.0/BSD-2-Clause](https://github.com/cilium/cilium#license) | Pod networking and NetworkPolicy. |
| [OpenEBS LocalPV LVM](https://github.com/openebs/lvm-localpv) | [Apache-2.0](https://github.com/openebs/lvm-localpv/blob/develop/LICENSE) | Hard-limited local volumes on the `pgcf` LVM volume group. |
| [cert-manager](https://github.com/cert-manager/cert-manager) | [Apache-2.0](https://github.com/cert-manager/cert-manager/blob/master/LICENSE) | Certificates required by the Barman plugin. |
| [cloudflared](https://github.com/cloudflare/cloudflared) | [Apache-2.0](https://github.com/cloudflare/cloudflared/blob/master/LICENSE) | Outbound tunnel from each region to Cloudflare. |
| [Kubernetes JavaScript client](https://github.com/kubernetes-client/javascript) | [Apache-2.0](https://github.com/kubernetes-client/javascript/blob/master/LICENSE) | Kubernetes API access from the regional agent. |
| [Neon serverless driver](https://github.com/neondatabase/serverless) | [MIT](https://github.com/neondatabase/serverless/blob/main/LICENSE) | Client library compatible with the edge endpoint (WebSocket `Pool`/`Client`). Used by clients and tests, not bundled into the platform. |

**Barman license note:** the upstream package metadata declares `GPL-3.0-only`, while the README
and source headers say GPL version 3 or later. Record the declaration at the pinned release.

**Barman plugin issue:** the R2 restore failure reported in
[plugin-barman-cloud issue #411](https://github.com/cloudnative-pg/plugin-barman-cloud/issues/411#issuecomment-3572945793)
was a naming conflict between archives. Every restore target needs its own archive path and server
name.

## Application dependencies

Direct npm dependencies at the versions resolved in [pnpm-lock.yaml](pnpm-lock.yaml). Licenses are
read from the installed package manifests.

| Package | Version | License | Role |
| --- | --- | --- | --- |
| [hono](https://github.com/honojs/hono) | 4.13.12 | MIT | HTTP framework of the API Worker. |
| [zod](https://github.com/colinhacks/zod) | 4.6.5 | MIT | Shared schemas in `packages/contracts` and request validation. |
| [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi) | 1.6.3 | MIT | OpenAPI document generated from the route schemas. |
| [ws](https://github.com/websockets/ws) | 8.22.0 | MIT | WebSocket server of the regional gateway and link client of the agent. |
| [esbuild](https://github.com/evanw/esbuild) | 0.25.12 | MIT | Bundles the regional entry points into the container image (build only). |
| [@neondatabase/serverless](https://github.com/neondatabase/serverless) | 1.2.0 | MIT | Client driver used by the live acceptance run (also listed above). |
| [pg](https://github.com/brianc/node-postgres) | 8.23.1 | MIT | Direct PostgreSQL client for `scripts/e2e` only. |
| [vitest](https://github.com/vitest-dev/vitest) | 4.1.11 | MIT | Test runner (development only). |
| [@cloudflare/vitest-plugin](https://github.com/cloudflare/workers-sdk/tree/main/packages/vitest-plugin) | 1.3.5 | MIT | Runs Worker tests in the Workers runtime (development only). |

### Reference only

| Component | License | Use |
| --- | --- | --- |
| [neondatabase/wsproxy](https://github.com/neondatabase/wsproxy) | Apache-2.0 | Read-only reference for the WebSocket-to-PostgreSQL bridge. Not vendored, not pinned, not a dependency. |

## Not used

| Component | Reason |
| --- | --- |
| [Neon storage engine, proxy](https://github.com/neondatabase/neon), [NeonVM](https://github.com/neondatabase/autoscaling) (Apache-2.0) | The public repository is effectively dormant. Its storage is a different architecture. NeonVM needs nested virtualization, which Contabo Cloud VPS lack. |
| [Xata OSS](https://github.com/xataio/xata) (Apache-2.0) | Active and CNPG-based, but its SNI gateway is not needed: access runs through the Cloudflare edge and Tunnel. |
| [PgBouncer](https://github.com/pgbouncer/pgbouncer) (ISC), [Supavisor](https://github.com/supabase/supavisor) (Apache-2.0) | No server-side pooler in v1; reconsider with measured connection pressure. |
| [Omni](https://github.com/siderolabs/omni) (BUSL-1.1) | Not open source; not needed. |

## Rules

1. Prefer maintained upstream images and APIs. Keep adapters narrow and do not fork.
2. When adding a component, record its exact release or digest, source, license and notices here.
3. Cloudflare and Contabo are service providers, not bundled software. Their terms apply
   separately.
