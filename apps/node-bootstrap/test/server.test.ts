// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { NodeBootstrapCallback } from "@pgcf/contracts/node-bootstrap";
import { inputHash } from "../src/bootstrap.ts";
import { LOOPBACK } from "../src/proxy-command.ts";
import { authorized, createBootstrapServer } from "../src/server.ts";
import { authority, fixture } from "./fixture.ts";

test("private HTTP authenticates before parsing and exposes only durable bounded status", async () => {
  const input = fixture();
  let current = authority(input);
  const bearer = randomBytes(32).toString("base64url");
  const runtime = createBootstrapServer(bearer, {
    run: async () => {
      throw new Error(input.callback.bearer);
    },
    request: async (_url, init) => {
      const message = NodeBootstrapCallback.parse(
        JSON.parse(String(init?.body)),
      );
      if (message.kind === "checkpoint")
        current = {
          ...current,
          revision: current.revision + 1,
          checkpoint: message.payload,
        };
      return Response.json(current);
    },
  });
  runtime.server.listen(0, LOOPBACK);
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://${LOOPBACK}:${address.port}`;
  try {
    const refused = await fetch(`${url}/v1/jobs`, {
      method: "POST",
      body: "{invalid private input",
    });
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error_code: "unauthorized" });
    const headers = {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    };
    const started = await fetch(`${url}/v1/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(started.status, 202);
    const exposed = await started.text();
    assert.ok(!exposed.includes(input.callback.bearer));
    assert.ok(!exposed.includes(input.rescue.ssh_private_key));
    const alteredSpec = { ...input.spec, inventory_revision: 2 };
    const conflict = await fetch(`${url}/v1/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...input,
        spec: alteredSpec,
        input_hash: inputHash(alteredSpec),
      }),
    });
    assert.equal(conflict.status, 409);
    const status = await fetch(`${url}/v1/jobs/${input.spec.operation_id}`, {
      headers,
    });
    assert.equal(status.status, 200);
    const text = await status.text();
    assert.ok(!text.includes(input.callback.bearer));
    const cancelled = await fetch(
      `${url}/v1/jobs/${input.spec.operation_id}/cancel`,
      { method: "POST", headers },
    );
    assert.equal(cancelled.status, 202);
    const finalStatus = await fetch(
      `${url}/v1/jobs/${input.spec.operation_id}`,
      { headers },
    );
    assert.equal(finalStatus.status, 200);
    assert.equal(
      ((await finalStatus.json()) as { checkpoint: { status: string } })
        .checkpoint.status,
      "cancelled",
    );
  } finally {
    runtime.stop();
    runtime.server.closeAllConnections();
    if (runtime.server.listening) await once(runtime.server, "close");
  }
  assert.equal(authorized(`Bearer ${bearer}`, bearer), true);
  assert.equal(authorized(`Bearer ${bearer.slice(1)}`, bearer), false);
});
