// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  assertClusterIdentity,
  assertPolicyIdentity,
  inverseReady,
} from "../src/identity.ts";

function identity() {
  return {
    cluster_uid: randomUUID(),
    namespace_uid: randomUUID(),
    agent_uid: randomUUID(),
    nodes: { "pgcf-node": randomUUID() },
    agent_api_url: "https://pgcf-api.test.invalid",
    region_id: "test-region",
  };
}

test("same names in another cluster cannot authorize a mutation", () => {
  const expected = identity();
  assert.doesNotThrow(() =>
    assertClusterIdentity(expected, expected, [expected.agent_api_url]),
  );
  assert.throws(() =>
    assertClusterIdentity(
      { ...expected, cluster_uid: randomUUID() },
      expected,
      [expected.agent_api_url],
    ),
  );
  assert.throws(() =>
    assertClusterIdentity(
      { ...expected, namespace_uid: randomUUID() },
      expected,
      [expected.agent_api_url],
    ),
  );
  assert.throws(() =>
    assertClusterIdentity({ ...expected, agent_uid: randomUUID() }, expected, [
      expected.agent_api_url,
    ]),
  );
  assert.throws(() =>
    assertClusterIdentity(
      { ...expected, nodes: { "pgcf-node": randomUUID() } },
      expected,
      [expected.agent_api_url],
    ),
  );
});

test("effective agent API and region must be the bound Dev configuration", () => {
  const expected = identity();
  assert.throws(() =>
    assertClusterIdentity(
      { ...expected, agent_api_url: "https://pgcf-production.test.invalid" },
      expected,
      [expected.agent_api_url],
    ),
  );
  assert.throws(() =>
    assertClusterIdentity(
      { ...expected, region_id: "another-region" },
      expected,
      [expected.agent_api_url],
    ),
  );
});

test("same-name policy without the recorded UID remains foreign", () => {
  const uid = randomUUID();
  const policy = {
    metadata: {
      name: "pgcf-e2e-policy",
      namespace: "pgcf-system",
      uid,
      labels: { "pgcf.io/e2e-run": "pgcf-e2e-run" },
    },
  };
  assert.throws(() =>
    assertPolicyIdentity(
      policy,
      "pgcf-e2e-policy",
      "pgcf-system",
      "pgcf-e2e-run",
      undefined,
    ),
  );
  assert.throws(() =>
    assertPolicyIdentity(
      policy,
      "pgcf-e2e-policy",
      "pgcf-system",
      "pgcf-e2e-run",
      randomUUID(),
    ),
  );
  assert.doesNotThrow(() =>
    assertPolicyIdentity(
      policy,
      "pgcf-e2e-policy",
      "pgcf-system",
      "pgcf-e2e-run",
      uid,
    ),
  );
});

test("inverse stays pending until exact rollout and new real API contact", () => {
  const uid = randomUUID(),
    now = Date.now();
  const proof = {
    uid,
    expected_uid: uid,
    original_url: "https://pgcf-api.test.invalid",
    actual_url: "https://pgcf-api.test.invalid",
    generation: 4,
    observed_generation: 3,
    replicas: 1,
    available_replicas: 1,
    api_seen_at: new Date(now - 1).toISOString(),
    started_at: new Date(now).toISOString(),
    pod_original_url: true,
  };
  assert.equal(inverseReady(proof), false);
  assert.equal(inverseReady({ ...proof, observed_generation: 4 }), false);
  assert.equal(
    inverseReady({
      ...proof,
      observed_generation: 4,
      api_seen_at: new Date(now + 1).toISOString(),
    }),
    true,
  );
  assert.equal(
    inverseReady({
      ...proof,
      observed_generation: 4,
      api_seen_at: new Date(now + 1).toISOString(),
      started_at: new Date(now + 2).toISOString(),
    }),
    false,
  );
  assert.equal(
    inverseReady({
      ...proof,
      observed_generation: 4,
      api_seen_at: new Date(now + 1).toISOString(),
      uid: randomUUID(),
    }),
    false,
  );
});
