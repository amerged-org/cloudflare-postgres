// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CapacityJournal } from "../src/capacity-journal.ts";
import { PodRetirementJournal } from "../src/pod-retirement.ts";
import { canonicalCohort } from "../src/node-cohort.ts";
const hash = (value) =>
  createHash("sha256").update(canonicalCohort(value)).digest("hex");
const ids = {
  region: "11111111-1111-4111-8111-111111111111",
  operation: "22222222-2222-4222-8222-222222222222",
  environment: "33333333-3333-4333-8333-333333333333",
  namespace: "44444444-4444-4444-8444-444444444444",
  cluster: "55555555-5555-4555-8555-555555555555",
  project: "66666666-6666-4666-8666-666666666666",
  organization: "77777777-7777-4777-8777-777777777777",
  node: "88888888-8888-4888-8888-888888888888",
  boot: "99999999-9999-4999-8999-999999999999",
  pod: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  stop: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  quota: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  cohort: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  attempt: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};
const namespace = "pgcf-" + ids.environment.replaceAll("-", "");
const binding = {
  installationId: "capacity-installation",
  regionId: ids.region,
  operationId: ids.operation,
  environmentId: ids.environment,
  specRevision: 1,
  specHash: "a".repeat(64),
  runEpoch: "1",
};
const plan = {
  version: 1,
  binding,
  namespace,
  customerStorageClass: "pgcf-data",
  holdNamespace: "capacity",
  holdStorageClassPrefix: "pgcf-hold",
  instances: 1,
  slots: [
    {
      id: "database-0",
      kind: "database",
      maintenance: false,
      reservationName: "capacity-database-0",
      holdPvcName: "hold-database-0",
      cpuMilli: 125,
      memoryBytes: "134217728",
      cpuLimitMilli: 200,
      memoryLimitBytes: "268435456",
      volumeBytes: "1073741824",
    },
    {
      id: "database-1",
      kind: "database",
      maintenance: true,
      reservationName: "capacity-database-1",
      holdPvcName: "hold-database-1",
      cpuMilli: 125,
      memoryBytes: "134217728",
      cpuLimitMilli: 200,
      memoryLimitBytes: "268435456",
      volumeBytes: "1073741824",
    },
    {
      id: "pooler",
      kind: "pooler",
      maintenance: false,
      reservationName: "capacity-pooler",
      holdPvcName: null,
      cpuMilli: 25,
      memoryBytes: "67108864",
      cpuLimitMilli: 100,
      memoryLimitBytes: "134217728",
      volumeBytes: null,
    },
  ],
};
const ref = (name, uid, namespace = "") => ({
  name,
  namespace,
  uid,
  resourceVersion: "1",
});
const observed = (index) => ({
  reservation: ref(
    plan.slots[index].reservationName,
    `10000000-0000-4000-8000-00000000000${index}`,
  ),
  node: {
    name: "node-a",
    uid: ids.node,
    bootId: ids.boot,
    topologyKey: "openebs.io/nodename",
    topologyValue: "node-a",
    vgUuid: "vg-pgcf",
  },
  storage: {
    holdPvc: ref(
      plan.slots[index].holdPvcName,
      `20000000-0000-4000-8000-00000000000${index}`,
      "capacity",
    ),
    pv: ref("pv-" + index, `30000000-0000-4000-8000-00000000000${index}`),
    lvmVolume: ref(
      "lvm-" + index,
      `40000000-0000-4000-8000-00000000000${index}`,
      "openebs",
    ),
    csiHandle: "lvm-volume-" + index,
    bytes: "1073741824",
    storageClassName: "pgcf-hold-node-a",
  },
});
const pod = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: "database-1",
    namespace,
    uid: ids.pod,
    resourceVersion: "1",
    ownerReferences: [
      {
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "Cluster",
        name: "database",
        uid: ids.cluster,
        controller: true,
      },
    ],
  },
  spec: {
    nodeName: "node-a",
    restartPolicy: "Always",
    containers: [{ name: "postgres", image: "postgres@sha256:fixture" }],
  },
  status: {
    phase: "Running",
    containerStatuses: [
      {
        name: "postgres",
        restartCount: 0,
        containerID: "containerd://" + "f".repeat(64),
        state: { running: { startedAt: "2026-09-30T00:00:00Z" } },
      },
    ],
  },
};

test("retains exact compute/storage acquisition custody through uncertain admission and restart, and releases compute only for its complete original retired consumer history", (t) => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "pgcf-capacity-journal-")),
  );
  chmodSync(directory, 0o700);
  const path = join(directory, "capacity.sqlite");
  let journal = new CapacityJournal(path, plan);
  let retirement;
  t.after(() => {
    journal.close();
    retirement?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(
    journal.snapshot().slots.map((slot) => slot.plan),
    plan.slots,
    "all stable slots must be durable before acquisition I/O",
  );
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const index of [0, 1])
    journal.observeHold(plan.slots[index].id, observed(index));
  const poolerHold = {
    reservation: ref("capacity-pooler", "10000000-0000-4000-8000-000000000002"),
    node: { ...observed(0).node, vgUuid: null },
  };
  journal.observeHold("pooler", poolerHold);
  journal.available();
  journal.beginEffects();
  journal.bindRuntime({
    namespaceUid: ids.namespace,
    clusterUid: ids.cluster,
    projectId: ids.project,
    organizationId: ids.organization,
  });
  const intent = {
    operator: "system:serviceaccount:platform:regional",
    targetPvc: ref(
      "database-1",
      "50000000-0000-4000-8000-000000000000",
      namespace,
    ),
    oldClaimRef: {
      name: plan.slots[0].holdPvcName,
      namespace: "capacity",
      uid: observed(0).storage.holdPvc.uid,
    },
    newClaimRef: {
      name: "database-1",
      namespace,
      uid: "50000000-0000-4000-8000-000000000000",
    },
  };
  journal.handoff("database-0", intent);
  journal.handoffProgress("database-0", "hold_released");
  const attempt = {
    id: ids.attempt,
    slotId: "database-0",
    name: pod.metadata.name,
    namespace,
    podUid: null,
  };
  journal.admitAttempt(attempt);
  assert.throws(
    () => journal.admitAttempt({ ...attempt, id: ids.stop }),
    /capacity/,
    "a concurrent second admission cannot claim the same pending slot",
  );
  const beforeRestart = journal.snapshot();
  journal.close();
  journal = CapacityJournal.openExisting(path);
  assert.deepEqual(
    journal.snapshot(),
    beforeRestart,
    "lost provider response preserves original request, identities and handoff phase",
  );
  assert.throws(
    () =>
      new CapacityJournal(
        path,
        { ...plan, binding: { ...binding, runEpoch: "2" } },
        2,
      ),
    /capacity/,
  );
  journal.handoffProgress("database-0", "rebound");
  journal.observeComputeConsumer(
    "database-0",
    {
      uid: ids.pod,
      name: pod.metadata.name,
      namespace,
      nodeUid: ids.node,
      specHash: hash(pod.spec),
      ownerChain: [{ kind: "Cluster", name: "database", uid: ids.cluster }],
    },
    ids.attempt,
  );
  const cohort = {
    version: 1,
    environmentId: ids.environment,
    regionId: ids.region,
    specHash: binding.specHash,
    runEpoch: "1",
    namespaceUid: ids.namespace,
    nodes: [{ name: "node-a", uid: ids.node, bootId: ids.boot }],
  };
  const retirementBinding = {
    ...binding,
    operationId: ids.stop,
    projectId: ids.project,
    namespace,
    namespaceUid: ids.namespace,
    clusterUid: ids.cluster,
    quotaUid: ids.quota,
    nodeCohort: { uid: ids.cohort, hash: hash(cohort) },
  };
  journal.bindRuntime({
    namespaceUid: ids.namespace,
    quotaUid: ids.quota,
    nodeCohort: { uid: ids.cohort, hash: hash(cohort) },
  });
  journal.bindRetirementScope(ids.pod, retirementBinding);
  retirement = new PodRetirementJournal(
    join(directory, "retirement.sqlite"),
    retirementBinding,
    1,
    () => Date.parse("2026-09-30T00:00:03Z"),
  );
  retirement.capture([pod], cohort);
  const terminal = structuredClone(pod);
  terminal.metadata.finalizers = [retirement.finalizer];
  terminal.metadata.deletionTimestamp = "2026-09-30T00:00:01Z";
  terminal.status.phase = "Succeeded";
  const status = terminal.status.containerStatuses[0];
  status.state = {
    terminated: {
      exitCode: 0,
      startedAt: "2026-09-30T00:00:00Z",
      finishedAt: "2026-09-30T00:00:01Z",
      containerID: status.containerID,
    },
  };
  const envelope = {
    version: 1,
    requestId: ids.attempt,
    observerPodUid: ids.stop,
    observerNamespace: "observer",
    observerNodeName: "node-a",
    snapshot: {
      version: 1,
      scope: {
        installationId: binding.installationId,
        regionId: ids.region,
        nodeName: "node-a",
        nodeUid: ids.node,
        expectedBootId: ids.boot,
      },
      bootId: ids.boot,
      startedAt: "2026-09-30T00:00:02.000000000Z",
      finishedAt: "2026-09-30T00:00:02.100000000Z",
      sandboxes: [],
      containers: [],
    },
  };
  assert.ok(
    retirement.prove(terminal, { envelope, probeHash: hash(envelope) }),
    "the existing proof producer persists terminal+CRI custody",
  );
  assert.equal(
    journal.retireConsumer("database-0", ids.pod, retirement),
    true,
    "trusted original physical proof seals one-use slot retirement without releasing compute or storage",
  );
  assert.equal(journal.snapshot().slots[0].retirements[0].podUid, ids.pod);
  assert.equal(journal.snapshot().phase, "active");
  const sealedRetirement = structuredClone(
    journal.snapshot().slots[0].retirements[0],
  );
  journal.bindRuntime({
    namespaceUid: ids.namespace,
    poolerUid: "80000000-0000-4000-8000-000000000000",
    poolerDeploymentUid: "80000000-0000-4000-8000-000000000001",
  });
  assert.deepEqual(
    journal.snapshot().slots[0].retirements,
    [sealedRetirement],
    "later workload identities cannot alter independently sealed predecessor custody",
  );
  journal.close();
  journal = CapacityJournal.openExisting(path);
  assert.equal(journal.retireConsumer("database-0", ids.pod, retirement), true);
  assert.deepEqual(
    journal.snapshot().slots[0].retirements,
    [sealedRetirement],
    "identical physical proof replay cannot issue a second successor receipt",
  );
  assert.throws(
    () =>
      journal.observeComputeConsumer(
        "database-0",
        {
          uid: ids.pod,
          name: pod.metadata.name,
          namespace,
          nodeUid: ids.node,
          specHash: hash(pod.spec),
          ownerChain: [{ kind: "Cluster", name: "database", uid: ids.cluster }],
        },
        ids.attempt,
      ),
    /capacity/,
    "retired consumers cannot re-enter through an idempotent observation branch",
  );

  const missingProof = new PodRetirementJournal(
    join(directory, "missing-proof.sqlite"),
    retirementBinding,
    1,
    () => Date.parse("2026-09-30T00:00:03Z"),
  );
  try {
    journal.beginComputeRelease();
    assert.throws(
      () => journal.authorizeComputeRelease(missingProof),
      /capacity/,
      "no missing proof or timeout releases compute",
    );
    assert.throws(
      () => journal.admitAttempt({ ...attempt, id: ids.stop }),
      /capacity/,
      "closed allocation refuses new admissions",
    );
  } finally {
    missingProof.close();
  }
  const release = journal.authorizeComputeRelease(retirement);
  assert.deepEqual(release, [
    observed(0).reservation,
    observed(1).reservation,
    poolerHold.reservation,
  ]);
  const originalStorage = journal.snapshot().slots.map((slot) => slot.storage);
  for (const slot of journal.snapshot().slots)
    journal.recordComputeReleased(slot.plan.id, slot.reservation.uid);
  journal.close();
  journal = CapacityJournal.openExisting(path);
  assert.equal(journal.snapshot().phase, "released");
  assert.deepEqual(
    journal.snapshot().slots.map((slot) => slot.storage),
    originalStorage,
    "compute retirement never deletes or invents free storage",
  );
  assert.throws(
    () => CapacityJournal.openExisting(join(directory, "missing.sqlite")),
    /capacity/,
  );
});
