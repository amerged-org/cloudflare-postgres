// SPDX-License-Identifier: Apache-2.0
// The hint of a claimed wake carries the desired page of its one database, so the controller can
// apply it without pulling it. Real D1, Durable Object and WebSocket harness; no live evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  DatabaseWithOperation,
  DesiredResponse,
  LinkDesiredHint,
  newOperationId,
} from "@pgcf/contracts";
import { cleanupFixtures, request } from "./fixtures.ts";
import {
  actor,
  readyBody,
  registered,
  sleeping,
  untilWake,
} from "./wake-fixture.ts";
import { awakeWriter, claimsOf, parkedWriter } from "./parked-tier-fixture.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  admissionFixtureReleases,
  admissionSnapshotFixture,
} from "./admission-snapshot-fixture.ts";
import { wakeHintPage } from "../../src/domain/desired.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of [
    ...releases.splice(0),
    ...admissionFixtureReleases.splice(0),
  ])
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

/** An authenticated controller on the region's link, collecting every hint it receives. */
async function agentOnLink(region: string) {
  const stub = env.REGION_LINK.get(env.REGION_LINK.idFromName(region));
  const response = await stub.fetch(
    new Request(`https://${["link", "invalid"].join(".")}/agent/v1/link`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const messages: unknown[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      agent_version: "test",
      instance_id: crypto.randomUUID(),
    }),
  );
  await vi.waitFor(() =>
    expect(messages).toEqual([{ type: "welcome", protocol: 1 }]),
  );
  messages.length = 0;
  return { socket, messages };
}
const resume = async (id: string, key: string) =>
  DatabaseWithOperation.parse(
    await (
      await request(
        `/v1/databases/${id}/resume`,
        key,
        "POST",
        undefined,
        crypto.randomUUID(),
      )
    ).json(),
  );
/** The page a targeted pull of `id` reads: the region's page with that database alone. */
const pulled = async (agent: string, id: string) => {
  const page = DesiredResponse.parse(
    await (await request("/agent/v1/desired", agent)).json(),
  );
  return {
    ...page,
    databases: page.databases.filter((database) => database.id === id),
    next: null,
  };
};

it("the hint of a claimed wake carries the page a targeted pull reads for its database", async () => {
  const f = await sleeping();
  const link = await agentOnLink(f.region);
  const waiterId = crypto.randomUUID();
  const waiting = actor(f.id).ensureAwake(f.id, "app", {
    waiterId,
    deadline: Date.now() + 20_000,
  });
  const row = await untilWake(f.id);
  await registered(f.id, waiterId);
  await vi.waitFor(() => expect(link.messages).toHaveLength(1), {
    timeout: 10_000,
  });
  const hint = LinkDesiredHint.parse(link.messages[0]);
  expect(hint).toEqual({
    type: "desired",
    ids: [f.id],
    desired: await pulled(f.agent, f.id),
  });
  expect(hint.desired!.databases[0]).toMatchObject({
    generation: row.generation,
    desired_state: "running",
    power: { operation: row.power_operation, mode: "running" },
  });
  link.socket.close(1000);
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    readyBody(f, row.power_operation),
  );
  expect(await waiting).toMatchObject({ ok: true });
}, 30_000);

it("a parked thin wake's page carries its startup hold, write token and admission as the page serves them", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  await parkedWriter(w, "fast");
  const wake = await resume(w.id, w.f.integrator);
  const hinted = (await wakeHintPage(env, w.f.region, w.id, {
    operation: wake.operation.id,
    revision: wake.database.generation,
  }))!;
  const page = await pulled(w.f.agent, w.id);
  const [carried] = hinted.databases,
    [served] = page.databases;
  expect(carried!.storage_startup).toMatchObject({
    operation_id: wake.operation.id,
    generation: wake.database.generation,
  });
  expect(carried!.storage_authority).toMatch(/^sa1\./);
  // The token is signed when the page is read; everything it states but its issue and expiry is equal.
  const scope = (token: string | undefined) => ({
    ...claimsOf(token)!,
    iat: undefined,
    exp: undefined,
  });
  expect(scope(carried!.storage_authority)).toEqual(
    scope(served!.storage_authority),
  );
  const unsigned = (database: typeof carried) => ({
    ...database,
    storage_authority: undefined,
  });
  expect(unsigned(carried)).toEqual(unsigned(served));
  expect({ ...hinted, databases: [] }).toEqual({ ...page, databases: [] });
}, 30_000);

it("a wake's page in an admission-capable region carries the admission epoch and route the page serves", async () => {
  const f = await admissionSnapshotFixture();
  expect(
    (
      await request(
        `/v1/databases/${f.id}/suspend`,
        f.integrator,
        "POST",
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(202);
  const wake = await resume(f.id, f.integrator);
  const hinted = await wakeHintPage(env, f.region, f.id, {
    operation: wake.operation.id,
    revision: wake.database.generation,
  });
  expect(hinted!.databases[0]!.admission).toMatchObject({ v: 1 });
  expect(hinted).toEqual(await pulled(f.agent, f.id));
}, 30_000);

it("carries no page for another region, a deleted database or a revision that is not the claimed wake", async () => {
  const f = await sleeping();
  const wake = await resume(f.id, f.integrator);
  const claim = {
    operation: wake.operation.id,
    revision: wake.database.generation,
  };
  expect((await wakeHintPage(env, f.region, f.id, claim))!.databases).toEqual(
    (await pulled(f.agent, f.id)).databases,
  );
  expect(await wakeHintPage(env, f.foreign, f.id, claim)).toBeUndefined();
  expect(
    await wakeHintPage(env, f.region, f.id, {
      ...claim,
      revision: claim.revision - 1,
    }),
  ).toBeUndefined();
  expect(
    await wakeHintPage(env, f.region, f.id, {
      ...claim,
      operation: newOperationId(),
    }),
  ).toBeUndefined();
  expect(
    (
      await request(
        `/v1/databases/${f.id}`,
        f.integrator,
        "DELETE",
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(202);
  const deleted = (await env.DB.prepare(
    "SELECT generation,power_operation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<{ generation: number; power_operation: string | null }>())!;
  for (const revision of [claim.revision, deleted.generation])
    expect(
      await wakeHintPage(env, f.region, f.id, { ...claim, revision }),
    ).toBeUndefined();
}, 30_000);
