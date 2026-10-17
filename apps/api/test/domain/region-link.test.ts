// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  type DesiredResponse,
  LinkDesiredHint,
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
  newRolePassword,
} from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(cleanupFixtures);

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    }),
  );
}
async function connect(
  stub: ReturnType<typeof env.REGION_LINK.get>,
): Promise<WebSocket> {
  const response = await stub.fetch(
    new Request(`https://${["link", "invalid"].join(".")}/agent/v1/link`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const welcome = nextMessage(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      agent_version: "test",
      instance_id: crypto.randomUUID(),
    }),
  );
  expect(JSON.parse(await welcome)).toEqual({ type: "welcome", protocol: 1 });
  return socket;
}
it("sends real DO hints after hibernation and replaces the previous agent socket", async () => {
  const stub = env.REGION_LINK.get(
      env.REGION_LINK.idFromName(crypto.randomUUID()),
    ),
    id = newDatabaseId();
  const first = await connect(stub);
  const hint = nextMessage(first);
  expect(await stub.notify([id])).toBe(1);
  expect(JSON.parse(await hint)).toEqual({ type: "desired", ids: [id] });
  await evictDurableObject(stub);
  const resumed = nextMessage(first);
  expect(await stub.notify([id])).toBe(1);
  expect(JSON.parse(await resumed)).toEqual({ type: "desired", ids: [id] });
  const replaced = new Promise<number>((resolve) =>
    first.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  const second = await connect(stub);
  expect(await replaced).toBe(1012);
  const next = nextMessage(second);
  expect(await stub.notify([id])).toBe(1);
  expect(JSON.parse(await next)).toEqual({ type: "desired", ids: [id] });
  second.close(1000);
});
/** A valid desired page of one database; `sources` recovery sources make it as large as needed. */
function page(region: string, id: string, sources = 0): DesiredResponse {
  return {
    region: {
      id: region,
      backup: {
        bucket: "pgcf-backups",
        endpoint_url: `https://${["archive", "invalid"].join(".")}`,
        region: "auto",
      },
      ...(sources
        ? {
            recovery_sources: Object.fromEntries(
              Array.from({ length: sources }, (_, n) => [
                `source-${n}`,
                {
                  bucket: "pgcf-backups",
                  endpoint_url: `https://${["archive", "invalid"].join(".")}`,
                  access_key_id: "k".repeat(4096),
                  secret_access_key: "s".repeat(4096),
                },
              ]),
            ),
          }
        : {}),
    },
    databases: [
      {
        id,
        generation: 1,
        desired_state: "running",
        node: "node-one",
        pg_major: 18,
        size: {
          memory_mib: 512,
          cpu_millicores: 500,
          storage_gib: 5,
          max_connections: 50,
          archive_timeout_seconds: 60,
          backup_retention_days: 7,
        },
        roles: [
          {
            name: "app",
            owner: true,
            password: newRolePassword(),
            revision: 1,
          },
        ],
        archive: {
          destination_path: archiveDestinationPath(
            "pgcf-backups",
            region,
            id,
            1,
            newOperationId(),
          ),
          server_name: "database",
        },
      },
    ],
    next: null,
  };
}
it("carries a wake's page only when it is valid for its one database and fits the link", async () => {
  const region = "eu-" + crypto.randomUUID().slice(0, 8),
    stub = env.REGION_LINK.get(env.REGION_LINK.idFromName(region)),
    id = newDatabaseId();
  const socket = await connect(stub);
  const received = async (desired: DesiredResponse, ids = [id]) => {
    const message = nextMessage(socket);
    expect(await stub.notify(ids, desired)).toBe(1);
    return JSON.parse(await message);
  };
  const carried = page(region, id);
  expect(await received(carried)).toEqual({
    type: "desired",
    ids: [id],
    desired: carried,
  });
  // Another database's page, a page for several IDs and one larger than the link takes: the IDs
  // alone, and the region pulls as before.
  expect(await received(page(region, newDatabaseId()))).toEqual({
    type: "desired",
    ids: [id],
  });
  const other = newDatabaseId();
  expect(await received(carried, [id, other])).toEqual({
    type: "desired",
    ids: [id, other],
  });
  const large = page(region, id, 8);
  expect(JSON.stringify(large).length).toBeGreaterThan(64 * 1024);
  // Dropped because it is too large, not because it is invalid.
  expect(
    LinkDesiredHint.safeParse({ type: "desired", ids: [id], desired: large })
      .success,
  ).toBe(true);
  expect(await received(large)).toEqual({ type: "desired", ids: [id] });
  socket.close(1000);
});
it("persists latest orphan observations in the real region DO", async () => {
  const stub = env.REGION_LINK.get(
    env.REGION_LINK.idFromName(crypto.randomUUID()),
  );
  const observedAt = new Date().toISOString(),
    orphans = [{ namespace: "pgcf-db-" + newDatabaseId(), database_id: null }];
  await stub.reportOrphans(observedAt, orphans);
  await stub.reportOrphans(new Date(Date.now() - 1000).toISOString(), []);
  await evictDurableObject(stub);
  const rows = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ observed_at: string; orphans: string }>(
        "SELECT observed_at,orphans FROM orphan_reports",
      )
      .toArray(),
  );
  expect(rows).toEqual([
    { observed_at: observedAt, orphans: JSON.stringify(orphans) },
  ]);
});
it("authenticates the public agent link and rejects ordinary HTTP requests", async () => {
  const f = await fixture();
  expect((await request("/agent/v1/link", f.integrator)).status).toBe(401);
  expect((await request("/agent/v1/link", f.agent)).status).toBe(426);
});

it("upgrades the authenticated agent link through the real API middleware", async () => {
  const f = await fixture();
  const response = await request(
    "/agent/v1/link",
    f.agent,
    "GET",
    undefined,
    undefined,
    { Upgrade: "websocket" },
  );
  expect(response.status).toBe(101);
  expect(response.headers.get("X-Request-Id")).toBeTruthy();
  const socket = response.webSocket!;
  expect(socket).toBeDefined();
  socket.accept();
  const welcome = nextMessage(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      agent_version: "test",
      instance_id: crypto.randomUUID(),
    }),
  );
  expect(JSON.parse(await welcome)).toEqual({ type: "welcome", protocol: 1 });
  socket.close(1000);
});
