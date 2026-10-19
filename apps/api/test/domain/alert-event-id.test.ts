// SPDX-License-Identifier: Apache-2.0
import { InfraAlert } from "@pgcf/contracts";
import { expect, it } from "vitest";
import { alertEventId } from "../../src/domain/infrastructure-alerts.ts";

const A = "daaaaaaaaaaaaaaaaaaa",
  B = "dbbbbbbbbbbbbbbbbbbb";

it("derives the id of an alert from the error: its region, its kind and the set of subjects that fail", async () => {
  // Known answers. Receivers keep these ids, so the derivation must never change.
  expect(await alertEventId("eu1", "regional_ram_warning")).toBe(
    "51aa091f-07e2-826d-af90-de2060fd291f",
  );
  expect(await alertEventId("eu2", "regional_ram_warning")).toBe(
    "d37856f8-f023-83bb-b971-17799ea4e024",
  );
  const both = "c3e0b73e-882a-8f2c-8722-8827cc503f74";
  expect(await alertEventId("eu1", "database_archive_failing", [B, A])).toBe(
    both,
  );
  // A kind with no listed nodes or databases is told apart by its failing step.
  expect(
    await alertEventId("eu1", "control_cron_step_failing", ["usage"]),
  ).toBe("6263629e-a150-8592-a767-e148c017633d");
  expect(
    await alertEventId("eu1", "control_cron_step_failing", ["health_alerts"]),
  ).toBe("20d15560-b1e6-80c8-8518-152575d79e3b");
  // The order the subjects were found in and a repeated subject change nothing.
  expect(await alertEventId("eu1", "database_archive_failing", [A, B, A])).toBe(
    both,
  );
  // Another set, another kind, and no subjects at all are other errors.
  const others = await Promise.all([
    alertEventId("eu1", "database_archive_failing", [A]),
    alertEventId("eu1", "database_archive_failing", [B]),
    alertEventId("eu1", "database_archive_failing"),
    alertEventId("eu1", "database_base_backup_stale", [A, B]),
  ]);
  expect(new Set([...others, both]).size).toBe(5);
  // A UUID of version 8 (RFC 9562: a name-based UUID from SHA-256 is no version 5) and the RFC 4122
  // variant, which the alert contract accepts.
  for (const id of [both, ...others])
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  expect(InfraAlert.shape.event_id.safeParse(others[0]).success).toBe(true);
});
