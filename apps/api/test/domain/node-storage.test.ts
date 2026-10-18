// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import type { NodeObservation, NodeStorageSample } from "@pgcf/contracts";
import {
  recordNodeStorageObservation,
  readNodeStorageObservation,
} from "../../src/domain/node-storage.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(cleanupFixtures);
async function subject() {
  const f = await fixture(),
    provider = "12345";
  await env.DB.prepare("UPDATE nodes SET provider_instance_id=? WHERE id=?")
    .bind(provider, f.node)
    .run();
  const uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string>("node_uid");
  const node: NodeObservation = {
    node_id: f.node,
    node_uid: uid!,
    provider_instance_id: provider,
    name: f.nodeName,
    ready: true,
    allocatable_memory_mib: 8192,
    allocatable_cpu_millicores: 3000,
    storage_gib_total: 95,
    platform_reserved_memory_mib: 128,
  };
  const sample: NodeStorageSample = {
    node_uid: uid!,
    observed_at: new Date().toISOString(),
    physical: {
      volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
      total_bytes: 1000,
      free_bytes: 700,
      thick_allocated_bytes: 300,
      thin_pool: null,
    },
  };
  return { f, node, sample };
}

it("persists fresh physical facts only for the current exact regional node and clears unknown", async () => {
  const { f, node, sample } = await subject(),
    now = Date.now();
  expect(
    await recordNodeStorageObservation(env.DB, f.region, node, sample, now),
  ).toBe(true);
  expect(
    await readNodeStorageObservation(env.DB, f.region, f.node, now),
  ).toEqual(sample);
  expect(
    await recordNodeStorageObservation(
      env.DB,
      f.foreign,
      node,
      { ...sample, observed_at: new Date(now + 1).toISOString() },
      now,
    ),
  ).toBe(false);
  expect(
    await recordNodeStorageObservation(
      env.DB,
      f.region,
      { ...node, node_uid: undefined },
      sample,
      now,
    ),
  ).toBe(false);
  expect(
    await recordNodeStorageObservation(
      env.DB,
      f.region,
      node,
      { ...sample, physical: null },
      now,
    ),
  ).toBe(false);
  const unavailable = {
    ...sample,
    observed_at: new Date(now + 2).toISOString(),
    physical: null,
  };
  expect(
    await recordNodeStorageObservation(
      env.DB,
      f.region,
      node,
      unavailable,
      now,
    ),
  ).toBe(true);
  expect(
    await readNodeStorageObservation(env.DB, f.region, f.node, now),
  ).toEqual(unavailable);
});

it("stale, future and replaced node identities never become fresh physical capacity", async () => {
  const { f, node, sample } = await subject(),
    now = Date.now();
  expect(
    await recordNodeStorageObservation(
      env.DB,
      f.region,
      node,
      { ...sample, observed_at: new Date(now - 120001).toISOString() },
      now,
    ),
  ).toBe(false);
  expect(
    await recordNodeStorageObservation(
      env.DB,
      f.region,
      node,
      { ...sample, observed_at: new Date(now + 5001).toISOString() },
      now,
    ),
  ).toBe(false);
  expect(
    await recordNodeStorageObservation(env.DB, f.region, node, sample, now),
  ).toBe(true);
  expect(
    await readNodeStorageObservation(env.DB, f.region, f.node, now + 120001),
  ).toBeNull();
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.node)
    .run();
  expect(
    await recordNodeStorageObservation(
      env.DB,
      f.region,
      node,
      { ...sample, observed_at: new Date(now + 1).toISOString() },
      now,
    ),
  ).toBe(false);
  expect(
    await readNodeStorageObservation(env.DB, f.region, f.node, now),
  ).toBeNull();
});

it("serves the recorded physical facts of a node to administrators only", async () => {
  const { f, node, sample } = await subject();
  const path = `/v1/nodes/${f.node}/storage`;
  expect(
    await recordNodeStorageObservation(
      env.DB,
      f.region,
      node,
      sample,
      Date.now(),
    ),
  ).toBe(true);
  const readback = await request(path, f.admin);
  expect(readback.status).toBe(200);
  expect(await readback.json()).toEqual({
    node_id: f.node,
    region_id: f.region,
    sample,
  });
  expect((await request(path, f.integrator)).status).toBe(403);
  // A report of another install of the node is not this node's: the sample is withheld.
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.node)
    .run();
  expect(
    ((await (await request(path, f.admin)).json()) as { sample: unknown })
      .sample,
  ).toBeNull();
});
