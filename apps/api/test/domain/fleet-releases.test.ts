// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  FleetNodeReleaseStatus,
  FleetRegionReleaseStatus,
} from "@pgcf/contracts/releases";
import {
  cleanupFixtures,
  fixture,
  nodeSample,
  releaseSpec,
  request,
} from "./fixtures.ts";
import { NODE_HEADER, NODE_UID_HEADER } from "../../src/node-actor.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
async function setup() {
  const f = await fixture(),
    id = `release-${crypto.randomUUID()}`,
    value = releaseSpec();
  releases.push(id);
  const approve = (body: unknown = value, key?: string) =>
    request(`/v1/fleet/releases/${id}`, f.admin, "PUT", body, key);
  const assign = (revision = 0, release = id) =>
    request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
      expected_revision: revision,
      release_id: release,
    });
  const status = async () =>
    FleetNodeReleaseStatus.parse(
      await (await request(`/v1/nodes/${f.node}/release`, f.admin)).json(),
    );
  return { ...f, id, value, approve, assign, status };
}
/** A node says hello over its link, naming the release it runs, and sends its first sample. */
async function hello(
  f: Awaited<ReturnType<typeof setup>>,
  release: string | null,
  sampleAt = Date.now() - 1000,
) {
  const stub = env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(f.node));
  const response = await stub.fetch(
    new Request(`https://${["link", "invalid"].join(".")}/node/v1/link`, {
      headers: {
        Upgrade: "websocket",
        [NODE_HEADER]: f.node,
        [NODE_UID_HEADER]: f.nodeUid,
      },
    }),
  );
  const socket = response.webSocket!;
  socket.accept();
  const welcome = new Promise<void>((resolve) =>
    socket.addEventListener("message", () => resolve(), { once: true }),
  );
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      agent_version: "0.1.0",
      release_id: release,
    }),
  );
  await welcome;
  socket.send(JSON.stringify({ type: "sample", sample: nodeSample(sampleAt) }));
  for (let i = 0; i < 200; i++) {
    const row = await env.DB.prepare(
      "SELECT last_sample_json FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first<{ last_sample_json: string | null }>();
    if (row?.last_sample_json) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return socket;
}

it("approves immutable releases with idempotent replay and rejects a changed one", async () => {
  const f = await setup(),
    key = crypto.randomUUID();
  const first = await f.approve(f.value, key);
  expect(first.status).toBe(200);
  const result = await first.json();
  expect(await (await f.approve(f.value, key)).json()).toEqual(result);
  expect(await (await f.approve()).json()).toEqual(result);
  const changed = structuredClone(f.value);
  changed.binaries["pgcf-agent"].sha256 = "e".repeat(64);
  expect((await f.approve(changed)).status).toBe(409);
  expect((await request(`/v1/fleet/releases/${f.id}`, f.admin)).status).toBe(
    200,
  );
  expect((await f.assign(0, "missing")).status).toBe(404);
  await expect(
    env.DB.prepare("UPDATE fleet_releases SET spec_json='{}' WHERE id=?")
      .bind(f.id)
      .run(),
  ).rejects.toThrow();
});

it("refuses a release of the old spec, an unknown field and an unpinned download", async () => {
  const f = await setup();
  for (const body of [
    { ...f.value, version: 1 },
    { ...f.value, roles: {} },
    { ...f.value, route_token_version: 6 },
    {
      ...f.value,
      binaries: {
        ...f.value.binaries,
        "pgcf-agent": { ...f.value.binaries["pgcf-agent"], sha256: "latest" },
      },
    },
    { ...f.value, os: { ...f.value.os, debian_snapshot: "today" } },
    {},
  ])
    expect((await f.approve(body)).status).toBe(400);
});

it("enforces admin scope and the revision compare-and-set of a region's release", async () => {
  const f = await setup();
  expect(
    (await request(`/v1/fleet/releases/${f.id}`, f.integrator, "PUT", f.value))
      .status,
  ).toBe(403);
  expect((await request(`/v1/fleet/releases/${f.id}`, "invalid")).status).toBe(
    401,
  );
  expect((await f.assign()).status).toBe(404);
  expect((await f.approve()).status).toBe(200);
  expect(
    FleetRegionReleaseStatus.parse(
      await (await request(`/v1/regions/${f.region}/release`, f.admin)).json(),
    ),
  ).toMatchObject({ revision: 0, desired_release_id: null });
  const key = crypto.randomUUID();
  const assign = () =>
    request(
      `/v1/regions/${f.region}/release`,
      f.admin,
      "PUT",
      { expected_revision: 0, release_id: f.id },
      key,
    );
  expect((await assign()).status).toBe(200);
  expect((await assign()).status).toBe(200);
  expect(
    FleetRegionReleaseStatus.parse(
      await (await request(`/v1/regions/${f.region}/release`, f.admin)).json(),
    ),
  ).toMatchObject({ revision: 1, desired_release_id: f.id });
  expect((await f.assign(0)).status).toBe(409);
  expect((await f.assign(7)).status).toBe(409);
  expect(
    (await request(`/v1/regions/${f.foreign}/release`, f.admin)).status,
  ).toBe(200);
  expect(
    (await request("/v1/regions/eu-unknown/release", f.admin)).status,
  ).toBe(404);
});

it("elects one of two competing assignments", async () => {
  const f = await setup();
  await f.approve();
  const responses = await Promise.all([f.assign(0), f.assign(9)]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
});

it("tells the region's nodes to pull the page that names the release", async () => {
  const f = await setup();
  await f.approve();
  const stub = env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(f.node));
  const socket = await hello(f, null);
  const hint = new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    }),
  );
  expect((await f.assign()).status).toBe(200);
  expect(JSON.parse(await hint)).toEqual({ type: "desired" });
  expect((await stub.latest()).connected).toBe(true);
  socket.close(1000);
});

it("converges a node when it runs the release of its region and its link is fresh", async () => {
  const f = await setup();
  expect(await f.status()).toMatchObject({
    state: "unassigned",
    desired_release_id: null,
  });
  await f.approve();
  await f.assign();
  // The node has not said hello with the release yet.
  expect(await f.status()).toMatchObject({
    state: "pending",
    desired_release_id: f.id,
    observed_release_id: null,
  });
  const socket = await hello(f, f.id);
  const converged = await f.status();
  expect(converged).toMatchObject({
    state: "converged",
    node_uid: f.nodeUid,
    desired_release_id: f.id,
    observed_release_id: f.id,
  });
  expect(converged.desired_spec_sha256).toMatch(/^[0-9a-f]{64}$/);
  // A node that runs another release is pending, whatever its link says.
  const stub = env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(f.node));
  void stub;
  await env.DB.prepare(
    "UPDATE nodes SET reported_release_id='older' WHERE id=?",
  )
    .bind(f.node)
    .run();
  expect(await f.status()).toMatchObject({
    state: "pending",
    observed_release_id: "older",
  });
  // A link that has been silent for too long is stale, a lost node is fenced.
  await env.DB.prepare(
    "UPDATE nodes SET reported_release_id=?,last_observed_at=? WHERE id=?",
  )
    .bind(f.id, new Date(Date.now() - 181_000).toISOString(), f.node)
    .run();
  expect(await f.status()).toMatchObject({ state: "stale" });
  await env.DB.prepare(
    "UPDATE nodes SET last_observed_at=?,lost_at=?,lost_reason='test' WHERE id=?",
  )
    .bind(new Date().toISOString(), new Date().toISOString(), f.node)
    .run();
  expect(await f.status()).toMatchObject({ state: "fenced" });
  socket.close(1000);
});

it("shows the release and the link of every node in the inventory", async () => {
  const f = await setup();
  await f.approve();
  await f.assign();
  const socket = await hello(f, f.id);
  const listed = (await (await request("/v1/nodes", f.admin)).json()) as {
    data: {
      id: string;
      release: { state: string; desired_release_id: string };
      observation: { state: string; agent_version: string | null };
    }[];
  };
  const node = listed.data.find((entry) => entry.id === f.node)!;
  expect(node.release).toMatchObject({
    state: "converged",
    desired_release_id: f.id,
  });
  expect(node.observation).toMatchObject({
    state: "current",
    agent_version: "0.1.0",
  });
  expect((await request(`/v1/nodes/${f.node}`, f.admin)).status).toBe(200);
  socket.close(1000);
});

it("no longer assigns a release to a single node", async () => {
  const f = await setup();
  await f.approve();
  await f.assign();
  expect(
    (
      await request(`/v1/nodes/${f.node}/release`, f.admin, "PUT", {
        expected_revision: 0,
        release_id: f.id,
        node_uid: f.nodeUid,
      })
    ).status,
  ).toBe(404);
  expect(
    (await request("/node/v1/fleet-observations", f.admin, "POST", {})).status,
  ).toBe(401);
});
