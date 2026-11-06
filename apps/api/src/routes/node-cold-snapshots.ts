// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  COLD_SNAPSHOT_API_PREFIX,
  COLD_SNAPSHOT_CHUNKS_MAX,
  ColdSnapshotManifest,
  ColdSnapshotSha256,
  ErrorBody,
  OperationId,
} from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { callingNode } from "../domain/node-auth.ts";
import {
  declareColdSnapshot,
  uploadColdSnapshotChunk,
  sealColdSnapshot,
  readColdSnapshotManifest,
  readColdSnapshotChunk,
} from "../domain/cold-snapshots.ts";

const prefix = `${COLD_SNAPSHOT_API_PREFIX}{operation}`;
const operation = z.object({ operation: OperationId });
const chunk = operation.extend({
  index: z.coerce
    .number()
    .int()
    .min(0)
    .max(COLD_SNAPSHOT_CHUNKS_MAX - 1),
});
const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const binary = {
  "application/octet-stream": { schema: z.string().meta({ format: "binary" }) },
};
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 500].map((code) => [
    code,
    { description: "Snapshot refused", content: json(ErrorBody) },
  ]),
);
const common = { tags: ["Node"], security: [{ NodeBearer: [] }] };
const sealBody = z.strictObject({ manifest_sha256: ColdSnapshotSha256 });
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
): void {
  app.openapi(createRoute(route), handler);
}

/** Installed after the common node-auth middleware. Clients choose an operation and chunk index,
 * never an R2 key, URL or filesystem path. The domain rechecks exact node/operation ownership. */
export function registerNodeColdSnapshots(app: ApiApp): void {
  register(
    app,
    {
      ...common,
      method: "put",
      path: `${prefix}/manifest`,
      description:
        "Declares the complete source-produced clean-shutdown snapshot manifest before any chunks are uploaded. Identical retries are idempotent; changed manifests are refused.",
      request: {
        params: operation,
        body: { required: true, content: json(ColdSnapshotManifest) },
      },
      responses: {
        ...errors,
        200: {
          description: "Immutable manifest declared",
          content: json(
            z.object({
              declared: z.literal(true),
              manifest_sha256: ColdSnapshotSha256,
              total_chunks: z.number().int().nonnegative(),
            }),
          ),
        },
      },
    },
    (c) =>
      declareColdSnapshot(
        c.env,
        callingNode(c),
        operation.parse(c.req.param()).operation,
        c.get("body") ?? new Uint8Array(),
      ),
  );
  register(
    app,
    {
      ...common,
      method: "put",
      path: `${prefix}/chunks/{index}`,
      description:
        "Stores one bounded chunk matching the declared size and SHA-256. The node signature covers its exact binary bytes. A retired key cannot be recreated.",
      request: { params: chunk, body: { required: true, content: binary } },
      responses: {
        ...errors,
        200: {
          description: "Immutable chunk stored",
          content: json(
            z.object({
              index: z.number().int().nonnegative(),
              size_bytes: z.number().int().positive(),
              sha256: ColdSnapshotSha256,
            }),
          ),
        },
      },
    },
    (c) => {
      const params = chunk.parse(c.req.param());
      return uploadColdSnapshotChunk(
        c.env,
        callingNode(c),
        params.operation,
        params.index,
        c.get("body") ?? new Uint8Array(),
      );
    },
  );
  register(
    app,
    {
      ...common,
      method: "post",
      path: `${prefix}/seal`,
      description:
        "Checks a bounded part of the complete expected chunk inventory. The snapshot is readable for recovery only after every expected chunk has been verified and sealed.",
      request: {
        params: operation,
        body: { required: true, content: json(sealBody) },
      },
      responses: {
        ...errors,
        200: {
          description: "Seal progress",
          content: json(
            z.object({
              sealed: z.boolean(),
              checked_chunks: z.number().int().nonnegative(),
              total_chunks: z.number().int().positive(),
              manifest_sha256: ColdSnapshotSha256,
            }),
          ),
        },
      },
    },
    async (c) =>
      sealColdSnapshot(
        c.env,
        callingNode(c),
        operation.parse(c.req.param()).operation,
        sealBody.parse(await c.req.json()).manifest_sha256,
      ),
  );
  register(
    app,
    {
      ...common,
      method: "get",
      path: `${prefix}/manifest`,
      request: { params: operation },
      responses: {
        ...errors,
        200: {
          description: "Exact sealed manifest bytes",
          content: json(ColdSnapshotManifest),
        },
      },
    },
    (c) =>
      readColdSnapshotManifest(
        c.env,
        callingNode(c),
        operation.parse(c.req.param()).operation,
      ),
  );
  register(
    app,
    {
      ...common,
      method: "get",
      path: `${prefix}/chunks/{index}`,
      request: { params: chunk },
      responses: {
        ...errors,
        200: { description: "Exact immutable chunk bytes", content: binary },
      },
    },
    (c) => {
      const params = chunk.parse(c.req.param());
      return readColdSnapshotChunk(
        c.env,
        callingNode(c),
        params.operation,
        params.index,
      );
    },
  );
}
