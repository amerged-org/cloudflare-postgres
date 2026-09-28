// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type {
  MaintenanceBlocker,
  MaintenanceClaim,
  MaintenanceContext,
  MaintenanceEvidence,
  MaintenanceJobs,
  MaintenancePreparationResult,
  MaintenanceSnapshot,
} from "./maintenance-types.ts";
import type { Resource } from "./types.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const version =
  /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/;
const image =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;
const name = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const freshMilliseconds = 60_000;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) >= 0 &&
  Number(value) <= 253402300739999;
const endpoint = (value: string) =>
  value.length <= 253 &&
  (isIP(value) !== 0 || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value));

export function validMaintenanceClaim(
  value: unknown,
): value is MaintenanceClaim {
  const claim = object(value),
    plan = object(claim.plan);
  if (
    typeof plan.fromVersion !== "string" ||
    !version.test(plan.fromVersion) ||
    typeof plan.toVersion !== "string" ||
    !version.test(plan.toVersion)
  )
    return false;
  const a = plan.fromVersion.split(".").map(Number),
    b = plan.toVersion.split(".").map(Number);
  return (
    typeof claim.operationId === "string" &&
    uuid.test(claim.operationId) &&
    typeof claim.regionId === "string" &&
    uuid.test(claim.regionId) &&
    typeof claim.planHash === "string" &&
    hash.test(claim.planHash) &&
    typeof claim.leaseToken === "string" &&
    /^cpmtl_[A-Za-z0-9_-]{43}$/.test(claim.leaseToken) &&
    Number.isSafeInteger(claim.leaseEpoch) &&
    Number(claim.leaseEpoch) >= 1 &&
    typeof claim.leaseExpiresAt === "string" &&
    Number.isFinite(Date.parse(claim.leaseExpiresAt)) &&
    plan.schemaVersion === 1 &&
    plan.kind === "kubernetes.upgrade" &&
    typeof plan.clusterUid === "string" &&
    uuid.test(plan.clusterUid) &&
    Array.isArray(plan.nodeUids) &&
    plan.nodeUids.length > 0 &&
    plan.nodeUids.length <= 100 &&
    plan.nodeUids.every((uid) => typeof uid === "string" && uuid.test(uid)) &&
    new Set(plan.nodeUids).size === plan.nodeUids.length &&
    plan.nodeUids.every(
      (uid, index, nodes) => index === 0 || nodes[index - 1]! < uid,
    ) &&
    a.every(Number.isSafeInteger) &&
    b.every(Number.isSafeInteger) &&
    a[0] === b[0] &&
    (b[1] === a[1]! + 1 || (b[1] === a[1] && b[2]! >= a[2]!)) &&
    typeof plan.talosVersion === "string" &&
    version.test(plan.talosVersion) &&
    typeof plan.toolImage === "string" &&
    plan.toolImage.length <= 512 &&
    image.test(plan.toolImage) &&
    typeof plan.targetArtifactsHash === "string" &&
    hash.test(plan.targetArtifactsHash) &&
    digest(claim.plan) === claim.planHash
  );
}

function fresh(
  evidence: MaintenanceEvidence | null,
  claim: MaintenanceClaim,
  now: number,
): boolean {
  return (
    evidence !== null &&
    evidence.status === "verified" &&
    evidence.planHash === claim.planHash &&
    hash.test(evidence.evidenceHash) &&
    time(evidence.observedAt) &&
    time(evidence.expiresAt) &&
    evidence.observedAt <= now &&
    now - evidence.observedAt <= freshMilliseconds &&
    evidence.expiresAt > now &&
    evidence.expiresAt > evidence.observedAt
  );
}

function assess(
  claim: MaintenanceClaim,
  snapshot: MaintenanceSnapshot,
  now: number,
): MaintenanceBlocker[] {
  const blockers = new Set<MaintenanceBlocker>();
  if (!snapshot.complete) blockers.add("inventory_incomplete");
  if (
    !time(snapshot.observedAt) ||
    snapshot.observedAt > now ||
    now - snapshot.observedAt > freshMilliseconds
  )
    blockers.add("evidence_stale");
  const uids = snapshot.nodes.map((node) => node.uid);
  if (
    snapshot.regionId !== claim.regionId ||
    snapshot.clusterUid !== claim.plan.clusterUid ||
    !claim.plan.nodeUids.includes(snapshot.targetNodeUid) ||
    uids.length !== claim.plan.nodeUids.length ||
    new Set(uids).size !== uids.length ||
    !uids.every((uid) => claim.plan.nodeUids.includes(uid)) ||
    snapshot.nodes.some(
      (node) =>
        !node.ready ||
        node.kubernetesVersion.replace(/^v/, "") !== claim.plan.fromVersion,
    ) ||
    !fresh(snapshot.machineIdentity, claim, now)
  )
    blockers.add("identity_changed");
  const voters = snapshot.etcd?.voters ?? [];
  const quorum = Math.floor(voters.length / 2) + 1;
  if (
    !snapshot.etcd ||
    !time(snapshot.etcd.observedAt) ||
    !time(snapshot.etcd.expiresAt) ||
    snapshot.etcd.observedAt > now ||
    now - snapshot.etcd.observedAt > freshMilliseconds ||
    snapshot.etcd.expiresAt <= now ||
    !hash.test(snapshot.etcd.evidenceHash) ||
    voters.length < 3 ||
    new Set(voters.map((voter) => voter.memberId)).size !== voters.length ||
    new Set(voters.map((voter) => voter.nodeUid)).size !== voters.length ||
    voters.some(
      (voter) =>
        !voter.memberId ||
        voter.memberId.length > 128 ||
        !uids.includes(voter.nodeUid),
    )
  )
    blockers.add("quorum_unproven");
  const capacity = snapshot.capacity;
  if (
    !fresh(capacity, claim, now) ||
    !capacity ||
    object(capacity).scope !== "sequential-plan" ||
    !uuid.test(capacity.reservationId) ||
    capacity.nodeUids.length === 0 ||
    new Set(capacity.nodeUids).size !== capacity.nodeUids.length ||
    !capacity.nodeUids.every((uid) => uids.includes(uid))
  )
    blockers.add("capacity_unreserved");
  // upgrade-k8s affects the whole immutable plan. Prove each sequential removal,
  // rather than authorizing the full plan from its first connection target.
  for (const target of claim.plan.nodeUids) {
    if (
      voters.filter((voter) => voter.healthy && voter.nodeUid !== target)
        .length < quorum
    )
      blockers.add("quorum_unproven");
    if (capacity && !capacity.nodeUids.some((uid) => uid !== target))
      blockers.add("capacity_unreserved");
    for (const database of snapshot.databases) {
      const ready = database.readyInstanceNodeUids;
      if (
        !uuid.test(database.uid) ||
        !uids.includes(database.primaryNodeUid) ||
        !ready.includes(database.primaryNodeUid) ||
        new Set(ready).size !== ready.length ||
        !ready.every((uid) => uids.includes(uid)) ||
        ready.filter((uid) => uid !== target).length < 1 ||
        (database.primaryNodeUid === target && !database.switchoverVerified) ||
        !database.pdbAllowsDisruption ||
        !database.volumeBindingsStable
      )
        blockers.add("database_availability_unproven");
    }
  }
  if (!fresh(snapshot.recovery, claim, now)) blockers.add("recovery_unproven");
  if (!fresh(snapshot.staging, claim, now)) blockers.add("staging_unqualified");
  for (const evidence of [
    snapshot.machineIdentity,
    snapshot.recovery,
    snapshot.staging,
    capacity,
  ])
    if (evidence?.status === "verified" && !fresh(evidence, claim, now))
      blockers.add("evidence_stale");
  return [...blockers].sort();
}

function desiredJob(
  claim: MaintenanceClaim,
  context: MaintenanceContext,
): Resource {
  const labels = {
    "app.kubernetes.io/managed-by": "cloudflare-postgres",
    "pgcf.io/region-id": claim.regionId,
    "pgcf.io/maintenance-id": claim.operationId,
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `pgcf-maintenance-${claim.operationId.replaceAll("-", "")}`,
      namespace: context.namespace,
      labels,
      annotations: { "pgcf.io/maintenance-plan-hash": claim.planHash },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 300,
      parallelism: 1,
      completions: 1,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: "pgcf-maintenance-preparer",
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "talos-preparation",
              image: claim.plan.toolImage,
              imagePullPolicy: "IfNotPresent",
              command: ["/talosctl"],
              args: [
                "upgrade-k8s",
                "--from",
                claim.plan.fromVersion,
                "--to",
                claim.plan.toVersion,
                "--dry-run",
                "--pre-pull-images=false",
                "--talosconfig",
                "/var/run/pgcf-talos/talosconfig",
                "--endpoints",
                context.endpoints.join(","),
                "--nodes",
                context.endpoints[0]!,
                "--with-docs=false",
                "--with-examples=false",
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: { cpu: "10m", memory: "32Mi" },
                limits: { cpu: "200m", memory: "128Mi" },
              },
              volumeMounts: [
                {
                  name: "talos-config",
                  mountPath: "/var/run/pgcf-talos",
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: "talos-config",
              secret: {
                secretName: context.talosconfigSecret,
                optional: false,
                defaultMode: 0o440,
                items: [{ key: "talosconfig", path: "talosconfig" }],
              },
            },
          ],
        },
      },
    },
  };
}

function fields(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([key, value]) =>
    equal(actual[key], value),
  );
}
function ownedJob(actual: Resource, expected: Resource): boolean {
  const spec = object(actual.spec),
    wanted = object(expected.spec);
  const pod = object(object(spec.template).spec),
    wantedPod = object(object(wanted.template).spec);
  const containers = Array.isArray(pod.containers) ? pod.containers : [];
  const expectedContainers = wantedPod.containers as Record<string, unknown>[];
  return (
    actual.apiVersion === "batch/v1" &&
    actual.kind === "Job" &&
    actual.metadata.name === expected.metadata.name &&
    actual.metadata.namespace === expected.metadata.namespace &&
    typeof actual.metadata.uid === "string" &&
    actual.metadata.uid.length > 0 &&
    !actual.metadata.deletionTimestamp &&
    fields(object(actual.metadata.labels), object(expected.metadata.labels)) &&
    fields(
      object(actual.metadata.annotations),
      object(expected.metadata.annotations),
    ) &&
    spec.backoffLimit === 0 &&
    spec.activeDeadlineSeconds === 300 &&
    spec.parallelism === 1 &&
    spec.completions === 1 &&
    (spec.completionMode === undefined ||
      spec.completionMode === "NonIndexed") &&
    spec.ttlSecondsAfterFinished === undefined &&
    spec.suspend !== true &&
    pod.restartPolicy === "Never" &&
    pod.automountServiceAccountToken === false &&
    pod.serviceAccountName === wantedPod.serviceAccountName &&
    pod.hostNetwork !== true &&
    pod.hostPID !== true &&
    pod.hostIPC !== true &&
    (!Array.isArray(pod.initContainers) || pod.initContainers.length === 0) &&
    (!Array.isArray(pod.ephemeralContainers) ||
      pod.ephemeralContainers.length === 0) &&
    fields(object(pod.securityContext), object(wantedPod.securityContext)) &&
    equal(pod.volumes, wantedPod.volumes) &&
    containers.length === 1 &&
    fields(object(containers[0]), expectedContainers[0]!) &&
    object(containers[0]).env === undefined &&
    object(containers[0]).envFrom === undefined
  );
}

export async function prepareMaintenance(
  claim: MaintenanceClaim,
  snapshot: MaintenanceSnapshot,
  context: MaintenanceContext,
  jobs: MaintenanceJobs,
): Promise<MaintenancePreparationResult> {
  const now = context.now();
  if (
    !time(now) ||
    !validMaintenanceClaim(claim) ||
    !name.test(context.namespace) ||
    !name.test(context.talosconfigSecret) ||
    !Array.isArray(context.endpoints) ||
    context.endpoints.length === 0 ||
    context.endpoints.length > 16 ||
    !context.endpoints.every(
      (value) => typeof value === "string" && endpoint(value),
    ) ||
    new Set(context.endpoints).size !== context.endpoints.length ||
    !snapshot ||
    !Array.isArray(snapshot.nodes) ||
    !Array.isArray(snapshot.databases)
  )
    throw new Error("maintenance_configuration_invalid");
  const blockers = assess(claim, snapshot, now);
  const dryRun: MaintenancePreparationResult["assessment"]["dryRun"] = {
    status: "not_run",
    jobUid: null,
  };
  let status: MaintenancePreparationResult["status"] = blockers.length
    ? "blocked"
    : "pending";
  if (blockers.length === 0) {
    if (
      Date.parse(claim.leaseExpiresAt) <= now + 5_000 ||
      !(await context.leaseValid())
    )
      throw new Error("maintenance_lease_not_authorized");
    const expected = desiredJob(claim, context);
    let job = await jobs.readJob(expected.metadata.name);
    if (job === null) {
      if (!(await context.leaseValid()))
        throw new Error("maintenance_lease_not_authorized");
      try {
        job = await jobs.createJob(expected);
      } catch {
        job = await jobs.readJob(expected.metadata.name);
        if (job === null) throw new Error("maintenance_job_outcome_unresolved");
      }
    }
    if (!ownedJob(job, expected)) {
      blockers.push("identity_changed");
      status = "blocked";
    } else {
      dryRun.jobUid = job.metadata.uid!;
      const conditions = job.status?.conditions ?? [];
      if (
        conditions.some(
          (condition) =>
            condition.type === "Failed" && condition.status === "True",
        )
      ) {
        dryRun.status = "failed";
        blockers.push("dry_run_failed");
        status = "blocked";
      } else if (
        conditions.some(
          (condition) =>
            condition.type === "Complete" && condition.status === "True",
        )
      ) {
        dryRun.status = "succeeded";
        status = "eligible";
      }
    }
  }
  const positiveExpiry = Math.min(
    now + freshMilliseconds,
    snapshot.observedAt + freshMilliseconds,
    ...[
      snapshot.machineIdentity,
      snapshot.recovery,
      snapshot.staging,
      snapshot.capacity,
    ]
      .filter((entry): entry is MaintenanceEvidence => entry !== null)
      .map((entry) => entry.expiresAt),
    snapshot.etcd?.expiresAt ?? now + freshMilliseconds,
  );
  const expiresAt =
    status === "blocked" ? now + freshMilliseconds : positiveExpiry;
  return {
    status,
    assessment: {
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      blockers: [...blockers].sort(),
      dryRun,
      evidenceHash: digest({
        method: "kubernetes-maintenance-preparation/v1",
        planHash: claim.planHash,
        snapshot,
        blockers: [...blockers].sort(),
        dryRun,
        observedAt: now,
        expiresAt,
      }),
    },
  };
}
