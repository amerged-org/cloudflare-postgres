// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  BARMAN_COMPUTE,
  provisioningResourceEnvelope,
} from "@cloudflare-postgres/resource-envelope";
import { CapacityJournal } from "./capacity-journal.ts";
import { inspectCapacityTransfer } from "./capacity-handoff.ts";
import { canonicalCohort } from "./node-cohort.ts";
import {
  capacityResourceAmounts,
  effectiveCapacityResources,
} from "./capacity-pod-resources.ts";
import { quantity } from "./owned-stop.ts";
import {
  CAPACITY_NODE_UID,
  CAPACITY_OPERATION,
  CAPACITY_SLOT,
  CAPACITY_ATTEMPT,
  RESERVATION_AFFINITY,
  RESERVATION_ALLOCATED,
  RESERVATION_IGNORED,
  RESERVATION_RESTRICTED_OPTIONS,
} from "./capacity-types.ts";
import type {
  CapacityConfiguration,
  CapacityNode,
  CapacityPlan,
  CapacityRef,
  CapacityRuntime,
  CapacitySlotPlan,
  CapacitySlotState,
  CapacitySnapshot,
  CapacityStorage,
} from "./capacity-types.ts";
import type { Claim, Kubernetes, Resource } from "./types.ts";

const failure = () => new Error("capacity_acquisition_unproven");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const dns = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const image = /^[A-Za-z0-9./_:-]+@sha256:[a-f0-9]{64}$/;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const equal = (a: unknown, b: unknown) =>
  canonicalCohort(a) === canonicalCohort(b);
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw failure();
  return v as Record<string, unknown>;
}
function array(v: unknown): unknown[] {
  if (!Array.isArray(v) || v.length > 512) throw failure();
  return v;
}
function resource(v: Record<string, unknown>): Resource {
  return v as unknown as Resource;
}
function ref(r: Resource): CapacityRef {
  if (
    !uuid.test(r.metadata.uid ?? "") ||
    !/^[1-9][0-9]{0,18}$/.test(r.metadata.resourceVersion ?? "") ||
    r.metadata.deletionTimestamp
  )
    throw failure();
  return {
    name: r.metadata.name,
    namespace: r.metadata.namespace ?? "",
    uid: r.metadata.uid!,
    resourceVersion: r.metadata.resourceVersion!,
  };
}
function present(
  actual: Resource | null,
  kind: string,
  name: string,
  namespace = "",
): Resource {
  if (
    !actual ||
    actual.kind !== kind ||
    actual.metadata.name !== name ||
    (actual.metadata.namespace ?? "") !== namespace
  )
    throw failure();
  ref(actual);
  return actual;
}
function requestResources(spec: unknown): Record<string, unknown> {
  const containers = array(record(spec).containers);
  if (containers.length !== 1) throw failure();
  return record(record(record(containers[0]).resources).requests);
}
function amounts(r: unknown, cpu: number, bytes: string): boolean {
  const v = record(r);
  return (
    quantity(v.cpu, 1000n) === BigInt(cpu) &&
    quantity(v.memory, 1n) === BigInt(bytes)
  );
}
function reservationReady(r: Resource, cpu: number, bytes: string): boolean {
  const status = record(r.status ?? {});
  if (status.phase !== "Available") return false;
  const conditions = array(status.conditions);
  if (
    ["Ready", "Scheduled"].some(
      (type) =>
        conditions.filter(
          (c) => record(c).type === type && record(c).status === "True",
        ).length !== 1,
    )
  )
    return false;
  if (!amounts(status.allocatable, cpu, bytes)) throw failure();
  return true;
}
function available(r: Resource, cpu: number, bytes: string): boolean {
  if (!reservationReady(r, cpu, bytes)) return false;
  const status = record(r.status);
  if (array(status.currentOwners ?? []).length) throw failure();
  for (const [key, value] of Object.entries(record(status.allocated ?? {})))
    if (quantity(value, key === "cpu" ? 1000n : 1n) !== 0n) throw failure();
  return true;
}
function planFor(claim: Claim, config: CapacityConfiguration): CapacityPlan {
  if (
    config.version !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.installationId) ||
    !dns.test(config.namespace) ||
    !dns.test(config.storageNamespace) ||
    !dns.test(config.holdStorageClassPrefix) ||
    config.holdStorageClassPrefix.length > 40 ||
    config.schedulerName !== "koord-scheduler" ||
    !image.test(config.schedulerDeployment.image) ||
    !dns.test(config.schedulerDeployment.namespace) ||
    !dns.test(config.schedulerDeployment.name) ||
    !Array.isArray(config.allowedNodes) ||
    config.allowedNodes.length < 1 ||
    config.allowedNodes.length > 32 ||
    new Set(config.allowedNodes.map((n) => n.uid)).size !==
      config.allowedNodes.length ||
    config.allowedNodes.some((n) => !dns.test(n.name) || !uuid.test(n.uid)) ||
    !Array.isArray(config.platformReservations) ||
    config.platformReservations.length !== config.allowedNodes.length ||
    config.allowedNodes.some(
      (n) =>
        config.platformReservations.filter(
          (p) =>
            p.nodeName === n.name &&
            p.nodeUid === n.uid &&
            dns.test(p.name) &&
            uuid.test(p.uid),
        ).length !== 1,
    ) ||
    Object.values(config.platformMargin).some(
      (n) => !Number.isSafeInteger(n) || n <= 0,
    ) ||
    config.platformMargin.podSlots !== 1 ||
    claim.kind !== "environment.create" ||
    claim.specRevision !== 1 ||
    ![claim.operationId, claim.environmentId, claim.regionId].every((v) =>
      uuid.test(v),
    ) ||
    !Number.isSafeInteger(claim.leaseEpoch) ||
    claim.leaseEpoch < 1 ||
    (claim.runEpoch !== undefined && claim.runEpoch !== "1") ||
    claim.spec.regionId !== claim.regionId ||
    hash(JSON.stringify(claim.spec)) !== claim.specHash ||
    !image.test(claim.spec.profile.postgresImage) ||
    !dns.test(claim.spec.profile.storage.storageClassName)
  )
    throw failure();
  provisioningResourceEnvelope({
    ...claim.spec.profile,
    volumeGiB: claim.spec.volumeGiB,
  });
  const bytes = (mi: number) => (BigInt(mi) * 1048576n).toString(),
    profile = claim.spec.profile;
  const slots: CapacitySlotPlan[] = [];
  for (let i = 0; i <= profile.instances; i++) {
    const id = "database-" + i,
      suffix = hash(claim.operationId + "/" + id).slice(0, 24);
    slots.push({
      id,
      kind: "database",
      maintenance: i === profile.instances,
      reservationName: "pgcf-cap-" + suffix,
      holdPvcName: "pgcf-hold-" + suffix,
      cpuMilli: profile.compute.cpuMilli + BARMAN_COMPUTE.requests.cpuMilli,
      memoryBytes: bytes(
        profile.compute.memoryMiB + BARMAN_COMPUTE.requests.memoryMiB,
      ),
      cpuLimitMilli: profile.compute.cpuMilli + BARMAN_COMPUTE.limits.cpuMilli,
      memoryLimitBytes: bytes(
        profile.compute.memoryMiB + BARMAN_COMPUTE.limits.memoryMiB,
      ),
      volumeBytes: (BigInt(claim.spec.volumeGiB) * 1073741824n).toString(),
    });
  }
  if (profile.pooling) {
    const pool = profile.pooling.compute;
    slots.push({
      id: "pooler",
      kind: "pooler",
      maintenance: false,
      reservationName:
        "pgcf-cap-" + hash(claim.operationId + "/pooler").slice(0, 24),
      holdPvcName: null,
      cpuMilli: pool.requests.cpuMilli,
      memoryBytes: bytes(pool.requests.memoryMiB),
      cpuLimitMilli: pool.limits.cpuMilli,
      memoryLimitBytes: bytes(pool.limits.memoryMiB),
      volumeBytes: null,
    });
  }
  return {
    version: 1,
    binding: {
      installationId: config.installationId,
      regionId: claim.regionId,
      operationId: claim.operationId,
      environmentId: claim.environmentId,
      specRevision: 1,
      specHash: claim.specHash,
      runEpoch: claim.runEpoch ?? null,
    },
    namespace: "pgcf-" + claim.environmentId.replaceAll("-", ""),
    customerStorageClass: profile.storage.storageClassName,
    holdNamespace: config.namespace,
    holdStorageClassPrefix: config.holdStorageClassPrefix,
    instances: profile.instances,
    slots,
  };
}
function metadata(
  plan: CapacityPlan,
  name: string,
  slot?: string,
  namespace?: string,
) {
  return {
    name,
    ...(namespace ? { namespace } : {}),
    labels: {
      "app.kubernetes.io/managed-by": "cloudflare-postgres",
      "pgcf.io/environment-id": plan.binding.environmentId,
      "pgcf.io/region-id": plan.binding.regionId,
      [CAPACITY_OPERATION]: plan.binding.operationId,
      ...(slot ? { [CAPACITY_SLOT]: slot } : {}),
    },
    annotations: { "pgcf.io/spec-hash": plan.binding.specHash },
  };
}
function reservation(
  plan: CapacityPlan,
  slot: CapacitySlotPlan,
  claim: Claim,
  config: CapacityConfiguration,
): Resource {
  return resource({
    apiVersion: "scheduling.koordinator.sh/v1alpha1",
    kind: "Reservation",
    metadata: metadata(plan, slot.reservationName, slot.id),
    spec: {
      ttl: "0s",
      allocateOnce: false,
      allocatePolicy: "Restricted",
      preAllocation: false,
      template: {
        spec: {
          schedulerName: config.schedulerName,
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [
                  {
                    matchExpressions: [
                      {
                        key: CAPACITY_NODE_UID,
                        operator: "In",
                        values: config.allowedNodes.map((n) => n.uid).sort(),
                      },
                    ],
                  },
                ],
              },
            },
          },
          containers: [
            {
              name: "capacity",
              image: claim.spec.profile.postgresImage,
              resources: {
                requests: {
                  cpu: slot.cpuMilli + "m",
                  memory: slot.memoryBytes,
                },
                limits: {
                  cpu: slot.cpuLimitMilli + "m",
                  memory: slot.memoryLimitBytes,
                },
              },
            },
          ],
        },
      },
      owners: [
        {
          object: { apiVersion: "v1", kind: "Pod", namespace: plan.namespace },
          labelSelector: {
            matchLabels: {
              [CAPACITY_OPERATION]: plan.binding.operationId,
              [CAPACITY_SLOT]: slot.id,
              "pgcf.io/environment-id": plan.binding.environmentId,
            },
          },
        },
      ],
    },
  });
}
function owned(actual: Resource, desired: Resource): void {
  if (actual.apiVersion !== desired.apiVersion) throw failure();
  present(
    actual,
    desired.kind,
    desired.metadata.name,
    desired.metadata.namespace,
  );
  for (const [key, value] of Object.entries(desired.metadata.labels ?? {}))
    if (actual.metadata.labels?.[key] !== value) throw failure();
  for (const [key, value] of Object.entries(desired.metadata.annotations ?? {}))
    if (actual.metadata.annotations?.[key] !== value) throw failure();
  if (desired.kind === "Reservation") {
    const a = record(actual.spec),
      d = record(desired.spec);
    if (
      a.ttl !== "0s" ||
      a.expires !== undefined ||
      a.allocateOnce !== false ||
      a.allocatePolicy !== "Restricted" ||
      (a.preAllocation ?? false) !== false ||
      a.unschedulable === true ||
      (a.taints !== undefined &&
        (!Array.isArray(a.taints) || a.taints.length !== 0)) ||
      a.preAllocationPolicy !== undefined ||
      !equal(a.owners, d.owners) ||
      !equal(a.template, d.template)
    )
      throw failure();
  } else if (desired.kind === "PersistentVolumeClaim") {
    const a = record(actual.spec),
      d = record(desired.spec);
    if (
      a.selector != null ||
      a.dataSource != null ||
      a.dataSourceRef != null ||
      a.storageClassName !== d.storageClassName ||
      !equal(a.accessModes, d.accessModes) ||
      (a.volumeMode ?? "Filesystem") !== "Filesystem" ||
      quantity(record(record(a.resources).requests).storage, 1n) !==
        quantity(record(record(d.resources).requests).storage, 1n)
    )
      throw failure();
  } else if (desired.kind === "StorageClass") {
    const a = record(actual),
      d = record(desired);
    for (const key of [
      "provisioner",
      "parameters",
      "reclaimPolicy",
      "volumeBindingMode",
      "allowVolumeExpansion",
      "allowedTopologies",
    ])
      if (!equal(a[key], d[key])) throw failure();
  } else throw failure();
}
function nodeOwner(r: Resource, uid: string): boolean {
  return (
    r.metadata.ownerReferences?.filter(
      (o) => o.kind === "Node" && o.apiVersion === "v1" && o.uid === uid,
    ).length === 1
  );
}
export function validateCapacityReservation(
  actual: Resource,
  plan: CapacityPlan,
  slot: CapacitySlotPlan,
  claim: Claim,
  config: CapacityConfiguration,
): void {
  if (
    hash(JSON.stringify(claim.spec)) !== plan.binding.specHash ||
    claim.operationId !== plan.binding.operationId ||
    claim.environmentId !== plan.binding.environmentId ||
    claim.regionId !== plan.binding.regionId ||
    (claim.runEpoch ?? null) !== plan.binding.runEpoch
  )
    throw failure();
  owned(actual, reservation(plan, slot, claim, config));
}
class Acquisition {
  private requests = 0;
  private readonly deadline: number;
  readonly runtime: CapacityRuntime;
  readonly claim: Claim;
  readonly config: CapacityConfiguration;
  readonly plan: CapacityPlan;
  readonly journal: CapacityJournal;
  readonly authorized: () => void;
  constructor(
    runtime: CapacityRuntime,
    claim: Claim,
    config: CapacityConfiguration,
    plan: CapacityPlan,
    journal: CapacityJournal,
    authorized: () => void,
  ) {
    this.runtime = runtime;
    this.claim = claim;
    this.config = config;
    this.plan = plan;
    this.journal = journal;
    this.authorized = authorized;
    this.deadline = Math.min(
      Date.now() + 20_000,
      Date.parse(claim.leaseExpiresAt),
    );
    this.check();
  }
  check(): void {
    this.authorized();
    if (["releasing", "released"].includes(this.journal.snapshot().phase))
      throw failure();
    if (!Number.isFinite(this.deadline) || Date.now() >= this.deadline)
      throw failure();
  }
  request(): void {
    this.check();
    if (++this.requests > 512) throw failure();
  }
  async list(kind: string, namespace?: string): Promise<Resource[]> {
    this.request();
    const rows = await this.runtime.list(kind, namespace);
    this.check();
    return rows;
  }
  authorizationDeadline(): number {
    this.check();
    return this.deadline;
  }
  async read(kind: string, ns: string, name: string): Promise<Resource | null> {
    this.request();
    const result = await this.runtime.read(kind, ns, name);
    this.check();
    return result;
  }
  async ensure(
    desired: Resource,
    known?: CapacityRef | null,
  ): Promise<Resource> {
    const ns = desired.metadata.namespace ?? "";
    let actual = await this.read(desired.kind, ns, desired.metadata.name);
    if (known && (!actual || actual.metadata.uid !== known.uid))
      throw failure();
    if (!actual) {
      this.check();
      let created: Resource | undefined;
      try {
        this.request();
        created = await this.runtime.create(desired, {
          check: () => this.check(),
          expiresAt: () => this.deadline,
        });
        owned(created, desired);
      } catch {
        actual = await this.read(desired.kind, ns, desired.metadata.name);
        if (!actual) throw failure();
      }
      actual ??= await this.read(desired.kind, ns, desired.metadata.name);
      if (created && actual?.metadata.uid !== created.metadata.uid)
        throw failure();
    }
    if (!actual) throw failure();
    owned(actual, desired);
    return actual;
  }
  async prerequisites(): Promise<void> {
    const c = this.config;
    const deploy = present(
      await this.read(
        "Deployment",
        c.schedulerDeployment.namespace,
        c.schedulerDeployment.name,
      ),
      "Deployment",
      c.schedulerDeployment.name,
      c.schedulerDeployment.namespace,
    );
    const status = record(deploy.status),
      spec = record(deploy.spec);
    if (
      status.observedGeneration !== deploy.metadata.generation ||
      status.readyReplicas !== spec.replicas ||
      status.availableReplicas !== spec.replicas ||
      typeof spec.replicas !== "number" ||
      spec.replicas < 1 ||
      !array(record(record(spec.template).spec).containers).some(
        (v) => record(v).image === c.schedulerDeployment.image,
      )
    )
      throw failure();
    for (const [kind, name, path] of [
      [
        "MutatingWebhookConfiguration",
        c.admission.mutatingConfiguration,
        "/mutate",
      ],
      [
        "ValidatingWebhookConfiguration",
        c.admission.validatingConfiguration,
        "/validate",
      ],
    ]) {
      const hook = present(await this.read(kind!, "", name!), kind!, name!);
      if (
        !array(record(hook).webhooks).some((value) => {
          const h = record(value),
            client = record(h.clientConfig),
            service = record(client.service);
          return (
            h.failurePolicy === "Fail" &&
            h.matchPolicy === "Equivalent" &&
            h.sideEffects === "NoneOnDryRun" &&
            array(h.admissionReviewVersions).includes("v1") &&
            typeof client.caBundle === "string" &&
            client.caBundle.length > 0 &&
            service.namespace === c.admission.serviceNamespace &&
            service.name === c.admission.serviceName &&
            service.path === path &&
            service.port === 443 &&
            (h.namespaceSelector === undefined ||
              Object.keys(record(h.namespaceSelector)).length === 0) &&
            (h.objectSelector === undefined ||
              Object.keys(record(h.objectSelector)).length === 0) &&
            array(h.matchConditions ?? []).length === 0 &&
            array(h.rules).some((v) => {
              const r = record(v);
              return (
                ["CREATE", "UPDATE"].every((o) =>
                  array(r.operations).includes(o),
                ) &&
                (array(r.apiGroups).includes("") ||
                  array(r.apiGroups).includes("*")) &&
                (array(r.apiVersions).includes("v1") ||
                  array(r.apiVersions).includes("*")) &&
                (array(r.resources).includes("pods") ||
                  array(r.resources).includes("*")) &&
                array(r.resources).includes("pods/binding") &&
                ["*", "Namespaced"].includes(String(r.scope))
              );
            })
          );
        })
      )
        throw failure();
    }
    for (const pin of c.platformReservations) {
      const margin = present(
        await this.read("Reservation", "", pin.name),
        "Reservation",
        pin.name,
      );
      const m = record(margin.spec),
        template = record(record(m.template).spec),
        cpu = c.platformMargin.cpuMilli;
      const bytes = (BigInt(c.platformMargin.memoryMiB) * 1048576n).toString();
      if (
        margin.metadata.uid !== pin.uid ||
        m.ttl !== "0s" ||
        m.expires !== undefined ||
        m.allocateOnce !== false ||
        m.allocatePolicy !== "Restricted" ||
        (m.preAllocation ?? false) !== false ||
        template.nodeName !== pin.nodeName ||
        !amounts(requestResources(template), cpu, bytes) ||
        record(margin.status).nodeName !== pin.nodeName ||
        !available(margin, cpu, bytes)
      )
        throw failure();
      const owners = array(m.owners);
      if (owners.length !== 1) throw failure();
      const o = record(record(owners[0]).object);
      if (
        o.apiVersion !== "v1" ||
        o.kind !== "Pod" ||
        o.namespace !== c.namespace ||
        !uuid.test(String(o.uid)) ||
        !dns.test(String(o.name))
      )
        throw failure();
      if (await this.read("Pod", c.namespace, String(o.name))) throw failure();
      await this.node(pin.nodeName, false);
    }
  }
  async node(name: string, storage: boolean): Promise<CapacityNode> {
    const pin = this.config.allowedNodes.find((n) => n.name === name);
    if (!pin) throw failure();
    const node = present(await this.read("Node", "", name), "Node", name);
    const status = record(node.status),
      conditions = array(status.conditions);
    if (
      node.metadata.uid !== pin.uid ||
      node.metadata.labels?.[CAPACITY_NODE_UID] !== pin.uid ||
      node.metadata.labels?.["openebs.io/nodename"] !== name ||
      record(node.spec).unschedulable === true ||
      !uuid.test(String(record(status.nodeInfo).bootID)) ||
      !["Ready", "MemoryPressure", "DiskPressure", "PIDPressure"].every(
        (type) =>
          conditions.filter(
            (v) =>
              record(v).type === type &&
              record(v).status === (type === "Ready" ? "True" : "False"),
          ).length === 1,
      )
    )
      throw failure();
    const result: CapacityNode = {
      name,
      uid: pin.uid,
      bootId: String(record(status.nodeInfo).bootID),
      topologyKey: "openebs.io/nodename",
      topologyValue: name,
      vgUuid: null,
    };
    if (storage) {
      const csi = present(
        await this.read("CSINode", "", name),
        "CSINode",
        name,
      );
      if (
        !nodeOwner(csi, pin.uid) ||
        !array(record(csi.spec).drivers).some(
          (d) =>
            record(d).name === "local.csi.openebs.io" &&
            record(d).nodeID === name &&
            array(record(d).topologyKeys).includes("openebs.io/nodename"),
        )
      )
        throw failure();
      const lvm = present(
        await this.read("LVMNode", this.config.storageNamespace, name),
        "LVMNode",
        name,
        this.config.storageNamespace,
      );
      if (!nodeOwner(lvm, pin.uid)) throw failure();
      const sc = record(
        present(
          await this.read("StorageClass", "", this.plan.customerStorageClass),
          "StorageClass",
          this.plan.customerStorageClass,
        ),
      );
      const params = record(sc.parameters);
      if (
        sc.provisioner !== "local.csi.openebs.io" ||
        sc.volumeBindingMode !== "WaitForFirstConsumer" ||
        sc.reclaimPolicy !== "Retain" ||
        sc.allowVolumeExpansion !== true ||
        params.storage !== "lvm" ||
        params.thinProvision !== "no" ||
        params.fsType !== "ext4" ||
        typeof params.vgpattern !== "string" ||
        !/^\^[A-Za-z0-9_-]{1,64}\$$/.test(params.vgpattern)
      )
        throw failure();
      const groups = array(record(lvm).volumeGroups).filter(
        (g) => record(g).name === String(params.vgpattern).slice(1, -1),
      );
      if (groups.length !== 1) throw failure();
      const vg = record(groups[0]);
      if (
        vg.permissions !== 0 ||
        vg.missingPvCount !== 0 ||
        typeof vg.uuid !== "string" ||
        !/^[A-Za-z0-9-]{1,128}$/.test(vg.uuid) ||
        quantity(vg.size, 1n) === null ||
        quantity(vg.free, 1n) === null
      )
        throw failure();
      result.vgUuid = vg.uuid;
    }
    return result;
  }
  async storage(
    slot: CapacitySlotPlan,
    node: CapacityNode,
  ): Promise<CapacityStorage | null> {
    const current = this.journal.snapshot();
    const recorded = current.slots.find((s) => s.plan.id === slot.id)!;
    if (recorded.handoffPhase !== "none")
      return inspectCapacityTransfer(
        (kind, ns, name) => this.read(kind, ns, name),
        current,
        recorded,
      );
    const sc = record(
      present(
        await this.read("StorageClass", "", this.plan.customerStorageClass),
        "StorageClass",
        this.plan.customerStorageClass,
      ),
    );
    const className =
      this.plan.holdStorageClassPrefix +
      "-" +
      hash(this.plan.binding.operationId + "/" + node.uid).slice(0, 16);
    await this.ensure(
      resource({
        apiVersion: "storage.k8s.io/v1",
        kind: "StorageClass",
        metadata: metadata(this.plan, className),
        provisioner: sc.provisioner,
        parameters: sc.parameters,
        reclaimPolicy: "Retain",
        volumeBindingMode: "WaitForFirstConsumer",
        allowVolumeExpansion: true,
        allowedTopologies: [
          {
            matchLabelExpressions: [
              { key: node.topologyKey, values: [node.topologyValue] },
            ],
          },
        ],
      }),
    );
    const pvc = await this.ensure(
      resource({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          ...metadata(
            this.plan,
            slot.holdPvcName!,
            slot.id,
            this.plan.holdNamespace,
          ),
          annotations: {
            ...metadata(this.plan, slot.holdPvcName!).annotations,
            "volume.kubernetes.io/selected-node": node.name,
          },
        },
        spec: {
          accessModes: ["ReadWriteOnce"],
          volumeMode: "Filesystem",
          storageClassName: className,
          resources: { requests: { storage: slot.volumeBytes } },
        },
      }),
      this.journal.snapshot().slots.find((s) => s.plan.id === slot.id)!.holdPvc,
    );
    this.journal.observeStorageClaim(slot.id, ref(pvc));
    if (record(pvc.status ?? {}).phase !== "Bound") return null;
    const pvName = record(pvc.spec).volumeName;
    if (typeof pvName !== "string") throw failure();
    const pv = present(
      await this.read("PersistentVolume", "", pvName),
      "PersistentVolume",
      pvName,
    );
    const p = record(pv.spec),
      cr = record(p.claimRef),
      csi = record(p.csi);
    if (
      record(pv.status).phase !== "Bound" ||
      p.storageClassName !== className ||
      p.persistentVolumeReclaimPolicy !== "Retain" ||
      !equal(p.accessModes, ["ReadWriteOnce"]) ||
      (p.volumeMode ?? "Filesystem") !== "Filesystem" ||
      quantity(record(p.capacity).storage, 1n) !== BigInt(slot.volumeBytes!) ||
      cr.uid !== pvc.metadata.uid ||
      cr.name !== pvc.metadata.name ||
      cr.namespace !== pvc.metadata.namespace ||
      csi.driver !== "local.csi.openebs.io" ||
      typeof csi.volumeHandle !== "string"
    )
      throw failure();
    const terms = array(
      record(record(p.nodeAffinity).required).nodeSelectorTerms,
    );
    if (
      terms.length !== 1 ||
      !equal(record(terms[0]).matchExpressions, [
        { key: node.topologyKey, operator: "In", values: [node.name] },
      ])
    )
      throw failure();
    this.journal.observeVolumeIdentity(slot.id, "pv", ref(pv));
    const lv = present(
      await this.read(
        "LVMVolume",
        this.config.storageNamespace,
        csi.volumeHandle,
      ),
      "LVMVolume",
      csi.volumeHandle,
      this.config.storageNamespace,
    );
    const l = record(lv.spec),
      params = record(sc.parameters),
      group = String(params.vgpattern).slice(1, -1);
    if (
      record(lv.status).state !== "Ready" ||
      l.ownerNodeID !== node.name ||
      l.volGroup !== group ||
      l.vgPattern !== params.vgpattern ||
      l.thinProvision !== "no" ||
      quantity(l.capacity, 1n) !== BigInt(slot.volumeBytes!) ||
      record(csi.volumeAttributes)["openebs.io/volgroup"] !== group
    )
      throw failure();
    this.journal.observeVolumeIdentity(slot.id, "lvmVolume", ref(lv));
    if (!equal(await this.node(node.name, true), node)) throw failure();
    return {
      holdPvc: ref(pvc),
      pv: ref(pv),
      lvmVolume: ref(lv),
      csiHandle: csi.volumeHandle,
      bytes: slot.volumeBytes!,
      storageClassName: className,
    };
  }
  async reservationUse(r: Resource, slot: CapacitySlotState): Promise<boolean> {
    if (slot.consumers.length === 0)
      return available(r, slot.plan.cpuMilli, slot.plan.memoryBytes);
    if (!reservationReady(r, slot.plan.cpuMilli, slot.plan.memoryBytes))
      return false;
    const state = this.journal.snapshot();
    if (
      !slot.node ||
      !slot.reservation ||
      !state.namespaceUid ||
      !state.clusterUid ||
      state.podQuotaGate?.phase !== "open"
    )
      throw failure();
    const ns = present(
      await this.read("Namespace", "", state.plan.namespace),
      "Namespace",
      state.plan.namespace,
    );
    if (ns.metadata.uid !== state.namespaceUid) throw failure();
    const owners = array(record(r.status).currentOwners ?? []).map(record);
    const ownerIds = new Set<string>();
    let retiredProjection = false;
    for (const owner of owners) {
      const consumer = slot.consumers.find((c) => c.uid === owner.uid);
      if (
        !consumer ||
        owner.name !== consumer.name ||
        owner.namespace !== consumer.namespace ||
        ownerIds.has(consumer.uid)
      )
        throw failure();
      ownerIds.add(consumer.uid);
      if (slot.retirements.some((v) => v.podUid === consumer.uid))
        retiredProjection = true;
    }
    if (retiredProjection) return false;
    const active = slot.consumers.filter(
      (c) => !slot.retirements.some((v) => v.podUid === c.uid),
    );
    if (active.length > 1) throw failure();
    if (active.length === 0)
      return available(r, slot.plan.cpuMilli, slot.plan.memoryBytes);
    let cpu = 0n,
      memory = 0n;
    let pending = false;
    for (const consumer of active) {
      const pod = present(
        await this.read("Pod", consumer.namespace, consumer.name),
        "Pod",
        consumer.name,
        consumer.namespace,
      );
      const attempt = state.attempts.find(
        (a) => a.podUid === consumer.uid && a.slotId === slot.plan.id,
      );
      const annotations = pod.metadata.annotations ?? {},
        labels = pod.metadata.labels ?? {};
      const allocation = record(
        JSON.parse(annotations[RESERVATION_ALLOCATED] ?? "null"),
      );
      if (
        pod.metadata.uid !== consumer.uid ||
        consumer.nodeUid !== slot.node.uid ||
        !attempt ||
        annotations[CAPACITY_ATTEMPT] !== attempt.id ||
        labels[CAPACITY_OPERATION] !== state.plan.binding.operationId ||
        labels[CAPACITY_SLOT] !== slot.plan.id ||
        labels["pgcf.io/environment-id"] !== state.plan.binding.environmentId ||
        [RESERVATION_IGNORED, RESERVATION_RESTRICTED_OPTIONS].some(
          (key) => labels[key] !== undefined || annotations[key] !== undefined,
        ) ||
        annotations[RESERVATION_AFFINITY] !==
          JSON.stringify({ name: slot.reservation.name }) ||
        allocation.name !== slot.reservation.name ||
        allocation.uid !== slot.reservation.uid ||
        !pod.metadata.finalizers?.includes(
          "pgcf.io/capacity-" + state.plan.binding.operationId,
        ) ||
        record(pod.spec).schedulerName !== this.config.schedulerName ||
        !consumer.ownerChain ||
        consumer.ownerChain.length < 1 ||
        consumer.ownerChain.length > 4
      )
        throw failure();
      let child = pod;
      for (const owner of consumer.ownerChain) {
        const references = child.metadata.ownerReferences;
        if (
          references?.length !== 1 ||
          references[0]?.kind !== owner.kind ||
          references[0].name !== owner.name ||
          references[0].uid !== owner.uid ||
          references[0].controller !== true
        )
          throw failure();
        const parent = present(
          await this.read(owner.kind, state.plan.namespace, owner.name),
          owner.kind,
          owner.name,
          state.plan.namespace,
        );
        if (parent.metadata.uid !== owner.uid) throw failure();
        if (
          owner.kind === "Cluster" &&
          (owner.uid !== state.clusterUid ||
            owner.name !== "database" ||
            parent.metadata.annotations?.["pgcf.io/spec-hash"] !==
              state.plan.binding.specHash)
        )
          throw failure();
        if (
          owner.kind === "Pooler" &&
          (owner.uid !== state.poolerUid ||
            record(record(parent.spec).cluster).name !== "database")
        )
          throw failure();
        if (
          owner.kind === "Deployment" &&
          record(record(parent.spec).strategy).type !== "Recreate"
        )
          throw failure();
        child = parent;
      }
      if (
        consumer.ownerChain.at(-1)?.kind !== "Cluster" ||
        consumer.ownerChain.at(-1)?.uid !== state.clusterUid
      )
        throw failure();
      const p = record(pod.spec);
      if (p.nodeName === undefined) {
        pending = true;
        continue;
      }
      if (
        p.nodeName !== slot.node.name ||
        hash(canonicalCohort(pod.spec)) !== consumer.specHash
      )
        throw failure();
      const requests = effectiveCapacityResources(pod, "requests");
      cpu += requests[0];
      memory += requests[1];
      if (!ownerIds.has(consumer.uid)) pending = true;
    }
    if (pending) return false;
    const allocated = capacityResourceAmounts(
      record(r.status).allocated ?? { cpu: "0", memory: "0" },
    );
    if (allocated[0] !== cpu || allocated[1] !== memory) return false;
    if (
      cpu > BigInt(slot.plan.cpuMilli) ||
      memory > BigInt(slot.plan.memoryBytes)
    )
      throw failure();
    return true;
  }
  async observe(): Promise<boolean> {
    if (["releasing", "released"].includes(this.journal.snapshot().phase))
      throw failure();
    await this.prerequisites();
    let ready = true;
    for (const slot of this.plan.slots) {
      const r = await this.ensure(
        reservation(this.plan, slot, this.claim, this.config),
        this.journal.snapshot().slots.find((s) => s.plan.id === slot.id)!
          .reservation,
      );
      this.journal.observeReservation(slot.id, ref(r));
      if (
        !(await this.reservationUse(
          r,
          this.journal.snapshot().slots.find((s) => s.plan.id === slot.id)!,
        ))
      ) {
        ready = false;
        continue;
      }
      const node = await this.node(
        String(record(r.status).nodeName),
        slot.kind === "database",
      );
      this.journal.observeNode(slot.id, node);
      const storage =
        slot.kind === "database" ? await this.storage(slot, node) : undefined;
      if (storage === null) {
        ready = false;
        continue;
      }
      this.journal.observeHold(slot.id, {
        reservation: ref(r),
        node,
        ...(storage ? { storage } : {}),
      });
    }
    if (ready) this.journal.available();
    return ready;
  }
}
export class CapacityBarrier {
  private readonly acquisition: Acquisition;
  constructor(acquisition: Acquisition) {
    this.acquisition = acquisition;
  }
  snapshot(): CapacitySnapshot {
    return this.acquisition.journal.snapshot();
  }
  close(): void {
    this.acquisition.journal.close();
  }
  // Internal operation coordinator access; never part of the management API.
  custody(): CapacityJournal {
    return this.acquisition.journal;
  }
  dispatchAuthority(): { check: () => void; expiresAt: () => number } {
    return {
      check: () => this.acquisition.check(),
      expiresAt: () => this.acquisition.authorizationDeadline(),
    };
  }
  async refresh(): Promise<void> {
    if (!(await this.acquisition.observe())) throw failure();
  }
  async beforeCluster(): Promise<void> {
    const a = this.acquisition,
      s = a.journal.snapshot();
    a.check();
    if (!s.namespaceUid) throw failure();
    const namespace = present(
      await a.read("Namespace", "", s.plan.namespace),
      "Namespace",
      s.plan.namespace,
    );
    this.validateRuntimeIdentity(namespace, "Namespace");
    if (namespace.metadata.uid !== s.namespaceUid) throw failure();
    const quota = present(
      await a.read("ResourceQuota", s.plan.namespace, "database-resources"),
      "ResourceQuota",
      "database-resources",
      s.plan.namespace,
    );
    if (
      quota.metadata.labels?.["app.kubernetes.io/managed-by"] !==
        "cloudflare-postgres" ||
      quota.metadata.labels?.["pgcf.io/environment-id"] !==
        s.plan.binding.environmentId ||
      quota.metadata.labels?.["pgcf.io/region-id"] !==
        s.plan.binding.regionId ||
      quota.metadata.annotations?.["pgcf.io/spec-hash"] !==
        s.plan.binding.specHash ||
      (quota.metadata.annotations?.["pgcf.io/run-epoch"] ?? null) !==
        s.plan.binding.runEpoch
    )
      throw failure();
    a.journal.bindRuntime({
      namespaceUid: s.namespaceUid,
      quotaUid: ref(quota).uid,
    });
    a.check();
    const pods = await a.list("Pod", s.plan.namespace);
    a.check();
    const gate = s.podQuotaGate;
    if (gate && gate.phase !== "opening") {
      if (
        !s.clusterUid ||
        quota.metadata.uid !== gate.quota.uid ||
        !equal(quota.spec, gate.openSpec)
      )
        throw failure();
      const cluster = present(
        await a.read("Cluster", s.plan.namespace, "database"),
        "Cluster",
        "database",
        s.plan.namespace,
      );
      this.validateRuntimeIdentity(cluster, "Cluster");
      if (cluster.metadata.uid !== s.clusterUid) throw failure();
      if (gate.phase === "applied") {
        if (
          pods.length !== 0 ||
          (!equal(record(quota.status).hard, record(gate.closedSpec).hard) &&
            !equal(record(quota.status).hard, record(gate.openSpec).hard))
        )
          throw failure();
      } else {
        if (
          !equal(record(quota.status).hard, record(gate.openSpec).hard) ||
          !(await a.observe())
        )
          throw failure();
        const current = a.journal.snapshot();
        for (const pod of pods) {
          present(pod, "Pod", pod.metadata.name, s.plan.namespace);
          const labels = pod.metadata.labels ?? {},
            annotations = pod.metadata.annotations ?? {};
          const attempt = current.attempts.find(
            (v) => v.id === annotations[CAPACITY_ATTEMPT],
          );
          const slot = current.slots.find(
            (v) => v.plan.id === labels[CAPACITY_SLOT],
          );
          if (
            !attempt ||
            !slot ||
            attempt.slotId !== slot.plan.id ||
            attempt.name !== pod.metadata.name ||
            attempt.namespace !== s.plan.namespace ||
            labels[CAPACITY_OPERATION] !== s.plan.binding.operationId ||
            labels["pgcf.io/environment-id"] !== s.plan.binding.environmentId ||
            !pod.metadata.finalizers?.includes(
              "pgcf.io/capacity-" + s.plan.binding.operationId,
            ) ||
            (attempt.podUid === null
              ? Boolean(record(pod.spec).nodeName)
              : attempt.podUid !== pod.metadata.uid) ||
            (attempt.podUid !== null &&
              !slot.consumers.some((v) => v.uid === pod.metadata.uid))
          )
            throw failure();
        }
      }
      a.check();
      return;
    }
    if (
      record(record(quota.spec).hard).pods !== "0" ||
      record(record(quota.status).hard).pods !== "0" ||
      record(record(quota.status).used).pods !== "0" ||
      pods.length !== 0
    )
      throw failure();
    a.check();
  }
  private validateRuntimeIdentity(
    r: Resource,
    kind: "Namespace" | "Cluster",
  ): void {
    const a = this.acquisition;
    present(
      r,
      kind,
      kind === "Namespace" ? a.plan.namespace : "database",
      kind === "Namespace" ? "" : a.plan.namespace,
    );
    if (
      r.apiVersion !==
        (r.kind === "Namespace" ? "v1" : "postgresql.cnpg.io/v1") ||
      r.metadata.labels?.["app.kubernetes.io/managed-by"] !==
        "cloudflare-postgres" ||
      r.metadata.labels?.["pgcf.io/environment-id"] !==
        a.plan.binding.environmentId ||
      r.metadata.labels?.["pgcf.io/region-id"] !== a.plan.binding.regionId ||
      r.metadata.annotations?.["pgcf.io/spec-hash"] !==
        a.plan.binding.specHash ||
      (r.metadata.annotations?.["pgcf.io/run-epoch"] ?? null) !==
        a.plan.binding.runEpoch
    )
      throw failure();
    if (
      r.kind === "Cluster" &&
      (record(record(r.spec).storage).storageClass !==
        a.plan.customerStorageClass ||
        quantity(record(record(r.spec).storage).size, 1n) !==
          BigInt(a.claim.spec.volumeGiB) * 1073741824n ||
        record(r.spec).imageName !== a.claim.spec.profile.postgresImage)
    )
      throw failure();
  }
  wrap(api: Kubernetes, fundingCheck: () => void | Promise<void>): Kubernetes {
    const a = this.acquisition;
    const query = async <T>(read: () => Promise<T>): Promise<T> => {
      a.request();
      const result = await read();
      a.check();
      return result;
    };
    return {
      ...api,
      readSecret: (...args) => query(() => api.readSecret(...args)),
      listPods: (...args) => query(() => api.listPods(...args)),
      ...(api.listNodes
        ? { listNodes: () => query(() => api.listNodes!()) }
        : {}),
      ...(api.executionPreflight
        ? {
            executionPreflight: (...args: [string]) =>
              query(() => api.executionPreflight!(...args)),
          }
        : {}),
      ...(api.listEndpointSlices
        ? {
            listEndpointSlices: (...args: [string, string]) =>
              query(() => api.listEndpointSlices!(...args)),
          }
        : {}),
      ...(api.readPublicCertificate
        ? {
            readPublicCertificate: (
              ...args: [string, string, "ca.crt" | "tls.crt"]
            ) => query(() => api.readPublicCertificate!(...args)),
          }
        : {}),
      read: async (kind, namespace, name) => {
        a.check();
        a.request();
        const result = await api.read(kind, namespace, name);
        a.check();
        const managedNamespace =
          kind === "Namespace" && namespace === "" && name === a.plan.namespace;
        const managedCluster =
          kind === "Cluster" &&
          namespace === a.plan.namespace &&
          name === "database";
        if (!managedNamespace && !managedCluster) return result;
        const state = a.journal.snapshot();
        const knownUid = managedNamespace
          ? state.namespaceUid
          : state.clusterUid;
        if (!result) {
          if (knownUid) throw failure();
          return null;
        }
        this.validateRuntimeIdentity(
          result,
          managedNamespace ? "Namespace" : "Cluster",
        );
        if (knownUid && result.metadata.uid !== knownUid) throw failure();
        if (managedCluster) {
          if (!state.namespaceUid) throw failure();
          // A lost Cluster response is recoverable only while compute is
          // demonstrably closed; this is not permission to resume Pods.
          await this.beforeCluster();
        }
        a.check();
        a.journal.beginEffects();
        a.journal.bindRuntime(
          managedNamespace
            ? { namespaceUid: ref(result).uid }
            : {
                namespaceUid: state.namespaceUid!,
                clusterUid: ref(result).uid,
              },
        );
        return result;
      },
      create: async (r, authority) => {
        if (
          r.kind === "Namespace"
            ? r.metadata.name !== a.plan.namespace
            : r.metadata.namespace !== a.plan.namespace
        )
          throw failure();
        const sealed = a.journal.snapshot();
        if (
          (r.kind === "Namespace" && sealed.namespaceUid) ||
          (r.kind === "Cluster" && sealed.clusterUid) ||
          (r.kind === "Pooler" && sealed.poolerUid)
        )
          throw failure();
        // Compute remains closed until protected admission and exact storage
        // handoff are integrated. Acquisition is not runtime authorization.
        if (
          ![
            "Namespace",
            "ResourceQuota",
            "LimitRange",
            "ConfigMap",
            "Secret",
            "CiliumNetworkPolicy",
            "NetworkPolicy",
            "ObjectStore",
            "Cluster",
            "Pooler",
          ].includes(r.kind)
        )
          throw failure();
        if (!(await a.observe())) throw failure();
        if (
          r.kind === "ResourceQuota" &&
          record(record(r.spec).hard).pods !== "0"
        )
          throw failure();
        if (r.kind === "Cluster") {
          if (
            r.metadata.name !== "database" ||
            r.apiVersion !== "postgresql.cnpg.io/v1" ||
            r.metadata.labels?.["pgcf.io/environment-id"] !==
              a.plan.binding.environmentId ||
            r.metadata.labels?.["pgcf.io/region-id"] !==
              a.plan.binding.regionId ||
            r.metadata.annotations?.["pgcf.io/spec-hash"] !==
              a.plan.binding.specHash ||
            record(record(r.spec).storage).storageClass !==
              a.plan.customerStorageClass ||
            quantity(record(record(r.spec).storage).size, 1n) !==
              BigInt(a.claim.spec.volumeGiB) * 1073741824n ||
            record(r.spec).imageName !== a.claim.spec.profile.postgresImage
          )
            throw failure();
          await this.beforeCluster();
        }
        if (r.kind === "Pooler") {
          const owner = r.metadata.ownerReferences?.[0];
          const spec = record(r.spec);
          if (
            !a.claim.spec.profile.pooling ||
            sealed.podQuotaGate?.phase !== "open" ||
            !sealed.clusterUid ||
            r.apiVersion !== "postgresql.cnpg.io/v1" ||
            r.metadata.name !== "database-pool-rw" ||
            r.metadata.labels?.["app.kubernetes.io/managed-by"] !==
              "cloudflare-postgres" ||
            r.metadata.labels?.["pgcf.io/environment-id"] !==
              a.plan.binding.environmentId ||
            r.metadata.labels?.["pgcf.io/region-id"] !==
              a.plan.binding.regionId ||
            r.metadata.annotations?.["pgcf.io/spec-hash"] !==
              a.plan.binding.specHash ||
            (r.metadata.annotations?.["pgcf.io/run-epoch"] ?? null) !==
              a.plan.binding.runEpoch ||
            r.metadata.ownerReferences?.length !== 1 ||
            !owner ||
            owner.kind !== "Cluster" ||
            owner.name !== "database" ||
            owner.apiVersion !== "postgresql.cnpg.io/v1" ||
            owner.uid !== sealed.clusterUid ||
            owner.controller !== true ||
            record(spec.cluster).name !== "database" ||
            spec.instances !== 1 ||
            record(spec.deploymentStrategy).type !== "Recreate" ||
            record(spec.pgbouncer).image !== a.claim.spec.profile.pooling.image
          )
            throw failure();
          await this.beforeCluster();
        }
        a.journal.beginEffects();
        await fundingCheck();
        a.check();
        a.request();
        const result = await api.create(r, {
          check: () => {
            a.check();
            authority?.check();
          },
          expiresAt: () =>
            Math.min(
              a.authorizationDeadline(),
              authority?.expiresAt() ?? Number.POSITIVE_INFINITY,
            ),
        });
        a.check();
        if (r.kind === "Namespace" || r.kind === "Cluster") {
          this.validateRuntimeIdentity(result, r.kind);
          a.journal.bindRuntime(
            r.kind === "Namespace"
              ? { namespaceUid: ref(result).uid }
              : {
                  namespaceUid: a.journal.snapshot().namespaceUid!,
                  clusterUid: ref(result).uid,
                },
          );
        }
        if (r.kind === "Pooler") {
          present(result, "Pooler", r.metadata.name, a.plan.namespace);
          a.journal.bindRuntime({
            namespaceUid: a.journal.snapshot().namespaceUid!,
            poolerUid: ref(result).uid,
          });
        }
        return result;
      },
    };
  }
}
// Persist the exact plan before funding transport, without contacting Kubernetes.
// A later lease still refuses missing custody instead of inventing a new hold.
export function initializeCapacityCustody(
  claim: Claim,
  config: CapacityConfiguration,
  authorized: () => void,
): void {
  authorized();
  const plan = planFor(claim, config);
  const journal = new CapacityJournal(
    join(config.journalDirectory, claim.operationId + ".sqlite"),
    plan,
    claim.leaseEpoch,
  );
  try {
    authorized();
  } finally {
    journal.close();
  }
}
export async function acquireCapacity(
  runtime: CapacityRuntime,
  claim: Claim,
  config: CapacityConfiguration,
  authorized: () => void,
): Promise<CapacityBarrier | null> {
  const plan = planFor(claim, config);
  authorized();
  const journal = new CapacityJournal(
    join(config.journalDirectory, claim.operationId + ".sqlite"),
    plan,
    claim.leaseEpoch,
  );
  try {
    const a = new Acquisition(
      runtime,
      claim,
      config,
      plan,
      journal,
      authorized,
    );
    if (!(await a.observe())) {
      journal.close();
      return null;
    }
    return new CapacityBarrier(a);
  } catch (error) {
    journal.close();
    throw error;
  }
}
