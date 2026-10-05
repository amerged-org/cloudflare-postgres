// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import type { NodeAddition } from "@pgcf/contracts/nodes";
import {
  configureNodeRegionPolicy,
  markNodeLost,
  readNodeAddition,
  recordNodeReceipt,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import {
  reconcileNodeProvider,
  dispatchNodeOrder,
} from "../../src/workflows/add-node.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(cleanupFixtures);
async function lost() {
  const f = await fixture();
  const provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  const uid = crypto.randomUUID();
  await env.DB.prepare(
    "UPDATE nodes SET provider_instance_id=?,node_uid=? WHERE id=?",
  )
    .bind(provider, uid, f.node)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
  });
  await markNodeLost(env.DB, f.node, {
    expected_node_uid: uid,
    reason: "confirmed test loss",
  });
  const request = () => ({
    mode: "recover" as const,
    region_id: f.region,
    provider_instance_id: provider,
    predecessor_node_id: f.node,
    expected_node_uid: uid,
  });
  return { ...f, provider, uid, request };
}

it("reserves one UID-bound recovery on the same lost provider with a new install identity and stable replay", async () => {
  const f = await lost();
  const key = crypto.randomUUID();
  const tombstone = await env.DB.prepare("SELECT * FROM nodes WHERE id=?")
    .bind(f.node)
    .first();
  const recovered = await reserveNodeAddition(env.DB, {
    request_key: key,
    request: f.request(),
  });
  expect(recovered.intent.node_id).not.toBe(f.node);
  expect(recovered.intent.request).toEqual(f.request());
  expect(recovered.approval).toBeNull();
  expect(recovered.dispatch_request_id).toBeNull();
  expect(recovered.checkpoint).toBeNull();
  expect(
    await reserveNodeAddition(env.DB, {
      request_key: key,
      request: f.request(),
    }),
  ).toEqual(recovered);
  const receipt = {
    provider_instance_id: f.provider,
    request_id: null,
    reference: "verified-existing-instance",
    received_at: new Date().toISOString(),
  };
  const bound = await recordNodeReceipt(
    env.DB,
    recovered.intent.operation_id,
    recovered.revision,
    receipt,
  );
  expect(bound.provider_instance_id).toBe(f.provider);
  expect(bound.status).toBe("provider_bound");
  expect(
    await env.DB.prepare("SELECT * FROM nodes WHERE id=?").bind(f.node).first(),
  ).toEqual(tombstone);
  await expect(
    reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: {
        mode: "adopt",
        region_id: f.region,
        provider_instance_id: f.provider,
      },
    }),
  ).rejects.toMatchObject({ code: "capacity_unavailable" });
});

it("keeps recovery administrator-only and publishes its required identity in OpenAPI", async () => {
  const f = await lost();
  const response = await request(
    "/v1/nodes/additions",
    f.integrator,
    "POST",
    f.request(),
    crypto.randomUUID(),
  );
  expect(response.status).toBe(403);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM node_additions WHERE region_id=?",
    )
      .bind(f.region)
      .first("count"),
  ).toBe(0);
  const spec = (await (await request("/v1/openapi.json", f.admin)).json()) as {
    paths: Record<
      string,
      {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  oneOf: {
                    properties: Record<string, { enum?: string[] }>;
                    required: string[];
                  }[];
                };
              };
            };
          };
        };
      }
    >;
  };
  const recover = spec.paths["/v1/nodes/additions"]!.post.requestBody.content[
    "application/json"
  ].schema.oneOf.find((choice) =>
    choice.properties.mode?.enum?.includes("recover"),
  );
  expect(recover?.required).toEqual(
    expect.arrayContaining([
      "region_id",
      "mode",
      "provider_instance_id",
      "predecessor_node_id",
      "expected_node_uid",
    ]),
  );
});

it("refuses wrong UID, provider, region and a healthy predecessor without reserving state", async () => {
  const f = await lost();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.foreign,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
  });
  for (const request of [
    { ...f.request(), expected_node_uid: crypto.randomUUID() },
    { ...f.request(), provider_instance_id: f.provider + "1" },
    { ...f.request(), region_id: f.foreign },
  ])
    await expect(
      reserveNodeAddition(env.DB, {
        request_key: crypto.randomUUID(),
        request,
      }),
    ).rejects.toMatchObject({ code: "capacity_unavailable" });
  const other = await fixture();
  const otherUid = crypto.randomUUID();
  await configureNodeRegionPolicy(env.DB, {
    region_id: other.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
  });
  await env.DB.prepare(
    "UPDATE nodes SET provider_instance_id=?,node_uid=? WHERE id=?",
  )
    .bind(f.provider + "2", otherUid, other.node)
    .run();
  await expect(
    reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: {
        ...f.request(),
        region_id: other.region,
        provider_instance_id: f.provider + "2",
        predecessor_node_id: other.node,
        expected_node_uid: otherUid,
      },
    }),
  ).rejects.toMatchObject({ code: "capacity_unavailable" });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM node_additions WHERE region_id IN(?,?)",
    )
      .bind(f.region, f.foreign)
      .first("count"),
  ).toBe(0);
});

it("allows only one concurrent recovery claim and cannot bind another provider receipt", async () => {
  const f = await lost();
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      reserveNodeAddition(env.DB, {
        request_key: crypto.randomUUID(),
        request: f.request(),
      }),
    ),
  );
  const successful = results.filter((result) => result.status === "fulfilled");
  expect(successful).toHaveLength(1);
  const addition = (successful[0] as PromiseFulfilledResult<NodeAddition>)
    .value;
  await expect(
    recordNodeReceipt(env.DB, addition.intent.operation_id, addition.revision, {
      provider_instance_id: f.provider + "1",
      request_id: null,
      reference: "foreign",
      received_at: new Date().toISOString(),
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    (await readNodeAddition(env.DB, addition.intent.operation_id))
      .provider_instance_id,
  ).toBeNull();
});

it("uses provider inventory readback for recovery and never dispatches a purchase", async () => {
  const f = await lost();
  const addition = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: f.request(),
  });
  let orders = 0;
  await dispatchNodeOrder(env, addition.intent.operation_id, {
    order: async () => {
      orders++;
      throw new Error("unexpected_purchase");
    },
  });
  expect(orders).toBe(0);
  await reconcileNodeProvider(env, addition.intent.operation_id, {
    getInstance: async () =>
      ({
        id: f.provider,
        region: "test",
        productId: "existing",
        imageId: crypto.randomUUID(),
      }) as never,
    instanceAudits: async () => [],
  });
  const current = await readNodeAddition(env.DB, addition.intent.operation_id);
  expect(current.provider_instance_id).toBe(f.provider);
  expect(current.status).toBe("audited");
  expect(current.dispatch_request_id).toBeNull();
  expect(orders).toBe(0);
});
