// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, DatabaseRegionRoute, RoleName } from "@pgcf/contracts";
import { DatabaseRuntimeAttestationV2 } from "@pgcf/contracts/reclaim";
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
      .array(z.strictObject({ name: RoleName, revision: Revision }))
      .max(100)
      .refine(
        (roles) =>
          new Set(roles.map((role) => role.name)).size === roles.length,
      ),
    deleted: z.boolean(),
    cache_capable: z.boolean(),
    admissible: z.boolean(),
    /**
     * An idle sleeper the Actor may issue a wake ticket for without reading D1 (pool design
     * 2026-10-16). Optional so snapshots persisted before it still parse; absent means the Actor
     * takes the authoritative wake path.
     */
    wakeable: z.boolean().optional(),
    region: DatabaseRegionRoute,
    runtime: DatabaseRuntimeAttestationV2.nullable(),
  })
  .refine(
    (snapshot) =>
      !snapshot.deleted ||
      (snapshot.roles.length === 0 && !snapshot.admissible),
  )
  .refine(
    (snapshot) =>
      !snapshot.cache_capable ||
      !snapshot.admissible ||
      (snapshot.runtime !== null &&
        snapshot.runtime.database_id === snapshot.database_id &&
        snapshot.runtime.generation === snapshot.generation &&
        snapshot.runtime.admission_epoch === snapshot.admission_revision &&
        snapshot.runtime.route_revision === snapshot.route_revision),
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
