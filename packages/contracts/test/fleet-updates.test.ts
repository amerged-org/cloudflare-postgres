// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  FleetUpdatePolicy,
  FleetUpdatePolicyUpdate,
} from "../src/fleet-updates.ts";
import {
  FleetRolloutIntent,
  FleetRolloutRequest,
} from "../src/fleet-rollouts.ts";
import { newNodeId, newOperationId } from "../src/ids.ts";
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
it("accepts an explicit rollout predecessor and retains only its immediate core intent", () => {
  const request = {
      release_id: "release-one",
      maintenance_acknowledged: true,
      regions: [
        {
          region_id: "a".repeat(20),
          expected_revision: 0,
          cluster_uid: crypto.randomUUID(),
          material_revision: 1,
          nodes: [
            {
              node_id: newNodeId(),
              node_uid: crypto.randomUUID(),
              expected_revision: 0,
              role: "customer",
              address: "192.0.2.18",
            },
          ],
        },
      ],
    },
    previous = {
      ...request,
      rollout_id: newOperationId(),
      created_at: new Date().toISOString(),
      regions: request.regions.map((region) => ({
        ...region,
        revision: 1,
        current_material_revision: 1,
        nodes: region.nodes.map((node) => ({
          ...node,
          assignment_revision: 1,
        })),
      })),
    },
    older = { ...previous, rollout_id: newOperationId() };
  expect(FleetRolloutRequest.parse(request)).toEqual(request);
  expect(
    FleetRolloutRequest.parse({
      ...request,
      expected_previous_rollout_id: previous.rollout_id,
    }).expected_previous_rollout_id,
  ).toBe(previous.rollout_id);
  expect(
    FleetRolloutIntent.parse({
      ...previous,
      rollout_id: newOperationId(),
      previous_intent: {
        ...previous,
        expected_previous_rollout_id: older.rollout_id,
        previous_intent: older,
      },
    }).previous_intent,
  ).toEqual(previous);
});
