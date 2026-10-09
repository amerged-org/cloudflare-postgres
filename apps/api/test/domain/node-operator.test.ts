// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import {
  joinBundleReference,
  storeRegionJoinBundle,
} from "../../src/crypto/bootstrap-credentials.ts";
import {
  BOOTSTRAP_RELAY_HEADER,
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_PATH,
  importBootstrapVerificationKeys,
  verifyBootstrapRelay,
} from "@pgcf/contracts/bootstrap-relay";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(cleanupFixtures);

async function operatorFixture(endpoint = "https://192.0.2.40:6443") {
  const f = await fixture(),
    nodeUid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("node_uid"),
    clusterUid = crypto.randomUUID(),
    epoch = crypto.randomUUID();
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    {
      version: 1,
      cluster_name: "operator-test",
      cluster_endpoint: endpoint,
      kube_system_uid: clusterUid,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml: "cluster: test-private-material\n",
      talos_admin_config: "context: test-private-material\n",
      kubeconfig: "apiVersion: v1\ncontext: test-private-material\n",
    },
  );
  const calls: string[] = [],
    claims: unknown[] = [];
  const hooks: {
    identity?: () => Promise<void>;
    opening?: () => Promise<void>;
  } = {};
  const keys = await importBootstrapVerificationKeys(
    JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
  );
  const bindings = {
    ...env,
    BOOTSTRAP_RELAY_ISSUER_REGION: f.region,
    BOOTSTRAP_RELAY_URL: `https://relay.invalid${BOOTSTRAP_RELAY_PATH}`,
    BOOTSTRAP_RELAY_SERVICE: {
      async fetch(request: Request) {
        const pathname = new URL(request.url).pathname;
        calls.push(pathname);
        if (pathname === BOOTSTRAP_RELAY_IDENTITY_PATH) {
          await hooks.identity?.();
          return Response.json({
            v: 1,
            region: f.region,
            issuer_region: f.region,
            relay_epoch: epoch,
            allowed_target_regions: [f.region],
            capabilities: ["kubernetes_api"],
          });
        }
        expect(pathname).toBe(BOOTSTRAP_RELAY_PATH);
        expect(request.redirect).toBe("manual");
        const verified = await verifyBootstrapRelay(
          request.headers.get(BOOTSTRAP_RELAY_HEADER),
          {
            keys,
            region: f.region,
            issuer_region: f.region,
            relay_epoch: epoch,
            allowedTargetRegions: [f.region],
          },
        );
        expect(verified.ok).toBe(true);
        if (!verified.ok) throw Error("invalid_operator_capability");
        expect(verified.claims).toMatchObject({
          node: f.node,
          capability: "kubernetes_api",
          target: { address: "192.0.2.40", port: 6443 },
          revision: 1,
        });
        claims.push(verified.claims);
        await hooks.opening?.();
        const pair = new WebSocketPair();
        pair[1].binaryType = "arraybuffer";
        pair[1].accept();
        pair[1].addEventListener("message", (event) =>
          pair[1].send(event.data),
        );
        return new Response(null, { status: 101, webSocket: pair[0] });
      },
    },
  } as unknown as Env;
  const request = (key = f.admin, query = `node_uid=${nodeUid}`) =>
    createApp().fetch(
      new Request(
        `https://api.invalid/v1/nodes/${f.node}/operator/kubernetes?${query}`,
        {
          headers: { Authorization: `Bearer ${key}`, Upgrade: "websocket" },
        },
      ),
      bindings,
    );
  return {
    ...f,
    nodeUid: nodeUid!,
    clusterUid,
    epoch,
    bindings,
    calls,
    claims,
    hooks,
    request,
  };
}

it("forwards one real administrator request over a CF-signed fixed Kubernetes relay without a provisioning job", async () => {
  const f = await operatorFixture();
  const response = await f.request();
  expect(response.status).toBe(101);
  expect(response.headers.get("X-PGCF-Node-UID")).toBe(f.nodeUid);
  expect(response.headers.get("X-PGCF-Cluster-UID")).toBe(f.clusterUid);
  expect(response.headers.get("X-PGCF-Node-Name")).toBe(f.nodeName);
  expect(response.headers.get("X-PGCF-Material-Revision")).toBe("1");
  expect([...response.headers.values()].join(" ")).not.toContain("br1.");
  const socket = response.webSocket!;
  socket.binaryType = "arraybuffer";
  socket.accept();
  const echoed = new Promise<unknown>((resolve) =>
    socket.addEventListener("message", (event) => resolve(event.data), {
      once: true,
    }),
  );
  socket.send(Buffer.from([22, 3, 3, 0, 1, 7]));
  const value = await echoed;
  const bytes =
    value instanceof Blob ? await value.arrayBuffer() : (value as ArrayBuffer);
  expect(new Uint8Array(bytes)).toEqual(new Uint8Array([22, 3, 3, 0, 1, 7]));
  socket.close();
  expect(f.calls).toEqual([
    BOOTSTRAP_RELAY_IDENTITY_PATH,
    BOOTSTRAP_RELAY_PATH,
  ]);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_bootstrap_jobs WHERE node_id=?",
    )
      .bind(f.node)
      .first<number>("count"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM fleet_patch_operations WHERE node_id=?",
    )
      .bind(f.node)
      .first<number>("count"),
  ).toBe(0);
});

it("refuses non-admin, wrong or stale physical identities and caller targets before relay access", async () => {
  const f = await operatorFixture();
  expect((await f.request(f.integrator)).status).toBe(403);
  expect(
    (await f.request(f.admin, `node_uid=${crypto.randomUUID()}`)).status,
  ).toBe(409);
  expect(
    (
      await f.request(
        f.admin,
        `node_uid=${f.nodeUid}&address=192.0.2.80&port=22`,
      )
    ).status,
  ).toBe(400);
  expect(
    (await f.request(f.admin, `node_uid=${f.nodeUid}&node_uid=${f.nodeUid}`))
      .status,
  ).toBe(400);
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(Date.now() - 240000).toISOString(), f.node)
    .run();
  expect((await f.request()).status).toBe(409);
  expect(f.calls).toEqual([]);
});

it("blocks a physical UID change during the relay identity read without opening transport", async () => {
  const f = await operatorFixture();
  f.hooks.identity = async () => {
    await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
      .bind(crypto.randomUUID(), f.node)
      .run();
  };
  expect((await f.request()).status).toBe(409);
  expect(f.calls).toEqual([BOOTSTRAP_RELAY_IDENTITY_PATH]);
  expect(f.claims).toEqual([]);
});

it("closes an opened relay when material changes before the operator handshake is accepted", async () => {
  const f = await operatorFixture();
  f.hooks.opening = async () => {
    await env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
    )
      .bind(f.region)
      .run();
  };
  const response = await f.request();
  expect(response.status).toBe(409);
  expect(response.webSocket).toBeNull();
  expect(f.claims).toHaveLength(1);
});

it("rechecks the current administrator permission before opening the relay", async () => {
  const f = await operatorFixture();
  f.hooks.identity = async () => {
    await env.DB.prepare("UPDATE api_keys SET revoked_at=? WHERE lookup_id=?")
      .bind(new Date().toISOString(), f.admin.split("_")[2])
      .run();
  };
  expect((await f.request()).status).toBe(401);
  expect(f.calls).toEqual([BOOTSTRAP_RELAY_IDENTITY_PATH]);
});

it("refuses a hostname or other port in retained cluster custody before relay access", async () => {
  const f = await operatorFixture("https://cluster.invalid:6443");
  expect((await f.request()).status).toBe(409);
  expect(f.calls).toEqual([]);
  const g = await operatorFixture("https://192.0.2.40:22");
  expect((await g.request()).status).toBe(409);
  expect(g.calls).toEqual([]);
});
