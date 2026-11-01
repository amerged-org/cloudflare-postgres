// SPDX-License-Identifier: Apache-2.0
/**
 * The live acceptance of data events (T3 of docs/architecture/database-events-and-schedules.md,
 * section 8) on a Dev stack:
 *
 *   node src/data-events.ts run
 *
 * It creates a project and an integrator key, deploys a scratch receiver (receiver/worker.ts,
 * configured by receiver/wrangler.jsonc, a copy of wrangler.example.jsonc), creates a database
 * with a table that has the platform's capture trigger, and subscribes the receiver to
 * `data.orders`. Then it asserts:
 *   commit    one committed INSERT gives one verified delivery;
 *   rollback  a transaction that fails after its INSERT gives none;
 *   outage    while the receiver answers 503 with Retry-After, five commits are retried, and after
 *             the receiver recovers each event is there once, in (epoch, seq) order, and the
 *             deliveries API agrees.
 * It prints one JSON line per assertion (step, pass and measured numbers) and deletes everything
 * it created, checking each deletion. It prints no ids, keys, tokens, URIs or bodies.
 *
 * Environment (names only; values are read into memory and never printed or put in argv):
 *   PGCF_API_URL                    the management API
 *   PGCF_ADMIN_API_KEY             an administrator key: the project, its integrator key
 *   PGCF_REGION_ID, PGCF_SIZE_CLASS_ID  where the database is placed and its size class
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID  read by wrangler, which deploys the receiver
 *
 * The receiver's secrets go to wrangler as a 0600 file in a 0700 temporary directory, removed
 * afterwards. The database's connection URI travels only in the `Neon-Connection-String` header.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDataEventId } from "@pgcf/contracts/webhooks";
import { command, HarnessError, record, string } from "./core.ts";
import { percentile } from "./saas.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RECEIVER_CONFIG = "receiver/wrangler.jsonc";
const RECEIVER_URL = /https:\/\/pgcf-t3-receiver\.[a-z0-9-]+\.workers\.dev/;
const SECOND = 1000;

interface Receipt {
  event_id: string;
  delivery_id: string;
  attempt: number;
  body_sha256: string;
  received_at: number;
  verified: boolean;
  status: number;
}

interface Delivery {
  event_id: string;
  state: string;
  attempts: number;
}

interface Caller {
  readonly base: string;
  readonly key: string;
}

interface Receiver {
  readonly url: string;
  readonly token: string;
}

/** Orders the events by (epoch, seq): true when each is strictly after the one before it. */
export function isInSeqOrder(
  positions: readonly { epoch: number; seq: number }[],
): boolean {
  return positions.every((position, index) => {
    if (index === 0) return true;
    const before = positions[index - 1]!;
    return (
      position.epoch > before.epoch ||
      (position.epoch === before.epoch && position.seq > before.seq)
    );
  });
}

/**
 * How many pairs of events arrived against their (epoch, seq) order. Delivery order is not
 * guaranteed (retries of different events race); a receiver restores the order from the ids.
 */
export function arrivalInversions(
  positions: readonly { epoch: number; seq: number }[],
): number {
  let inversions = 0;
  for (let later = 1; later < positions.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      const a = positions[earlier]!;
      const b = positions[later]!;
      if (b.epoch < a.epoch || (b.epoch === a.epoch && b.seq < a.seq))
        inversions += 1;
    }
  }
  return inversions;
}

/** A mutation carries a fresh Idempotency-Key; a GET carries none. */
export function idempotencyHeaders(
  method: string,
  key: string,
): Record<string, string> {
  return method === "GET" ? {} : { "Idempotency-Key": key };
}

/** True when `actual` holds each expected id exactly once and no other id. */
export function sameEventIds(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  if (actual.length !== expected.length) return false;
  const counts = new Map<string, number>();
  for (const id of expected) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of actual) {
    const left = counts.get(id);
    if (left === undefined || left === 0) return false;
    counts.set(id, left - 1);
  }
  return true;
}

/** The count and the nearest-rank p50 and p95 of latencies in milliseconds. */
export function latencySummary(values: readonly number[]): {
  n: number;
  p50: number | null;
  p95: number | null;
} {
  return {
    n: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

function environment(name: string): string {
  const value = process.env[name];
  if (!value) throw new HarnessError(`missing_${name}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Polls `check` until it returns a value, at most `timeoutMs`. */
async function until<T>(
  what: string,
  timeoutMs: number,
  check: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new HarnessError(`timeout_${what}`);
    await sleep(SECOND);
  }
}

async function http(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs = 30 * SECOND,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** A management API call under a key. */
async function send(
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return http(
    new URL(path, caller.base),
    method,
    {
      Authorization: `Bearer ${caller.key}`,
      ...idempotencyHeaders(method, randomUUID()),
    },
    body,
  );
}

async function callJson(
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await send(caller, method, path, body);
  if (!response.ok) throw new HarnessError(`${method}_${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function expectStatus(
  caller: Caller,
  path: string,
  status: number,
): Promise<boolean> {
  const response = await send(caller, "GET", path);
  return response.status === status;
}

/** Runs one transaction of statements through the HTTP SQL path, as the database's role. */
async function transaction(
  uri: string,
  queries: readonly string[],
): Promise<number> {
  const url = new URL(uri);
  const response = await http(
    new URL("/sql", `https://${url.host}`),
    "POST",
    {
      "Neon-Connection-String": uri,
      "Neon-Raw-Text-Output": "true",
      "Neon-Array-Mode": "true",
    },
    { queries: queries.map((query) => ({ query, params: [] })) },
    90 * SECOND,
  );
  await response.arrayBuffer();
  return response.status;
}

async function receiverCall(
  receiver: Receiver,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await http(
    new URL(path, receiver.url),
    method,
    { Authorization: `Bearer ${receiver.token}` },
    body,
  );
  if (!response.ok) throw new HarnessError(`receiver_${response.status}`);
  return response.json();
}

async function receipts(receiver: Receiver): Promise<Receipt[]> {
  const body = record(await receiverCall(receiver, "GET", "/admin/receipts"));
  return body.receipts as Receipt[];
}

async function deliveries(
  caller: Caller,
  database: string,
): Promise<Delivery[]> {
  const body = record(
    await callJson(
      caller,
      "GET",
      `/v1/databases/${database}/webhook-deliveries?limit=100`,
    ),
  );
  return body.data as Delivery[];
}

async function setMode(receiver: Receiver, mode: string): Promise<void> {
  await receiverCall(receiver, "PUT", "/admin/mode", {
    mode,
    retry_after_s: 1,
  });
}

/** Wrangler reads the receiver's configuration from the receiver directory. */
async function wrangler(args: readonly string[]): Promise<string> {
  return command(
    "pnpm",
    ["exec", "wrangler", ...args, "--config", RECEIVER_CONFIG],
    { cwd: ROOT, timeoutMs: 300 * SECOND },
  );
}

/** Deploys the receiver and returns its workers.dev address. */
async function deployReceiver(): Promise<string> {
  const match = RECEIVER_URL.exec(await wrangler(["deploy"]));
  if (match === null) throw new HarnessError("receiver_url_missing");
  return match[0];
}

/** Sets Worker secrets from a JSON file that exists only for the call, in a 0700 directory. */
async function setSecrets(values: Record<string, string>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-t3-"));
  try {
    const file = join(directory, "secrets.json");
    await writeFile(file, JSON.stringify(values), { mode: 0o600 });
    await wrangler(["secret", "bulk", file]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function databaseState(
  caller: Caller,
  database: string,
): Promise<string> {
  const response = await send(caller, "GET", `/v1/databases/${database}`);
  if (response.status === 404) return "gone";
  if (!response.ok) throw new HarnessError(`GET_${response.status}`);
  return string(record(await response.json()).observed_state);
}

function insert(id: number, total: number, secret: string): string {
  return `INSERT INTO orders (id, total, secret) VALUES (${id}, ${total}, '${secret}')`;
}

async function main(): Promise<number> {
  const base = environment("PGCF_API_URL");
  const admin: Caller = { base, key: environment("PGCF_ADMIN_API_KEY") };
  const regionId = environment("PGCF_REGION_ID");
  const sizeClassId = environment("PGCF_SIZE_CLASS_ID");
  const readToken = randomBytes(32).toString("base64url");
  const stamp = Date.now().toString(36);
  const passed: boolean[] = [];
  const report = (
    step: string,
    pass: boolean,
    numbers: Record<string, number | null> = {},
  ) => {
    passed.push(pass);
    console.log(JSON.stringify({ step, pass, ...numbers }));
  };
  // Each undo runs in reverse order of creation, even after a failed step.
  const undo: [string, () => Promise<void>][] = [];

  try {
    const project = string(
      record(
        await callJson(admin, "POST", "/v1/projects", {
          name: `pgcf-t3-${stamp}`,
        }),
      ).id,
    );
    undo.push([
      "project",
      async () => {
        await callJson(admin, "DELETE", `/v1/projects/${project}`);
        if (!(await expectStatus(admin, `/v1/projects/${project}`, 404)))
          throw new HarnessError("project_not_gone");
      },
    ]);

    const keyBody = record(
      await callJson(admin, "POST", "/v1/api-keys", {
        scope: "integrator",
        project_id: project,
        name: `t3-${stamp}`,
      }),
    );
    const keyId = string(record(keyBody.api_key).id);
    const integrator: Caller = { base, key: string(keyBody.key) };
    undo.push([
      "integrator key",
      async () => {
        await callJson(admin, "DELETE", `/v1/api-keys/${keyId}`);
        // A revoked key answers 401 on any route.
        if (
          (await send(integrator, "GET", `/v1/projects/${project}`)).status !==
          401
        )
          throw new HarnessError("integrator_key_not_revoked");
      },
    ]);

    // Registered before the deploy, so a deploy that succeeds but whose output is not parsed is
    // still deleted.
    const deployed: { url?: string } = {};
    undo.push([
      "receiver",
      async () => {
        await wrangler(["delete", "--force"]);
        const url = deployed.url;
        if (url === undefined) throw new HarnessError("receiver_url_unknown");
        await until("receiver_gone", 120 * SECOND, async () => {
          const response = await http(new URL("/admin/receipts", url), "GET", {
            Authorization: `Bearer ${readToken}`,
          });
          return response.status === 200 ? undefined : true;
        });
      },
    ]);
    const receiverUrl = await deployReceiver();
    deployed.url = receiverUrl;
    const receiver: Receiver = { url: receiverUrl, token: readToken };
    await setSecrets({ READ_TOKEN: readToken });

    const created = Date.now();
    const databaseBody = record(
      await callJson(integrator, "POST", "/v1/databases", {
        project_id: project,
        region_id: regionId,
        name: `t3-${stamp}`,
        size_class_id: sizeClassId,
      }),
    );
    const database = string(record(databaseBody.database).id);
    undo.push([
      "database",
      async () => {
        await callJson(integrator, "DELETE", `/v1/databases/${database}`);
        await until("database_deleted", 600 * SECOND, async () => {
          const state = await databaseState(integrator, database);
          return state === "deleted" || state === "gone" ? true : undefined;
        });
      },
    ]);
    await until("database_ready", 600 * SECOND, async () =>
      (await databaseState(integrator, database)) === "ready"
        ? true
        : undefined,
    );
    report("database becomes ready", true, {
      create_to_ready_ms: Date.now() - created,
    });

    const uri = string(
      record(
        await callJson(
          integrator,
          "GET",
          `/v1/databases/${database}/roles/app/connection-uri`,
        ),
      ).uri,
    );
    const schemaStatus = await transaction(uri, [
      "CREATE TABLE orders (id integer PRIMARY KEY, total integer NOT NULL, secret text)",
      "CREATE TRIGGER orders_capture AFTER INSERT OR UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'total')",
    ]);
    report("table with the capture trigger is created", schemaStatus === 200);

    const subscription = record(
      await callJson(integrator, "POST", "/v1/webhooks", {
        url: `${receiverUrl}/hook`,
        event_types: ["data.orders"],
        database_ids: [database],
      }),
    );
    const webhookId = string(subscription.id);
    undo.push([
      "subscription",
      async () => {
        await callJson(integrator, "DELETE", `/v1/webhooks/${webhookId}`);
        if (!(await expectStatus(integrator, `/v1/webhooks/${webhookId}`, 404)))
          throw new HarnessError("subscription_not_gone");
      },
    ]);
    await setSecrets({ WEBHOOK_SECRET: string(subscription.secret) });

    // commit: one committed INSERT gives one verified delivery.
    const committedA = Date.now();
    await transaction(uri, [insert(1, 10, "a")]);
    await until("first_receipt", 120 * SECOND, async () => {
      const list = await receipts(receiver);
      return list.length > 0 ? true : undefined;
    });
    await sleep(3 * SECOND);
    const afterCommit = await receipts(receiver);
    const [only] = afterCommit;
    report(
      "commit gives one verified delivery",
      afterCommit.length === 1 &&
        only !== undefined &&
        only.verified &&
        only.attempt === 1,
      {
        commit_to_receipt_ms:
          only === undefined ? null : only.received_at - committedA,
      },
    );

    // rollback: an error after the INSERT rolls the transaction back, outbox row included.
    const rolledBackStatus = await transaction(uri, [
      insert(2, 20, "b"),
      "SELECT 1/0",
    ]);
    await sleep(5 * SECOND);
    const afterRollback = await receipts(receiver);
    report(
      "rollback gives no delivery",
      rolledBackStatus === 400 && afterRollback.length === afterCommit.length,
    );

    // outage: the receiver answers 503 with Retry-After while five commits happen.
    await setMode(receiver, "503");
    const commitTimes = [committedA];
    for (const id of [3, 4, 5, 6, 7]) {
      commitTimes.push(Date.now());
      await transaction(uri, [insert(id, id * 10, "c")]);
    }
    // Every outage event is refused at least once before the receiver recovers.
    await until("outage_refused", 120 * SECOND, async () => {
      const refused = new Set(
        (await receipts(receiver))
          .filter((receipt) => receipt.status === 503)
          .map((receipt) => receipt.event_id),
      );
      return refused.size >= commitTimes.length - 1 ? true : undefined;
    });
    await setMode(receiver, "ok");
    const delivered = await until("deliveries", 300 * SECOND, async () => {
      const done = (await deliveries(integrator, database)).filter(
        (delivery) => delivery.state === "delivered",
      );
      return done.length === commitTimes.length ? done : undefined;
    });
    const received = await receipts(receiver);
    // Only accepted (2xx) deliveries count for order, multiplicity and latency, in arrival order.
    const accepted = received.filter(
      (receipt) => receipt.status >= 200 && receipt.status < 300,
    );
    const acceptedIds = accepted.map((receipt) => receipt.event_id);
    const positions = accepted.flatMap((receipt) => {
      const parsed = parseDataEventId(receipt.event_id);
      return parsed === null ? [] : [parsed];
    });
    const outageIds = [...new Set(acceptedIds)].filter(
      (id) => !afterCommit.some((receipt) => receipt.event_id === id),
    );
    const retried =
      outageIds.length === commitTimes.length - 1 &&
      outageIds.every((id) =>
        received.some(
          (receipt) => receipt.event_id === id && receipt.status === 503,
        ),
      );
    // Commits are serial, so the k-th commit is the k-th event in (epoch, seq) order.
    const inOrder = [...accepted].sort(
      (a, b) =>
        (parseDataEventId(a.event_id)?.seq ?? 0) -
        (parseDataEventId(b.event_id)?.seq ?? 0),
    );
    const summary = latencySummary(
      inOrder.map(
        (receipt, index) => receipt.received_at - commitTimes[index]!,
      ),
    );
    report(
      "outage: every event is accepted once, verified, strictly ordered by (epoch, seq) and retried",
      sameEventIds(
        acceptedIds,
        delivered.map((delivery) => delivery.event_id),
      ) &&
        positions.length === accepted.length &&
        // Once the receiver orders them by id, each event is there exactly once and the order is strict.
        isInSeqOrder(
          [...positions].sort((a, b) => a.epoch - b.epoch || a.seq - b.seq),
        ) &&
        received.every((receipt) => receipt.verified) &&
        retried,
      {
        events: summary.n,
        commit_to_receipt_p50_ms: summary.p50,
        commit_to_receipt_p95_ms: summary.p95,
        arrival_inversions: arrivalInversions(positions),
      },
    );
  } finally {
    for (const [name, step] of undo.reverse()) {
      try {
        await step();
        report(`cleanup ${name}`, true);
      } catch {
        report(`cleanup ${name}`, false);
      }
    }
  }
  return passed.length > 0 && passed.every(Boolean) ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    // Step names and status codes only: a message may carry a URL or a body.
    console.error(
      JSON.stringify({
        error: error instanceof HarnessError ? error.code : "unexpected",
      }),
    );
    process.exitCode = 2;
  }
}
