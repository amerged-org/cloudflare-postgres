# Third-party components

Reviewed: 2026-10-17. The repository's [Apache License 2.0](LICENSE) covers original
project work only. Upstream components keep their own licenses, notices and source obligations.
No upstream source is vendored in the repository.
Direct application dependencies are listed below at the version
resolved in `pnpm-lock.yaml`. Their transitive dependencies are recorded only in the lockfile.
Recheck the exact release and its dependencies before upgrading or redistributing.

## Selected stack

Pinned Rust, Edge build and CI toolchain versions are in [infra/platform/versions.lock.json](infra/platform/versions.lock.json).

| Component                                                                                 | License                                                                                  | Role                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [PostgreSQL](https://www.postgresql.org/)                                                 | [PostgreSQL License](https://www.postgresql.org/about/licence/)                          | The database engine, unmodified (18.x); the node image installs the PGDG packages.                                                      |
| [Barman / barman-cloud](https://github.com/EnterpriseDB/barman)                           | [GPL-3.0](https://github.com/EnterpriseDB/barman/blob/REL_3_X_master/LICENSE) (see note) | Backup tooling run unmodified on the node for base backups, WAL archiving and PITR to R2; not relicensed.                               |
| [cloudflared 2026.10.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.0) | [Apache-2.0](https://github.com/cloudflare/cloudflared/blob/2026.10.0/LICENSE)           | Outbound Tunnel of each node; the node image pins its binary.                                                                           |
| [Neon serverless driver](https://github.com/neondatabase/serverless)                      | [MIT](https://github.com/neondatabase/serverless/blob/main/LICENSE)                      | Client library compatible with the edge endpoint (WebSocket `Pool`/`Client`). Used by clients and tests, not bundled into the platform. |

**PostgreSQL test server:** CI installs PostgreSQL 18.6 from the PGDG apt repository, the
`postgresql-18` and `postgresql-client-18` packages at `18.6-1.pgdg24.04+2`, verified by the
repository key fingerprint `B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8`. It serves only the Rust
tests of the gateway and the archive clients, which start real servers; it is in no PGCF image
and on no node. The packages retain the PostgreSQL License and their own notices.

**Barman license note:** the upstream package metadata declares `GPL-3.0-only`, while the README
and source headers say GPL version 3 or later. Record the declaration at the pinned release.

## Native Rust gateway and node agent

The native gateway (`apps/native-gateway`), the node agent library (`apps/node-agent`), the
shared protocol crate (`packages/native-protocol`), the archive clients (`apps/pgcf-archive`,
`apps/pgcf-wal-fetch`) and the PostgreSQL test harness (`packages/test-postgres`) are first-party
Apache-2.0. The archive clients and the test harness use only the Rust standard library (the
archive clients' tests also read the contract's vectors with serde_json). Each `Cargo.toml` pins its
direct crates exactly; `Cargo.lock` binds their archive checksums and transitive versions. No
upstream source is vendored here.

The gateway's direct crates are httparse 1.10.1, time 0.3.55, futures-util 0.3.34, serde 1.0.229,
serde_json 1.0.151, sha2 0.11.0, hmac 0.13.0 and base64 0.23.1 (all `MIT OR Apache-2.0`), zeroize
1.9.1 (`Apache-2.0 OR MIT`), ring 0.17.14 (`Apache-2.0 AND ISC`), and tokio 1.53.2 and
tokio-tungstenite 0.30.0 (MIT). The protocol crate adds regex 1.13.1 (`MIT OR Apache-2.0`) and,
outside Wasm, time 0.3.55 (the agent channel's timestamps). The node agent adds reqwest 0.13.5,
rustls-pki-types 1.15.1, tokio-postgres 0.7.18 and libc 0.2.190 (`MIT OR Apache-2.0`), rustls
0.23.45 and tokio-rustls 0.26.6 (`Apache-2.0 OR ISC OR MIT` and `MIT OR Apache-2.0`), jsonschema
0.58.6 and zbus 5.19.0 (MIT; zbus drives the database units over systemd's D-Bus API), and
webpki-roots 1.0.9 (`CDLA-Permissive-2.0`). The agent signs the node's requests with its Ed25519
key through ring, checks the Ed25519 signature of each release against the release key through
the same crate (`ring::signature::ED25519`; no crate was added for release signing, and the
script that makes and checks the key uses Node's own `node:crypto`), and speaks the link's TLS
WebSocket to Cloudflare through tokio-rustls and tokio-tungstenite. Its tests also use rcgen 0.14.10 (`MIT OR Apache-2.0`). rustls-pki-types is used
directly for PEM parsing; the unmaintained rustls-pemfile wrapper is not used. The gateway's SCRAM
client uses hmac and zeroize directly, with sha2, and takes its random nonces from ring.

Rust 1.99.0 and the immutable compiler test image are recorded in
[versions.lock.json](infra/platform/versions.lock.json). The compiler image is used for isolated
tests and is not published as a PGCF runtime. Preserve Rust standard-library and crate notices
when distributing a native executable; do not attribute their code to the project's Apache
license alone.

## Rust/Wasm Edge Worker

The complete Edge application uses the official
[workers-rs 0.8.7](https://github.com/cloudflare/workers-rs) SDK (`worker`,
`worker-sys` and `worker-macros`, Apache-2.0). `Cargo.lock` records the exact runtime
crate archives and their transitive dependencies. The verified `worker` archive
SHA256 is `4057bce8ec66c80b7e270d884c312e2a4ff60eb997fd02936656106c06a964e5`.
The shared native protocol crate remains first-party Apache-2.0.

The host bindings use wasm-bindgen 0.2.129, js-sys/web-sys 0.3.106 and
wasm-bindgen-futures 0.4.79 (`MIT OR Apache-2.0`), serde-wasm-bindgen 0.6.5 (MIT),
and futures-channel/futures-util 0.3.34 (`MIT OR Apache-2.0`). Preserve their
notices and the Rust standard-library notices with distributed Worker artifacts.

The build-only `worker-build` 0.8.7 tool is Apache-2.0; its verified crate archive
SHA256 is `1051c05ef088889a30ad3bad40c22a716ba8ca8d02a3fb01cef8c143ba952222`.
It selects wasm-bindgen CLI 0.2.129, Binaryen wasm-opt 132 (Apache-2.0) and
esbuild 0.28.2 (MIT). These tools are not Worker runtime dependencies. Generated
SDK/wasm-bindgen host glue retains upstream licensing; the admission and decoy
state machines are first-party Rust. No maintained TypeScript Edge wrapper is
included in that artifact.

## Node image

The node image ([infra/node-image](infra/node-image/README.md)) redistributes unmodified Debian 13
and PGDG binary packages. [packages.lock.json](infra/node-image/packages.lock.json) records every
one with its exact version, download URL, size and sha256, and the image keeps each package's
`/usr/share/doc/<package>/copyright`. Corresponding sources are on snapshot.debian.org at the locked
snapshot and on apt-archive.postgresql.org.

| Component | License | Role |
| --- | --- | --- |
| [Debian 13 "trixie"](https://www.debian.org/) packages at snapshot `20261016T133910Z`, Linux 6.12.113 (`6.12.113-1`) | Per package (DFSG); the kernel GPL-2.0 | Node operating system |
| [systemd 257](https://github.com/systemd/systemd) | LGPL-2.1-or-later | Units, sandboxing, cgroups, credentials, first-boot partitioning |
| [GRUB 2](https://www.gnu.org/software/grub/) | GPL-3.0-or-later | BIOS and UEFI boot loader |
| [PostgreSQL 18.6](https://www.postgresql.org/) (PGDG `18.6-1.pgdg13+2`, with its `libpq5` pinned to the same version) | [PostgreSQL License](https://www.postgresql.org/about/licence/) | The database engine, unmodified |
| [pgvector 0.8.7](https://github.com/pgvector/pgvector) (PGDG `0.8.7-1.pgdg13+1`) | PostgreSQL License | Extension |
| [barman-cli-cloud 3.20.1](https://github.com/EnterpriseDB/barman) (PGDG `3.20.1-1.pgdg13+1`) | GPL-3.0 | WAL archive, base backup and restore to R2; run as a separate program, not linked |
| [lvm2](https://sourceware.org/lvm2/), [thin-provisioning-tools](https://github.com/jthornber/thin-provisioning-tools) | GPL-2.0, LGPL-2.1 / GPL-3.0 | Thin pool and volumes, run as separate programs |
| [cloudflared 2026.10.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.0) | [Apache-2.0](https://github.com/cloudflare/cloudflared/blob/2026.10.0/LICENSE) | The node's Tunnel; release `.deb` pinned by sha256 `9721287c28f78cb623e77c7b95a63feea87e909054d75666a0ec9eff20e5d548` |
| [mkosi v27.1](https://github.com/systemd/mkosi) (commit `ecf7f5702bb2052b7a69cab3fe7d37bc3b9ad77b`) | LGPL-2.1-or-later | Build tool only; not in the image |

The PGDG archive signing key in [infra/node-image/keys/pgdg.asc](infra/node-image/keys/pgdg.asc)
(fingerprint `B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8`) is the public key published by the
PostgreSQL project.

## Application dependencies

Direct npm dependencies at the versions resolved in [pnpm-lock.yaml](pnpm-lock.yaml). Licenses are
read from the installed package manifests.

| Package                                                                                                 | Version | License           | Role                                                                                      |
| ------------------------------------------------------------------------------------------------------- | ------- | ----------------- | ----------------------------------------------------------------------------------------- |
| [hono](https://github.com/honojs/hono)                                                                  | 4.13.12 | MIT               | HTTP framework of the API Worker.                                                         |
| [zod](https://github.com/colinhacks/zod)                                                                | 4.6.5   | MIT               | Shared schemas and validation; bundled into the CLI, with its actual LICENSE shipped.     |
| [@hono/zod-openapi](https://github.com/honojs/middleware/tree/main/packages/zod-openapi)                | 1.6.3   | MIT               | OpenAPI document generated from the route schemas.                                        |
| [wrangler](https://github.com/cloudflare/workers-sdk)                                                   | 4.145.0 | MIT OR Apache-2.0 | Worker build, type generation and deployment tooling.                                     |
| [ws](https://github.com/websockets/ws)                                                                  | 8.22.0  | MIT               | CLI WebSocket client, the probe tests, the SaaS benchmark's socket and the Edge benchmark's loopback shim; the CLI installs the upstream runtime package with its notice. |
| [esbuild](https://github.com/evanw/esbuild)                                                             | 0.25.12 | MIT               | Bundles the installable CLI (build only).                                                 |
| [@neondatabase/serverless](https://github.com/neondatabase/serverless)                                  | 1.2.0   | MIT               | Client driver used by the probe Worker and the Edge HTTP query mode test (also listed above). |
| [pg](https://github.com/brianc/node-postgres)                                                           | 8.23.1  | MIT               | PostgreSQL client of the Edge runtime tests and benchmark (development only).             |
| [vitest](https://github.com/vitest-dev/vitest)                                                          | 4.1.11  | MIT               | Test runner (development only).                                                           |
| [@cloudflare/vitest-plugin](https://github.com/cloudflare/workers-sdk/tree/main/packages/vitest-plugin) | 1.3.5   | MIT               | Runs Worker tests in the Workers runtime (development only).                              |

Direct root development tooling (`typescript`, `eslint`, `@eslint/js`, `typescript-eslint`,
`prettier` and `@types/node`) and the development type packages `@types/pg` and `@types/ws` are not intentionally
installed as runtime dependencies. Resolved dependency versions are recorded in `pnpm-lock.yaml`;
build and test tooling is not relicensed as first-party code.

### Reference only

| Component                                                       | License    | Use                                                                                                     |
| --------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| [neondatabase/wsproxy](https://github.com/neondatabase/wsproxy) | Apache-2.0 | Read-only reference for the WebSocket-to-PostgreSQL bridge. Not vendored, not pinned, not a dependency. |

## Architecture documentation tooling

[Mermaider](https://github.com/sebmer-com/mermaider) 0.1.1 is licensed under
[Apache-2.0](https://github.com/sebmer-com/mermaider/blob/main/LICENSE). Its immutable
source revision is recorded in [.mermaider/tool-revision](.mermaider/tool-revision);
the existing CI workflow reads that pin and installs the tool's locked dependency
tree. Mermaider generates and checks selected source-backed architecture, schema,
CI and process diagrams. It is development tooling, not part of any PGCF runtime
image. Its dependencies retain the licenses and notices in their installed
packages and upstream source. The generated offline diagram gallery embeds
[Mermaid 11.17.2](https://github.com/mermaid-js/mermaid/tree/mermaid%4011.17.2),
with its MIT license included in the HTML; this browser renderer is documentation
content, not a PGCF service. The gallery also embeds unmodified Latin Modern
regular and italic fonts from latex.css 1.14.0 under the GUST Font License 1.0
(LPPL 1.3c or later); the full font and distribution notices are included in its
HTML and in [Mermaider's notices](https://github.com/sebmer-com/mermaider/blob/main/THIRD_PARTY.md).
No Mermaider analysis source is vendored here.

## Acceptance workflow actions

The supplemental native TCP probe uses these official actions in the existing CI workflow.
They are pinned to immutable commits; their own bundled dependencies retain their upstream notices.
The actions run on GitHub-hosted runners and are not part of any PGCF runtime.

| Action                                                                | Release and commit                                | License                                                                                                 | Role                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [actions/attest](https://github.com/actions/attest)                   | 4.1.0, `59d89421af93a897026c735860bf21b6eb4f7b26` | [MIT](https://github.com/actions/attest/blob/59d89421af93a897026c735860bf21b6eb4f7b26/LICENSE)          | Signs provenance for the sanitized native-probe report.     |
| [actions/upload-artifact](https://github.com/actions/upload-artifact) | 7.0.0, `bbbca2ddaa5d8feaa63e36b76fdaad77386f024f` | [MIT](https://github.com/actions/upload-artifact/blob/bbbca2ddaa5d8feaa63e36b76fdaad77386f024f/LICENSE) | Publishes only the sanitized report with one-day retention; the check job also retains the tested Rust Edge bytes. |
| [actions/download-artifact](https://github.com/actions/download-artifact) | 8.0.1, `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` | [MIT](https://github.com/actions/download-artifact/blob/3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/LICENSE) | Hands the release files of the `node-image` job to the `sign-release` job, which signs them. |

## Not used

| Component                                                                                                                              | Reason                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Neon storage engine, proxy](https://github.com/neondatabase/neon), [NeonVM](https://github.com/neondatabase/autoscaling) (Apache-2.0) | The public repository is effectively dormant. Its storage is a different architecture. NeonVM needs nested virtualization, which Contabo Cloud VPS lack. |
| [Xata OSS](https://github.com/xataio/xata) (Apache-2.0)                                                                                | Requires Kubernetes, CloudNativePG and OpenEBS, the platform PGCF left; access runs through the Cloudflare edge and Tunnel.                              |
| [PgBouncer](https://github.com/pgbouncer/pgbouncer) (ISC), [Supavisor](https://github.com/supabase/supavisor) (Apache-2.0)             | No server-side pooler in v1; reconsider with measured connection pressure.                                                                               |

## Rules

1. Prefer maintained upstream images and APIs. Keep adapters narrow and do not fork.
2. When adding a component, record its exact release or digest, source, license and notices here.
3. Cloudflare and Contabo are service providers, not bundled software. Their terms apply
   separately.
