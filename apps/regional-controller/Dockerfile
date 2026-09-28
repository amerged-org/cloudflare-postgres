# SPDX-License-Identifier: Apache-2.0
# Official Node 24 LTS multi-platform index, verified 2026-09-28.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.24.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY LICENSE ./LICENSE
COPY apps/control-api/package.json apps/control-api/package.json
COPY apps/regional-controller/package.json apps/regional-controller/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/regional-controller/tsconfig.json apps/regional-controller/tsconfig.json
COPY apps/regional-controller/src apps/regional-controller/src
RUN pnpm --filter @cloudflare-postgres/regional-controller build
RUN pnpm --filter @cloudflare-postgres/regional-controller --prod deploy --legacy /out

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /workspace/LICENSE ./LICENSE
USER node
CMD ["node", "dist/main.js"]
