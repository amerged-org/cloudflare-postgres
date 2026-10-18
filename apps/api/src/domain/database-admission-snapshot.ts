// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, DatabaseRuntime } from "@pgcf/contracts";
import type { Env } from "../env.ts";
import { databaseActor } from "./database-actor-sync.ts";
import { DatabaseAdmissionSnapshot } from "./admission-state.ts";
import { DatabasePresence } from "../database-actor.ts";
import type { DatabaseRow } from "./rows.ts";
import { notifyAdmissionRevisions } from "./admission-mutations.ts";

interface SnapshotRow extends DatabaseRow {
  epoch_database_id: string | null;
  presence_updated_at: string;
  project_deleted_at: string | null;
  node_ready: number | null;
  lost_at: string | null;
  gateway_url: string;
  gateway_binding: string | null;
  admission_revision: number;
  route_revision: number;
  mutation_id: string | null;
  completed_mutation_id: string | null;
  roles_json: string;
}
/** Trusted publication reads all authoritative nonsecret admission inputs together. */
export async function readDatabaseAdmissionSnapshot(env: Env, id: string) {
  DatabaseId.parse(id);
  const readRow = () =>
    env.DB.prepare(
      `SELECT d.*,p.deleted_at project_deleted_at,n.ready node_ready,n.lost_at,r.gateway_url,r.gateway_binding,
    ae.database_id epoch_database_id,CASE WHEN p.updated_at>d.updated_at THEN p.updated_at ELSE d.updated_at END presence_updated_at,
    ae.admission_revision,ae.route_revision,ae.mutation_id,ae.completed_mutation_id,
    (SELECT json_group_array(json_object('name',rr.name,'owner',rr.owner,'revision',rr.password_revision,'valid_until',rr.valid_until)) FROM roles rr WHERE rr.database_id=d.id AND rr.deleted_at IS NULL) roles_json
    FROM databases d JOIN projects p ON p.id=d.project_id JOIN regions r ON r.id=d.region_id
    LEFT JOIN database_admission_epochs ae ON ae.database_id=d.id LEFT JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id WHERE d.id=?`,
    )
      .bind(id)
      .first<SnapshotRow>();
  let row = await readRow();
  if (row && row.epoch_database_id === null) {
    await env.DB.prepare(
      "INSERT INTO database_admission_epochs(database_id) SELECT id FROM databases WHERE id=? ON CONFLICT(database_id) DO NOTHING",
    )
      .bind(id)
      .run();
    // One positive current readback, including a concurrent first publisher; never synthesize an epoch.
    row = await readRow();
    if (row?.epoch_database_id == null) return null;
  }
  if (!row) return null;
  const roleOrder = (a: { name: string }, b: { name: string }) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const roles = (
    JSON.parse(row.roles_json) as {
      name: string;
      owner: number;
      revision: number;
      valid_until: string | null;
    }[]
  ).sort(roleOrder);
  const deleted =
    row.deleted_at !== null ||
    row.desired_state === "deleted" ||
    row.project_deleted_at !== null;
  // What the node reported of the unit counts only for the generation and storage it names now.
  let runtime: DatabaseAdmissionSnapshot["runtime"] = null;
  try {
    const parsed = DatabaseRuntime.safeParse(
      row.runtime_attestation_json
        ? JSON.parse(row.runtime_attestation_json)
        : null,
    );
    if (
      parsed.success &&
      parsed.data.database_id === id &&
      parsed.data.node_id === row.node_id &&
      parsed.data.generation === row.generation &&
      parsed.data.storage_generation === (row.storage_generation ?? 1)
    )
      runtime = parsed.data;
  } catch {
    /* A malformed report closes admission; it cannot repair desired state. */
  }
  const admissible =
    !deleted &&
    row.mutation_id === null &&
    row.node_id !== null &&
    row.lost_at === null &&
    row.node_ready === 1 &&
    row.desired_state === "running" &&
    row.observed_state === "ready" &&
    row.observed_power === "awake" &&
    row.observed_generation === row.generation &&
    runtime !== null;
  const wakeable =
    !deleted &&
    row.mutation_id === null &&
    row.node_id !== null &&
    row.lost_at === null &&
    row.desired_state === "suspended" &&
    row.suspension_reason === "idle" &&
    row.power_operation !== null;
  return {
    presence: DatabasePresence.parse({
      database_id: id,
      revision: row.generation,
      updated_at: row.presence_updated_at,
      deleted,
      roles: deleted
        ? []
        : roles.map(({ name, valid_until }) => ({ name, valid_until })),
    }),
    snapshot: DatabaseAdmissionSnapshot.parse({
      v: 1,
      database_id: id,
      admission_revision: row.admission_revision,
      route_revision: row.route_revision,
      generation: row.generation,
      updated_at: row.updated_at,
      roles: deleted
        ? []
        : roles.map(({ name, revision, valid_until }) => ({
            name,
            revision,
            valid_until,
          })),
      deleted,
      admissible,
      wakeable,
      region: {
        id: row.region_id,
        gateway_url: row.gateway_url,
        gateway_binding: row.gateway_binding,
      },
      node: row.node_id,
      runtime,
    }),
    mutation_id: row.mutation_id,
    completed_mutation_id: row.completed_mutation_id,
  };
}
/** Milliseconds each step of one publish took, for the measurement of a wake. */
export type PublishSteps = Partial<
  Record<"repair_ms" | "snapshot_ms" | "seed_ms" | "store_ms", number>
>;
export async function publishDatabaseAdmission(
  env: Env,
  id: string,
  completedMutation?: string,
  steps?: PublishSteps,
) {
  const timed = async <T>(
    step: keyof PublishSteps,
    run: () => Promise<T>,
  ): Promise<T> => {
    const started = Date.now();
    try {
      return await run();
    } finally {
      if (steps) steps[step] = Date.now() - started;
    }
  };
  const actor = databaseActor(env, id);
  if (await timed("repair_ms", () => actor.repairAdmissionMutation()))
    await notifyAdmissionRevisions(env, [id]);
  const state = await timed("snapshot_ms", () =>
    readDatabaseAdmissionSnapshot(env, id),
  );
  if (!state) return false;
  await timed("seed_ms", () => actor.seed(state.presence));
  return timed("store_ms", () =>
    actor.publishAdmissionSnapshot(
      state.snapshot,
      completedMutation ?? state.completed_mutation_id,
    ),
  );
}
