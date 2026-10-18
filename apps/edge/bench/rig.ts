// SPDX-License-Identifier: Apache-2.0
/**
 * A local stack for the Edge benchmarks: a real PostgreSQL 18, a loopback shim in Node that
 * stands in for the gateway's `/sql`, and the production Edge entry with its real Actor, D1 and
 * limiters in workerd next to a test gateway Worker (`test/bench-gateway.js`), with one running
 * database seeded. The shim and the gateway Worker are test code: no PGCF gateway runs here.
 *
 * With a base ref the stack also runs the Edge as that git ref has it, next to the working tree's,
 * so that two versions are compared inside one workerd process, request by request in turn:
 * machine load that drifts between separate runs hits both alike.
 *
 * The PostgreSQL binaries are the directory `PGCF_TEST_POSTGRES_BINDIR` names (default:
 * Homebrew's PostgreSQL 18). It listens on loopback only; its superuser is the role "app", with
 * trust authentication unless a password is given. The seeded database also exists in it under
 * its id, which is where a client's StartupMessage names it.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import pg from "pg";
import { createTestHarness } from "wrangler";
import { WebSocketServer } from "ws";

const BINARIES =
  process.env.PGCF_TEST_POSTGRES_BINDIR ??
  "/opt/homebrew/opt/postgresql@18/bin";
const REPOSITORY = resolve(import.meta.dirname, "../../..");
/** The Edge's sources at the base ref; ignored by git, removed when the rig stops. */
const BASE = join(import.meta.dirname, ".base-src");

/** Writes `apps/edge/src` as `ref` has it to `BASE`, with an entry like `test/bench-entry.js`. */
async function extractBase(ref: string): Promise<string> {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: REPOSITORY, maxBuffer: 16_000_000 });
  await rm(BASE, { recursive: true, force: true });
  await mkdir(BASE);
  const files = git("ls-tree", "--name-only", ref, "apps/edge/src/")
    .toString()
    .split("\n")
    .filter(Boolean);
  if (files.length === 0) throw new Error(`no apps/edge/src at ${ref}`);
  for (const path of files)
    await writeFile(join(BASE, basename(path)), git("show", `${ref}:${path}`));
  const entry = join(BASE, "entry.js");
  await writeFile(
    entry,
    [
      'import edge from "./index.ts";',
      'import { withSeed } from "../../test/bench-seed.js";',
      'export { RegionLink } from "../../../api/src/region-link.ts";',
      'export { DatabaseActor } from "../../../api/src/database-actor.ts";',
      "export default withSeed(edge);",
      "",
    ].join("\n"),
  );
  return entry;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise((done) => server.close(done));
  return port;
}

async function startPostgres(directory: string, password: string | undefined) {
  const data = join(directory, "data");
  const authentication = password
    ? ["-A", "password", "--pwfile", join(directory, "password")]
    : ["-A", "trust"];
  if (password)
    await writeFile(join(directory, "password"), password, { mode: 0o600 });
  execFileSync(
    join(BINARIES, "initdb"),
    ["-D", data, "-U", "app", "--no-sync", ...authentication],
    { stdio: "ignore" },
  );
  const port = await freePort();
  execFileSync(
    join(BINARIES, "pg_ctl"),
    [
      "-D",
      data,
      "-o",
      `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories= -c fsync=off`,
      "-l",
      join(directory, "postgres.log"),
      "-w",
      "start",
    ],
    { stdio: "ignore" },
  );
  return {
    port,
    stop: () =>
      execFileSync(
        join(BINARIES, "pg_ctl"),
        ["-D", data, "-m", "fast", "stop"],
        { stdio: "ignore" },
      ),
  };
}

/** The loopback shim: `/pg` bridges WebSocket frames to PostgreSQL, `/sql` runs a request. */
async function startShim(postgres: number, password: string | undefined) {
  const pool = new pg.Pool({
    host: "127.0.0.1",
    port: postgres,
    user: "app",
    password,
    database: "postgres",
    max: 4,
  });
  const raw = { getTypeParser: () => (value: string) => value };
  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          queries: { query: string; params: string[] }[];
        };
        const results = [];
        for (const { query, params } of body.queries) {
          const result = await pool.query({
            text: query,
            values: params,
            rowMode: "array",
            types: raw,
          });
          results.push({
            fields: result.fields.map((field) => ({
              name: field.name,
              dataTypeID: field.dataTypeID,
            })),
            command: result.command,
            rowCount: result.rowCount,
            rows: result.rows,
            rowAsArray: true,
          });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(results[0]));
      })();
    });
  });
  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  http.on("upgrade", (req, socket, head) => {
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const tcp = connect(postgres, "127.0.0.1");
      tcp.setNoDelay(true);
      ws.on("message", (frame: Buffer) => tcp.write(frame));
      tcp.on("data", (chunk) => ws.send(chunk));
      tcp.on("close", () => ws.close());
      tcp.on("error", () => ws.close());
      ws.on("close", () => tcp.destroy());
    });
  });
  const port = await freePort();
  await new Promise<void>((done) => http.listen(port, "127.0.0.1", done));
  return {
    port,
    stop: async () => {
      http.closeAllConnections();
      await new Promise((done) => http.close(done));
      await pool.end();
    },
  };
}

export interface Rig {
  readonly postgres: { readonly port: number };
  /** The Node shim, reached without workerd. */
  readonly shim: { readonly port: number };
  /**
   * workerd's port: the Edge answers `edge.invalid` with the database `database`, the Edge at the
   * base ref `base.invalid` with `baseDatabase`, and the gateway Worker `gateway.invalid`.
   */
  readonly workerd: {
    readonly port: number;
    readonly database: string;
    readonly baseDatabase?: string;
  };
  /** The workerd logs captured so far. */
  logs(): string[];
  stop(): Promise<void>;
}

export async function startRig(
  options: { password?: string; baseRef?: string } = {},
): Promise<Rig> {
  const { password, baseRef } = options;
  const stops: (() => unknown)[] = [];
  const directory = await mkdtemp(join(tmpdir(), "pgcf-edge-bench-"));
  stops.push(() => rm(directory, { recursive: true, force: true }));
  try {
    const postgres = await startPostgres(directory, password);
    stops.push(postgres.stop);
    const shim = await startShim(postgres.port, password);
    stops.push(shim.stop);
    const keys = JSON.stringify({
      active: "v1",
      keys: { v1: randomBytes(32).toString("base64url") },
    });
    const unlimited = { limit: 1_000_000, period: 60 };
    // Each Edge has a D1 database and Actors of its own, so two never share a fixture.
    const edge = (name: string, main: string, host: string) => ({
      config: {
        name,
        main,
        compatibility_date: "2026-10-02",
        routes: [`${host}/*`],
        vars: { ROUTE_MASTER_KEYS: keys },
        services: [{ binding: "GATEWAY", service: "pgcf-gateway-bench" }],
        d1_databases: [
          {
            binding: "DB",
            database_name: name,
            database_id: name,
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
          { tag: "v1", new_sqlite_classes: ["DatabaseActor", "RegionLink"] },
        ],
        ratelimits: [
          {
            name: "CONNECTION_RATE_LIMITER",
            namespace_id: "1",
            simple: unlimited,
          },
          {
            name: "DATABASE_CONNECTION_RATE_LIMITER",
            namespace_id: "3",
            simple: unlimited,
          },
          {
            name: "BINDING_CONNECTION_RATE_LIMITER",
            namespace_id: "4",
            simple: unlimited,
          },
        ],
      },
    });
    const baseEntry = baseRef ? await extractBase(baseRef) : undefined;
    if (baseEntry) stops.push(() => rm(BASE, { recursive: true, force: true }));
    const server = createTestHarness({
      root: directory,
      workers: [
        edge(
          "pgcf-edge-bench",
          resolve(import.meta.dirname, "../test/bench-entry.js"),
          "edge.invalid",
        ),
        ...(baseEntry
          ? [edge("pgcf-edge-base", baseEntry, "base.invalid")]
          : []),
        {
          config: {
            name: "pgcf-gateway-bench",
            main: resolve(import.meta.dirname, "../test/bench-gateway.js"),
            compatibility_date: "2026-10-02",
            routes: ["gateway.invalid/*"],
            vars: {
              SHIM: `127.0.0.1:${shim.port}`,
              PG: `127.0.0.1:${postgres.port}`,
            },
          },
        },
      ],
    });
    stops.push(() => server.close());
    const { url } = await server.listen();
    const admin = new pg.Client({
      host: "127.0.0.1",
      port: postgres.port,
      user: "app",
      password,
      database: "postgres",
    });
    await admin.connect();
    try {
      const seeded: string[] = [];
      for (const [worker, host] of [
        ["pgcf-edge-bench", "edge.invalid"],
        ...(baseEntry ? [["pgcf-edge-base", "base.invalid"]] : []),
      ] as const) {
        await server.getWorker(worker).applyD1Migrations("DB");
        const database = await (
          await server.fetch(`http://${host}/__seed`)
        ).text();
        await admin.query(`CREATE DATABASE "${database}"`);
        seeded.push(database);
      }
      return {
        postgres: { port: postgres.port },
        shim: { port: shim.port },
        workerd: {
          port: Number(url.port),
          database: seeded[0]!,
          ...(seeded[1] ? { baseDatabase: seeded[1] } : {}),
        },
        logs: () => server.getLogs().map((log) => log.message),
        stop: async () => {
          for (const stop of stops.reverse()) await stop();
        },
      };
    } finally {
      await admin.end();
    }
  } catch (error) {
    for (const stop of stops.reverse()) await stop();
    throw error;
  }
}
