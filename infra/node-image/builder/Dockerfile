# SPDX-License-Identifier: Apache-2.0
# Image builder: Debian trixie tools from the locked snapshot and mkosi at its locked commit.
# node-image.ts passes every argument from packages.lock.json; nothing here floats.
# The builder runs natively (amd64 in CI, arm64 on Apple silicon); mkosi then builds the x86-64
# image as a cross-architecture build through binfmt. GRUB's BIOS and EFI tools exist only as
# amd64 packages, so an arm64 builder takes them from amd64 (grub-common is Multi-Arch: foreign).
ARG PGCF_BUILDER_BASE
FROM ${PGCF_BUILDER_BASE}

ARG PGCF_DEBIAN_SNAPSHOT
ARG PGCF_MKOSI_REPOSITORY
ARG PGCF_MKOSI_COMMIT
ARG PGCF_CA_CERTIFICATES_SHA256

COPY --chmod=0600 bootstrap-ca-certificates.deb /tmp/bootstrap-ca-certificates.deb

COPY --chmod=0755 cache-packages.sh /usr/local/bin/pgcf-cache-builder-packages

RUN set -eu; \
    test -n "$PGCF_DEBIAN_SNAPSHOT"; \
    test -n "$PGCF_MKOSI_REPOSITORY"; \
    test -n "$PGCF_MKOSI_COMMIT"; \
    test -n "$PGCF_CA_CERTIFICATES_SHA256"; \
    test "$(sha256sum /tmp/bootstrap-ca-certificates.deb | cut -d ' ' -f 1)" = "$PGCF_CA_CERTIFICATES_SHA256"; \
    mkdir -m 0700 /tmp/pgcf-bootstrap-ca; \
    dpkg-deb --extract /tmp/bootstrap-ca-certificates.deb /tmp/pgcf-bootstrap-ca; \
    mkdir -p /etc/ssl/certs; \
    cat /tmp/pgcf-bootstrap-ca/usr/share/ca-certificates/mozilla/*.crt > /etc/ssl/certs/ca-certificates.crt; \
    chmod 0644 /etc/ssl/certs/ca-certificates.crt; \
    test -s /etc/ssl/certs/ca-certificates.crt; \
    rm -rf /tmp/pgcf-bootstrap-ca /tmp/bootstrap-ca-certificates.deb; \
    rm -f /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; \
    printf '%s\n' \
      'Types: deb' \
      "URIs: https://snapshot.debian.org/archive/debian/$PGCF_DEBIAN_SNAPSHOT" \
      'Suites: trixie trixie-updates' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      'Check-Valid-Until: no' \
      '' \
      'Types: deb' \
      "URIs: https://snapshot.debian.org/archive/debian-security/$PGCF_DEBIAN_SNAPSHOT" \
      'Suites: trixie-security' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      'Check-Valid-Until: no' \
      > /etc/apt/sources.list.d/snapshot.sources; \
    grub='grub-efi-amd64-bin grub-pc-bin'; \
    if [ "$(dpkg --print-architecture)" != amd64 ]; then \
      dpkg --add-architecture amd64; \
      grub='grub-efi-amd64-bin:amd64 grub-pc-bin:amd64'; \
    fi; \
    apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=3 update; \
    set -- apt-utils ca-certificates cpio curl dosfstools e2fsprogs git \
      grub-common $grub kmod mtools python3 \
      systemd systemd-repart zstd; \
    apt-get -o Acquire::ForceHash=SHA256 --print-uris --yes --no-install-recommends install "$@" > /tmp/pgcf-builder-packages; \
    /usr/local/bin/pgcf-cache-builder-packages "$PGCF_DEBIAN_SNAPSHOT" /tmp/pgcf-builder-packages /var/cache/apt/archives; \
    apt-get install --yes --no-install-recommends "$@"; \
    rm -f /tmp/pgcf-builder-packages; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    git init --quiet /opt/mkosi; \
    git -C /opt/mkosi fetch --quiet --depth 1 "$PGCF_MKOSI_REPOSITORY" "$PGCF_MKOSI_COMMIT"; \
    git -C /opt/mkosi checkout --quiet FETCH_HEAD; \
    test "$(git -C /opt/mkosi rev-parse HEAD)" = "$PGCF_MKOSI_COMMIT"; \
    ln -s /opt/mkosi/bin/mkosi /usr/local/bin/mkosi; \
    mkosi --version

COPY --chmod=0755 build.sh /usr/local/bin/pgcf-node-image-build
ENTRYPOINT ["/usr/local/bin/pgcf-node-image-build"]
