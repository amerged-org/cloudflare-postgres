// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AllowanceJournal } from "../src/allowance-journal.ts";
import {
  acquireAllowance,
  reconcileAllowance,
} from "../src/allowance-supervisor.ts";

const start = Date.parse("2026-09-28T12:00:00.000Z");
const binding = {
  regionId: "11111111-1111-4111-8111-111111111111",
  environmentId: "22222222-2222-4222-8222-222222222222",
  projectId: "99999999-9999-4999-8999-999999999999",
  specRevision: 1,
  specHash: "a".repeat(64),
  namespace: "pgcf-22222222222242228222222222222222",
  namespaceUid: "33333333-3333-4333-8333-333333333333",
  clusterUid: "44444444-4444-4444-8444-444444444444",
  quotaUid: "55555555-5555-4555-8555-555555555555",
};
function receipt() {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    environmentId: binding.environmentId,
    regionId: binding.regionId,
    specRevision: 1,
    specHash: binding.specHash,
    epoch: "0",
    revision: "0",
    units: { cpu_millicore_ms: "9007199254740993" },
    issuedAt: new Date(start).toISOString(),
    expiresAt: new Date(start + 90_000).toISOString(),
    status: "issued",
    gapCount: "0",
    stoppedAt: null,
    fenceToken: `cprsv_${"f".repeat(43)}`,
    runtimeEnforced: false,
    enforcementStatus: "pending_runtime",
  };
}
function authority() {
  return {
    schemaVersion: 1,
    reservationId: receipt().id,
    environmentId: binding.environmentId,
    regionId: binding.regionId,
    projectId: binding.projectId,
    specRevision: 1,
    specHash: binding.specHash,
    epoch: "0",
    decision: "allow",
    reason: "authorized",
    observedAt: new Date(start).toISOString(),
    validUntil: new Date(start + 15_000).toISOString(),
    units: receipt().units,
    limitedMetrics: [],
    bindings: [],
    evidenceHash: "b".repeat(64),
    runtimeEnforced: false,
    enforcementStatus: "pending_runtime",
  };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pgcf-allowance-runtime-"));
  const path = join(directory, "allowance.sqlite");
  let journal = new AllowanceJournal(path, binding);
  t.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get journal() {
      return journal;
    },
    reopen() {
      journal.close();
      journal = new AllowanceJournal(path, binding);
      return journal;
    },
  };
}

test("lost reservation replies preserve the durable request, receipt and original expiry across restart", async (t) => {
  const state = fixture(t);
  const requests = [];
  const reserved = receipt();
  const client = {
    reserve: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) throw new Error("lost_after_commit");
      return structuredClone(reserved);
    },
    authority: async () => authority(),
  };
  await assert.rejects(
    acquireAllowance(state.journal, client, 90, reserved.units),
    /lost_after_commit/,
  );
  state.reopen();
  const recovered = await acquireAllowance(
    state.journal,
    client,
    90,
    reserved.units,
  );
  assert.deepEqual(
    requests[1],
    requests[0],
    "uncertain reservation must retry the same durable request identity",
  );
  assert.deepEqual(recovered, reserved);
  const persisted = state.reopen();
  assert.deepEqual(persisted.receipt, reserved);
  persisted.recordAuthority(authority());
  assert.throws(
    () =>
      persisted.recordAuthority({ ...authority(), specHash: "c".repeat(64) }),
    /authority/,
  );
  assert.deepEqual(state.reopen().authority, authority());
  assert.throws(
    () =>
      state.journal.recordAuthority({
        ...authority(),
        bindings: [
          {
            targetId: "environment:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            revision: "1",
            executionEpoch: "0",
            accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            periodStart: new Date(start).toISOString(),
            periodEnd: new Date(start + 90_000).toISOString(),
            requestedState: "running",
          },
        ],
      }),
    /authority/,
    "a foreign policy binding cannot authorize this environment",
  );
});

test("an unfunded policy dimension fences growth and remains stopped through cache expiry and control outage without changing volumes", async (t) => {
  const state = fixture(t);
  state.journal.recordReceipt({ ...receipt(), epoch: "1" });
  const limitedAuthority = {
    ...authority(),
    epoch: "1",
    limitedMetrics: ["cpu_millicore_ms", "memory_byte_ms"],
    bindings: [
      {
        targetId: `project:${binding.projectId}`,
        revision: "1",
        executionEpoch: "1",
        accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        periodStart: new Date(start).toISOString(),
        periodEnd: new Date(start + 90_000).toISOString(),
        requestedState: "running",
      },
    ],
  };
  state.journal.recordAuthority(limitedAuthority);
  const labels = {
    "app.kubernetes.io/managed-by": "cloudflare-postgres",
    "pgcf.io/environment-id": binding.environmentId,
    "pgcf.io/region-id": binding.regionId,
  };
  const annotations = { "pgcf.io/spec-hash": binding.specHash };
  const inventory = {
    namespace: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: binding.namespace,
        uid: binding.namespaceUid,
        labels,
        annotations,
      },
    },
    cluster: {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: {
        name: "database",
        namespace: binding.namespace,
        uid: binding.clusterUid,
        resourceVersion: "10",
        labels,
        annotations,
      },
      spec: { instances: 1 },
    },
    quota: {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: {
        name: "database-resources",
        namespace: binding.namespace,
        uid: binding.quotaUid,
        resourceVersion: "11",
        labels,
        annotations,
      },
      spec: {
        hard: {
          pods: "2",
          "requests.cpu": "1050m",
          "requests.memory": "1152Mi",
        },
      },
    },
    pods: [],
    pvcs: [
      {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name: "database-1",
          namespace: binding.namespace,
          uid: "77777777-7777-4777-8777-777777777777",
        },
        spec: { volumeName: "volume-1", storageClassName: "test-local" },
        status: { phase: "Bound", capacity: { storage: "4Gi" } },
      },
    ],
    pvs: [
      {
        apiVersion: "v1",
        kind: "PersistentVolume",
        metadata: {
          name: "volume-1",
          uid: "88888888-8888-4888-8888-888888888888",
        },
        spec: {
          storageClassName: "test-local",
          capacity: { storage: "4Gi" },
          persistentVolumeReclaimPolicy: "Retain",
          claimRef: {
            namespace: binding.namespace,
            name: "database-1",
            uid: "77777777-7777-4777-8777-777777777777",
          },
        },
        status: { phase: "Bound" },
      },
    ],
  };
  const volumes = structuredClone({ pvcs: inventory.pvcs, pvs: inventory.pvs });
  const patches = [];
  const runtime = {
    inventory: async () => structuredClone(inventory),
    patch: async (kind, name, operations) => {
      patches.push({ kind, name, operations: structuredClone(operations) });
      const resource = kind === "Cluster" ? inventory.cluster : inventory.quota;
      assert.ok(
        operations.some(
          (operation) =>
            operation.op === "test" &&
            operation.path === "/metadata/uid" &&
            operation.value === resource.metadata.uid,
        ),
      );
      assert.ok(
        operations.some(
          (operation) =>
            operation.op === "test" &&
            operation.path === "/metadata/resourceVersion" &&
            operation.value === resource.metadata.resourceVersion,
        ),
      );
      const edit = operations.find((operation) => operation.op !== "test");
      if (kind === "ResourceQuota") {
        assert.equal(edit.path, "/spec/hard/pods");
        inventory.quota.spec.hard.pods = "0";
      } else {
        assert.equal(edit.path, "/metadata/annotations/cnpg.io~1hibernation");
        assert.equal(edit.value, "on");
        inventory.cluster.metadata.annotations["cnpg.io/hibernation"] = "on";
        throw new Error("lost_after_patch_commit");
      }
    },
  };
  let controlOnline = true;
  const client = {
    reserve: async () => {
      throw new Error("unexpected_reserve");
    },
    authority: async () => {
      if (controlOnline) return limitedAuthority;
      throw new Error("control_offline");
    },
  };
  const stopped = await reconcileAllowance(
    state.journal,
    client,
    runtime,
    start + 1_000,
  );
  assert.equal(
    stopped.growthAllowed,
    false,
    "a CPU receipt cannot authorize nonzero RAM under an unfunded RAM policy",
  );
  assert.equal(stopped.state, "stopped");
  assert.equal(inventory.quota.spec.hard.pods, "0");
  assert.equal(
    inventory.cluster.metadata.annotations["cnpg.io/hibernation"],
    "on",
  );
  assert.deepEqual({ pvcs: inventory.pvcs, pvs: inventory.pvs }, volumes);
  assert.equal(
    patches.length,
    2,
    "uncertain patch response is resolved by observed ownership/readback",
  );
  state.reopen();
  controlOnline = false;
  const restarted = await reconcileAllowance(
    state.journal,
    client,
    runtime,
    start + 17_000,
  );
  assert.equal(restarted.growthAllowed, false);
  assert.equal(
    patches.length,
    2,
    "restarted stop reconciliation must not repeat committed patches",
  );
});
