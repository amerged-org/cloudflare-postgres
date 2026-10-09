# Third-party components

Reviewed: 2026-10-06. The repository's [Apache License 2.0](LICENSE) covers original
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
| [cloudflared 2026.10.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.0) | [Apache-2.0](https://github.com/cloudflare/cloudflared/blob/2026.10.0/LICENSE) | Outbound regional and bootstrap-relay tunnels, pinned to multi-platform index `sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07`. |
| [node:24.21.0-slim](https://github.com/nodejs/docker-node) | [Node.js MIT and bundled-component notices](https://github.com/nodejs/node/blob/v24.21.0/LICENSE); Debian packages retain their individual licenses | Redistributed runtime base image, pinned by its multi-platform digest in `apps/regional/Dockerfile`; see the base-image notice below. |
| [Kubernetes JavaScript client](https://github.com/kubernetes-client/javascript)     | [Apache-2.0](https://github.com/kubernetes-client/javascript/blob/master/LICENSE)                                                                 | Kubernetes API access from the regional agent.                                                                                          |
| [Neon serverless driver](https://github.com/neondatabase/serverless)                | [MIT](https://github.com/neondatabase/serverless/blob/main/LICENSE)                                                                               | Client library compatible with the edge endpoint (WebSocket `Pool`/`Client`). Used by clients and tests, not bundled into the platform. |

**PostgreSQL security image:** `infra/postgres/Dockerfile` retains the unmodified upstream
PostgreSQL 18.6 engine and the CloudNativePG runtime, pinned by the official multi-platform
and AMD64 digests in `infra/postgres/sources.lock.json`. It replaces only the upstream
`postgresql-18-pgvector` package with checksum-pinned pgvector 0.8.7, fixing
[CVE-2026-103484](https://www.postgresql.org/about/news/pgvector-087-released-3392/).
[pgvector](https://github.com/pgvector/pgvector/tree/f37c13f68b57d2c3472b2214fbcff699d6d34876)
uses the PostgreSQL License. PostgreSQL and pgvector copyright files remain in the image.
The final image snapshots the patched upstream filesystem into one layer after removing
only `/etc/ssl/private/ssl-cert-snakeoil.key` and its unused paired certificate,
`/etc/ssl/certs/ssl-cert-snakeoil.pem`. Earlier key-bearing build layers are not published.
Verified upstream runtime settings, the engine bytes and other package versions are retained.
Other upstream packages retain their licenses. First-party assembly code remains Apache-2.0.
The single CI workflow checks the unchanged engine, package identity, actual extension creation
and SQL, then qualifies every image layer before publication. Existing databases require their
own extension upgrade after the image update; a new package alone does not change `extversion`.

**Barman license note:** the upstream package metadata declares `GPL-3.0-only`, while the README
and source headers say GPL version 3 or later. Record the declaration at the pinned release.

**Regional base-image notice:** the image uses
`node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`.
Node.js includes components with their own notices; the Debian base is not covered by Node's MIT
license alone. The [official image guidance](https://github.com/nodejs/docker-node#license) refers
to these upstream licenses. Node's `/usr/local/LICENSE`, Debian package copyright files under
`/usr/share/doc` and the other notices present in the pinned base remain in the regional image.
Redistributors must retain those notices and satisfy each component's applicable obligations.

**Node bootstrap image:** `apps/node-bootstrap/Dockerfile` uses the same pinned Node base.
It bundles yaml 2.9.1 (ISC) and zod 4.6.5 (MIT), with their installed license files under
`/app/licenses`. The unmodified Talos CLI 1.14.1 (MPL-2.0) and Kubernetes CLI 1.36.5
(Apache-2.0) are downloaded from their official releases and checked against the recorded
SHA-256 for each supported architecture. Their license files are retained in the image.
Helm `4.3.0` (Apache-2.0) is downloaded from the [official release](https://github.com/helm/helm/releases/tag/v4.3.0)
with architecture-specific archive checksums in `infra/platform/versions.lock.json`; its license
is retained at `/app/licenses/helm/LICENSE`. The qualified amd64 binary is extracted from the
verified official archive and additionally bound by its whole-file SHA-256 and size. Pinned
Cilium `1.20.2` chart and Flux `2.9.6` install assets retain their Apache-2.0 notices under
`/app/licenses/cilium` and `/app/licenses/flux`.
The matching source releases are [Talos v1.14.1](https://github.com/siderolabs/talos/tree/v1.14.1)
and [Kubernetes v1.36.5](https://github.com/kubernetes/kubernetes/tree/v1.36.5).

The actual base runs Debian Bookworm. Added direct Debian packages are pinned to
ca-certificates `20250419~deb12u1`, curl `7.88.1-10+deb12u15` (build stage only) and
openssh-client `1:9.2p1-2+deb12u10`. Their Debian copyright and source references remain
under `/usr/share/doc`; these packages and their dependencies keep their own licenses.
See the primary package records for [ca-certificates](https://packages.debian.org/bookworm/ca-certificates),
[curl](https://packages.debian.org/bookworm/curl) and [OpenSSH](https://packages.debian.org/bookworm/openssh-client).
Full payload qualification and immutable release digests bind the actual shipped dependency set.

**Barman plugin images:** the pinned [plugin v0.15.1](https://github.com/cloudnative-pg/plugin-barman-cloud/tree/v0.15.1)
and [chart v0.8.1](https://github.com/cloudnative-pg/charts/tree/plugin-barman-cloud-v0.8.1)
retain their Apache-2.0 licenses. The plugin release updates its Barman dependency to
[3.20.1](https://github.com/EnterpriseDB/barman/tree/release%2F3.20.1), which retains
GPL-3.0 source and redistribution obligations. These upstream images remain unmodified;
the platform lock records verified chart bytes and metadata, not a complete image security audit.

**Barman plugin issue:** the R2 restore failure reported in
[plugin-barman-cloud issue #411](https://github.com/cloudnative-pg/plugin-barman-cloud/issues/411#issuecomment-3572945793)
was a naming conflict between archives. Every restore target needs its own archive path and server
name.

**Operator network-capture image:** post-join acceptance uses the unmodified `linux/amd64`
image `docker.io/jonlabelle/network-tools:sha-6257a44@sha256:0c4de3370f8c19aa7c9577ea9ab9bb72063db807efe88a8a7bbead9482b89732`,
from [source revision `6257a444384726c3e0093ba1cf37d5780fda4637`](https://github.com/jonlabelle/docker-network-tools/tree/6257a444384726c3e0093ba1cf37d5780fda4637).
Its [MIT license](https://github.com/jonlabelle/docker-network-tools/blob/6257a444384726c3e0093ba1cf37d5780fda4637/LICENSE.txt)
covers the image recipe. The verified installed tools are Bash `5.3.9-r1` and GNU coreutils
`9.11-r0` (`GPL-3.0-or-later`), tcpdump `4.99.6-r1` and libpcap `1.10.7-r0` (`BSD-3-Clause`).
Other Alpine packages retain their individual licenses. Preserve upstream notices and satisfy
applicable source obligations when redistributing. This temporary image is operator acceptance
tooling, separate from the product runtime.

## Native Rust runtime primitive

The first-party prepared namespace holder is Apache-2.0. Its only direct crate dependency is
[libc0.2.190](https://crates.io/crates/libc/0.2.190), licensed `MIT OR Apache-2.0`; Cargo.lock binds
archive checksum `ce5d3ddc6d3fa000eb1536d85e147bfe31aacaba692ed6a876f95cb7c855be78`.
Rust1.99.0 and the immutable compiler test image are recorded in versions.lock.json.
The compiler image is used for isolated tests and is not published as a PGCF runtime. Preserve
Rust standard-library and libc notices when distributing a static native executable; do not
attribute their code to the project's Apache license alone. No upstream source is vendored here.
The primitive is not yet installed on customer servers or integrated with containerd/CNPG.

CI host checks use the build-only [Protocol Buffers31.1 compiler](https://github.com/protocolbuffers/protobuf/releases/tag/v31.1)
under [BSD-3-Clause](https://github.com/protocolbuffers/protobuf/blob/v31.1/LICENSE), matching the
31.1 compiler used by the pinned Alpine build recipes. The Linux archive and executable SHA256
are recorded in `nativeRuntime.protoc` in versions.lock.json. They were pinned from the official
release download and checked against its published asset size; that historical asset has no
vendor-published digest. The compiler is not shipped in PGCF runtime images.

The native sandbox-controller adapter uses unchanged Apache-2.0 protobuf definitions from
[containerd 2.3.6](https://github.com/containerd/containerd/tree/v2.3.6/api),
[Kubernetes CRI API 0.36.5](https://github.com/kubernetes/cri-api/tree/v0.36.5) and
[containerd ttrpc 1.2.7](https://github.com/containerd/ttrpc/tree/v1.2.7).
Exact source paths and SHA256 values are retained in
`apps/sandbox-controller/proto/sources.json`, with all three upstream licenses beside them.
The adapter's direct crates are tonic/tonic-prost/tonic-prost-build 0.14.6 (MIT),
prost/prost-types 0.14.4 (Apache-2.0), tokio 1.53.2 and tokio-stream 0.1.19 (MIT),
tower 0.5.3 (MIT), hyper-util 0.1.21 (MIT), serde 1.0.229 and serde_json 1.0.151
(MIT OR Apache-2.0), plus libc above. Cargo.lock retains exact archive checksums and
transitive versions. The isolated Linux boundary proof uses official containerd 2.3.6
and runc 1.5.2 (both Apache-2.0); these local test binaries are not shipped in a published
PGCF image. Preserve all upstream notices when packaging a future runtime or Talos extension.
Its Cloudflare policy consumer also uses pinned reqwest 0.13.5 (MIT OR Apache-2.0), rustls
0.23.45 (Apache-2.0 OR ISC OR MIT), webpki-roots 1.0.9 (MPL-2.0), time 0.3.55
(MIT OR Apache-2.0), sha2 0.11.0 (MIT OR Apache-2.0), and jsonschema 0.58.6 (MIT).
The native gateway and controller use rustls-pki-types 1.15.1 (MIT OR Apache-2.0)
directly for PEM parsing; the unmaintained rustls-pemfile wrapper is not shipped.
The scratch artifact includes the actual Cargo dependency notices, Rust notices, generated
shared contract bytes and exact Cargo.lock rather than shipping a compiler or test runtime.
The common boot asset producer uses official Talos imager 1.14.2 (MPL-2.0), with
the imager and installer-base references pinned under `talosBoot` in
[versions.lock.json](infra/platform/versions.lock.json). The imager reference is
`ghcr.io/siderolabs/imager@sha256:89d1b1e2be167632745abf7f6834220a255a0182714f3d91670ecad55a3c41ff`,
and installer-base 1.14.2 at
`ghcr.io/siderolabs/installer-base@sha256:a47d7d4ed3ff5e3467494a0e62483767a5ba00d731b963cdcbc917abd83553d6`.
Their manifests and SHA256 headers were verified against the official anonymous GHCR API.
PGCF extension/service/recipe files remain Apache-2.0; compiled upstream dependencies keep
the notices inside the system-extension rootfs.
The disposable public runtime proof pins official containerd-static 2.3.6 AMD64 SHA256
`96eece214bedf3b77d2c2fd04245baaa3de36a1be1d10addf358dca71ae876d2` and runc 1.5.2 AMD64
SHA256 `599f6f94ff8c5057241eff0d54c3c74f95c34935b6457b33fe545defc61e9488` (Apache-2.0).
For native ARM64 the matching hashes are containerd
`b188111644bf19c3f482f0f0d4b7b93461a3653e60521289519cc474f5bce511` and runc
`d10ecae898361832a059be2089bab92d158aec54661b18ed7346ed79628b46b0`.
All eleven vendored containerd protobuf files are byte-identical between 2.3.5 and 2.3.6;
their source metadata now names the selected 2.3.6 release.
Its test-only Alpine tools pin iproute2 7.0.0-r0 (GPL-2.0-or-later) and busybox-static
1.37.0-r31 (GPL-2.0-only); they are not shipped in the PGCF runtime/system extension.

## Assembled Talos boot qualification tools

The disposable inspection and maintenance-boot fixture in
[BootProof.Dockerfile](infra/talos/sandbox/BootProof.Dockerfile) uses
`debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f`.
It runs only on the local/CI inspection host and is not published or installed on fleet nodes.
Node and the official Talos client come from the existing pinned build inputs and client archive
checksums. Debian package copyright files under `/usr/share/doc/*/copyright` and
`/usr/share/common-licenses` remain in this fixture, including all transitive package notices.

| Direct package | Exact Debian version | Upstream licensing and purpose |
| --- | --- | --- |
| [QEMU](https://www.qemu.org/) `qemu-system-x86` | `1:10.0.13+ds-0+deb13u1` | GPL-2.0 as a whole, with compatible per-file licenses; isolated AMD64 maintenance boot. |
| [squashfs-tools](https://github.com/plougher/squashfs-tools) | `1:4.6.1-1+b1` | GPL-2.0-or-later; complete root-filesystem and extended-attribute extraction. |
| [util-linux](https://www.kernel.org/pub/linux/utils/util-linux/) | `2.41.5-0+deb13u1` | GPL/LGPL/BSD/ISC/Expat and other per-file licenses recorded by Debian; read-only partition mounts and loop-device checks. |
| [XZ Utils](https://tukaani.org/xz/) `xz-utils` | `5.8.1-1+deb13u2` | 0BSD with bundled GPL/LGPL and other per-file notices; bounded raw-image decompression. |
| [GCC runtime](https://gcc.gnu.org/) `libstdc++6`, `libatomic1` | `14.2.0-19` | GPL-3.0 with GCC Runtime Library Exception and the package's other notices; inspection-tool runtime libraries. |
| [Debian ca-certificates](https://packages.debian.org/trixie/ca-certificates) | `20250419` | GPL-2.0-or-later packaging and MPL-2.0 certificate material; verified public tool downloads. |

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
| [yaml](https://github.com/eemeli/yaml) | 2.9.1 | ISC | Parses and generates protected native bootstrap configuration; its installed license ships in the bootstrap image. |
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
