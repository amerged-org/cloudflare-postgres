// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { storageReadbackFixture as state } from "./storage-readback.fixture.ts";
import { readStorageFacts } from "../src/storage-readback.ts";
import { BootstrapError } from "../src/bootstrap.ts";

const gi = 1024 ** 3;

test("binds live physical PV/VG/LV facts to a quarantined Node and CSI owner without using nominal GiB", async () => {
  const f = state(),
    facts = await readStorageFacts(f.input, f.commands);
  assert.equal(facts.cluster_uid, f.clusterUid);
  assert.equal(facts.storage_namespace_uid, f.namespaceUid);
  assert.equal(facts.node_uid, f.nodeUid);
  assert.equal(facts.lvmnode_uid, f.lvmnodeUid);
  assert.equal(facts.vg_uuid, f.vgUuid);
  assert.equal(facts.pv_uuid, f.pvUuid);
  assert.equal(facts.total_bytes, f.total);
  assert.notEqual(facts.total_bytes, f.input.spec.storage.lvm_gib * gi);
  assert.equal(facts.free_bytes, f.free);
  assert.equal(facts.extent_size_bytes, f.extent);
  assert.deepEqual(facts.raw_partition, {
    device: "/dev/vda6",
    parent_device: "/dev/vda",
    partition_uuid: f.partitionUuid,
    partition_index: 6,
    size_bytes: 96 * gi,
  });
  assert.deepEqual(facts.logical_volumes, [
    {
      name: "trial",
      uuid: f.lvUuid,
      path: "/dev/pgcf/trial",
      size_bytes: gi,
      active: true,
    },
  ]);
  assert.deepEqual(facts.node, f.node);
  assert.deepEqual(facts.lvmnode, f.lvmnode);
  assert.ok(f.calls.every((args) => ["get", "version"].includes(args[0]!)));
});

test("rejects foreign CSI ownership and an absent quarantine before physical storage reads", async () => {
  const f = state();
  f.lvmnode.metadata.ownerReferences[0]!.uid = randomUUID();
  await assert.rejects(
    readStorageFacts(f.input, f.commands),
    /storage_lvmnode_owner_mismatch/,
  );
  assert.ok(!f.calls.some((args) => args.includes("lvmphysicalvolumestatus")));
  f.lvmnode.metadata.ownerReferences[0]!.uid = f.nodeUid;
  f.node.spec.taints = [];
  await assert.rejects(
    readStorageFacts(f.input, f.commands),
    /storage_node_identity_mismatch/,
  );
});

test("rejects a raw partition on another disk and a PV whose device is outside that partition", async () => {
  const f = state();
  f.volume.spec.parentLocation = "/dev/vdb";
  await assert.rejects(
    readStorageFacts(f.input, f.commands),
    /storage_raw_partition_mismatch/,
  );
  f.volume.spec.parentLocation = "/dev/vda";
  f.pv.spec.device = "/dev/vda7";
  await assert.rejects(
    readStorageFacts(f.input, f.commands),
    /storage_physical_pv_mismatch/,
  );
});

test("CSI lag and a changing physical VG remain unknown instead of publishing configured capacity", async () => {
  const f = state();
  f.lvmnode.volumeGroups[0]!.free = String(f.total);
  await assert.rejects(
    readStorageFacts(f.input, f.commands),
    /storage_capacity_unsettled/,
  );
  f.lvmnode.volumeGroups[0]!.free = String(f.free);
  let vgReads = 0;
  const commands = {
    ...f.commands,
    talos: async (args: string[]) => {
      if (args.includes("lvmvolumegroupstatus") && ++vgReads === 2) {
        f.vg.spec.free = String(f.free - gi);
        f.vg.spec.freeExtentCount = String((f.free - gi) / f.extent);
        f.vg.spec.seqNo = "3";
      }
      return f.commands.talos(args);
    },
  };
  await assert.rejects(
    readStorageFacts(f.input, commands),
    /storage_capacity_unsettled/,
  );
});

test("a successful empty LV inventory requires a matching zero-count, fully free physical VG", async () => {
  const f = state();
  f.vg.spec.lvCount = "0";
  f.vg.spec.free = String(f.total);
  f.vg.spec.freeExtentCount = f.vg.spec.extentCount;
  f.pv.spec.free = String(f.total);
  f.pv.spec.used = "0";
  f.pv.spec.peAllocCount = "0";
  f.lvmnode.volumeGroups[0]!.free = String(f.total);
  const commands = {
    ...f.commands,
    talos: async (args: string[]) => {
      const result = await f.commands.talos(args);
      return args.includes("lvmlogicalvolumestatus")
        ? { ...result, stdout: "" }
        : result;
    },
  };
  assert.deepEqual(
    (await readStorageFacts(f.input, commands)).logical_volumes,
    [],
  );
  f.vg.spec.lvCount = "1";
  await assert.rejects(
    readStorageFacts(f.input, commands),
    /storage_capacity_unsettled/,
  );
});

test("missing measurements and cluster authority changes stop readback before any mutation", async () => {
  const f = state();
  f.vg.spec.free = "unknown";
  await assert.rejects(
    readStorageFacts(f.input, f.commands),
    /storage_physical_lvm_invalid/,
  );
  f.vg.spec.free = String(f.free);
  let checks = 0;
  await assert.rejects(
    readStorageFacts(f.input, {
      ...f.commands,
      authorize: async () => {
        await f.commands.authorize();
        return ++checks > 3 ? randomUUID() : f.clusterUid;
      },
    }),
    /storage_cluster_identity_mismatch/,
  );
});

test("independent storage readbacks overlap in bounded batches and use exact REST identities", async () => {
  const f = state();
  let active = 0,
    peak = 0,
    simulatedReadMilliseconds = 0;
  const delayed = async (
    read: () => Promise<{ exit_code: number; stdout: string }>,
  ) => {
    if (active === 0) simulatedReadMilliseconds += 20_000;
    active++;
    peak = Math.max(peak, active);
    try {
      await setImmediate();
      return await read();
    } finally {
      active--;
    }
  };
  const kubeCalls: string[][] = [];
  const facts = await readStorageFacts(f.input, {
    ...f.commands,
    kube: (args) => {
      kubeCalls.push(args);
      return delayed(() => f.commands.kube(args));
    },
    talos: (args) => delayed(() => f.commands.talos(args)),
  });
  assert.equal(facts.node_uid, f.nodeUid);
  assert.equal(active, 0);
  assert.ok(
    simulatedReadMilliseconds < 270_000,
    `read budget consumed: ${simulatedReadMilliseconds}`,
  );
  assert.ok(peak >= 2 && peak <= 4, `observed concurrent reads: ${peak}`);
  assert.ok(
    kubeCalls.every(
      (args) =>
        args.length === 2 && args[0] === "get" && args[1]!.startsWith("--raw="),
    ),
  );
});

test("a rejected storage identity batch settles every sibling before returning", async () => {
  const f = state();
  const failure = new BootstrapError("storage_node_identity_mismatch");
  let active = 0,
    finished = 0;
  await assert.rejects(
    readStorageFacts(f.input, {
      ...f.commands,
      kube: async (args) => {
        active++;
        try {
          if (args[1]?.includes("/api/v1/nodes/")) throw failure;
          await setImmediate();
          return await f.commands.kube(args);
        } finally {
          active--;
          finished++;
        }
      },
    }),
    (error: unknown) => error === failure,
  );
  assert.equal(active, 0);
  assert.equal(finished, 4);
  assert.ok(!f.calls.some((args) => args[0] === "version"));
});
