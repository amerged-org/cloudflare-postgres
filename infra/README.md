# Infrastructure

[node-image/](node-image/README.md) builds the Debian disk image that every node installs from: the
pinned package lock, the systemd units, the installer and the QEMU boot test that CI runs.

The node stack is **Debian 13 (trixie), systemd, PostgreSQL 18.6 and thin LVM**. Its four
first-party binaries are native Rust: `pgcf-agent`, `pgcf-native-gateway`, `pgcf-archive` and
`pgcf-wal-fetch`. The slot supervisor executes PostgreSQL after binding a database's retained
volume and socket. The image requires no Node.js runtime; the Cloudflare API, Durable Objects,
Workflows and deployed Edge remain TypeScript outside it.

The [image recipe](node-image/mkosi.conf) and
[slot unit](node-image/mkosi.extra/usr/lib/systemd/system/pgcf-slot@.service) define the node
runtime; latest dated entries in [the ULTRA plan](../docs/architecture/cloudflare-convergence-and-serverless-plan.md)
record actual releases and operating observations.

[platform/versions.lock.json](platform/versions.lock.json) pins the Rust compiler and its test
builder image, the Rust Edge Worker build tools and the CI toolchain (Node, Docker, the runner
distribution and the Rust targets). CI and `scripts/ci/toolchain.mjs` read it.

The Kubernetes runtime that once lived here (Talos, Flux, CloudNativePG, OpenEBS and the relay) was
retired on 2026-10-17. Its source remains in Git history at commit `6761e7f0`; the obsolete
archive branch was consolidated into main history.
