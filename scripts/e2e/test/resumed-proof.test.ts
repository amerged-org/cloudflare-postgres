// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Run } from "../src/run.ts";

function reboundContext() {
  const bound = {
    cluster_uid: randomUUID(),
    namespace_uid: randomUUID(),
    agent_uid: randomUUID(),
    nodes: { "pgcf-node": randomUUID() },
    agent_api_url: "https://pgcf-api.test.invalid",
    region_id: "test-region",
  };
  const actual = { ...bound, cluster_uid: randomUUID() };
  let proofReads = 0,
    archivePurges = 0;
  const databaseId = `d${randomUUID().replaceAll("-", "").slice(0, 19)}`;
  const run = Object.assign(Object.create(Run.prototype) as Run, {
    c: {
      apiUrl: new URL(bound.agent_api_url),
      expectedCluster: bound,
      nodes: ["pgcf-node"],
      values: {
        PGCF_E2E_REGIONAL_NAMESPACE: "pgcf-system",
        PGCF_E2E_AGENT_DEPLOYMENT_NAME: "pgcf-agent",
        PGCF_E2E_REGION_ID: bound.region_id,
      },
    },
    state: {
      cluster: bound,
      database_id: databaseId,
      completed: ["E5"],
      intents: [],
      actions: [],
      pvs: [],
      lvm_volumes: [],
      allocated: [],
      baseline: [
        { node: "pgcf-node", free_bytes: 1, resource_version: "prior" },
      ],
      tails: [],
    },
    runName: "pgcf-e2e-test",
    kube: {
      clusterIdentity: async () => actual,
      read: async (resource: string) => {
        proofReads++;
        return resource === "lvmnodes.local.openebs.io"
          ? {
              items: [
                {
                  metadata: { name: "pgcf-node", resourceVersion: "current" },
                  volumeGroups: [{ name: "pgcf", free: "1" }],
                },
              ],
            }
          : { items: [] };
      },
    },
    cf: {
      list: async () => [],
      request: async () => ({ result: { subdomain: "test" } }),
    },
    api: { list: async () => [] },
    verifyIdentity: async () => undefined,
    recoverOwnership: async () => undefined,
    save: async () => undefined,
    emit: async () => undefined,
  });
  return {
    run,
    reads: () => proofReads,
    purges: () => archivePurges,
    fakePurge: () => {
      archivePurges++;
    },
  };
}

test("resumed storage capture rejects a rebound cluster before collecting evidence", async () => {
  const fixture = reboundContext();
  await assert.rejects(fixture.run.captureStorage(), {
    message: "dev_cluster_identity_mismatch",
  });
  assert.equal(fixture.reads(), 0);
});

test("resumed deleted-storage proof cannot pass against same-name foreign nodes", async () => {
  const fixture = reboundContext();
  await assert.rejects(fixture.run.assertStorageGone(), {
    message: "dev_cluster_identity_mismatch",
  });
  assert.equal(fixture.reads(), 0);
});

test("resumed E6 rejects foreign node addresses before any scan input is read", async () => {
  const fixture = reboundContext();
  await assert.rejects(fixture.run.scan(), {
    message: "dev_cluster_identity_mismatch",
  });
  assert.equal(fixture.reads(), 0);
});

test("resumed cleanup preserves owned archives when cluster identity changes", async () => {
  const fixture = reboundContext();
  fixture.run.state.chaos = {
    relay_name: "pgcf-e2e-test-relay",
    policy_name: "pgcf-e2e-test-egress",
    inverse_needed: true,
  };
  Object.assign(fixture.run, {
    deleteDatabase: async () => fixture.fakePurge(),
  });
  await assert.rejects(fixture.run.cleanup(), {
    message: "dev_cluster_identity_mismatch",
  });
  assert.equal(fixture.reads(), 0);
  assert.equal(fixture.purges(), 0);
  assert.equal(fixture.run.state.chaos.inverse_needed, true);
});

test("volume-free sampling checks the bound cluster before reading measurements", async () => {
  const fixture = reboundContext();
  await assert.rejects(fixture.run.sample(), {
    message: "dev_cluster_identity_mismatch",
  });
  assert.equal(fixture.reads(), 0);
});
