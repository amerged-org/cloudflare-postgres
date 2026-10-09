# SPDX-License-Identifier: Apache-2.0
# Isolated test environment only; this is not a published production runtime image.
# Supply the immutable compiler image from infra/platform/versions.lock.json.
ARG RUST_BUILDER
FROM ${RUST_BUILDER} AS test
ARG RUST_VERSION
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
COPY LICENSE /licenses/pgcf/LICENSE
RUN rustc --version | grep -F "rustc ${RUST_VERSION} " \
 && cargo fmt --all -- --check \
 && cargo test --workspace --locked \
 && cargo clippy --workspace --all-targets --locked -- -D warnings \
 && cargo build --workspace --release --locked \
 && find target/debug/deps -maxdepth 1 -type f -name 'kernel_assignment-*' -perm -111 \
    -exec cp '{}' /usr/local/bin/pgcf-slot-kernel-test ';' \
 && test -x /usr/local/bin/pgcf-slot-kernel-test
ENTRYPOINT ["/usr/local/bin/pgcf-slot-kernel-test"]
CMD ["--ignored", "--test-threads=1", "--nocapture"]
