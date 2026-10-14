# OpenEBS storage metadata, pool custody and thin tools

The storage image retains OpenEBS LVM LocalPV 1.10.1's LVM binary and runtime,
while rebuilding the driver with metadata readers and a per-volume pool custody gate. Its metadata
collectors read the original visible-LV `lvs` and `vgs` reports independently of
public device symlink readiness or CSI thin-pool capacity enrichment. Every
measured visible LV remains in the inventory. Missing utilization is omitted,
not converted to zero; duplicate segment rows must agree. An absent enum field
remains unknown, while LVM's explicitly empty healthy status retains its meaning.
The node controller still checks complete counts and required primary-pool facts.

The original CSI device-path and capacity functions are unchanged source bytes.
NodePublishVolume (including raw block and its already-mounted fast path),
NodeExpandVolume and the node volume/snapshot reconcilers now acquire the same
per-volume lock as the agent and refuse any durable denial record. The root-owned
`/var/lib/kubelet/pgcf-pool-gates` directory contains SHA-256 volume-handle keys.
Locks are never unlinked; process death releases a lock but preserves denial.
Expiry, malformed records and agent restart cannot authorize publishing. Normal
detach requires nonlazy unmount, closure of creation descriptors and fresh
UUID-scoped global device open-count zero. After a different boot, fresh physical
absence is reported as an unclean boot loss without claiming an unmount. In both
cases the agent retains its exact denial until Cloudflare's retained terminal
binding contains one of its actual durable reports. A guarded driver cannot be
replaced or rolled back while a pool holder remains active.


The rebuilt executable has different machine bytes and a separately pinned hash.
The image also adds the checksum-pinned, signature-verified official Alpine
`thin-provisioning-tools` package, providing `thin_check` and `thin_repair` without
disabling metadata checking or automatically repairing damaged pools. LVM bytes,
installed runtime dependency versions and effective runtime configuration remain
bound to the original image.

`sources.lock.json` records the original image/binary, rebuilt binary, Go builder,
source archive, local patch, build-only patch tool, runtime tools and notice hashes.
The image retains the OpenEBS source archive and applied patch under `/usr/share/pgcf`,
its Apache-2.0 license and modification notice under `/usr/share/licenses/pgcf-lvm-localpv`,
the Go BSD-3-Clause license and vendored dependency notices, and the thin-tools
GPL-3.0-only corresponding source/COPYING. First-party assembly remains Apache-2.0.

```sh
docker buildx build --platform linux/amd64 --load --provenance=false \
  --tag pgcf-storage:local infra/storage
PGCF_TEST_STORAGE_IMAGE=pgcf-storage:local node --test infra/storage/image.test.mjs
```

Among RUN instructions, only the builder's checksum-verified Go module download/vendor step uses network.
Remote ADD fetches remain HTTPS downloads bound by their recorded SHA-256.
Unpack/patch, direct parser/collector tests, compilation and final runtime package
installation explicitly run without network. The build-only Alpine patch package
is verified by SHA-256 and the builder's inherited official signing keys.

The unprivileged image tests use regular files in a bounded temporary filesystem,
without network, host devices or capabilities. They bind the actual executable,
source/patch/notices and unchanged runtime, and prove real thin-metadata restore,
check, explicit-geometry repair and corruption rejection. The Go tests execute the
actual metadata parsers/collector logic on inputs reproducing observed LV shapes,
real process/file-lock serialization and the actual CSI entrypoint refusal;
they do not substitute shell responses. Live pool geometry, exported series,
capacity growth, full-pool recovery and reclamation require a new fenced Dev
qualification against the rebuilt driver image.

The existing CI image qualification scans every layer and publishes the immutable
driver digest before release selection. Use the existing public `pgcf-regional`
package with a separate `lvm-thin-sha-<commit>` tag. Selecting this image does not
activate thin storage or change existing thick volumes.
