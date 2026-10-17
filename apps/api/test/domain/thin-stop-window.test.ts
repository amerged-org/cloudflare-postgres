// SPDX-License-Identifier: Apache-2.0
// The host lease while a thin database sleeps and is then deleted, on real D1 fixtures.
// Controlled metadata only; no live qualification or Dev evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { cleanupFixtures, request } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import { awakeWriter, idleIntent, leaseEntry } from "./thin-writer-fixture.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

it("a sleeping database stays permitted, and so does its deletion until its volume is read absent", async () => {
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
  const writer = {
    generation: deleted.database.generation + 1,
    desired_state: "running",
    write_blocked: false,
    volume: w.receipt,
    runtime_authority: null,
    drain: null,
  };
  expect(await leaseEntry(w.f, w.id)).toMatchObject(writer);
  // The node reading the volume quiesced changes nothing: the guard never suspends it.
  await w.evidence({
    generation: deleted.database.generation,
    quiesced: true,
  });
  expect(await leaseEntry(w.f, w.id)).toMatchObject(writer);
});
