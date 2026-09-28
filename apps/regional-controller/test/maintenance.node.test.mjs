// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareMaintenance } from "../src/maintenance.ts";

const start = Date.parse("2026-09-28T12:00:00.000Z");
const node1 = "11111111-1111-4111-8111-111111111111";
const node2 = "22222222-2222-4222-8222-222222222222";
const node3 = "33333333-3333-4333-8333-333333333333";
const clusterUid = "44444444-4444-4444-8444-444444444444";
const regionId = "55555555-5555-4555-8555-555555555555";
function claim(nodeUids) {
  const plan = {
    schemaVersion: 1,
    kind: "kubernetes.upgrade",
    clusterUid,
    nodeUids,
    fromVersion: "1.36.3",
    toVersion: "1.36.4",
    talosVersion: "1.14.1",
    toolImage: `ghcr.io/amerged-org/pgcf-talosctl@sha256:${"a".repeat(64)}`,
    targetArtifactsHash: "b".repeat(64),
  };
  return {
    operationId: "66666666-6666-4666-8666-666666666666",
    regionId,
    plan,
    planHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    leaseToken: `cpmtl_${"f".repeat(43)}`,
    leaseEpoch: 1,
    leaseExpiresAt: new Date(start + 90_000).toISOString(),
  };
}
function evidence(planHash) {
  return {
    status: "verified",
    planHash,
    observedAt: start,
    expiresAt: start + 60_000,
    evidenceHash: "c".repeat(64),
  };
}
function context() {
  return {
    namespace: "pgcf-system",
    talosconfigSecret: "maintenance-talos",
    endpoints: ["192.0.2.10"],
    now: () => start,
    leaseValid: async () => true,
  };
}

test("standalone maintenance is blocked by observed availability and missing recovery evidence without side effects", async () => {
  const operation = claim([node1]);
  const snapshot = {
    complete: true,
    observedAt: start,
    regionId,
    clusterUid,
    targetNodeUid: node1,
    machineIdentity: evidence(operation.planHash),
    nodes: [{ uid: node1, ready: true, kubernetesVersion: "1.36.3" }],
    etcd: {
      observedAt: start,
      expiresAt: start + 60_000,
      evidenceHash: "d".repeat(64),
      voters: [{ memberId: "voter-1", nodeUid: node1, healthy: true }],
    },
    databases: [
      {
        uid: "77777777-7777-4777-8777-777777777777",
        primaryNodeUid: node1,
        readyInstanceNodeUids: [node1],
        switchoverVerified: false,
        pdbAllowsDisruption: false,
        volumeBindingsStable: true,
      },
    ],
    recovery: null,
    staging: null,
    capacity: null,
  };
  let jobReads = 0;
  let jobCreates = 0;
  const jobs = {
    readJob: async () => {
      jobReads += 1;
      return null;
    },
    createJob: async () => {
      jobCreates += 1;
      throw new Error("unexpected_job");
    },
  };
  const result = await prepareMaintenance(operation, snapshot, context(), jobs);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.assessment.blockers.toSorted(), [
    "capacity_unreserved",
    "database_availability_unproven",
    "quorum_unproven",
    "recovery_unproven",
    "staging_unqualified",
  ]);
  assert.deepEqual(result.assessment.dryRun, {
    status: "not_run",
    jobUid: null,
  });
  assert.equal(jobReads, 0);
  assert.equal(
    jobCreates,
    0,
    "missing prerequisites must prevent a Talos Job from starting",
  );
});

test("a lost committed preparation Job response is reconciled after restart without duplicate creation", async () => {
  const operation = claim([node1, node2, node3]);
  const proof = evidence(operation.planHash);
  const snapshot = {
    complete: true,
    observedAt: start,
    regionId,
    clusterUid,
    targetNodeUid: node1,
    machineIdentity: proof,
    nodes: [
      { uid: node1, ready: true, kubernetesVersion: "1.36.3" },
      { uid: node2, ready: true, kubernetesVersion: "1.36.3" },
      { uid: node3, ready: true, kubernetesVersion: "1.36.3" },
    ],
    etcd: {
      observedAt: start,
      expiresAt: start + 60_000,
      evidenceHash: "d".repeat(64),
      voters: [
        { memberId: "voter-1", nodeUid: node1, healthy: true },
        { memberId: "voter-2", nodeUid: node2, healthy: true },
        { memberId: "voter-3", nodeUid: node3, healthy: true },
      ],
    },
    databases: [
      {
        uid: "77777777-7777-4777-8777-777777777777",
        primaryNodeUid: node1,
        readyInstanceNodeUids: [node1, node2],
        switchoverVerified: true,
        pdbAllowsDisruption: true,
        volumeBindingsStable: true,
      },
    ],
    recovery: proof,
    staging: proof,
    capacity: {
      ...proof,
      scope: "sequential-plan",
      reservationId: "88888888-8888-4888-8888-888888888888",
      nodeUids: [node2, node3],
    },
  };
  let stored = null;
  let creates = 0;
  const jobs = {
    readJob: async () => (stored === null ? null : structuredClone(stored)),
    createJob: async (job) => {
      creates += 1;
      stored = structuredClone(job);
      stored.metadata.uid = "99999999-9999-4999-8999-999999999999";
      stored.status = {};
      throw new Error("response_lost_after_commit");
    },
  };
  const uncertain = await prepareMaintenance(
    operation,
    snapshot,
    context(),
    jobs,
  );
  assert.equal(creates, 1, "the authorized preparation starts one durable Job");
  assert.equal(uncertain.status, "pending");
  const container = stored.spec.template.spec.containers[0];
  const invocation = [...container.command, ...(container.args ?? [])];
  assert.ok(invocation.includes("upgrade-k8s"));
  assert.ok(invocation.includes("--dry-run"));
  assert.ok(invocation.includes("--pre-pull-images=false"));
  assert.ok(invocation.includes("--from"));
  assert.ok(invocation.includes("--to"));
  assert.equal(container.image, operation.plan.toolImage);
  assert.equal(stored.spec.template.spec.automountServiceAccountToken, false);
  stored.status = { conditions: [{ type: "Complete", status: "True" }] };
  const restarted = await prepareMaintenance(
    { ...operation, leaseEpoch: 2 },
    snapshot,
    context(),
    jobs,
  );
  assert.equal(
    creates,
    1,
    "restart must observe the committed Job instead of creating another",
  );
  assert.equal(restarted.status, "eligible");
  assert.deepEqual(restarted.assessment.blockers, []);
  assert.deepEqual(restarted.assessment.dryRun, {
    status: "succeeded",
    jobUid: stored.metadata.uid,
  });
});
