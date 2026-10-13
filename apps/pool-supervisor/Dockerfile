# SPDX-License-Identifier: Apache-2.0
# Static PID1 copied into unmodified pinned PostgreSQL and Barman images by the pool init container.
ARG RUST_BUILDER
FROM ${RUST_BUILDER} AS build
ARG RUST_VERSION
ARG SOURCE_COMMIT
WORKDIR /workspace
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY apps/edge-rust/ apps/edge-rust/
COPY apps/native-reclaimer/ apps/native-reclaimer/
COPY apps/native-bootstrap-relay/ apps/native-bootstrap-relay/
COPY apps/native-controller/ apps/native-controller/
COPY apps/native-gateway/ apps/native-gateway/
COPY apps/sandbox-controller/ apps/sandbox-controller/
COPY apps/node-runtime/ apps/node-runtime/
COPY apps/pool-supervisor/ apps/pool-supervisor/
COPY packages/native-protocol/ packages/native-protocol/
COPY packages/contracts/native/ packages/contracts/native/
COPY infra/platform/versions.lock.json infra/platform/versions.lock.json
COPY LICENSE /licenses/pgcf/LICENSE
RUN rustc --version | grep -F "rustc ${RUST_VERSION} " \
 && test "${#SOURCE_COMMIT}" -eq 40 \
 && case "$SOURCE_COMMIT" in *[!0-9a-f]*) exit 1;; esac \
 && export PGCF_SOURCE_REVISION="$SOURCE_COMMIT" PGCF_RUST_VERSION="$RUST_VERSION" \
 && export PGCF_CARGO_LOCK_SHA256="$(sha256sum Cargo.lock | cut -d ' ' -f 1)" \
 && export PGCF_VERSIONS_LOCK_SHA256="$(sha256sum infra/platform/versions.lock.json | cut -d ' ' -f 1)" \
 && export PGCF_PROTOCOL_SHA256="$(sha256sum packages/contracts/native/protocol.generated.json | cut -d ' ' -f 1)" \
 && export PGCF_POOL_CONTRACT_SHA256="$(sha256sum packages/contracts/native/postgres-pool.generated.json | cut -d ' ' -f 1)" \
 && cargo build --release --locked -p pgcf-pool-supervisor \
 && cargo metadata --locked --offline --no-deps --format-version 1 > /licenses/workspace-metadata.json \
 && mkdir -p /licenses/provenance \
 && cp Cargo.lock /licenses/provenance/Cargo.lock \
 && cp packages/contracts/native/postgres-pool.generated.json /licenses/provenance/postgres-pool.generated.json \
 && cp packages/contracts/native/protocol.generated.json /licenses/provenance/protocol.generated.json \
 && cp packages/native-protocol/src/constants.generated.rs /licenses/provenance/constants.generated.rs \
 && cp infra/platform/versions.lock.json /licenses/provenance/versions.lock.json \
 && sh apps/native-gateway/license-bundle.sh
FROM scratch
COPY --from=build /workspace/target/release/pgcf-pool-supervisor /pgcf-supervisor
COPY --from=build /licenses /licenses
USER 26:26
ENTRYPOINT ["/pgcf-supervisor"]
