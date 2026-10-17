// SPDX-License-Identifier: Apache-2.0
// The host lease while a thin database sleeps and is then deleted, on real D1 fixtures.
// Controlled metadata only; no live qualification or Dev evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { cleanupFixtures, request } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import { awakeWriter, idleIntent, leaseEntry } from "./parked-tier-fixture.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

it("a sleeping database stays permitted until it is deleted, and its deletion drains as before", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  const intent = await idleIntent(w);
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    generation: intent.generation + 1,
    desired_state: "running",
    write_blocked: false,
    volume: w.receipt,
    runtime_authority: null,
    drain: null,
  });
  const response = await request(
    `/v1/databases/${w.id}`,
    w.f.integrator,
    "DELETE",
    undefined,
    crypto.randomUUID(),
  );
  expect(response.status).toBe(202);
  const deleted = DatabaseWithOperation.parse(await response.json());
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    generation: deleted.database.generation,
    desired_state: "deleted",
    runtime_authority: null,
    drain: null,
  });
  // Once the node reads the volume quiesced at the deletion's generation, the deletion drains.
  await w.evidence({
    generation: deleted.database.generation,
    quiesced: true,
  });
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    desired_state: "deleted",
    runtime_authority: null,
    drain: {
      operation_id: deleted.operation.id,
      kind: "database.delete",
      generation: deleted.database.generation,
    },
  });
});
