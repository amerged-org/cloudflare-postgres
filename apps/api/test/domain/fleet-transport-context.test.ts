// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import { newOperationId } from "@pgcf/contracts";
import { installationHash } from "../../src/domain/node-installation.ts";
import { fleetPatchInput } from "../../src/domain/fleet-patches.ts";
import {
  BOOTSTRAP_RELAY_HEADER,
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  importBootstrapVerificationKeys,
  verifyBootstrapRelay,
} from "@pgcf/contracts/bootstrap-relay";
import { cleanupFixtures } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";

const releases: string[] = [],
  sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.close();
    } catch {
      /* The test peer may already have closed. */
    }
  }
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

async function setupTransport() {
  const f = await thinExecutionFixture(releases),
    op = newOperationId(),
    at = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_closed_at=? WHERE id=?",
  )
    .bind(at, f.node)
    .run();
  await env.DB.prepare(
    `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,host_configuration_revision,host_configuration_sha256,revision,stage,state,created_at,updated_at,deadline_at) VALUES(?,?,?,?,?,?,?,1,1,1,'192.0.2.18',?,?,?,0,'preflight','pending',?,?,?)`,
  )
    .bind(
      op,
      f.node,
      f.region,
      f.uid,
      f.authority.cluster_uid,
      f.qualified.releaseId,
      await installationHash(f.qualified.spec),
      JSON.stringify([
        {
          node_id: f.node,
          node_uid: f.uid,
          k8s_node_name: f.nodeName,
          assignment_revision: 1,
        },
      ]),
      f.host.revision,
      f.host.sha256,
      at,
      at,
      new Date(Date.now() + 60000).toISOString(),
    )
    .run();
  const input = await fleetPatchInput(f.local, op),
    epoch = crypto.randomUUID(),
    counts = { hostLoads: 0, identity: 0, opening: 0 },
    hooks: {
      identity?: () => Promise<void>;
      opening?: () => Promise<void>;
      pool?: () => Promise<void>;
    } = {};
  const keys = await importBootstrapVerificationKeys(
    JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
  );
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (
            sql ===
            "SELECT 1 version,* FROM node_host_configurations WHERE node_id=?"
          )
            counts.hostLoads++;
          const statement = target.prepare(sql);
          if (
            !sql.startsWith(
              "SELECT p.*,n.region_id FROM node_compute_pool_policies",
            )
          )
            return statement;
          const wrap = (selected: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(selected, {
              get(prepared, method) {
                if (method === "bind")
                  return (...params: unknown[]) =>
                    wrap(prepared.bind(...params));
                if (method === "first")
                  return async (...params: []) => {
                    const hook = hooks.pool;
                    hooks.pool = undefined;
                    await hook?.();
                    return prepared.first(...params);
                  };
                const value = Reflect.get(prepared, method);
                return typeof value === "function"
                  ? value.bind(prepared)
                  : value;
              },
            });
          return wrap(statement);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = {
    ...f.local,
    DB: database,
    BOOTSTRAP_RELAY_ISSUER_REGION: f.region,
    BOOTSTRAP_RELAY_URL: `https://relay.invalid${BOOTSTRAP_RELAY_PATH}`,
    BOOTSTRAP_RELAY_SERVICE: {
      async fetch(request: Request) {
        if (new URL(request.url).pathname === BOOTSTRAP_RELAY_IDENTITY_PATH) {
          counts.identity++;
          await hooks.identity?.();
          return Response.json({
            v: 1,
            region: f.region,
            issuer_region: f.region,
            relay_epoch: epoch,
            allowed_target_regions: [f.region],
            capabilities: ["talos_api", "kubernetes_api"],
          });
        }
        const checked = await verifyBootstrapRelay(
          request.headers.get(BOOTSTRAP_RELAY_HEADER),
          {
            keys,
            region: f.region,
            issuer_region: f.region,
            relay_epoch: epoch,
            allowedTargetRegions: [f.region],
          },
        );
        expect(checked.ok).toBe(true);
        counts.opening++;
        await hooks.opening?.();
        const pair = new WebSocketPair();
        pair[1].accept();
        sockets.push(pair[1]);
        return new Response(null, { status: 101, webSocket: pair[0] });
      },
    },
  } as unknown as Env;
  const app = createApp(),
    callback = input.callback.url,
    headers = {
      authorization: `Bearer ${input.callback.bearer}`,
      "content-type": "application/json",
    };
  const grant = () =>
    app.request(
      callback,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "transport", capability: "talos_api" }),
      },
      runtime,
    );
  const open = (token: string) =>
    app.request(
      callback + "/relay",
      {
        headers: {
          authorization: headers.authorization,
          Upgrade: "websocket",
          [BOOTSTRAP_RELAY_HEADER]: token,
        },
      },
      runtime,
    );
  return { ...f, op, counts, hooks, grant, open };
}

it("loads full verified host custody once per grant and once per WebSocket handler", async () => {
  const f = await setupTransport(),
    response = await f.grant();
  expect(response.status).toBe(200);
  const grant = await response.json<{
    token: string;
    expectedTarget: { ip: string; port: number };
  }>();
  expect(grant.expectedTarget).toEqual({ ip: "192.0.2.18", port: 50000 });
  expect(f.counts.hostLoads).toBe(1);
  f.counts.hostLoads = 0;
  const opened = await f.open(grant.token);
  expect(opened.status).toBe(101);
  expect(f.counts.hostLoads).toBe(1);
  opened.webSocket?.accept();
  opened.webSocket?.close();
});
it("refuses a reassigned node after request verification and before grant return", async () => {
  const f = await setupTransport();
  f.hooks.identity = async () => {
    await env.DB.prepare(
      "UPDATE fleet_node_releases SET revision=revision+1 WHERE node_id=?",
    )
      .bind(f.node)
      .run();
  };
  const response = await f.grant();
  expect(response.status).toBe(409);
  expect(f.counts.opening).toBe(0);
});
it("refuses a stage change while the WebSocket is opening", async () => {
  const f = await setupTransport(),
    response = await f.grant();
  expect(response.status).toBe(200);
  const grant = await response.json<{ token: string }>();
  f.hooks.opening = async () => {
    await env.DB.prepare(
      "UPDATE fleet_patch_operations SET state='halted' WHERE operation_id=?",
    )
      .bind(f.op)
      .run();
  };
  const opened = await f.open(grant.token);
  expect(opened.status).toBe(409);
});

it("refuses a compute policy change after private context verification", async () => {
  const f = await setupTransport();
  f.hooks.identity = async () => {
    await env.DB.prepare(
      "UPDATE node_compute_pool_policies SET revision=revision+1 WHERE node_id=?",
    )
      .bind(f.node)
      .run();
  };
  expect((await f.grant()).status).toBe(409);
  expect(f.counts.opening).toBe(0);
});

it("closes an opening WebSocket when current custody moves", async () => {
  const f = await setupTransport(),
    response = await f.grant();
  expect(response.status).toBe(200);
  const grant = await response.json<{ token: string }>();
  f.hooks.opening = async () => {
    await env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
    )
      .bind(f.region)
      .run();
  };
  expect((await f.open(grant.token)).status).toBe(409);
});

it("rejects a new policy profile read after old host custody was verified", async () => {
  const f = await setupTransport();
  f.hooks.pool = async () => {
    await env.DB.prepare(
      "UPDATE node_compute_pool_policies SET revision=revision+1,policy_json=json_set(policy_json,'$.profile.controller_sha256',?) WHERE node_id=?",
    )
      .bind("e".repeat(64), f.node)
      .run();
  };
  expect((await f.grant()).status).toBe(409);
  expect(f.counts.identity).toBe(0);
});

it("allows a policy target-slot update that preserves the verified host profile", async () => {
  const f = await setupTransport();
  f.hooks.pool = async () => {
    await env.DB.prepare(
      "UPDATE node_compute_pool_policies SET revision=revision+1,policy_json=json_set(policy_json,'$.target_slots',0) WHERE node_id=?",
    )
      .bind(f.node)
      .run();
  };
  expect((await f.grant()).status).toBe(200);
  expect(f.counts.hostLoads).toBe(1);
});
