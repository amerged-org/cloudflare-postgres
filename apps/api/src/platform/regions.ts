// SPDX-License-Identifier: Apache-2.0
import {
  hashApiKey,
  newAgentKey,
  type RegionCreate,
  type RegionRouteKeyring,
} from "@pgcf/contracts";
import {
  deriveRegionKeyring,
  parseRouteKeyring,
  serializeRouteKeyring,
} from "@pgcf/contracts/route-token";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import {
  refuseCredentialReplay,
  withIdempotency,
} from "../middleware/idempotency.ts";
import { page } from "./pagination.ts";
import { nodeRow, regionRow, type Row } from "./rows.ts";

export async function createRegion(
  c: ApiContext,
  body: RegionCreate,
): Promise<Response> {
  await requireScope(c, "admin");
  return withIdempotency(c, {
    replay: async () => refuseCredentialReplay(),
    execute: async (lease) => {
      const agentKey = newAgentKey(body.id);
      const routeKeyring = JSON.parse(
        serializeRouteKeyring(
          await deriveRegionKeyring(
            parseRouteKeyring(c.env.ROUTE_MASTER_KEYS),
            body.id,
          ),
        ),
      ) as RegionRouteKeyring;
      const now = new Date().toISOString();
      try {
        await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO regions
            (id, provider, provider_region, gateway_url, gateway_binding, backup_bucket, backup_endpoint_url,
             agent_key_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            body.id,
            body.provider,
            body.provider_region,
            body.gateway_url,
            body.gateway_binding ?? null,
            body.backup_bucket,
            body.backup_endpoint_url,
            await hashApiKey(c.env.API_KEY_PEPPER, agentKey),
            now,
            now,
          ),
          lease.completeStatement(body.id, 201),
        ]);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("UNIQUE constraint failed: regions.id")
        )
          throw new ApiError("conflict", "Region already exists");
        throw error;
      }
      c.header("Location", `/v1/regions/${body.id}`);
      return c.json(
        {
          region: {
            ...body,
            gateway_binding: body.gateway_binding ?? null,
            agent_last_seen_at: null,
            created_at: now,
            updated_at: now,
          },
          agent_key: agentKey,
          route_keyring: routeKeyring,
        },
        201,
      );
    },
  });
}
export async function listRegions(c: ApiContext): Promise<Response> {
  await requireScope(c, "admin");
  const pagination = page(c);
  const cursor = pagination.where();
  const rows = await c.env.DB.prepare(
    `SELECT * FROM regions WHERE ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...cursor.bindings, pagination.limit + 1)
    .all<Row>();
  return c.json(pagination.envelope(rows.results.map(regionRow)), 200);
}
export async function listNodes(c: ApiContext): Promise<Response> {
  await requireScope(c, "admin");
  const pagination = page(c);
  const cursor = pagination.where();
  const rows = await c.env.DB.prepare(
    `SELECT * FROM nodes WHERE ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...cursor.bindings, pagination.limit + 1)
    .all<Row>();
  return c.json(pagination.envelope(rows.results.map(nodeRow)), 200);
}
