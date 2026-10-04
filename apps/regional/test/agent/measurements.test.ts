// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { networkInterfaces } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { AgentApi } from "../../src/agent/api-client.ts";
import { measurementBatches } from "../../src/agent/measurements.ts";
import { newDatabaseId } from "@pgcf/contracts";
import { test } from "node:test";
import { RegionalMeasurements } from "../../src/agent/measurements.ts";
import { Reconciler } from "../../src/agent/reconcile.ts";
import {
  fixture,
  MemoryKubernetes,
  authenticate,
  metrics,
} from "./fixtures.ts";
import { record } from "../../src/agent/types.ts";
import { gatewayFenceName } from "@pgcf/contracts/gateway-control";
import {
  GATEWAY_ACTIVITY_HEADER,
  verifyGatewayActivity,
} from "@pgcf/contracts/gateway-activity";
import type { GatewayActivityReport } from "@pgcf/contracts/gateway-activity";
import type { AgentActivityRequest, AgentUsageRequest } from "@pgcf/contracts";

async function setup() {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const signal = new AbortController().signal;
  k8s.backupSecret(ctx);
  await new Reconciler(k8s, signal, Date.now, metrics, authenticate).reconcile(
    db,
    ctx,
  );
  k8s.put({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: gatewayFenceName(db.id),
      namespace: "pgcf-system",
      labels: { "pgcf.io/gateway-fence": "true", "pgcf.io/database-id": db.id },
    },
    data: {
      "intent.json": JSON.stringify({
        database: db.id,
        operation: db.creation!.operation_id,
        revision: 1,
        mode: "running",
      }),
    },
  });
  let now = Math.floor(Date.now() / 3600000) * 3600000 + 120000;
  const pods = [1, 2].map((number) => ({
    name: `gateway-${number}`,
    uid: randomUUID(),
    ip: [10, 20, 0, number].join("."),
    restarts: 0,
  }));
  const keyring = {
    active: "fixture",
    keys: new Map([["fixture", randomBytes(32)]]),
  };
  const snapshot = { pods, keyring, keyUid: randomUUID(), keyVersion: "1" };
  let count = 100;
  const reports = new Map(
    pods.map((pod) => [
      pod.uid,
      {
        region: "eu-test",
        database: db.id,
        revision: 1,
        pod: pod.uid,
        processEpoch: randomUUID(),
        epoch: randomUUID(),
        startedAt: new Date(now - 60000).toISOString(),
        counterStartedAt: new Date(now - 60000).toISOString(),
        observedAt: new Date(now).toISOString(),
        history: "complete",
        countersSince: new Date(now - 60000).toISOString(),
        ingressBytes: count,
        egressBytes: count * 2,
        totalConnections: 1,
        connectionMilliseconds: 1000,
        connections: 1,
        authenticatedConnections: 1,
        busyConnections: 0,
        pendingDials: 0,
        lastActivityAt: new Date(now - 60000).toISOString(),
      } as GatewayActivityReport,
    ]),
  );
  const activities: AgentActivityRequest[] = [],
    usages: AgentUsageRequest[] = [];
  let lose = false;
  const api = {
    async activity(value: AgentActivityRequest) {
      activities.push(structuredClone(value));
    },
    async usage(value: AgentUsageRequest) {
      usages.push(structuredClone(value));
      if (lose) {
        lose = false;
        throw new Error("fixture_response_lost");
      }
    },
  };
  const fetcher: typeof fetch = async (input, options) => {
    const host = new URL(String(input)).hostname,
      pod = pods.find((value) => value.ip === host)!;
    assert.equal(
      (
        await verifyGatewayActivity(
          new Headers(options?.headers).get(GATEWAY_ACTIVITY_HEADER),
          { keys: keyring.keys, region: "eu-test", pod: pod.uid, now },
        )
      ).ok,
      true,
    );
    return Response.json({
      ...reports.get(pod.uid),
      observedAt: new Date(now).toISOString(),
      ingressBytes: count,
      egressBytes: count * 2,
    });
  };
  const make = () =>
    new RegionalMeasurements({
      k8s,
      signal,
      region: "eu-test",
      snapshot: async () => structuredClone(snapshot),
      fetcher,
      api,
      now: () => now,
    });
  return {
    db,
    k8s,
    reports,
    snapshot,
    activities,
    usages,
    api,
    fetcher,
    signal,
    make,
    clock(value: number) {
      now = value;
    },
    advance(ms: number) {
      now += ms;
      count += 25;
    },
    now: () => now,
    lose() {
      lose = true;
    },
  };
}

test("exact cumulative deltas are checkpointed and a lost usage response replays the identical payload", async () => {
  const state = await setup();
  const meter = state.make();
  meter.update([state.db]);
  await meter.cycle();
  state.advance(15000);
  state.lose();
  await meter.cycle();
  const pending = state.usages.at(-1)!;
  const gateway = pending.samples.filter(
    (sample) => sample.source === "gateway",
  );
  assert.equal(gateway.length, 2);
  assert.equal(
    gateway[0]!.source === "gateway" && gateway[0]!.ingress_bytes,
    25,
  );
  const restarted = state.make();
  restarted.update([state.db]);
  await restarted.cycle();
  assert.deepEqual(state.usages.at(-1), pending);
  assert.equal(state.activities.at(-1)!.databases[0]!.busy_connections, 0);
  const map = state.k8s.resources.get(
    state.k8s.key("ConfigMap", "pgcf-system", `storage-${state.db.id}`),
  )!;
  assert.equal(record(map.data).state !== undefined, true);
});

test("a changed Pod IP or restart inventory cannot reuse an old idle boundary", async () => {
  const state = await setup(),
    meter = state.make();
  meter.update([state.db]);
  await meter.cycle();
  const before = state.activities.length;
  state.advance(15000);
  state.snapshot.pods[0]!.ip = [10, 20, 1, 1].join(".");
  state.snapshot.pods[0]!.restarts++;
  await meter.cycle();
  assert.equal(state.activities.length, before);
});

test("missing and partial histories withhold idle through recovery until a real boundary advances", async () => {
  const state = await setup(),
    meter = state.make();
  meter.update([state.db]);
  await meter.cycle();
  const before = state.activities.length;
  state.advance(15000);
  for (const report of state.reports.values()) {
    report.history = "unavailable";
    report.countersSince = null;
    report.ingressBytes = null;
    report.egressBytes = null;
    report.totalConnections = null;
    report.connectionMilliseconds = null;
  }
  // The response double retains real-schema unavailable counters rather than filling them with zero.
  const fetcher: typeof fetch = async (input, options) => {
    const response = await state.fetcher(input, options);
    const value = (await response.json()) as GatewayActivityReport;
    return Response.json({ ...value, ingressBytes: null, egressBytes: null });
  };
  const unavailable = new RegionalMeasurements({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    snapshot: async () => structuredClone(state.snapshot),
    api: state.api,
    fetcher,
    now: state.now,
  });
  unavailable.update([state.db]);
  await unavailable.cycle();
  assert.equal(state.activities.length, before);
  for (const report of state.reports.values()) {
    report.history = "complete";
    report.countersSince = report.counterStartedAt;
    report.ingressBytes = 100;
    report.egressBytes = 200;
    report.totalConnections = 1;
    report.connectionMilliseconds = 1000;
  }
  state.advance(15000);
  const recovered = state.make();
  recovered.update([state.db]);
  await recovered.cycle();
  assert.equal(state.activities.length, before);
  for (const report of state.reports.values())
    report.lastActivityAt = new Date(state.now()).toISOString();
  state.advance(15000);
  await recovered.cycle();
  assert.equal(state.activities.length, before + 1);
});

test("counter epoch changes produce a coverage gap and never subtract across process reset", async () => {
  const state = await setup(),
    meter = state.make();
  meter.update([state.db]);
  await meter.cycle();
  state.advance(15000);
  const report = state.reports.values().next().value!;
  report.processEpoch = randomUUID();
  report.epoch = randomUUID();
  report.startedAt = new Date(state.now()).toISOString();
  report.counterStartedAt = report.startedAt;
  report.countersSince = report.startedAt;
  report.lastActivityAt = report.startedAt;
  await meter.cycle();
  const samples = state.usages
    .at(-1)!
    .samples.filter((value) => value.source === "gateway");
  assert.equal(samples.length, 2);
  assert.equal(
    samples.find((value) => value.producer_id.includes(report.processEpoch))
      ?.source === "gateway",
    true,
  );
  assert.equal(
    samples.find((value) => value.producer_id.includes(report.processEpoch))
      ?.ingress_bytes,
    null,
  );
});

test("UTC hour straddles remain null fragments and never allocate traffic proportionally", async () => {
  const state = await setup();
  const hour = Math.floor(state.now() / 3600000) * 3600000;
  state.clock(hour + 3599000);
  const meter = state.make();
  meter.update([state.db]);
  await meter.cycle();
  state.advance(15000);
  await meter.cycle();
  const samples = state.usages
    .at(-1)!
    .samples.filter((value) => value.source === "gateway");
  assert.equal(samples.length, 4);
  for (const sample of samples) {
    assert.equal(sample.ingress_bytes, null);
    assert.equal(sample.egress_bytes, null);
    if (sample.source === "gateway")
      assert.equal(
        Math.floor(Date.parse(sample.interval_start) / 3600000),
        Math.floor((Date.parse(sample.interval_end) - 1) / 3600000),
      );
  }
});

test("active SQL and pending dials are forwarded as busy evidence, even for idle-open connections", async () => {
  const state = await setup();
  for (const report of state.reports.values()) {
    report.busyConnections = 1;
    report.pendingDials = 0;
  }
  const meter = state.make();
  meter.update([state.db]);
  await meter.cycle();
  assert.equal(state.activities[0]!.databases[0]!.connections, 2);
  assert.equal(state.activities[0]!.databases[0]!.busy_connections, 2);
});

test("wrong report region/revision and changed inventory during a read never deliver activity", async () => {
  const state = await setup();
  const bad: typeof fetch = async (input, options) => {
    const response = await state.fetcher(input, options);
    return Response.json({
      ...((await response.json()) as object),
      region: "wrong-region",
      revision: 2,
    });
  };
  const meter = new RegionalMeasurements({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    snapshot: async () => structuredClone(state.snapshot),
    fetcher: bad,
    api: state.api,
    now: state.now,
  });
  meter.update([state.db]);
  await meter.cycle();
  assert.equal(state.activities.length, 0);
  let reads = 0;
  const unstable = new RegionalMeasurements({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    snapshot: async () => {
      const value = structuredClone(state.snapshot);
      if (++reads === 2) value.pods[0]!.uid = randomUUID();
      return value;
    },
    fetcher: state.fetcher,
    api: state.api,
    now: state.now,
  });
  unstable.update([state.db]);
  await unstable.cycle();
  assert.equal(state.activities.length, 0);
});

test("cohort paging is fair for one thousand subjects and each API batch obeys count/byte bounds", async () => {
  const state = await setup(),
    subjects = Array.from({ length: 1000 }, () => ({
      ...state.db,
      id: newDatabaseId(),
    }));
  const seen = new Set<string>(),
    baseRead = state.k8s.read.bind(state.k8s);
  let inCycle = new Set<string>();
  state.k8s.read = async (kind, namespace, name) => {
    if (kind === "Namespace") {
      seen.add(name);
      inCycle.add(name);
    }
    return baseRead(kind, namespace, name);
  };
  const meter = state.make();
  meter.update(subjects);
  for (let cohort = 0; cohort < 40; cohort++) {
    inCycle = new Set();
    await meter.cycle();
    assert.equal(inCycle.size, 25);
  }
  assert.equal(seen.size, 1000);
  const records = Array.from({ length: 60 }, (_, ordinal) => ({
    ordinal,
    payload: "x".repeat(4000),
  }));
  for (const batch of measurementBatches("samples", records)) {
    assert.ok(batch.length <= 25);
    assert.ok(Buffer.byteLength(JSON.stringify({ samples: batch })) <= 65536);
  }
});

test("API usage validates acknowledgements and sends only authenticated bounded relay requests", async () => {
  const state = await setup(),
    token = randomBytes(32).toString("base64url");
  let sent = 0;
  const sample = {
    database_id: state.db.id,
    source: "agent" as const,
    producer_id: "fixture",
    sequence: 1,
    observed_at: new Date(state.now()).toISOString(),
    storage_used_bytes: null,
    storage_allocated_bytes: 1,
  };
  const api = new AgentApi(
    {
      apiUrl: `https://${["api", "example", "invalid"].join(".")}`,
      regionId: "eu-test",
      agentKey: token,
    },
    async (input, options) => {
      sent++;
      assert.equal(new URL(String(input)).pathname, "/agent/v1/usage");
      assert.equal(
        new Headers(options?.headers).get("Authorization") ===
          `Bearer ${token}`,
        true,
      );
      assert.equal(options?.redirect, "error");
      return Response.json({ recorded: 0, duplicates: 1 });
    },
  );
  await api.usage({ samples: [sample] }, state.signal);
  assert.equal(sent, 1);
  const invalid = new AgentApi(
    {
      apiUrl: `https://${["api", "example", "invalid"].join(".")}`,
      regionId: "eu-test",
      agentKey: token,
    },
    async () => Response.json({ recorded: 0, duplicates: 0 }),
  );
  await assert.rejects(
    invalid.usage({ samples: [sample] }, state.signal),
    /usage_ack_invalid/,
  );
  await assert.rejects(
    api.usage(
      { samples: Array.from({ length: 26 }, () => sample) },
      state.signal,
    ),
    /usage_measurements_invalid/,
  );
  assert.equal(sent, 1);
});

test("collection cancellation reaps pending reads and delivers no partial idle observation", async () => {
  const state = await setup(),
    controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const fetcher: typeof fetch = async (_input, options) => {
    entered();
    await new Promise<void>((_resolve, reject) => {
      options!.signal!.addEventListener(
        "abort",
        () => reject(new Error("fixture_aborted")),
        { once: true },
      );
    });
    throw new Error("unreachable fixture");
  };
  const meter = new RegionalMeasurements({
    k8s: state.k8s,
    signal: controller.signal,
    region: "eu-test",
    snapshot: async () => structuredClone(state.snapshot),
    fetcher,
    api: state.api,
    now: state.now,
  });
  meter.update([state.db]);
  const pending = meter.cycle();
  await started;
  controller.abort();
  await assert.rejects(pending);
  assert.equal(state.activities.length, 0);
  assert.equal(state.usages.length, 0);
});

test("actual local HTTP sockets receive fresh activity-purpose tokens and preserve power proof data", async (t) => {
  const state = await setup(),
    loopback = Object.values(networkInterfaces())
      .flat()
      .find((value) => value?.internal && value.family === "IPv4")!.address;
  const marker = state.k8s.resources.get(
    state.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(state.db.id)),
  )!;
  record(marker.data)["power.json"] = JSON.stringify({
    fixture: "preserved-power-proof",
  });
  const originalState = record(
    state.k8s.resources.get(
      state.k8s.key("ConfigMap", "pgcf-system", `storage-${state.db.id}`),
    )!.data,
  ).state;
  const peers = new Set<import("node:stream").Duplex>();
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls++;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/_pgcf/gateway/activity");
    const header = request.headers[GATEWAY_ACTIVITY_HEADER.toLowerCase()];
    assert.equal(typeof header, "string");
    assert.equal((header as string).startsWith("ga1."), true);
    const claims = JSON.parse(
      Buffer.from((header as string).split(".")[1]!, "base64url").toString(),
    );
    const pod = state.snapshot.pods.find((value) => value.uid === claims.pod)!;
    const supplied = await state.fetcher(
      `http://${pod.ip}:8080/_pgcf/gateway/activity`,
      { headers: { [GATEWAY_ACTIVITY_HEADER]: header as string } },
    );
    response.setHeader("Content-Type", "application/json");
    response.end(await supplied.text());
  });
  server.on("connection", (socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
  });
  server.listen(0, loopback);
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const transport: typeof fetch = (input, options) => {
    const target = new URL(String(input));
    assert.equal(target.port, "8080");
    target.hostname = loopback;
    target.port = String(address.port);
    return fetch(target, options);
  };
  const meter = new RegionalMeasurements({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    snapshot: async () => structuredClone(state.snapshot),
    fetcher: transport,
    api: state.api,
    now: state.now,
  });
  meter.update([state.db]);
  await meter.cycle();
  assert.equal(calls, 2);
  assert.equal(state.activities.length, 1);
  assert.equal(
    record(marker.data)["power.json"],
    JSON.stringify({ fixture: "preserved-power-proof" }),
  );
  assert.equal(
    record(
      state.k8s.resources.get(
        state.k8s.key("ConfigMap", "pgcf-system", `storage-${state.db.id}`),
      )!.data,
    ).state,
    originalState,
  );
});

test("durable paging resumes the next subject after collector reconstruction", async () => {
  const first = await setup(),
    second = await setup(),
    third = await setup();
  for (const source of [second, third])
    for (const [key, resource] of source.k8s.resources)
      if (!first.k8s.resources.has(key)) first.k8s.resources.set(key, resource);
  const targets = [first.db, second.db, third.db].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const seen: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const claims = JSON.parse(
      Buffer.from(
        new Headers(options?.headers)
          .get(GATEWAY_ACTIVITY_HEADER)!
          .split(".")[1]!,
        "base64url",
      ).toString(),
    );
    seen.push(claims.database);
    const base = await first.fetcher(input, options);
    return Response.json({
      ...((await base.json()) as object),
      database: claims.database,
    });
  };
  const make = () =>
    new RegionalMeasurements({
      k8s: first.k8s,
      signal: first.signal,
      region: "eu-test",
      snapshot: async () => structuredClone(first.snapshot),
      fetcher,
      api: first.api,
      now: first.now,
      cohort: 1,
    });
  const initial = make();
  initial.update(targets);
  await initial.cycle();
  const resumed = make();
  resumed.update(targets);
  await resumed.cycle();
  assert.deepEqual([...new Set(seen)], [targets[0]!.id, targets[1]!.id]);
});

test("unpersisted deltas after a checkpoint CAS conflict never reach usage ingestion", async () => {
  const state = await setup(),
    meter = state.make();
  meter.update([state.db]);
  await meter.cycle();
  const before = state.usages.length;
  state.advance(15000);
  const patch = state.k8s.patch.bind(state.k8s);
  let conflict = true;
  state.k8s.patch = async (kind, namespace, name, operations) => {
    if (
      conflict &&
      operations.some(
        (value) => record(value).path === "/data/measurements.json",
      )
    ) {
      conflict = false;
      throw new Error("fixture_concurrent_checkpoint");
    }
    return patch(kind, namespace, name, operations);
  };
  await meter.cycle();
  assert.equal(state.usages.length, before);
});

test("a changed namespace identity cannot deliver idle or manufacture allocated storage", async () => {
  const state = await setup();
  const namespace = state.k8s.resources.get(
    state.k8s.key("Namespace", undefined, `pgcf-db-${state.db.id}`),
  )!;
  state.k8s.put(namespace);
  const meter = state.make();
  meter.update([state.db]);
  await meter.cycle();
  assert.equal(state.activities.length, 0);
  assert.equal(state.usages.length, 0);
});

test("backward respondent time never rewinds a baseline into overlapping intervals", async () => {
  const state = await setup(),
    meter = state.make();
  meter.update([state.db]);
  await meter.cycle();
  state.advance(15000);
  await meter.cycle();
  const storage = state.k8s.resources.get(
    state.k8s.key("ConfigMap", "pgcf-system", `storage-${state.db.id}`),
  )!;
  const baseline = JSON.parse(
    String(record(storage.data)["measurements.json"]),
  ).baseline;
  const count = state.activities.length;
  state.clock(state.now() - 500);
  await meter.cycle();
  assert.deepEqual(
    JSON.parse(String(record(storage.data)["measurements.json"])).baseline,
    baseline,
  );
  assert.equal(state.activities.length, count);
});

test("one database samples at most every fifteen seconds over an hour of fast cohort ticks", async () => {
  const state = await setup();
  let reads = 0,
    calls = 0;
  const read = state.k8s.read.bind(state.k8s);
  state.k8s.read = async (...args) => {
    reads++;
    return read(...args);
  };
  const meter = new RegionalMeasurements({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    snapshot: async () => structuredClone(state.snapshot),
    fetcher: async (...args) => {
      calls++;
      return state.fetcher(...args);
    },
    api: state.api,
    now: state.now,
  });
  meter.update([state.db]);
  await meter.cycle();
  const started = state.now();
  let lastRead = reads;
  for (let tick = 1; tick <= 14400; tick++) {
    state.advance(250);
    await meter.cycle();
    assert.ok(calls <= 2 * (Math.floor((state.now() - started) / 15000) + 1));
    if (tick % 60 !== 0) assert.equal(reads, lastRead);
    lastRead = reads;
  }
  assert.equal(calls, 482);
  assert.equal(state.activities.length, 241);
  assert.ok(
    state.usages.reduce((sum, batch) => sum + batch.samples.length, 0) <= 727,
  );
  const resumed = state.make();
  resumed.update([state.db]);
  state.advance(250);
  const count = state.usages.length;
  await resumed.cycle();
  assert.equal(state.usages.length, count);
});

test("cooldown resumes from actual checkpoints but revision changes and missing checkpoints measure freshly", async () => {
  const state = await setup();
  let calls = 0;
  const make = () =>
    new RegionalMeasurements({
      k8s: state.k8s,
      signal: state.signal,
      region: "eu-test",
      snapshot: async () => structuredClone(state.snapshot),
      fetcher: async (input, options) => {
        calls++;
        const response = await state.fetcher(input, options);
        return Response.json({
          ...((await response.json()) as object),
          revision: state.db.generation,
        });
      },
      api: state.api,
      now: state.now,
    });
  const meter = make();
  meter.update([state.db]);
  await meter.cycle();
  assert.equal(calls, 2);
  state.advance(250);
  const resumed = make();
  resumed.update([state.db]);
  await resumed.cycle();
  assert.equal(calls, 2);
  state.db.generation = 2;
  const fence = state.k8s.resources.get(
    state.k8s.key("ConfigMap", "pgcf-system", gatewayFenceName(state.db.id)),
  )!;
  const intent = JSON.parse(String(record(fence.data)["intent.json"]));
  intent.revision = 2;
  record(fence.data)["intent.json"] = JSON.stringify(intent);
  resumed.update([state.db]);
  await resumed.cycle();
  assert.equal(calls, 4);
  const storage = state.k8s.resources.get(
    state.k8s.key("ConfigMap", "pgcf-system", `storage-${state.db.id}`),
  )!;
  delete record(storage.data)["measurements.json"];
  const absent = make();
  absent.update([state.db]);
  await absent.cycle();
  assert.equal(calls, 6);
});

test("immutable pending usage replays during cooldown without another gateway poll", async () => {
  const state = await setup();
  let calls = 0;
  const make = () =>
    new RegionalMeasurements({
      k8s: state.k8s,
      signal: state.signal,
      region: "eu-test",
      snapshot: async () => structuredClone(state.snapshot),
      fetcher: async (...args) => {
        calls++;
        return state.fetcher(...args);
      },
      api: state.api,
      now: state.now,
    });
  const meter = make();
  meter.update([state.db]);
  await meter.cycle();
  state.advance(15000);
  state.lose();
  await meter.cycle();
  const payload = structuredClone(state.usages.at(-1));
  assert.equal(calls, 4);
  state.advance(250);
  const resumed = make();
  resumed.update([state.db]);
  state.lose();
  await resumed.cycle();
  assert.deepEqual(state.usages.at(-1), payload);
  assert.equal(calls, 4);
  state.advance(20000);
  state.lose();
  await resumed.cycle();
  assert.deepEqual(state.usages.at(-1), payload);
  assert.equal(calls, 4);
  state.advance(250);
  await resumed.cycle();
  assert.equal(calls, 4);
  state.advance(250);
  await resumed.cycle();
  assert.equal(calls, 6);
});

test("an accepted future gateway timestamp cannot bypass the fifteen-second sampling floor", async () => {
  const state = await setup();
  let calls = 0;
  const meter = new RegionalMeasurements({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    snapshot: async () => structuredClone(state.snapshot),
    fetcher: async (input, options) => {
      calls++;
      const response = await state.fetcher(input, options);
      return Response.json({
        ...((await response.json()) as object),
        observedAt: new Date(state.now() + 5000).toISOString(),
      });
    },
    api: state.api,
    now: state.now,
  });
  meter.update([state.db]);
  await meter.cycle();
  state.advance(250);
  await meter.cycle();
  assert.equal(calls, 2);
});

test("accepted lagging gateway time uses actual receipt cadence without changing report coverage", async () => {
  const state = await setup();
  let calls = 0;
  const meter = new RegionalMeasurements({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    snapshot: async () => structuredClone(state.snapshot),
    fetcher: async (input, options) => {
      calls++;
      const response = await state.fetcher(input, options);
      return Response.json({
        ...((await response.json()) as object),
        observedAt: new Date(state.now() - 30000).toISOString(),
      });
    },
    api: state.api,
    now: state.now,
  });
  meter.update([state.db]);
  await meter.cycle();
  const raw = state.activities[0]!.databases[0]!.reports[0]!.observedAt;
  state.advance(250);
  await meter.cycle();
  assert.equal(calls, 2);
  assert.equal(raw, new Date(state.now() - 30250).toISOString());
  const restarted = new RegionalMeasurements({
    k8s: state.k8s,
    signal: state.signal,
    region: "eu-test",
    snapshot: async () => structuredClone(state.snapshot),
    fetcher: async (...args) => {
      calls++;
      return state.fetcher(...args);
    },
    api: state.api,
    now: state.now,
  });
  restarted.update([state.db]);
  await restarted.cycle();
  assert.equal(calls, 2);
});
