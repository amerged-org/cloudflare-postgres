// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import {
  createNodeRescueHostIdentity,
  type NodeInspectionInput,
} from "@pgcf/contracts/node-installation";
import { BootstrapError } from "../src/bootstrap.ts";
import { createBootstrapServer } from "../src/server.ts";

async function fixture(): Promise<NodeInspectionInput> {
  const server = await createNodeRescueHostIdentity(),
    client = await createNodeRescueHostIdentity();
  const operation = newOperationId(),
    base = `https://inspection.invalid/internal/v1/node-installation/${operation}`;
  return {
    version: 1,
    operation_id: operation,
    node_id: newNodeId(),
    region_id: "region-dev",
    provider_instance_id: "17",
    profile_sha256: randomBytes(32).toString("hex"),
    binding_sha256: randomBytes(32).toString("hex"),
    network_plan_sha256: randomBytes(32).toString("hex"),
    expected_generation: 0,
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    expected_network: {
      mac: "02:00:00:00:00:17",
      ipv4: "192.0.2.17",
      prefix_length: 24,
      gateway: "192.0.2.1",
    },
    dns: ["192.0.2.53"],
    peer_ipv4: [],
    rescue: {
      ssh_private_key: JSON.parse(client.user_data.split("\n")[1]!).ssh_keys
        .ed25519_private,
      ssh_host_key: server.ssh_host_key,
      ssh_host_fingerprint: server.ssh_host_fingerprint,
    },
    callback: {
      url: `${base}/inspection`,
      bearer: randomBytes(32).toString("base64url"),
    },
    transport_url: `${base}/transport`,
    relay_url: base.replace(/^https:/, "wss:") + "/relay",
  };
}

test("inspection registration authenticates before parsing and coalesces one read-only run per identity", async () => {
  const input = await fixture(),
    bearer = randomBytes(32).toString("base64url");
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createBootstrapServer(bearer, {
    inspection: async () => {
      calls++;
      await gate;
      throw new BootstrapError("inspection_fixture_failure");
    },
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture_address_missing");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const unauthorized = await fetch(`${base}/v1/inspections`, {
      method: "POST",
      body: "{",
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(calls, 0);
    const headers = {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    };
    const register = (body: unknown) =>
      fetch(`${base}/v1/inspections`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    assert.equal((await register(input)).status, 202);
    assert.equal((await register(input)).status, 202);
    assert.equal(calls, 1);
    assert.equal(
      (await register({ ...input, expected_generation: 1 })).status,
      409,
    );
    const status = await fetch(`${base}/v1/inspections/${input.operation_id}`, {
      headers,
    });
    assert.equal(status.status, 200);
    const text = await status.text();
    assert.equal(text.includes(input.rescue.ssh_private_key), false);
    assert.equal(text.includes(input.callback.bearer), false);
    assert.equal(text.includes(bearer), false);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    const failed = (await (
      await fetch(`${base}/v1/inspections/${input.operation_id}`, { headers })
    ).json()) as { status: string; error_code: string };
    assert.deepEqual(
      { status: failed.status, error_code: failed.error_code },
      { status: "failed", error_code: "inspection_fixture_failure" },
    );
  } finally {
    release();
    runtime.stop();
    runtime.server.closeAllConnections();
  }
});
