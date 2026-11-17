// SPDX-License-Identifier: Apache-2.0
/**
 * Run an approved EU1 acceptance with an existing project and its scoped integrator key:
 *
 *   pnpm --filter @pgcf/e2e exec node src/extension-acceptance.ts run
 *
 * Supply PGCF_API_URL, PGCF_INTEGRATOR_API_KEY, PGCF_PROJECT_ID, PGCF_REGION_ID, PGCF_EU1_NODE_ID
 * and PGCF_SIZE_CLASS_ID in the environment. Retain a unique lowercase alphanumeric
 * PGCF_EXTENSION_RUN_ID (12–40 characters). It names the two disposable databases
 * `pgcf-ext-<run-id>-source` and `pgcf-ext-<run-id>-restored` for operator reconciliation.
 * The source must run patched PostgreSQL 18 on the named EU1 node. Confirm its archive
 * by suspending it, physically restore it in EU, then prove the same results and constraints.
 * The run verifies deletion of the databases it owns. Provider retention handles archives.
 * The script reports only stages, counts, versions and redacted error codes.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  DATABASE_ID_PATTERN,
  NODE_ID_PATTERN,
  OPERATION_ID_PATTERN,
  PROJECT_ID_PATTERN,
  REGION_ID_PATTERN,
  ROLE_NAME_PATTERN,
  SIZE_CLASS_ID_PATTERN,
  isReservedRoleName,
} from "@pgcf/contracts/ids-core";
import { HarnessError, record, string } from "./core.ts";

const extensions = [
  "btree_gist",
  "citext",
  "ltree",
  "pg_trgm",
  "pgcrypto",
  "unaccent",
];
const expectedDigest =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

export const extensionFixtureStatements = [
  "CREATE SCHEMA extensions",
  ...extensions.flatMap((extension) => [
    `CREATE EXTENSION IF NOT EXISTS ${extension} WITH SCHEMA extensions`,
    `CREATE EXTENSION IF NOT EXISTS ${extension} WITH SCHEMA extensions`,
  ]),
  "CREATE TABLE public.products (id integer PRIMARY KEY, name text NOT NULL)",
  "INSERT INTO public.products VALUES (1, 'Schmidt'), (2, 'Zimmermann')",
  "CREATE INDEX product_name_trgm ON public.products USING gin (name extensions.gin_trgm_ops)",
  `CREATE TABLE public.bookings (room integer, slot tstzrange,
    EXCLUDE USING gist (room extensions.gist_int4_ops WITH =, slot WITH &&))`,
  "INSERT INTO public.bookings VALUES (1, '[2030-01-01 09:00+00,2030-01-01 10:00+00)'::tstzrange)",
  "CREATE TABLE public.handles (name extensions.citext UNIQUE)",
  "INSERT INTO public.handles VALUES ('Alice')",
  "CREATE TABLE public.categories (path extensions.ltree PRIMARY KEY)",
  "INSERT INTO public.categories VALUES ('shop.hardware.drills'), ('shop.clothes.coats')",
  "CREATE INDEX categories_path_gist ON public.categories USING gist (path extensions.gist_ltree_ops)",
  "CREATE TABLE public.restore_marker (id integer PRIMARY KEY)",
];

const search =
  "SELECT id FROM public.products WHERE name OPERATOR(extensions.%) 'Schmit'";
export const extensionObservationStatements = [
  `SELECT current_setting('server_version_num'),
          (SELECT NOT rolsuper FROM pg_roles WHERE rolname = current_user)
          AND (SELECT pg_get_userbyid(datdba) = current_user
               FROM pg_database WHERE datname = current_database())`,
  `SELECT e.extname, e.extversion, n.nspname
   FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname IN ('btree_gist', 'citext', 'ltree', 'pg_trgm', 'pgcrypto', 'unaccent')
   ORDER BY e.extname`,
  `SELECT (${search}),
          extensions.unaccent('García'),
          (SELECT path::text FROM public.categories
           WHERE path OPERATOR(extensions.<@) 'shop.hardware'::extensions.ltree),
          encode(extensions.digest('abc', 'sha256'), 'hex')`,
  "SET LOCAL enable_seqscan = off",
  `EXPLAIN (COSTS OFF) ${search}`,
];

type Observation = Readonly<{
  serverVersion: number;
  versions: readonly string[];
}>;

function resultRows(value: unknown, count: number): unknown[][][] {
  const { results } = record(value);
  if (!Array.isArray(results) || results.length !== count)
    throw new HarnessError("extension_observation_shape");
  return results.map((result) => {
    const rows = record(result).rows;
    if (!Array.isArray(rows) || !rows.every(Array.isArray))
      throw new HarnessError("extension_observation_shape");
    return rows;
  });
}

function patchedOwner(server: unknown[][]): number {
  const [rawVersion, owner] = server[0] ?? [];
  const serverVersion = Number(rawVersion);
  if (
    owner !== "t" ||
    !Number.isInteger(serverVersion) ||
    serverVersion < 180007 ||
    serverVersion >= 190000
  )
    throw new HarnessError("postgresql_release_or_owner");
  return serverVersion;
}

export function validateExtensionObservation(value: unknown): Observation {
  const [server, catalog, witnesses, , plan] = resultRows(
    value,
    extensionObservationStatements.length,
  );
  const serverVersion = patchedOwner(server!);
  if (
    catalog!.length !== extensions.length ||
    catalog!.some(
      ([name, version, schema], index) =>
        name !== extensions[index] ||
        typeof version !== "string" ||
        !/^\d+(\.\d+)+$/.test(version) ||
        schema !== "extensions",
    )
  )
    throw new HarnessError("extension_catalog");
  if (
    JSON.stringify(witnesses) !==
    JSON.stringify([["1", "Garcia", "shop.hardware.drills", expectedDigest]])
  )
    throw new HarnessError("extension_fixture_results");
  if (
    !plan!.some(
      ([line]) =>
        typeof line === "string" &&
        line.includes("Bitmap Index Scan on product_name_trgm"),
    )
  )
    throw new HarnessError("trigram_index_plan");
  return {
    serverVersion,
    versions: catalog!.map(([, version]) => version as string),
  };
}

type Context = Readonly<{
  origin: URL;
  key: string;
  project: string;
  region: string;
  node: string;
  sizeClass: string;
}>;

function variable(name: string, pattern?: RegExp): string {
  const value = process.env[name];
  if (!value || (pattern && !pattern.test(value)))
    throw new HarnessError(`invalid_${name}`);
  return value;
}

function configuration(): Context {
  let origin: URL;
  try {
    origin = new URL(variable("PGCF_API_URL"));
  } catch {
    throw new HarnessError("invalid_PGCF_API_URL");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new HarnessError("invalid_PGCF_API_URL");
  const region = variable("PGCF_REGION_ID", REGION_ID_PATTERN);
  if (region !== "eu" && !region.startsWith("eu-"))
    throw new HarnessError("invalid_PGCF_REGION_ID");
  return {
    origin,
    region,
    key: variable("PGCF_INTEGRATOR_API_KEY"),
    project: variable("PGCF_PROJECT_ID", PROJECT_ID_PATTERN),
    node: variable("PGCF_EU1_NODE_ID", NODE_ID_PATTERN),
    sizeClass: variable("PGCF_SIZE_CLASS_ID", SIZE_CLASS_ID_PATTERN),
  };
}

async function management(
  context: Context,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Response> {
  const mutation = method !== "GET";
  const headers = new Headers({ Authorization: `Bearer ${context.key}` });
  if (mutation) headers.set("Idempotency-Key", randomUUID());
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) headers.set("Content-Type", "application/json");
  const url = new URL(path, context.origin);
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fetch(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
      if (attempt === 2 || (result.status < 500 && result.status !== 429))
        return result;
      await result.body?.cancel();
    } catch {
      if (attempt === 2)
        throw new HarnessError(`management_${method}_transport`);
    }
    // Any retry of a management mutation keeps its original body and idempotency key.
    await delay(2000);
  }
}

async function json(
  response: Response,
  purpose: string,
): Promise<Record<string, unknown>> {
  if (!response.ok)
    throw new HarnessError(`${purpose}_http_${response.status}`);
  return record(await response.json());
}

async function waitFor<T>(
  purpose: string,
  check: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 600000;
  do {
    const result = await check();
    if (result !== undefined) return result;
    await delay(2000);
  } while (Date.now() < deadline);
  throw new HarnessError(`${purpose}_timeout`);
}

type Fixture = { name: string; id?: string };

function ownedDatabase(
  context: Context,
  fixture: Fixture,
  value: unknown,
): string {
  const database = record(value);
  const id = string(database.id);
  if (
    !DATABASE_ID_PATTERN.test(id) ||
    database.project_id !== context.project ||
    database.region_id !== context.region ||
    database.name !== fixture.name ||
    (fixture.id !== undefined && id !== fixture.id)
  )
    throw new HarnessError("unexpected_fixture_scope");
  return id;
}

function report(
  step: string,
  pass: boolean,
  values: Record<string, number | readonly string[]> = {},
): void {
  console.log(JSON.stringify({ step, pass, ...values }));
}

async function operation(
  context: Context,
  value: unknown,
  database: string,
  kind: string,
): Promise<void> {
  const token = record(value);
  const id = string(token.id);
  if (
    !OPERATION_ID_PATTERN.test(id) ||
    token.database_id !== database ||
    token.project_id !== context.project ||
    token.kind !== kind
  )
    throw new HarnessError("unexpected_operation_scope");
  await waitFor("operation", async () => {
    const current = await json(
      await management(context, "GET", `/v1/operations/${id}`),
      "operation",
    );
    if (
      current.id !== id ||
      current.database_id !== database ||
      current.project_id !== context.project ||
      current.kind !== kind
    )
      throw new HarnessError("unexpected_operation_scope");
    if (current.status === "failed") {
      const code = record(current.error).code;
      throw new HarnessError(
        typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
          ? code
          : "operation_failed",
      );
    }
    if (current.status === "succeeded") return true;
    if (current.status !== "pending" && current.status !== "running")
      throw new HarnessError("invalid_operation_state");
  });
}

async function state(
  context: Context,
  fixture: Fixture,
  expected: string,
): Promise<void> {
  await waitFor(expected, async () => {
    const database = await json(
      await management(context, "GET", `/v1/databases/${fixture.id}`),
      "database",
    );
    ownedDatabase(context, fixture, database);
    if (database.node_id !== null && database.node_id !== context.node)
      throw new HarnessError("unexpected_eu1_node");
    if (
      database.node_id === context.node &&
      database.observed_state === expected &&
      database.generation === database.observed_generation
    )
      return true;
  });
}

async function connectionUri(
  context: Context,
  id: string,
  role = "app",
): Promise<URL> {
  const result = await json(
    await management(
      context,
      "GET",
      `/v1/databases/${id}/roles/${role}/connection-uri`,
    ),
    "connection_uri",
  );
  const uri = new URL(string(result.uri));
  if (
    (uri.protocol !== "postgres:" && uri.protocol !== "postgresql:") ||
    uri.pathname !== `/${id}` ||
    result.database_id !== id ||
    result.role !== role ||
    result.includes_password !== true ||
    uri.username !== role ||
    !uri.password ||
    uri.port
  )
    throw new HarnessError("unexpected_connection_scope");
  return uri;
}

async function sql(
  uri: URL,
  statements: readonly string[],
  expectedSqlstate?: string,
): Promise<unknown> {
  const response = await fetch(new URL("/sql", `https://${uri.host}`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": uri.href,
      "Neon-Raw-Text-Output": "true",
      "Neon-Array-Mode": "true",
    },
    body: JSON.stringify({
      queries: statements.map((query) => ({ query, params: [] })),
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(90000),
  });
  const value = record(await response.json());
  if (
    expectedSqlstate === undefined
      ? !response.ok
      : response.status !== 400 || value.code !== expectedSqlstate
  ) {
    const code = value.code;
    throw new HarnessError(
      typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)
        ? `sql_${code}`
        : `sql_http_${response.status}`,
    );
  }
  return value;
}

async function observe(uri: URL): Promise<Observation> {
  const result = validateExtensionObservation(
    await sql(uri, extensionObservationStatements),
  );
  await sql(
    uri,
    [
      "INSERT INTO public.bookings VALUES (1, '[2030-01-01 09:30+00,2030-01-01 09:45+00)'::tstzrange)",
    ],
    "23P01",
  );
  await sql(uri, ["INSERT INTO public.handles VALUES ('alice')"], "23505");
  return result;
}

async function cleanup(context: Context, fixture: Fixture): Promise<void> {
  if (fixture.id === undefined) {
    // A lost create reply can leave a live fixture. Reconcile by the exact random name
    // and project from the request, without guessing a database ID or widening the scope.
    const query = new URLSearchParams({
      project_id: context.project,
      region_id: context.region,
      name: fixture.name,
    });
    const listed = await json(
      await management(context, "GET", `/v1/databases?${query}`),
      "cleanup_lookup",
    );
    if (
      !Array.isArray(listed.data) ||
      listed.data.length > 1 ||
      listed.next_cursor !== null
    )
      throw new HarnessError("ambiguous_fixture_cleanup");
    if (listed.data.length === 0) return;
    fixture.id = ownedDatabase(context, fixture, listed.data[0]);
  }
  const path = `/v1/databases/${fixture.id}`;
  const current = await management(context, "GET", path);
  if (current.status === 404) return;
  ownedDatabase(context, fixture, await json(current, "cleanup_scope"));
  const removed = await management(context, "DELETE", path);
  if (removed.status === 404) return;
  const { operation: removedOperation } = await json(removed, "cleanup_delete");
  await operation(context, removedOperation, fixture.id, "database.delete");
  await waitFor("cleanup_confirmation", async () => {
    const response = await management(context, "GET", path);
    if (response.status === 404) return true;
    const database = await json(response, "cleanup_state");
    ownedDatabase(context, fixture, database);
    return database.observed_state === "deleted" ? true : undefined;
  });
}

function newFixture(suffix: string): Fixture {
  if (!/^[a-z][a-z0-9-]{0,12}$/.test(suffix))
    throw new HarnessError("invalid_fixture_suffix");
  const runId = variable("PGCF_EXTENSION_RUN_ID", /^[a-z0-9]{12,40}$/);
  return { name: `pgcf-ext-${runId}-${suffix}` };
}

async function checkUnusedName(
  context: Context,
  fixture: Fixture,
): Promise<void> {
  const query = new URLSearchParams({
    project_id: context.project,
    region_id: context.region,
    name: fixture.name,
  });
  const list = await json(
    await management(context, "GET", `/v1/databases?${query}`),
    "fixture_name_preflight",
  );
  if (
    !Array.isArray(list.data) ||
    list.data.length !== 0 ||
    list.next_cursor !== null
  )
    throw new HarnessError("fixture_name_in_use");
}

async function createFixture(context: Context, fixture: Fixture): Promise<URL> {
  const created = await json(
    await management(context, "POST", "/v1/databases", {
      name: fixture.name,
      project_id: context.project,
      region_id: context.region,
      size_class_id: context.sizeClass,
    }),
    "create",
  );
  fixture.id = ownedDatabase(context, fixture, created.database);
  await operation(context, created.operation, fixture.id, "database.create");
  await state(context, fixture, "ready");
  const uri = await connectionUri(context, fixture.id);
  patchedOwner(
    resultRows(await sql(uri, [extensionObservationStatements[0]!]), 1)[0]!,
  );
  return uri;
}

type FixtureBatch = (
  statements: readonly string[],
  expectedSqlstate?: string,
) => Promise<unknown>;

export interface Eu1Fixture {
  readonly databaseId: string;
  readonly batch: FixtureBatch;
  createRole(name: string): Promise<void>;
  roleBatch(
    name: string,
    statements: readonly string[],
    expectedSqlstate?: string,
  ): Promise<unknown>;
}

export async function withEu1Fixture<T>(
  suffix: string,
  test: (fixture: Eu1Fixture) => Promise<T>,
): Promise<T> {
  const context = configuration();
  const fixture = newFixture(suffix);
  await checkUnusedName(context, fixture);
  let value: T;
  let cleanupFailed = false;
  try {
    const uri = await createFixture(context, fixture);
    const databaseId = string(fixture.id);
    const roles = new Map<string, URL>();
    value = await test({
      databaseId,
      batch: (statements, expectedSqlstate) =>
        sql(uri, statements, expectedSqlstate),
      async createRole(name) {
        if (
          !ROLE_NAME_PATTERN.test(name) ||
          isReservedRoleName(name) ||
          name === "app" ||
          roles.has(name)
        )
          throw new HarnessError("invalid_fixture_role");
        const result = await json(
          await management(
            context,
            "POST",
            `/v1/databases/${databaseId}/roles`,
            {
              name,
              bypass_rls: false,
              valid_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
              connection_limit: 2,
            },
          ),
          "fixture_role",
        );
        if (
          result.name !== name ||
          result.owner !== false ||
          result.database_id !== databaseId ||
          result.bypass_rls !== false
        )
          throw new HarnessError("unexpected_role_scope");
        await state(context, fixture, "ready");
        roles.set(name, await connectionUri(context, databaseId, name));
      },
      roleBatch(name, statements, expectedSqlstate) {
        const role = roles.get(name);
        if (!role) throw new HarnessError("unknown_fixture_role");
        return sql(role, statements, expectedSqlstate);
      },
    });
  } finally {
    try {
      await cleanup(context, fixture);
      report(`cleanup_${suffix}`, true);
    } catch {
      report(`cleanup_${suffix}`, false);
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) throw new HarnessError("fixture_cleanup_unconfirmed");
  return value;
}

async function run(context: Context): Promise<void> {
  const source = newFixture("source");
  const target = newFixture("restored");
  const attempted: Fixture[] = [];
  for (const fixture of [source, target])
    await checkUnusedName(context, fixture);
  let cleanupFailed = false;
  try {
    attempted.push(source);
    const sourceUri = await createFixture(context, source);
    const sourceId = string(source.id);
    await sql(sourceUri, extensionFixtureStatements);
    const sourceObservation = await observe(sourceUri);
    report("source_index_and_constraints", true, sourceObservation);

    const suspended = await json(
      await management(
        context,
        "POST",
        `/v1/databases/${sourceId}/suspend`,
        {},
      ),
      "suspend",
    );
    await operation(context, suspended.operation, sourceId, "database.suspend");
    await state(context, source, "hibernated");
    const backups = await json(
      await management(context, "GET", `/v1/databases/${sourceId}/backups`),
      "backup_catalog",
    );
    if (
      backups.database_id !== sourceId ||
      !Array.isArray(backups.base_backups) ||
      backups.base_backups.length === 0 ||
      typeof backups.latest_restorable_time !== "string"
    )
      throw new HarnessError("backup_catalog_incomplete");
    report("source_sleep_and_archive", true, {
      baseBackups: backups.base_backups.length,
    });

    attempted.push(target);
    const restored = await json(
      await management(context, "POST", `/v1/databases/${sourceId}/restore`, {
        mode: "full",
        name: target.name,
        region_id: context.region,
      }),
      "restore",
    );
    target.id = ownedDatabase(context, target, restored.target_database);
    if (target.id === sourceId) throw new HarnessError("restore_reused_source");
    await operation(context, restored.operation, target.id, "database.restore");
    await state(context, target, "ready");
    const targetUri = await connectionUri(context, target.id);
    const targetObservation = await observe(targetUri);
    if (JSON.stringify(targetObservation) !== JSON.stringify(sourceObservation))
      throw new HarnessError("restore_extension_version_mismatch");
    await sql(targetUri, ["INSERT INTO public.restore_marker VALUES (1)"]);
    report("restored_index_constraints_and_write", true, targetObservation);
  } finally {
    for (const fixture of attempted.reverse()) {
      const label = fixture === target ? "cleanup_restored" : "cleanup_source";
      try {
        await cleanup(context, fixture);
        report(label, true);
      } catch {
        cleanupFailed = true;
        report(label, false);
      }
    }
  }
  if (cleanupFailed) throw new HarnessError("fixture_cleanup_unconfirmed");
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "run")
      throw new HarnessError("usage_extensions_run");
    await run(configuration());
  } catch (error) {
    // Neither HTTP bodies nor exception messages from native clients are operator output.
    console.error(
      JSON.stringify({
        error: error instanceof HarnessError ? error.code : "unexpected",
      }),
    );
    process.exitCode = 1;
  }
}
