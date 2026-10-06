// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { newNodeId, ObservationRequest } from "../src/index.ts";

const observed_at = "2026-10-06T12:00:00.000Z";
const node_uid = crypto.randomUUID();
const sample = {
  node_id: newNodeId(),
  provider_instance_id: "123",
  node_uid,
  memory: {
    node_uid,
    observed_at,
    working_set_bytes: 810,
    capacity_memory_bytes: 1000,
    available_bytes: 190,
    memory_pressure: false,
  },
};
const body = { observed_at, nodes: [], databases: [], orphans: [] };

it("node memory is a separate bounded UID-bound observation with explicit unknown values", () => {
  expect(ObservationRequest.safeParse(body).success).toBe(true);
  expect(
    ObservationRequest.safeParse({ ...body, node_memory_samples: [sample] })
      .success,
  ).toBe(true);
  expect(
    ObservationRequest.safeParse({
      ...body,
      node_memory_samples: [{ ...sample, memory: null }],
    }).success,
  ).toBe(true);
  expect(
    ObservationRequest.safeParse({
      ...body,
      node_memory_samples: [
        {
          ...sample,
          memory: {
            ...sample.memory,
            available_bytes: null,
            memory_pressure: null,
          },
        },
      ],
    }).success,
  ).toBe(true);
  expect(
    ObservationRequest.safeParse({
      ...body,
      node_memory_samples: [
        {
          ...sample,
          memory: { ...sample.memory, node_uid: crypto.randomUUID() },
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    ObservationRequest.safeParse({
      ...body,
      node_memory_samples: [sample, sample],
    }).success,
  ).toBe(false);
  expect(
    ObservationRequest.safeParse({
      ...body,
      node_memory_samples: [
        { ...sample, memory: { ...sample.memory, working_set_bytes: 1001 } },
      ],
    }).success,
  ).toBe(false);
  expect(
    ObservationRequest.safeParse({
      ...body,
      node_memory_samples: [
        {
          ...sample,
          memory: { ...sample.memory, observed_at: "2026-10-06T12:00:01.000Z" },
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    ObservationRequest.safeParse({
      ...body,
      node_memory_samples: [
        { ...sample, memory: { ...sample.memory, working_set_bytes: null } },
      ],
    }).success,
  ).toBe(false);
});
