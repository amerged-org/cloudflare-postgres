// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  FleetUpdatePolicy,
  FleetUpdatePolicyUpdate,
} from "../src/fleet-updates.ts";
const policy = () => ({
  enabled: true,
  promoted_release_id: "release-one",
  canary: { region_id: "a".repeat(20), cluster_uid: crypto.randomUUID() },
  windows: [{ weekday: 0, start_minute: 1380, duration_minutes: 120 }],
  supported_lines: [{ component: "talos", line: "1.14" }],
  soak_seconds: 300,
  normal_deadline_hours: 48,
  critical: {
    minimum_severity: "critical",
    deadline_hours: 6,
    allow_outside_window: false,
  },
});
it("requires explicit maintenance, unique supported lines and separate emergency permission", () => {
  expect(FleetUpdatePolicy.parse(policy()).critical.allow_outside_window).toBe(
    false,
  );
  expect(
    FleetUpdatePolicy.safeParse({ ...policy(), windows: [] }).success,
  ).toBe(false);
  expect(
    FleetUpdatePolicy.safeParse({
      ...policy(),
      supported_lines: [{ component: "postgres", line: "18.6" }],
    }).success,
  ).toBe(false);
  expect(
    FleetUpdatePolicy.safeParse({
      ...policy(),
      supported_lines: [
        { component: "talos", line: "1.14" },
        { component: "talos", line: "1.15" },
      ],
    }).success,
  ).toBe(false);
});
it("accepts no unsigned qualification or canary boolean in the management contract", () => {
  expect(
    FleetUpdatePolicyUpdate.safeParse({
      expected_revision: 0,
      policy: policy(),
      qualified: true,
      canary_passed: true,
    }).success,
  ).toBe(false);
  expect(
    FleetUpdatePolicy.safeParse({
      ...policy(),
      qualification_receipt: { passed: true },
    }).success,
  ).toBe(false);
});
