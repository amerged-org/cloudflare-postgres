// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import { createTestHarness } from "wrangler";
import {
  encodeStartup,
  encodeSslRequest,
} from "../../../packages/contracts/src/pg-wire.ts";
import {
  parseRouteKeyring,
  deriveRegionKeyring,
  verifyRouteToken,
} from "../../../packages/contracts/src/route-token.ts";

const encodeGssRequest = () => Uint8Array.of(0, 0, 0, 8, 4, 210, 22, 48);
function encodeCancelRequest(pid: number, secret: number) {
  const bytes = new Uint8Array(16),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 16);
  view.setUint32(4, 80877102);
  view.setUint32(8, pid);
  view.setUint32(12, secret);
  return bytes;
}
import { ADMISSION_DEADLINE_MS } from "../../edge/src/session-policy.ts";

const origin = "https://edge.invalid";
const gatewayOrigin = "https://gateway.invalid";
const region = "eu-test";
const id = (prefix: string) =>
  prefix + randomUUID().replaceAll("-", "").slice(0, 19);
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "bounded condition did not become true");
    await delay(5);
  }
}
interface Observation {
  token: string;
  headers: Record<string, string>;
  path: string;
  waiting: boolean;
  bytes: number[];
  closes: number[];
  byte_count: number;
  text_frames: number;
}

test(
  "the complete Rust/Wasm entry runs against real workerd bindings",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pgcf-edge-wasm-"));
    const keyring = {
      active: "v1",
      keys: { v1: randomBytes(32).toString("base64url") },
    };
    const main = resolve(import.meta.dirname, "../build/worker/shim.mjs");
    const edgeConfig = (
      name: string,
      namespace: string,
      limit: number,
      actor = true,
    ) => ({
      name,
      main,
      compatibility_date: "2026-10-02",
      vars: { ROUTE_MASTER_KEYS: JSON.stringify(keyring) },
      ...(actor
        ? {
            durable_objects: {
              bindings: [
                {
                  name: "DATABASE_ACTOR",
                  class_name: "DatabaseActor",
                  script_name: "actual-actor",
                },
              ],
            },
          }
        : {}),
      services: [{ binding: "GATEWAY", service: "test-gateway" }],
      ratelimits: [
        {
          name: "CONNECTION_RATE_LIMITER",
          namespace_id: namespace,
          simple: { limit, period: 60 as const },
        },
        {
          name: "DATABASE_CONNECTION_RATE_LIMITER",
          namespace_id: "3",
          simple: { limit: 12000, period: 60 as const },
        },
      ],
    });
    const server = createTestHarness({
      root: directory,
      workers: [
        { config: edgeConfig("rust-edge", "1", 12000) },
        { config: edgeConfig("limited-edge", "2", 1) },
        { config: edgeConfig("no-actor-edge", "4", 12000, false) },
        {
          config: {
            ...edgeConfig("abort-edge", "5", 12000),
            main: resolve(import.meta.dirname, "request-probe.ts"),
          },
        },
        {
          config: {
            name: "actual-actor",
            main: resolve(import.meta.dirname, "actor-fixture.ts"),
            compatibility_date: "2026-10-02",
            d1_databases: [
              {
                binding: "DB",
                database_name: "edge-rust-test",
                migrations_dir: resolve(
                  import.meta.dirname,
                  "../../api/migrations",
                ),
              },
            ],
            durable_objects: {
              bindings: [
                { name: "DATABASE_ACTOR", class_name: "DatabaseActor" },
                { name: "REGION_LINK", class_name: "RegionLink" },
              ],
            },
            migrations: [
              {
                tag: "v1",
                new_sqlite_classes: ["DatabaseActor", "RegionLink"],
              },
            ],
          },
        },
        {
          config: {
            name: "test-gateway",
            main: resolve(import.meta.dirname, "gateway-fixture.ts"),
            compatibility_date: "2026-10-02",
          },
        },
      ],
    });
    const sockets: { close(code?: number): void }[] = [];
    try {
      await server.listen();
      const edge = server.getWorker("rust-edge"),
        actor = server.getWorker("actual-actor"),
        gateway = server.getWorker("test-gateway");
      await actor.applyD1Migrations("DB");
      const { DB } = (await actor.getEnv()) as { DB: D1Database };
      const now = new Date().toISOString();
      await DB.prepare(
        `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,archive_timeout_seconds,backup_retention_days,created_at,updated_at) VALUES('small',512,250,1,20,300,7,?,?)`,
      )
        .bind(now, now)
        .run();
      await DB.prepare(
        `INSERT INTO regions(id,provider,provider_region,gateway_url,gateway_binding,backup_bucket,backup_endpoint_url,agent_key_hash,created_at,updated_at) VALUES(?,'fixture','fixture',?,'GATEWAY','test-backups','https://backup.invalid',?,?,?)`,
      )
        .bind(region, gatewayOrigin + "/pg", "a".repeat(64), now, now)
        .run();
      async function seed() {
        const database = id("d"),
          project = "prj_" + randomUUID().replaceAll("-", "").slice(0, 20),
          node = "nod_" + randomUUID().replaceAll("-", "").slice(0, 20);
        await DB.batch([
          DB.prepare(
            "INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,'edge-rust',?,?)",
          ).bind(project, now, now),
          DB.prepare(
            `INSERT INTO nodes(id,region_id,k8s_node_name,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,platform_reserved_memory_mib,storage_gib_total,created_at,updated_at,node_uid,last_observed_at,platform_reserved_cpu_millicores) VALUES(?,?,?,1,1,4096,2000,128,20,?,?,?,?,100)`,
          ).bind(
            node,
            region,
            "fixture-" + node.slice(4),
            now,
            now,
            randomUUID(),
            now,
          ),
          DB.prepare(
            `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,observed_state,generation,observed_generation,archive_path,created_at,updated_at) VALUES(?,?,?,?,'edge-rust','small','running','ready',2,2,?,?,?)`,
          ).bind(
            database,
            project,
            region,
            node,
            `s3://test-backups/${region}/${database}/g1-op_${"a".repeat(20)}`,
            now,
            now,
          ),
          DB.prepare(
            `INSERT INTO roles(database_id,name,owner,password_ciphertext,password_iv,password_kid,created_at,updated_at) VALUES(?,'app',1,?,?,'v1',?,?)`,
          ).bind(
            database,
            randomUUID(),
            randomBytes(12).toString("base64"),
            now,
            now,
          ),
        ]);
        assert.equal(
          (await actor.fetch(`/seed?database=${database}`, { method: "POST" }))
            .status,
          204,
        );
        return { database, project, node };
      }
      const stats = async () =>
        (await gateway.fetch("/stats")).json() as Promise<Observation[]>;
      async function diagnostics(database: string) {
        return (
          await actor.fetch(`/diagnostics?database=${database}`, {
            method: "POST",
          })
        ).json() as Promise<{
          received: {
            database: string;
            user: string;
            options: { deadline: number; waiterId: string };
          }[];
          cancellations: number;
          waiters: number;
        }>;
      }
      async function sleeping(database: string) {
        const operation = "op_" + randomUUID().replaceAll("-", "").slice(0, 20);
        await DB.batch([
          DB.prepare(
            "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) SELECT ?,'database.hibernate','succeeded',project_id,id,3,?,?,? FROM databases WHERE id=?",
          ).bind(operation, now, now, now, database),
          DB.prepare(
            "UPDATE databases SET desired_state='suspended',suspension_reason='idle',power_operation=?,generation=3,observed_generation=3,observed_state='provisioning',observed_power='hibernated' WHERE id=?",
          ).bind(operation, database),
        ]);
        assert.equal(
          (await actor.fetch(`/seed?database=${database}`, { method: "POST" }))
            .status,
          204,
        );
      }
      const reset = async () => {
        await gateway.fetch("/reset");
        await DB.prepare(
          "UPDATE regions SET gateway_url=?,gateway_binding='GATEWAY' WHERE id=?",
        )
          .bind(gatewayOrigin + "/pg", region)
          .run();
      };
      const mode = async (value: string) => {
        await DB.prepare("UPDATE regions SET gateway_url=? WHERE id=?")
          .bind(gatewayOrigin + "/pg?mode=" + value, region)
          .run();
      };
      async function open(
        database: string,
        options: {
          user?: string;
          query?: string;
          ip?: string | null;
          worker?: string;
          headers?: Record<string, string>;
          signal?: AbortSignal;
        } = {},
      ) {
        const headers = {
          Upgrade: "websocket",
          ...(options.ip === null
            ? {}
            : { "CF-Connecting-IP": options.ip ?? "192.0.2.1" }),
          ...options.headers,
        };
        const response = await server
          .getWorker(options.worker ?? "rust-edge")
          .fetch(
            origin +
              "/v2?" +
              (options.query ??
                new URLSearchParams({ database, user: options.user ?? "app" })),
            { headers, signal: options.signal },
          );
        assert.equal(response.status, 101);
        assert.ok(response.webSocket);
        const socket = response.webSocket;
        socket.binaryType = "arraybuffer";
        socket.accept({ allowHalfOpen: true });
        sockets.push(socket);
        const messages: Uint8Array[] = [],
          texts: string[] = [];
        let close: number | null = null;
        socket.addEventListener("message", (e) => {
          if (e.data instanceof ArrayBuffer)
            messages.push(new Uint8Array(e.data));
          else texts.push(String(e.data));
        });
        socket.addEventListener("close", (e) => {
          close = e.code;
          try {
            socket.close();
          } catch {
            /* The socket may already be closed. */
          }
        });
        return {
          socket,
          messages,
          texts,
          close: () => close,
          database,
          user: options.user ?? "app",
        };
      }
      async function sqlstate(c: Awaited<ReturnType<typeof open>>) {
        await until(() => c.messages.some((v) => v[0] === 0x45));
        const text = new TextDecoder().decode(
          c.messages.find((v) => v[0] === 0x45)!.subarray(5),
        );
        return text
          .split("\0")
          .find((v) => v.startsWith("C"))!
          .slice(1);
      }
      const errorFrame = (messages: Uint8Array[]) =>
        messages.some((v) => v[0] === 0x45);
      await t.test(
        "health, unknown path and upgrade requirements execute inside Wasm",
        async () => {
          assert.deepEqual(await (await edge.fetch("/healthz")).json(), {
            status: "ok",
          });
          assert.equal((await edge.fetch("/unknown")).status, 404);
          assert.equal((await edge.fetch("/v2")).status, 426);
          assert.equal(
            (
              await edge.fetch("/v2", {
                method: "POST",
              })
            ).status,
            426,
          );
        },
      );
      await t.test(
        "malformed, duplicate and reserved hints fail before origin or actor admission",
        async () => {
          await reset();
          const { database } = await seed();
          assert.equal(
            await sqlstate(
              await open(database, {
                query: "database=wrong&database=" + database + "&user=app",
              }),
            ),
            "08P01",
          );
          assert.equal(
            await sqlstate(await open(database, { query: "user=app" })),
            "3D000",
          );
          assert.equal(
            await sqlstate(await open(database, { user: "pg_admin" })),
            "28P01",
          );
          assert.equal(
            await sqlstate(
              await open(database, {
                query: "database=" + database + "&user=app&user=app",
              }),
            ),
            "08P01",
          );
          assert.equal((await stats()).length, 0);
        },
      );
      await t.test(
        "actual Actor RPC and Fetcher return unopened upgrade; byte and text frames pass through once",
        async () => {
          await reset();
          const { database } = await seed();
          const c = await open(database);
          assert.equal(c.messages.length, 0);
          const bytes = new Uint8Array([
            ...encodeSslRequest(),
            ...encodeGssRequest(),
            ...encodeStartup({ database, user: "app" }),
            1,
            2,
            3,
          ]);
          c.socket.send(bytes.subarray(0, 3));
          c.socket.send(bytes.subarray(3, 13));
          c.socket.send(bytes.subarray(13));
          c.socket.send(new Uint8Array([4, 5]));
          c.socket.send("untrusted-text");
          await until(() => c.messages.length === 4 && c.texts.length === 1);
          assert.deepEqual(
            [...c.messages.flatMap((v) => [...v])],
            [...bytes, 4, 5],
          );
          assert.equal(c.texts[0], "untrusted-text");
          const rows = await stats();
          assert.equal(rows.length, 1);
          assert.deepEqual(rows[0]!.bytes, [...bytes, 4, 5]);
          assert.equal(rows[0]!.text_frames, 1);
          assert.equal(errorFrame(c.messages), false);
        },
      );
      await t.test(
        "Wasm signs only admitted identity and strips caller credentials and route header",
        async () => {
          await reset();
          const { database } = await seed();
          const c = await open(database, {
            query: new URLSearchParams({
              database,
              user: "app",
              password: "query-secret-canary",
              irrelevant: "ignored",
            }).toString(),
            headers: {
              Authorization: "Bearer header-secret-canary",
              Cookie: "private-cookie",
              "X-PGCF-Route": "forged",
            },
          });
          const rows = await stats();
          const row = rows[0]!;
          assert.equal(row.headers.authorization, undefined);
          assert.equal(row.headers.cookie, undefined);
          assert.notEqual(row.token, "forged");
          const keys = await deriveRegionKeyring(
            parseRouteKeyring(JSON.stringify(keyring)),
            region,
          );
          const verified = await verifyRouteToken(row.token, {
            region,
            keys: keys.keys,
          });
          assert.ok(verified.ok);
          const claims = verified.claims;
          assert.equal(claims.db, database);
          assert.equal(claims.user, "app");
          assert.equal(claims.rg, region);
          assert.equal(claims.exp - claims.iat, 30);
          assert.equal(row.path, "/pg");
          c.socket.close(1000);
          await until(async () => (await stats())[0]!.closes.length === 1);
          const logs = JSON.stringify(server.getLogs());
          assert.equal(logs.includes("query-secret-canary"), false);
          assert.equal(logs.includes("header-secret-canary"), false);
          assert.equal(logs.includes("private-cookie"), false);
        },
      );
      await t.test(
        "missing actor and source IP fail closed before gateway",
        async () => {
          await reset();
          const { database } = await seed();
          assert.equal(
            await sqlstate(await open(database, { worker: "no-actor-edge" })),
            "08006",
          );
          assert.equal(
            await sqlstate(
              await open(database, {
                worker: "abort-edge",
                query: new URLSearchParams({
                  database,
                  user: "app",
                  probe_no_ip: "true",
                }).toString(),
              }),
            ),
            "53300",
          );
          assert.equal(
            await sqlstate(await open(database, { ip: "192.168.001.1" })),
            "53300",
          );
          assert.equal(
            await sqlstate(await open(database, { ip: "x".repeat(10000) })),
            "53300",
          );
          assert.equal((await stats()).length, 0);
        },
      );
      await t.test(
        "real rate binding isolates identities and canonical IPv6 /64",
        async () => {
          await reset();
          const first = await seed(),
            second = await seed();
          const opts = { worker: "limited-edge", ip: "2001:db8:1:2::1" };
          await open(first.database, opts);
          assert.equal(
            await sqlstate(
              await open(first.database, {
                ...opts,
                ip: "2001:0db8:0001:0002:1234::5",
              }),
            ),
            "53300",
          );
          await open(second.database, opts);
          await open(first.database, { ...opts, ip: "2001:db8:1:3::1" });
          assert.equal((await stats()).length, 3);
        },
      );
      await t.test(
        "authoritative project deletion, suspension and unavailable observations block new upgrades",
        async () => {
          await reset();
          const { database, project } = await seed();
          await DB.prepare("UPDATE projects SET deleted_at=? WHERE id=?")
            .bind(now, project)
            .run();
          const c = await open(database);
          c.socket.send(encodeStartup({ database, user: "app" }));
          await until(() => c.messages.length === 1);
          assert.equal(new DataView(c.messages[0]!.buffer).getUint32(5), 10);
          c.socket.close(1000);
          const suspended = await seed();
          await DB.prepare(
            "UPDATE databases SET desired_state='suspended',suspension_reason='manual' WHERE id=?",
          )
            .bind(suspended.database)
            .run();
          assert.equal(await sqlstate(await open(suspended.database)), "57P03");
          assert.equal((await stats()).length, 0);
        },
      );
      await t.test(
        "binding failure and public HTTP fail before dialing; permitted binding HTTP succeeds",
        async () => {
          await reset();
          const { database } = await seed();
          await DB.prepare(
            "UPDATE regions SET gateway_binding='MISSING' WHERE id=?",
          )
            .bind(region)
            .run();
          assert.equal(await sqlstate(await open(database)), "08006");
          assert.equal((await stats()).length, 0);
          await DB.prepare(
            "UPDATE regions SET gateway_binding=NULL,gateway_url='http://gateway.invalid/pg' WHERE id=?",
          )
            .bind(region)
            .run();
          assert.equal(await sqlstate(await open(database)), "08006");
          assert.equal((await stats()).length, 0);
          await DB.prepare(
            "UPDATE regions SET gateway_binding='GATEWAY' WHERE id=?",
          )
            .bind(region)
            .run();
          await open(database);
          assert.equal((await stats()).length, 1);
        },
      );
      await t.test(
        "redirect and non-upgrade response fail once without leaking to redirect target",
        async () => {
          await reset();
          const { database } = await seed();
          await mode("redirect");
          assert.equal(await sqlstate(await open(database)), "08006");
          let rows = await stats();
          assert.equal(rows.length, 1);
          assert.equal(rows[0]!.path, "/pg");
          await reset();
          await mode("reject");
          assert.equal(await sqlstate(await open(database)), "08006");
          rows = await stats();
          assert.equal(rows.length, 1);
        },
      );
      await t.test(
        "a refusal is prompt even when the upstream body cancel never settles",
        async () => {
          await reset();
          const { database } = await seed();
          await mode("stalled-cancel");
          const began = Date.now();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const c = await Promise.race([
              open(database),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error("refusal blocked on upstream body cleanup"),
                    ),
                  2500,
                );
              }),
            ]);
            assert.equal(await sqlstate(c), "08006");
            assert.ok(Date.now() - began < 2500);
            assert.equal((await stats()).length, 1);
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
      );
      await t.test(
        "an already aborted request makes no Actor RPC or origin attempt",
        async () => {
          await reset();
          const { database } = await seed();
          const c = await open(database, {
            worker: "abort-edge",
            query: new URLSearchParams({
              database,
              user: "app",
              probe_abort: "immediate",
            }).toString(),
          });
          assert.equal(await sqlstate(c), "08006");
          assert.equal((await diagnostics(database)).received.length, 0);
          assert.equal((await stats()).length, 0);
        },
      );
      await t.test(
        "ten real Actor waiters coalesce one wake and use only exact fresh readiness",
        async () => {
          await reset();
          const { database } = await seed();
          await sleeping(database);
          const started = Date.now();
          const pending = Promise.all(
            Array.from({ length: 10 }, () => open(database)),
          );
          await until(async () => (await diagnostics(database)).waiters === 10);
          assert.equal((await stats()).length, 0);
          assert.equal(
            await DB.prepare(
              "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.wake'",
            )
              .bind(database)
              .first("n"),
            1,
          );
          const observed = await diagnostics(database);
          assert.equal(observed.received.length, 10);
          assert.equal(
            new Set(observed.received.map((v) => v.options.waiterId)).size,
            10,
          );
          for (const value of observed.received) {
            assert.equal(value.database, database);
            assert.equal(value.user, "app");
            assert.ok(
              value.options.deadline >= started + 29000 &&
                value.options.deadline <= Date.now() + 30000,
            );
          }
          await DB.prepare(
            "UPDATE databases SET observed_state='ready',observed_power='awake',observed_generation=3 WHERE id=?",
          )
            .bind(database)
            .run();
          await delay(250);
          assert.equal((await stats()).length, 0);
          await DB.prepare("UPDATE regions SET gateway_url=? WHERE id=?")
            .bind(gatewayOrigin + "/fresh", region)
            .run();
          await DB.prepare(
            "UPDATE databases SET observed_generation=generation WHERE id=?",
          )
            .bind(database)
            .run();
          const connections = await pending;
          assert.equal(connections.length, 10);
          assert.equal((await stats()).length, 10);
          const keys = await deriveRegionKeyring(
            parseRouteKeyring(JSON.stringify(keyring)),
            region,
          );
          const tokens = await Promise.all(
            (await stats()).map((v) =>
              verifyRouteToken(v.token, { region, keys: keys.keys }),
            ),
          );
          const ids = tokens.map((v) => {
            assert.ok(v.ok);
            return v.claims.cid;
          });
          assert.deepEqual(
            [...ids].sort(),
            observed.received.map((v) => v.options.waiterId).sort(),
          );
          assert.equal(
            (await stats()).every((v) => v.path === "/fresh"),
            true,
          );
          assert.equal((await diagnostics(database)).waiters, 0);
        },
      );
      await t.test(
        "request abort cancels exactly the real Actor waiter without an origin attempt",
        async () => {
          await reset();
          const { database } = await seed();
          await sleeping(database);
          const c = await open(database, { worker: "abort-edge" });
          assert.equal(await sqlstate(c), "08006");
          await until(async () => (await diagnostics(database)).waiters === 0);
          const observed = await diagnostics(database);
          assert.equal(observed.received.length, 1);
          assert.equal(observed.cancellations, 1);
          assert.equal((await stats()).length, 0);
        },
      );
      await t.test(
        "request abort ends a real pending Fetcher upgrade without SQL or replay",
        async () => {
          await reset();
          const { database } = await seed();
          await mode("held");
          const c = await open(database, { worker: "abort-edge" });
          assert.equal(await sqlstate(c), "08006");
          assert.equal((await stats()).length, 1);
          await gateway.fetch("/release");
          assert.equal((await stats())[0]!.byte_count, 0);
          assert.equal((await stats()).length, 1);
          assert.equal((await diagnostics(database)).cancellations, 0);
        },
      );
      await t.test(
        "gateway owns startup bounds and cancellation with raw large or malformed bytes",
        async () => {
          await reset();
          const { database } = await seed();
          const c = await open(database);
          const bytes = new Uint8Array(16000);
          bytes.set([255, 255, 255, 255, 0, 0, 0, 0]);
          c.socket.send(bytes);
          c.socket.send(encodeCancelRequest(123, 456));
          await until(
            async () => (await stats())[0]!.byte_count === bytes.length + 16,
          );
          assert.equal(errorFrame(c.messages), false);
        },
      );
      await t.test(
        "upstream close propagates unchanged without a reconnect",
        async () => {
          await reset();
          const { database } = await seed();
          await mode("close");
          const c = await open(database);
          c.socket.send(new Uint8Array([1]));
          await until(() => c.close() !== null);
          assert.equal(c.close(), 1012);
          assert.equal((await stats()).length, 1);
        },
      );
      await t.test(
        "one thousand native idle upgrades retain no application startup timer",
        async () => {
          await reset();
          const { database } = await seed();
          const timeoutDB = await seed();
          await sleeping(timeoutDB.database);
          const began = Date.now();
          const timedOut = open(timeoutDB.database);
          const idle: Awaited<ReturnType<typeof open>>[] = [];
          for (let start = 0; start < 1000; start += 20)
            idle.push(
              ...(await Promise.all(
                Array.from({ length: 20 }, () => open(database)),
              )),
            );
          await delay(
            Math.max(0, began + ADMISSION_DEADLINE_MS + 30 - Date.now()),
          );
          const refusal = await timedOut;
          assert.ok(["08006", "57P03"].includes(await sqlstate(refusal)));
          assert.ok(Date.now() - began >= ADMISSION_DEADLINE_MS - 100);
          assert.ok(Date.now() - began < ADMISSION_DEADLINE_MS + 5000);
          assert.equal((await diagnostics(timeoutDB.database)).waiters, 0);
          assert.equal((await stats()).length, 1000);
          assert.equal(
            idle.filter(
              (c) => c.close() !== null || c.messages.length || c.texts.length,
            ).length,
            0,
          );
          for (const c of idle) c.socket.close(1000);
        },
      );
      await t.test(
        "the actual node-postgres default SCRAM client gets wrong-password from the Rust decoy",
        async () => {
          await reset();
          const database = id("d"),
            c = await open(database),
            backend: Uint8Array[] = [];
          class WireStream extends Duplex {
            connect() {
              queueMicrotask(() => this.emit("connect"));
              return this;
            }
            setNoDelay() {
              return this;
            }
            setKeepAlive() {
              return this;
            }
            override _read() {}
            override _write(
              chunk: Buffer,
              _encoding: BufferEncoding,
              callback: (error?: Error | null) => void,
            ) {
              try {
                c.socket.send(new Uint8Array(chunk));
                callback();
              } catch (error) {
                callback(error as Error);
              }
            }
            override _destroy(
              error: Error | null,
              callback: (error: Error | null) => void,
            ) {
              try {
                c.socket.close();
              } catch {
                /* The socket may already be closed. */
              }
              callback(error);
            }
          }
          const stream = new WireStream();
          c.socket.addEventListener("message", (e) => {
            if (e.data instanceof ArrayBuffer) {
              const bytes = new Uint8Array(e.data);
              backend.push(bytes);
              stream.push(Buffer.from(bytes));
            }
          });
          c.socket.addEventListener("close", () => stream.push(null));
          const load = createRequire(import.meta.url),
            { Client } = load(
              load.resolve("pg", {
                paths: [resolve(import.meta.dirname, "../../regional")],
              }),
            );
          const client = new Client({
            user: "app",
            database,
            password: randomUUID(),
            ssl: false,
            stream,
            connectionTimeoutMillis: 5000,
          });
          try {
            await assert.rejects(
              client.connect(),
              (error: unknown) => (error as { code?: string }).code === "28P01",
            );
          } finally {
            await client.end();
            stream.destroy();
          }
          assert.deepEqual(
            backend.map((bytes) =>
              bytes[0] === 0x52
                ? new DataView(bytes.buffer).getUint32(5)
                : bytes[0],
            ),
            [10, 11, 0x45],
          );
          assert.equal((await stats()).length, 0);
        },
      );
    } finally {
      for (const socket of sockets) {
        try {
          socket.close(1000);
        } catch {
          /* The socket may already be closed. */
        }
      }
      try {
        await server.getWorker("test-gateway").fetch("/release");
      } catch {
        /* The socket may already be closed. */
      }
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
