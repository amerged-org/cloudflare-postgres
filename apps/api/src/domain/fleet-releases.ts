// SPDX-License-Identifier: Apache-2.0
import {
  NODE_STALE_MS,
  NodeOs,
  bytesToHex,
  type NodeInventory,
} from "@pgcf/contracts";
import {
  FleetRelease,
  FleetReleaseId,
  FleetNodeReleaseStatus,
  FleetRegionReleaseStatus,
  RELEASE_BINARY_FILES,
  RELEASE_IMAGE_FILE,
  RELEASE_LOCK_FILE,
  fleetReleaseSpec,
  releaseObjectKey,
  type FleetPinnedFile,
  type FleetRegionReleaseUpdate,
  type FleetReleaseRegistration,
  type FleetReleaseSpec,
  type ReleaseFile,
} from "@pgcf/contracts/releases";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { page } from "../platform/pagination.ts";
import { hintNode } from "./node-hints.ts";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
async function sha256(text: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  );
}
const conflict = (message: string): never => {
  throw new ApiError("conflict", message);
};
interface ReleaseRow {
  id: string;
  spec_json: string;
  spec_sha256: string;
  approved_at: string;
}
function releaseRow(row: ReleaseRow): FleetRelease {
  return FleetRelease.parse({
    id: row.id,
    spec: JSON.parse(row.spec_json),
    spec_sha256: row.spec_sha256,
    approved_at: row.approved_at,
  });
}
async function release(db: D1Database, id: string): Promise<FleetRelease> {
  const row = await db
    .prepare(
      "SELECT id,spec_json,spec_sha256,approved_at FROM fleet_releases WHERE id=?",
    )
    .bind(id)
    .first<ReleaseRow>();
  if (!row) throw new ApiError("not_found", "Fleet release not found");
  return releaseRow(row);
}
export async function listFleetReleases(c: ApiContext): Promise<Response> {
  await requireScope(c, "admin");
  const pagination = page(
      c,
      c.req.query(),
      (id) => FleetReleaseId.safeParse(id).success,
    ),
    where = pagination.where("approved_at", "id"),
    rows = await c.env.DB.prepare(
      `SELECT id,spec_json,spec_sha256,approved_at FROM fleet_releases WHERE ${where.sql} ORDER BY approved_at DESC,id DESC LIMIT ?`,
    )
      .bind(...where.bindings, pagination.limit + 1)
      .all<ReleaseRow>(),
    envelope = pagination.envelope(
      rows.results.map((row) => ({ ...row, created_at: row.approved_at })),
    );
  return c.json({ ...envelope, data: envelope.data.map(releaseRow) });
}
export async function getFleetRelease(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(await release(c.env.DB, id), 200);
}
/** The spec of a registration, with every URL named by this Worker's own delivery route. */
function registeredSpec(
  c: ApiContext,
  id: string,
  registration: FleetReleaseRegistration,
): FleetReleaseSpec {
  const origin = c.env.NODE_API_ORIGIN;
  if (origin === undefined)
    return conflict(
      "NODE_API_ORIGIN is not configured, so the release's URLs cannot be named",
    );
  try {
    return fleetReleaseSpec(origin, id, registration);
  } catch {
    return conflict("NODE_API_ORIGIN is not an https origin");
  }
}
const hex = (bytes: ArrayBuffer) => bytesToHex(new Uint8Array(bytes));
/**
 * A release is registered only when the archive bucket holds each of its six files at the
 * registered size and R2 itself verified the registered sha256 when the file was uploaded
 * (`x-amz-checksum-sha256`), so a mistyped version or a half-finished upload is refused here
 * and not at the install of a node.
 */
async function assertFilesStored(
  bucket: R2Bucket,
  id: string,
  spec: FleetReleaseSpec,
): Promise<void> {
  const pins: [ReleaseFile, { sha256: string; size_bytes: number }][] = [
    [RELEASE_IMAGE_FILE, spec.image],
    [RELEASE_LOCK_FILE, spec.os.package_lock],
    ...RELEASE_BINARY_FILES.map(
      (file) => [file, spec.binaries[file]] as [ReleaseFile, FleetPinnedFile],
    ),
  ];
  const stored = await Promise.all(
    pins.map(([file]) => bucket.head(releaseObjectKey(id, file))),
  );
  pins.forEach(([file, pin], index) => {
    const object = stored[index],
      key = releaseObjectKey(id, file);
    if (!object) conflict(`${key} is not in the archive bucket`);
    else if (object.size !== pin.size_bytes)
      conflict(
        `${key} has ${object.size} bytes, not the registered ${pin.size_bytes}`,
      );
    else if (
      object.checksums.sha256 === undefined ||
      hex(object.checksums.sha256) !== pin.sha256
    )
      conflict(
        `${key} was not uploaded with the registered sha256 for R2 to verify`,
      );
  });
}
export async function approveFleetRelease(
  c: ApiContext,
  id: string,
  registration: FleetReleaseRegistration,
): Promise<Response> {
  await requireScope(c, "admin");
  const spec = registeredSpec(c, id, registration),
    specJson = canonical(spec),
    hash = await sha256(specJson);
  const read = async () => {
    const current = await release(c.env.DB, id);
    if (current.spec_sha256 !== hash || canonical(current.spec) !== specJson)
      return conflict("An approved fleet release is immutable");
    return c.json(current, 200);
  };
  return withIdempotency(c, {
    replay: read,
    execute: async (lease) => {
      const known = await c.env.DB.prepare(
        "SELECT 1 FROM fleet_releases WHERE id=?",
      )
        .bind(id)
        .first();
      if (known === null) await assertFilesStored(c.env.ARCHIVE, id, spec);
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
        ).bind(id, specJson, hash, new Date().toISOString()),
        lease.completeStatement(id, 200, {
          sql: "EXISTS(SELECT 1 FROM fleet_releases WHERE id=? AND spec_sha256=? AND spec_json=?)",
          bindings: [id, hash, specJson],
        }),
      ]);
      return read();
    },
  });
}
export async function readFleetRegionRelease(db: D1Database, regionId: string) {
  const row = await db
    .prepare(
      "SELECT r.id region_id,f.revision,f.release_id desired_release_id,f.updated_at FROM regions r LEFT JOIN fleet_region_releases f ON f.region_id=r.id WHERE r.id=?",
    )
    .bind(regionId)
    .first();
  if (!row) throw new ApiError("not_found", "Region not found");
  return FleetRegionReleaseStatus.parse({
    ...row,
    revision: row.revision ?? 0,
  });
}
export async function getFleetRegionRelease(
  c: ApiContext,
  regionId: string,
): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(await readFleetRegionRelease(c.env.DB, regionId), 200);
}
export async function assignFleetRegionRelease(
  c: ApiContext,
  regionId: string,
  input: FleetRegionReleaseUpdate,
): Promise<Response> {
  await requireScope(c, "admin");
  await release(c.env.DB, input.release_id);
  await readFleetRegionRelease(c.env.DB, regionId);
  const read = async () => {
    const result = await readFleetRegionRelease(c.env.DB, regionId);
    if (
      result.revision !== input.expected_revision + 1 ||
      result.desired_release_id !== input.release_id
    )
      return conflict("Region release assignment changed");
    return c.json(result, 200);
  };
  return withIdempotency(c, {
    replay: read,
    execute: async (lease) => {
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at)
          SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM regions WHERE id=?)
            AND (?=0 OR EXISTS(SELECT 1 FROM fleet_region_releases WHERE region_id=? AND revision=?))
          ON CONFLICT(region_id) DO UPDATE SET release_id=excluded.release_id,
            revision=excluded.revision,updated_at=excluded.updated_at WHERE fleet_region_releases.revision=?`,
        ).bind(
          regionId,
          input.release_id,
          input.expected_revision + 1,
          new Date().toISOString(),
          regionId,
          input.expected_revision,
          regionId,
          input.expected_revision,
          input.expected_revision,
        ),
        lease.completeStatement(regionId, 200, {
          sql: "changes()=1",
          bindings: [],
        }),
      ]);
      if (results[0]!.meta.changes !== 1)
        return conflict("Region release assignment changed");
      // The nodes of the region pull the page that names the release.
      const nodes = await c.env.DB.prepare(
        "SELECT id FROM nodes WHERE region_id=? AND lost_at IS NULL AND public_key IS NOT NULL",
      )
        .bind(regionId)
        .all<{ id: string }>();
      c.executionCtx.waitUntil(
        Promise.all(
          nodes.results.map((node) => hintNode(c.env, node.id).catch(() => 0)),
        ),
      );
      return read();
    },
  });
}
interface NodeReleaseRow {
  node_id: string;
  region_id: string;
  node_uid: string | null;
  lost_at: string | null;
  last_observed_at: string | null;
  reported_release_id: string | null;
  agent_version: string | null;
  os_boot_id: string | null;
  os_booted_at: string | null;
  os_kernel_release: string | null;
  os_packages_sha256: string | null;
  desired_release_id: string | null;
  desired_spec_sha256: string | null;
  desired_kernel_release: string | null;
  desired_packages_sha256: string | null;
}
const nodeReleaseSelect = `SELECT n.id node_id,n.region_id,n.node_uid,n.lost_at,n.last_observed_at,n.reported_release_id,n.agent_version,
    n.os_boot_id,n.os_booted_at,n.os_kernel_release,n.os_packages_sha256,
    f.release_id desired_release_id,r.spec_sha256 desired_spec_sha256,
    json_extract(r.spec_json,'$.os.kernel_release') desired_kernel_release,
    json_extract(r.spec_json,'$.os.packages_sha256') desired_packages_sha256
    FROM nodes n LEFT JOIN fleet_region_releases f ON f.region_id=n.region_id LEFT JOIN fleet_releases r ON r.id=f.release_id`;
/** What the fleet knows of a node beyond its row: its release status and what its link reported. */
export type NodeFleet = {
  status: FleetNodeReleaseStatus;
} & Pick<NodeInventory, "observation" | "os" | "os_converged">;
/**
 * Where a node stands against its region's release. A node follows the release of its region:
 * its page names it, and the agent's hello names the release it runs and the operating system
 * it boots. The OS is the release's when the kernel and the installed packages are.
 */
function nodeReleaseStatus(row: NodeReleaseRow, now = Date.now()): NodeFleet {
  const seen =
      row.last_observed_at === null ? null : Date.parse(row.last_observed_at),
    stale = seen === null || seen < now - NODE_STALE_MS || seen > now + 5000;
  const state: FleetNodeReleaseStatus["state"] =
    row.lost_at !== null
      ? "fenced"
      : row.desired_release_id === null
        ? "unassigned"
        : row.reported_release_id !== row.desired_release_id
          ? "pending"
          : stale
            ? "stale"
            : "converged";
  const os =
    row.os_boot_id === null
      ? null
      : NodeOs.parse({
          boot_id: row.os_boot_id,
          booted_at: row.os_booted_at,
          kernel_release: row.os_kernel_release,
          packages_sha256: row.os_packages_sha256,
        });
  return {
    status: FleetNodeReleaseStatus.parse({
      node_id: row.node_id,
      region_id: row.region_id,
      node_uid: row.node_uid,
      desired_release_id: row.desired_release_id,
      desired_spec_sha256: row.desired_spec_sha256,
      observed_release_id: row.reported_release_id,
      observed_at: row.last_observed_at,
      state,
    }),
    observation: {
      state: seen === null ? "unobserved" : stale ? "stale" : "current",
      observed_at: row.last_observed_at,
      agent_version: row.agent_version,
    },
    os,
    os_converged:
      os === null || row.desired_release_id === null
        ? null
        : os.kernel_release === row.desired_kernel_release &&
          os.packages_sha256 === row.desired_packages_sha256,
  };
}
export async function readFleetNodeRelease(
  db: D1Database,
  id: string,
): Promise<FleetNodeReleaseStatus> {
  const row = await db
    .prepare(`${nodeReleaseSelect} WHERE n.id=?`)
    .bind(id)
    .first<NodeReleaseRow>();
  if (!row) throw new ApiError("not_found", "Node not found");
  return nodeReleaseStatus(row).status;
}
/** The same projection for a bounded page of nodes, read together. */
export async function readFleetNodeReleaseInventories(
  db: D1Database,
  ids: string[],
): Promise<Map<string, NodeFleet>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .prepare(
      `${nodeReleaseSelect} WHERE n.id IN(SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(ids))
    .all<NodeReleaseRow>();
  const now = Date.now();
  return new Map(
    rows.results.map((row) => [row.node_id, nodeReleaseStatus(row, now)]),
  );
}
export async function getFleetNodeRelease(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(await readFleetNodeRelease(c.env.DB, id), 200);
}
