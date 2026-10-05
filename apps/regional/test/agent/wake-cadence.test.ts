// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import type { ObservationRequest } from "@pgcf/contracts";
import type { DesiredResponse } from "@pgcf/contracts";
import { AgentLoop } from "../../src/agent/loop.ts";
import { PowerCoordinator } from "../../src/agent/power.ts";
import { record } from "../../src/agent/types.ts";
import {
  fixture,
  MemoryKubernetes,
  metrics,
  authenticate,
} from "./fixtures.ts";

test("pending wake polls in one second and verified ready restores the sixty-second steady interval", async (t) => {
  const { db, ctx } = fixture();
  db.power = {
    operation: db.creation!.operation_id,
    revision: 1,
    mode: "running",
    reason: null,
  };
  const k8s = new MemoryKubernetes();
  k8s.ready = false;
  k8s.backupSecret(ctx);
  k8s.put({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "pgcf-gateway", namespace: "pgcf-system" },
    data: {
      PGCF_ROUTE_KEY: Buffer.from(
        JSON.stringify({
          active: "fixture",
          keys: { fixture: randomBytes(32).toString("base64url") },
        }),
      ).toString("base64"),
    },
  });
  for (const ordinal of [1, 2])
    k8s.put({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: `gateway-${ordinal}`,
        namespace: "pgcf-system",
        labels: { "app.kubernetes.io/name": "pgcf-gateway" },
      },
      spec: { serviceAccountName: "pgcf-gateway" },
      status: {
        podIP: [10, 20, 0, ordinal].join("."),
        containerStatuses: [{ name: "gateway", restartCount: 0 }],
      },
    });
  const controller = new AbortController(),
    scheduled: {
      callback: () => void;
      milliseconds: number;
      handle: NodeJS.Timeout;
    }[] = [];
  const original = globalThis.setTimeout;
  let notify: (() => void) | undefined;
  t.mock.method(
    globalThis,
    "setTimeout",
    (callback: () => void, milliseconds: number) => {
      const handle = original(() => {}, 600000);
      handle.unref();
      scheduled.push({ callback, milliseconds, handle });
      notify?.();
      return handle;
    },
  );
  const next = async (count: number) => {
    if (scheduled.length < count)
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    notify = undefined;
  };
  const desired: DesiredResponse = {
    region: {
      id: "eu-test",
      backup: {
        bucket: ctx.backup.bucket,
        endpoint_url: ctx.backup.endpointUrl,
        region: "auto",
      },
    },
    databases: [db],
    next: null,
  };
  const fetcher: typeof fetch = async (_url, options) => {
    const token = new Headers(options?.headers).get("X-PGCF-Control")!;
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    );
    return Response.json({
      database: db.id,
      operation: claims.operation,
      revision: claims.revision,
      pod: claims.pod,
      mode: "running",
      status: "running",
      connections: 0,
      busyConnections: 0,
      pendingDials: 0,
    });
  };
  const power = new PowerCoordinator({
    k8s,
    signal: controller.signal,
    region: "eu-test",
    replicas: 2,
    fetcher,
  });
  const loop = new AgentLoop(
    { desired: async () => desired, observations: async () => {} },
    k8s,
    ctx.postgresImage,
    controller.signal,
    () => {},
    Date.now,
    metrics,
    authenticate,
    power,
    undefined,
    undefined,
    () => 0,
  );
  const running = loop.run();
  t.after(async () => {
    controller.abort();
    for (const item of scheduled) clearTimeout(item.handle);
    await running;
  });
  await next(1);
  assert.equal(scheduled[0]!.milliseconds, 1000);
  k8s.ready = true;
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  record(cluster.status).conditions = [
    { type: "Ready", status: "True" },
    { type: "ContinuousArchiving", status: "True" },
  ];
  k8s.addStorage(db);
  scheduled[0]!.callback();
  await next(2);
  assert.equal(scheduled[1]!.milliseconds, 60000);
});

function scheduler(t: TestContext) {
  const scheduled: {
    callback: () => void;
    milliseconds: number;
    handle: NodeJS.Timeout;
  }[] = [];
  const original = globalThis.setTimeout;
  let notify: (() => void) | undefined;
  t.mock.method(
    globalThis,
    "setTimeout",
    (callback: () => void, milliseconds: number) => {
      const handle = original(() => {}, 600000);
      handle.unref();
      scheduled.push({ callback, milliseconds, handle });
      notify?.();
      return handle;
    },
  );
  t.after(() => {
    for (const item of scheduled) clearTimeout(item.handle);
  });
  return {
    scheduled,
    next: async (count: number) => {
      if (scheduled.length < count)
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      notify = undefined;
    },
  };
}

test("a wake exception retries in one second, skipped retry remains fast and verified readiness restores steady cadence", async (t) => {
  const { db, ctx } = fixture();
  db.power = {
    operation: db.creation!.operation_id,
    revision: db.generation,
    mode: "running",
    reason: null,
  };
  const k8s = new MemoryKubernetes();
  k8s.ready = false;
  k8s.failAfter = 1;
  k8s.backupSecret(ctx);
  k8s.put({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "pgcf-gateway", namespace: "pgcf-system" },
    data: {
      PGCF_ROUTE_KEY: Buffer.from(
        JSON.stringify({
          active: "fixture",
          keys: { fixture: randomBytes(32).toString("base64url") },
        }),
      ).toString("base64"),
    },
  });
  for (const ordinal of [1, 2])
    k8s.put({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: `gateway-${ordinal}`,
        namespace: "pgcf-system",
        labels: { "app.kubernetes.io/name": "pgcf-gateway" },
      },
      spec: { serviceAccountName: "pgcf-gateway" },
      status: {
        podIP: [10, 20, 0, ordinal].join("."),
        containerStatuses: [{ name: "gateway", restartCount: 0 }],
      },
    });
  const fetcher: typeof fetch = async (_url, options) => {
    const token = new Headers(options?.headers).get("X-PGCF-Control")!;
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    );
    return Response.json({
      database: db.id,
      operation: claims.operation,
      revision: claims.revision,
      pod: claims.pod,
      mode: "running",
      status: "running",
      connections: 0,
      busyConnections: 0,
      pendingDials: 0,
    });
  };
  let now = Date.now(),
    sqlSwitches = 0;
  const started = now,
    controller = new AbortController();
  const power = new PowerCoordinator({
    k8s,
    signal: controller.signal,
    region: "eu-test",
    replicas: 2,
    fetcher,
    now: () => now,
    probe: async () => {
      sqlSwitches++;
      throw new Error("unexpected_SQL_switch");
    },
  });
  const desired: DesiredResponse = {
    region: {
      id: "eu-test",
      backup: {
        bucket: ctx.backup.bucket,
        endpoint_url: ctx.backup.endpointUrl,
        region: "auto",
      },
    },
    databases: [db],
    next: null,
  };
  const reports: ObservationRequest[] = [];
  const timers = scheduler(t);
  t.mock.method(Math, "random", () => 1);
  const loop = new AgentLoop(
    {
      desired: async () => desired,
      observations: async (value) => {
        reports.push(value);
      },
    },
    k8s,
    ctx.postgresImage,
    controller.signal,
    () => {},
    () => now,
    metrics,
    authenticate,
    power,
    undefined,
    undefined,
    () => 0,
  );
  const running = loop.run();
  t.after(async () => {
    controller.abort();
    await running;
  });
  const retry = () =>
    (
      loop as unknown as {
        retries: Map<string, { nextAt: number; attempt: number }>;
      }
    ).retries.get(db.id);
  await timers.next(1);
  assert.equal(timers.scheduled[0]!.milliseconds, 1000);
  assert.deepEqual(retry(), {
    generation: db.generation,
    nextAt: started + 1000,
    attempt: 0,
  });
  assert.equal(reports[0]!.databases.length, 0);
  const mutations = k8s.mutations;
  now += 500;
  timers.scheduled[0]!.callback();
  await timers.next(2);
  assert.equal(timers.scheduled[1]!.milliseconds, 1000);
  assert.equal(k8s.mutations, mutations);
  assert.equal(retry()!.nextAt, started + 1000);
  now += 500;
  timers.scheduled[1]!.callback();
  await timers.next(3);
  assert.equal(timers.scheduled[2]!.milliseconds, 1000);
  assert.equal(reports.at(-1)!.databases[0]!.state, "provisioning");
  assert.equal(retry(), undefined);
  k8s.ready = true;
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  record(cluster.status).conditions = [
    { type: "Ready", status: "True" },
    { type: "ContinuousArchiving", status: "True" },
  ];
  k8s.addStorage(db);
  now += 1000;
  timers.scheduled[2]!.callback();
  await timers.next(4);
  assert.equal(timers.scheduled[3]!.milliseconds, 60000);
  assert.equal(reports.at(-1)!.databases[0]!.state, "ready");
  assert.equal(retry(), undefined);
  assert.equal(sqlSwitches, 0);
});

test("ordinary creation exceptions retain the five-second retry base and cancellation", async (t) => {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes();
  k8s.failAfter = 1;
  k8s.backupSecret(ctx);
  const controller = new AbortController(),
    timers = scheduler(t),
    now = Date.now();
  t.mock.method(Math, "random", () => 1);
  const desired: DesiredResponse = {
    region: {
      id: "eu-test",
      backup: {
        bucket: ctx.backup.bucket,
        endpoint_url: ctx.backup.endpointUrl,
        region: "auto",
      },
    },
    databases: [db],
    next: null,
  };
  const loop = new AgentLoop(
    { desired: async () => desired, observations: async () => {} },
    k8s,
    ctx.postgresImage,
    controller.signal,
    () => {},
    () => now,
    metrics,
    authenticate,
    undefined,
    undefined,
    undefined,
    () => 0,
  );
  const running = loop.run();
  t.after(async () => {
    controller.abort();
    await running;
  });
  await timers.next(1);
  assert.equal(timers.scheduled[0]!.milliseconds, 5000);
  const retry = (
    loop as unknown as {
      retries: Map<string, { nextAt: number; attempt: number }>;
    }
  ).retries.get(db.id)!;
  assert.equal(retry.nextAt, now + 5000);
  assert.equal(retry.attempt, 0);
  controller.abort();
  await running;
});
