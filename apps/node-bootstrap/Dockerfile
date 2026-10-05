# SPDX-License-Identifier: Apache-2.0
# Build context is the repository root. Native clients are checked against official release checksums.
FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
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
RUN pnpm --filter @pgcf/node-bootstrap build \
 && test -f apps/node-bootstrap/dist/server.mjs && test -f apps/node-bootstrap/dist/proxy-command.mjs \
 && mkdir -p /licenses/zod /licenses/yaml \
 && cp apps/node-bootstrap/node_modules/zod/LICENSE /licenses/zod/LICENSE \
 && cp apps/node-bootstrap/node_modules/yaml/LICENSE /licenses/yaml/LICENSE
RUN node -e "const f='apps/node-bootstrap/package.json',p=JSON.parse(require('fs').readFileSync(f));delete p.dependencies['@pgcf/contracts'];delete p.dependencies.yaml;delete p.dependencies.zod;delete p.devDependencies;require('fs').writeFileSync(f,JSON.stringify(p))" \
 && pnpm --filter @pgcf/node-bootstrap --prod deploy --legacy /out \
 && cp apps/node-bootstrap/dist/server.mjs apps/node-bootstrap/dist/proxy-command.mjs /out/

FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS clients
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
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
 amd64) kube_sum=ebbd080e7c2e275093b55915722043257eb24004363e20acb3c4d71919f88336 ;; \
 arm64) kube_sum=3d86f24401c41ae5a46ac50eef8865fe891d3647d324a0836f6c63757a126e62 ;; \
 *) exit 1 ;; esac; \
 curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 480 --output /kubectl "https://dl.k8s.io/release/v1.36.3/bin/linux/$TARGETARCH/kubectl"; \
 printf '%s  /kubectl\n' "$kube_sum" | sha256sum --check --status; \
 chmod 755 /kubectl

FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=clients --chown=root:root /talosctl /kubectl /usr/local/bin/
COPY --from=build --chown=root:root /out/node_modules ./node_modules
COPY --from=build --chown=root:root /out/package.json /out/server.mjs /out/proxy-command.mjs ./
COPY --from=build --chown=root:root /licenses /app/licenses
COPY --chown=root:root apps/node-bootstrap/assets/talos.LICENSE /app/licenses/talos/LICENSE
COPY --chown=root:root apps/node-bootstrap/assets/kubernetes.LICENSE /app/licenses/kubernetes/LICENSE
COPY --from=build --chown=root:root /workspace/LICENSE ./LICENSE
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
