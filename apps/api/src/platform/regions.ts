// SPDX-License-Identifier: Apache-2.0
import {
  PlacementRegion,
  type RegionCreate,
  bytesToHex,
  RegionGatewayConfiguration,
  type RegionConfigurationUpdate,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import { withAdmissionMutation } from "../domain/admission-mutations.ts";
import type { ApiContext } from "../env.ts";
import { getAuth, requireAdminRead, requireScope } from "../middleware/auth.ts";
import { regionAcceptsPlacementSql } from "../domain/placement.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { page } from "./pagination.ts";
import { nodeInventoryRow, regionRow, type Row } from "./rows.ts";
import { readFleetNodeReleaseInventories } from "../domain/fleet-releases.ts";

/** A region as the API shows it: the newest link message of its nodes is the agent's last sighting. */
const regionSelect = `SELECT r.*,(SELECT MAX(n.last_observed_at) FROM nodes n WHERE n.region_id=r.id) agent_last_seen_at FROM regions r WHERE r.id=?`;

export async function createRegion(
  c: ApiContext,
  body: RegionCreate,
): Promise<Response> {
  await requireScope(c, "admin");
  if (
    !RegionGatewayConfiguration.safeParse({
      gateway_url: body.gateway_url,
      gateway_binding: body.gateway_binding ?? null,
    }).success
  )
    throw new ApiError(
      "invalid_request",
      "Gateway URL must use /pg without credentials, query or fragment; public gateways require HTTPS",
    );
  return withIdempotency(c, {
    replay: async (id) => {
      const row = await c.env.DB.prepare(regionSelect).bind(id).first<Row>();
      if (!row) throw new ApiError("not_found", "Region not found");
      c.header("Location", `/v1/regions/${id}`);
      return c.json(regionRow(row), 201);
    },
    execute: async (lease) => {
      const now = new Date().toISOString();
      try {
        await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO regions
            (id, provider, provider_region, gateway_url, gateway_binding,
             created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            body.id,
            body.provider,
            body.provider_region,
            body.gateway_url,
            body.gateway_binding ?? null,
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
        regionRow({
          ...body,
          gateway_binding: body.gateway_binding ?? null,
          agent_last_seen_at: null,
          created_at: now,
          updated_at: now,
        }),
        201,
      );
    },
  });
}
/**
 * An administrator reads the full records. An integrator key chooses where to create a database
 * and sees only the regions that accept placement, as `{id, provider_region}`.
 */
export async function listRegions(c: ApiContext): Promise<Response> {
  const auth = await getAuth(c);
  const pagination = page(c);
  const cursor = pagination.where();
  if (auth.scope === "integrator") {
    const placed = await c.env.DB.prepare(
      `SELECT id,provider_region,created_at FROM regions WHERE ${regionAcceptsPlacementSql()} AND ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
      .bind(...cursor.bindings, pagination.limit + 1)
      .all<{ id: string; provider_region: string; created_at: string }>();
    const { data, next_cursor } = pagination.envelope(placed.results);
    return c.json(
      {
        data: data.map((region) =>
          PlacementRegion.parse({
            id: region.id,
            provider_region: region.provider_region,
          }),
        ),
        next_cursor,
      },
      200,
    );
  }
  const rows = await c.env.DB.prepare(
    `SELECT r.*,(SELECT MAX(n.last_observed_at) FROM nodes n WHERE n.region_id=r.id) agent_last_seen_at
     FROM regions r WHERE ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...cursor.bindings, pagination.limit + 1)
    .all<Row>();
  return c.json(pagination.envelope(rows.results.map(regionRow)), 200);
}
export async function listNodes(c: ApiContext): Promise<Response> {
  await requireAdminRead(c);
  const pagination = page(c);
  const cursor = pagination.where();
  const rows = await c.env.DB.prepare(
    `SELECT * FROM nodes WHERE ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...cursor.bindings, pagination.limit + 1)
    .all<Row>();
  // Enrich only the public page, not the extra cursor sentinel.
  const pageRows = rows.results.slice(0, pagination.limit),
    data = await inventoryRows(c, pageRows);
  const envelope = pagination.envelope(
    rows.results as (Row & { id: string; created_at: string })[],
  );
  return c.json({ ...envelope, data }, 200);
}

async function inventoryRows(c: ApiContext, rows: Row[]) {
  const releases = await readFleetNodeReleaseInventories(
    c.env.DB,
    rows.map((row) => String(row.id)),
  );
  return rows.map((row) => {
    const release = releases.get(String(row.id));
    if (!release || release.status.node_uid !== row.node_uid)
      throw new ApiError("conflict", "Node inventory identity changed");
    return nodeInventoryRow(row, release);
  });
}

export async function getNode(c: ApiContext, id: string) {
  await requireAdminRead(c);
  const row = await c.env.DB.prepare("SELECT * FROM nodes WHERE id=?")
    .bind(id)
    .first<Row>();
  if (!row) throw new ApiError("not_found", "Node not found");
  return c.json((await inventoryRows(c, [row]))[0], 200);
}

export async function getRegion(c: ApiContext, id: string) {
  await requireAdminRead(c);
  const row = await c.env.DB.prepare(regionSelect).bind(id).first<Row>();
  if (!row) throw new ApiError("not_found", "Region not found");
  return c.json(regionRow(row), 200);
}

// The newest link message of the region's nodes is deliberately excluded.
const configurationFields = [
  "id",
  "provider",
  "provider_region",
  "gateway_url",
  "gateway_binding",
  "created_at",
  "updated_at",
] as const;

async function regionConfigurationRow(c: ApiContext, id: string): Promise<Row> {
  const row = await c.env.DB.prepare(regionSelect).bind(id).first<Row>();
  if (!row) throw new ApiError("not_found", "Region not found");
  return row;
}
async function configurationDigest(row: Row): Promise<string> {
  const value = JSON.stringify(configurationFields.map((field) => row[field]));
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
async function configurationResponse(
  c: ApiContext,
  row: Row,
): Promise<Response> {
  return c.json(
    {
      region: regionRow(row),
      configuration_sha256: await configurationDigest(row),
    },
    200,
  );
}

export async function getRegionConfiguration(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireAdminRead(c);
  return configurationResponse(c, await regionConfigurationRow(c, id));
}

export async function updateRegionConfiguration(
  c: ApiContext,
  id: string,
  body: RegionConfigurationUpdate,
): Promise<Response> {
  await requireScope(c, "admin");
  if (
    !RegionGatewayConfiguration.safeParse({
      gateway_url: body.gateway_url,
      gateway_binding: body.gateway_binding,
    }).success
  )
    throw new ApiError("invalid_request", "Invalid gateway configuration");
  const read = async () =>
    configurationResponse(c, await regionConfigurationRow(c, id));
  return withIdempotency(c, {
    // As with other configuration endpoints, replay returns the current safe view;
    // it never reapplies a previous routing value after a subsequent update.
    replay: read,
    execute: async (lease) => {
      const before = await regionConfigurationRow(c, id);
      if (
        (await configurationDigest(before)) !==
        body.expected_configuration_sha256
      )
        throw new ApiError(
          "conflict",
          "Region configuration changed; read the current configuration before updating",
        );
      const now = new Date(
        Math.max(Date.now(), Date.parse(String(before.updated_at)) + 1),
      ).toISOString();
      const results = await withAdmissionMutation(
        c.env,
        [],
        async (mutation) => {
          const guard = mutation.scopeGuard();
          return mutation.batch([
            c.env.DB.prepare(
              `UPDATE regions SET gateway_url=?,gateway_binding=?,updated_at=?
          WHERE ${configurationFields.map((field) => `${field} IS ?`).join(" AND ")} AND ${guard.sql}`,
            ).bind(
              body.gateway_url,
              body.gateway_binding,
              now,
              ...configurationFields.map(
                (field) => before[field] as string | number | null,
              ),
              ...guard.bindings,
            ),
            lease.completeStatement(id, 200, {
              sql: "changes() = 1",
              bindings: [],
            }),
          ]);
        },
        { kind: "region", id },
      );
      if (results[0]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Region configuration changed; read the current configuration before updating",
        );
      return read();
    },
  });
}
