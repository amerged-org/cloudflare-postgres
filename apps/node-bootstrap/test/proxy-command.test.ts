// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import {
  capabilityTarget,
  openCapability,
  startNativeProxy,
} from "../src/proxy-command.ts";
import { fixture } from "./fixture.ts";

test("relay capability refuses a callback target that differs from immutable provider identity", async () => {
  const input = fixture();
  let requests = 0;
  const config = {
    spec: input.spec,
    input_hash: input.input_hash,
    callback: input.callback,
  };
  await assert.rejects(
    openCapability(
      config,
      "rescue_ssh",
      AbortSignal.timeout(1000),
      async (_url, options) => {
        requests++;
        assert.equal(
          new Headers(options?.headers).get("authorization"),
          `Bearer ${input.callback.bearer}`,
        );
        return Response.json({
          websocket_url: `wss://${randomUUID()}.invalid/relay`,
          token: randomUUID(),
          expectedTarget: { ip: [192, 0, 2, 18].join("."), port: 22 },
        });
      },
    ),
    /transport_target_mismatch/,
  );
  assert.equal(requests, 1);
  assert.equal(capabilityTarget(config, "talos_api").port, 50000);
  assert.equal(
    capabilityTarget(config, "kubernetes_api").ip,
    new URL(input.spec.cluster_endpoint).hostname,
  );
});

test("native CONNECT proxy denies public PostgreSQL and unapproved host requests before relay admission", async () => {
  const input = fixture();
  const abort = new AbortController();
  const proxy = await startNativeProxy(
    {
      spec: input.spec,
      input_hash: input.input_hash,
      callback: input.callback,
    },
    abort.signal,
  );
  try {
    const response = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(proxy.url, {
        method: "CONNECT",
        path: `${input.spec.hardware.ipv4}:5432`,
      });
      request.once("connect", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode!);
      });
      request.once("error", reject);
      request.end();
    });
    assert.equal(response, 403);
  } finally {
    await proxy.close();
  }
});
