// SPDX-License-Identifier: Apache-2.0
import { NodeDataEventReport } from "@pgcf/contracts";
import { dataEventId } from "@pgcf/contracts/webhooks";
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";
import type { IngestedEvent } from "../trigger-actor.ts";
import { subscriptionWants } from "./event-match.ts";
import type { NodeCaller } from "./node-auth.ts";
import { derivedId, projectSubscriptions } from "./webhook-events.ts";

type BatchItem = {
  event: IngestedEvent;
  webhookIds: string[];
  deliveryIds: string[];
};

/**
 * `POST /node/v1/data-events`: the events of one database's outbox, all or nothing. The project
 * comes from the database row this node serves, never from the body. An event no subscription of
 * the project wants is ignored, and the rest go to the database's actor in one batch, so any 2xx
 * means every event is stored or deliberately dropped.
 */
export async function nodeDataEvents(
  c: ApiContext,
  node: NodeCaller,
  raw: unknown,
): Promise<Response> {
  const parsed = NodeDataEventReport.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid data event report");
  const report = parsed.data;
  const owner = await c.env.DB.prepare(
    "SELECT project_id FROM databases WHERE id=? AND node_id=? AND deleted_at IS NULL AND desired_state<>'deleted'",
  )
    .bind(report.database, node.id)
    .first<{ project_id: string }>();
  if (!owner)
    throw new ApiError("conflict", "The database is not served by this node", {
      reason: "generation_changed",
    });
  const subscriptions = await projectSubscriptions(c.env, owner.project_id);
  const now = Date.now();
  const items: BatchItem[] = [];
  let ignored = 0;
  for (const data of report.events) {
    const type = `data.${data.topic}`;
    const wanting = subscriptions.filter((subscription) =>
      subscriptionWants(subscription, { type, database_id: report.database }),
    );
    if (wanting.length === 0) {
      ignored += 1;
      continue;
    }
    const id = dataEventId(report.database, data.epoch, data.seq);
    items.push({
      event: {
        id,
        type,
        // An event stamped in the future is kept, at the time it was received.
        occurred_at: new Date(Math.min(Date.parse(data.at), now)).toISOString(),
        project_id: owner.project_id,
        database_id: report.database,
        data: data.payload,
      },
      webhookIds: wanting.map((subscription) => subscription.id),
      deliveryIds: await Promise.all(
        wanting.map((subscription) =>
          derivedId("dlv", `${id}|${subscription.id}`),
        ),
      ),
    });
  }
  if (items.length > 0) {
    const actor = c.env.TRIGGER_ACTOR.get(
      c.env.TRIGGER_ACTOR.idFromName(report.database),
    );
    const result = await actor.ingestBatch(items);
    if (!result.ok)
      throw new ApiError(
        "capacity_exhausted",
        "The database event buffer is full; send the batch again later",
        { buffer: "events" },
      );
  }
  const stored = items.length;
  console.info(
    JSON.stringify({
      event: "data_events_ingested",
      database_id: report.database,
      stored,
      ignored,
    }),
  );
  return c.json({ stored, ignored });
}
