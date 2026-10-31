// SPDX-License-Identifier: Apache-2.0
import {
  decodeCursor,
  encodeCursor,
  isAdminScope,
  type Cursor,
} from "@pgcf/contracts";
import {
  newWebhookId,
  WEBHOOK_MAX_SUBSCRIPTIONS_PER_PROJECT,
  type Webhook,
  type WebhookCreate,
  type WebhookCreated,
  type WebhookDelivery,
  type WebhookListQuery,
  type WebhookTestResult,
} from "@pgcf/contracts/webhooks";
import { ApiError } from "../api-error.ts";
import { sealer } from "../crypto/keyring.ts";
import type { ApiContext } from "../env.ts";
import { assertProjectAccess, getAuth } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { page } from "../platform/pagination.ts";
import type { StoredDelivery } from "../trigger-actor.ts";
import { databaseForRequest } from "./rows.ts";
import {
  headersSealContext,
  loadSubscription,
  postEnvelope,
  secretSealContext,
} from "./webhook-delivery.ts";
import { derivedId } from "./webhook-events.ts";
import { checkWebhookUrl } from "./webhook-url.ts";
import { newWebhookSecret } from "./webhook-signing.ts";

const WEBHOOK_TEST_INTERVAL_MS = 5_000;

type WebhookRow = {
  id: string;
  project_id: string;
  url: string;
  event_types: string;
  database_ids: string | null;
  header_names: string;
  created_at: string;
};

const WEBHOOK_COLUMNS =
  "id, project_id, url, event_types, database_ids, header_names, created_at";

function webhookView(row: WebhookRow): Webhook {
  return {
    id: row.id,
    project_id: row.project_id,
    url: row.url,
    event_types: JSON.parse(row.event_types) as string[],
    database_ids: row.database_ids
      ? (JSON.parse(row.database_ids) as string[])
      : null,
    header_names: JSON.parse(row.header_names) as string[],
    created_at: row.created_at,
  };
}

/** The subscription as the caller may see it: a foreign or deleted one does not exist. */
async function webhookForRequest(
  c: ApiContext,
  id: string,
): Promise<WebhookRow> {
  await getAuth(c);
  const row = await c.env.DB.prepare(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhook_subscriptions WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<WebhookRow>();
  if (!row) throw new ApiError("not_found", "Webhook not found");
  await assertProjectAccess(c, row.project_id);
  return row;
}

async function projectForCreate(
  c: ApiContext,
  requested: string | undefined,
): Promise<string> {
  const auth = await getAuth(c);
  const projectId = isAdminScope(auth.scope) ? requested : auth.project_id;
  if (!projectId)
    throw new ApiError(
      "invalid_request",
      "An administrator key names the project in project_id",
    );
  if (requested !== undefined && requested !== projectId)
    throw new ApiError("not_found", "Project not found");
  const project = await c.env.DB.prepare(
    "SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(projectId)
    .first();
  if (!project) throw new ApiError("not_found", "Project not found");
  return projectId;
}

export async function createWebhook(
  c: ApiContext,
  body: WebhookCreate,
): Promise<Response> {
  const projectId = await projectForCreate(c, body.project_id);
  const url = checkWebhookUrl(body.url);
  if (!url.ok)
    throw new ApiError("invalid_request", `Webhook URL refused: ${url.reason}`);
  if (body.database_ids) {
    const found = await c.env.DB.prepare(
      `SELECT count(*) AS n FROM databases
       WHERE project_id = ? AND deleted_at IS NULL AND id IN(SELECT value FROM json_each(?))`,
    )
      .bind(projectId, JSON.stringify(body.database_ids))
      .first<{ n: number }>();
    if (found?.n !== new Set(body.database_ids).size)
      throw new ApiError(
        "invalid_request",
        "database_ids names a database that is not in the project",
      );
  }
  const replay = async (id: string, status: number): Promise<Response> => {
    const row = await webhookForRequest(c, id);
    const subscription = await loadSubscription(c.env, id);
    if (!subscription) throw new ApiError("not_found", "Webhook not found");
    c.header("Location", `/v1/webhooks/${id}`);
    return c.json(
      {
        ...webhookView(row),
        secret: subscription.secret,
      } satisfies WebhookCreated,
      status as 201,
    );
  };
  return withIdempotency(c, {
    replay,
    execute: async (lease) => {
      const id = newWebhookId();
      const seal = sealer(c.env.CREDENTIAL_KEYS);
      const secret = await seal.seal(secretSealContext(id), newWebhookSecret());
      const headers = body.headers
        ? await seal.seal(headersSealContext(id), JSON.stringify(body.headers))
        : null;
      const now = new Date().toISOString();
      const inserted = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO webhook_subscriptions(id, project_id, url, event_types, database_ids,
             secret_ciphertext, secret_iv, secret_kid, headers_ciphertext, headers_iv, headers_kid,
             header_names, created_at)
           SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${lease.guard.sql}
             AND (SELECT count(*) FROM webhook_subscriptions
                  WHERE project_id = ? AND deleted_at IS NULL) < ?`,
        ).bind(
          id,
          projectId,
          url.url.toString(),
          JSON.stringify(body.event_types),
          body.database_ids ? JSON.stringify(body.database_ids) : null,
          secret.ciphertext,
          secret.iv,
          secret.kid,
          headers?.ciphertext ?? null,
          headers?.iv ?? null,
          headers?.kid ?? null,
          JSON.stringify(Object.keys(body.headers ?? {})),
          now,
          ...lease.guard.bindings,
          projectId,
          WEBHOOK_MAX_SUBSCRIPTIONS_PER_PROJECT,
        ),
        // The key completes only for a webhook that exists.
        lease.completeStatement(id, 201, {
          sql: "EXISTS(SELECT 1 FROM webhook_subscriptions WHERE id = ?)",
          bindings: [id],
        }),
      ]);
      if (inserted[0]?.meta.changes !== 1) {
        // The limit is part of the insert, so concurrent creates cannot pass it together.
        const live = await c.env.DB.prepare(
          "SELECT count(*) AS n FROM webhook_subscriptions WHERE project_id = ? AND deleted_at IS NULL",
        )
          .bind(projectId)
          .first<{ n: number }>();
        if ((live?.n ?? 0) >= WEBHOOK_MAX_SUBSCRIPTIONS_PER_PROJECT)
          throw new ApiError(
            "conflict",
            `A project holds at most ${WEBHOOK_MAX_SUBSCRIPTIONS_PER_PROJECT} webhooks`,
          );
        throw new ApiError("idempotency_in_progress", "Retry the request");
      }
      return replay(id, 201);
    },
  });
}

export async function listWebhooks(
  c: ApiContext,
  query: WebhookListQuery,
): Promise<Response> {
  const auth = await getAuth(c);
  const projectId = isAdminScope(auth.scope)
    ? (query.project_id ?? null)
    : auth.project_id;
  if (!isAdminScope(auth.scope) && query.project_id !== undefined)
    await assertProjectAccess(c, query.project_id);
  const paging = page(c, { limit: query.limit, cursor: query.cursor });
  const where = paging.where("created_at", "id");
  const rows = await c.env.DB.prepare(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhook_subscriptions
     WHERE deleted_at IS NULL AND (? IS NULL OR project_id = ?) AND ${where.sql}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(projectId, projectId, ...where.bindings, paging.limit + 1)
    .all<WebhookRow>();
  return c.json(paging.envelope(rows.results.map(webhookView)), 200);
}

export async function getWebhook(c: ApiContext, id: string): Promise<Response> {
  return c.json(webhookView(await webhookForRequest(c, id)), 200);
}

export async function deleteWebhook(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await webhookForRequest(c, id);
  await c.env.DB.prepare(
    "UPDATE webhook_subscriptions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(new Date().toISOString(), id)
    .run();
  return c.body(null, 204);
}

/** One delivery of a sample event, once, now: the answer is the receiver's, and nothing is stored. */
export async function testWebhook(
  c: ApiContext,
  id: string,
): Promise<Response> {
  const row = await webhookForRequest(c, id);
  const now = new Date();
  // A test sends a real request to a third party: one every five seconds per webhook.
  const claimed = await c.env.DB.prepare(
    `UPDATE webhook_subscriptions SET last_tested_at = ?
     WHERE id = ? AND deleted_at IS NULL AND (last_tested_at IS NULL OR last_tested_at < ?)`,
  )
    .bind(
      now.toISOString(),
      id,
      new Date(now.getTime() - WEBHOOK_TEST_INTERVAL_MS).toISOString(),
    )
    .run();
  if (claimed.meta.changes !== 1)
    throw new ApiError("rate_limited", "Wait a few seconds between tests");
  const subscription = await loadSubscription(c.env, id);
  if (!subscription) throw new ApiError("not_found", "Webhook not found");
  const eventId = await derivedId(
    "evt",
    `test|${id}|${now.getTime()}|${crypto.randomUUID()}`,
  );
  const started = Date.now();
  const result = await postEnvelope(
    subscription,
    {
      id: eventId,
      type: "webhook.test",
      occurred_at: now.toISOString(),
      project_id: row.project_id,
      database_id: null,
      data: { message: "A test event from PGCF" },
    },
    await derivedId("dlv", `${eventId}|${id}`),
  );
  const view: WebhookTestResult =
    result.kind === "delivered"
      ? {
          delivered: true,
          status: result.status,
          error: null,
          duration_ms: Date.now() - started,
        }
      : {
          delivered: false,
          status: result.status,
          error:
            result.kind === "failed"
              ? result.error
              : result.status === null
                ? "network"
                : "http",
          duration_ms: Date.now() - started,
        };
  return c.json(view, 200);
}

function deliveryView(row: StoredDelivery): WebhookDelivery {
  return {
    id: row.id,
    event_id: row.event_id,
    event_type: row.event_type,
    webhook_id: row.webhook_id,
    state: row.state,
    attempts: row.attempts,
    created_at: new Date(row.created_ms).toISOString(),
    next_attempt_at:
      row.next_attempt_ms === null
        ? null
        : new Date(row.next_attempt_ms).toISOString(),
    delivered_at:
      row.delivered_ms === null
        ? null
        : new Date(row.delivered_ms).toISOString(),
    last_status: row.last_status,
    last_error: row.last_error as WebhookDelivery["last_error"],
  } as WebhookDelivery;
}

function triggerActor(c: ApiContext, databaseId: string) {
  return c.env.TRIGGER_ACTOR.get(c.env.TRIGGER_ACTOR.idFromName(databaseId));
}

export async function listDatabaseDeliveries(
  c: ApiContext,
  databaseId: string,
  query: { limit: number; cursor?: string | undefined },
): Promise<Response> {
  await databaseForRequest(c, databaseId, true);
  const cursor: Cursor | null =
    query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null)
    throw new ApiError("invalid_request", "Invalid pagination cursor");
  const { rows, more } = await triggerActor(c, databaseId).list(
    query.limit,
    cursor === null
      ? null
      : { created_ms: Date.parse(cursor.created_at), id: cursor.id },
  );
  const last = rows.at(-1);
  return c.json(
    {
      data: rows.map(deliveryView),
      next_cursor:
        more && last
          ? encodeCursor({
              created_at: new Date(last.created_ms).toISOString(),
              id: last.id,
            })
          : null,
    },
    200,
  );
}

export async function replayDelivery(
  c: ApiContext,
  databaseId: string,
  deliveryId: string,
): Promise<Response> {
  await databaseForRequest(c, databaseId, true);
  const outcome = await triggerActor(c, databaseId).replay(deliveryId);
  if (outcome === "not_found")
    throw new ApiError("not_found", "Delivery not found");
  if (outcome === "not_replayable")
    throw new ApiError("conflict", "The delivery is still being retried");
  return c.json({ delivery_id: deliveryId, state: "pending" }, 202);
}
