// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId, NodeId, OperationId, RegionId } from "./ids.ts";

/**
 * The existing DatabaseActor RPC response; Rust Edge consumes its generated schema. The gateway is
 * the one of the node that serves the database (its own hostname, else the region's), because only
 * that gateway verifies the route.
 */
export const DatabaseRegionRoute = z.strictObject({
  id: RegionId,
  gateway_url: z.url({ protocol: /^https?$/ }).max(2048),
  gateway_binding: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
});
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/**
 * What an awake database runs on its node: the generation the node reported, the admission route
 * revision and the invocation ID of the PostgreSQL unit. The Edge signs it into route v6, and the
 * gateway compares it with its table (`UnitWriter.instance`).
 */
export const NodeDatabaseTarget = z.strictObject({
  revision: Revision,
  route_revision: Revision,
  instance: z.uuid(),
});
export type NodeDatabaseTarget = z.infer<typeof NodeDatabaseTarget>;
/**
 * What a node reported of the unit that serves a database, stored beside the database and carried
 * in its admission snapshot. It is valid exactly while the database's observed generation and
 * storage generation are these.
 */
export const DatabaseRuntime = z.strictObject({
  database_id: DatabaseId,
  node_id: NodeId,
  generation: Revision,
  storage_generation: Revision,
  instance: z.uuid(),
  /** Milliseconds since the epoch when the API accepted the report. */
  observed_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type DatabaseRuntime = z.infer<typeof DatabaseRuntime>;
export const DatabaseAdmission = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    region: DatabaseRegionRoute,
    /** The node of the database; its key signs the route. */
    node: NodeId,
    target: NodeDatabaseTarget,
  }),
  z.strictObject({
    ok: z.literal(false),
    sqlstate: z.enum(["3D000", "28P01", "57P03", "08006", "53300"]),
  }),
]);
export type DatabaseAdmission = z.infer<typeof DatabaseAdmission>;
/** The wake ticket the DatabaseActor issues for a sleeping database; the Edge signs it as route v5. */
export const DatabaseWakeTicket = z.strictObject({
  operation: OperationId,
  /** The generation the wake claims in D1: the snapshot's generation + 1. */
  generation: Revision,
  route_revision: Revision,
  role_revision_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DatabaseWakeTicket = z.infer<typeof DatabaseWakeTicket>;
/** `DatabaseActor.admitWake`: an awake target, a wake ticket, or a refusal. */
export const DatabaseWakeAdmission = z.union([
  z.strictObject({
    ok: z.literal(true),
    region: DatabaseRegionRoute,
    node: NodeId,
    target: NodeDatabaseTarget,
  }),
  z.strictObject({
    ok: z.literal(true),
    region: DatabaseRegionRoute,
    node: NodeId,
    wake: DatabaseWakeTicket,
  }),
  z.strictObject({
    ok: z.literal(false),
    sqlstate: z.enum(["3D000", "28P01", "57P03", "08006", "53300"]),
  }),
]);
export type DatabaseWakeAdmission = z.infer<typeof DatabaseWakeAdmission>;

/** How long a connect to a sleeping database may wait to be admitted, at the Edge and in the Actor. A cold
 * Thin wake takes 22 s when the identity turn is free and about 40 s when one is in flight, which the
 * 30 s of the first deadline cut off (measured 2026-10-16). */
export const ADMISSION_DEADLINE_MS = 60_000;
