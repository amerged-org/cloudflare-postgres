// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  InfraAlert,
  type InfraAlertKind,
} from "@pgcf/contracts";
import { infrastructureAlertStatus } from "../../src/domain/infrastructure-alerts.ts";
import type { fixture } from "./fixtures.ts";

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const ago = (now: number, ms: number) => new Date(now - ms).toISOString();
export const HOUR = 3_600_000;

export async function database(
  f: Fixture,
  name: string,
  columns: Record<string, string | number | null> = {},
) {
  const created = DatabaseWithOperation.parse(
    await (await f.create(name)).json(),
  );
  const id = created.database.id,
    keys = Object.keys(columns);
  // The create's own lifecycle event is "now"; these databases claim an older history.
  await env.DB.prepare("DELETE FROM lifecycle_events WHERE database_id=?")
    .bind(id)
    .run();
  if (keys.length)
    await env.DB.prepare(
      `UPDATE databases SET ${keys.map((key) => `${key}=?`).join(",")} WHERE id=?`,
    )
      .bind(...Object.values(columns), id)
      .run();
  return id;
}
export const awake = (
  now: number,
  extra: Record<string, string | number | null>,
) => ({
  observed_state: "ready",
  observed_power: "awake",
  created_at: ago(now, 100 * HOUR),
  ...extra,
});
/** The webhook receiver of the alert tests: records each event and acknowledges it. */
export function receiver() {
  const events: { event: InfraAlert; key: string | null }[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    events.push({
      event: InfraAlert.parse(JSON.parse(init!.body as string)),
      key: new Headers(init!.headers).get("Idempotency-Key"),
    });
    return new Response(null, { status: 204 });
  };
  return {
    events,
    fetcher,
    env: {
      ...env,
      INFRASTRUCTURE_ALERT_WEBHOOK_URL: "https://receiver.invalid/events",
      INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN: "test-alert-receiver-token",
    },
  };
}
export const status = async (f: Fixture, kind: InfraAlertKind) =>
  (await infrastructureAlertStatus(env.DB, f.region)).find(
    (value) => value.kind === kind,
  );
