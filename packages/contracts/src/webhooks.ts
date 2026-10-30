// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { HttpsUrl, ListQuery, Timestamp } from "./api.ts";
import { DatabaseId, ID_PREFIXES, newId, ProjectId } from "./ids.ts";

export const WEBHOOK_ID_PATTERN = /^whk_[a-z0-9]{20}$/;
export const EVENT_ID_PATTERN = /^evt_[0-9a-f]{20}$/;
export const DELIVERY_ID_PATTERN = /^dlv_[0-9a-f]{20}$/;
export const WebhookId = z
  .string()
  .regex(WEBHOOK_ID_PATTERN)
  .meta({ id: "WebhookId" });
export type WebhookId = z.infer<typeof WebhookId>;
export const EventId = z
  .string()
  .regex(EVENT_ID_PATTERN)
  .meta({ id: "EventId" });
export type EventId = z.infer<typeof EventId>;
export const DeliveryId = z
  .string()
  .regex(DELIVERY_ID_PATTERN)
  .meta({ id: "DeliveryId" });
export type DeliveryId = z.infer<typeof DeliveryId>;
export const newWebhookId = (): WebhookId => newId(ID_PREFIXES.webhook);

export const WEBHOOK_EVENT_TYPES = [
  "database.created",
  "database.ready",
  "database.woke",
  "database.slept",
  "database.suspended",
  "database.resized",
  "database.deleted",
  "operation.succeeded",
  "operation.failed",
  "webhook.test",
] as const;
export const WebhookEventType = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

export const WEBHOOK_MAX_SUBSCRIPTIONS_PER_PROJECT = 20;
export const WEBHOOK_MAX_HEADERS = 8;

/** `*`, `<group>.*` or one exact `<group>.<name>`. */
export const EVENT_PATTERN = /^(\*|[a-z][a-z_]*\.(\*|[a-z][a-z_]*))$/;
const EventPattern = z.string().max(64).regex(EVENT_PATTERN);

// Names the service sets itself, or that would change how the request is framed.
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "user-agent",
  "te",
  "upgrade",
  "expect",
]);
const HeaderName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
  .refine((name) => {
    const lower = name.toLowerCase();
    return (
      !FORBIDDEN_HEADERS.has(lower) &&
      !lower.startsWith("pgcf-") &&
      !lower.startsWith("cf-") &&
      !lower.startsWith("x-forwarded-")
    );
  }, "reserved header name");
const HeaderValue = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/);
export const WebhookHeaders = z
  .record(HeaderName, HeaderValue)
  .refine(
    (headers) => Object.keys(headers).length <= WEBHOOK_MAX_HEADERS,
    "too many headers",
  )
  .refine(
    (headers) =>
      new Set(Object.keys(headers).map((name) => name.toLowerCase())).size ===
      Object.keys(headers).length,
    "duplicate header",
  );

export const WebhookCreate = z
  .strictObject({
    project_id: ProjectId.optional(),
    url: HttpsUrl,
    event_types: z.array(EventPattern).min(1).max(16),
    database_ids: z.array(DatabaseId).min(1).max(100).optional(),
    headers: WebhookHeaders.optional(),
  })
  .meta({ id: "WebhookCreate" });
export type WebhookCreate = z.infer<typeof WebhookCreate>;

export const Webhook = z
  .strictObject({
    id: WebhookId,
    project_id: ProjectId,
    url: HttpsUrl,
    event_types: z.array(EventPattern),
    database_ids: z.array(DatabaseId).nullable(),
    header_names: z.array(z.string()),
    created_at: Timestamp,
  })
  .meta({ id: "Webhook" });
export type Webhook = z.infer<typeof Webhook>;

/** The creation answer is the only place that shows the signing secret. */
export const WebhookCreated = Webhook.extend({
  secret: z.string(),
}).meta({ id: "WebhookCreated" });
export type WebhookCreated = z.infer<typeof WebhookCreated>;

export const WebhookListQuery = ListQuery.extend({
  project_id: ProjectId.optional(),
});
export type WebhookListQuery = z.infer<typeof WebhookListQuery>;

/** The JSON body of every delivery. */
export const WebhookEnvelope = z
  .strictObject({
    id: EventId,
    type: WebhookEventType,
    occurred_at: Timestamp,
    project_id: ProjectId,
    database_id: DatabaseId.nullable(),
    data: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "WebhookEnvelope" });
export type WebhookEnvelope = z.infer<typeof WebhookEnvelope>;

export const WEBHOOK_DELIVERY_STATES = [
  "pending",
  "delivered",
  "dead_lettered",
] as const;
export const WebhookDelivery = z
  .strictObject({
    id: DeliveryId,
    event_id: EventId,
    event_type: WebhookEventType,
    webhook_id: WebhookId,
    state: z.enum(WEBHOOK_DELIVERY_STATES),
    attempts: z.number().int().nonnegative(),
    created_at: Timestamp,
    next_attempt_at: Timestamp.nullable(),
    delivered_at: Timestamp.nullable(),
    last_status: z.number().int().nullable(),
    last_error: z
      .enum(["timeout", "network", "http", "expired", "permanent"])
      .nullable(),
  })
  .meta({ id: "WebhookDelivery" });
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

export const WebhookTestResult = z
  .strictObject({
    delivered: z.boolean(),
    status: z.number().int().nullable(),
    error: z.enum(["timeout", "network", "http"]).nullable(),
    duration_ms: z.number().int().nonnegative(),
  })
  .meta({ id: "WebhookTestResult" });
export type WebhookTestResult = z.infer<typeof WebhookTestResult>;

export const WebhookReplayResult = z
  .strictObject({ delivery_id: DeliveryId, state: z.literal("pending") })
  .meta({ id: "WebhookReplayResult" });
export type WebhookReplayResult = z.infer<typeof WebhookReplayResult>;

export const WEBHOOK_SIGNATURE_HEADER = "PGCF-Signature";
export const WEBHOOK_EVENT_ID_HEADER = "PGCF-Event-Id";
export const WEBHOOK_DELIVERY_ID_HEADER = "PGCF-Delivery-Id";
