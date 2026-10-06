// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  NodeStorageTrial,
  nodeStorageTrialTransition,
} from "@pgcf/contracts/node-bootstrap";
import {
  storageTrialObjects,
  storageTrialWriteScript,
  storageDeleteRequest,
  publishNodeStorageCapacity,
} from "../src/storage-capacity.ts";
import { digest } from "../src/bootstrap.ts";
import { storageReadbackFixture } from "./storage-readback.fixture.ts";
import { storageCapacityFixture } from "./storage-capacity.fixture.ts";

function trialFixture() {
  const f = storageReadbackFixture();
  const trialHash = digest(randomBytes(32));
  const script = storageTrialWriteScript(trialHash);
  const trial = NodeStorageTrial.parse({
    version: 1,
    input_hash: f.input.input_hash,
    node_uid: f.nodeUid,
    cluster_uid: f.clusterUid,
    storage_namespace_uid: f.namespaceUid,
    lvmnode_uid: f.lvmnodeUid,
    vg_uuid: f.vgUuid,
    pv_uuid: f.pvUuid,
    device: f.volume.spec.location,
    partition_uuid: f.partitionUuid,
    total_bytes: f.total,
    extent_size_bytes: f.extent,
    runs: [
      {
        namespace_name: `pgcf-storage-${f.input.input_hash.slice(0, 20)}-1`,
        trial_sha256: trialHash,
        image: `fixture.invalid/postgres@sha256:${digest(randomBytes(32))}`,
        data_sha256: script.sha256,
        volume_bytes: 1024 ** 3,
        stage: "intent",
        namespace_uid: null,
        pvc_uid: null,
        pod_uid: null,
        pv_name: null,
        pv_uid: null,
        volume_handle: null,
        lvmvolume_uid: null,
        lv_uuid: null,
        before: {
          observed_at: new Date().toISOString(),
          node_uid: f.nodeUid,
          lvmnode_uid: f.lvmnodeUid,
          resource_version: "29",
          vg_uuid: f.vgUuid,
          size: f.total,
          free: f.total,
        },
        allocated: null,
        after: null,
        written_at: null,
        published_at: null,
      },
    ],
  });
  return { ...f, trial, script };
}

test("trial grants bind one delayed 1Gi volume to the quarantined target without broad Pod privileges", () => {
  const f = trialFixture();
  const resources = storageTrialObjects(f.input, f.trial);
  const pod = resources.find((value) => value.kind === "Pod")!;
  const pvc = resources.find(
    (value) => value.kind === "PersistentVolumeClaim",
  )!;
  const spec = pod.spec as Record<string, unknown>;
  assert.equal(
    spec.nodeName,
    undefined,
    "WaitForFirstConsumer must use the scheduler",
  );
  assert.equal(spec.automountServiceAccountToken, false);
  assert.deepEqual(spec.tolerations, [
    {
      key: "pgcf.io/quarantine",
      operator: "Equal",
      value: "bootstrap",
      effect: "NoSchedule",
    },
  ]);
  assert.equal(JSON.stringify(spec).includes(f.input.spec.hostname), true);
  assert.equal(JSON.stringify(spec).includes('"privileged":true'), false);
  assert.equal(JSON.stringify(pvc).includes('"storage":"1Gi"'), true);
  assert.equal(
    resources.some((value) => value.kind === "NetworkPolicy"),
    true,
  );
});

test("the actual bounded trial write script reads its bytes back before reporting the digest", async () => {
  const f = trialFixture();
  const dir = await mkdtemp(join(tmpdir(), "pgcf-storage-script-test-"));
  try {
    const script = storageTrialWriteScript(f.trial.runs[0]!.trial_sha256, dir);
    const result = spawnSync("sh", ["-ec", script.script], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `pgcf_storage_proof ${script.sha256}`);
    assert.equal(digest(await readFile(join(dir, "proof"))), script.sha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cleanup uses actual API UID and resourceVersion preconditions with ordinary graceful deletion", () => {
  const metadata = { uid: randomUUID(), resourceVersion: "73" };
  const request = storageDeleteRequest(
    "/api/v1/namespaces/owned/pods/proof",
    metadata,
  );
  assert.deepEqual(request.args, [
    "delete",
    "--raw=/api/v1/namespaces/owned/pods/proof",
    "--filename=-",
  ]);
  const body = JSON.parse(request.stdin);
  assert.deepEqual(body.preconditions, metadata);
  assert.equal(body.gracePeriodSeconds, undefined);
  assert.equal(
    request.args.some((value: string) => /force|finalizer|all/.test(value)),
    false,
  );
});

test("trial history cannot replace a recorded physical LV, erase an owned namespace or rewind", () => {
  const f = trialFixture(),
    next = structuredClone(f.trial);
  next.runs[0]!.namespace_uid = randomUUID();
  next.runs[0]!.lv_uuid = f.lvUuid;
  assert.equal(
    nodeStorageTrialTransition(f.trial, next, f.input.input_hash),
    true,
  );
  const foreign = structuredClone(next);
  foreign.runs[0]!.lv_uuid = digest(randomBytes(32));
  assert.equal(
    nodeStorageTrialTransition(next, foreign, f.input.input_hash),
    false,
  );
  foreign.runs[0]!.namespace_uid = null;
  assert.equal(
    nodeStorageTrialTransition(next, foreign, f.input.input_hash),
    false,
  );
  assert.equal(
    nodeStorageTrialTransition(next, null, f.input.input_hash),
    false,
  );
});

test("publishes the actual VG total only after write proof and physical plus Kubernetes reclamation", async () => {
  const f = storageCapacityFixture();
  f.loseCreate();
  await publishNodeStorageCapacity(f.input, f.commands);
  const trial = f.trial()!,
    run = trial.runs[0]!;
  assert.equal(run.stage, "published");
  assert.equal(run.lv_uuid, f.lvUuid);
  assert.equal(run.before.free - run.allocated!.free, 1024 ** 3);
  assert.equal(run.after!.free, f.total);
  assert.equal(f.logical_volumes.length, 0);
  assert.equal(f.objects.size, 0);
  assert.equal(
    (f.node.metadata as Record<string, unknown>).annotations &&
      (
        (f.node.metadata as Record<string, unknown>).annotations as Record<
          string,
          unknown
        >
      )["pgcf.io/storage-gib-total"],
    String(Math.floor(f.total / 1024 ** 3)),
  );
  assert.notEqual(
    Math.floor(f.total / 1024 ** 3),
    f.input.spec.storage.lvm_gib,
  );
  assert.equal(
    f.mutations.filter((value) => value.args[0] === "create").length,
    5,
    "uncertain create is read back, not repeated",
  );
  const before = f.mutations.length;
  await publishNodeStorageCapacity(f.input, f.commands);
  assert.equal(
    f.mutations.length,
    before,
    "a confirmed publication resumes without a second allocation or patch",
  );
});

test("metadata deletion alone cannot publish or complete a physically retained LV", async () => {
  const f = storageCapacityFixture();
  f.retainPhysical();
  await assert.rejects(
    publishNodeStorageCapacity(f.input, f.commands),
    /physical_lv_still_present/,
  );
  assert.equal(f.trial()!.runs[0]!.stage, "cleanup");
  assert.equal(f.logical_volumes.length, 1);
  assert.equal(
    f.mutations.some(
      (value) => value.args[0] === "patch" && value.args[1] === "node",
    ),
    false,
  );
  assert.ok(f.trial()!.runs[0]!.lv_uuid);
});

test("an interruption keeps exact owned UIDs and a fresh resume uses the same PVC and Pod", async () => {
  const f = storageCapacityFixture();
  f.stopAfterPod();
  await assert.rejects(
    publishNodeStorageCapacity(f.input, f.commands),
    /interrupted_after_owned_pod/,
  );
  const first = structuredClone(f.trial()!.runs[0]!);
  assert.ok(first.pvc_uid && first.pod_uid && first.namespace_uid);
  const commands = {
    ...f.commands,
    signal: new AbortController().signal,
    saveTrial: async (trial: NodeStorageTrial) => {
      // Keep the same persisted fixture custody while removing only the test interruption hook.
      const restore = f.commands.saveTrial;
      await restore(trial);
    },
  };
  await publishNodeStorageCapacity(f.input, commands);
  const last = f.trial()!.runs[0]!;
  assert.equal(last.pvc_uid, first.pvc_uid);
  assert.equal(last.pod_uid, first.pod_uid);
  assert.equal(last.namespace_uid, first.namespace_uid);
  assert.equal(last.stage, "published");
  assert.equal(
    f.mutations.filter((value) => value.args[0] === "create").length,
    5,
  );
});

test("cleanup refuses a replaced physical LV or CSI object before changing reclaim policy or deleting the PVC", async () => {
  for (const replacement of ["physical", "csi"]) {
    const f = storageCapacityFixture();
    f.afterWritten(() => {
      if (replacement === "physical")
        f.lv.spec.uuid =
          f.lvUuid[0] === "a"
            ? "b" + f.lvUuid.slice(1)
            : "a" + f.lvUuid.slice(1);
      else
        (
          f.get("LVMVolume", f.trial()!.runs[0]!.volume_handle!, "openebs")!
            .metadata as Record<string, unknown>
        ).uid = randomUUID();
    });
    await assert.rejects(
      publishNodeStorageCapacity(f.input, f.commands),
      /storage_trial_(physical_volume_changed|volume_not_owned)/,
    );
    assert.equal(
      f.mutations.some(
        (value) =>
          value.args[0] === "patch" && value.args[1] === "persistentvolume",
      ),
      false,
    );
    assert.equal(
      f.mutations.some((value) =>
        value.args.some((arg) => arg.includes("/persistentvolumeclaims/")),
      ),
      false,
    );
    assert.equal(f.logical_volumes.length, 1);
  }
});

test("storage patches use bounded literal JSON rather than reopening a piped /dev/stdin", async () => {
  const f = storageCapacityFixture();
  await publishNodeStorageCapacity(f.input, f.commands);
  const patches = f.mutations.filter((value) => value.args[0] === "patch");
  assert.equal(patches.length, 2);
  for (const patch of patches) {
    assert.equal(
      patch.args.some((arg) => arg.includes("/dev/stdin")),
      false,
    );
    assert.ok(patch.args.includes("--patch"));
    assert.ok(
      Array.isArray(JSON.parse(patch.args[patch.args.indexOf("--patch") + 1]!)),
    );
  }
});

test("a cleanup resume recovers a late Retain allocation through the exact recorded PVC UID", async () => {
  const f = storageCapacityFixture();
  f.stopAfterPod();
  await assert.rejects(
    publishNodeStorageCapacity(f.input, f.commands),
    /interrupted_after_owned_pod/,
  );
  const saved = structuredClone(f.trial()!);
  saved.runs[0]!.stage = "cleanup";
  await f.commands.saveTrial(saved);
  const claim = f.get(
    "PersistentVolumeClaim",
    "proof",
    saved.runs[0]!.namespace_name,
  )!;
  (claim.status as Record<string, unknown>).phase = "Pending";
  const commands = { ...f.commands, signal: new AbortController().signal };
  await publishNodeStorageCapacity(f.input, commands);
  assert.equal(f.trial()!.runs.length, 2);
  assert.equal(f.trial()!.runs[0]!.stage, "reclaimed");
  assert.equal(f.trial()!.runs[0]!.pvc_uid, saved.runs[0]!.pvc_uid);
  assert.ok(f.trial()!.runs[0]!.pv_uid && f.trial()!.runs[0]!.lv_uuid);
  assert.equal(f.trial()!.runs[1]!.stage, "published");
  assert.equal(f.objects.size, 0);
});

test("a published resume refuses a missing or replaced publication proof marker", async () => {
  const f = storageCapacityFixture();
  await publishNodeStorageCapacity(f.input, f.commands);
  const annotations = (f.node.metadata as Record<string, unknown>)
    .annotations as Record<string, unknown>;
  delete annotations["pgcf.io/storage-proof"];
  const count = f.mutations.length;
  await assert.rejects(
    publishNodeStorageCapacity(f.input, f.commands),
    /storage_publish_readback_failed/,
  );
  assert.equal(f.mutations.length, count);
});

test("an orphan Retain PV remains recoverable after its exact owned PVC has already disappeared", async () => {
  const f = storageCapacityFixture();
  f.stopAfterPod();
  await assert.rejects(
    publishNodeStorageCapacity(f.input, f.commands),
    /interrupted_after_owned_pod/,
  );
  const saved = structuredClone(f.trial()!);
  saved.runs[0]!.stage = "cleanup";
  await f.commands.saveTrial(saved);
  f.objects.delete(
    `PersistentVolumeClaim/${saved.runs[0]!.namespace_name}/proof`,
  );
  await publishNodeStorageCapacity(f.input, {
    ...f.commands,
    signal: new AbortController().signal,
  });
  assert.equal(f.trial()!.runs.length, 2);
  assert.equal(f.trial()!.runs[0]!.stage, "reclaimed");
  assert.equal(
    f.trial()!.runs[0]!.volume_handle,
    `pvc-${saved.runs[0]!.pvc_uid}`,
  );
  assert.equal(f.trial()!.runs[1]!.stage, "published");
  assert.equal(f.objects.size, 0);
});

test("expiry during awaited authorization refuses the following native mutation", async (t) => {
  const f = storageCapacityFixture();
  let clock = 0,
    armed = false;
  t.mock.method(performance, "now", () => clock);
  const commands = {
    ...f.commands,
    authorize: async () => {
      if (armed) clock = 300_000;
      return f.commands.authorize();
    },
    kube: async (...args: Parameters<typeof f.commands.kube>) => {
      const result = await f.commands.kube(...args);
      if (
        args[0][0] === "get" &&
        args[0][1] === "namespace" &&
        args[0][2]?.startsWith("pgcf-storage-") &&
        !result.stdout
      )
        armed = true;
      return result;
    },
  };
  await assert.rejects(
    publishNodeStorageCapacity(f.input, commands),
    /storage_trial_deadline/,
  );
  assert.equal(f.mutations.length, 0);
  assert.equal(f.trial()!.runs[0]!.stage, "intent");
});
