# SPDX-License-Identifier: Apache-2.0
# Local/CI inspection fixture only. Never published or installed on fleet nodes.
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS node
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      qemu-system-x86=1:10.0.13+ds-0+deb13u1 squashfs-tools=1:4.6.1-1+b1 \
      util-linux=2.41.5-0+deb13u1 xz-utils=5.8.1-1+deb13u2 \
      libstdc++6=14.2.0-19 libatomic1=14.2.0-19 ca-certificates=20250419 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ARG TALOS_ASSET
ARG TALOS_SHA256
ADD --checksum=sha256:${TALOS_SHA256} ${TALOS_ASSET} /usr/local/bin/talosctl
RUN chmod 755 /usr/local/bin/talosctl
COPY boot-inspect-worker.ts /tools/boot-inspect-worker.ts
ENTRYPOINT ["node", "/tools/boot-inspect-worker.ts"]
