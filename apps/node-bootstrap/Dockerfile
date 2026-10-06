# SPDX-License-Identifier: Apache-2.0
# Build context is the repository root. Native clients are checked against official release checksums.
FROM node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json LICENSE ./
COPY apps/api/package.json apps/api/package.json
COPY apps/edge/package.json apps/edge/package.json
COPY apps/regional/package.json apps/regional/package.json
COPY apps/node-bootstrap/package.json apps/node-bootstrap/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY scripts/e2e/package.json scripts/e2e/package.json
RUN corepack enable && pnpm --version \
 && pnpm install --frozen-lockfile --ignore-scripts --filter @pgcf/node-bootstrap...
COPY packages/contracts/ packages/contracts/
COPY apps/node-bootstrap/tsconfig.json apps/node-bootstrap/tsconfig.json
COPY apps/node-bootstrap/src apps/node-bootstrap/src
COPY infra/talos/publish-storage-capacity.ts infra/talos/publish-storage-capacity.ts
COPY scripts/e2e/src/node-network-native.ts scripts/e2e/src/node-network-native.ts
COPY scripts/e2e/src/node-network-packets.ts scripts/e2e/src/node-network-packets.ts
RUN pnpm --filter @pgcf/node-bootstrap build \
 && test -f apps/node-bootstrap/dist/server.mjs && test -f apps/node-bootstrap/dist/proxy-command.mjs && test -f apps/node-bootstrap/dist/inspection-proxy-command.mjs && test -f apps/node-bootstrap/dist/outside-scan-command.mjs && test -f apps/node-bootstrap/dist/proof-proxy-command.mjs \
 && mkdir -p /licenses/zod /licenses/yaml \
 && cp apps/node-bootstrap/node_modules/zod/LICENSE /licenses/zod/LICENSE \
 && cp apps/node-bootstrap/node_modules/yaml/LICENSE /licenses/yaml/LICENSE
RUN node -e "const f='apps/node-bootstrap/package.json',p=JSON.parse(require('fs').readFileSync(f));delete p.dependencies['@pgcf/contracts'];delete p.dependencies.yaml;delete p.dependencies.zod;delete p.devDependencies;require('fs').writeFileSync(f,JSON.stringify(p))" \
 && pnpm --filter @pgcf/node-bootstrap --prod deploy --legacy /out \
 && cp apps/node-bootstrap/dist/server.mjs apps/node-bootstrap/dist/proxy-command.mjs apps/node-bootstrap/dist/inspection-proxy-command.mjs apps/node-bootstrap/dist/outside-scan-command.mjs apps/node-bootstrap/dist/proof-proxy-command.mjs /out/

FROM node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS clients
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates=20250419~deb12u1 curl=7.88.1-10+deb12u15 \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
 case "$TARGETARCH" in \
 amd64) talos_sum=7233ece94c94296a033a6ddb5efe0baf508a94c71de7e6c7b286500705924208 ;; \
 arm64) talos_sum=812406cfc3bd83a937108d5f4872a48645b96de3c01e1f3d82445e8cbd1e7a21 ;; \
 *) exit 1 ;; esac; \
 curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 480 --output /talosctl "https://github.com/siderolabs/talos/releases/download/v1.14.1/talosctl-linux-$TARGETARCH"; \
 printf '%s  /talosctl\n' "$talos_sum" | sha256sum --check --status; chmod 755 /talosctl
RUN set -eu; \
 case "$TARGETARCH" in \
 amd64) kube_sum=33bc88a24c3b09cf55bfd59e6ca977881b61fc3f25ab65bc80c65b430248648e ;; \
 arm64) kube_sum=88fc1aca8fd0c1b44fe379f67c39bd6858bdfc50241dc55775f84d0f5b31da3a ;; \
 *) exit 1 ;; esac; \
 curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 480 --output /kubectl "https://dl.k8s.io/release/v1.36.5/bin/linux/$TARGETARCH/kubectl"; \
 printf '%s  /kubectl\n' "$kube_sum" | sha256sum --check --status; \
 chmod 755 /kubectl
RUN set -eu; \
 case "$TARGETARCH" in \
 amd64) helm_sum=86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb ;; \
 arm64) helm_sum=31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08 ;; \
 *) exit 1 ;; esac; \
 curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 480 --output /helm.tgz "https://get.helm.sh/helm-v4.3.0-linux-$TARGETARCH.tar.gz"; \
 printf '%s  /helm.tgz\n' "$helm_sum" | sha256sum --check --status; \
 tar --extract --gzip --file=/helm.tgz --directory=/ "linux-$TARGETARCH/helm"; \
 mv "/linux-$TARGETARCH/helm" /helm; chmod 755 /helm; rm /helm.tgz
COPY apps/node-bootstrap/src/build-assets.ts apps/node-bootstrap/src/platform-artifacts.ts /bootstrap-assets/
COPY infra/platform/base/values/cilium.yaml /assets/cilium-values.yaml
RUN node /bootstrap-assets/build-assets.ts /assets

FROM node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates=20250419~deb12u1 openssh-client=1:9.2p1-2+deb12u10 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=clients --chown=root:root /talosctl /kubectl /helm /usr/local/bin/
COPY --from=clients --chown=root:root /assets /app/assets
COPY --from=build --chown=root:root /out/node_modules ./node_modules
COPY --from=build --chown=root:root /out/package.json /out/server.mjs /out/proxy-command.mjs /out/inspection-proxy-command.mjs /out/outside-scan-command.mjs /out/proof-proxy-command.mjs ./
COPY --from=build --chown=root:root /licenses /app/licenses
COPY --chown=root:root apps/node-bootstrap/assets/talos.LICENSE /app/licenses/talos/LICENSE
COPY --chown=root:root apps/node-bootstrap/assets/kubernetes.LICENSE /app/licenses/kubernetes/LICENSE
COPY --chown=root:root apps/node-bootstrap/assets/helm.LICENSE /app/licenses/helm/LICENSE
COPY --chown=root:root apps/node-bootstrap/assets/flux.LICENSE /app/licenses/flux/LICENSE
COPY --chown=root:root apps/node-bootstrap/assets/cilium.LICENSE /app/licenses/cilium/LICENSE
COPY --from=build --chown=root:root /workspace/LICENSE ./LICENSE
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
