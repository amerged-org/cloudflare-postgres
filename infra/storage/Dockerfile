# SPDX-License-Identifier: Apache-2.0
# Preserve the official driver and LVM; install its missing checked thin-metadata tools.
FROM docker.io/openebs/lvm-driver@sha256:41f73aba7f31eee4a033053d9c2f203e007a838c14823f3fd472c50651a98999

ADD --checksum=sha256:88d98bb7034823d5184d873e8eef05ae6ec9a9880fdcd6c1bbc12e1484fdd829 https://dl-cdn.alpinelinux.org/alpine/v3.22/community/x86_64/thin-provisioning-tools-1.1.0-r0.apk /tmp/thin-provisioning-tools.apk
ADD --checksum=sha256:fef778119046e6057aabcc087685aafefe62eb3a65febba639482e72c85a59ed https://distfiles.alpinelinux.org/distfiles/v3.22/thin-provisioning-tools-1.1.0.tar.gz /usr/share/pgcf/thin-provisioning-tools-1.1.0.tar.gz
COPY sources.lock.json /usr/share/pgcf/storage-sources.lock.json

RUN set -eu; \
    test "$(stat -c %s /tmp/thin-provisioning-tools.apk)" = 919148; \
    apk info -v --installed > /tmp/packages-before; \
    apk add --no-network --no-cache --repositories-file /dev/null /tmp/thin-provisioning-tools.apk; \
    apk info -v --installed | sed '/^thin-provisioning-tools-1.1.0-r0$/d' > /tmp/packages-after; \
    cmp /tmp/packages-before /tmp/packages-after; \
    printf '%s  %s\n' 50a9ede8031deae0adf2431f960c0979b305b54dc7950b170a54cc4613d4fdb1 /usr/local/bin/lvm-driver fdc5aa9706d9982553ff4ee8497e4236dbfba4e790a8b81883789739e0176546 /sbin/lvm 940fee125b98d0381c4084d791d1975e99758f774869f145543636eacecd796d /usr/sbin/pdata_tools | sha256sum -c -; \
    chmod 0644 /usr/share/pgcf/thin-provisioning-tools-1.1.0.tar.gz; \
    mkdir -p /usr/share/licenses/pgcf-thin-tools; \
    tar -xOf /usr/share/pgcf/thin-provisioning-tools-1.1.0.tar.gz thin-provisioning-tools-1.1.0/COPYING > /usr/share/licenses/pgcf-thin-tools/COPYING; \
    printf '%s  %s\n' 3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986 /usr/share/licenses/pgcf-thin-tools/COPYING | sha256sum -c -; \
    thin_check --version; thin_repair --version; \
    rm /tmp/thin-provisioning-tools.apk /tmp/packages-before /tmp/packages-after

LABEL org.opencontainers.image.source="https://github.com/amerged-org/cloudflare-postgres" \
      org.opencontainers.image.title="PGCF OpenEBS LVM with checked thin tools" \
      org.opencontainers.image.licenses="Apache-2.0 AND GPL-3.0-only"
