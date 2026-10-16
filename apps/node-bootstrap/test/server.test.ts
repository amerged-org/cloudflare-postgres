// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
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

test(
  "an executor turn registers at once and the container's own record follows that exact turn",
  { timeout: 5000 },
  async () => {
    const bearer = randomBytes(32).toString("base64url"),
      secret = randomBytes(32).toString("base64url"),
      turn = { operation_id: `op_${"a".repeat(20)}`, revision: 7 };
    let release!: () => void, entered!: () => void, received!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      began = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      receiving = new Promise<void>((resolve) => {
        received = resolve;
      });
    const runtime = createBootstrapServer(bearer, {
      thinQualification: async () => {
        entered();
        await held;
        return { waiting: false };
      },
    });
    runtime.server.on("request", (incoming: IncomingMessage) => {
      if (incoming.method === "POST") received();
    });
    runtime.server.listen(0, LOOPBACK);
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://${LOOPBACK}:${address.port}`,
      headers = { authorization: `Bearer ${bearer}` };
    const record = async () => {
      const response = await fetch(`${url}/v1/turn`, { headers });
      assert.equal(response.status, 200);
      return response.text();
    };
    try {
      const body = JSON.stringify({
        run: { lease: turn },
        callback: { bearer: secret },
      });
      const posted = request(`${url}/v1/thin-qualification`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      });
      // A failed assertion closes the server under this request; that must not outlive the test.
      posted.on("error", () => {});
      posted.write(body.slice(0, 16));
      await receiving;
      // Until its body arrived the container cannot know which turn it is receiving.
      assert.deepEqual(JSON.parse(await record()), { state: "receiving" });
      posted.end(body.slice(16));
      const [answer] = (await once(posted, "response")) as [IncomingMessage];
      let accepted = "";
      for await (const chunk of answer) accepted += String(chunk);
      const running = {
        state: "running",
        kind: "thin_qualification",
        ...turn,
        error_code: null,
      };
      assert.equal(answer.statusCode, 202);
      assert.deepEqual(JSON.parse(accepted), running);
      await began;
      assert.equal((await fetch(`${url}/v1/turn`)).status, 401);
      assert.deepEqual(JSON.parse(await record()), running);
      const busy = await fetch(`${url}/v1/patches`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ status: turn }),
      });
      assert.equal(busy.status, 409);
      assert.deepEqual(await busy.json(), {
        error_code: "patch_container_busy",
      });
      release();
      await new Promise((resolve) => setImmediate(resolve));
      // The ended turn's record stays readable, so a lost answer never loses its outcome.
      const ended = await record();
      assert.deepEqual(JSON.parse(ended), { ...running, state: "succeeded" });
      assert.ok(!ended.includes(secret));
    } finally {
      release();
      runtime.stop();
      runtime.server.closeAllConnections();
    }
  },
);

test("a failed turn keeps only its safe executor code in the container's record", async () => {
  const { BootstrapError } = await import("../src/bootstrap.ts");
  const bearer = randomBytes(32).toString("base64url"),
    secret = randomBytes(32).toString("base64url"),
    turn = { operation_id: `op_${"b".repeat(20)}`, revision: 3 };
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
  const url = `http://${LOOPBACK}:${address.port}`,
    headers = {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    };
  const call = async (body: unknown) => {
    const accepted = await fetch(`${url}/v1/patches`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(accepted.status, 202);
    await accepted.body?.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    return (await fetch(`${url}/v1/turn`, { headers })).text();
  };
  const failed = (error_code: string) => ({
    state: "failed",
    kind: "patch",
    ...turn,
    error_code,
  });
  try {
    assert.deepEqual(
      JSON.parse(await call({ status: turn })),
      failed("patch_command_output_limit"),
    );
    error = new Error(secret);
    const unexpected = await call({ status: turn });
    assert.deepEqual(JSON.parse(unexpected), failed("patch_request_invalid"));
    assert.ok(!unexpected.includes(secret));
    // Input without the fence of its turn is refused before anything runs.
    const unfenced = await fetch(`${url}/v1/patches`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(unfenced.status, 400);
    assert.deepEqual(await unfenced.json(), {
      error_code: "patch_request_invalid",
    });
  } finally {
    await runtime.stop();
  }
});

/** A container whose thin identity turns are `run`; `cancel` names a turn of operation `op_ccc…`. */
async function cancelServer(
  run: NonNullable<Parameters<typeof createBootstrapServer>[1]>["thinStorage"],
) {
  const bearer = randomBytes(32).toString("base64url");
  const runtime = createBootstrapServer(bearer, { thinStorage: run });
  runtime.server.listen(0, LOOPBACK);
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://${LOOPBACK}:${address.port}`,
    headers = {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    operation = `op_${"c".repeat(20)}`;
  return {
    runtime,
    start: async (revision: number, action: object | null) => {
      const accepted = await fetch(`${url}/v1/thin-storage`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          lease: { operation_id: operation, revision, action },
        }),
      });
      assert.equal(accepted.status, 202);
      await accepted.body?.cancel();
    },
    cancel: async (
      revision: number,
      named: { kind?: string; operation_id?: string } = {},
    ) => {
      const answer = await fetch(`${url}/v1/turn/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "thin_storage",
          operation_id: operation,
          revision,
          ...named,
        }),
      });
      assert.equal(answer.status, 200);
      return (await answer.json()) as unknown;
    },
    record: async () =>
      (await (await fetch(`${url}/v1/turn`, { headers })).json()) as unknown,
    state: (
      revision: number,
      value: string,
      error_code: string | null = null,
    ) => ({
      state: value,
      kind: "thin_storage",
      operation_id: operation,
      revision,
      error_code,
    }),
    stop: () => {
      runtime.stop();
      runtime.server.closeAllConnections();
    },
  };
}

test(
  "a cancel ends only the running read-only identity turn it names, and the next turn runs after it",
  { timeout: 5000 },
  async () => {
    const { BootstrapError } = await import("../src/bootstrap.ts");
    const turns: { signal: AbortSignal | undefined; release: () => void }[] =
      [];
    const container = await cancelServer(async (_input, options = {}) => {
      await new Promise<void>((resolve, reject) => {
        turns.push({ signal: options.signal, release: resolve });
        // As a turn's session ends on its cancel.
        options.signal?.addEventListener(
          "abort",
          () => reject(new BootstrapError("thin_storage_turn_cancelled")),
          { once: true },
        );
      });
      return {};
    });
    const { start, cancel, record, state } = container;
    try {
      // An idle container has nothing to end.
      assert.deepEqual(await cancel(1), { state: "idle" });
      // A turn with a pool action is never ended early.
      await start(1, { kind: "grow" });
      assert.deepEqual(await cancel(1), state(1, "running"));
      assert.equal(turns[0]!.signal, undefined);
      turns[0]!.release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(await record(), state(1, "succeeded"));
      // A read-only turn ends on a cancel that names it, and only then; the answer is its outcome.
      await start(2, null);
      assert.deepEqual(await cancel(3), state(2, "running"));
      assert.deepEqual(
        await cancel(2, { operation_id: `op_${"d".repeat(20)}` }),
        state(2, "running"),
      );
      assert.deepEqual(
        await cancel(2, { kind: "thin_qualification" }),
        state(2, "running"),
      );
      assert.equal(turns[1]!.signal?.aborted, false);
      const ended = state(2, "failed", "thin_storage_turn_cancelled");
      assert.deepEqual(await cancel(2), ended);
      assert.equal(turns[1]!.signal?.aborted, true);
      assert.deepEqual(await record(), ended);
      // The container takes the next turn at once.
      await start(4, null);
      assert.deepEqual(await record(), state(4, "running"));
      turns[2]!.release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(await record(), state(4, "succeeded"));
    } finally {
      for (const value of turns) value.release();
      container.stop();
    }
  },
);

test(
  "a cancel that reaches a turn after it failed on its own keeps the turn's own failure",
  { timeout: 5000 },
  async () => {
    const { BootstrapError } = await import("../src/bootstrap.ts");
    let cleaning!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      cleaning = resolve;
    });
    // The turn has raised a blocking failure and is still closing its relay session.
    const container = await cancelServer(async () => {
      try {
        throw new BootstrapError("thin_storage_physical_identity_changed");
      } finally {
        cleaning();
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    });
    try {
      await container.start(1, null);
      await cleanup;
      const failed = container.state(
        1,
        "failed",
        "thin_storage_physical_identity_changed",
      );
      assert.deepEqual(await container.cancel(1), failed);
      assert.deepEqual(await container.record(), failed);
    } finally {
      container.stop();
    }
  },
);
