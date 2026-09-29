# Node runtime observer dependencies

This module reuses the unmodified Apache-2.0 Kubernetes CRI client and API at `v0.36.3`, matching the current development Kubernetes minor. The narrow adapter permits observation methods only; the upstream constructor also performs a read-only Version handshake. No upstream source is vendored or relabeled.

- [CRI client source and license](https://github.com/kubernetes/cri-client/tree/v0.36.3).
- [CRI API source and license](https://github.com/kubernetes/cri-api/tree/v0.36.3).
- `go.mod` and `go.sum` pin direct and transitive dependency versions/checksums. The image includes the pinned module inventory and upstream root license/notice files under `/licenses`; the standard-library license/patents are included separately. The build refuses a dependency without such a license file. Release qualification must still audit applicable source-file and embedded dependency notices.
- The official Go `1.27.1-alpine` build image is pinned by multi-platform digest. The runtime is a static first-party binary in scratch; it contains no development configuration, credentials or tool cache.

First-party code is Apache-2.0. Runtime trust and integration limitations are in [README.md](README.md). A build or an isolated local observation does not qualify stopped compute or finalized usage.
