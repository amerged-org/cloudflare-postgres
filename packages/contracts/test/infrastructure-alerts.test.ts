// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { newDatabaseId, newNodeId } from "../src/ids.ts";
import {
  INFRA_ALERT_ACTIONS,
  InfraAlert,
  InfraAlertKind,
} from "../src/infrastructure-alerts.ts";

const base = {
  version: 1 as const,
  event_id: crypto.randomUUID(),
  region_id: "eu-1",
  occurred_at: "2026-10-15T00:00:00.000Z",
  regional_ram_utilization_ppm: null,
  allocated_nodes: 2,
  max_nodes: null,
};

it("gives every alert kind one short runbook action", () => {
  expect(Object.keys(INFRA_ALERT_ACTIONS).sort()).toEqual(
    [...InfraAlertKind.options].sort(),
  );
  for (const [kind, action] of Object.entries(INFRA_ALERT_ACTIONS)) {
    expect(action.length, kind).toBeGreaterThan(40);
    expect(action.length, kind).toBeLessThanOrEqual(400);
  }
});

it("lists at most 20 failing cron steps and keeps the longest such alert under the 4 KB the store checks", () => {
  const steps = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      step: `step_${index}`.padEnd(32, "x"),
      consecutive_failures: 1_000_000,
      error_code: "e".repeat(64),
    }));
  const alert = (count: number) => ({
    ...base,
    kind: "control_cron_step_failing" as const,
    event_id: crypto.randomUUID(),
    cron: {
      last_started_at: "2026-10-15T00:00:00.000Z",
      last_completed_at: "2026-10-15T00:00:00.000Z",
      failing_steps: steps(count),
    },
    action: "a".repeat(512),
  });
  const longest = InfraAlert.parse(alert(20));
  expect(JSON.stringify(longest).length).toBeLessThanOrEqual(4096);
  expect(InfraAlert.safeParse(alert(21)).success).toBe(false);
});

it("has no regional RAM warning and sends the RAM utilization field only as null", () => {
  expect(InfraAlertKind.options).not.toContain("regional_ram_warning");
  // The field stays in the event so a receiver that reads it keeps working; nothing measures it.
  expect(
    InfraAlert.safeParse({ ...base, kind: "regional_node_stale" }).success,
  ).toBe(true);
  expect(
    InfraAlert.safeParse({
      ...base,
      kind: "regional_node_stale",
      regional_ram_utilization_ppm: 760000,
    }).success,
  ).toBe(false);
  expect(
    InfraAlert.safeParse({
      ...base,
      kind: "regional_node_stale",
      regional_ram_utilization_ppm: undefined,
    }).success,
  ).toBe(false);
});

it("covers the database, Thin storage and cron conditions beside the infrastructure ones", () => {
  expect(InfraAlertKind.options).toEqual(
    expect.arrayContaining([
      "database_archive_failing",
      "database_base_backup_stale",
      "thin_storage_blocked",
      "control_cron_stalled",
      "control_cron_step_failing",
    ]),
  );
});

it("carries the subjects, the runbook action and the cron heartbeat of an event", () => {
  const archive = InfraAlert.parse({
    ...base,
    kind: "database_archive_failing",
    database_ids: [newDatabaseId(), newDatabaseId()],
    action: INFRA_ALERT_ACTIONS.database_archive_failing,
  });
  expect(archive.database_ids).toHaveLength(2);
  expect(archive.action).toBe(INFRA_ALERT_ACTIONS.database_archive_failing);
  expect(
    InfraAlert.parse({
      ...base,
      kind: "thin_storage_blocked",
      thin_storage: [
        { node_id: newNodeId(), error_code: "thin_storage_report_unqualified" },
        { node_id: newNodeId(), error_code: null },
      ],
    }).thin_storage,
  ).toHaveLength(2);
  expect(
    InfraAlert.parse({
      ...base,
      kind: "control_cron_step_failing",
      cron: {
        last_started_at: "2026-10-15T00:00:00.000Z",
        last_completed_at: "2026-10-15T00:00:00.000Z",
        failing_steps: [
          {
            step: "usage",
            consecutive_failures: 5,
            error_code: "usage_cron_statement_budget",
          },
        ],
      },
    }).cron?.failing_steps,
  ).toHaveLength(1);
  // An episode stored before the action existed still parses.
  expect(
    InfraAlert.safeParse({ ...base, kind: "regional_node_stale" }).success,
  ).toBe(true);
  expect(
    InfraAlert.safeParse({
      ...base,
      kind: "database_archive_failing",
      database_ids: Array.from({ length: 65 }, () => newDatabaseId()),
    }).success,
  ).toBe(false);
});
