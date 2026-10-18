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
  deriveNodeKeyring,
  verifyRouteToken,
} from "../../../packages/contracts/src/route-token.ts";
import { MAX_SQL_REQUEST_BYTES } from "../../../packages/contracts/src/edge-sql.ts";

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

// Sentinels for the Access service token: they must reach the gateway and nothing else.
const accessId = `sentinel-id-${randomUUID()}.access`;
const accessSecret = `sentinel-secret-${randomUUID()}`;
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
  /** An HTTP query, as the gateway received it. */
  method?: string;
  body?: string;
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
      binding: [namespace: string, limit: number] = ["6", 12000],
      hint?: string,
    ) => ({
      name,
      main,
      compatibility_date: "2026-10-02",
      vars: {
        ROUTE_MASTER_KEYS: JSON.stringify(keyring),
        ...(hint ? { DATABASE_ACTOR_LOCATION_HINT: hint } : {}),
      },
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
        {
          name: "BINDING_CONNECTION_RATE_LIMITER",
          namespace_id: binding[0],
          simple: { limit: binding[1], period: 60 as const },
        },
      ],
    });
    const server = createTestHarness({
      root: directory,
      workers: [
        { config: edgeConfig("rust-edge", "1", 12000) },
        { config: edgeConfig("limited-edge", "2", 1, true, ["7", 1]) },
        // A generous public limiter beside a binding limiter of one: which of them counted.
        {
          config: edgeConfig("binding-limited-edge", "9", 12000, true, [
            "10",
            1,
          ]),
        },
        {
          config: {
            name: "binding-caller",
            main: resolve(import.meta.dirname, "binding-caller.ts"),
            compatibility_date: "2026-10-02",
            services: ["rust-edge", "limited-edge", "binding-limited-edge"].map(
              (name) => ({ binding: name, service: name }),
            ),
          },
        },
        // An Edge that fetches its gateway over the public network, with the Access token or part
        // of it.
        ...(
          [
            [
              "access-edge",
              "11",
              {
                ACCESS_CLIENT_ID: accessId,
                ACCESS_CLIENT_SECRET: accessSecret,
              },
            ],
            ["half-access-edge", "12", { ACCESS_CLIENT_ID: accessId }],
            ["plain-public-edge", "13", {}],
          ] as const
        ).map(([name, namespace, access]) => {
          const config = edgeConfig(name, namespace, 12000);
          return {
            config: {
              ...config,
              main: resolve(import.meta.dirname, "public-gateway.ts"),
              vars: { ...config.vars, ...access },
            },
          };
        }),
        { config: edgeConfig("no-actor-edge", "4", 12000, false) },
        {
          config: edgeConfig(
            "hinted-edge",
            "8",
            12000,
            true,
            ["6", 12000],
            "weur",
          ),
        },
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
                { name: "NODE_ACTOR", class_name: "NodeActor" },
              ],
            },
            migrations: [
              {
                tag: "v1",
                new_sqlite_classes: ["DatabaseActor", "NodeActor"],
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
        `INSERT INTO regions(id,provider,provider_region,gateway_url,gateway_binding,backup_bucket,backup_endpoint_url,created_at,updated_at) VALUES(?,'fixture','fixture',?,'GATEWAY','test-backups','https://backup.invalid',?,?)`,
      )
        .bind(region, gatewayOrigin + "/pg", now, now)
        .run();
      // The API publishes the admission snapshot of a database whenever D1 changes it; a test
      // that writes D1 directly publishes the same way, or the Actor admits on the old snapshot.
      async function publish(database: string) {
        assert.equal(
          (await actor.fetch(`/seed?database=${database}`, { method: "POST" }))
            .status,
          204,
        );
      }
      async function seed() {
        const database = id("d"),
          project = "prj_" + randomUUID().replaceAll("-", "").slice(0, 20),
          node = "nod_" + randomUUID().replaceAll("-", "").slice(0, 20),
          instance = randomUUID();
        await DB.batch([
          DB.prepare(
            "INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,'edge-rust',?,?)",
          ).bind(project, now, now),
          DB.prepare(
            `INSERT INTO nodes(id,region_id,hostname,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,platform_reserved_memory_mib,storage_gib_total,created_at,updated_at,node_uid,last_observed_at,platform_reserved_cpu_millicores) VALUES(?,?,?,1,1,4096,2000,128,20,?,?,?,?,100)`,
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
            `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,observed_state,generation,observed_generation,archive_path,runtime_json,created_at,updated_at) VALUES(?,?,?,?,'edge-rust','small','running','ready',2,2,?,?,?,?)`,
          ).bind(
            database,
            project,
            region,
            node,
            `s3://test-backups/${region}/${database}/g1-op_${"a".repeat(20)}`,
            // The unit the node reported for the observed generation.
            JSON.stringify({
              database_id: database,
              node_id: node,
              generation: 2,
              storage_generation: 1,
              instance,
              observed_at: Date.now(),
            }),
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
        await publish(database);
        return { database, project, node, instance };
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
      const nodeKeys = async (node: string) =>
        (
          await deriveNodeKeyring(
            parseRouteKeyring(JSON.stringify(keyring)),
            node,
          )
        ).keys;
      // The claims of a route the gateway received, verified with the key of its node.
      async function claimsOf(token: string, node: string) {
        const verified = await verifyRouteToken(token, {
          region,
          node,
          keys: await nodeKeys(node),
        });
        assert.ok(verified.ok);
        return verified.claims;
      }
      // Keeps the Actor from answering the admissions of one database until released.
      const hold = async (database: string, action: "hold" | "release") =>
        assert.equal(
          (
            await actor.fetch(`/${action}?database=${database}`, {
              method: "POST",
            })
          ).status,
          204,
        );
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
        await publish(database);
      }
      const reset = async () => {
        await gateway.fetch("/reset");
        await DB.prepare(
          "UPDATE regions SET gateway_url=?,gateway_binding='GATEWAY' WHERE id=?",
        )
          .bind(gatewayOrigin + "/pg", region)
          .run();
      };
      // The route is part of the snapshot: a changed route is published again.
      const route = async (
        database: string,
        set: string,
        ...values: string[]
      ) => {
        await DB.prepare(`UPDATE regions SET ${set} WHERE id=?`)
          .bind(...values, region)
          .run();
        await publish(database);
      };
      const mode = (database: string, value: string) =>
        route(database, "gateway_url=?", gatewayOrigin + "/pg?mode=" + value);
      // Where a request to `worker` is sent. One without a source address (`ip: null`) arrives as
      // a call over a service binding does: from the caller Worker, which removes the address the
      // harness gives every request it sends.
      const entry = (worker: string, ip: string | null) =>
        ip === null
          ? {
              worker: server.getWorker("binding-caller"),
              headers: { "X-Target": worker },
            }
          : { worker: server.getWorker(worker), headers: {} };
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
        const ip = options.ip === undefined ? "192.0.2.1" : options.ip;
        const via = entry(options.worker ?? "rust-edge", ip);
        const headers = {
          Upgrade: "websocket",
          ...(ip === null ? {} : { "CF-Connecting-IP": ip }),
          ...via.headers,
          ...options.headers,
        };
        const response = await via.worker.fetch(
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
      // The log line of an event, as the Worker wrote it; `cid` picks one when several were.
      async function logged(event: string, cid?: string) {
        let found: Record<string, unknown> | undefined;
        await until(() => {
          for (const entry of server.getLogs().toReversed()) {
            try {
              const line = JSON.parse(entry.message);
              if (line.event === event && (!cid || line.cid === cid)) {
                found = line;
                return true;
              }
            } catch {
              /* Another line of the log. */
            }
          }
          return false;
        });
        return found!;
      }
      // A request to the HTTP query endpoint, as the Neon serverless driver sends it.
      async function query(
        body: unknown,
        options: {
          database: string;
          worker?: string;
          ip?: string | null;
          method?: string;
          connection?: string | null;
          headers?: Record<string, string>;
        },
      ) {
        const connection =
          options.connection === undefined
            ? `postgres://app:secret@host.invalid/${options.database}`
            : options.connection;
        const ip = options.ip === undefined ? "192.0.2.1" : options.ip;
        const via = entry(options.worker ?? "rust-edge", ip);
        const response = await via.worker.fetch(origin + "/sql", {
          method: options.method ?? "POST",
          headers: {
            ...(ip === null ? {} : { "CF-Connecting-IP": ip }),
            "Neon-Raw-Text-Output": "true",
            "Neon-Array-Mode": "true",
            ...(connection === null
              ? {}
              : { "Neon-Connection-String": connection }),
            ...via.headers,
            ...options.headers,
          },
          body:
            options.method === "GET"
              ? undefined
              : typeof body === "string" || body instanceof ReadableStream
                ? body
                : JSON.stringify(body),
          ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
        });
        return {
          status: response.status,
          headers: response.headers,
          json: (await response.json()) as Record<string, unknown>,
        };
      }
      const streamed = (bytes: number) => {
        const chunk = new Uint8Array(1024 * 1024).fill(120);
        let sent = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= bytes) return controller.close();
            controller.enqueue(
              chunk.subarray(0, Math.min(chunk.length, bytes - sent)),
            );
            sent += chunk.length;
          },
        });
      };
      const failure = (code: string, message: string, severity = "ERROR") => ({
        message,
        code,
        severity,
      });
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
          const { database, node, instance } = await seed();
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
          const verified = await verifyRouteToken(row.token, {
            region,
            node,
            keys: await nodeKeys(node),
          });
          assert.ok(verified.ok);
          const claims = verified.claims;
          assert.equal(claims.db, database);
          assert.equal(claims.user, "app");
          assert.equal(claims.rg, region);
          // An awake database is routed as v6: the unit the node reported, for its node.
          assert.equal(claims.v, 6);
          assert.ok("inst" in claims && claims.inst === instance);
          assert.ok("node" in claims && claims.node === node);
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
        "a missing actor and an invalid source IP fail closed before gateway",
        async () => {
          await reset();
          const { database } = await seed();
          assert.equal(
            await sqlstate(await open(database, { worker: "no-actor-edge" })),
            "08006",
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
        "a caller without a source IP counts in the limiter of service bindings, not the public ones",
        async () => {
          await reset();
          const first = await seed(),
            second = await seed();
          const binding = { worker: "limited-edge", ip: null };
          await open(first.database, binding);
          assert.equal(
            await sqlstate(await open(first.database, binding)),
            "53300",
          );
          // Another database has a budget of its own, and the public limiter was never asked.
          await open(second.database, binding);
          await open(first.database, {
            worker: "limited-edge",
            ip: "192.0.2.9",
          });
          assert.equal((await stats()).length, 3);
          // The limiter of service bindings alone decides: beside a public limiter that would
          // let any number through, the second connect of the same caller is still refused.
          const generous = { worker: "binding-limited-edge", ip: null };
          await open(first.database, generous);
          assert.equal(
            await sqlstate(await open(first.database, generous)),
            "53300",
          );
          assert.equal((await stats()).length, 4);
          // The same of HTTP queries, in a bucket of their own.
          const sent = { database: second.database, ...generous };
          assert.equal((await query({ query: "SELECT 1" }, sent)).status, 200);
          assert.equal(
            (await query({ query: "SELECT 1" }, sent)).json.code,
            "53300",
          );
          assert.equal((await stats()).length, 5);
        },
      );
      await t.test(
        "an HTTP query counts in limiter buckets of its own, beside the connection's",
        async () => {
          await reset();
          const { database } = await seed();
          // The public limiter of this Worker lets one connect per address, database and role
          // through, and the query below comes from the same address to the same database and role.
          const worker = "limited-edge";
          await open(database, { worker });
          const first = await query(
            { query: "SELECT 1" },
            { database, worker },
          );
          assert.equal(first.status, 200);
          // Its bucket of its own holds one as well.
          const second = await query(
            { query: "SELECT 1" },
            { database, worker },
          );
          assert.equal(second.json.code, "53300");
          assert.equal((await stats()).length, 2);
        },
      );
      await t.test(
        "the limiters and the Actor admit together, so a connect the limiter denied was still admitted",
        async () => {
          await reset();
          const { database } = await seed();
          const opts = { worker: "limited-edge", ip: "198.51.100.7" };
          await open(database, opts);
          assert.equal(await sqlstate(await open(database, opts)), "53300");
          assert.equal((await diagnostics(database)).received.length, 2);
          assert.equal((await stats()).length, 1);
        },
      );
      await t.test(
        "a configured location hint leaves admission working",
        async () => {
          await reset();
          const { database } = await seed();
          // workerd takes any hint and places nothing by it (a hint of "no-such-place" is admitted
          // as well), so that the Actor is got at the hint is not observable here, only that
          // getting it with one works.
          await open(database, { worker: "hinted-edge" });
          assert.equal((await stats()).length, 1);
        },
      );
      await t.test(
        "each connection logs where its time went and which request of its isolate it was",
        async () => {
          await reset();
          const { database, node } = await seed();
          await open(database);
          const [row] = await stats();
          const first = await logged(
            "conn_admission",
            (await claimsOf(row!.token, node)).cid,
          );
          // The connection id of the log is the one the gateway received in the route.
          assert.equal(first.database_id, database);
          assert.equal(first.user, "app");
          assert.equal(first.region_id, region);
          assert.equal(first.outcome, "accepted");
          assert.equal(first.route, "v6");
          assert.ok(first.colo === null || typeof first.colo === "string");
          for (const stage of [
            "duration_ms",
            "limiters_ms",
            "admit_ms",
            "token_ms",
            "gateway_connect_ms",
          ])
            assert.ok(Number(first[stage]) >= 0, stage);
          // Everything of the upgrade but the gateway's answer: the Edge's own share.
          assert.equal(
            first.edge_ms,
            Number(first.duration_ms) - Number(first.gateway_connect_ms),
          );
          await open(database);
          const [, next] = await stats();
          const second = await logged(
            "conn_admission",
            (await claimsOf(next!.token, node)).cid,
          );
          assert.equal(
            second.isolate_requests,
            Number(first.isolate_requests) + 1,
          );
          // Only admission fields: no route, password or byte counts the Edge never sees.
          for (const line of [first, second])
            for (const name of [
              "token",
              "password",
              "ingress_bytes",
              "egress_bytes",
            ])
              assert.equal(name in line, false, name);
          assert.equal(
            JSON.stringify([first, second]).includes(row!.token),
            false,
          );
        },
      );
      await t.test(
        "an HTTP query is admitted as a connection is, signed a route and forwarded once",
        async () => {
          await reset();
          const { database, node, instance } = await seed();
          const answer = await query(
            { query: "SELECT $1, $2, $3", params: ["x", 2, null] },
            { database },
          );
          assert.equal(answer.status, 200);
          assert.equal(answer.headers.get("content-type"), "application/json");
          assert.equal(answer.headers.get("cache-control"), "no-store");
          assert.deepEqual(answer.json, {
            fields: [],
            command: "SELECT",
            rowCount: 0,
            rows: [],
            rowAsArray: true,
          });
          let rows = await stats();
          assert.equal(rows.length, 1);
          const sent = rows[0]!;
          // The gateway of the node, at the path of HTTP queries; the caller's headers stay home.
          assert.equal(sent.path, "/sql");
          assert.equal(sent.method, "POST");
          assert.equal(sent.headers["neon-connection-string"], undefined);
          assert.deepEqual(JSON.parse(sent.body!), {
            password: Buffer.from("secret").toString("base64url"),
            queries: [{ query: "SELECT $1, $2, $3", params: ["x", "2", null] }],
          });
          const claims = await claimsOf(sent.token, node);
          assert.equal(claims.v, 6);
          assert.ok("inst" in claims && claims.inst === instance);
          assert.equal(claims.db, database);
          assert.equal(claims.user, "app");
          // A transaction carries the characteristics of the driver's batch.
          const batch = await query(
            { queries: [{ query: "SELECT 1" }, { query: "SELECT 2" }] },
            {
              database,
              headers: {
                "Neon-Batch-Isolation-Level": "Serializable",
                "Neon-Batch-Read-Only": "true",
              },
            },
          );
          assert.equal(batch.status, 200);
          assert.equal((batch.json.results as unknown[]).length, 2);
          rows = await stats();
          assert.deepEqual(JSON.parse(rows[1]!.body!).transaction, {
            isolation: "Serializable",
            read_only: true,
          });
          // An empty transaction has nothing to run and asks nobody.
          assert.deepEqual((await query({ queries: [] }, { database })).json, {
            results: [],
          });
          assert.equal((await stats()).length, 2);
          // A sleeping database is woken by the ticket of its wake, signed as v5.
          await sleeping(database);
          assert.equal(
            (await query({ query: "SELECT 1" }, { database })).status,
            200,
          );
          assert.equal((await claimsOf((await stats())[2]!.token, node)).v, 5);
        },
      );
      await t.test(
        "an HTTP query that cannot be admitted or understood is refused before the gateway",
        async () => {
          await reset();
          const { database } = await seed();
          const suspended = await seed();
          await DB.prepare(
            "UPDATE databases SET desired_state='suspended',suspension_reason='manual' WHERE id=?",
          )
            .bind(suspended.database)
            .run();
          await publish(suspended.database);
          const statement = { query: "SELECT 1" };
          const refused = [
            // An unknown database is a wrong password, as on a connection.
            [
              await query(statement, { database: id("d") }),
              failure("28P01", "password authentication failed", "FATAL"),
            ],
            [
              await query(statement, { database: suspended.database }),
              failure("57P03", "database is not accepting connections"),
            ],
            [
              await query(statement, { database, method: "GET" }),
              failure("08P01", "HTTP SQL requires POST"),
            ],
            [
              await query(statement, { database, connection: "not a url" }),
              failure("08P01", "invalid HTTP SQL request"),
            ],
            [
              await query(statement, {
                database,
                connection: `postgres://app@host.invalid/${database}`,
              }),
              failure("28P01", "password authentication failed", "FATAL"),
            ],
            [
              await query(statement, {
                database,
                headers: { "Neon-Array-Mode": "false" },
              }),
              failure(
                "0A000",
                "only raw text results in array mode are supported",
              ),
            ],
            [
              await query(statement, {
                database,
                headers: { Authorization: "Bearer token" },
              }),
              failure("0A000", "authorization tokens are not supported"),
            ],
            [
              await query("{", { database }),
              failure("08P01", "invalid HTTP SQL request"),
            ],
            [
              await query(
                { queries: [{ query: "SELECT 1", extra: 1 }] },
                { database },
              ),
              failure("08P01", "invalid HTTP SQL request"),
            ],
            [
              await query("x".repeat(MAX_SQL_REQUEST_BYTES + 1), { database }),
              failure("54000", "request is too large"),
            ],
            // A body that does not say how long it is is read only up to the same bound.
            [
              await query(streamed(MAX_SQL_REQUEST_BYTES + 1), { database }),
              failure("54000", "request is too large"),
            ],
          ] as const;
          for (const [answer, expected] of refused) {
            assert.equal(answer.status, 400);
            assert.deepEqual(answer.json, expected);
          }
          assert.equal((await stats()).length, 0);
        },
      );
      await t.test(
        "an HTTP query passes on the gateway's error and never retries a lost answer",
        async () => {
          await reset();
          const { database, node } = await seed();
          await mode(database, "sql-error");
          const error = await query(
            { query: "SELECT * FROM missing" },
            { database },
          );
          assert.equal(error.status, 400);
          assert.deepEqual(
            error.json,
            failure("42P01", "relation does not exist"),
          );
          let rows = await stats();
          assert.equal(rows.length, 1);
          // An error the Edge passes on is the client's to read: the log has no error code of it.
          let line = await logged(
            "sql_admission",
            (await claimsOf(rows[0]!.token, node)).cid,
          );
          assert.equal(line.gateway_status, 400);
          assert.equal("gateway_error" in line, false);
          // The same of a 400 that is not an error of a statement. The outcome is unknown to
          // the client, but the log names what the gateway answered, and not its free text.
          for (const [refusal, status, code] of [
            ["reject", 503, "route_refused"],
            ["uncoded-400", 400, "bad_request"],
          ] as const) {
            await reset();
            await mode(database, refusal);
            const lost = await query(
              { query: "INSERT INTO t VALUES (1)" },
              { database },
            );
            assert.equal(lost.status, 400);
            assert.equal(lost.json.code, "08007");
            rows = await stats();
            assert.equal(rows.length, 1);
            line = await logged(
              "sql_admission",
              (await claimsOf(rows[0]!.token, node)).cid,
            );
            assert.equal(line.outcome, "08007");
            assert.equal(line.gateway_status, status);
            assert.equal(line.gateway_error, code);
            assert.equal(JSON.stringify(line).includes("free text"), false);
          }
          await reset();
          await route(database, "gateway_binding='MISSING'");
          const unconfigured = await query({ query: "SELECT 1" }, { database });
          assert.deepEqual(
            unconfigured.json,
            failure("08006", "gateway connection failed"),
          );
          assert.equal((await stats()).length, 0);
        },
      );
      await t.test(
        "an HTTP query logs its stages without its password, statements or parameters",
        async () => {
          await reset();
          const { database, node } = await seed();
          await query(
            {
              query: "SELECT 'statement-canary'",
              params: ["parameter-canary"],
            },
            {
              database,
              connection: `postgres://app:password-canary@host.invalid/${database}`,
            },
          );
          const [row] = await stats();
          const line = await logged(
            "sql_admission",
            (await claimsOf(row!.token, node)).cid,
          );
          assert.equal(line.database_id, database);
          assert.equal(line.user, "app");
          assert.equal(line.region_id, region);
          assert.equal(line.outcome, "accepted");
          assert.equal(line.route, "v6");
          assert.equal(line.statements, 1);
          assert.equal(line.gateway_status, 200);
          for (const stage of [
            "body_ms",
            "gateway_ms",
            "limiters_ms",
            "admit_ms",
            "token_ms",
          ])
            assert.ok(Number(line[stage]) >= 0, stage);
          // All but the client's upload and the gateway is the Edge's own.
          assert.equal(
            line.edge_ms,
            Number(line.duration_ms) -
              Number(line.body_ms) -
              Number(line.gateway_ms),
          );
          const text = JSON.stringify(line);
          for (const secret of ["canary", "password"])
            assert.equal(text.includes(secret), false, secret);
          server.clearLogs();
          const refused = await query("{", { database });
          assert.equal(refused.json.code, "08P01");
          const failed = await logged("sql_admission");
          assert.equal(failed.outcome, "08P01");
          assert.equal(failed.gateway_ms, undefined);
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
          await publish(database);
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
          await publish(suspended.database);
          assert.equal(await sqlstate(await open(suspended.database)), "57P03");
          assert.equal((await stats()).length, 0);
        },
      );
      await t.test(
        "binding failure and public HTTP fail before dialing; permitted binding HTTP succeeds",
        async () => {
          await reset();
          const { database } = await seed();
          await route(database, "gateway_binding='MISSING'");
          assert.equal(await sqlstate(await open(database)), "08006");
          assert.equal((await stats()).length, 0);
          await route(
            database,
            "gateway_binding=NULL,gateway_url=?",
            "http://gateway.invalid/pg",
          );
          assert.equal(await sqlstate(await open(database)), "08006");
          assert.equal((await stats()).length, 0);
          await route(database, "gateway_binding='GATEWAY'");
          await open(database);
          assert.equal((await stats()).length, 1);
        },
      );
      await t.test(
        "redirect and non-upgrade response fail once without leaking to redirect target",
        async () => {
          await reset();
          const { database, node } = await seed();
          await mode(database, "redirect");
          assert.equal(await sqlstate(await open(database)), "08006");
          let rows = await stats();
          assert.equal(rows.length, 1);
          assert.equal(rows[0]!.path, "/pg");
          // The log names the status of a gateway's refusal; a redirect has no error code.
          let line = await logged(
            "conn_admission",
            (await claimsOf(rows[0]!.token, node)).cid,
          );
          assert.equal(line.gateway_status, 307);
          assert.equal("gateway_error" in line, false);
          await reset();
          await mode(database, "reject");
          assert.equal(await sqlstate(await open(database)), "08006");
          rows = await stats();
          assert.equal(rows.length, 1);
          // The gateway answered with its error code and free text: only the code is logged.
          line = await logged(
            "conn_admission",
            (await claimsOf(rows[0]!.token, node)).cid,
          );
          assert.equal(line.outcome, "08006");
          assert.equal(line.gateway_status, 503);
          assert.equal(line.gateway_error, "route_refused");
          assert.equal(JSON.stringify(line).includes("free text"), false);
        },
      );
      await t.test(
        "the Access service token goes to a gateway on the public network and to no other",
        async () => {
          await reset();
          const { database } = await seed();
          // What a caller sends in these headers is not what the gateway gets.
          const caller = {
            "CF-Access-Client-Id": "caller-id",
            "CF-Access-Client-Secret": "caller-secret",
          };
          const token = {
            "cf-access-client-id": accessId,
            "cf-access-client-secret": accessSecret,
          };
          const presented = async () => {
            const rows = await stats();
            assert.equal(rows.length, 1);
            return Object.fromEntries(
              Object.entries(rows[0]!.headers).filter(([name]) =>
                name.startsWith("cf-access"),
              ),
            );
          };
          const select = (worker: string) =>
            query({ query: "SELECT 1" }, { database, worker, headers: caller });
          await route(database, "gateway_binding=NULL");
          await open(database, { worker: "access-edge", headers: caller });
          assert.deepEqual(await presented(), token);
          // An HTTP query presents it as well.
          await gateway.fetch("/reset");
          assert.equal((await select("access-edge")).status, 200);
          assert.deepEqual(await presented(), token);
          // Without the secrets nothing is presented, whatever the caller sends.
          await gateway.fetch("/reset");
          await open(database, {
            worker: "plain-public-edge",
            headers: caller,
          });
          assert.deepEqual(await presented(), {});
          await gateway.fetch("/reset");
          await select("plain-public-edge");
          assert.deepEqual(await presented(), {});
          // A gateway on a service binding is not behind Access: it gets nothing, with the
          // secrets set or not.
          await route(database, "gateway_binding='GATEWAY'");
          for (const worker of ["access-edge", "half-access-edge"]) {
            await gateway.fetch("/reset");
            await select(worker);
            assert.deepEqual(await presented(), {});
          }
          const text = JSON.stringify(server.getLogs());
          for (const secret of [accessId, accessSecret])
            assert.equal(text.includes(secret), false);
        },
      );
      await t.test(
        "one Access secret alone refuses before anything is sent and is logged by name only",
        async () => {
          await reset();
          const { database } = await seed();
          await route(database, "gateway_binding=NULL");
          server.clearLogs();
          assert.equal(
            await sqlstate(
              await open(database, { worker: "half-access-edge" }),
            ),
            "08006",
          );
          let line = await logged("conn_admission");
          assert.equal(line.outcome, "08006");
          assert.equal(line.config_error, "access_secrets_incomplete");
          assert.equal("gateway_status" in line, false);
          server.clearLogs();
          // Not an unknown outcome (08007): the query was never sent.
          const refused = await query(
            { query: "INSERT INTO t VALUES (1)" },
            { database, worker: "half-access-edge" },
          );
          assert.deepEqual(
            refused.json,
            failure("08006", "gateway connection failed"),
          );
          line = await logged("sql_admission");
          assert.equal(line.outcome, "08006");
          assert.equal(line.config_error, "access_secrets_incomplete");
          assert.equal((await stats()).length, 0);
          for (const secret of [accessId, accessSecret])
            assert.equal(
              JSON.stringify(server.getLogs()).includes(secret),
              false,
            );
        },
      );
      await t.test(
        "an Access refusal is logged by status, and a redirect to its login is a failed upgrade",
        async () => {
          await reset();
          const { database } = await seed();
          await route(database, "gateway_binding=NULL");
          for (const [refusal, status] of [
            ["status-401", 401],
            ["status-403", 403],
            ["status-530", 530],
            ["access-login", 302],
          ] as const) {
            await gateway.fetch("/reset");
            await mode(database, refusal);
            server.clearLogs();
            assert.equal(
              await sqlstate(await open(database, { worker: "access-edge" })),
              "08006",
            );
            let line = await logged("conn_admission");
            assert.equal(line.outcome, "08006");
            assert.equal(line.gateway_status, status);
            assert.equal("gateway_error" in line, false);
            assert.equal("config_error" in line, false);
            // The redirect to the login page was not followed.
            assert.equal((await stats()).length, 1);
            server.clearLogs();
            const lost = await query(
              { query: "INSERT INTO t VALUES (1)" },
              { database, worker: "access-edge" },
            );
            assert.equal(lost.json.code, "08007");
            line = await logged("sql_admission");
            assert.equal(line.outcome, "08007");
            assert.equal(line.gateway_status, status);
            assert.equal((await stats()).length, 2);
            const text = JSON.stringify(server.getLogs());
            for (const secret of [accessId, accessSecret, "free text"])
              assert.equal(text.includes(secret), false, secret);
          }
        },
      );
      await t.test(
        "a refusal is prompt even when the upstream body never ends and its cancel never settles",
        async () => {
          await reset();
          const { database, node } = await seed();
          await mode(database, "stalled-cancel");
          // The gateway sends one byte of its refusal and neither ends the body nor lets it be
          // cancelled: the Edge answers all the same, and logs the status without a code.
          const promptly = async <T>(answer: Promise<T>) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                answer,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(new Error("refusal blocked on the upstream body")),
                    2500,
                  );
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          };
          const began = Date.now();
          const c = await promptly(open(database));
          assert.equal(await sqlstate(c), "08006");
          assert.ok(Date.now() - began < 2500);
          let rows = await stats();
          assert.equal(rows.length, 1);
          let line = await logged(
            "conn_admission",
            (await claimsOf(rows[0]!.token, node)).cid,
          );
          assert.equal(line.gateway_status, 503);
          assert.equal("gateway_error" in line, false);
          // An HTTP query is answered as promptly.
          const lost = await promptly(
            query({ query: "INSERT INTO t VALUES (1)" }, { database }),
          );
          assert.equal(lost.json.code, "08007");
          rows = await stats();
          assert.equal(rows.length, 2);
          line = await logged(
            "sql_admission",
            (await claimsOf(rows[1]!.token, node)).cid,
          );
          assert.equal(line.gateway_status, 503);
          assert.equal("gateway_error" in line, false);
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
        "ten connects to a sleeping database get the one wake ticket of its node, signed as v5",
        async () => {
          await reset();
          const { database, node } = await seed();
          await sleeping(database);
          const connections = await Promise.all(
            Array.from({ length: 10 }, () => open(database)),
          );
          assert.equal(connections.length, 10);
          const rows = await stats();
          assert.equal(rows.length, 10);
          const observed = await diagnostics(database);
          assert.equal(observed.received.length, 10);
          assert.equal(
            new Set(observed.received.map((v) => v.options.waiterId)).size,
            10,
          );
          const keys = await nodeKeys(node);
          const tokens = await Promise.all(
            rows.map((v) => verifyRouteToken(v.token, { region, keys })),
          );
          const claims = tokens.map((v) => {
            assert.ok(v.ok);
            assert.equal(v.claims.v, 5);
            return v.claims as { cid: string; op: string; gen: number };
          });
          // Every connect of the same wake carries the same operation and generation; the
          // connections themselves are told apart by their ids.
          assert.equal(new Set(claims.map((v) => v.op)).size, 1);
          assert.equal(new Set(claims.map((v) => v.gen)).size, 1);
          assert.equal(
            [...claims.map((v) => v.cid)].sort().join(),
            observed.received
              .map((v) => v.options.waiterId)
              .sort()
              .join(),
          );
          // Cloudflare claims the wake in D1 once, after the answers.
          await until(
            async () =>
              (await DB.prepare(
                "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.wake'",
              )
                .bind(database)
                .first("n")) === 1,
          );
          assert.equal((await diagnostics(database)).waiters, 0);
        },
      );
      await t.test(
        "request abort cancels exactly the real Actor waiter without an origin attempt",
        async () => {
          await reset();
          const { database } = await seed();
          await hold(database, "hold");
          const c = await open(database, { worker: "abort-edge" });
          assert.equal(await sqlstate(c), "08006");
          await hold(database, "release");
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
          await mode(database, "held");
          server.clearLogs();
          const c = await open(database, { worker: "abort-edge" });
          assert.equal(await sqlstate(c), "08006");
          assert.equal((await stats()).length, 1);
          // The wait on the upgrade the client interrupted is the gateway's, not the Edge's.
          const line = await logged("conn_admission");
          assert.equal(line.outcome, "08006");
          assert.ok(Number(line.gateway_connect_ms) >= 50);
          assert.equal(
            line.edge_ms,
            Number(line.duration_ms) - Number(line.gateway_connect_ms),
          );
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
          await mode(database, "close");
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
          await hold(timeoutDB.database, "hold");
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
          await hold(timeoutDB.database, "release");
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
          const { Client } = createRequire(import.meta.url)("pg");
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
