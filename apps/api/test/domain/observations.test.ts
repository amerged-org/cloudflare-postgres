// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { powerTransitionStatements } from "../../src/domain/lifecycle.ts";
import type { DatabaseRow } from "../../src/domain/rows.ts";
import {
  cleanupFixtures,
  fixture,
  observedBody,
  observation,
  request,
} from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
async function suspended(action: "hibernate" | "suspend" = "hibernate") {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json()),
    id = created.database.id;
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(id, 1)]),
  );
  const row = (await env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(id)
    .first<DatabaseRow>())!;
  const operation = newOperationId();
  await env.DB.batch(
    powerTransitionStatements(
      env.DB,
      row,
      action,
      operation,
      new Date().toISOString(),
    ),
  );
  await env.DB.prepare(
    "UPDATE databases SET archiving_health='failing' WHERE id=?",
  )
    .bind(id)
    .run();
  const sample = {
    ...observation(id, 2, "hibernated"),
    power: { operation, revision: 2, state: "hibernated" },
    archive: { continuous: false, ready_wal_files: null },
  };
  return { ...f, id, operation, sample };
}
async function submit(
  f: Awaited<ReturnType<typeof suspended>>,
  value: unknown = f.sample,
  key = f.agent,
) {
  return request("/agent/v1/observations", key, "POST", observedBody([value]));
}
async function health(id: string) {
  return env.DB.prepare("SELECT archiving_health FROM databases WHERE id=?")
    .bind(id)
    .first("archiving_health");
}

it("accepted exact idle hibernation reports inactive archive health as unknown rather than failing", async () => {
  const f = await suspended();
  const response = await submit(f);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: 1 });
  expect(await health(f.id)).toBe("unknown");
  const view = await (
    await request(`/v1/databases/${f.id}`, f.integrator)
  ).json();
  expect(view).toMatchObject({
    desired_state: "suspended",
    observed_state: "hibernated",
    suspension_reason: "idle",
    health: { archiving: "unknown" },
  });
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(f.operation)
      .first("status"),
  ).toBe("succeeded");
  expect((await submit(f)).status).toBe(200);
  expect(await health(f.id)).toBe("unknown");
});

it("accepted manual hibernation is inactive too and never asserts a healthy live archiver", async () => {
  const f = await suspended("suspend");
  expect((await submit(f)).status).toBe(200);
  expect(await health(f.id)).toBe("unknown");
  expect(
    (
      await submit(f, {
        ...f.sample,
        archive: { continuous: true, ready_wal_files: 0 },
      })
    ).status,
  ).toBe(200);
  expect(await health(f.id)).toBe("unknown");
});

it("a queued WAL sample or an incompatible power operation cannot hide archive failure", async () => {
  const f = await suspended();
  expect(
    (
      await submit(f, {
        ...f.sample,
        archive: { continuous: false, ready_wal_files: 1 },
      })
    ).status,
  ).toBe(200);
  expect(await health(f.id)).toBe("failing");
  await env.DB.prepare(
    "UPDATE operations SET kind='database.resume' WHERE id=?",
  )
    .bind(f.operation)
    .run();
  expect((await submit(f)).status).toBe(200);
  expect(await health(f.id)).toBe("failing");
});

it("a concurrently failed power operation cannot clear a failing archive alarm", async () => {
  const f = await suspended(),
    original = env.DB.batch.bind(env.DB);
  let injected = false;
  vi.spyOn(Object.getPrototypeOf(env.DB), "batch").mockImplementation(
    async (...args: unknown[]) => {
      const statements = args[0] as D1PreparedStatement[];
      if (!injected) {
        injected = true;
        await env.DB.prepare(
          "UPDATE operations SET status='failed',error_code='test_race',completed_at=? WHERE id=?",
        )
          .bind(new Date().toISOString(), f.operation)
          .run();
      }
      return original(statements);
    },
  );
  expect((await submit(f)).status).toBe(200);
  expect(injected).toBe(true);
  expect(await health(f.id)).toBe("failing");
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(f.operation)
      .first("status"),
  ).toBe("failed");
});

it("running and partial or failed hibernation observations retain failure semantics", async () => {
  const f = await suspended();
  const partial = {
    ...f.sample,
    state: "provisioning",
    power: { ...f.sample.power, state: "awake" },
  };
  expect((await submit(f, partial)).status).toBe(200);
  expect(await health(f.id)).toBe("failing");
  await env.DB.prepare(
    "UPDATE operations SET status='failed',error_code='test_failure',error_message='fixture failure',completed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), f.operation)
    .run();
  expect((await submit(f)).status).toBe(200);
  expect(await health(f.id)).toBe("failing");
  const readyFixture = await fixture();
  const created = DatabaseWithOperation.parse(
    await (await readyFixture.create()).json(),
  );
  await request(
    "/agent/v1/observations",
    readyFixture.agent,
    "POST",
    observedBody([
      {
        ...observation(created.database.id, 1),
        archive: { continuous: false, ready_wal_files: null },
      },
    ]),
  );
  expect(await health(created.database.id)).toBe("failing");
});

it("stale, wrong-operation, wrong-region and inconsistent power claims cannot clear archive failure", async () => {
  const f = await suspended();
  const stale = {
    ...f.sample,
    generation: 1,
    power: { ...f.sample.power, revision: 1 },
  };
  const staleResponse = await submit(f, stale);
  expect(await staleResponse.json()).toEqual({ accepted: 0 });
  const wrongOperation = await submit(f, {
    ...f.sample,
    power: { ...f.sample.power, operation: newOperationId() },
  });
  expect(await wrongOperation.json()).toEqual({ accepted: 0 });
  const wrongRegion = await submit(f, f.sample, f.foreignAgent);
  expect(await wrongRegion.json()).toEqual({ accepted: 0 });
  expect(
    (
      await submit(f, {
        ...f.sample,
        power: { ...f.sample.power, state: "awake" },
      })
    ).status,
  ).toBe(400);
  expect(await health(f.id)).toBe("failing");
});

it("a refused quiesce preserves archive failure and cannot claim inactive", async () => {
  const f = await suspended();
  const refusal = {
    ...f.sample,
    state: "error",
    power: { ...f.sample.power, state: "awake", refusal: "archive" },
  };
  const response = await submit(f, refusal);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: 1 });
  expect(await health(f.id)).toBe("failing");
  const stale = await submit(f);
  expect(await stale.json()).toEqual({ accepted: 0 });
  expect(await health(f.id)).toBe("failing");
});
