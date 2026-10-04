// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
import {
  cleanupFixtures,
  fixture,
  request,
  observation,
  observedBody,
} from "./fixtures.ts";

afterEach(async () => {
  await env.DB.prepare("DELETE FROM reconciliation_cursors").run();
  await env.DB.prepare("DELETE FROM power_timeout_cursor").run();
  await cleanupFixtures();
});

async function suspended() {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(id, 1)]),
  );
  const result = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${id}/suspend`, f.integrator, "POST")
    ).json(),
  );
  await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id=?")
    .bind(new Date(Date.now() - 21 * 60_000).toISOString(), result.operation.id)
    .run();
  return { ...f, id, operation: result.operation.id };
}

it("compensates timed-out quiescence before failing the operation without inventing readiness", async () => {
  const f = await suspended();
  const before = await env.DB.prepare(
    "SELECT archive_path,node_id,size_class_id FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first();
  const result = await runCron(env);
  expect(result.failed).toBe(1);
  expect(
    await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?")
      .bind(f.operation)
      .first(),
  ).toEqual({ status: "failed", error_code: "power_timeout" });
  const row = await env.DB.prepare(
    "SELECT desired_state,generation,power_operation,observed_state,observed_power FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<{
      desired_state: string;
      generation: number;
      power_operation: string;
      observed_state: string;
      observed_power: string;
    }>();
  expect(row).toMatchObject({
    desired_state: "running",
    generation: 3,
    observed_state: "provisioning",
    observed_power: "awake",
  });
  expect(row!.power_operation).not.toBe(f.operation);
  expect(
    await env.DB.prepare("SELECT kind,status FROM operations WHERE id=?")
      .bind(row!.power_operation)
      .first(),
  ).toEqual({ kind: "database.resume", status: "pending" });
  expect(
    await env.DB.prepare(
      "SELECT archive_path,node_id,size_class_id FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual(before);
  expect((await runCron(env)).failed).toBe(0);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(3);
});

it("uses the current power revision after a role configuration change", async () => {
  const f = await suspended();
  expect(
    (
      await request(
        `/v1/databases/${f.id}/roles/app/reset-password`,
        f.integrator,
        "POST",
      )
    ).status,
  ).toBe(200);
  expect((await runCron(env)).failed).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT desired_state,generation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ desired_state: "running", generation: 4 });
  expect(
    await env.DB.prepare("SELECT error_code FROM operations WHERE id=?")
      .bind(f.operation)
      .first("error_code"),
  ).toBe("power_timeout");
});

it("does not compensate a superseded suspension", async () => {
  const f = await suspended();
  const resumed = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${f.id}/resume`, f.integrator, "POST")
    ).json(),
  );
  expect((await runCron(env)).failed).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT generation,power_operation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ generation: 3, power_operation: resumed.operation.id });
});

it("pages timeout recovery and leaves the remaining owned suspension pending", async () => {
  const cohort = [];
  for (let i = 0; i < 9; i++) cohort.push(await suspended());
  expect((await runCron(env)).failed).toBe(8);
  const stillPending = await env.DB.prepare(
    "SELECT id FROM operations WHERE id IN(" +
      cohort.map(() => "?").join(",") +
      ") AND status='pending'",
  )
    .bind(...cohort.map((f) => f.operation))
    .all<{ id: string }>();
  expect(stillPending.results).toHaveLength(1);
  const remaining = cohort.find(
    (f) => f.operation === stillPending.results[0]!.id,
  )!;
  expect(
    await env.DB.prepare(
      "SELECT desired_state,generation FROM databases WHERE id=?",
    )
      .bind(remaining.id)
      .first(),
  ).toEqual({ desired_state: "suspended", generation: 2 });
  expect((await runCron(env)).failed).toBe(1);
  expect(
    await env.DB.prepare("SELECT error_code FROM operations WHERE id=?")
      .bind(remaining.operation)
      .first("error_code"),
  ).toBe("power_timeout");
  expect(
    await env.DB.prepare(
      "SELECT database_id FROM power_timeout_cursor WHERE singleton=1",
    ).first(),
  ).toEqual({ database_id: null });
});
