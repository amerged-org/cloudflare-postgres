# SPDX-License-Identifier: Apache-2.0
ARG RUST_BUILDER
FROM ${RUST_BUILDER} AS build
ARG RUST_VERSION
ARG SOURCE_COMMIT
RUN apk add --no-cache protobuf=31.1-r1 protobuf-dev=31.1-r1
WORKDIR /workspace
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY apps/edge-rust/ apps/edge-rust/
COPY apps/native-reclaimer/ apps/native-reclaimer/
COPY apps/native-bootstrap-relay/ apps/native-bootstrap-relay/
COPY apps/node-runtime/ apps/node-runtime/
COPY apps/native-controller/ apps/native-controller/
COPY apps/sandbox-controller/ apps/sandbox-controller/
COPY apps/native-gateway/ apps/native-gateway/
COPY packages/native-protocol/ packages/native-protocol/
COPY packages/contracts/native/ packages/contracts/native/
COPY infra/platform/versions.lock.json infra/platform/versions.lock.json
COPY infra/talos/sandbox/manifest.yaml /talos-extension-manifest.template.yaml
COPY infra/talos/sandbox/service.yaml /talos-extension-service.yaml
COPY infra/talos/sandbox/20-pgcf-prestarted.part /talos-extension-cri.part
COPY LICENSE /licenses/pgcf/LICENSE
COPY apps/sandbox-controller/proto/containerd.LICENSE /licenses/containerd/LICENSE
COPY apps/sandbox-controller/proto/cri-api.LICENSE /licenses/cri-api/LICENSE
COPY apps/sandbox-controller/proto/ttrpc.LICENSE /licenses/ttrpc/LICENSE
COPY Cargo.lock /licenses/provenance/Cargo.lock
COPY infra/platform/versions.lock.json /licenses/provenance/versions.lock.json
COPY packages/contracts/native/protocol.generated.json /licenses/provenance/protocol.generated.json
COPY packages/native-protocol/src/constants.generated.rs /licenses/provenance/constants.generated.rs
COPY packages/contracts/native/compute-pool.generated.json /licenses/provenance/compute-pool.generated.json
COPY packages/contracts/native/reclaim.generated.json /licenses/provenance/reclaim.generated.json
RUN rustc --version | grep -F "rustc ${RUST_VERSION} " \
 && if test -n "$SOURCE_COMMIT"; then test "${#SOURCE_COMMIT}" -eq 40 && case "$SOURCE_COMMIT" in *[!0-9a-f]*) exit 1;; esac; fi \
 && export PGCF_SOURCE_REVISION="$SOURCE_COMMIT" PGCF_RUST_VERSION="$RUST_VERSION" \
 && export PGCF_VERSIONS_LOCK_SHA256="$(sha256sum infra/platform/versions.lock.json | cut -d ' ' -f 1)" \
 && export PGCF_CARGO_LOCK_SHA256="$(sha256sum Cargo.lock | cut -d ' ' -f 1)" \
 && cargo build --release --locked -p pgcf-sandbox-controller -p pgcf-node-runtime \
 && sh apps/native-gateway/license-bundle.sh \
 && if test -n "$SOURCE_COMMIT"; then PGCF_EXTENSION_VERSION="0.1.0-$SOURCE_COMMIT"; else PGCF_EXTENSION_VERSION="0.1.0-local"; fi \
 && PGCF_TALOS_VERSION=$(sed -n 's/^[[:space:]]*"talosVersion":[[:space:]]*"\([0-9.]*\)".*/\1/p' infra/platform/versions.lock.json) \
 && printf '%s\n' "$PGCF_TALOS_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
 && sed -e "s/PGCF_EXTENSION_VERSION/$PGCF_EXTENSION_VERSION/" -e "s/PGCF_TALOS_VERSION/$PGCF_TALOS_VERSION/" /talos-extension-manifest.template.yaml > /talos-extension-manifest.yaml
FROM scratch AS talos-extension
COPY --from=build /workspace/target/release/pgcf-sandbox-controller /rootfs/usr/local/bin/pgcf-sandbox-controller
COPY --from=build /workspace/target/release/pgcf-node-runtime /rootfs/usr/local/bin/pgcf-node-runtime
COPY --from=build /licenses /rootfs/usr/local/share/licenses/pgcf-sandbox
COPY --from=build /talos-extension-manifest.yaml /manifest.yaml
COPY --from=build /talos-extension-service.yaml /rootfs/usr/local/etc/containers/pgcf-sandbox-controller.yaml
COPY --from=build /talos-extension-cri.part /rootfs/etc/cri/conf.d/20-pgcf-prestarted.part
FROM scratch AS runtime
COPY --from=build /workspace/target/release/pgcf-sandbox-controller /usr/local/bin/pgcf-sandbox-controller
COPY --from=build /workspace/target/release/pgcf-node-runtime /usr/local/bin/pgcf-node-runtime
COPY --from=build /licenses /licenses
ENTRYPOINT ["/usr/local/bin/pgcf-sandbox-controller"]
