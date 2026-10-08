// SPDX-License-Identifier: Apache-2.0
import { setTimeout as delay } from "node:timers/promises";
import {
  NodeStorageTrial,
  type NodeBootstrapInput,
  type NodeStorageTrialRun,
  type NodeStorageVgReadback,
} from "@pgcf/contracts/node-bootstrap";
import {
  capacityPlan,
  parseQuantityBytes,
} from "../../../infra/talos/publish-storage-capacity.ts";
import { BootstrapError, canonical, digest, shellQuote } from "./bootstrap.ts";
import { assertOwnedResource } from "./platform.ts";
import {
  readStorageFacts,
  type StorageFacts,
  type StorageReadCommands,
} from "./storage-readback.ts";

type Json = Record<string, unknown>;
const GI = 1024 ** 3;
const UID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const trialStages = [
  "intent",
  "allocated",
  "written",
  "cleanup",
  "reclaimed",
  "published",
];
const fail = (code = "storage_trial_readback_invalid"): never => {
  throw new BootstrapError(code);
};
const object = (value: unknown): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  return value as Json;
};
const items = (value: unknown): Json[] => {
  if (!Array.isArray(value)) return fail();
  return value.map(object);
};
const meta = (value: Json) => {
  const valueMeta = object(value.metadata);
  if (
    typeof valueMeta.uid !== "string" ||
    !UID.test(valueMeta.uid) ||
    typeof valueMeta.resourceVersion !== "string" ||
    !/^[0-9]+$/.test(valueMeta.resourceVersion)
  )
    return fail();
  return valueMeta as Json & { uid: string; resourceVersion: string };
};

export function storageTrialWriteScript(trialHash: string, path = "/data") {
  if (
    !/^[a-f0-9]{64}$/.test(trialHash) ||
    !path.startsWith("/") ||
    /[\0\r\n]/.test(path)
  )
    return fail();
  const marker = `pgcf-storage/v1:${trialHash}\n`;
  const sha256 = digest(
    Buffer.concat([Buffer.alloc(1024 ** 2), Buffer.from(marker)]),
  );
  const file = shellQuote(`${path}/proof`);
  return {
    sha256,
    script: `set -eu
test ! -L ${shellQuote(path)} && test -d ${shellQuote(path)}
test ! -e ${file} && test ! -L ${file}
umask 077
dd if=/dev/zero of=${file} bs=4096 count=256 status=none
printf '%s' ${shellQuote(marker)} >> ${file}
sync ${file}
set -- $(sha256sum ${file})
test "$1" = ${shellQuote(sha256)}
printf '%s\\n' ${shellQuote(`pgcf_storage_proof ${sha256}`)}`,
  };
}

export function storageTrialObjects(
  input: NodeBootstrapInput,
  trial: NodeStorageTrial,
): Json[] {
  const run = trial.runs.at(-1)!;
  const annotations = {
    "pgcf.io/bootstrap-input": input.input_hash,
    "pgcf.io/bootstrap-operation": input.spec.operation_id,
    "pgcf.io/storage-trial": run.trial_sha256,
    "pgcf.io/storage-node-uid": trial.node_uid,
    "pgcf.io/storage-cluster-uid": trial.cluster_uid,
  };
  const resource = (
    kind: string,
    name: string,
    body: Json,
    namespaced = true,
  ): Json => ({
    apiVersion: kind === "NetworkPolicy" ? "networking.k8s.io/v1" : "v1",
    kind,
    metadata: {
      name,
      ...(namespaced ? { namespace: run.namespace_name } : {}),
      annotations,
    },
    ...body,
  });
  return [
    resource(
      "Namespace",
      run.namespace_name,
      {
        metadata: {
          name: run.namespace_name,
          annotations,
          labels: {
            "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/enforce-version": "v1.36",
          },
        },
      },
      false,
    ),
    resource("NetworkPolicy", "deny-all", {
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        ingress: [],
        egress: [],
      },
    }),
    resource("ResourceQuota", "bounded", {
      spec: {
        hard: {
          "count/pods": "1",
          "count/persistentvolumeclaims": "1",
          "requests.storage": "1Gi",
          "requests.cpu": "100m",
          "limits.cpu": "200m",
          "requests.memory": "64Mi",
          "limits.memory": "128Mi",
        },
      },
    }),
    resource("PersistentVolumeClaim", "proof", {
      spec: {
        accessModes: ["ReadWriteOnce"],
        volumeMode: "Filesystem",
        storageClassName: "pgcf-lvm",
        resources: { requests: { storage: "1Gi" } },
      },
    }),
    resource("Pod", "proof", {
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        nodeSelector: {
          "pgcf.io/node-id": input.spec.node_id,
          "pgcf.io/region": input.spec.region_id,
          "pgcf.io/provider-instance-id": input.spec.provider_instance_id,
        },
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: [
                {
                  matchFields: [
                    {
                      key: "metadata.name",
                      operator: "In",
                      values: [input.spec.hostname],
                    },
                  ],
                },
              ],
            },
          },
        },
        tolerations: [
          {
            key: "pgcf.io/quarantine",
            operator: "Equal",
            value: "bootstrap",
            effect: "NoSchedule",
          },
        ],
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: "proof" } },
        ],
        containers: [
          {
            name: "proof",
            image: run.image,
            imagePullPolicy: "IfNotPresent",
            command: [
              "/bin/sh",
              "-ec",
              storageTrialWriteScript(run.trial_sha256).script,
            ],
            resources: {
              requests: { cpu: "100m", memory: "64Mi" },
              limits: { cpu: "200m", memory: "128Mi" },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [{ name: "data", mountPath: "/data" }],
          },
        ],
      },
    }),
  ];
}

/** Raw DELETE is required: ordinary kubectl delete has no UID/resourceVersion precondition. */
export function storageDeleteRequest(
  path: string,
  metadata: { uid: string; resourceVersion: string },
) {
  if (
    !/^\/api\/v1\/(?:namespaces|persistentvolumes)\/[a-z0-9-]+(?:\/(?:pods|persistentvolumeclaims)\/[a-z0-9-]+)?$/.test(
      path,
    ) ||
    !UID.test(metadata.uid) ||
    !/^[0-9]+$/.test(metadata.resourceVersion)
  )
    return fail();
  return {
    args: ["delete", `--raw=${path}`, "--filename=-"],
    stdin: JSON.stringify({
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: metadata,
      propagationPolicy: "Foreground",
    }),
  };
}

export interface StorageCapacityCommands extends StorageReadCommands {
  readTrial(): Promise<NodeStorageTrial | null>;
  saveTrial(trial: NodeStorageTrial): Promise<void>;
  signal: AbortSignal;
  wait?(milliseconds: number): Promise<void>;
}
function sample(facts: StorageFacts): NodeStorageVgReadback {
  return {
    observed_at: facts.observed_at,
    node_uid: facts.node_uid,
    lvmnode_uid: facts.lvmnode_uid,
    resource_version: facts.lvmnode_resource_version,
    vg_uuid: facts.vg_uuid,
    size: facts.total_bytes,
    free: facts.free_bytes,
  };
}
function assertBinding(trial: NodeStorageTrial, facts: StorageFacts) {
  if (
    trial.node_uid !== facts.node_uid ||
    trial.cluster_uid !== facts.cluster_uid ||
    trial.storage_namespace_uid !== facts.storage_namespace_uid ||
    trial.lvmnode_uid !== facts.lvmnode_uid ||
    trial.vg_uuid !== facts.vg_uuid ||
    trial.pv_uuid !== facts.pv_uuid ||
    trial.device !== facts.raw_partition.device ||
    trial.partition_uuid !== facts.raw_partition.partition_uuid ||
    trial.total_bytes !== facts.total_bytes ||
    trial.extent_size_bytes !== facts.extent_size_bytes
  )
    return fail("storage_trial_identity_changed");
}
function publicationHash(run: NodeStorageTrialRun) {
  return digest(
    canonical({
      trial: run.trial_sha256,
      before: run.before,
      allocated: run.allocated,
      after: run.after,
      data: run.data_sha256,
    }),
  );
}

class StorageProducer {
  readonly input: NodeBootstrapInput;
  readonly commands: StorageCapacityCommands;
  private trial: NodeStorageTrial | null = null;
  private readonly end = performance.now() + 270_000;
  constructor(input: NodeBootstrapInput, commands: StorageCapacityCommands) {
    this.input = input;
    this.commands = commands;
  }
  private check() {
    this.commands.signal.throwIfAborted();
    if (performance.now() >= this.end) return fail("storage_trial_deadline");
  }
  private async wait() {
    this.check();
    if (this.commands.wait) await this.commands.wait(1000);
    else await delay(1000, undefined, { signal: this.commands.signal });
    this.check();
  }
  private async facts(): Promise<StorageFacts> {
    for (;;) {
      this.check();
      try {
        const facts = await readStorageFacts(this.input, this.commands);
        if (this.trial) assertBinding(this.trial, facts);
        return facts;
      } catch (error) {
        if (
          !(error instanceof BootstrapError) ||
          error.code !== "storage_capacity_unsettled"
        )
          throw error;
        await this.wait();
      }
    }
  }
  private async save(run: Partial<NodeStorageTrialRun>) {
    this.check();
    const next = structuredClone(this.trial!);
    Object.assign(next.runs.at(-1)!, run);
    await this.commands.saveTrial(NodeStorageTrial.parse(next));
    this.trial = next;
  }
  private async get(
    kind: string,
    name?: string,
    namespace?: string,
  ): Promise<Json | null> {
    this.check();
    await this.commands.authorize();
    const resources: Record<
      string,
      { apiVersion: string; kind: string; plural: string }
    > = {
      namespace: { apiVersion: "v1", kind: "Namespace", plural: "namespaces" },
      configmap: { apiVersion: "v1", kind: "ConfigMap", plural: "configmaps" },
      pod: { apiVersion: "v1", kind: "Pod", plural: "pods" },
      resourcequota: {
        apiVersion: "v1",
        kind: "ResourceQuota",
        plural: "resourcequotas",
      },
      networkpolicy: {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        plural: "networkpolicies",
      },
      persistentvolumeclaim: {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        plural: "persistentvolumeclaims",
      },
      persistentvolume: {
        apiVersion: "v1",
        kind: "PersistentVolume",
        plural: "persistentvolumes",
      },
      persistentvolumes: {
        apiVersion: "v1",
        kind: "PersistentVolume",
        plural: "persistentvolumes",
      },
      "lvmvolumes.local.openebs.io": {
        apiVersion: "local.openebs.io/v1alpha1",
        kind: "LVMVolume",
        plural: "lvmvolumes",
      },
    };
    const resource = resources[kind];
    if (
      !resource ||
      (name && !/^[a-z0-9][a-z0-9.-]*$/.test(name)) ||
      (namespace && !/^[a-z0-9][a-z0-9-]*$/.test(namespace))
    )
      return fail();
    const prefix =
      resource.apiVersion === "v1" ? "/api/v1" : `/apis/${resource.apiVersion}`;
    const path = `${prefix}${namespace ? `/namespaces/${namespace}` : ""}/${resource.plural}${name ? `?fieldSelector=${encodeURIComponent(`metadata.name=${name}`)}` : ""}`;
    const result = await this.commands.kube(["get", `--raw=${path}`]);
    if (result.exit_code !== 0 || Buffer.byteLength(result.stdout) > 512 * 1024)
      return fail();
    let list: Json;
    try {
      list = object(JSON.parse(result.stdout));
    } catch {
      return fail();
    }
    const metadata = object(list.metadata);
    if (
      list.apiVersion !== resource.apiVersion ||
      list.kind !== `${resource.kind}List` ||
      (metadata.continue !== undefined && metadata.continue !== "") ||
      (metadata.remainingItemCount !== undefined &&
        metadata.remainingItemCount !== 0)
    )
      return fail();
    const values = items(list.items).map((item) => {
      const value =
        item.kind === undefined && item.apiVersion === undefined
          ? { ...item, kind: resource.kind, apiVersion: resource.apiVersion }
          : item;
      if (
        value.kind !== resource.kind ||
        value.apiVersion !== resource.apiVersion
      )
        return fail();
      const vm = object(value.metadata);
      if (
        (name !== undefined && vm.name !== name) ||
        (namespace !== undefined && vm.namespace !== namespace)
      )
        return fail();
      return value;
    });
    if (name !== undefined) {
      if (values.length > 1) return fail();
      return values[0] ?? null;
    }
    return { ...list, items: values };
  }
  private async mutate(args: string[], stdin: string) {
    this.check();
    const facts = await this.facts();
    this.check();
    if (
      (args[0] === "patch" && args[1] === "persistentvolume") ||
      (args[0] === "delete" &&
        args.some((arg) => arg.includes("/persistentvolumeclaims/")))
    )
      await this.assertCleanupVolume(facts);
    await this.commands.authorize();
    this.check();
    return this.commands.kube(args, true, stdin);
  }
  private async assertCleanupVolume(facts: StorageFacts) {
    const run = this.current();
    if (!run.volume_handle) return;
    const physical = facts.logical_volumes.find(
      (lv) => lv.name === run.volume_handle,
    );
    if (physical && (!run.lv_uuid || physical.uuid !== run.lv_uuid))
      return fail("storage_trial_physical_volume_changed");
    const volume = await this.get(
      "lvmvolumes.local.openebs.io",
      run.volume_handle,
      "openebs",
    );
    if (volume) {
      const spec = object(volume.spec);
      if (
        !run.lvmvolume_uid ||
        meta(volume).uid !== run.lvmvolume_uid ||
        spec.ownerNodeID !== this.input.spec.hostname ||
        spec.volGroup !== "pgcf" ||
        parseQuantityBytes(spec.capacity) !== GI
      )
        return fail("storage_trial_volume_not_owned");
    } else if (physical) return fail("storage_trial_allocation_unresolved");
  }
  private current() {
    return this.trial!.runs.at(-1)!;
  }
  private manifest(kind: string) {
    return storageTrialObjects(this.input, this.trial!).find(
      (value) => value.kind === kind,
    )!;
  }
  private owned(
    expected: Json,
    actual: Json,
    uid?: string | null,
    deleting = false,
  ) {
    const actualMeta = meta(actual);
    if (uid && actualMeta.uid !== uid)
      return fail("storage_trial_resource_replaced");
    const checked = structuredClone(actual);
    if (deleting) delete object(checked.metadata).deletionTimestamp;
    try {
      assertOwnedResource(expected, checked);
    } catch {
      return fail("storage_trial_resource_not_owned");
    }
    return actualMeta;
  }
  private async ensure(
    kind: string,
    uidField?: "namespace_uid" | "pvc_uid" | "pod_uid",
  ) {
    const expected = this.manifest(kind),
      em = object(expected.metadata);
    const savedUid = uidField ? this.current()[uidField] : undefined;
    let actual = await this.get(
      kind.toLowerCase(),
      String(em.name),
      em.namespace as string | undefined,
    );
    if (!actual) {
      if (savedUid) return fail("storage_trial_resource_disappeared");
      try {
        await this.mutate(
          ["create", "--filename=-", "--output=json"],
          JSON.stringify(expected),
        );
      } catch {
        /* Read actual ownership after an uncertain create, without inventing success. */
      }
      actual = await this.get(
        kind.toLowerCase(),
        String(em.name),
        em.namespace as string | undefined,
      );
      if (!actual) return fail("storage_trial_create_unconfirmed");
    }
    const actualMeta = this.owned(expected, actual, savedUid);
    if (uidField && !savedUid) await this.save({ [uidField]: actualMeta.uid });
    return actual;
  }
  private async freshTrial(facts: StorageFacts) {
    if (
      facts.logical_volumes.length !== 0 ||
      facts.free_bytes !== facts.total_bytes
    )
      return fail("storage_trial_vg_not_empty");
    const config = await this.get("configmap", "pgcf-regional", "pgcf-system");
    const image = object(config?.data).PGCF_POSTGRES_IMAGE;
    if (
      typeof image !== "string" ||
      !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image)
    )
      return fail("storage_trial_image_unpinned");
    const round = (this.trial?.runs.length ?? 0) + 1;
    if (round > 16) return fail("storage_trial_attempt_limit");
    const trialHash = digest(
      canonical({
        input: this.input.input_hash,
        node: facts.node_uid,
        cluster: facts.cluster_uid,
        vg: facts.vg_uuid,
        round,
        image,
      }),
    );
    const run: NodeStorageTrialRun = {
      namespace_name: `pgcf-storage-${this.input.input_hash.slice(0, 20)}-${round}`,
      trial_sha256: trialHash,
      image,
      data_sha256: storageTrialWriteScript(trialHash).sha256,
      volume_bytes: GI,
      stage: "intent",
      namespace_uid: null,
      pvc_uid: null,
      pod_uid: null,
      pv_name: null,
      pv_uid: null,
      volume_handle: null,
      lvmvolume_uid: null,
      lv_uuid: null,
      before: sample(facts),
      allocated: null,
      after: null,
      written_at: null,
      published_at: null,
    };
    const next = NodeStorageTrial.parse(
      this.trial
        ? { ...this.trial, runs: [...this.trial.runs, run] }
        : {
            version: 1,
            input_hash: this.input.input_hash,
            node_uid: facts.node_uid,
            cluster_uid: facts.cluster_uid,
            storage_namespace_uid: facts.storage_namespace_uid,
            lvmnode_uid: facts.lvmnode_uid,
            vg_uuid: facts.vg_uuid,
            pv_uuid: facts.pv_uuid,
            device: facts.raw_partition.device,
            partition_uuid: facts.raw_partition.partition_uuid,
            total_bytes: facts.total_bytes,
            extent_size_bytes: facts.extent_size_bytes,
            runs: [run],
          },
    );
    await this.commands.saveTrial(next);
    this.trial = next;
  }
  private async collectAllocation(): Promise<boolean> {
    const run = this.current(),
      pvc = await this.get(
        "persistentvolumeclaim",
        "proof",
        run.namespace_name,
      );
    const claimUid = pvc
      ? this.owned(
          this.manifest("PersistentVolumeClaim"),
          pvc,
          run.pvc_uid,
          true,
        ).uid
      : run.pvc_uid;
    if (!claimUid) return false;
    if (!run.pvc_uid) await this.save({ pvc_uid: claimUid });
    const name = `pvc-${claimUid}`;
    if (
      pvc &&
      object(pvc.spec).volumeName !== undefined &&
      object(pvc.spec).volumeName !== name
    )
      return fail("storage_trial_volume_not_owned");
    const pv = await this.get("persistentvolume", String(name));
    if (!pv) return false;
    const pvMeta = meta(pv),
      spec = object(pv.spec),
      claim = object(spec.claimRef),
      csi = object(spec.csi);
    if (
      claim.namespace !== run.namespace_name ||
      claim.name !== "proof" ||
      claim.uid !== claimUid ||
      spec.storageClassName !== "pgcf-lvm" ||
      csi.driver !== "local.csi.openebs.io" ||
      csi.volumeHandle !== name ||
      parseQuantityBytes(object(spec.capacity).storage) !== GI ||
      (run.pv_uid && run.pv_uid !== pvMeta.uid)
    )
      return fail("storage_trial_volume_not_owned");
    if (!run.pv_uid)
      await this.save({
        pv_name: String(name),
        pv_uid: pvMeta.uid,
        volume_handle: String(name),
      });
    const volume = await this.get(
      "lvmvolumes.local.openebs.io",
      String(name),
      "openebs",
    );
    if (!volume) return false;
    const vm = meta(volume),
      vs = object(volume.spec);
    if (
      vs.ownerNodeID !== this.input.spec.hostname ||
      vs.volGroup !== "pgcf" ||
      vs.vgPattern !== "^pgcf$" ||
      (vs.thinProvision !== undefined && vs.thinProvision !== "no") ||
      (vs.source !== undefined && vs.source !== "") ||
      parseQuantityBytes(vs.capacity) !== GI ||
      (run.lvmvolume_uid && run.lvmvolume_uid !== vm.uid)
    )
      return fail("storage_trial_volume_not_owned");
    if (!run.lvmvolume_uid) await this.save({ lvmvolume_uid: vm.uid });
    const facts = await this.facts(),
      lv = facts.logical_volumes.find((value) => value.name === name);
    if (!lv || object(volume.status).state !== "Ready") return false;
    if (
      facts.logical_volumes.length !== 1 ||
      lv.size_bytes !== GI ||
      !lv.active ||
      (run.lv_uuid && run.lv_uuid !== lv.uuid)
    )
      return fail("storage_trial_physical_volume_changed");
    if (!run.lv_uuid) await this.save({ lv_uuid: lv.uuid });
    if (
      facts.free_bytes !== run.before.free - GI ||
      facts.total_bytes !== run.before.size
    )
      return fail("storage_trial_physical_volume_changed");
    if (
      facts.lvmnode_resource_version === run.before.resource_version ||
      Date.parse(facts.observed_at) <= Date.parse(run.before.observed_at)
    )
      return false;
    if (!run.allocated) await this.save({ allocated: sample(facts) });
    return true;
  }
  private async prove() {
    await this.ensure("Namespace", "namespace_uid");
    await this.ensure("NetworkPolicy");
    await this.ensure("ResourceQuota");
    await this.ensure("PersistentVolumeClaim", "pvc_uid");
    await this.ensure("Pod", "pod_uid");
    while (!(await this.collectAllocation())) await this.wait();
    if (this.current().stage === "intent")
      await this.save({ stage: "allocated" });
    if (this.current().stage !== "allocated") return;
    for (;;) {
      const run = this.current(),
        pod = await this.get("pod", "proof", run.namespace_name);
      if (!pod) return fail("storage_trial_resource_disappeared");
      this.owned(this.manifest("Pod"), pod, run.pod_uid);
      if (object(pod.spec).nodeName !== this.input.spec.hostname) {
        if (object(pod.spec).nodeName !== undefined)
          return fail("storage_trial_pod_node_changed");
        await this.wait();
        continue;
      }
      const status = object(pod.status),
        containers = status.containerStatuses;
      if (status.phase === "Failed") return fail("storage_trial_write_failed");
      if (status.phase !== "Succeeded") {
        await this.wait();
        continue;
      }
      const container = items(containers);
      if (
        container.length !== 1 ||
        container[0]!.name !== "proof" ||
        object(object(container[0]!.state).terminated).exitCode !== 0 ||
        !String(container[0]!.imageID).includes(run.image.split("@")[1]!)
      )
        return fail("storage_trial_write_failed");
      await this.commands.authorize();
      const logs = await this.commands.kube([
        "logs",
        "proof",
        "--namespace",
        run.namespace_name,
        "--container=proof",
        "--limit-bytes=4096",
      ]);
      if (
        logs.exit_code !== 0 ||
        logs.stdout.trim() !== `pgcf_storage_proof ${run.data_sha256}`
      )
        return fail("storage_trial_write_failed");
      await this.facts();
      await this.save({
        stage: "written",
        written_at: new Date().toISOString(),
      });
      return;
    }
  }
  private async deleteOwned(
    kind: "Namespace" | "Pod" | "PersistentVolumeClaim",
    field: "namespace_uid" | "pod_uid" | "pvc_uid",
  ) {
    const expected = this.manifest(kind),
      em = object(expected.metadata),
      run = this.current();
    const actual = await this.get(
      kind.toLowerCase(),
      String(em.name),
      em.namespace as string | undefined,
    );
    if (!actual) return;
    const m = this.owned(expected, actual, run[field], true);
    if (!run[field]) await this.save({ [field]: m.uid });
    if (m.deletionTimestamp) return;
    const path =
      kind === "Namespace"
        ? `/api/v1/namespaces/${run.namespace_name}`
        : `/api/v1/namespaces/${run.namespace_name}/${kind === "Pod" ? "pods" : "persistentvolumeclaims"}/proof`;
    const request = storageDeleteRequest(path, {
      uid: m.uid,
      resourceVersion: m.resourceVersion,
    });
    try {
      await this.mutate(request.args, request.stdin);
    } catch {
      /* Subsequent bound reads resolve a lost DELETE response. */
    }
  }
  private async metadataGone(): Promise<boolean> {
    const run = this.current();
    if (
      (await this.get("pod", "proof", run.namespace_name)) ||
      (await this.get("persistentvolumeclaim", "proof", run.namespace_name))
    )
      return false;
    const pvs = items((await this.get("persistentvolumes"))!.items),
      lvs = items(
        (await this.get("lvmvolumes.local.openebs.io", undefined, "openebs"))!
          .items,
      );
    return (
      !pvs.some(
        (pv) =>
          object(object(pv.spec).claimRef ?? {}).namespace ===
            run.namespace_name ||
          object(pv.metadata).uid === run.pv_uid ||
          object(pv.metadata).name === run.pv_name,
      ) &&
      !lvs.some(
        (lv) =>
          object(lv.metadata).uid === run.lvmvolume_uid ||
          object(lv.metadata).name === run.volume_handle ||
          (object(lv.spec).ownerNodeID === this.input.spec.hostname &&
            object(lv.spec).volGroup === "pgcf"),
      )
    );
  }
  private async cleanup() {
    if (
      trialStages.indexOf(this.current().stage) < trialStages.indexOf("cleanup")
    )
      await this.save({ stage: "cleanup" });
    let run = this.current();
    await this.deleteOwned("Pod", "pod_uid");
    while (await this.get("pod", "proof", run.namespace_name))
      await this.wait();
    if (run.pvc_uid && !run.lv_uuid) {
      // Capture any identities whose allocation response/checkpoint was interrupted before reclamation.
      await this.collectAllocation();
      run = this.current();
    }
    if (run.pv_name) {
      const pv = await this.get("persistentvolume", run.pv_name);
      if (pv) {
        const m = meta(pv),
          spec = object(pv.spec),
          claim = object(spec.claimRef),
          csi = object(spec.csi);
        if (
          m.uid !== run.pv_uid ||
          claim.uid !== run.pvc_uid ||
          claim.namespace !== run.namespace_name ||
          csi.volumeHandle !== run.volume_handle
        )
          return fail("storage_trial_volume_not_owned");
        if (spec.persistentVolumeReclaimPolicy !== "Delete") {
          if (spec.persistentVolumeReclaimPolicy !== "Retain")
            return fail("storage_trial_volume_not_owned");
          const patch = [
            { op: "test", path: "/metadata/uid", value: run.pv_uid },
            {
              op: "test",
              path: "/metadata/resourceVersion",
              value: m.resourceVersion,
            },
            { op: "test", path: "/spec/claimRef/uid", value: run.pvc_uid },
            {
              op: "test",
              path: "/spec/claimRef/namespace",
              value: run.namespace_name,
            },
            {
              op: "test",
              path: "/spec/csi/volumeHandle",
              value: run.volume_handle,
            },
            {
              op: "test",
              path: "/spec/persistentVolumeReclaimPolicy",
              value: "Retain",
            },
            {
              op: "add",
              path: "/spec/persistentVolumeReclaimPolicy",
              value: "Delete",
            },
          ];
          try {
            await this.mutate(
              [
                "patch",
                "persistentvolume",
                run.pv_name,
                "--type=json",
                "--patch",
                JSON.stringify(patch),
                "--output=json",
              ],
              "",
            );
          } catch (error) {
            if (error instanceof BootstrapError) throw error;
            /* Resolve the exact owned PV readback before deleting its PVC. */
          }
          const current = await this.get("persistentvolume", run.pv_name);
          if (
            current &&
            (meta(current).uid !== run.pv_uid ||
              object(current.spec).persistentVolumeReclaimPolicy !== "Delete")
          )
            return fail("storage_trial_reclaim_policy_unconfirmed");
        }
      }
    }
    await this.deleteOwned("PersistentVolumeClaim", "pvc_uid");
    let after: StorageFacts;
    for (;;) {
      after = await this.facts();
      if (
        run.pvc_uid &&
        !run.lv_uuid &&
        after.logical_volumes.some((lv) => lv.name === `pvc-${run.pvc_uid}`)
      ) {
        if (await this.collectAllocation()) {
          await this.cleanup();
          return;
        }
        await this.wait();
        continue;
      }
      if (
        after.logical_volumes.some(
          (lv) => lv.name === run.volume_handle || lv.uuid === run.lv_uuid,
        )
      ) {
        await this.wait();
        continue;
      }
      if (
        after.logical_volumes.length !== 0 ||
        after.free_bytes !== after.total_bytes
      )
        return fail("storage_trial_physical_reclamation_failed");
      if (await this.metadataGone()) break;
      await this.wait();
    }
    await this.deleteOwned("Namespace", "namespace_uid");
    while (await this.get("namespace", run.namespace_name)) await this.wait();
    after = await this.facts();
    if (
      after.logical_volumes.length !== 0 ||
      after.free_bytes !== run.before.free ||
      !(await this.metadataGone())
    )
      return fail("storage_trial_physical_reclamation_failed");
    if (
      run.allocated &&
      (after.lvmnode_resource_version === run.allocated.resource_version ||
        Date.parse(after.observed_at) <= Date.parse(run.allocated.observed_at))
    )
      return fail("storage_capacity_unsettled");
    if (this.current().stage === "cleanup")
      await this.save({ stage: "reclaimed", after: sample(after) });
  }
  private async publish() {
    const run = this.current();
    if (!run.allocated || !run.after || !run.written_at)
      return fail("storage_trial_write_unproven");
    const facts = await this.facts();
    if (
      facts.logical_volumes.length !== 0 ||
      facts.free_bytes !== facts.total_bytes ||
      (await this.get("namespace", run.namespace_name)) ||
      !(await this.metadataGone())
    )
      return fail("storage_trial_physical_reclamation_failed");
    const binding = this.trial!;
    const plan = capacityPlan(
      {
        clusterUid: binding.cluster_uid,
        storageNamespaceUid: binding.storage_namespace_uid,
        context: "native-bootstrap",
        proofNotBefore: Date.parse(run.before.observed_at),
        proofCompletedAt: Date.parse(run.after.observed_at),
        bindings: {
          [this.input.spec.hostname]: {
            node_uid: binding.node_uid,
            lvmnode_uid: binding.lvmnode_uid,
            lvmnode_resource_version: run.after.resource_version,
            vg_uuid: binding.vg_uuid,
            smoke: {
              before: run.before,
              allocated: run.allocated,
              after: run.after,
            },
          },
        },
      },
      this.input.spec.hostname,
      facts.node,
      facts.lvmnode,
      Date.now(),
    );
    const proofHash = publicationHash(run);
    const last = plan.patch.at(-1)!;
    if (last.path === "/metadata/annotations")
      object(last.value)["pgcf.io/storage-proof"] = proofHash;
    else
      plan.patch.push({
        op: "add",
        path: "/metadata/annotations/pgcf.io~1storage-proof",
        value: proofHash,
      });
    try {
      await this.mutate(
        [
          "patch",
          "node",
          this.input.spec.hostname,
          "--type=json",
          "--patch",
          JSON.stringify(plan.patch),
          "--output=json",
        ],
        "",
      );
    } catch (error) {
      if (error instanceof BootstrapError) throw error;
      /* Resolve an uncertain publication from its bound proof marker. */
    }
    const current = await this.facts(),
      annotations = object(object(current.node.metadata).annotations);
    if (
      annotations["pgcf.io/storage-gib-total"] !== String(plan.storageGiB) ||
      annotations["pgcf.io/storage-proof"] !== proofHash
    )
      return fail("storage_publish_readback_failed");
    await this.save({
      stage: "published",
      published_at: new Date().toISOString(),
    });
  }
  async run() {
    this.trial = await this.commands.readTrial();
    if (this.trial) this.trial = NodeStorageTrial.parse(this.trial);
    const first = await this.facts();
    if (
      this.trial?.input_hash !== undefined &&
      this.trial.input_hash !== this.input.input_hash
    )
      return fail("storage_trial_identity_changed");
    if (this.currentOrNull()?.stage === "published") {
      if (
        object(object(first.node.metadata).annotations)[
          "pgcf.io/storage-proof"
        ] !== publicationHash(this.current())
      )
        return fail("storage_publish_readback_failed");
      if (
        first.logical_volumes.length !== 0 ||
        first.free_bytes !== first.total_bytes ||
        object(object(first.node.metadata).annotations)[
          "pgcf.io/storage-gib-total"
        ] !== String(Math.floor(first.total_bytes / GI)) ||
        (await this.get("namespace", this.current().namespace_name)) ||
        !(await this.metadataGone())
      )
        return fail("storage_trial_physical_reclamation_failed");
      return;
    }
    try {
      if (
        this.trial &&
        (this.current().stage === "cleanup" ||
          Date.now() - Date.parse(this.current().before.observed_at) >= 180_000)
      )
        await this.cleanup();
      if (
        !this.trial ||
        (this.current().stage === "reclaimed" &&
          (!this.current().written_at ||
            Date.now() - Date.parse(this.current().before.observed_at) >=
              240_000))
      )
        await this.freshTrial(await this.facts());
      if (["intent", "allocated"].includes(this.current().stage))
        await this.prove();
      if (this.current().stage === "written") await this.cleanup();
      await this.publish();
    } catch (error) {
      if (
        this.trial &&
        !["reclaimed", "published"].includes(this.current().stage)
      ) {
        try {
          await this.cleanup();
        } catch {
          /* Preserve exact unfinished ownership in D1; unavailable authority never authorizes foreign or forced cleanup. */
        }
      }
      throw error;
    }
  }
  private currentOrNull() {
    return this.trial?.runs.at(-1) ?? null;
  }
}

/** Actual storage production runs while quarantine is held, before existing independent admission proofs. */
export async function publishNodeStorageCapacity(
  input: NodeBootstrapInput,
  commands: StorageCapacityCommands,
): Promise<void> {
  try {
    await new StorageProducer(input, commands).run();
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    if (
      commands.signal.aborted ||
      (error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name))
    )
      throw new BootstrapError("storage_trial_aborted");
    throw new BootstrapError("storage_trial_failed");
  }
}
