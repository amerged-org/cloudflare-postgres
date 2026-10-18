// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseId,
  DatabaseRegionRoute,
  DatabaseRuntime,
  NodeId,
  RoleName,
  Timestamp,
} from "@pgcf/contracts";
import { z } from "zod";

const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const AdmissionMutationIntent = z.strictObject({
  database_id: DatabaseId,
  mutation_id: z.uuid(),
  admission_revision: Revision,
  route_revision: Revision,
});
export type AdmissionMutationIntent = z.infer<typeof AdmissionMutationIntent>;
export const DatabaseAdmissionSnapshot = z
  .strictObject({
    v: z.literal(1),
    database_id: DatabaseId,
    admission_revision: Revision,
    route_revision: Revision,
    generation: Revision,
    updated_at: z.iso.datetime(),
    roles: z
      .array(
        z.strictObject({
          name: RoleName,
          revision: Revision,
          /** PostgreSQL refuses the role from the start of this second on. */
          valid_until: Timestamp.nullable(),
        }),
      )
      .max(100)
      .refine(
        (roles) =>
          new Set(roles.map((role) => role.name)).size === roles.length,
      ),
    deleted: z.boolean(),
    admissible: z.boolean(),
    /**
     * An idle sleeper the Actor may issue a wake ticket for without reading D1 (pool design
     * 2026-10-16). Optional so snapshots persisted before it still parse; absent means the Actor
     * takes the authoritative wake path.
     */
    wakeable: z.boolean().optional(),
    region: DatabaseRegionRoute,
    /** The node of the database, whose key signs the routes to it. */
    node: NodeId.nullable(),
    /** What the node reported of the unit that serves the database now. */
    runtime: DatabaseRuntime.nullable(),
  })
  .refine(
    (snapshot) =>
      !snapshot.deleted ||
      (snapshot.roles.length === 0 && !snapshot.admissible),
  )
  .refine(
    (snapshot) =>
      !snapshot.admissible ||
      (snapshot.runtime !== null &&
        snapshot.runtime.database_id === snapshot.database_id &&
        snapshot.runtime.node_id === snapshot.node &&
        snapshot.runtime.generation === snapshot.generation),
  );
export type DatabaseAdmissionSnapshot = z.infer<
  typeof DatabaseAdmissionSnapshot
>;

/** SQL-only boundary: a create/placement cannot join a scope that is being mutated. */
export function admissionScopesOpenSql(
  project: string,
  region: string,
  node: string,
) {
  return `NOT EXISTS(SELECT 1 FROM admission_scope_fences sf WHERE sf.mutation_id IS NOT NULL
    AND ((sf.kind='project' AND sf.scope_id=${project}) OR (sf.kind='region' AND sf.scope_id=${region})
      OR (sf.kind='node' AND sf.scope_id=${node})))`;
}
