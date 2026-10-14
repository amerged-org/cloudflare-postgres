# SPDX-License-Identifier: Apache-2.0
FROM docker.io/library/golang:1.27.2-alpine3.24@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS driver-build
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 GOMAXPROCS=2
ADD --checksum=sha256:f571ef645592fe5f82936ddfb609d755d83fea2d5c57fb04f61a83b4f84ebff4 https://codeload.github.com/openebs/lvm-localpv/tar.gz/e8a234cbfeef5fa16fde1330c8de2d91e31831f1 /upstream.tar.gz
ADD --checksum=sha256:723c061ea3e2c3e61b457f8f614f0b87724aeae37564ba4c1bdd41c722118187 https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/patch-2.8-r0.apk /patch-tool.apk
WORKDIR /src
COPY exporter-metadata.patch /exporter-metadata.patch
RUN --network=none set -eu; \
    printf '%s  %s\n' 723c061ea3e2c3e61b457f8f614f0b87724aeae37564ba4c1bdd41c722118187 /patch-tool.apk | sha256sum -c -; \
    test "$(stat -c %s /patch-tool.apk)" = 69750; \
    apk add --no-network --no-cache --repositories-file /dev/null /patch-tool.apk; \
    printf '%s  %s\n' f571ef645592fe5f82936ddfb609d755d83fea2d5c57fb04f61a83b4f84ebff4 /upstream.tar.gz f88f388bba5b66a41ba5e51b8eea2ca35574a8f90db8802031c0279bd29cf82c /exporter-metadata.patch | sha256sum -c -; \
    test "$(stat -c %s /upstream.tar.gz)" = 421865; \
    tar -xzf /upstream.tar.gz --strip-components=1 --exclude='*/result'; \
    patch -p1 < /exporter-metadata.patch
RUN --network=default --mount=type=cache,target=/go/pkg/mod \
    go mod download && go mod verify && go mod vendor
RUN --network=none --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    set -eu; \
    go test -mod=vendor -count=1 ./pkg/lvm ./pkg/collector ./pkg/volumegate; \
    go test -mod=vendor -count=1 ./pkg/driver -run '^TestPoolDenialPrecedesEveryPublishAndExpansionPath$'; \
    go test -mod=vendor -run '^$' ./pkg/mgmt/volume ./pkg/mgmt/snapshot; \
    mkdir -p /out/licenses; \
    go build -mod=vendor -trimpath -buildvcs=false -ldflags='-s -w -buildid= -X github.com/openebs/lvm-localpv/pkg/version.Version=1.10.1 -X github.com/openebs/lvm-localpv/pkg/version.GitCommit=e8a234cbfeef5fa16fde1330c8de2d91e31831f1' -o /out/lvm-driver ./cmd; \
    find vendor -type f \( -iname '*license*' -o -iname '*notice*' -o -iname '*copying*' -o -iname '*copyright*' \) -exec sh -c 'for file do relative="${file#vendor/}"; mkdir -p "/out/licenses/${relative%/*}"; cp "$file" "/out/licenses/$relative"; done' sh {} +

# Preserve upstream LVM/runtime; install the rebuilt metadata/CSI gate driver and thin tools.
FROM docker.io/openebs/lvm-driver@sha256:41f73aba7f31eee4a033053d9c2f203e007a838c14823f3fd472c50651a98999

ADD --checksum=sha256:88d98bb7034823d5184d873e8eef05ae6ec9a9880fdcd6c1bbc12e1484fdd829 https://dl-cdn.alpinelinux.org/alpine/v3.22/community/x86_64/thin-provisioning-tools-1.1.0-r0.apk /tmp/thin-provisioning-tools.apk
ADD --checksum=sha256:fef778119046e6057aabcc087685aafefe62eb3a65febba639482e72c85a59ed https://distfiles.alpinelinux.org/distfiles/v3.22/thin-provisioning-tools-1.1.0.tar.gz /usr/share/pgcf/thin-provisioning-tools-1.1.0.tar.gz
COPY sources.lock.json /usr/share/pgcf/storage-sources.lock.json

RUN --network=none set -eu; \
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

COPY --from=driver-build /out/lvm-driver /usr/local/bin/lvm-driver
COPY --from=driver-build /upstream.tar.gz /usr/share/pgcf/lvm-localpv-e8a234cbfeef5fa16fde1330c8de2d91e31831f1.tar.gz
COPY exporter-metadata.patch /usr/share/pgcf/lvm-localpv-exporter.patch
COPY --from=driver-build /src/LICENSE /usr/share/licenses/pgcf-lvm-localpv/LICENSE
COPY NOTICE /usr/share/licenses/pgcf-lvm-localpv/NOTICE
COPY --from=driver-build /usr/local/go/LICENSE /usr/share/licenses/pgcf-lvm-localpv/Go-LICENSE
COPY --from=driver-build /out/licenses/ /usr/share/licenses/pgcf-lvm-localpv/dependencies/
RUN --network=none set -eu; \
    chmod 0644 /usr/share/pgcf/lvm-localpv-e8a234cbfeef5fa16fde1330c8de2d91e31831f1.tar.gz; \
    printf '%s  %s\n' a40d565e57266594e1602e1a9388327c170bd20979cdb3a78e979afd043594ba /usr/local/bin/lvm-driver f571ef645592fe5f82936ddfb609d755d83fea2d5c57fb04f61a83b4f84ebff4 /usr/share/pgcf/lvm-localpv-e8a234cbfeef5fa16fde1330c8de2d91e31831f1.tar.gz f88f388bba5b66a41ba5e51b8eea2ca35574a8f90db8802031c0279bd29cf82c /usr/share/pgcf/lvm-localpv-exporter.patch c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 /usr/share/licenses/pgcf-lvm-localpv/LICENSE adecbdfb771dd9de099f05da63db1558b93aa0f21451e4f6dfa6c3f6f7582fd9 /usr/share/licenses/pgcf-lvm-localpv/NOTICE 911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad /usr/share/licenses/pgcf-lvm-localpv/Go-LICENSE | sha256sum -c -; \
    test "$(stat -c %s /usr/local/bin/lvm-driver)" = 54956156; \
    test "$(stat -c %s /usr/share/pgcf/lvm-localpv-e8a234cbfeef5fa16fde1330c8de2d91e31831f1.tar.gz)" = 421865; \
    find /usr/share/licenses/pgcf-lvm-localpv/dependencies -type f > /tmp/dependency-notices; \
    test "$(wc -l < /tmp/dependency-notices)" = 108; \
    rm /tmp/dependency-notices

LABEL org.opencontainers.image.source="https://github.com/amerged-org/cloudflare-postgres" \
      org.opencontainers.image.title="PGCF OpenEBS LVM with checked thin tools" \
      org.opencontainers.image.licenses="Apache-2.0 AND BSD-3-Clause AND GPL-3.0-only"
