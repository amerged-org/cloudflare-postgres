// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { test } from "node:test";
import { NodeBootstrapCallback } from "@pgcf/contracts/node-bootstrap";
import { inputHash } from "../src/bootstrap.ts";
import { LOOPBACK } from "../src/proxy-command.ts";
import { authorized, createBootstrapServer } from "../src/server.ts";
import { authority, fixture } from "./fixture.ts";

test("installation registration reserves the executor before awaiting authoritative status", async () => {
  const first = fixture(),
    second = fixture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const bearer = randomBytes(32).toString("base64url");
  const runtime = createBootstrapServer(bearer, {
    request: async (_url, init) => {
      const envelope = NodeBootstrapCallback.parse(
        JSON.parse(String(init?.body)),
      );
      const input =
        envelope.operation_id === first.spec.operation_id ? first : second;
      if (input === first) {
        entered();
        await held;
      }
      const current = authority(input);
      return Response.json({
        ...current,
        checkpoint: {
          ...current.checkpoint,
          stage: "awaiting_verification",
          status: "awaiting_verification",
        },
      });
    },
  });
  runtime.server.listen(0, LOOPBACK);
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://${LOOPBACK}:${address.port}/v1/jobs`,
    headers = {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    };
  let pending: Promise<Response> | undefined;
  try {
    pending = fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(first),
    });
    await Promise.race([
      began,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("registration_status_not_reached")),
          1000,
        );
        timer.unref();
      }),
    ]);
    const blocked = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(second),
    });
    assert.equal(blocked.status, 409);
    assert.deepEqual(await blocked.json(), { error_code: "container_busy" });
  } finally {
    release();
    if (pending) await pending;
    await runtime.stop();
  }
});

test("actual child entry emits only the fixed JSON event for invalid private configuration", () => {
  const canary = randomBytes(32).toString("base64url");
  const entry = fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const result = spawnSync(process.execPath, [entry], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      LANG: "C",
      PGCF_BOOTSTRAP_SERVER_BEARER: canary,
      PORT: "0",
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    `${JSON.stringify({ event: "bootstrap_invalid_configuration" })}\n`,
  );
  assert.ok(!result.stderr.includes(canary));
});

test("the actual bundled entry starts far enough to emit the sanitized configuration event", () => {
  const built = spawnSync("pnpm", ["run", "build"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, LANG: "C", CI: "true" },
  });
  assert.equal(built.status, 0);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/server.mjs", import.meta.url))],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { PATH: process.env.PATH, LANG: "C" },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    `${JSON.stringify({ event: "bootstrap_invalid_configuration" })}\n`,
  );
});

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

test(
  "admission registration skips installation and preserves a running admission",
  { timeout: 5000 },
  async () => {
    const input = fixture();
    const current = {
      ...authority(input),
      checkpoint: {
        ...authority(input).checkpoint,
        stage: "awaiting_verification" as const,
        status: "awaiting_verification" as const,
      },
    };
    let releaseRead!: () => void;
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let admissionEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      admissionEntered = resolve;
    });
    let reads = 0;
    let commands = 0;
    const bearer = randomBytes(32).toString("base64url");
    const runtime = createBootstrapServer(bearer, {
      run: async () => {
        commands++;
        throw new Error("installation_must_not_run");
      },
      request: async (_url, init) => {
        const message = NodeBootstrapCallback.parse(
          JSON.parse(String(init?.body)),
        );
        if (message.kind === "read" && ++reads === 2) await blockedRead;
        return Response.json(current);
      },
    });
    runtime.server.on("request", (request) => {
      if (request.url?.endsWith("/admit")) admissionEntered();
    });
    runtime.server.listen(0, LOOPBACK);
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://${LOOPBACK}:${address.port}`;
    const headers = {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    };
    try {
      const registered = await fetch(`${url}/v1/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      assert.equal(registered.status, 202);
      await registered.body?.cancel();
      const pending = fetch(`${url}/v1/jobs/${input.spec.operation_id}/admit`, {
        method: "POST",
        headers,
      });
      await entered;
      const repeated = await fetch(`${url}/v1/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      assert.equal(repeated.status, 202);
      await repeated.body?.cancel();
      const overlapping = await fetch(
        `${url}/v1/jobs/${input.spec.operation_id}/admit`,
        { method: "POST", headers },
      );
      assert.equal(overlapping.status, 409);
      assert.deepEqual(await overlapping.json(), {
        error_code: "container_busy",
      });
      releaseRead();
      const admission = await pending;
      assert.equal(admission.status, 400);
      assert.deepEqual(await admission.json(), {
        error_code: "admission_not_authorized",
      });
      assert.equal(commands, 0);
      assert.equal(reads, 3);
    } finally {
      releaseRead();
      runtime.stop();
      runtime.server.closeAllConnections();
      if (runtime.server.listening) await once(runtime.server, "close");
    }
  },
);

test("patch failures preserve the safe executor code without exposing private exception messages", async () => {
  const { BootstrapError } = await import("../src/bootstrap.ts");
  const bearer = randomBytes(32).toString("base64url"),
    secret = randomBytes(32).toString("base64url");
  let error: Error = new BootstrapError("command_output_limit");
  const runtime = createBootstrapServer(bearer, {
    patch: async () => {
      throw error;
    },
  });
  runtime.server.listen(0, LOOPBACK);
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  const call = () =>
    fetch(`http://${LOOPBACK}:${address.port}/v1/patches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
  try {
    const bounded = await call();
    assert.equal(bounded.status, 400);
    assert.deepEqual(await bounded.json(), {
      error_code: "patch_command_output_limit",
    });
    error = new Error(secret);
    const unexpected = await call();
    assert.deepEqual(await unexpected.json(), {
      error_code: "patch_request_invalid",
    });
  } finally {
    await runtime.stop();
  }
});
