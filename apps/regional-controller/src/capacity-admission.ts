// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { quantity } from "./owned-stop.ts";
import {
  capacityResourceAmounts as resources,
  effectiveCapacityResources as effective,
} from "./capacity-pod-resources.ts";
import { canonicalCohort } from "./node-cohort.ts";
import { validateCapacityReservation } from "./capacity-reconcile.ts";
import {
  CAPACITY_OPERATION,
  CAPACITY_SLOT,
  CAPACITY_ATTEMPT,
  RESERVATION_AFFINITY,
  RESERVATION_ALLOCATED,
  RESERVATION_IGNORED,
  RESERVATION_RESTRICTED_OPTIONS,
} from "./capacity-types.ts";
import type { CapacityJournal } from "./capacity-journal.ts";
import type {
  CapacityConfiguration,
  CapacityRuntime,
  CapacitySnapshot,
  CapacitySlotState,
} from "./capacity-types.ts";
import type { CapacityFundingFence } from "./capacity-handoff.ts";
import type { Resource, Claim } from "./types.ts";
export interface CapacityAdmissionContext {
  claim: Claim;
  runtime: CapacityRuntime;
  journal: CapacityJournal;
  config: CapacityConfiguration;
  funding: CapacityFundingFence;
  authority: { check: () => void; expiresAt: () => number };
  transportAuthenticated: () => boolean;
  executionPrepared: (
    pod: Resource,
    state: CapacitySnapshot,
    slot: CapacitySlotState,
  ) => boolean;
  workloadVolumesPrepared: (
    pod: Resource,
    state: CapacitySnapshot,
    slot: CapacitySlotState,
  ) => boolean;
}
export interface CapacityAdmissionResponse {
  uid: string;
  allowed: boolean;
  status?: { code: number; message: string };
  patchType?: "JSONPatch";
  patch?: string;
}
const fail = () => new Error("capacity_admission_unproven");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalCohort(v)).digest("hex");
const equal = (a: unknown, b: unknown) =>
  canonicalCohort(a) === canonicalCohort(b);
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw fail();
  return v as Record<string, unknown>;
}
function items(v: unknown): unknown[] {
  if (!Array.isArray(v) || v.length > 64) throw fail();
  return v;
}
function owner(
  r: Resource,
  kind: string,
  uid?: string,
): Record<string, unknown> {
  const refs = r.metadata.ownerReferences;
  if (
    refs?.length !== 1 ||
    refs[0]?.kind !== kind ||
    refs[0].controller !== true ||
    (uid !== undefined && refs[0].uid !== uid)
  )
    throw fail();
  return object(refs[0]);
}
function resource(v: unknown): Resource {
  const r = object(v);
  object(r.metadata);
  return r as unknown as Resource;
}
function podPolicy(
  pod: Resource,
  slot: CapacitySlotState,
  ctx: CapacityAdmissionContext,
): void {
  const p = object(pod.spec),
    containers = [...items(p.containers), ...items(p.initContainers ?? [])];
  if (
    p.hostNetwork === true ||
    p.hostPID === true ||
    p.hostIPC === true ||
    p.shareProcessNamespace === true ||
    containers.length === 0 ||
    containers.some((v) => {
      const c = object(v),
        security =
          c.securityContext === undefined ? {} : object(c.securityContext);
      return (
        typeof c.image !== "string" ||
        !ctx.config.admission.approvedImages.includes(c.image) ||
        !/^[A-Za-z0-9./_:-]+@sha256:[a-f0-9]{64}$/.test(c.image) ||
        security.privileged === true ||
        security.allowPrivilegeEscalation === true
      );
    })
  )
    throw fail();
  const requests = effective(pod, "requests"),
    limits = effective(pod, "limits");
  if (
    requests[0] > BigInt(slot.plan.cpuMilli) ||
    requests[1] > BigInt(slot.plan.memoryBytes) ||
    limits[0] > BigInt(slot.plan.cpuLimitMilli) ||
    limits[1] > BigInt(slot.plan.memoryLimitBytes) ||
    requests.some((v, i) => v <= 0n || limits[i]! < v)
  )
    throw fail();
}
function nodeAffinity(slot: CapacitySlotState): unknown {
  if (!slot.node) throw fail();
  return {
    requiredDuringSchedulingIgnoredDuringExecution: {
      nodeSelectorTerms: [
        {
          matchExpressions: [
            {
              key: "pgcf.io.node-restriction.kubernetes.io/capacity-node-uid",
              operator: "In",
              values: [slot.node.uid],
            },
          ],
        },
      ],
    },
  };
}
export async function capacityAdmission(
  review: unknown,
  lane: "mutate" | "validate",
  ctx: CapacityAdmissionContext,
): Promise<CapacityAdmissionResponse> {
  let uid = "";
  try {
    const envelope = object(review),
      request = object(envelope.request);
    uid = typeof request.uid === "string" ? request.uid : "";
    if (
      envelope.apiVersion !== "admission.k8s.io/v1" ||
      envelope.kind !== "AdmissionReview" ||
      !uuid.test(uid) ||
      !ctx.transportAuthenticated() ||
      request.dryRun === true
    )
      throw fail();
    ctx.authority.check();
    await ctx.funding.refresh();
    ctx.funding.check();
    const deadline = Math.min(
      Date.now() + 10000,
      ctx.authority.expiresAt(),
      ctx.funding.expiresAt(),
    );
    const check = () => {
      ctx.authority.check();
      ctx.funding.check();
      if (!Number.isSafeInteger(deadline) || Date.now() >= deadline)
        throw fail();
    };
    check();
    const state = ctx.journal.snapshot(),
      ns = state.plan.namespace,
      user = String(object(request.userInfo).username);
    if (
      request.namespace !== ns ||
      !state.namespaceUid ||
      !state.clusterUid ||
      state.plan.binding.runEpoch !== "1" ||
      !["materializing", "active"].includes(state.phase)
    )
      throw fail();
    const namespace = await ctx.runtime.read("Namespace", "", ns);
    if (
      namespace?.metadata.uid !== state.namespaceUid ||
      namespace.metadata.deletionTimestamp
    )
      throw fail();
    const kind = object(request.kind),
      input = resource(request.object);
    const read = async (kind: string, name: string, namespace = ns) => {
      check();
      const r = await ctx.runtime.read(kind, namespace, name);
      check();
      if (
        !r ||
        r.kind !== kind ||
        r.metadata.name !== name ||
        (r.metadata.namespace ?? "") !== namespace ||
        r.metadata.deletionTimestamp
      )
        throw fail();
      return r;
    };
    let pod = input,
      binding = false;
    if (
      kind.kind === "Binding" &&
      request.operation === "CREATE" &&
      request.subResource === "binding"
    ) {
      if (
        lane !== "validate" ||
        user !== ctx.config.admission.schedulerUsername ||
        kind.group !== "" ||
        kind.version !== "v1"
      )
        throw fail();
      pod = await read("Pod", String(input.metadata.name));
      binding = true;
      if (input.metadata.uid !== pod.metadata.uid) throw fail();
    } else if (
      kind.kind !== "Pod" ||
      kind.group !== "" ||
      kind.version !== "v1" ||
      !["CREATE", "UPDATE"].includes(String(request.operation)) ||
      request.subResource
    )
      throw fail();
    if (
      pod.kind !== "Pod" ||
      pod.apiVersion !== "v1" ||
      pod.metadata.namespace !== ns ||
      pod.metadata.deletionTimestamp
    )
      throw fail();
    const cluster = await read("Cluster", "database");
    if (
      cluster.metadata.uid !== state.clusterUid ||
      cluster.metadata.annotations?.["pgcf.io/spec-hash"] !==
        state.plan.binding.specHash
    )
      throw fail();
    const labels = pod.metadata.labels ?? {},
      annotations = pod.metadata.annotations ?? {};
    if (
      [RESERVATION_IGNORED, RESERVATION_RESTRICTED_OPTIONS].some(
        (k) => labels[k] !== undefined || annotations[k] !== undefined,
      ) ||
      (request.operation === "CREATE" &&
        !binding &&
        (annotations[RESERVATION_ALLOCATED] !== undefined ||
          labels[RESERVATION_ALLOCATED] !== undefined))
    )
      throw fail();
    let slot: CapacitySlotState | undefined;
    let ownerLineage: { kind: string; name: string; uid: string }[] = [];
    const refs = pod.metadata.ownerReferences;
    if (refs?.[0]?.kind === "Cluster") {
      owner(pod, "Cluster", state.clusterUid);
      ownerLineage = [
        { kind: "Cluster", name: "database", uid: state.clusterUid },
      ];
      if (
        !binding &&
        request.operation === "CREATE" &&
        user !== ctx.config.admission.cnpgUsername
      )
        throw fail();
      const serial = /^database-([1-9][0-9]*)$/.exec(
        labels["cnpg.io/instanceName"] ?? "",
      );
      if (
        !serial ||
        pod.metadata.name !== serial[0] ||
        labels["cnpg.io/podRole"] !== "instance" ||
        annotations["cnpg.io/nodeSerial"] !== serial[1]
      )
        throw fail();
      slot = state.slots.find(
        (s) => s.plan.id === "database-" + (Number(serial[1]) - 1),
      );
    } else if (refs?.[0]?.kind === "Job") {
      const ref = owner(pod, "Job"),
        job = await read("Job", String(ref.name));
      if (job.metadata.uid !== ref.uid) throw fail();
      owner(job, "Cluster", state.clusterUid);
      ownerLineage = [
        { kind: "Job", name: job.metadata.name, uid: job.metadata.uid! },
        { kind: "Cluster", name: "database", uid: state.clusterUid },
      ];
      if (
        !binding &&
        request.operation === "CREATE" &&
        user !== ctx.config.admission.jobUsername
      )
        throw fail();
      const instance = labels["cnpg.io/instanceName"],
        role = labels["cnpg.io/jobRole"],
        serial = /^database-([1-9][0-9]*)$/.exec(instance ?? "");
      if (
        !serial ||
        !["initdb", "join"].includes(role ?? "") ||
        job.metadata.name !== instance + "-" + role ||
        job.metadata.labels?.["cnpg.io/instanceName"] !== instance ||
        job.metadata.labels?.["cnpg.io/jobRole"] !== role
      )
        throw fail();
      slot = state.slots.find(
        (s) => s.plan.id === "database-" + (Number(serial[1]) - 1),
      );
    } else if (refs?.[0]?.kind === "ReplicaSet") {
      const ref = owner(pod, "ReplicaSet"),
        rs = await read("ReplicaSet", String(ref.name));
      if (rs.metadata.uid !== ref.uid) throw fail();
      const deploymentRef = owner(rs, "Deployment"),
        deployment = await read("Deployment", String(deploymentRef.name));
      if (
        deployment.metadata.uid !== deploymentRef.uid ||
        object(object(deployment.spec).strategy).type !== "Recreate"
      )
        throw fail();
      const poolRef = owner(deployment, "Pooler"),
        pool = await read("Pooler", String(poolRef.name));
      if (
        !state.poolerUid ||
        pool.metadata.uid !== state.poolerUid ||
        pool.metadata.uid !== poolRef.uid ||
        deployment.metadata.name !== "database-pool-rw" ||
        object(object(pool.spec).cluster).name !== "database" ||
        labels["cnpg.io/poolerName"] !== "database-pool-rw" ||
        labels["cnpg.io/podRole"] !== "pooler" ||
        object(pool.spec).instances !== 1
      )
        throw fail();
      if (
        !binding &&
        request.operation === "CREATE" &&
        user !== ctx.config.admission.replicaSetUsername
      )
        throw fail();
      slot = state.slots.find((s) => s.plan.kind === "pooler");
      ownerLineage = [
        { kind: "ReplicaSet", name: rs.metadata.name, uid: rs.metadata.uid! },
        {
          kind: "Deployment",
          name: deployment.metadata.name,
          uid: deployment.metadata.uid!,
        },
        { kind: "Pooler", name: pool.metadata.name, uid: pool.metadata.uid! },
        { kind: "Cluster", name: "database", uid: state.clusterUid },
      ];
    } else throw fail();
    if (
      !slot ||
      !slot.reservation ||
      !slot.node ||
      labels["cnpg.io/cluster"] !== "database"
    )
      throw fail();
    if (
      ownerLineage[0]?.kind === "Job" &&
      slot.retirements.some(
        (r) => r.ownerKind === "Job" && r.ownerUid === ownerLineage[0]!.uid,
      )
    )
      throw fail();
    if (slot.plan.kind === "database") {
      if (slot.handoffPhase !== "rebound" || !slot.targetPvc || !slot.storage)
        throw fail();
      const pvc = await read("PersistentVolumeClaim", slot.targetPvc.name),
        pv = await read("PersistentVolume", slot.storage.pv.name, "");
      const volumes = items(object(pod.spec).volumes ?? []);
      if (
        volumes.some(
          (v) =>
            object(v).persistentVolumeClaim &&
            object(object(v).persistentVolumeClaim).claimName !==
              slot!.targetPvc!.name,
        )
      )
        throw fail();
      if (
        pvc.metadata.uid !== slot.targetPvc.uid ||
        object(pvc.status).phase !== "Bound" ||
        object(pvc.spec).volumeName !== pv.metadata.name ||
        pv.metadata.uid !== slot.storage.pv.uid ||
        object(object(pv.spec).claimRef).uid !== pvc.metadata.uid ||
        !volumes.some(
          (v) =>
            object(v).persistentVolumeClaim &&
            object(object(v).persistentVolumeClaim).claimName ===
              pvc.metadata.name,
        )
      )
        throw fail();
    }
    const reservation = await read("Reservation", slot.reservation.name, "");
    validateCapacityReservation(
      reservation,
      state.plan,
      slot.plan,
      ctx.claim,
      ctx.config,
    );
    const node = await read("Node", slot.node.name, "");
    if (
      reservation.metadata.uid !== slot.reservation.uid ||
      object(reservation.status).nodeName !== slot.node.name ||
      node.metadata.uid !== slot.node.uid ||
      object(object(node.status).nodeInfo).bootID !== slot.node.bootId ||
      object(reservation.spec).allocatePolicy !== "Restricted" ||
      object(reservation.spec).allocateOnce !== false ||
      object(reservation.spec).preAllocation === true ||
      object(reservation.spec).unschedulable === true
    )
      throw fail();
    const reservationStatus = object(reservation.status),
      nodeStatus = object(node.status);
    const ready = items(reservationStatus.conditions);
    if (
      reservationStatus.phase !== "Available" ||
      ["Ready", "Scheduled"].some(
        (type) =>
          ready.filter(
            (c) => object(c).type === type && object(c).status === "True",
          ).length !== 1,
      ) ||
      object(node.spec).unschedulable === true ||
      !["Ready", "MemoryPressure", "DiskPressure", "PIDPressure"].every(
        (type) =>
          items(nodeStatus.conditions).filter(
            (c) =>
              object(c).type === type &&
              object(c).status === (type === "Ready" ? "True" : "False"),
          ).length === 1,
      )
    )
      throw fail();
    const currentOwners = items(reservationStatus.currentOwners ?? []);
    if (
      currentOwners.some(
        (v) =>
          object(v).uid !== pod.metadata.uid ||
          object(v).name !== pod.metadata.name ||
          object(v).namespace !== ns,
      )
    )
      throw fail();
    podPolicy(pod, slot, ctx);
    const allocatable = resources(object(reservation.status).allocatable);
    if (
      allocatable[0] !== BigInt(slot.plan.cpuMilli) ||
      allocatable[1] !== BigInt(slot.plan.memoryBytes)
    )
      throw fail();
    if (!ctx.workloadVolumesPrepared(pod, state, slot)) throw fail();
    const quota = await read("ResourceQuota", "database-resources");
    const gate = state.podQuotaGate;
    if (
      !gate ||
      gate.phase !== "open" ||
      quota.metadata.uid !== gate.quota.uid ||
      canonicalCohort(quota.spec) !== canonicalCohort(gate.openSpec) ||
      canonicalCohort(object(quota.status).hard) !==
        canonicalCohort(object(gate.openSpec).hard) ||
      quantity(object(object(quota.spec).hard).pods, 1n) !==
        BigInt(state.plan.slots.length) ||
      quantity(object(object(quota.status).hard).pods, 1n) !==
        BigInt(state.plan.slots.length)
    )
      throw fail();
    if (!ctx.executionPrepared(pod, state, slot)) throw fail();
    const finalizer = "pgcf.io/capacity-" + state.plan.binding.operationId;
    const spec = object(pod.spec),
      attemptId = annotations[CAPACITY_ATTEMPT];
    if (request.operation === "CREATE" && !binding && lane === "mutate") {
      if (
        spec.nodeName ||
        [
          CAPACITY_OPERATION,
          CAPACITY_SLOT,
          CAPACITY_ATTEMPT,
          RESERVATION_AFFINITY,
          RESERVATION_ALLOCATED,
          RESERVATION_IGNORED,
        ].some((k) => annotations[k] !== undefined || labels[k] !== undefined)
      )
        throw fail();
      const name =
        pod.metadata.name ||
        String(object(pod.metadata).generateName ?? "") +
          uid.replaceAll("-", "").slice(0, 12);
      if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(name)) throw fail();
      check();
      ctx.journal.admitAttempt({
        id: uid,
        slotId: slot.plan.id,
        name,
        namespace: ns,
        podUid: null,
      });
      const affinity = spec.affinity === undefined ? {} : object(spec.affinity);
      const patch = [
        { op: "add", path: "/metadata/name", value: name },
        {
          op: "add",
          path: "/metadata/labels",
          value: {
            ...labels,
            [CAPACITY_OPERATION]: state.plan.binding.operationId,
            [CAPACITY_SLOT]: slot.plan.id,
            "pgcf.io/environment-id": state.plan.binding.environmentId,
          },
        },
        {
          op: "add",
          path: "/metadata/annotations",
          value: {
            ...annotations,
            [CAPACITY_ATTEMPT]: uid,
            [RESERVATION_AFFINITY]: JSON.stringify({
              name: slot.reservation.name,
            }),
          },
        },
        {
          op: "add",
          path: "/metadata/finalizers",
          value: [...new Set([...(pod.metadata.finalizers ?? []), finalizer])],
        },
        {
          op: "add",
          path: "/spec/schedulerName",
          value: ctx.config.schedulerName,
        },
        {
          op: "add",
          path: "/spec/affinity",
          value: { ...affinity, nodeAffinity: nodeAffinity(slot) },
        },
      ];
      check();
      return {
        uid,
        allowed: true,
        patchType: "JSONPatch",
        patch: Buffer.from(JSON.stringify(patch)).toString("base64"),
      };
    }
    if (
      !attemptId ||
      !uuid.test(attemptId) ||
      spec.schedulerName !== ctx.config.schedulerName ||
      annotations[RESERVATION_IGNORED] !== undefined ||
      labels[CAPACITY_OPERATION] !== state.plan.binding.operationId ||
      labels[CAPACITY_SLOT] !== slot.plan.id ||
      labels["pgcf.io/environment-id"] !== state.plan.binding.environmentId ||
      !pod.metadata.finalizers?.includes(finalizer) ||
      annotations[RESERVATION_AFFINITY] !==
        JSON.stringify({ name: slot.reservation.name }) ||
      !equal(object(spec.affinity).nodeAffinity, nodeAffinity(slot))
    )
      throw fail();
    const attempt = state.attempts.find((a) => a.id === attemptId);
    if (
      !attempt ||
      attempt.slotId !== slot.plan.id ||
      attempt.namespace !== ns ||
      attempt.name !== pod.metadata.name
    )
      throw fail();
    if (binding) {
      const allocated = object(
          JSON.parse(annotations[RESERVATION_ALLOCATED] ?? "null"),
        ),
        target = object(object(input).target);
      if (
        allocated.name !== slot.reservation.name ||
        allocated.uid !== slot.reservation.uid ||
        target.kind !== "Node" ||
        target.name !== slot.node.name ||
        (target.uid !== undefined && target.uid !== slot.node.uid) ||
        (spec.nodeName && spec.nodeName !== slot.node.name) ||
        !uuid.test(pod.metadata.uid ?? "")
      )
        throw fail();
      check();
      ctx.journal.observeComputeConsumer(
        slot.plan.id,
        {
          uid: pod.metadata.uid!,
          name: pod.metadata.name,
          namespace: ns,
          nodeUid: slot.node.uid,
          specHash: hash({ ...spec, nodeName: slot.node.name }),
          ownerChain: ownerLineage,
        },
        attemptId,
      );
    } else if (request.operation === "UPDATE") {
      if (user !== ctx.config.admission.schedulerUsername) throw fail();
      const old = resource(request.oldObject);
      if (
        old.metadata.uid !== pod.metadata.uid ||
        hash(old.spec) !== hash(pod.spec) ||
        old.metadata.annotations?.[CAPACITY_ATTEMPT] !== attemptId ||
        !equal(old.metadata.ownerReferences, pod.metadata.ownerReferences) ||
        !equal(old.metadata.labels, pod.metadata.labels) ||
        !equal(
          {
            ...old.metadata.annotations,
            [RESERVATION_ALLOCATED]: annotations[RESERVATION_ALLOCATED],
          },
          pod.metadata.annotations,
        ) ||
        (old.metadata.finalizers ?? []).some(
          (v) => !pod.metadata.finalizers?.includes(v),
        )
      )
        throw fail();
      const allocated = object(
        JSON.parse(annotations[RESERVATION_ALLOCATED] ?? "null"),
      );
      if (
        allocated.name !== slot.reservation.name ||
        allocated.uid !== slot.reservation.uid
      )
        throw fail();
    } else if (spec.nodeName) throw fail();
    check();
    return { uid, allowed: true };
  } catch {
    return {
      uid,
      allowed: false,
      status: { code: 403, message: "capacity_admission_unproven" },
    };
  }
}
