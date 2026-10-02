// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { faultCycleReady, preservedDatabase } from "../src/cycles.ts";

test("a pull alone cannot complete a fault cycle", () => {
  assert.equal(
    faultCycleReady(
      { completed_responses: 0, observations_after_response: 0 },
      1,
    ),
    false,
  );
  assert.equal(
    faultCycleReady(
      { completed_responses: 1, observations_after_response: 0 },
      1,
    ),
    false,
  );
  assert.equal(
    faultCycleReady(
      { completed_responses: 1, observations_after_response: 1 },
      1,
    ),
    true,
  );
  assert.equal(
    faultCycleReady(
      { completed_responses: 1, observations_after_response: 1 },
      2,
    ),
    false,
  );
});

test("preservation checks persisted fences and credential fingerprints", () => {
  const before = {
    uid: "unit-generated-namespace",
    accepted: 2,
    completed: 2,
    roles: ["unit-generated-fingerprint"],
  };
  assert.equal(preservedDatabase(before, { ...before }), true);
  assert.equal(preservedDatabase(before, { ...before, accepted: 1 }), false);
  assert.equal(preservedDatabase(before, { ...before, completed: 1 }), false);
  assert.equal(
    preservedDatabase(before, { ...before, roles: ["changed-fingerprint"] }),
    false,
  );
});
