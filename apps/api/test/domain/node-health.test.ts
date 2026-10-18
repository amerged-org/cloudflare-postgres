// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, newNodeId } from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  placePendingDatabases,
  runNodeCapacity,
} from "../../src/domain/node-capacity.ts";
import {
  configureNodeRegionPolicy,
  nodeRegionOccupiedSlots,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import { patchSample, reports } from "./node-samples.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

it("rechecks node freshness inside pending placement's atomic reservation", async () => {
  const f = await fixture(0);
  const pending = DatabaseWithOperation.parse(await (await f.create()).json());
  await reports(f.node);
  const prototype = Object.getPrototypeOf(env.DB);
  const batch = prototype.batch;
  const spy = vi
    .spyOn(prototype, "batch")
    .mockImplementationOnce(async function (statements) {
      await patchSample(f.node, {
        observedAt: new Date(Date.now() - 180_001).toISOString(),
      });
      return batch.call(env.DB, statements);
    });
  expect(await placePendingDatabases(env.DB, f.region)).toEqual([]);
  spy.mockRestore();
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(pending.database.id)
      .first("node_id"),
  ).toBeNull();
});

it("marks a node lost with its exact UID and preserves its recovery identity and paid allocation", async () => {
  const f = await fixture();
  const uid = crypto.randomUUID();
  const provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=? WHERE id=?",
  )
    .bind(uid, provider, f.node)
    .run();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const source = await env.DB.prepare(
    "SELECT node_id,archive_path,generation FROM databases WHERE id=?",
  )
    .bind(created.database.id)
    .first();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 1,
    purchases_enabled: false,
    order: null,
  });
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(1);
  const path = `/v1/nodes/${f.node}/mark-lost`;
  expect(
    (
      await request(`/v1/nodes/${newNodeId()}/mark-lost`, f.admin, "POST", {
        expected_node_uid: uid,
        reason: "confirmed loss",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(path, f.integrator, "POST", {
        expected_node_uid: uid,
        reason: "confirmed loss",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(path, f.admin, "POST", {
        expected_node_uid: crypto.randomUUID(),
        reason: "confirmed loss",
      })
    ).status,
  ).toBe(409);
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(1);
  const loss = await request(path, f.admin, "POST", {
    expected_node_uid: uid,
    reason: "confirmed loss",
  });
  expect(loss.status).toBe(200);
  const record = await loss.json();
  const replay = await request(path, f.admin, "POST", {
    expected_node_uid: uid,
    reason: "different replay explanation",
  });
  expect(await replay.json()).toEqual(record);
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT node_id,archive_path,generation FROM databases WHERE id=?",
    )
      .bind(created.database.id)
      .first(),
  ).toEqual(source);
  expect(
    await env.DB.prepare(
      "SELECT node_uid,provider_instance_id,ready,schedulable FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual({
    node_uid: uid,
    provider_instance_id: provider,
    ready: 0,
    schedulable: 0,
  });
  await expect(
    env.DB.prepare("UPDATE nodes SET lost_at=NULL WHERE id=?")
      .bind(f.node)
      .run(),
  ).rejects.toThrow("lost_node_identity_immutable");
  await expect(
    reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: {
        region_id: f.region,
        mode: "adopt",
        provider_instance_id: provider,
      },
    }),
  ).rejects.toMatchObject({ code: "capacity_unavailable" });
  await expect(
    reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: {
        region_id: f.region,
        mode: "adopt",
        provider_instance_id: String(
          1 + crypto.getRandomValues(new Uint32Array(1))[0]!,
        ),
      },
    }),
  ).rejects.toMatchObject({ code: "capacity_unavailable" });
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(1);
  await request(path, f.admin, "POST", {
    expected_node_uid: uid,
    reason: "replayed",
  });
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(1);
  await expect(
    reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: {
        region_id: f.region,
        mode: "adopt",
        provider_instance_id: String(
          1 + crypto.getRandomValues(new Uint32Array(1))[0]!,
        ),
      },
    }),
  ).rejects.toMatchObject({ code: "capacity_unavailable" });
});

it("does not turn stale observations into automatic paid replacement intent", async () => {
  const f = await fixture();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: true,
    order: {
      product_id: "fixture",
      provider_region: "test",
      image_id: crypto.randomUUID(),
      term_months: 1,
      location: "fixture location",
    },
  });
  await env.DB.prepare(
    "UPDATE node_region_policies SET autoscale_enabled=1 WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  await patchSample(f.node, {
    observedAt: new Date(Date.now() - 180_001).toISOString(),
  });
  expect((await runNodeCapacity(env, f.region)).action).toBe(
    "observations_stale",
  );
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_additions WHERE region_id=?",
    )
      .bind(f.region)
      .first("count"),
  ).toBe(0);
});
