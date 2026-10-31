// SPDX-License-Identifier: Apache-2.0
import { bytesToHex } from "@pgcf/contracts";
import type { WebhookEventType } from "@pgcf/contracts/webhooks";
import type { Env } from "../env.ts";
import type { IngestedEvent } from "../trigger-actor.ts";
import { subscriptionWants } from "./event-match.ts";

const LIFECYCLE_BATCH = 200;
const OPERATION_BATCH = 200;
const MAX_BATCHES_PER_RUN = 10;
const INGEST_CONCURRENCY = 10;
const OPERATION_LAG_MS = 30_000;

const LIFECYCLE_TYPES: Readonly<Record<string, WebhookEventType>> = {
  created: "database.created",
  ready: "database.ready",
  woke: "database.woke",
  hibernated: "database.slept",
  resized: "database.resized",
  suspended: "database.suspended",
  deleted: "database.deleted",
};

/** The operations PGCF starts for itself are not events of the integrator's own requests. */
const INTERNAL_OPERATION_KINDS = ["database.hibernate", "database.wake"];

type Subscription = {
  id: string;
  event_types: string[];
  database_ids: string[] | null;
};

/**
 * A stable identifier derived from the source row, so that the same lifecycle row or operation
 * is the same event however often the producer reads it.
 */
export async function derivedId(
  prefix: "evt" | "dlv",
  key: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return `${prefix}_${bytesToHex(new Uint8Array(digest)).slice(0, 20)}`;
}

export interface WebhookEventsResult {
  lifecycle: number;
  operations: number;
  delivered_to_actors: number;
}

type Candidate = {
  /** The cursor value that is reached once this and every earlier candidate are handled. */
  cursor: string;
  key: string;
  /** Null for a lifecycle kind this release does not name: passed over without an event. */
  type: WebhookEventType | null;
  occurred_at: string;
  project_id: string;
  database_id: string;
  data: Record<string, unknown>;
};

/**
 * Turns the lifecycle log and the finished operations into webhook events. It keeps its place in
 * `webhook_cursors` and moves it only past events that a database's actor has stored, so a
 * failed hand-over is read again by the next minute; the actor ignores an event it already has.
 */
export async function runWebhookEvents(env: Env): Promise<WebhookEventsResult> {
  const result: WebhookEventsResult = {
    lifecycle: 0,
    operations: 0,
    delivered_to_actors: 0,
  };
  const subscriptions = new Map<string, Subscription[]>();
  const forProject = async (projectId: string): Promise<Subscription[]> => {
    const cached = subscriptions.get(projectId);
    if (cached) return cached;
    const rows = await env.DB.prepare(
      `SELECT id, event_types, database_ids FROM webhook_subscriptions
       WHERE project_id = ? AND deleted_at IS NULL`,
    )
      .bind(projectId)
      .all<{ id: string; event_types: string; database_ids: string | null }>();
    const loaded = rows.results.map((row) => ({
      id: row.id,
      event_types: JSON.parse(row.event_types) as string[],
      database_ids: row.database_ids
        ? (JSON.parse(row.database_ids) as string[])
        : null,
    }));
    subscriptions.set(projectId, loaded);
    return loaded;
  };

  for (const source of ["lifecycle", "operations"] as const) {
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const cursor = await env.DB.prepare(
        "SELECT cursor FROM webhook_cursors WHERE name = ?",
      )
        .bind(source)
        .first<{ cursor: string }>();
      if (!cursor) throw new Error("webhook_cursor_missing");
      const candidates =
        source === "lifecycle"
          ? await lifecycleCandidates(env, cursor.cursor)
          : await operationCandidates(env, cursor.cursor);
      if (candidates.length === 0) break;
      const reached = await handOver(env, candidates, forProject, result);
      if (reached !== null)
        await env.DB.prepare(
          "UPDATE webhook_cursors SET cursor = ? WHERE name = ?",
        )
          .bind(reached, source)
          .run();
      if (reached !== candidates.at(-1)?.cursor) break;
      if (
        candidates.length <
        (source === "lifecycle" ? LIFECYCLE_BATCH : OPERATION_BATCH)
      )
        break;
    }
  }
  return result;
}

async function lifecycleCandidates(
  env: Env,
  after: string,
): Promise<Candidate[]> {
  const rows = await env.DB.prepare(
    `SELECT le.id, le.database_id, le.kind, le.generation, le.size_class_id, le.occurred_at, d.project_id
     FROM lifecycle_events le JOIN databases d ON d.id = le.database_id
     WHERE le.id > ? ORDER BY le.id LIMIT ?`,
  )
    .bind(Number(after), LIFECYCLE_BATCH)
    .all<{
      id: number;
      database_id: string;
      kind: string;
      generation: number;
      size_class_id: string;
      occurred_at: string;
      project_id: string;
    }>();
  return rows.results.map((row) => ({
    cursor: String(row.id),
    key: `lifecycle|${row.id}`,
    type: LIFECYCLE_TYPES[row.kind] ?? null,
    occurred_at: row.occurred_at,
    project_id: row.project_id,
    database_id: row.database_id,
    data: { generation: row.generation, size_class_id: row.size_class_id },
  }));
}

async function operationCandidates(
  env: Env,
  after: string,
): Promise<Candidate[]> {
  const separator = after.lastIndexOf("|");
  const completedAfter = after.slice(0, separator);
  const idAfter = after.slice(separator + 1);
  const rows = await env.DB.prepare(
    `SELECT id, kind, status, project_id, database_id, generation, error_code, completed_at
     FROM operations
     WHERE completed_at IS NOT NULL AND status IN('succeeded','failed') AND database_id IS NOT NULL
       AND kind NOT IN(SELECT value FROM json_each(?))
       AND (completed_at, id) > (?, ?) AND completed_at <= ?
     ORDER BY completed_at, id LIMIT ?`,
  )
    .bind(
      JSON.stringify(INTERNAL_OPERATION_KINDS),
      completedAfter,
      idAfter,
      // A row is stamped by the Worker that finished it and committed a moment later; reading only
      // what is older than the lag keeps one that commits late from falling behind the cursor.
      new Date(Date.now() - OPERATION_LAG_MS).toISOString(),
      OPERATION_BATCH,
    )
    .all<{
      id: string;
      kind: string;
      status: "succeeded" | "failed";
      project_id: string;
      database_id: string;
      generation: number;
      error_code: string | null;
      completed_at: string;
    }>();
  return rows.results.map((row) => ({
    cursor: `${row.completed_at}|${row.id}`,
    key: `operation|${row.id}|${row.status}`,
    type:
      row.status === "succeeded" ? "operation.succeeded" : "operation.failed",
    occurred_at: row.completed_at,
    project_id: row.project_id,
    database_id: row.database_id,
    data: {
      operation_id: row.id,
      kind: row.kind,
      generation: row.generation,
      error_code: row.error_code,
    },
  }));
}

/**
 * Hands the candidates to their actors in order, a few at a time, and returns the cursor of the
 * last candidate before the first failure (the last one when none failed), or null when the first
 * one failed.
 */
async function handOver(
  env: Env,
  candidates: readonly Candidate[],
  forProject: (projectId: string) => Promise<Subscription[]>,
  result: WebhookEventsResult,
): Promise<string | null> {
  let reached: string | null = null;
  for (let i = 0; i < candidates.length; i += INGEST_CONCURRENCY) {
    const chunk = candidates.slice(i, i + INGEST_CONCURRENCY);
    const outcomes = await Promise.allSettled(
      chunk.map(async (candidate) => {
        const type = candidate.type;
        if (type === null) return 0;
        const wanting = (await forProject(candidate.project_id)).filter(
          (subscription) =>
            subscriptionWants(subscription, {
              type,
              database_id: candidate.database_id,
            }),
        );
        if (wanting.length === 0) return 0;
        const eventId = await derivedId("evt", candidate.key);
        const event: IngestedEvent = {
          id: eventId,
          type,
          occurred_at: candidate.occurred_at,
          project_id: candidate.project_id,
          database_id: candidate.database_id,
          data: candidate.data,
        };
        const deliveryIds = await Promise.all(
          wanting.map((subscription) =>
            derivedId("dlv", `${eventId}|${subscription.id}`),
          ),
        );
        const actor = env.TRIGGER_ACTOR.get(
          env.TRIGGER_ACTOR.idFromName(candidate.database_id),
        );
        await actor.ingest(
          event,
          wanting.map((subscription) => subscription.id),
          deliveryIds,
        );
        return wanting.length;
      }),
    );
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "rejected") {
        // The cursor stays before this event, so the next minute reads it again.
        console.error(
          JSON.stringify({
            event: "webhook_event_handover_failed",
            type: chunk[index]?.type ?? null,
            error_class:
              outcome.reason instanceof Error ? outcome.reason.name : "unknown",
          }),
        );
        return reached;
      }
      const candidate = chunk[index]!;
      reached = candidate.cursor;
      if (outcome.value > 0) {
        result.delivered_to_actors += outcome.value;
        if (candidate.key.startsWith("lifecycle")) result.lifecycle += 1;
        else result.operations += 1;
      }
    }
  }
  return reached;
}
