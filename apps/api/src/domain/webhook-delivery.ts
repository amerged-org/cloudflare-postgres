// SPDX-License-Identifier: Apache-2.0
import {
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEnvelope,
} from "@pgcf/contracts/webhooks";
import { sealer } from "../crypto/keyring.ts";
import type { Env } from "../env.ts";
import { checkWebhookUrl } from "./webhook-url.ts";
import {
  parseRetryAfter,
  WEBHOOK_ATTEMPT_TIMEOUT_MS,
} from "./webhook-retry.ts";
import { signWebhook } from "./webhook-signing.ts";

export const WEBHOOK_USER_AGENT = "PGCF-Webhooks/1";

/** The context a subscription's sealed secret and headers are bound to. */
export const secretSealContext = (webhookId: string) => `${webhookId}|secret`;
export const headersSealContext = (webhookId: string) => `${webhookId}|headers`;

export interface SubscriptionSecrets {
  readonly id: string;
  readonly projectId: string;
  readonly url: string;
  readonly secret: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface SubscriptionRow {
  id: string;
  project_id: string;
  url: string;
  secret_ciphertext: string;
  secret_iv: string;
  secret_kid: string;
  headers_ciphertext: string | null;
  headers_iv: string | null;
  headers_kid: string | null;
  deleted_at: string | null;
}

/** The subscription with its secret and headers opened, or null when it is gone. */
export async function loadSubscription(
  env: Env,
  webhookId: string,
): Promise<SubscriptionSecrets | null> {
  const row = await env.DB.prepare(
    `SELECT id, project_id, url, secret_ciphertext, secret_iv, secret_kid,
            headers_ciphertext, headers_iv, headers_kid, deleted_at
     FROM webhook_subscriptions WHERE id = ?`,
  )
    .bind(webhookId)
    .first<SubscriptionRow>();
  if (!row || row.deleted_at !== null) return null;
  const seal = sealer(env.CREDENTIAL_KEYS);
  const secret = await seal.open(secretSealContext(row.id), {
    ciphertext: row.secret_ciphertext,
    iv: row.secret_iv,
    kid: row.secret_kid,
  });
  const headers =
    row.headers_ciphertext && row.headers_iv && row.headers_kid
      ? (JSON.parse(
          await seal.open(headersSealContext(row.id), {
            ciphertext: row.headers_ciphertext,
            iv: row.headers_iv,
            kid: row.headers_kid,
          }),
        ) as Record<string, string>)
      : {};
  return {
    id: row.id,
    projectId: row.project_id,
    url: row.url,
    secret,
    headers,
  };
}

export type AttemptResult =
  | { kind: "delivered"; status: number }
  | {
      kind: "failed";
      status: number | null;
      error: "timeout" | "network" | "http";
      retryAfterSeconds: number | null;
    }
  | { kind: "permanent"; status: number | null };

/**
 * One POST of one event to one subscription. It never follows a redirect, reads no response body
 * and logs neither URL, headers nor payload. The outcome of a request that timed out is unknown, so
 * the caller treats it as a failure and may deliver again: delivery is at least once.
 */
export async function postEnvelope(
  subscription: SubscriptionSecrets,
  envelope: WebhookEnvelope,
  deliveryId: string,
): Promise<AttemptResult> {
  const url = checkWebhookUrl(subscription.url);
  if (!url.ok) return { kind: "permanent", status: null };
  const body = JSON.stringify(envelope);
  const signature = await signWebhook(
    subscription.secret,
    Math.floor(Date.now() / 1000),
    body,
  );
  let response: Response;
  try {
    response = await fetch(url.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...subscription.headers,
        "Content-Type": "application/json",
        "User-Agent": WEBHOOK_USER_AGENT,
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_EVENT_ID_HEADER]: envelope.id,
        [WEBHOOK_DELIVERY_ID_HEADER]: deliveryId,
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_ATTEMPT_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      kind: "failed",
      status: null,
      error:
        name === "TimeoutError" || name === "AbortError"
          ? "timeout"
          : "network",
      retryAfterSeconds: null,
    };
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status >= 200 && response.status < 300)
    return { kind: "delivered", status: response.status };
  if (response.status >= 300 && response.status < 400)
    return { kind: "permanent", status: response.status };
  return {
    kind: "failed",
    status: response.status,
    error: "http",
    retryAfterSeconds: parseRetryAfter(
      response.headers.get("Retry-After"),
      Date.now(),
    ),
  };
}

/** One delivery of an event: the subscription is read, opened and the request is sent. */
export async function attemptDelivery(
  env: Env,
  webhookId: string,
  envelope: WebhookEnvelope,
  deliveryId: string,
): Promise<AttemptResult> {
  const subscription = await loadSubscription(env, webhookId);
  if (!subscription) return { kind: "permanent", status: null };
  return postEnvelope(subscription, envelope, deliveryId);
}
