// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseRuntime, DatabaseWithOperation } from "@pgcf/contracts";
import { expect } from "vitest";
import { readDatabaseAdmissionSnapshot } from "../../src/domain/database-admission-snapshot.ts";
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
