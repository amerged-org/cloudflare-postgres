// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { fixture as databaseFixture } from "../../../apps/regional/test/agent/fixtures.ts";
import { ChaosRelay } from "./chaos-relay.ts";

function storage() {
  const values = new Map<string, unknown>();
  return {
    values,
    context: {
      storage: {
        async get<T>(key: string): Promise<T | undefined> {
          return structuredClone(values.get(key)) as T | undefined;
        },
        async put<T>(key: string, value: T): Promise<void> {
          values.set(key, structuredClone(value));
        },
        async delete(key: string): Promise<boolean> {
          return values.delete(key);
        },
      },
      async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
        return callback();
      },
    },
  };
}

function fixture(context: TestContext) {
  const store = storage();
  const bearer = randomBytes(32).toString("hex");
  const env = {
    API_URL: `https://${["api", "test", "invalid"].join(".")}`,
    RUN_NAME: `pgcf-e2e-${randomBytes(8).toString("hex")}`,
    RUN_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
    PROBE_BEARER: bearer,
    AGENT_KEY: randomBytes(32).toString("hex"),
    RELAY: {
      idFromName: () => "test",
      get: () => {
        throw new Error("unused_test_binding");
      },
    },
  };
  let databases: ReturnType<typeof databaseFixture>["db"][] = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(null, { status: 204 })
        : Response.json({
            region: {
              id: "eu-test",
              backup: {
                bucket: "pgcf-backups",
                endpoint_url: `https://${["r2", "test", "invalid"].join(".")}`,
                region: "auto",
              },
            },
            databases,
            next: null,
          }),
  );
  const control = (relay: ChaosRelay, path: string, body?: unknown) =>
    relay.fetch(
      new Request(
        `https://${["relay", "test", "invalid"].join(".")}/control/${path}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body ?? {}),
        },
      ),
    );
  const desired = (relay: ChaosRelay) =>
    relay.fetch(
      new Request(
        `https://${["relay", "test", "invalid"].join(".")}/agent/v1/desired`,
        { headers: { Authorization: `Bearer ${env.AGENT_KEY}` } },
      ),
    );
  const observe = (
    relay: ChaosRelay,
    db?: { id: string; generation: number },
  ) =>
    relay.fetch(
      new Request(
        `https://${["relay", "test", "invalid"].join(".")}/agent/v1/observations`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.AGENT_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            observed_at: new Date().toISOString(),
            nodes: [],
            databases: db
              ? [
                  {
                    ...db,
                    state: "provisioning",
                    archive: { continuous: false, ready_wal_files: null },
                  },
                ]
              : [],
            orphans: [],
          }),
        },
      ),
    );
  return {
    store,
    env,
    control,
    desired,
    observe,
    setDatabases: (next: typeof databases) => {
      databases = next;
    },
    create: () => new ChaosRelay(store.context, env),
  };
}

test("captured real-shaped empty snapshot, mode and completion survive a new relay instance", async (context) => {
  const sample = fixture(context);
  const initial = sample.create();
  await sample.control(initial, "capture-empty");
  await sample.control(initial, "mode", {
    mode: "empty",
    cycle_id: randomBytes(24).toString("hex"),
  });
  const restored = sample.create();
  const reply = await sample.desired(restored);
  assert.deepEqual((await reply.json()).databases, []);
  await sample.observe(sample.create());
  const counts = await (await sample.control(sample.create(), "counts")).json();
  assert.equal(counts.replayed, 1);
  assert.equal(counts.completed_responses, 1);
  assert.equal(counts.observations_after_response, 1);
});

test("older/fresh snapshots stay encrypted and out-of-order swaps exactly once across eviction", async (context) => {
  const sample = fixture(context);
  const db = databaseFixture().db;
  const relay = sample.create();
  sample.setDatabases([db]);
  await sample.control(relay, "capture-older", { database_id: db.id });
  sample.setDatabases([{ ...db, generation: 2 }]);
  await sample.control(sample.create(), "capture-fresh");
  await sample.control(sample.create(), "mode", {
    mode: "out_of_order",
    cycle_id: randomBytes(24).toString("hex"),
  });
  const first = await (await sample.desired(sample.create())).json();
  const second = await (await sample.desired(sample.create())).json();
  const third = await (await sample.desired(sample.create())).json();
  assert.equal(first.databases[0].generation, 2);
  assert.equal(second.databases[0].generation, 1);
  assert.equal(third.databases[0].generation, 1);
  const raw = JSON.stringify([...sample.store.values.values()]);
  assert.equal(sample.store.values.size, 1);
  assert.equal(raw.includes(db.roles[0]!.password), false);
  assert.equal(raw.includes(sample.env.PROBE_BEARER), false);
  assert.equal(raw.includes(sample.env.AGENT_KEY), false);
});

test("durable generation high-water and fault counters survive reconstruction", async (context) => {
  const sample = fixture(context);
  const id = databaseFixture().db.id;
  await sample.observe(sample.create(), { id, generation: 2 });
  await sample.observe(sample.create(), { id, generation: 1 });
  await sample.control(sample.create(), "mode", {
    mode: "failure",
    cycle_id: randomBytes(24).toString("hex"),
  });
  await assert.rejects(sample.desired(sample.create()), {
    message: "injected_desired_transport_failure",
  });
  const counts = await (await sample.control(sample.create(), "counts")).json();
  assert.equal(counts.regressed_generations, 1);
  assert.equal(counts.transport_failures, 1);
  assert.equal(counts.failure_responses, 1);
});

test("tampered ciphertext is refused without replacing stored evidence", async (context) => {
  const sample = fixture(context);
  await sample.control(sample.create(), "capture-empty");
  assert.equal(sample.store.values.size, 1);
  const [key, stored] = [...sample.store.values.entries()][0]!;
  const envelope = stored as { ciphertext: string };
  envelope.ciphertext =
    (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1);
  sample.store.values.set(key, envelope);
  await assert.rejects(sample.control(sample.create(), "counts"), {
    message: "relay_state_invalid",
  });
  assert.deepEqual(sample.store.values.get(key), envelope);
});

test("wrong run identity cannot restore prior relay snapshots", async (context) => {
  const sample = fixture(context);
  await sample.control(sample.create(), "capture-empty");
  const wrong = new ChaosRelay(sample.store.context, {
    ...sample.env,
    RUN_NAME: `pgcf-e2e-${randomBytes(8).toString("hex")}`,
  });
  await assert.rejects(sample.control(wrong, "counts"), {
    message: "relay_state_invalid",
  });
});

test("authenticated save time and a fresh nonce protect every durable update", async (context) => {
  const sample = fixture(context);
  await sample.control(sample.create(), "capture-empty");
  const [key, first] = [...sample.store.values.entries()][0]!;
  const oldNonce = (first as { nonce: string }).nonce;
  await sample.control(sample.create(), "mode", {
    mode: "empty",
    cycle_id: randomBytes(24).toString("hex"),
  });
  const stored = sample.store.values.get(key) as {
    nonce: string;
    saved_at: number;
  };
  assert.notEqual(stored.nonce, oldNonce);
  stored.saved_at--;
  await assert.rejects(sample.control(sample.create(), "counts"), {
    message: "relay_state_invalid",
  });
});

test("wrong key cannot restore prior relay snapshots", async (context) => {
  const sample = fixture(context);
  await sample.control(sample.create(), "capture-empty");
  const key = randomBytes(32).toString("hex");
  const wrong = new ChaosRelay(sample.store.context, {
    ...sample.env,
    PROBE_BEARER: key,
  });
  await assert.rejects(
    wrong.fetch(
      new Request(
        `https://${["relay", "test", "invalid"].join(".")}/control/counts`,
        { method: "POST", headers: { Authorization: `Bearer ${key}` } },
      ),
    ),
    { message: "relay_state_invalid" },
  );
});

test("stop clears durable snapshots and prevents restoration", async (context) => {
  const sample = fixture(context);
  await sample.control(sample.create(), "capture-empty");
  assert.equal(sample.store.values.size, 1);
  await sample.control(sample.create(), "stop");
  assert.equal(sample.store.values.size, 0);
  await assert.rejects(
    sample.control(sample.create(), "mode", {
      mode: "empty",
      cycle_id: randomBytes(24).toString("hex"),
    }),
    { message: "real_snapshot_unavailable" },
  );
});

test("expiry clears durable data before returning410", async (context) => {
  const sample = fixture(context);
  await sample.control(sample.create(), "capture-empty");
  assert.equal(sample.store.values.size, 1);
  const expired = new ChaosRelay(sample.store.context, {
    ...sample.env,
    RUN_EXPIRES_AT: new Date(Date.now() - 1).toISOString(),
  });
  assert.equal((await sample.control(expired, "counts")).status, 410);
  assert.equal(sample.store.values.size, 0);
});

test("persisted snapshot age is still limited to fifteen minutes", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2030, 0, 1) });
  const sample = fixture(context);
  await sample.control(sample.create(), "capture-empty");
  context.mock.timers.setTime(Date.now() + 900_001);
  await assert.rejects(
    sample.control(sample.create(), "mode", {
      mode: "empty",
      cycle_id: randomBytes(24).toString("hex"),
    }),
    { message: "real_snapshot_unavailable" },
  );
});

test("body completion waits for durable acknowledgement before it can be observed", async (context) => {
  const sample = fixture(context);
  const relay = sample.create();
  await sample.control(relay, "capture-empty");
  await sample.control(relay, "mode", {
    mode: "empty",
    cycle_id: randomBytes(24).toString("hex"),
  });
  const reply = await sample.desired(relay);
  let started!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = sample.store.context.storage.put.bind(
    sample.store.context.storage,
  );
  sample.store.context.storage.put = async (key, value) => {
    started();
    await blocked;
    await put(key, value);
  };
  let consumed = false;
  const body = reply.text().then(() => {
    consumed = true;
  });
  await writing;
  assert.equal(consumed, false);
  const prior = await (await sample.control(sample.create(), "counts")).json();
  assert.equal(prior.completed_responses, 0);
  release();
  await body;
  const acknowledged = await (
    await sample.control(sample.create(), "counts")
  ).json();
  assert.equal(acknowledged.completed_responses, 1);
});

test("a body completing after stop cannot resurrect cleared state", async (context) => {
  const sample = fixture(context);
  const relay = sample.create();
  const reply = await sample.desired(relay);
  await sample.control(relay, "stop");
  assert.equal(sample.store.values.size, 0);
  await reply.text();
  assert.equal(sample.store.values.size, 0);
});

test("a failed durable write cannot acknowledge captured state or leak its error", async (context) => {
  const sample = fixture(context);
  const canary = randomBytes(32).toString("hex");
  sample.store.context.storage.put = async () => {
    throw new Error(canary);
  };
  const relay = sample.create();
  await assert.rejects(sample.control(relay, "capture-empty"), (error) => {
    assert(error instanceof Error);
    assert.equal(error.message, "relay_state_unavailable");
    assert.equal(String(error).includes(canary), false);
    return true;
  });
  assert.equal(sample.store.values.size, 0);
  await assert.rejects(sample.control(relay, "counts"), {
    message: "relay_state_invalid",
  });
});
