# SPDX-License-Identifier: Apache-2.0
# Build context is the repository root: docker build -f apps/regional/Dockerfile .
# node:24.21.0-slim multi-platform index, resolved with `docker buildx imagetools inspect`.
FROM node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json LICENSE ./
COPY apps/api/package.json apps/api/package.json
COPY apps/edge/package.json apps/edge/package.json
COPY apps/regional/package.json apps/regional/package.json
COPY apps/node-bootstrap/package.json apps/node-bootstrap/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY scripts/e2e/package.json scripts/e2e/package.json
# corepack installs the pnpm version pinned in the packageManager field.
RUN corepack enable && pnpm --version \
 && pnpm install --frozen-lockfile --ignore-scripts --filter @pgcf/regional...
COPY packages/contracts/ packages/contracts/
COPY apps/regional/tsconfig.json apps/regional/tsconfig.json
COPY apps/regional/src apps/regional/src
COPY infra/platform/versions.lock.json infra/platform/versions.lock.json
COPY infra/platform/openebs-image.ts infra/platform/openebs-image.ts
COPY infra/platform/image-manifest.ts infra/platform/image-manifest.ts
RUN pnpm --filter @pgcf/regional build \
 && test -f apps/regional/dist/agent/main.mjs && test -f apps/regional/dist/gateway/main.mjs && test -f apps/regional/dist/bootstrap-relay-main.mjs \
 && mkdir -p /licenses/zod \
 && cp packages/contracts/node_modules/zod/LICENSE /licenses/zod/LICENSE
# The runtime image carries only the external packages (@kubernetes/client-node, ws, pg); the
# workspace contracts are bundled into the entry points, so drop them from the deployed manifest.
RUN node -e "const f='apps/regional/package.json',p=JSON.parse(require('fs').readFileSync(f));delete p.dependencies['@pgcf/contracts'];delete p.devDependencies;require('fs').writeFileSync(f,JSON.stringify(p))" \
 && pnpm --filter @pgcf/regional --prod deploy --legacy /out \
 && cp apps/regional/dist/agent/main.mjs /out/agent.mjs \
 && cp apps/regional/dist/gateway/main.mjs /out/gateway.mjs \
 && cp apps/regional/dist/bootstrap-relay-main.mjs /out/bootstrap-relay.mjs

FROM node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=root:root /out/node_modules ./node_modules
COPY --from=build --chown=root:root /out/package.json /out/agent.mjs /out/gateway.mjs /out/bootstrap-relay.mjs ./
COPY --from=build --chown=root:root /licenses/zod/LICENSE /app/licenses/zod/LICENSE
COPY --from=build --chown=root:root /workspace/LICENSE ./LICENSE
USER node
CMD ["node", "/app/agent.mjs"]
