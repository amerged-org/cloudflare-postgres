// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
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
