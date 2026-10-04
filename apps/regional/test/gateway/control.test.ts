// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { newOperationId } from "@pgcf/contracts";
import {
  GATEWAY_CONTROL_HEADER,
  gatewayFenceName,
  GATEWAY_FENCE_LABEL,
  signGatewayControl,
} from "@pgcf/contracts/gateway-control";
import { GatewayFenceStore } from "../../src/gateway/fences.ts";
import { createGatewayControl } from "../../src/gateway/control.ts";
import { readGatewayPodUid } from "../../src/gateway/config.ts";
import {
  database,
  derived,
  gatewayFor,
  loopback,
  postgresServer,
  region,
  token,
} from "./helpers.ts";

test("HTTP controls require exact purpose/Pod/action/intent and repeats are idempotent", async (t) => {
  const postgres = await postgresServer();
  const pod = randomUUID();
  const { gateway, port } = await gatewayFor(postgres.port, {
    control: (req, res) => controls?.(req, res) ?? false,
    fenceSynchronization: {
      get ready() {
        return store?.ready ?? false;
      },
      get epoch() {
        return store?.epoch ?? 0;
      },
    },
  });
  const store = new GatewayFenceStore(gateway);
  const controls = createGatewayControl({
    gateway,
    store,
    pod,
    region,
    keyring: derived,
  });
  t.after(async () => {
    await gateway.drain();
    await postgres.close();
  });
  const operation = newOperationId(),
    uid = randomUUID();
  const map = (op: string, revision: number, mode: string) => ({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: gatewayFenceName(database),
      namespace: "pgcf-system",
      uid,
      resourceVersion: String(revision),
      labels: {
        [GATEWAY_FENCE_LABEL]: "true",
        "pgcf.io/database-id": database,
      },
    },
    data: {
      "intent.json": JSON.stringify({
        database,
        operation: op,
        revision,
        mode,
      }),
    },
  });
  const signed = (
    action: "begin" | "status" | "close" | "release",
    overrides = {},
  ) =>
    signGatewayControl({
      keyring: derived,
      region,
      pod,
      database,
      operation,
      revision: 1,
      action,
      ...overrides,
    });
  const call = async (action: string, value?: string) => {
    const response = await fetch(
      `http://${loopback}:${port}/_pgcf/gateway/${action}`,
      {
        method: "POST",
        headers: value ? { [GATEWAY_CONTROL_HEADER]: value } : {},
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  assert.equal((await call("begin")).status, 401);
  assert.equal((await call("begin", await token())).status, 401);
  const begin = await signed("begin");
  assert.equal((await call("begin", begin)).status, 503);
  store.load([map(operation, 1, "quiesce")]);
  store.connected();
  assert.equal((await call("begin", begin)).status, 200);
  assert.deepEqual(await call("begin", begin), await call("begin", begin));
  const close = await signed("close");
  await new Promise<void>((resolve, reject) => {
    const req = request(
      `http://${loopback}:${port}/_pgcf/gateway/close`,
      { method: "POST", headers: { [GATEWAY_CONTROL_HEADER]: close } },
      (response) => {
        response.destroy();
        resolve();
      },
    );
    req.once("error", reject);
    req.end();
  });
  assert.equal((await call("close", close)).body.status, "closed");
  assert.equal(
    (await call("close", await signed("close"))).body.status,
    "closed",
  );
  assert.equal((await call("close", begin)).status, 401);
  assert.equal(
    (await call("begin", await signed("begin", { pod: randomUUID() }))).status,
    401,
  );
  assert.equal(
    (await call("begin", await signed("begin", { region: "other-region" })))
      .status,
    401,
  );
  assert.equal(
    (await call("begin", await signed("begin", { now: Date.now() - 60000 })))
      .status,
    401,
  );
  assert.equal(
    (
      await call(
        "begin",
        begin.slice(0, -1) + (begin.endsWith("a") ? "b" : "a"),
      )
    ).status,
    401,
  );
  const resume = newOperationId();
  store.update(map(resume, 2, "running"));
  assert.equal((await call("begin", begin)).status, 409);
  const release = await signed("release", { operation: resume, revision: 2 });
  assert.equal((await call("release", release)).body.status, "running");
  assert.deepEqual(
    await call("release", release),
    await call("release", release),
  );
  store.update(map(newOperationId(), 3, "quiesce"));
  assert.equal((await call("release", release)).status, 409);
  assert.equal(
    (
      await fetch(`http://${loopback}:${port}/_pgcf/gateway/status`, {
        headers: { [GATEWAY_CONTROL_HEADER]: await signed("status") },
      })
    ).status,
    405,
  );
  assert.equal(readGatewayPodUid({ PGCF_GATEWAY_POD_UID: pod }), pod);
  assert.throws(() => readGatewayPodUid({}));
  assert.throws(() => readGatewayPodUid({ PGCF_GATEWAY_POD_UID: "invalid" }));
});
