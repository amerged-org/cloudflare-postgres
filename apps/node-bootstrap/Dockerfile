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
COPY infra/talos/sandbox/runtime-admission.ts infra/talos/sandbox/runtime-admission.ts
COPY infra/platform/versions.lock.json infra/platform/versions.lock.json
COPY infra/platform/openebs-image.ts infra/platform/openebs-image.ts
COPY infra/platform/image-manifest.ts infra/platform/image-manifest.ts
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
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates=20250419~deb12u1 \
 && rm -rf /var/lib/apt/lists/*
COPY apps/node-bootstrap/src/build-assets.ts apps/node-bootstrap/src/platform-artifacts.ts /workspace/apps/node-bootstrap/src/
COPY infra/platform/versions.lock.json /workspace/infra/platform/versions.lock.json
COPY infra/platform/openebs-image.ts /workspace/infra/platform/openebs-image.ts
COPY infra/platform/image-manifest.ts /workspace/infra/platform/image-manifest.ts
COPY infra/talos/sandbox/runtime-admission.ts /workspace/infra/talos/sandbox/runtime-admission.ts
RUN node /workspace/apps/node-bootstrap/src/build-assets.ts --clients / "$TARGETARCH"
COPY infra/platform/base/values/cilium.yaml /assets/cilium-values.yaml
RUN node /workspace/apps/node-bootstrap/src/build-assets.ts /assets

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
