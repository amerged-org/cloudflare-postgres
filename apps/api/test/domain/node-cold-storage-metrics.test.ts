// SPDX-License-Identifier: Apache-2.0
import { newDatabaseId, NodeSample } from "@pgcf/contracts";
import { expect, it } from "vitest";
import { foldSample } from "../../src/node-actor.ts";
import { nodeSample } from "./fixtures.ts";

it("counts serving databases separately while retaining verification's actual resource demand", () => {
  const customer = newDatabaseId();
  const verification = newDatabaseId();
  const sample = NodeSample.parse({
    ...nodeSample(),
    awake: [customer, verification],
    verification_runtime_ids: [verification],
    awake_memory_mib: 1024,
    starting: 1,
    cpu: { cores: 6, busy_millicores: 900 },
  });
  const first = foldSample(undefined, sample);
  const second = foldSample(first, sample);
  expect(second).toMatchObject({
    samples: 2,
    awake_sum: 2,
    awake_max: 1,
    awake_memory_mib_sum: 2048,
    awake_memory_mib_max: 1024,
    starting_max: 1,
    cpu_busy_millicores_sum: 1800,
    memory_used_bytes_sum:
      2 * (sample.memory.total_bytes - sample.memory.available_bytes),
  });
});
