# Third-party components

Reviewed: 2026-10-02 (reset). The repository's [Apache License 2.0](LICENSE) covers original
project work only. Upstream components keep their own licenses, notices and source obligations.
No upstream source is vendored in the repository. The regional image bundles zod and ships its MIT
notice at `/app/licenses/zod/LICENSE`, copied from the lockfile-resolved installed package.
Direct application dependencies are listed below at the version
resolved in `pnpm-lock.yaml`. Their transitive dependencies are recorded only in the lockfile.
Recheck the exact release and its dependencies before upgrading or redistributing.

## Selected stack

Pinned platform versions are in [infra/platform/versions.lock.json](infra/platform/versions.lock.json).

| Component                                                                           | License                                                                                                                                           | Role                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [PostgreSQL](https://www.postgresql.org/)                                           | [PostgreSQL License](https://www.postgresql.org/about/licence/)                                                                                   | The database engine, unmodified upstream images (18.x).                                                                                 |
| [CloudNativePG](https://github.com/cloudnative-pg/cloudnative-pg)                   | [Apache-2.0](https://github.com/cloudnative-pg/cloudnative-pg/blob/main/LICENSE)                                                                  | Operator: one Cluster per database, roles, hibernation, recovery.                                                                       |
| [Barman Cloud CNPG-I plugin](https://github.com/cloudnative-pg/plugin-barman-cloud) | [Apache-2.0](https://github.com/cloudnative-pg/plugin-barman-cloud/blob/main/LICENSE)                                                             | Base backups, WAL archiving and PITR to R2.                                                                                             |
| [Barman / barman-cloud](https://github.com/EnterpriseDB/barman)                     | [GPL-3.0](https://github.com/EnterpriseDB/barman/blob/REL_3_X_master/LICENSE) (see note)                                                          | Backup tooling inside the plugin sidecar; used unmodified, not relicensed.                                                              |
| [Talos Linux](https://github.com/siderolabs/talos)                                  | [MPL-2.0](https://github.com/siderolabs/talos/blob/main/LICENSE)                                                                                  | Node operating system and Kubernetes lifecycle.                                                                                         |
| [Kubernetes](https://github.com/kubernetes/kubernetes)                              | [Apache-2.0](https://github.com/kubernetes/kubernetes/blob/master/LICENSE)                                                                        | Scheduling and resource limits in each region.                                                                                          |
| [Flux](https://github.com/fluxcd/flux2)                                             | [Apache-2.0](https://github.com/fluxcd/flux2/blob/main/LICENSE)                                                                                   | Reconciles pinned platform releases.                                                                                                    |
| [Cilium](https://github.com/cilium/cilium)                                          | [Apache-2.0](https://github.com/cilium/cilium/blob/main/LICENSE); BPF parts [dual GPL-2.0/BSD-2-Clause](https://github.com/cilium/cilium#license) | Pod networking and NetworkPolicy.                                                                                                       |
| [OpenEBS LocalPV LVM](https://github.com/openebs/lvm-localpv)                       | [Apache-2.0](https://github.com/openebs/lvm-localpv/blob/develop/LICENSE)                                                                         | Hard-limited local volumes on the `pgcf` LVM volume group.                                                                              |
| [cert-manager](https://github.com/cert-manager/cert-manager)                        | [Apache-2.0](https://github.com/cert-manager/cert-manager/blob/master/LICENSE)                                                                    | Certificates required by the Barman plugin.                                                                                             |
| [cloudflared 2026.9.3](https://github.com/cloudflare/cloudflared)                   | [Apache-2.0](https://github.com/cloudflare/cloudflared/blob/master/LICENSE)                                                                       | Outbound tunnel from each region to Cloudflare.                                                                                         |
| [node:24.21.0-slim](https://github.com/nodejs/docker-node) | [Node.js MIT and bundled-component notices](https://github.com/nodejs/node/blob/v24.21.0/LICENSE); Debian packages retain their individual licenses | Redistributed runtime base image, pinned by its multi-platform digest in `apps/regional/Dockerfile`; see the base-image notice below. |
| [Kubernetes JavaScript client](https://github.com/kubernetes-client/javascript)     | [Apache-2.0](https://github.com/kubernetes-client/javascript/blob/master/LICENSE)                                                                 | Kubernetes API access from the regional agent.                                                                                          |
| [Neon serverless driver](https://github.com/neondatabase/serverless)                | [MIT](https://github.com/neondatabase/serverless/blob/main/LICENSE)                                                                               | Client library compatible with the edge endpoint (WebSocket `Pool`/`Client`). Used by clients and tests, not bundled into the platform. |

**Barman license note:** the upstream package metadata declares `GPL-3.0-only`, while the README
and source headers say GPL version 3 or later. Record the declaration at the pinned release.

**Regional base-image notice:** the image uses
`node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`.
Node.js includes components with their own notices; the Debian base is not covered by Node's MIT
license alone. The [official image guidance](https://github.com/nodejs/docker-node#license) refers
to these upstream licenses. Node's `/usr/local/LICENSE`, Debian package copyright files under
`/usr/share/doc` and the other notices present in the pinned base remain in the regional image.
Redistributors must retain those notices and satisfy each component's applicable obligations.

**Barman plugin issue:** the R2 restore failure reported in
[plugin-barman-cloud issue #411](https://github.com/cloudnative-pg/plugin-barman-cloud/issues/411#issuecomment-3572945793)
was a naming conflict between archives. Every restore target needs its own archive path and server
name.

## Application dependencies

Direct npm dependencies at the versions resolved in [pnpm-lock.yaml](pnpm-lock.yaml). Licenses are
read from the installed package manifests.

| Package                                                                                                 | Version | License           | Role                                                                                      |
| ------------------------------------------------------------------------------------------------------- | ------- | ----------------- | ----------------------------------------------------------------------------------------- |
| [hono](https://github.com/honojs/hono)                                                                  | 4.13.12 | MIT               | HTTP framework of the API Worker.                                                         |
| [zod](https://github.com/colinhacks/zod)                                                                | 4.6.5   | MIT               | Shared schemas and validation; bundled into regional entry points and the CLI, with its actual LICENSE shipped. |
| [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi)                | 1.6.3   | MIT               | OpenAPI document generated from the route schemas.                                        |
| [@kubernetes/client-node](https://github.com/kubernetes-client/javascript)                              | 2.0.0   | Apache-2.0        | Regional Kubernetes API client.                                                           |
| [wrangler](https://github.com/cloudflare/workers-sdk)                                                   | 4.145.0 | MIT OR Apache-2.0 | Worker build, type generation and deployment tooling.                                     |
| [ws](https://github.com/websockets/ws)                                                                  | 8.22.0  | MIT               | Gateway server, agent link and CLI WebSocket client; CLI installs the upstream runtime package with its notice. |
| [esbuild](https://github.com/evanw/esbuild)                                                             | 0.25.12 | MIT               | Bundles regional entry points and the installable CLI (build only).                  |
| [@neondatabase/serverless](https://github.com/neondatabase/serverless)                                  | 1.2.0   | MIT               | Client driver used by the live acceptance run (also listed above).                        |
| [pg](https://github.com/brianc/node-postgres)                                                           | 8.23.1  | MIT               | Authenticated TLS readiness probes in the regional agent and PostgreSQL acceptance tools. |
| [@types/pg](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/pg)                    | 8.23.1  | MIT               | PostgreSQL client types (development only).                                               |
| [vitest](https://github.com/vitest-dev/vitest)                                                          | 4.1.11  | MIT               | Test runner (development only).                                                           |
| [@cloudflare/vitest-plugin](https://github.com/cloudflare/workers-sdk/tree/main/packages/vitest-plugin) | 1.3.5   | MIT               | Runs Worker tests in the Workers runtime (development only).                              |
| [tar-stream](https://github.com/mafintosh/tar-stream) | 3.2.1 | MIT | Parses actual saved image archives and all shipped layer files during CI qualification (development only). |
| [gitleaks](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) | 8.30.1 | [MIT](https://github.com/gitleaks/gitleaks/blob/v8.30.1/LICENSE) | Default full-layer secret scanner; official release archives are SHA256-pinned and verified before execution in CI. |

Direct root development tooling (`typescript`, `eslint`, `@eslint/js`, `typescript-eslint`,
`prettier` and `@types/node`) and regional development type packages (`@types/ws`, `@types/pg`)
are not intentionally installed as runtime dependencies. Production dependency trees can still
retain type packages: `@kubernetes/client-node` includes `@types/node` 26.6.3, and
`@types/stream-buffers` includes `@types/node` 24.19.0. These production transitive dependencies
remain in the distributed image with their licenses and notices. Resolved dependency versions
are recorded in `pnpm-lock.yaml`; build and test tooling is not relicensed as first-party code.

### Reference only

| Component                                                       | License    | Use                                                                                                     |
| --------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| [neondatabase/wsproxy](https://github.com/neondatabase/wsproxy) | Apache-2.0 | Read-only reference for the WebSocket-to-PostgreSQL bridge. Not vendored, not pinned, not a dependency. |

## Acceptance workflow actions

The supplemental native TCP probe uses these official actions in the existing CI workflow.
They are pinned to immutable commits; their own bundled dependencies retain their upstream notices.
The actions run on GitHub-hosted runners and are not included in the regional image.

| Action                                                                | Release and commit                                | License                                                                                                 | Role                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [actions/attest](https://github.com/actions/attest)                   | 4.1.0, `59d89421af93a897026c735860bf21b6eb4f7b26` | [MIT](https://github.com/actions/attest/blob/59d89421af93a897026c735860bf21b6eb4f7b26/LICENSE)          | Signs provenance for the sanitized native-probe report.     |
| [actions/upload-artifact](https://github.com/actions/upload-artifact) | 7.0.0, `bbbca2ddaa5d8feaa63e36b76fdaad77386f024f` | [MIT](https://github.com/actions/upload-artifact/blob/bbbca2ddaa5d8feaa63e36b76fdaad77386f024f/LICENSE) | Publishes only the sanitized report with one-day retention. |

## Not used

| Component                                                                                                                              | Reason                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Neon storage engine, proxy](https://github.com/neondatabase/neon), [NeonVM](https://github.com/neondatabase/autoscaling) (Apache-2.0) | The public repository is effectively dormant. Its storage is a different architecture. NeonVM needs nested virtualization, which Contabo Cloud VPS lack. |
| [Xata OSS](https://github.com/xataio/xata) (Apache-2.0)                                                                                | Active and CNPG-based, but its SNI gateway is not needed: access runs through the Cloudflare edge and Tunnel.                                            |
| [PgBouncer](https://github.com/pgbouncer/pgbouncer) (ISC), [Supavisor](https://github.com/supabase/supavisor) (Apache-2.0)             | No server-side pooler in v1; reconsider with measured connection pressure.                                                                               |
| [Omni](https://github.com/siderolabs/omni) (BUSL-1.1)                                                                                  | Not open source; not needed.                                                                                                                             |

## Rules

1. Prefer maintained upstream images and APIs. Keep adapters narrow and do not fork.
2. When adding a component, record its exact release or digest, source, license and notices here.
3. Cloudflare and Contabo are service providers, not bundled software. Their terms apply
   separately.
