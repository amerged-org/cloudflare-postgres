# SPDX-License-Identifier: Apache-2.0
# Disposable CI fixture, never a distributed runtime or node image.
ARG RUST_BUILDER
ARG POSTGRES_FIXTURE
FROM --platform=linux/amd64 ${POSTGRES_FIXTURE} AS postgres
FROM ${RUST_BUILDER} AS build
ARG RUST_VERSION
ARG POSTGRES_FIXTURE
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
RUN rustc --version | grep -F "rustc ${RUST_VERSION} " \
 && cargo build --release --locked -p pgcf-node-runtime \
 && PGCF_POSTGRES_FIXTURE_IMAGE="$POSTGRES_FIXTURE" cargo build --release --locked -p pgcf-sandbox-controller --example containerd-proof
FROM ${RUST_BUILDER} AS proof
ARG CONTAINERD_ASSET
ARG CONTAINERD_SHA256
ARG RUNC_ASSET
ARG RUNC_SHA256
RUN apk add --no-cache iproute2=7.0.0-r0 busybox-static=1.37.0-r31
ADD --checksum=sha256:${CONTAINERD_SHA256} ${CONTAINERD_ASSET} /tmp/containerd.tar.gz
ADD --checksum=sha256:${RUNC_SHA256} ${RUNC_ASSET} /usr/local/bin/runc
RUN tar xzf /tmp/containerd.tar.gz -C /usr/local && chmod 755 /usr/local/bin/runc && rm /tmp/containerd.tar.gz
COPY --from=build /workspace/target/release/pgcf-node-runtime /usr/local/bin/pgcf-node-runtime
COPY --from=build /workspace/target/release/examples/containerd-proof /usr/local/bin/pgcf-containerd-proof
COPY --from=postgres / /fixtures/postgres/
ENTRYPOINT ["/usr/local/bin/pgcf-containerd-proof"]
