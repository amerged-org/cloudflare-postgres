// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { createBootstrapServer } from "../src/server.ts";
import { BootstrapError } from "../src/bootstrap-error.ts";
import { proofExecutionFixture } from "./node-proof.fixture.ts";
import { fixture } from "./fixture.ts";

test("proof registration authenticates before private input and coalesces exact sessions without exposing keys", async () => {
  const { input } = await proofExecutionFixture(),
    token = randomBytes(32).toString("base64url");
  let runs = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createBootstrapServer(token, {
    proof: async () => {
      runs++;
      await gate;
      throw new BootstrapError("node_proof_fixture_failure");
    },
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture_address");
  const base = `http://127.0.0.1:${address.port}`,
    headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  try {
    assert.equal(
      (await fetch(`${base}/v1/proofs`, { method: "POST", body: "{" })).status,
      401,
    );
    const register = (value: unknown) =>
      fetch(`${base}/v1/proofs`, {
        method: "POST",
        headers,
        body: JSON.stringify(value),
      });
    assert.equal((await register(input)).status, 202);
    assert.equal((await register(input)).status, 202);
    assert.equal(runs, 1);
    const install = await fetch(`${base}/v1/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify(fixture()),
    });
    assert.equal(install.status, 409);
    assert.deepEqual(await install.json(), { error_code: "container_busy" });
    assert.equal(
      (
        await register({
          ...input,
          claims: { ...input.claims, session_id: crypto.randomUUID() },
        })
      ).status,
      409,
    );
    const status = (await (
      await fetch(
        `${base}/v1/proofs/${input.claims.operation_id}/preparation`,
        { headers },
      )
    ).json()) as Record<string, unknown>;
    assert.equal(status.status, "running");
    assert.equal(JSON.stringify(status).includes(input.session_bearer), false);
    assert.equal(
      JSON.stringify(status).includes(input.bootstrap.rescue.ssh_private_key),
      false,
    );
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const failed = (await (
      await fetch(
        `${base}/v1/proofs/${input.claims.operation_id}/preparation`,
        { headers },
      )
    ).json()) as Record<string, unknown>;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error_code, "node_proof_fixture_failure");
  } finally {
    release();
    runtime.stop();
  }
});
