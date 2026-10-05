// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import type { NodeAddition } from "@pgcf/contracts/nodes";
import { afterEach, expect, it } from "vitest";
import {
  completeNodeAddition,
  configureNodeRegionPolicy,
  markNodeLost,
  nodeRegionOccupiedSlots,
  readNodeAddition,
  recordNodeAudit,
  recordNodeReceipt,
  reserveNodeAddition,
  saveNodeBootstrapCheckpoint,
  verifyNodeCapacity,
  verifyNodeNetwork,
} from "../../src/domain/node-state.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(cleanupFixtures);
type NodeRow = Record<string, string | number | null>;
const reference = () => `fixture-${crypto.randomUUID()}`;
const readNode = (id: string) =>
  env.DB.prepare("SELECT * FROM nodes WHERE id=?").bind(id).first<NodeRow>();

async function publish(
  reserved: NodeAddition,
  provider: string,
  uid: string,
  previous?: NodeRow,
) {
  let addition = await recordNodeReceipt(
    env.DB,
    reserved.intent.operation_id,
    reserved.revision,
    {
      provider_instance_id: provider,
      request_id: null,
      reference: reference(),
      received_at: new Date().toISOString(),
    },
  );
  addition = await recordNodeAudit(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: provider,
      provider_region: "test",
      product_id: "existing-product",
      image_id: crypto.randomUUID(),
      reference: reference(),
      observed_at: new Date().toISOString(),
    },
  );
  addition = await saveNodeBootstrapCheckpoint(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      stage: "joined",
      reference: reference(),
      saved_at: new Date().toISOString(),
    },
  );
  const now = new Date().toISOString();
  const observed: NodeRow = {
    ...previous,
    id: addition.intent.node_id,
    region_id: addition.intent.request.region_id,
    k8s_node_name: addition.intent.requested_hostname,
    provider_instance_id: provider,
    node_uid: uid,
    ready: 1,
    schedulable: 0,
    allocatable_memory_mib: 8192,
    allocatable_cpu_millicores: 4000,
    storage_gib_total: 80,
    platform_reserved_memory_mib: 128,
    platform_reserved_cpu_millicores: 500,
    last_observed_at: now,
    created_at: now,
    updated_at: now,
    lost_at: null,
    lost_reason: null,
  };
  await env.DB.prepare(
    `INSERT INTO nodes(${Object.keys(observed).join(",")}) VALUES(${Object.keys(
      observed,
    )
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...Object.values(observed))
    .run();
  const scope = {
    operation_id: addition.intent.operation_id,
    node_id: addition.intent.node_id,
    intent_hash: addition.intent_hash,
    checkpoint_reference: addition.checkpoint!.reference,
    proof_reference: reference(),
  };
  addition = await verifyNodeNetwork(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    { ...scope, verified_at: now },
  );
  addition = await verifyNodeCapacity(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      ...scope,
      observed_at: now,
      allocatable_memory_mib: 8192,
      allocatable_cpu_millicores: 4000,
      storage_gib_total: 80,
      platform_reserved_memory_mib: 128,
      platform_reserved_cpu_millicores: 500,
    },
  );
  return completeNodeAddition(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
  );
}

it("recovers completed same-provider history and chains a later loss without rewriting either predecessor", async () => {
  const f = await fixture(),
    provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!),
    originalUid = crypto.randomUUID(),
    replacementUid = crypto.randomUUID();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
  });
  const original = await publish(
    await reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: {
        mode: "adopt",
        region_id: f.region,
        provider_instance_id: provider,
      },
    }),
    provider,
    originalUid,
  );
  expect(original.status).toBe("ready");
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
  await markNodeLost(env.DB, original.intent.node_id, {
    expected_node_uid: originalUid,
    reason: "confirmed original loss",
  });
  const originalTombstone = (await readNode(original.intent.node_id))!;
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(1);
  const recoverOriginal = {
    mode: "recover" as const,
    region_id: f.region,
    provider_instance_id: provider,
    predecessor_node_id: original.intent.node_id,
    expected_node_uid: originalUid,
  };
  const reserved = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: recoverOriginal,
  });
  expect(reserved.checkpoint).toBeNull();
  expect(reserved.intent.node_id).not.toBe(original.intent.node_id);
  expect(reserved.intent.operation_id).not.toBe(original.intent.operation_id);
  expect(reserved.intent.requested_hostname).not.toBe(
    original.intent.requested_hostname,
  );
  const replacement = await publish(
    reserved,
    provider,
    replacementUid,
    originalTombstone,
  );
  expect(replacement.status).toBe("ready");
  expect(replacement.checkpoint!.reference).not.toBe(
    original.checkpoint!.reference,
  );
  expect(await readNode(original.intent.node_id)).toEqual(originalTombstone);
  expect(await readNodeAddition(env.DB, original.intent.operation_id)).toEqual(
    original,
  );
  expect(await readNode(replacement.intent.node_id)).toMatchObject({
    node_uid: replacementUid,
    provider_instance_id: provider,
    ready: 1,
    schedulable: 1,
    lost_at: null,
  });
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);

  await markNodeLost(env.DB, replacement.intent.node_id, {
    expected_node_uid: replacementUid,
    reason: "confirmed replacement loss",
  });
  const replacementTombstone = await readNode(replacement.intent.node_id);
  await expect(
    reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: recoverOriginal,
    }),
  ).rejects.toMatchObject({ code: "capacity_unavailable" });
  const recoverReplacement = {
    ...recoverOriginal,
    predecessor_node_id: replacement.intent.node_id,
    expected_node_uid: replacementUid,
  };
  await expect(
    reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: { ...recoverReplacement, expected_node_uid: originalUid },
    }),
  ).rejects.toMatchObject({ code: "capacity_unavailable" });
  const chained = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: recoverReplacement,
  });
  expect(chained.intent.node_id).not.toBe(replacement.intent.node_id);
  expect(chained.checkpoint).toBeNull();
  const bound = await recordNodeReceipt(
    env.DB,
    chained.intent.operation_id,
    chained.revision,
    {
      provider_instance_id: provider,
      request_id: null,
      reference: reference(),
      received_at: new Date().toISOString(),
    },
  );
  expect(bound.status).toBe("provider_bound");
  expect(await nodeRegionOccupiedSlots(env.DB, f.region)).toBe(2);
  expect(await readNode(original.intent.node_id)).toEqual(originalTombstone);
  expect(await readNode(replacement.intent.node_id)).toEqual(
    replacementTombstone,
  );
  expect(await readNodeAddition(env.DB, original.intent.operation_id)).toEqual(
    original,
  );
  expect(
    await readNodeAddition(env.DB, replacement.intent.operation_id),
  ).toEqual(replacement);
  expect(
    (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
});
