// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { AgentApi, boundedText } from "../../src/agent/api-client.ts";
import { readConfig } from "../../src/agent/config.ts";
import { AgentLink } from "../../src/agent/link.ts";
import { AgentLoop } from "../../src/agent/loop.ts";
import { DATABASE_LABEL } from "../../src/agent/observe.ts";
import type { DesiredResponse, ObservationRequest } from "@pgcf/contracts";
import {
  fixture,
  MemoryKubernetes,
  metrics,
  authenticate,
} from "./fixtures.ts";

function desired(
  db: DesiredResponse["databases"][number] | undefined,
): DesiredResponse {
  const { ctx } = fixture();
  return {
    region: {
      id: "eu-test",
      backup: {
        bucket: ctx.backup.bucket,
        endpoint_url: ctx.backup.endpointUrl,
        region: "auto",
      },
    },
    databases: db ? [db] : [],
    next: null,
  };
}

test("backup credential outage cannot block another database's deletion", async () => {
  const { db, ctx } = fixture();
  const removed = {
    ...fixture().db,
    desired_state: "deleted" as const,
    roles: [],
  };
  const k8s = new MemoryKubernetes();
  k8s.ownedNamespace(removed);
  const reports: ObservationRequest[] = [];
  const api = {
    desired: async () => ({ ...desired(db), databases: [db, removed] }),
    observations: async (value: ObservationRequest) => {
      reports.push(value);
    },
  };
  const loop = new AgentLoop(
    api,
    k8s,
    ctx.postgresImage,
    new AbortController().signal,
    () => {},
    Date.now,
    metrics,
    authenticate,
  );
  await loop.cycle();
  assert.equal(
    reports[0]?.databases.find((value) => value.id === removed.id)?.state,
    "deleted",
  );
  assert.equal(
    await k8s.read("Namespace", undefined, `pgcf-db-${removed.id}`),
    null,
  );
});

test("API client fetches full pages and authenticates observations; HTTP errors expose no body", async () => {
  const { db } = fixture();
  const key = `pgcf_ak_eu-test_${randomBytes(32).toString("base64url")}`;
  let requests = 0;
  let observed = false;
  let failed = false;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    if (failed) {
      response.writeHead(500);
      response.end(key);
      return;
    }
    if (request.method === "POST") {
      for await (const chunk of request) assert.ok(chunk);
      observed = true;
      response.writeHead(204);
      response.end();
      return;
    }
    requests += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        requests === 1 ? { ...desired(db), next: db.id } : desired(undefined),
      ),
    );
  });
  server.listen(0);
  await once(server, "listening");
  const origin = `http://${["local", "host"].join("")}:${(server.address() as AddressInfo).port}`;
  const client = new AgentApi({
    apiUrl: origin,
    agentKey: key,
    regionId: "eu-test",
  });
  try {
    const pulled = await client.desired(new AbortController().signal);
    assert.equal(pulled.databases.length, 1);
    assert.equal(requests, 2);
    await client.observations(
      {
        observed_at: new Date().toISOString(),
        nodes: [],
        databases: [],
        orphans: [],
      },
      new AbortController().signal,
    );
    assert.equal(observed, true);
    failed = true;
    await assert.rejects(
      client.desired(new AbortController().signal),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "agent_api_http_500" &&
        !error.message.includes(key),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("API rejects duplicate pages, changing region, oversized bodies and aborts", async () => {
  const { db } = fixture();
  const response = { ...desired(db), next: db.id };
  const duplicates: typeof fetch = async () =>
    new Response(JSON.stringify(response));
  await assert.rejects(
    new AgentApi(
      {
        apiUrl: `https://${["api", "example", "invalid"].join(".")}`,
        agentKey: randomBytes(32).toString("base64url"),
        regionId: "eu-test",
      },
      duplicates,
    ).desired(new AbortController().signal),
    /duplicate/,
  );
  await assert.rejects(
    boundedText(new Response("a".repeat(101)), 100),
    /too_large/,
  );
  const wrong: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        ...desired(undefined),
        region: { ...desired(undefined).region, id: "us-test" },
      }),
    );
  await assert.rejects(
    new AgentApi(
      {
        apiUrl: `https://${["api", "example", "invalid"].join(".")}`,
        agentKey: randomBytes(32).toString("base64url"),
        regionId: "eu-test",
      },
      wrong,
    ).desired(new AbortController().signal),
    /region/,
  );
});

test("empty and stale snapshots, reordered hints and failed pulls never delete or downgrade; orphans only report", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  k8s.backupSecret(ctx);
  let snapshot = desired({ ...db, generation: 2 });
  let fail = false;
  const reports: ObservationRequest[] = [];
  const controller = new AbortController();
  const api = {
    desired: async () => {
      if (fail) throw new Error("http_500");
      return snapshot;
    },
    observations: async (observation: ObservationRequest) => {
      reports.push(observation);
    },
  };
  const logs: string[] = [];
  const loop = new AgentLoop(
    api,
    k8s,
    ctx.postgresImage,
    controller.signal,
    (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    Date.now,
    metrics,
    authenticate,
  );
  await loop.cycle();
  const before = k8s.actions.length;
  snapshot = desired(undefined);
  loop.hint();
  await loop.cycle();
  assert.equal(k8s.actions.length, before);
  assert.equal(reports.at(-1)?.orphans[0]?.database_id, db.id);
  snapshot = desired(db);
  await loop.cycle();
  loop.hint();
  assert.equal(k8s.actions.length, before);
  fail = true;
  await assert.rejects(loop.cycle());
  assert.equal(k8s.actions.length, before);
  assert.ok(await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`));
  assert.equal(
    k8s.actions.some((action) => action.startsWith("delete:")),
    false,
  );
  const orphan = k8s.ownedNamespace({ ...db, id: fixture().db.id });
  assert.ok(orphan.metadata.labels?.[DATABASE_LABEL]);
});

test("credential canaries never appear in agent failure logs and shutdown ends an idle loop", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  k8s.backupSecret(ctx);
  const canary = db.roles[0]!.password;
  k8s.failAfter = 1;
  const controller = new AbortController();
  const logs: string[] = [];
  const api = {
    desired: async () => desired(db),
    observations: async () => {
      controller.abort();
    },
  };
  const loop = new AgentLoop(
    api,
    k8s,
    ctx.postgresImage,
    controller.signal,
    (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    Date.now,
    metrics,
    authenticate,
  );
  await loop.run();
  assert.ok(logs.some((line) => line.includes("database_reconcile_failed")));
  assert.equal(logs.join("\n").includes(canary), false);
  assert.equal(
    logs.join("\n").includes(ctx.backup.credentials.secretAccessKey),
    false,
  );
  assert.equal(
    logs.join("\n").includes(ctx.backup.credentials.accessKeyId),
    false,
  );
});

test("link authenticates hello/welcome, coalesces hints and closes on shutdown", async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const key = randomBytes(32).toString("base64url");
  const controller = new AbortController();
  let hints = 0;
  let messages = 0;
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    socket.on("message", (value) => {
      messages += 1;
      const hello = JSON.parse(value.toString()) as {
        type: string;
        protocol: number;
      };
      assert.equal(hello.type, "hello");
      assert.equal(hello.protocol, 1);
      socket.send(JSON.stringify({ type: "welcome", protocol: 1 }));
      socket.send(JSON.stringify({ type: "desired" }));
    });
  });
  const connect = (_url: URL, options: WebSocket.ClientOptions) =>
    new WebSocket(
      `ws://${["local", "host"].join("")}:${(server.address() as AddressInfo).port}`,
      options,
    );
  const link = new AgentLink(
    {
      apiUrl: `https://${["api", "example", "invalid"].join(".")}`,
      agentKey: key,
    },
    () => {
      hints += 1;
      if (hints === 2) controller.abort();
    },
    () => {},
    "test",
    connect,
  );
  try {
    await link.run(controller.signal);
    assert.equal(messages, 1);
    assert.equal(hints, 2);
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("configuration matches deployed environment names and requires a pinned image", async () => {
  const { ctx } = fixture();
  const env = {
    PGCF_REGION_ID: "eu-test",
    PGCF_API_URL: `https://${["api", "example", "invalid"].join(".")}`,
    PGCF_AGENT_KEY: `pgcf_ak_eu-test_${randomBytes(32).toString("base64url")}`,
    PGCF_POSTGRES_IMAGE: ctx.postgresImage,
  };
  assert.equal((await readConfig(env)).regionId, "eu-test");
  await assert.rejects(
    readConfig({ ...env, PGCF_POSTGRES_IMAGE: "postgres:18" }),
    /pinned/,
  );
  await assert.rejects(
    readConfig({ ...env, PGCF_AGENT_KEY_FILE: "unused" }),
    /ambiguous/,
  );
  await assert.rejects(
    readConfig({
      ...env,
      PGCF_AGENT_KEY: randomBytes(32).toString("base64url"),
    }),
    /invalid_agent_key/,
  );
});
