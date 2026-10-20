// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseRuntime,
  DatabaseWithOperation,
  newOperationId,
} from "@pgcf/contracts";
import { expect } from "vitest";
import {
  publishDatabaseAdmission,
  readDatabaseAdmissionSnapshot,
} from "../../src/domain/database-admission-snapshot.ts";
import { fixture, report, request, verdicts } from "./fixtures.ts";

/**
 * A database on an enrolled node that reported it ready: the runtime and the admission epoch are
 * what the API's intake wrote on real D1, never a hand-built record.
 */
export async function admissionSnapshotFixture() {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  expect(
    (
      await request(
        `/v1/databases/${id}/roles`,
        f.integrator,
        "POST",
        { name: "reader" },
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(201);
  // The role advanced the generation, which is the one the node reports.
  const current = (await env.DB.prepare(
    "SELECT generation FROM databases WHERE id=?",
  )
    .bind(id)
    .first<number>("generation"))!;
  expect(await verdicts(await report(f, id, current))).toEqual(["accept"]);
  // The first read creates the database's admission epoch.
  expect(await readDatabaseAdmissionSnapshot(env, id)).not.toBeNull();
  const row = (await env.DB.prepare(
    "SELECT d.generation,d.runtime_json runtime,e.admission_revision,e.route_revision FROM databases d JOIN database_admission_epochs e ON e.database_id=d.id WHERE d.id=?",
  )
    .bind(id)
    .first<{
      generation: number;
      runtime: string;
      admission_revision: number;
      route_revision: number;
    }>())!;
  return {
    ...f,
    id,
    generation: row.generation,
    runtime: DatabaseRuntime.parse(JSON.parse(row.runtime)),
    epoch: {
      admission_revision: row.admission_revision,
      route_revision: row.route_revision,
    },
  };
}

/** A database the node reported asleep after an idle (or manual) sleep. */
export async function sleepingSnapshotFixture(
  reason: "idle" | "manual" = "idle",
) {
  const f = await admissionSnapshotFixture();
  const sleepOperation = newOperationId(),
    sleepGeneration = f.generation + 1,
    at = new Date().toISOString();
  // Controlled committed sleep metadata, as the idle sleeper test writes it.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,?,'succeeded',?,?,?,?,?,?)",
    ).bind(
      sleepOperation,
      reason === "idle" ? "database.hibernate" : "database.suspend",
      f.project,
      f.id,
      sleepGeneration,
      at,
      at,
      at,
    ),
    env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',suspension_reason=?,generation=?,observed_state='provisioning',observed_power='hibernated',observed_generation=?,power_operation=?,runtime_json=NULL WHERE id=?",
    ).bind(reason, sleepGeneration, sleepGeneration, sleepOperation, f.id),
    env.DB.prepare(
      "UPDATE database_admission_epochs SET admission_revision=admission_revision+1,route_revision=route_revision+1 WHERE database_id=?",
    ).bind(f.id),
  ]);
  expect(await publishDatabaseAdmission(env, f.id)).toBe(true);
  const snapshot = (await readDatabaseAdmissionSnapshot(env, f.id))!.snapshot;
  expect(snapshot.wakeable).toBe(reason === "idle");
  return { ...f, sleepGeneration, sleepOperation, snapshot };
}
