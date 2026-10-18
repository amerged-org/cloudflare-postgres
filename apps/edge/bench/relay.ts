// SPDX-License-Identifier: Apache-2.0
/**
 * What the Edge adds to one statement, measured locally against a real PostgreSQL 18.
 *
 *   pnpm bench                               (from apps/edge)
 *
 * Environment: PGCF_TEST_POSTGRES_BINDIR, the directory of the PostgreSQL 18 binaries (default:
 * Homebrew's); BENCH_ROUNDS (default 5) and BENCH_STATEMENTS, statements per round and variant
 * (default 60); BENCH_BASE_REF, a git ref whose `apps/edge/src` runs as a fourth variant, `base`,
 * so that a change to the Edge is measured against the version before it (see below).
 *
 * Each statement (a 50-row list page) is timed three ways, over the WebSocket relay (`/v2`) and
 * over HTTP (`/sql`), the statements of the variants interleaved in a random order (the stack is
 * `rig.ts`):
 *   direct  the client talks to a loopback shim, a WebSocket-to-TCP bridge and an HTTP runner
 *           in front of the PostgreSQL, written in Node;
 *   bridge  the client talks to the test gateway Worker in workerd, which does the same as the
 *           shim (a socket pump for `/v2`, a call to the HTTP runner for `/sql`);
 *   edge    the client talks to the production Edge entry, with the real Actor and limiters,
 *           which reaches the same gateway Worker through a service binding.
 * The Edge's share of a statement is edge minus bridge; it includes the service-binding hop to
 * the gateway Worker, which a bridge client does not make. The gateway side is test code, and
 * the network between client, Edge and gateway is loopback: the numbers say what the Edge adds
 * locally, not what Cloudflare's network adds.
 *
 * Runs of separate processes differ by more than a change to the Edge costs: on a loaded laptop
 * the medians of identical code moved by a millisecond. `base` is the same Edge as a git ref has
 * it, in the same workerd and on the same statements in turn, so `edge_minus_base` is the change.
 */
import { Agent, request } from "node:http";
import { encodeStartup } from "@pgcf/contracts/pg-wire";
import pg from "pg";
import { WebSocket } from "ws";
import { startRig } from "./rig.ts";

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);
const STATEMENTS = Number(process.env.BENCH_STATEMENTS ?? 60);
const WARMUP = 20;
/** Connections per round and variant beyond the one that carries the statements. */
const EXTRA_CONNECTS = 5;
const STATEMENT = "SELECT id, title, body FROM items ORDER BY id LIMIT 50";
const BASE_REF = process.env.BENCH_BASE_REF;
type Variant = "direct" | "bridge" | "base" | "edge";
const VARIANTS: readonly Variant[] = BASE_REF
  ? ["direct", "bridge", "base", "edge"]
  : ["direct", "bridge", "edge"];
const shuffled = () => [...VARIANTS].sort(() => Math.random() - 0.5);

const now = () => Number(process.hrtime.bigint()) / 1e6;

/** The nearest-rank percentile of `samples`. */
function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

interface Target {
  readonly port: number;
  readonly host?: string;
  readonly path: string;
}

/** A client of the PostgreSQL wire protocol over one WebSocket: Startup, then simple queries. */
async function openWire(target: Target) {
  const started = now();
  const ws = new WebSocket(`ws://127.0.0.1:${target.port}${target.path}`, {
    perMessageDeflate: false,
    headers: {
      ...(target.host ? { Host: target.host } : {}),
      "CF-Connecting-IP": "192.0.2.1",
    },
  });
  let pending = Buffer.alloc(0);
  let ready: ((error?: Error) => void) | null = null;
  ws.on("message", (frame: Buffer) => {
    pending = Buffer.concat([pending, frame]);
    while (pending.length >= 5) {
      const length = pending.readInt32BE(1);
      if (pending.length < 1 + length) break;
      const type = pending[0];
      pending = pending.subarray(1 + length);
      if (type === 0x45) ready?.(new Error("PostgreSQL error"));
      else if (type === 0x5a) ready?.();
    }
  });
  const settled = () =>
    new Promise<void>((done, fail) => {
      ready = (error) => (error ? fail(error) : done());
    });
  await new Promise<void>((done, fail) => {
    ws.once("open", done);
    ws.once("error", fail);
    ws.once("unexpected-response", (_req, res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        fail(
          new Error(
            `${target.path} upgrade answered ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`,
          ),
        ),
      );
    });
  });
  const first = settled();
  ws.send(encodeStartup({ user: "app", database: "postgres" }));
  await first;
  const connectMs = now() - started;
  const query = async (): Promise<number> => {
    const text = Buffer.from(`${STATEMENT}\0`);
    const frame = Buffer.alloc(5 + text.length);
    frame[0] = 0x51;
    frame.writeInt32BE(4 + text.length, 1);
    text.copy(frame, 5);
    const answered = settled();
    const sent = now();
    ws.send(frame);
    await answered;
    return now() - sent;
  };
  return { connectMs, query, close: () => ws.close() };
}

/** An HTTP client; with a `database` it speaks the Neon driver's format to an Edge, else the gateway's. */
function sqlClient(target: Target, database: string | undefined) {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const password = Buffer.from("bench").toString("base64url");
  const forwarded = JSON.stringify({
    password,
    queries: [{ query: STATEMENT, params: [] }],
  });
  const direct = JSON.stringify({ query: STATEMENT, params: [] });
  return {
    query: () =>
      new Promise<number>((done, fail) => {
        const body = database ? direct : forwarded;
        const sent = now();
        const req = request(
          {
            host: "127.0.0.1",
            port: target.port,
            method: "POST",
            path: target.path,
            agent,
            headers: {
              ...(target.host ? { Host: target.host } : {}),
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              "CF-Connecting-IP": "192.0.2.1",
              ...(database
                ? {
                    "Neon-Connection-String": `postgresql://app:bench@db.invalid/${database}`,
                    "Neon-Raw-Text-Output": "true",
                    "Neon-Array-Mode": "true",
                  }
                : {}),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              const elapsed = now() - sent;
              const answer = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              ) as { rows?: unknown[] };
              if (res.statusCode !== 200 || answer.rows?.length !== 50)
                fail(new Error(`HTTP ${res.statusCode}`));
              else done(elapsed);
            });
          },
        );
        req.on("error", fail);
        req.end(body);
      }),
    close: () => agent.destroy(),
  };
}

interface Samples {
  readonly statements: number[];
  readonly connects: number[];
}

async function main() {
  const rig = await startRig({ baseRef: BASE_REF });
  try {
    const client = new pg.Client({
      host: "127.0.0.1",
      port: rig.postgres.port,
      user: "app",
      database: "postgres",
    });
    await client.connect();
    await client.query(
      "CREATE TABLE items(id int PRIMARY KEY, title text NOT NULL, body text NOT NULL)",
    );
    await client.query(
      "INSERT INTO items SELECT g, 'item ' || g, repeat('x', 80) FROM generate_series(1, 1000) g",
    );
    await client.end();
    const workerd = rig.workerd.port;
    const edge = (host: string, database: string) => ({
      database,
      ws: {
        port: workerd,
        host,
        path: `/v2?${new URLSearchParams({ database, user: "app" })}`,
      },
      sql: { port: workerd, host, path: "/sql" },
    });
    const targets: Partial<
      Record<Variant, { ws: Target; sql: Target; database?: string }>
    > = {
      direct: {
        ws: { port: rig.shim.port, path: "/pg" },
        sql: { port: rig.shim.port, path: "/sql" },
      },
      bridge: {
        ws: { port: workerd, host: "gateway.invalid", path: "/pg" },
        sql: { port: workerd, host: "gateway.invalid", path: "/sql" },
      },
      edge: edge("edge.invalid", rig.workerd.database),
      ...(rig.workerd.baseDatabase
        ? { base: edge("base.invalid", rig.workerd.baseDatabase) }
        : {}),
    };
    const target = (variant: Variant) => targets[variant]!;
    const results = new Map<string, Samples>();
    const record = (mode: string, variant: Variant) => {
      const key = `${mode}/${variant}`;
      let samples = results.get(key);
      if (!samples)
        results.set(key, (samples = { statements: [], connects: [] }));
      return samples;
    };
    for (let round = -1; round < ROUNDS; round++) {
      // Round -1 warms every path and is not counted.
      const count = round < 0 ? WARMUP : STATEMENTS;
      const wires = new Map<Variant, Awaited<ReturnType<typeof openWire>>>();
      for (const variant of shuffled()) {
        const wire = await openWire(target(variant).ws);
        wires.set(variant, wire);
        if (round >= 0) record("ws", variant).connects.push(wire.connectMs);
      }
      for (let i = 0; i < count; i++)
        for (const variant of shuffled()) {
          const elapsed = await wires.get(variant)!.query();
          if (round >= 0) record("ws", variant).statements.push(elapsed);
        }
      for (const wire of wires.values()) wire.close();
      for (let i = 0; i < EXTRA_CONNECTS; i++)
        for (const variant of shuffled()) {
          const wire = await openWire(target(variant).ws);
          if (round >= 0) record("ws", variant).connects.push(wire.connectMs);
          wire.close();
        }
      const clients = new Map(
        VARIANTS.map((variant) => [
          variant,
          sqlClient(target(variant).sql, target(variant).database),
        ]),
      );
      for (let i = 0; i < count; i++)
        for (const variant of shuffled()) {
          const elapsed = await clients.get(variant)!.query();
          if (round >= 0) record("sql", variant).statements.push(elapsed);
        }
      for (const http of clients.values()) http.close();
    }
    const summary = (samples: number[]) => ({
      n: samples.length,
      p50_ms: Number(percentile(samples, 0.5).toFixed(3)),
      p95_ms: Number(percentile(samples, 0.95).toFixed(3)),
      mean_ms: Number(
        (
          samples.reduce((sum, value) => sum + value, 0) / samples.length
        ).toFixed(3),
      ),
    });
    /** What `of` adds to `over`: the difference of their p50, p95 and mean. */
    const difference = (of: number[], over: number[]) => {
      const a = summary(of);
      const b = summary(over);
      return {
        p50_ms: Number((a.p50_ms - b.p50_ms).toFixed(3)),
        p95_ms: Number((a.p95_ms - b.p95_ms).toFixed(3)),
        mean_ms: Number((a.mean_ms - b.mean_ms).toFixed(3)),
      };
    };
    for (const mode of ["ws", "sql"]) {
      for (const variant of VARIANTS) {
        const samples = results.get(`${mode}/${variant}`)!;
        console.log(
          JSON.stringify({
            mode,
            variant,
            statement: summary(samples.statements),
            ...(mode === "ws" ? { connect: summary(samples.connects) } : {}),
          }),
        );
      }
      const of = (variant: Variant) => results.get(`${mode}/${variant}`)!;
      const comparison = (
        subject: Variant,
        reference: Variant,
      ): Record<string, unknown> => ({
        statement: difference(of(subject).statements, of(reference).statements),
        ...(mode === "ws"
          ? {
              connect: difference(of(subject).connects, of(reference).connects),
            }
          : {}),
      });
      console.log(
        JSON.stringify({
          mode,
          added_by_edge: comparison("edge", "bridge"),
          ...(BASE_REF
            ? {
                added_by_base: comparison("base", "bridge"),
                edge_minus_base: comparison("edge", "base"),
              }
            : {}),
        }),
      );
    }
    // The Edge's own log line of each request, averaged: where its time goes, at whole
    // milliseconds (the Workers clock only advances across I/O).
    const stages = new Map<string, Map<string, number[]>>();
    for (const message of rig.logs()) {
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(message) as Record<string, unknown>;
      } catch {
        continue;
      }
      // Only the Edge under test: the base ref's lines lack the newer fields.
      if (
        (line.event !== "conn_admission" && line.event !== "sql_admission") ||
        line.database_id !== rig.workerd.database
      )
        continue;
      const fields = stages.get(line.event) ?? new Map<string, number[]>();
      stages.set(line.event, fields);
      for (const [key, value] of Object.entries(line))
        if (key.endsWith("_ms") && typeof value === "number")
          fields.set(key, [...(fields.get(key) ?? []), value]);
    }
    for (const [event, fields] of stages)
      console.log(
        JSON.stringify({
          event,
          mean_ms: Object.fromEntries(
            [...fields].map(([key, values]) => [
              key,
              Number(
                (
                  values.reduce((sum, value) => sum + value, 0) / values.length
                ).toFixed(2),
              ),
            ]),
          ),
        }),
      );
  } finally {
    await rig.stop();
  }
}

await main();
