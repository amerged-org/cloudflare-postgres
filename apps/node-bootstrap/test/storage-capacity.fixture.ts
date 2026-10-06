// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  nodeStorageTrialTransition,
  type NodeBootstrapInput,
  type NodeStorageTrial,
} from "@pgcf/contracts/node-bootstrap";
import type { StorageCapacityCommands } from "../src/storage-capacity.ts";
import { digest } from "../src/bootstrap.ts";
import { storageReadbackFixture } from "./storage-readback.fixture.ts";

type Json = Record<string, unknown>;
const obj = (value: unknown) => value as Json;
export function storageCapacityFixture(
  options: {
    input?: NodeBootstrapInput;
    clusterUid?: string;
  } = {},
) {
  const f = storageReadbackFixture(options),
    abort = new AbortController();
  const image = `fixture.invalid/postgres@sha256:${digest(randomBytes(32))}`;
  const objects = new Map<string, Json>();
  const key = (kind: string, name: string, namespace = "") =>
    `${kind}/${namespace}/${name}`;
  const canonicalKind = (kind: string) =>
    ({
      namespace: "Namespace",
      pod: "Pod",
      persistentvolumeclaim: "PersistentVolumeClaim",
      persistentvolume: "PersistentVolume",
      "lvmvolumes.local.openebs.io": "LVMVolume",
      networkpolicy: "NetworkPolicy",
      resourcequota: "ResourceQuota",
    })[kind] ?? kind;
  const saveObject = (object: Json) => {
    const m = obj(object.metadata);
    objects.set(
      key(String(object.kind), String(m.name), String(m.namespace ?? "")),
      object,
    );
    return object;
  };
  let lvmRevision = 28;
  const physical = (allocated: boolean, handle = "") => {
    const free = f.total - (allocated ? 1024 ** 3 : 0);
    f.vg.spec.free = String(free);
    f.vg.spec.freeExtentCount = String(free / f.extent);
    f.vg.spec.lvCount = allocated ? "1" : "0";
    f.vg.spec.seqNo = allocated ? "3" : "4";
    f.pv.spec.free = String(free);
    f.pv.spec.used = String(f.total - free);
    f.pv.spec.peAllocCount = String((f.total - free) / f.extent);
    f.lvmnode.volumeGroups[0]!.free = String(free);
    f.lvmnode.metadata.resourceVersion = String(++lvmRevision);
    f.logical_volumes.splice(0);
    if (allocated) {
      f.lv.spec.name = handle;
      f.lv.spec.path = `/dev/pgcf/${handle}`;
      f.lv.spec.fullName = `pgcf/${handle}`;
      f.logical_volumes.push(f.lv);
    }
  };
  physical(false);
  f.lvmnode.metadata.resourceVersion = "29";
  let trial: NodeStorageTrial | null = null,
    retainPhysical = false,
    stopAfterPod = false,
    loseCreate = false;
  const saved: NodeStorageTrial[] = [],
    mutations: { args: string[]; body?: Json }[] = [];
  let afterWritten: (() => void) | undefined;
  const get = (kind: string, name: string, namespace = "") =>
    objects.get(key(kind, name, namespace)) ?? null;
  const commands: StorageCapacityCommands = {
    authorize: f.commands.authorize,
    talos: f.commands.talos,
    signal: abort.signal,
    readTrial: async () => (trial ? structuredClone(trial) : null),
    saveTrial: async (next) => {
      assert.equal(
        nodeStorageTrialTransition(trial, next, f.input.input_hash),
        true,
      );
      trial = structuredClone(next);
      saved.push(structuredClone(next));
      if (next.runs.at(-1)!.stage === "written") afterWritten?.();
      if (stopAfterPod && next.runs.at(-1)!.pod_uid)
        abort.abort(new Error("interrupted_after_owned_pod"));
    },
    wait: async () => {
      if (retainPhysical) abort.abort(new Error("physical_lv_still_present"));
      await delay(2);
    },
    kube: async (args, _permit, stdin) => {
      if (args[0] === "get") {
        const kind = args[1]!,
          name = args[2]?.startsWith("--") ? undefined : args[2];
        if (
          kind === "node" ||
          kind === "lvmnodes.local.openebs.io" ||
          (kind === "namespace" &&
            ["openebs", "kube-system"].includes(name ?? ""))
        )
          return f.commands.kube(args);
        if (kind === "configmap" && name === "pgcf-regional")
          return {
            exit_code: 0,
            stdout: JSON.stringify({
              apiVersion: "v1",
              kind: "ConfigMap",
              metadata: {
                name,
                namespace: "pgcf-system",
                uid: randomUUID(),
                resourceVersion: "1",
              },
              data: { PGCF_POSTGRES_IMAGE: image },
            }),
          };
        const at = args.indexOf("--namespace"),
          ns = at < 0 ? "" : args[at + 1]!;
        if (!name)
          return {
            exit_code: 0,
            stdout: JSON.stringify({
              apiVersion: "v1",
              kind: "List",
              items: [...objects.values()].filter(
                (v) =>
                  v.kind ===
                  (kind === "persistentvolumes"
                    ? "PersistentVolume"
                    : "LVMVolume"),
              ),
            }),
          };
        const value = get(canonicalKind(kind), name, ns);
        return { exit_code: 0, stdout: value ? JSON.stringify(value) : "" };
      }
      if (args[0] === "logs")
        return {
          exit_code: 0,
          stdout: `pgcf_storage_proof ${trial!.runs.at(-1)!.data_sha256}\n`,
        };
      mutations.push({ args, ...(stdin ? { body: JSON.parse(stdin) } : {}) });
      if (args[0] === "create") {
        const value = JSON.parse(stdin!) as Json,
          metadata = obj(value.metadata);
        metadata.uid = randomUUID();
        metadata.resourceVersion = "1";
        if (value.kind === "PersistentVolumeClaim")
          value.status = { phase: "Pending" };
        saveObject(value);
        if (value.kind === "Pod") {
          const ns = String(metadata.namespace),
            claim = get("PersistentVolumeClaim", "proof", ns)!,
            cm = obj(claim.metadata);
          const handle = `pvc-${cm.uid}`;
          obj(claim.spec).volumeName = handle;
          claim.status = { phase: "Bound" };
          const nodeAffinity = {
            required: {
              nodeSelectorTerms: [
                {
                  matchExpressions: [
                    {
                      key: "openebs.io/nodename",
                      operator: "In",
                      values: [f.input.spec.hostname],
                    },
                  ],
                },
              ],
            },
          };
          saveObject({
            apiVersion: "v1",
            kind: "PersistentVolume",
            metadata: {
              name: handle,
              uid: randomUUID(),
              resourceVersion: "11",
            },
            spec: {
              capacity: { storage: "1Gi" },
              storageClassName: "pgcf-lvm",
              persistentVolumeReclaimPolicy: "Retain",
              nodeAffinity,
              csi: { driver: "local.csi.openebs.io", volumeHandle: handle },
              claimRef: { name: "proof", namespace: ns, uid: cm.uid },
            },
          });
          saveObject({
            apiVersion: "local.openebs.io/v1alpha1",
            kind: "LVMVolume",
            metadata: {
              name: handle,
              namespace: "openebs",
              uid: randomUUID(),
              resourceVersion: "12",
            },
            spec: {
              ownerNodeID: f.input.spec.hostname,
              volGroup: "pgcf",
              vgPattern: "^pgcf$",
              thinProvision: "no",
              capacity: String(1024 ** 3),
            },
            status: { state: "Ready" },
          });
          obj(value.spec).nodeName = f.input.spec.hostname;
          value.status = {
            phase: "Succeeded",
            containerStatuses: [
              {
                name: "proof",
                imageID: `docker-pullable://${image}`,
                state: { terminated: { exitCode: 0, reason: "Completed" } },
              },
            ],
          };
          physical(true, handle);
        }
        if (loseCreate) {
          loseCreate = false;
          throw new Error("create_response_lost");
        }
        return { exit_code: 0, stdout: JSON.stringify(value) };
      }
      if (args[0] === "patch") {
        const value =
          args[1] === "node" ? f.node : get("PersistentVolume", args[2]!)!;
        const patches = JSON.parse(
          stdin || args[args.indexOf("--patch") + 1]!,
        ) as {
          op: string;
          path: string;
          value: unknown;
        }[];
        for (const patch of patches) {
          const path = patch.path
            .slice(1)
            .split("/")
            .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
          let at = value as Json;
          for (const field of path.slice(0, -1)) at = obj(at[field]);
          const field = path.at(-1)!;
          if (patch.op === "test") assert.deepEqual(at[field], patch.value);
          else at[field] = patch.value;
        }
        obj(value.metadata).resourceVersion = String(
          Number(obj(value.metadata).resourceVersion) + 1,
        );
        if (
          args[1] === "persistentvolume" &&
          obj(value.spec).persistentVolumeReclaimPolicy === "Delete"
        ) {
          const claim = obj(obj(value.spec).claimRef);
          if (
            !get(
              "PersistentVolumeClaim",
              String(claim.name),
              String(claim.namespace),
            )
          ) {
            const handle = String(obj(value.metadata).name);
            objects.delete(key("PersistentVolume", handle));
            objects.delete(key("LVMVolume", handle, "openebs"));
            if (!retainPhysical) physical(false);
          }
        }
        return { exit_code: 0, stdout: JSON.stringify(value) };
      }
      if (args[0] === "delete") {
        const path = args
          .find((a) => a.startsWith("--raw="))!
          .slice(6)
          .split("/");
        const ns = path[4]!,
          kind =
            path[5] === "pods"
              ? "Pod"
              : path[5] === "persistentvolumeclaims"
                ? "PersistentVolumeClaim"
                : "Namespace";
        const name = path[6] ?? ns,
          value = get(kind, name, kind === "Namespace" ? "" : ns);
        if (!value) return { exit_code: 1, stdout: "" };
        const preconditions = obj(JSON.parse(stdin!).preconditions),
          m = obj(value.metadata);
        assert.equal(preconditions.uid, m.uid);
        assert.equal(preconditions.resourceVersion, m.resourceVersion);
        objects.delete(key(kind, name, kind === "Namespace" ? "" : ns));
        if (kind === "PersistentVolumeClaim") {
          const handle = String(obj(value.spec).volumeName),
            pv = get("PersistentVolume", handle);
          assert.equal(obj(pv!.spec).persistentVolumeReclaimPolicy, "Delete");
          objects.delete(key("PersistentVolume", handle));
          objects.delete(key("LVMVolume", handle, "openebs"));
          if (!retainPhysical) physical(false);
        }
        if (kind === "Namespace")
          for (const [k, resource] of objects)
            if (obj(resource.metadata).namespace === ns) objects.delete(k);
        return {
          exit_code: 0,
          stdout: JSON.stringify({ kind: "Status", status: "Success" }),
        };
      }
      throw new Error("unexpected_storage_command");
    },
  };
  return {
    ...f,
    commands,
    abort,
    saved,
    mutations,
    objects,
    get,
    trial: () => trial,
    retainPhysical: () => {
      retainPhysical = true;
    },
    stopAfterPod: () => {
      stopAfterPod = true;
    },
    loseCreate: () => {
      loseCreate = true;
    },
    physical,
    afterWritten: (fn: () => void) => {
      afterWritten = fn;
    },
  };
}
