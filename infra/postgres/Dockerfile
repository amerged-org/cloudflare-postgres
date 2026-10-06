# SPDX-License-Identifier: Apache-2.0
# The upstream PostgreSQL engine is unchanged. Only pgvector and unused snakeoil files change.
FROM ghcr.io/cloudnative-pg/postgresql:18.6-standard-trixie@sha256:79be0d10e78b7ac4520cf6c5db199a8bb7f6de53b3229f47e90cab5865528a0d AS postgres

USER root

ADD --checksum=sha256:d9923b9ea81375604d88bfcfa167d58bfaf3de5689372c9e4504244f1671f596 https://apt.postgresql.org/pub/repos/apt/pool/main/p/pgvector/postgresql-18-pgvector_0.8.7-1.pgdg13+1_amd64.deb /tmp/pgvector.deb
COPY sources.lock.json /usr/share/pgcf/postgres-sources.lock.json

RUN set -eu; \
    test "$(dpkg --print-architecture)" = amd64; \
    test "$(stat --format=%s /tmp/pgvector.deb)" = 274800; \
    test "$(dpkg-deb --field /tmp/pgvector.deb Package)" = postgresql-18-pgvector; \
    test "$(dpkg-deb --field /tmp/pgvector.deb Version)" = 0.8.7-1.pgdg13+1; \
    test "$(stat --format=%s /usr/lib/postgresql/18/bin/postgres)" = 10549848; \
    printf '%s  %s\n' 4944085dba4adcf0f65b8fb4e698c5ac353ecff890fdc89afe8007c2547b1469 /usr/lib/postgresql/18/bin/postgres | sha256sum --check --status; \
    sha256sum /usr/lib/postgresql/18/bin/postgres > /usr/share/pgcf/postgres-engine.sha256; \
    dpkg-query --show --showformat='${Package}=${Version}\n' > /tmp/packages-before; \
    dpkg --install /tmp/pgvector.deb; \
    test "$(dpkg-query --show --showformat='${Version}' postgresql-18-pgvector)" = 0.8.7-1.pgdg13+1; \
    dpkg-query --show --showformat='${Package}=${Version}\n' > /tmp/packages-after; \
    sed '/^postgresql-18-pgvector=/d' /tmp/packages-before > /tmp/packages-before-other; \
    sed '/^postgresql-18-pgvector=/d' /tmp/packages-after > /tmp/packages-after-other; \
    cmp /tmp/packages-before-other /tmp/packages-after-other; \
    sha256sum --check --status /usr/share/pgcf/postgres-engine.sha256; \
    test "$(dpkg-query --show --showformat='${Version}' postgresql-18)" = 18.6-1.pgdg13+2; \
    grep --quiet "default_version = '0.8.7'" /usr/share/postgresql/18/extension/vector.control; \
    rm /tmp/pgvector.deb /tmp/packages-before /tmp/packages-after /tmp/packages-before-other /tmp/packages-after-other; \
    rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem

# Snapshot the patched filesystem; the published image must not inherit an earlier key-bearing layer.
FROM scratch
COPY --from=postgres / /

# Exact effective runtime configuration from the verified official linux/amd64 image config.
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/18/bin"
USER 26
CMD ["bash"]

LABEL org.opencontainers.image.source="https://github.com/amerged-org/cloudflare-postgres" \
      org.opencontainers.image.title="PGCF PostgreSQL 18.6 with pgvector 0.8.7" \
      org.opencontainers.image.description="Unmodified CloudNativePG PostgreSQL 18.6 engine with the checksum-pinned upstream pgvector 0.8.7 package" \
      org.opencontainers.image.licenses="Apache-2.0 AND PostgreSQL"
