// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { NodeBootstrapInput } from "@pgcf/contracts/node-bootstrap";
import { fixture } from "./fixture.ts";
import type { StorageReadCommands } from "../src/storage-readback.ts";

const gi = 1024 ** 3;
function lvmUuid() {
  const value = randomBytes(16).toString("hex");
  return [
    value.slice(0, 6),
    value.slice(6, 10),
    value.slice(10, 14),
    value.slice(14, 18),
    value.slice(18, 22),
    value.slice(22, 26),
    value.slice(26),
  ].join("-");
}
export function storageReadbackFixture(
  options: {
    input?: NodeBootstrapInput;
    clusterUid?: string;
  } = {},
) {
  const input = options.input ?? fixture();
  const clusterUid = options.clusterUid ?? randomUUID(),
    namespaceUid = randomUUID(),
    nodeUid = randomUUID(),
    lvmnodeUid = randomUUID(),
    vgUuid = lvmUuid(),
    pvUuid = lvmUuid(),
    lvUuid = lvmUuid(),
    partitionUuid = randomUUID();
  const extent = 4 * 1024 ** 2,
    partitionSize = input.spec.storage.lvm_gib * gi,
    total = partitionSize - extent,
    free = total - gi;
  const node = {
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name: input.spec.hostname,
      uid: nodeUid,
      resourceVersion: "19",
      labels: {
        "pgcf.io/node-id": input.spec.node_id,
        "pgcf.io/region": input.spec.region_id,
        "pgcf.io/provider-instance-id": input.spec.provider_instance_id,
      },
    },
    spec: {
      unschedulable: false,
      taints: [
        { key: "pgcf.io/quarantine", value: "bootstrap", effect: "NoSchedule" },
      ],
    },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      addresses: [{ type: "InternalIP", address: input.spec.hardware.ipv4 }],
    },
  };
  const lvmnode = {
    apiVersion: "local.openebs.io/v1alpha1",
    kind: "LVMNode",
    metadata: {
      name: input.spec.hostname,
      namespace: "openebs",
      uid: lvmnodeUid,
      resourceVersion: "29",
      ownerReferences: [
        {
          apiVersion: "v1",
          kind: "Node",
          name: input.spec.hostname,
          uid: nodeUid,
          controller: true,
        },
      ],
    },
    volumeGroups: [
      {
        name: "pgcf",
        uuid: vgUuid,
        size: String(total),
        free: String(free),
        permissions: 0,
        missingPvCount: 0,
        thinPools: [],
      },
    ],
  };
  const namespace = (name: string, uid: string) => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name, uid },
    status: { phase: "Active" },
  });
  const resource = (
    namespace: string,
    type: string,
    id: string,
    spec: Record<string, unknown>,
  ) => ({
    node: input.spec.hardware.ipv4,
    metadata: { namespace, type, id, version: "1", phase: "running" },
    spec,
  });
  const disk = resource("runtime", "Disks.block.talos.dev", "vda", {
    dev_path: input.spec.hardware.install_disk,
    size: input.spec.hardware.disk_bytes,
  });
  const volume = resource(
    "runtime",
    "VolumeStatuses.block.talos.dev",
    "r-pgcf-lvm",
    {
      phase: "ready",
      type: "partition",
      location: "/dev/vda6",
      parentLocation: "/dev/vda",
      partitionIndex: 6,
      partitionUUID: partitionUuid,
      size: partitionSize,
    },
  );
  const vg = resource(
    "storage",
    "LVMVolumeGroupStatuses.storage.talos.dev",
    "pgcf",
    {
      name: "pgcf",
      uuid: vgUuid,
      format: "lvm2",
      permissions: "writeable",
      exported: "",
      partial: "",
      size: String(total),
      free: String(free),
      extentSize: String(extent),
      extentCount: String(total / extent),
      freeExtentCount: String(free / extent),
      pvCount: "1",
      lvCount: "1",
      snapCount: "0",
      missingPVCount: "0",
      seqNo: "2",
    },
  );
  const pv = resource(
    "storage",
    "LVMPhysicalVolumeStatuses.storage.talos.dev",
    "vda6",
    {
      device: "/dev/vda6",
      vgName: "pgcf",
      uuid: pvUuid,
      format: "lvm2",
      allocatable: "allocatable",
      exported: "",
      missing: "",
      inUse: "used",
      size: String(total),
      deviceSize: String(partitionSize),
      free: String(free),
      used: String(gi),
      peCount: String(total / extent),
      peAllocCount: String(gi / extent),
    },
  );
  const lv = resource(
    "storage",
    "LVMLogicalVolumeStatuses.storage.talos.dev",
    "pgcf-trial",
    {
      path: "/dev/pgcf/trial",
      name: "trial",
      fullName: "pgcf/trial",
      vgName: "pgcf",
      uuid: lvUuid,
      layout: "linear",
      role: "public",
      permissions: "writeable",
      active: "active",
      suspended: "",
      size: String(gi),
      origin: "",
      poolLV: "",
    },
  );
  const disks = [disk],
    volumes = [volume],
    volume_groups = [vg],
    physical_volumes = [pv],
    logical_volumes = [lv];
  const calls: string[][] = [];
  let authorizationCredits = 0;
  const commands: StorageReadCommands = {
    authorize: async () => {
      authorizationCredits++;
      return clusterUid;
    },
    kube: async (args) => {
      assert.ok(
        authorizationCredits > 0,
        "fresh authorization before every native read",
      );
      authorizationCredits--;
      calls.push(args);
      assert.equal(args[0], "get");
      const raw = args.find((arg) => arg.startsWith("--raw="));
      const path = raw?.slice("--raw=".length);
      const value = path
        ? path.endsWith("/namespaces/kube-system")
          ? namespace("kube-system", clusterUid)
          : path.endsWith("/namespaces/openebs")
            ? namespace("openebs", namespaceUid)
            : path.includes("/nodes/")
              ? node
              : lvmnode
        : args.includes("kube-system")
          ? namespace("kube-system", clusterUid)
          : args.includes("openebs") && args.includes("namespace")
            ? namespace("openebs", namespaceUid)
            : args.includes("node")
              ? node
              : lvmnode;
      return { exit_code: 0, stdout: JSON.stringify(value) };
    },
    talos: async (args) => {
      assert.ok(
        authorizationCredits > 0,
        "fresh authorization before every native read",
      );
      authorizationCredits--;
      calls.push(args);
      assert.ok(!args.includes("--insecure"));
      if (args[0] === "version")
        return {
          exit_code: 0,
          stdout: JSON.stringify({ version: { tag: "v1.14.1" } }),
        };
      assert.equal(args[0], "get");
      const values: Record<string, unknown[]> = {
        disks,
        volumestatus: volumes,
        lvmvolumegroupstatus: volume_groups,
        lvmphysicalvolumestatus: physical_volumes,
        lvmlogicalvolumestatus: logical_volumes,
      };
      return {
        exit_code: 0,
        stdout: values[args[1]!]!.map((value) => JSON.stringify(value)).join(
          "\n",
        ),
      };
    },
  };
  return {
    input,
    commands,
    calls,
    node,
    lvmnode,
    disk,
    volume,
    vg,
    pv,
    lv,
    disks,
    volumes,
    volume_groups,
    physical_volumes,
    logical_volumes,
    clusterUid,
    namespaceUid,
    nodeUid,
    lvmnodeUid,
    vgUuid,
    pvUuid,
    lvUuid,
    partitionUuid,
    total,
    free,
    extent,
  };
}
