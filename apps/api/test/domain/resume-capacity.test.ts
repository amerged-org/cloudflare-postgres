// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_FLOOR_MIB } from "../../src/domain/placement.ts";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  refusal,
  request,
} from "./fixtures.ts";
import { MIB } from "./node-samples.ts";

afterEach(cleanupFixtures);

type Fixture = Awaited<ReturnType<typeof fixture>>;
/** A database of 512 MiB on the fixture's node that a manual suspend has stopped. */
async function suspended(f: Fixture) {
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(id, 1)]),
  );
  await env.DB.prepare(
    "UPDATE databases SET desired_state='suspended',suspension_reason='manual',observed_state='provisioning',observed_power='hibernated',observed_generation=generation WHERE id=?",
  )
    .bind(id)
    .run();
  return id;
}
const resume = (f: Fixture, id: string) =>
  request(`/v1/databases/${id}/resume`, f.integrator, "POST");
const available = (f: Fixture, mib: number) =>
  env.DB.prepare(
    "UPDATE node_samples SET memory_available_bytes=? WHERE node_id=?",
  )
    .bind(mib * MIB, f.node)
    .run();

describe("resume asks whether the database's node can start it", () => {
  it("is accepted while the node has the database's memory above its floor, and refused one MiB short", async () => {
    const f = await fixture(4096),
      id = await suspended(f);
    await available(f, 512 + MEMORY_FLOOR_MIB - 1);
    expect(await refusal(await resume(f, id))).toEqual({
      status: 409,
      code: "conflict",
      reason: "node_capacity",
      retryAfter: "30",
    });
    expect(
      await env.DB.prepare("SELECT desired_state FROM databases WHERE id=?")
        .bind(id)
        .first("desired_state"),
    ).toBe("suspended");
    await available(f, 512 + MEMORY_FLOOR_MIB);
    const accepted = await resume(f, id);
    expect(accepted.status).toBe(202);
    expect(
      DatabaseWithOperation.parse(await accepted.json()).database.desired_state,
    ).toBe("running");
  });

  it("counts the database's own memory", async () => {
    const f = await fixture(4096),
      id = await suspended(f);
    await env.DB.prepare("UPDATE databases SET own_memory_mib=2048 WHERE id=?")
      .bind(id)
      .run();
    await available(f, 2048 + MEMORY_FLOOR_MIB - 1);
    expect((await resume(f, id)).status).toBe(409);
    await available(f, 2048 + MEMORY_FLOOR_MIB);
    expect((await resume(f, id)).status).toBe(202);
  });

  it("is refused while the node has no room in its pool or has not reported for 180 s", async () => {
    const f = await fixture(4096),
      id = await suspended(f);
    await env.DB.prepare("UPDATE node_samples SET room=0 WHERE node_id=?")
      .bind(f.node)
      .run();
    expect((await resume(f, id)).status).toBe(409);
    await env.DB.prepare(
      "UPDATE node_samples SET room=1,observed_at=? WHERE node_id=?",
    )
      .bind(new Date(Date.now() - 181_000).toISOString(), f.node)
      .run();
    expect((await resume(f, id)).status).toBe(409);
    await env.DB.prepare(
      "UPDATE node_samples SET observed_at=? WHERE node_id=?",
    )
      .bind(new Date(Date.now() - 170_000).toISOString(), f.node)
      .run();
    expect((await resume(f, id)).status).toBe(202);
  });
});
