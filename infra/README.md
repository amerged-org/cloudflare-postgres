# Infrastructure

[node-image/](node-image/README.md) builds the Debian disk image that every node installs from: the
pinned package lock, the systemd units, the installer and the QEMU boot test that CI runs.

[platform/versions.lock.json](platform/versions.lock.json) pins the Rust compiler and its test
builder image, the Rust Edge Worker build tools and the CI toolchain (Node, Docker, the runner
distribution and the Rust targets). CI and `scripts/ci/toolchain.mjs` read it.

The Kubernetes runtime that once lived here (Talos, Flux, CloudNativePG, OpenEBS and the relay) was
retired on 2026-10-17 and is kept on the `archive/kubernetes-runtime` branch.
