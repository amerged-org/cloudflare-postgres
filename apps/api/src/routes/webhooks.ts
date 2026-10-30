// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  DatabaseId,
  ErrorBody,
  IdempotencyKey,
  ListQuery,
  listEnvelope,
} from "@pgcf/contracts";
import {
  DeliveryId,
  Webhook,
  WebhookCreate,
  WebhookCreated,
  WebhookDelivery,
  WebhookId,
  WebhookListQuery,
  WebhookReplayResult,
  WebhookTestResult,
} from "@pgcf/contracts/webhooks";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listDatabaseDeliveries,
  listWebhooks,
  replayDelivery,
  testWebhook,
} from "../domain/webhooks.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = (...codes: readonly (readonly [number, string])[]) =>
  Object.fromEntries(
    codes.map(([code, description]) => [
      code,
      { description, content: json(ErrorBody) },
    ]),
  );
const E400 = [400, "Invalid request"] as const;
const E401 = [401, "Invalid credentials"] as const;
const E404 = [404, "Resource not found"] as const;
const E409 = [409, "Conflict"] as const;
const E500 = [500, "Internal server error"] as const;
const security = [{ bearerAuth: [] }];
const tags = ["Webhooks"];
const optionalKey = z.object({ "Idempotency-Key": IdempotencyKey.optional() });

function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
): void {
  app.openapi(createRoute(route), handler);
}

export function registerWebhooks(app: ApiApp): void {
  register(
    app,
    {
      method: "post",
      path: "/v1/webhooks",
      security,
      tags,
      description:
        "Subscribes an HTTPS URL to events. `event_types` are `*`, `<group>.*` or an exact type (`database.ready`, `database.woke`, `database.slept`, `database.suspended`, `database.resized`, `database.created`, `database.deleted`, `operation.succeeded`, `operation.failed`); `database_ids` limits the subscription to those databases of the project, and omitting it covers all of them. An integrator key subscribes its own project; an administrator key names `project_id`. Each delivery is a POST of the JSON `WebhookEnvelope` with `PGCF-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of `t.body` with the secret>`, `PGCF-Event-Id` and `PGCF-Delivery-Id`; `headers` are sent in addition and are stored sealed. The answer is the only one that shows the signing `secret`. Delivery is at least once: a receiver deduplicates by event id, answers 2xx within 5 seconds, and is retried with backoff for 24 hours (a 4xx other than 408, 425 and 429 and any redirect end the retries at once), after which the delivery is dead-lettered for seven days and can be replayed. A project holds at most 20 webhooks. An Idempotency-Key is optional; a replay returns the retained webhook with its secret.",
      request: {
        headers: optionalKey,
        body: { required: true, content: json(WebhookCreate) },
      },
      responses: {
        201: { description: "Webhook created", content: json(WebhookCreated) },
        ...errors(E400, E401, [403, "Insufficient scope"], E404, E409, E500),
      },
    },
    async (c) => createWebhook(c, WebhookCreate.parse(await c.req.json())),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/webhooks",
      security,
      tags,
      description:
        "Lists the webhooks of the project (an administrator key lists all, or those of `project_id`). The signing secret is not shown.",
      request: { query: WebhookListQuery },
      responses: {
        200: {
          description: "Webhooks, newest first",
          content: json(listEnvelope(Webhook)),
        },
        ...errors(E400, E401, E500),
      },
    },
    async (c) => listWebhooks(c, WebhookListQuery.parse(c.req.query())),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/webhooks/{id}",
      security,
      tags,
      request: { params: z.object({ id: WebhookId }) },
      responses: {
        200: { description: "The webhook", content: json(Webhook) },
        ...errors(E400, E401, E404, E500),
      },
    },
    async (c) => getWebhook(c, WebhookId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "delete",
      path: "/v1/webhooks/{id}",
      security,
      tags,
      description:
        "Deletes the webhook. Deliveries that are still waiting for a retry find it gone and are dead-lettered.",
      request: { params: z.object({ id: WebhookId }) },
      responses: {
        204: { description: "Deleted" },
        ...errors(E400, E401, [403, "Insufficient scope"], E404, E409, E500),
      },
    },
    async (c) => deleteWebhook(c, WebhookId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/webhooks/{id}/test",
      security,
      tags,
      description:
        "Sends one `webhook.test` event to the URL now, once, and reports the receiver's answer. Nothing is stored or retried.",
      request: { params: z.object({ id: WebhookId }) },
      responses: {
        200: {
          description: "The receiver's answer",
          content: json(WebhookTestResult),
        },
        ...errors(E400, E401, [403, "Insufficient scope"], E404, E500),
      },
    },
    async (c) => testWebhook(c, WebhookId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/databases/{id}/webhook-deliveries",
      security,
      tags,
      description:
        "Lists the deliveries of the database's events, newest first: pending ones with their next attempt, delivered ones for 24 hours and dead-lettered ones for seven days.",
      request: {
        params: z.object({ id: DatabaseId }),
        query: ListQuery,
      },
      responses: {
        200: {
          description: "Deliveries",
          content: json(listEnvelope(WebhookDelivery)),
        },
        ...errors(E400, E401, E404, E500),
      },
    },
    async (c) =>
      listDatabaseDeliveries(
        c,
        DatabaseId.parse(c.req.param("id")),
        ListQuery.parse(c.req.query()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/databases/{id}/webhook-deliveries/{delivery_id}/replay",
      security,
      tags,
      description:
        "Delivers a delivered or dead-lettered delivery again, with a fresh 24-hour retry window.",
      request: {
        params: z.object({ id: DatabaseId, delivery_id: DeliveryId }),
      },
      responses: {
        202: {
          description: "Queued for delivery",
          content: json(WebhookReplayResult),
        },
        ...errors(
          E400,
          E401,
          [403, "Insufficient scope"],
          E404,
          [409, "The delivery is still being retried"],
          E500,
        ),
      },
    },
    async (c) =>
      replayDelivery(
        c,
        DatabaseId.parse(c.req.param("id")),
        DeliveryId.parse(c.req.param("delivery_id")),
      ),
  );
}
