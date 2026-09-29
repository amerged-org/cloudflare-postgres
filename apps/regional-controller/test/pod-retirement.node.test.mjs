// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PodRetirementJournal } from "../src/pod-retirement.ts";
import { canonicalCohort, nodeCohortAffinity } from "../src/node-cohort.ts";
import { podRetirementAdapter } from "../src/pod-retirement-kubernetes.ts";
import { ownedInventory } from "../src/owned-stop.ts";
const hash = (value) =>
  createHash("sha256").update(canonicalCohort(value)).digest("hex");
const ids = {
  env: "11111111-1111-4111-8111-111111111111",
  region: "22222222-2222-4222-8222-222222222222",
  namespace: "33333333-3333-4333-8333-333333333333",
  cluster: "44444444-4444-4444-8444-444444444444",
  quota: "55555555-5555-4555-8555-555555555555",
  cohort: "66666666-6666-4666-8666-666666666666",
  node: "77777777-7777-4777-8777-777777777777",
  boot: "88888888-8888-4888-8888-888888888888",
  op: "99999999-9999-4999-8999-999999999999",
  pod: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const namespace = `pgcf-${ids.env.replaceAll("-", "")}`;
const cohort = {
  version: 1,
  environmentId: ids.env,
  regionId: ids.region,
  specHash: "a".repeat(64),
  runEpoch: "1",
  namespaceUid: ids.namespace,
  nodes: [{ name: "node-a", uid: ids.node, bootId: ids.boot }],
};
const binding = {
  operationId: ids.op,
  installationId: "installation-test",
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  environmentId: ids.env,
  regionId: ids.region,
  specRevision: 1,
  specHash: "a".repeat(64),
  runEpoch: "1",
  namespace,
  namespaceUid: ids.namespace,
  clusterUid: ids.cluster,
  quotaUid: ids.quota,
  nodeCohort: { uid: ids.cohort, hash: hash(cohort) },
};
const sourcePod = () => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: "database-1",
    namespace,
    uid: ids.pod,
    resourceVersion: "1",
    ownerReferences: [
      {
        kind: "Cluster",
        name: "database",
        uid: ids.cluster,
        apiVersion: "postgresql.cnpg.io/v1",
        controller: true,
      },
    ],
  },
  spec: {
    nodeName: "node-a",
    restartPolicy: "Always",
    containers: [{ name: "postgres", image: "postgres@sha256:test" }],
    initContainers: [
      {
        name: "archive",
        restartPolicy: "Always",
        image: "archive@sha256:test",
      },
    ],
  },
  status: {
    phase: "Running",
    containerStatuses: [
      {
        name: "postgres",
        restartCount: 0,
        containerID: `containerd://${"c".repeat(64)}`,
        state: { running: { startedAt: "2026-09-29T00:00:00Z" } },
      },
    ],
    initContainerStatuses: [
      {
        name: "archive",
        restartCount: 1,
        containerID: `containerd://${"d".repeat(64)}`,
        state: { running: { startedAt: "2026-09-29T00:00:00Z" } },
      },
    ],
  },
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pgcf-pod-retirement-")),
    path = join(dir, "journal.sqlite");
  let journal = new PodRetirementJournal(path, binding, 1, () =>
    Date.parse("2026-09-29T00:00:03Z"),
  );
  t.after(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    path,
    get journal() {
      return journal;
    },
    reopen() {
      journal.close();
      journal = new PodRetirementJournal(path, binding, 2, () =>
        Date.parse("2026-09-29T00:00:03Z"),
      );
      return journal;
    },
  };
}
function retained(pod, finalizer) {
  const result = structuredClone(pod);
  result.metadata.finalizers = [finalizer];
  result.metadata.deletionTimestamp = "2026-09-29T00:00:01Z";
  result.status.phase = "Succeeded";
  for (const status of [
    ...result.status.containerStatuses,
    ...result.status.initContainerStatuses,
  ])
    status.state = {
      terminated: {
        exitCode: 0,
        startedAt: "2026-09-29T00:00:00Z",
        finishedAt: "2026-09-29T00:00:01Z",
        containerID: status.containerID,
      },
    };
  return result;
}
function observation() {
  const startNs = String(
      BigInt(Date.parse("2026-09-29T00:00:00Z")) * 1_000_000n,
    ),
    endNs = String(BigInt(Date.parse("2026-09-29T00:00:01Z")) * 1_000_000n);
  const scope = {
    installationId: binding.installationId,
    regionId: ids.region,
    nodeName: "node-a",
    nodeUid: ids.node,
    expectedBootId: ids.boot,
  };
  const envelope = {
    version: 1,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    observerPodUid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    observerNamespace: "observer",
    observerNodeName: "node-a",
    snapshot: {
      version: 1,
      scope,
      bootId: ids.boot,
      startedAt: "2026-09-29T00:00:02.000000000Z",
      finishedAt: "2026-09-29T00:00:02.100000000Z",
      sandboxes: [
        {
          id: "e".repeat(64),
          podUid: ids.pod,
          namespace,
          name: "database-1",
          state: "not_ready",
          createdAtUnixNs: startNs,
        },
      ],
      containers: [
        {
          id: "c".repeat(64),
          sandboxId: "e".repeat(64),
          podUid: ids.pod,
          namespace,
          name: "postgres",
          attempt: 0,
          state: "exited",
          createdAtUnixNs: startNs,
          startedAtUnixNs: startNs,
          finishedAtUnixNs: endNs,
        },
        {
          id: "d".repeat(64),
          sandboxId: "e".repeat(64),
          podUid: ids.pod,
          namespace,
          name: "archive",
          attempt: 1,
          state: "exited",
          createdAtUnixNs: startNs,
          startedAtUnixNs: startNs,
          finishedAtUnixNs: endNs,
        },
      ],
    },
  };
  return { envelope, probeHash: hash(envelope) };
}

function ownedFixture(pod) {
  const labels = {
    "app.kubernetes.io/managed-by": "cloudflare-postgres",
    "pgcf.io/environment-id": ids.env,
    "pgcf.io/region-id": ids.region,
  };
  const annotations = {
    "pgcf.io/spec-hash": binding.specHash,
    "pgcf.io/run-epoch": "1",
  };
  const metadata = (name, uid) => ({
    name,
    uid,
    namespace,
    labels,
    annotations,
    resourceVersion: "1",
  });
  return {
    namespace: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { ...metadata(namespace, ids.namespace), namespace: undefined },
    },
    cluster: {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: {
        ...metadata("database", ids.cluster),
        annotations: {
          ...annotations,
          "cnpg.io/hibernation": "on",
          "pgcf.io/node-cohort-uid": ids.cohort,
          "pgcf.io/node-cohort-hash": binding.nodeCohort.hash,
        },
      },
      spec: { affinity: { nodeAffinity: nodeCohortAffinity(cohort) } },
    },
    quota: {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata("database-resources", ids.quota),
      spec: { hard: { pods: "0" } },
    },
    nodeCohort: {
      apiVersion: "v1",
      kind: "ConfigMap",
      immutable: true,
      metadata: {
        ...metadata("execution-nodes", ids.cohort),
        ownerReferences: [
          {
            kind: "Namespace",
            apiVersion: "v1",
            name: namespace,
            uid: ids.namespace,
            controller: true,
          },
        ],
      },
      data: { "cohort.json": canonicalCohort(cohort) },
    },
    nodes: [
      {
        apiVersion: "v1",
        kind: "Node",
        metadata: { name: "node-a", uid: ids.node },
        status: { nodeInfo: { bootID: ids.boot } },
      },
    ],
    pods: [pod],
    pvcs: [],
    pvs: [],
    poolers: [],
    deployments: [],
  };
}

test("durably seals the original Pod roster and replays retirement evidence after restart or lost release without reconstructing empty history", (t) => {
  const f = fixture(t),
    pod = sourcePod();
  const captured = f.journal.capture([pod], cohort);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].uid, ids.pod);
  assert.equal(captured[0].nodeUid, ids.node);
  assert.deepEqual(captured[0].init, [
    { name: "archive", nativeSidecar: true, restartCount: 1 },
  ]);
  assert.equal(statSync(f.path).mode & 0o077, 0);
  f.reopen();
  assert.deepEqual(f.journal.roster, captured);
  const terminal = retained(pod, f.journal.finalizer),
    proof = f.journal.prove(terminal, observation());
  assert.ok(
    proof,
    "qualified terminal+CRI acknowledgement must persist before release",
  );
  f.reopen();
  assert.deepEqual(f.journal.proof(ids.pod), proof);
  terminal.metadata.finalizers = [];
  assert.deepEqual(
    f.journal.prove(terminal, observation()),
    proof,
    "lost finalizer-release response cannot replace the original proof",
  );
  const contradictory = structuredClone(terminal);
  contradictory.status.phase = "Running";
  contradictory.status.containerStatuses[0].state = {
    running: { startedAt: "2026-09-29T00:00:00Z" },
  };
  const stale = observation();
  stale.envelope.snapshot.startedAt = "2026-09-28T23:59:00.000000000Z";
  stale.envelope.snapshot.finishedAt = "2026-09-28T23:59:00.100000000Z";
  stale.probeHash = hash(stale.envelope);
  const currentContradiction = f.journal.prove(contradictory, observation()),
    staleAcknowledgement = f.journal.prove(terminal, stale);
  assert.deepEqual(
    {
      currentContradiction: currentContradiction !== null,
      staleAcknowledgement: staleAcknowledgement !== null,
    },
    { currentContradiction: false, staleAcknowledgement: false },
  );
  assert.deepEqual(
    f.journal.proof(ids.pod),
    proof,
    "refusing contradictory current evidence preserves the historical record",
  );
  assert.throws(() => f.journal.capture([], cohort), /retirement/);
  assert.deepEqual(f.journal.roster, captured);
  assert.throws(
    () => new PodRetirementJournal(join(f.dir, "missing.sqlite"), binding, 2),
    /history/,
  );
});

test("requires scoped deleting-UID terminal states including native init sidecars and exact exited CRI evidence while refusing stale or incomplete ownership", async (t) => {
  const f = fixture(t),
    pod = sourcePod();
  f.journal.capture([pod], cohort);
  const terminal = retained(pod, f.journal.finalizer);
  const phaseOnly = structuredClone(terminal);
  phaseOnly.status.initContainerStatuses[0].state = {
    running: { startedAt: "2026-09-29T00:00:00Z" },
  };
  assert.equal(f.journal.prove(phaseOnly, observation()), null);
  const wrongBirth = observation();
  wrongBirth.envelope.snapshot.bootId = ids.node;
  wrongBirth.probeHash = hash(wrongBirth.envelope);
  assert.equal(f.journal.prove(terminal, wrongBirth), null);
  const active = observation();
  active.envelope.snapshot.containers[1].state = "running";
  active.envelope.snapshot.containers[1].finishedAtUnixNs = "0";
  active.probeHash = hash(active.envelope);
  assert.equal(f.journal.prove(terminal, active), null);
  const forgedHash = { ...observation(), probeHash: "f".repeat(64) };
  assert.equal(f.journal.prove(terminal, forgedHash), null);
  const replacement = structuredClone(terminal);
  replacement.metadata.uid = ids.cluster;
  assert.equal(f.journal.prove(replacement, observation()), null);
  assert.equal(f.journal.proof(ids.pod), null);
  const collected = observation();
  collected.envelope.snapshot.sandboxes = [];
  collected.envelope.snapshot.containers = [];
  collected.probeHash = hash(collected.envelope);
  const absentProof = f.journal.prove(terminal, collected);
  assert.ok(
    absentProof,
    "retained exact terminated groups plus a complete CRI snapshot can acknowledge fully collected Pod objects",
  );
  assert.deepEqual(absentProof.runtime.sandboxes, []);
  assert.deepEqual(absentProof.runtime.containers, []);
  const proof = f.journal.prove(terminal, observation());
  assert.ok(proof);
  assert.match(proof.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(proof.podUid, ids.pod);
  const contradictory = structuredClone(terminal);
  contradictory.status.phase = "Failed";
  contradictory.status.containerStatuses[0].state = {
    running: { startedAt: "2026-09-29T00:00:00Z" },
  };
  const inventory = ownedFixture(contradictory);
  assert.equal(
    ownedInventory(inventory, binding),
    true,
    "release regression requires the actual valid ownership barriers",
  );
  let patches = 0;
  const adapter = podRetirementAdapter(
    binding,
    ids.op,
    {
      owners: async () => inventory,
      readPod: async () => structuredClone(contradictory),
      patchPod: async () => {
        patches++;
        contradictory.metadata.finalizers = [];
      },
    },
    () => {},
  );
  await assert.rejects(
    adapter.releasePod(f.journal.roster[0], f.journal.finalizer, proof),
    /retirement/,
  );
  assert.equal(
    patches,
    0,
    "fresh Running container status must prevent finalizer removal",
  );
});
