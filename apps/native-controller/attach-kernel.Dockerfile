# SPDX-License-Identifier: Apache-2.0
# Isolated kernel test environment for the node attach agent only; not a published image.
# Supply the immutable compiler image and Rust version from infra/platform/versions.lock.json.
ARG RUST_BUILDER
FROM ${RUST_BUILDER} AS test
ARG RUST_VERSION
WORKDIR /workspace
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY apps/edge-rust/ apps/edge-rust/
COPY apps/native-bootstrap-relay/ apps/native-bootstrap-relay/
COPY apps/native-controller/ apps/native-controller/
COPY apps/native-gateway/ apps/native-gateway/
COPY apps/sandbox-controller/ apps/sandbox-controller/
COPY apps/node-runtime/ apps/node-runtime/
COPY packages/native-protocol/ packages/native-protocol/
COPY packages/contracts/native/ packages/contracts/native/
RUN rustc --version | grep -F "rustc ${RUST_VERSION} " \
 && cargo test --no-run --locked -p pgcf-native-controller --bin pgcf-attach \
 && find target/debug/deps -maxdepth 1 -type f -name 'pgcf_attach-*' -perm -111 \
    -exec cp '{}' /usr/local/bin/pgcf-attach-kernel-test ';' \
 && test -x /usr/local/bin/pgcf-attach-kernel-test \
 && mkdir -p /var/lib/postgresql/data
ENTRYPOINT ["/usr/local/bin/pgcf-attach-kernel-test"]
CMD ["--ignored", "--test-threads=1"]
