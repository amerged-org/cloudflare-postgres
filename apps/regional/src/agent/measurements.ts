// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentActivityRequest,
  AgentUsageRequest,
  AgentDatabaseActivity,
  gatewayActivityBoundary,
  GATEWAY_ACTIVITY_FRESH_MS,
  GATEWAY_ACTIVITY_FUTURE_MS,
  type DesiredDatabase,
} from "@pgcf/contracts";
import {
  UsageSample,
  USAGE_HOUR_MS,
  type UsageSample as Sample,
} from "@pgcf/contracts/usage";
import {
  GATEWAY_ACTIVITY_HEADER,
  GATEWAY_ACTIVITY_PATH,
  gatewayActivityReportSchema,
  signGatewayActivity,
  type GatewayActivityReport,
} from "@pgcf/contracts/gateway-activity";
import {
  gatewayFenceName,
  gatewayIntentSchema,
  GATEWAY_FENCE_LABEL,
  gatewayPodUidSchema,
} from "@pgcf/contracts/gateway-control";
import type { PowerCoordinator, GatewayPod } from "./power.ts";
import { appliedGeneration, DATABASE_LABEL, quantity } from "./observe.ts";
import {
  record,
  string,
  uid,
  type Kubernetes,
  type Resource,
} from "./types.ts";
import { boundedText } from "./api-client.ts";
import type { VolumeStatsKubernetes } from "./kubernetes.ts";

const DATA = "measurements.json",
  CURSOR = "pgcf.io/measurement-cursor";
export const MEASUREMENT_COHORT = 25,
  MEASUREMENT_BODY_BYTES = 64 * 1024;
export const MEASUREMENT_INTERVAL_MS = 15_000;
const CHECKPOINT_BYTES = 48 * 1024,
  MAX_OUTBOX = 64;
type Snapshot = Awaited<ReturnType<PowerCoordinator["gatewaySnapshot"]>>;
export interface MeasurementApi {
  activity(value: AgentActivityRequest, signal: AbortSignal): Promise<void>;
  usage(value: AgentUsageRequest, signal: AbortSignal): Promise<void>;
}
interface Identity {
  storage: string;
  namespace: string;
  cluster: string;
  fence: string;
  state: string;
}
interface Baseline {
  sampledAt?: string;
  inventory: GatewayPod[];
  keyUid: string;
  keyVersion: string;
  reports: GatewayActivityReport[];
}
interface Checkpoint {
  version: 1;
  identity: Identity;
  baseline?: Baseline;
  gapSince?: string;
  idleObservedSince?: string;
  outbox: Sample[];
}
type Subject = Pick<
  DesiredDatabase,
  "id" | "generation" | "node" | "desired_state" | "storage"
> & { archive: Pick<DesiredDatabase["archive"], "destination_path"> };
interface Work {
  db: Subject;
  resource: Resource;
  checkpoint: Checkpoint;
  allocated: number | null;
  namespace: Resource;
  cluster: Resource;
  volumeIdentity: string | undefined;
}

interface VolumeStatsBinding {
  node: string;
  namespace: string;
  pod: string;
  podUid: string;
  volume: string;
  claim: string;
  allocated: number;
}

export function volumeUsedBytes(
  summary: unknown,
  binding: VolumeStatsBinding,
  now: number,
): number | null {
  const value = record(summary),
    pods = value.pods;
  if (
    !Number.isSafeInteger(now) ||
    record(value.node).nodeName !== binding.node ||
    !Array.isArray(pods) ||
    pods.length > 10_000
  )
    return null;
  const selected = pods
    .map(record)
    .filter(
      (pod) =>
        record(pod.podRef).name === binding.pod &&
        record(pod.podRef).namespace === binding.namespace,
    );
  if (
    selected.length !== 1 ||
    record(selected[0]!.podRef).uid !== binding.podUid
  )
    return null;
  const volumes = selected[0]!.volume;
  if (!Array.isArray(volumes) || volumes.length > 64) return null;
  const matched = volumes
    .map(record)
    .filter((volume) => volume.name === binding.volume);
  if (matched.length !== 1) return null;
  const volume = matched[0]!,
    timestamp = typeof volume.time === "string" ? Date.parse(volume.time) : NaN;
  if (
    record(volume.pvcRef).name !== binding.claim ||
    record(volume.pvcRef).namespace !== binding.namespace ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < now - 120_000 ||
    timestamp > now + 5000 ||
    !Number.isSafeInteger(volume.usedBytes) ||
    Number(volume.usedBytes) < 0 ||
    !Number.isSafeInteger(volume.capacityBytes) ||
    Number(volume.capacityBytes) <= 0 ||
    Number(volume.usedBytes) > Number(volume.capacityBytes) ||
    Number(volume.capacityBytes) > binding.allocated
  )
    return null;
  return Number(volume.usedBytes);
}

const physicalSignature = (resource: Resource) =>
  text({ metadata: resource.metadata, spec: resource.spec });
function clusterOwner(resource: Resource, cluster: Resource): boolean {
  const owners = record(resource.metadata).ownerReferences;
  const matches = Array.isArray(owners)
    ? owners.map(record).filter((owner) => owner.kind === cluster.kind)
    : [];
  return (
    matches.length === 1 &&
    matches[0]!.apiVersion === cluster.apiVersion &&
    matches[0]!.name === cluster.metadata.name &&
    matches[0]!.uid === uid(cluster)
  );
}

async function storageUsed(
  k8s: VolumeStatsKubernetes,
  work: Work,
  summaries: Map<string, Promise<unknown>>,
  now: () => number,
): Promise<number | null> {
  if (!k8s.statsSummary || work.allocated === null || !work.volumeIdentity)
    return null;
  try {
    const identity = record(JSON.parse(work.volumeIdentity));
    const primary = string(record(work.cluster.status).currentPrimary);
    const namespace = work.namespace.metadata.name;
    if (
      !primary ||
      primary.length > 63 ||
      !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(primary)
    )
      return null;
    const [pod, claim, node] = await Promise.all([
      k8s.read("Pod", namespace, primary),
      k8s.read("PersistentVolumeClaim", namespace, primary),
      k8s.read("Node", undefined, work.db.node),
    ]);
    if (
      !pod ||
      !claim ||
      !node ||
      pod.metadata.deletionTimestamp ||
      claim.metadata.deletionTimestamp ||
      node.metadata.deletionTimestamp ||
      pod.metadata.name !== primary ||
      pod.metadata.namespace !== namespace ||
      pod.metadata.labels?.["cnpg.io/cluster"] !== work.cluster.metadata.name ||
      !clusterOwner(pod, work.cluster) ||
      record(pod.spec).nodeName !== work.db.node ||
      node.metadata.name !== work.db.node ||
      claim.metadata.namespace !== namespace ||
      claim.metadata.name !== primary ||
      claim.metadata.uid !== identity.claimUid ||
      !clusterOwner(claim, work.cluster) ||
      record(claim.status).phase !== "Bound" ||
      record(claim.spec).storageClassName !== "pgcf-lvm"
    )
      return null;
    const volumeName = string(record(claim.spec).volumeName);
    if (
      !volumeName ||
      volumeName.length > 253 ||
      !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(volumeName)
    )
      return null;
    const volume = await k8s.read("PersistentVolume", undefined, volumeName);
    const reference = record(record(volume?.spec).claimRef),
      csi = record(record(volume?.spec).csi);
    if (
      !volume ||
      volume.metadata.name !== volumeName ||
      volume.metadata.uid !== identity.volumeUid ||
      volume.metadata.deletionTimestamp ||
      reference.uid !== uid(claim) ||
      reference.namespace !== namespace ||
      reference.name !== primary ||
      csi.driver !== "local.csi.openebs.io" ||
      csi.volumeHandle !== identity.handle ||
      record(volume.status).phase !== "Bound"
    )
      return null;
    const mounts = record(pod.spec).volumes;
    const mounted = Array.isArray(mounts)
      ? mounts
          .map(record)
          .filter(
            (mount) =>
              record(mount.persistentVolumeClaim).claimName === primary,
          )
      : [];
    if (mounted.length !== 1 || !string(mounted[0]!.name)) return null;
    const before = [pod, claim, volume, node].map(physicalSignature);
    const key = `${uid(node)}_${node.metadata.resourceVersion}`;
    let summary = summaries.get(key);
    if (!summary) {
      summary = k8s.statsSummary(node);
      summaries.set(key, summary);
    }
    const used = volumeUsedBytes(
      await summary,
      {
        node: work.db.node,
        namespace,
        pod: primary,
        podUid: uid(pod),
        volume: String(mounted[0]!.name),
        claim: primary,
        allocated: work.allocated,
      },
      now(),
    );
    if (used === null) return null;
    const current = await Promise.all([
      k8s.read("Pod", namespace, primary),
      k8s.read("PersistentVolumeClaim", namespace, primary),
      k8s.read("PersistentVolume", undefined, volumeName),
      k8s.read("Node", undefined, work.db.node),
      k8s.read("Namespace", undefined, namespace),
      k8s.read("Cluster", namespace, work.cluster.metadata.name),
      k8s.read("ConfigMap", "pgcf-system", work.resource.metadata.name),
    ]);
    if (
      current
        .slice(0, 4)
        .some(
          (resource, index) =>
            !resource ||
            resource.metadata.deletionTimestamp ||
            physicalSignature(resource) !== before[index],
        ) ||
      current[4]?.metadata.uid !== uid(work.namespace) ||
      current[4]?.metadata.deletionTimestamp ||
      current[4]?.metadata.labels?.[DATABASE_LABEL] !== work.db.id ||
      current[5]?.metadata.uid !== uid(work.cluster) ||
      current[5]?.metadata.deletionTimestamp ||
      record(current[5]?.status).currentPrimary !== primary ||
      current[6]?.metadata.uid !== uid(work.resource) ||
      current[6]?.metadata.deletionTimestamp ||
      record(current[6]?.data).state !== work.checkpoint.identity.state ||
      current[6]?.metadata.annotations?.["pgcf.io/volume-identity"] !==
        work.volumeIdentity
    )
      return null;
    return used;
  } catch {
    return null;
  }
}
export interface MeasurementOptions {
  k8s: Kubernetes | ((signal: AbortSignal) => Kubernetes);
  signal: AbortSignal;
  region: string;
  snapshot(signal: AbortSignal): Promise<Snapshot>;
  api: MeasurementApi;
  fetcher?: typeof fetch;
  now?: () => number;
  cohort?: number;
  periodMs?: number;
}
const text = (value: unknown) => JSON.stringify(value);
const signature = (snapshot: Snapshot) =>
  text({
    pods: snapshot.pods,
    keyUid: snapshot.keyUid,
    keyVersion: snapshot.keyVersion,
  });
const producer = (report: GatewayActivityReport) =>
  `gw_${report.pod}_${report.processEpoch}_${report.epoch}`;
const validTime = (value: unknown) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
function history(report: GatewayActivityReport): boolean {
  return (
    report.countersSince !== null &&
    (report.history === "current_process_absence" ||
      (report.history === "complete" && report.lastActivityAt !== null))
  );
}
function sameEpoch(
  a: GatewayActivityReport,
  b: GatewayActivityReport,
): boolean {
  return (
    a.pod === b.pod &&
    a.processEpoch === b.processEpoch &&
    a.epoch === b.epoch &&
    a.startedAt === b.startedAt &&
    a.counterStartedAt === b.counterStartedAt &&
    a.countersSince === b.countersSince
  );
}
export function measurementBatches<T>(
  field: "samples" | "databases",
  values: readonly T[],
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  for (const value of values) {
    if (
      current.length === 25 ||
      Buffer.byteLength(text({ [field]: [...current, value] })) >
        MEASUREMENT_BODY_BYTES
    ) {
      if (!current.length) throw new Error("measurement_record_too_large");
      batches.push(current);
      current = [];
    }
    if (Buffer.byteLength(text({ [field]: [value] })) > MEASUREMENT_BODY_BYTES)
      throw new Error("measurement_record_too_large");
    current.push(value);
  }
  if (current.length) batches.push(current);
  return batches;
}
function readCheckpoint(resource: Resource, identity: Identity): Checkpoint {
  const raw = record(resource.data)[DATA];
  if (raw === undefined) return { version: 1, identity, outbox: [] };
  if (typeof raw !== "string" || Buffer.byteLength(raw) > CHECKPOINT_BYTES)
    throw new Error("measurement_checkpoint_invalid");
  const value = record(JSON.parse(raw));
  if (
    value.version !== 1 ||
    text(value.identity) !== text(identity) ||
    !Array.isArray(value.outbox) ||
    value.outbox.length > MAX_OUTBOX ||
    (value.gapSince !== undefined && !validTime(value.gapSince)) ||
    (value.idleObservedSince !== undefined &&
      !validTime(value.idleObservedSince))
  )
    throw new Error("measurement_checkpoint_invalid");
  const outbox = value.outbox.map((sample) => UsageSample.parse(sample));
  let baseline: Baseline | undefined;
  if (value.baseline !== undefined) {
    const rawBase = record(value.baseline);
    if (
      !Array.isArray(rawBase.reports) ||
      rawBase.reports.length < 1 ||
      rawBase.reports.length > 16 ||
      !Array.isArray(rawBase.inventory) ||
      rawBase.inventory.length !== rawBase.reports.length ||
      typeof rawBase.keyUid !== "string" ||
      typeof rawBase.keyVersion !== "string" ||
      (rawBase.sampledAt !== undefined && !validTime(rawBase.sampledAt))
    )
      throw new Error("measurement_checkpoint_invalid");
    const reports = rawBase.reports.map((report) =>
      gatewayActivityReportSchema.parse(report),
    );
    const inventory = rawBase.inventory.map((value) => {
      const pod = record(value);
      if (
        !gatewayPodUidSchema.safeParse(pod.uid).success ||
        typeof pod.name !== "string" ||
        !pod.name.length ||
        pod.name.length > 253 ||
        typeof pod.ip !== "string" ||
        !isIP(pod.ip) ||
        !Number.isSafeInteger(pod.restarts) ||
        Number(pod.restarts) < 0
      )
        throw new Error("measurement_checkpoint_invalid");
      return {
        name: pod.name,
        uid: pod.uid as string,
        ip: pod.ip,
        restarts: pod.restarts as number,
      };
    });
    if (
      new Set(inventory.map((pod) => pod.uid)).size !== inventory.length ||
      new Set(reports.map((report) => report.pod)).size !== reports.length ||
      reports.some((report) => !inventory.some((pod) => pod.uid === report.pod))
    )
      throw new Error("measurement_checkpoint_invalid");
    baseline = {
      ...(rawBase.sampledAt === undefined
        ? {}
        : { sampledAt: rawBase.sampledAt as string }),
      inventory,
      keyUid: rawBase.keyUid,
      keyVersion: rawBase.keyVersion,
      reports,
    };
  }
  if (
    value.idleObservedSince !== undefined &&
    (!baseline?.sampledAt ||
      (value.idleObservedSince as string) > baseline.sampledAt ||
      (value.gapSince !== undefined &&
        (value.idleObservedSince as string) < (value.gapSince as string)))
  )
    throw new Error("measurement_checkpoint_invalid");
  return {
    version: 1,
    identity,
    outbox,
    ...(value.idleObservedSince === undefined
      ? {}
      : { idleObservedSince: value.idleObservedSince as string }),
    ...(baseline ? { baseline } : {}),
    ...(value.gapSince === undefined
      ? {}
      : { gapSince: value.gapSince as string }),
  };
}
function differences(
  previous: GatewayActivityReport,
  current: GatewayActivityReport,
  expected: string[],
  continuous: boolean,
): Sample[] {
  const start = Date.parse(previous.observedAt),
    end = Date.parse(current.observedAt);
  if (end <= start) return [];
  const fields = [
    "ingressBytes",
    "egressBytes",
    "totalConnections",
    "connectionMilliseconds",
  ] as const;
  const known =
    continuous &&
    sameEpoch(previous, current) &&
    history(previous) &&
    history(current) &&
    fields.every(
      (field) =>
        previous[field] !== null &&
        current[field] !== null &&
        current[field]! >= previous[field]!,
    );
  const sameHour =
    Math.floor(start / USAGE_HOUR_MS) === Math.floor((end - 1) / USAGE_HOUR_MS);
  const intervals: { start: number; end: number }[] = [];
  if (sameHour) intervals.push({ start, end });
  else {
    // Only null coverage fragments are split; traffic is never distributed across an unknown hour boundary.
    const firstEnd = (Math.floor(start / USAGE_HOUR_MS) + 1) * USAGE_HOUR_MS;
    intervals.push({ start, end: firstEnd });
    const lastStart = Math.floor((end - 1) / USAGE_HOUR_MS) * USAGE_HOUR_MS;
    if (lastStart >= firstEnd) intervals.push({ start: lastStart, end });
  }
  return intervals.map((interval) =>
    UsageSample.parse({
      database_id: current.database,
      source: "gateway",
      producer_id: producer(current),
      sequence: interval.end,
      observed_at: current.observedAt,
      interval_start: new Date(interval.start).toISOString(),
      interval_end: new Date(interval.end).toISOString(),
      expected_producers: expected,
      ingress_bytes:
        known && sameHour
          ? current.ingressBytes! - previous.ingressBytes!
          : null,
      egress_bytes:
        known && sameHour ? current.egressBytes! - previous.egressBytes! : null,
      connections:
        known && sameHour
          ? current.totalConnections! - previous.totalConnections!
          : null,
      connection_seconds:
        known && sameHour
          ? (current.connectionMilliseconds! -
              previous.connectionMilliseconds!) /
            1000
          : null,
    }),
  );
}

export class RegionalMeasurements {
  private readonly options: MeasurementOptions;
  private targets: Subject[] = [];
  private cursor = "";
  private cursorLoaded = false;
  private sampling = new Map<
    string,
    { revision: number; observed: number; pending: boolean }
  >();
  private active: Promise<void> | undefined;
  private readonly process = `agent_${randomUUID()}`;
  constructor(options: MeasurementOptions) {
    const cohort = options.cohort ?? MEASUREMENT_COHORT,
      period = options.periodMs ?? 250;
    if (
      !Number.isInteger(cohort) ||
      cohort < 1 ||
      cohort > 25 ||
      !Number.isInteger(period) ||
      period < 1 ||
      period > 10000
    )
      throw new Error("measurement_schedule_invalid");
    this.options = options;
  }
  update(databases: readonly DesiredDatabase[]): void {
    if (
      databases.length > 10000 ||
      new Set(databases.map((db) => db.id)).size !== databases.length
    )
      throw new Error("measurement_subjects_invalid");
    for (const [id, sample] of this.sampling)
      if (
        !databases.some(
          (db) =>
            db.id === id &&
            db.generation === sample.revision &&
            db.desired_state !== "deleted",
        )
      )
        this.sampling.delete(id);
    this.targets = databases
      .filter((db) => db.desired_state !== "deleted")
      .map((db) => ({
        id: db.id,
        generation: db.generation,
        node: db.node,
        desired_state: db.desired_state,
        ...(db.storage ? { storage: db.storage } : {}),
        archive: { destination_path: db.archive.destination_path },
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  private get now(): number {
    const value = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("measurement_clock_invalid");
    return value;
  }
  async cycle(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.collect();
    try {
      await this.active;
    } finally {
      this.active = undefined;
    }
  }
  private cooled(db: Subject): boolean {
    const sample = this.sampling.get(db.id);
    return (
      !!sample &&
      sample.revision === db.generation &&
      this.now - sample.observed < MEASUREMENT_INTERVAL_MS
    );
  }
  private remember(work: Work): void {
    // Only persisted reports set the cooldown; an unacknowledged checkpoint cannot suppress a fresh measurement.
    const checkpoint = readCheckpoint(work.resource, work.checkpoint.identity);
    const reports = checkpoint.baseline?.reports;
    if (
      !reports?.length ||
      reports.some((report) => report.revision !== work.db.generation)
    ) {
      this.sampling.delete(work.db.id);
      return;
    }
    this.sampling.set(work.db.id, {
      revision: work.db.generation,
      observed: Math.max(
        ...reports.map((report) => Date.parse(report.observedAt)),
        Date.parse(checkpoint.baseline?.sampledAt ?? reports[0]!.observedAt),
      ),
      pending: checkpoint.outbox.length > 0,
    });
  }
  private async owner(k8s: Kubernetes, db: Subject): Promise<Work> {
    const [resource, namespace, cluster, fence] = await Promise.all([
      k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`),
      k8s.read("Namespace", undefined, `pgcf-db-${db.id}`),
      k8s.read("Cluster", `pgcf-db-${db.id}`, "database"),
      k8s.read("ConfigMap", "pgcf-system", gatewayFenceName(db.id)),
    ]);
    const state = record(JSON.parse(String(record(resource?.data).state)));
    if (
      !resource ||
      resource.metadata.namespace !== "pgcf-system" ||
      resource.metadata.name !== `storage-${db.id}` ||
      resource.metadata.labels?.[DATABASE_LABEL] !== db.id ||
      resource.metadata.deletionTimestamp ||
      !resource.metadata.resourceVersion ||
      !namespace ||
      !cluster ||
      namespace.metadata.name !== `pgcf-db-${db.id}` ||
      namespace.metadata.labels?.[DATABASE_LABEL] !== db.id ||
      cluster.metadata.name !== "database" ||
      cluster.metadata.namespace !== namespace.metadata.name ||
      cluster.metadata.labels?.[DATABASE_LABEL] !== db.id ||
      namespace.metadata.uid !== state.namespaceUid ||
      cluster.metadata.uid !== state.clusterUid ||
      namespace.metadata.deletionTimestamp ||
      cluster.metadata.deletionTimestamp ||
      state.node !== db.node ||
      state.archivePath !== db.archive.destination_path ||
      appliedGeneration(resource) > db.generation ||
      !fence ||
      fence.metadata.namespace !== "pgcf-system" ||
      fence.metadata.name !== gatewayFenceName(db.id) ||
      fence.metadata.labels?.[DATABASE_LABEL] !== db.id ||
      fence.metadata.labels?.[GATEWAY_FENCE_LABEL] !== "true" ||
      fence.metadata.deletionTimestamp
    )
      throw new Error("measurement_storage_identity_invalid");
    const intent = gatewayIntentSchema.parse(
      JSON.parse(String(record(fence.data)["intent.json"])),
    );
    if (
      intent.database !== db.id ||
      !["running", "quiesce"].includes(intent.mode) ||
      intent.revision !== db.generation ||
      (resource.metadata.annotations?.["pgcf.io/gateway-fence-uid"] &&
        resource.metadata.annotations["pgcf.io/gateway-fence-uid"] !==
          fence.metadata.uid)
    )
      throw new Error("measurement_fence_invalid");
    const identity = {
      storage: uid(resource),
      namespace: uid(namespace),
      cluster: uid(cluster),
      fence: uid(fence),
      state: String(record(resource.data).state),
    };
    const checkpoint = readCheckpoint(resource, identity);
    if (
      checkpoint.outbox.some((sample) => sample.database_id !== db.id) ||
      checkpoint.baseline?.reports.some(
        (report) =>
          report.database !== db.id || report.region !== this.options.region,
      )
    )
      throw new Error("measurement_checkpoint_subject_invalid");
    let allocated: number | null = null;
    try {
      const volumeIdentity = record(
        JSON.parse(
          resource.metadata.annotations?.["pgcf.io/volume-identity"] ?? "",
        ),
      );
      const primary = string(record(cluster.status).currentPrimary);
      const claims = primary
        ? [
            await k8s.read(
              "PersistentVolumeClaim",
              namespace.metadata.name,
              primary,
            ),
          ]
        : await k8s.list(
            "PersistentVolumeClaim",
            namespace.metadata.name,
            "cnpg.io/cluster=database",
          );
      const matches = claims.filter(
        (claim) => claim?.metadata.uid === volumeIdentity.claimUid,
      );
      const claim = matches.length === 1 ? matches[0] : undefined;
      const owners = record(claim?.metadata).ownerReferences;
      if (
        !db.storage &&
        claim &&
        claim.metadata.namespace === namespace.metadata.name &&
        (!primary || claim.metadata.name === primary) &&
        claim.metadata.labels?.["cnpg.io/cluster"] === cluster.metadata.name &&
        Array.isArray(owners) &&
        owners.some(
          (owner) =>
            record(owner).uid === cluster.metadata.uid &&
            record(owner).kind === cluster.kind &&
            record(owner).name === cluster.metadata.name &&
            record(owner).apiVersion === cluster.apiVersion,
        ) &&
        !claim.metadata.deletionTimestamp &&
        record(claim.status).phase === "Bound" &&
        record(claim.spec).storageClassName === "pgcf-lvm"
      ) {
        const value = quantity(record(record(claim.status).capacity).storage);
        if (Number.isSafeInteger(value) && value >= 0) allocated = value;
      }
    } catch {
      /* Allocation remains unknown when its bound claim cannot be established. */
    }
    return {
      db,
      resource,
      checkpoint,
      allocated,
      namespace,
      cluster,
      volumeIdentity:
        resource.metadata.annotations?.["pgcf.io/volume-identity"],
    };
  }
  private async save(k8s: Kubernetes, work: Work): Promise<void> {
    const encoded = text(work.checkpoint);
    if (Buffer.byteLength(encoded) > CHECKPOINT_BYTES)
      throw new Error("measurement_checkpoint_overflow");
    await k8s.patch("ConfigMap", "pgcf-system", work.resource.metadata.name, [
      { op: "test", path: "/metadata/uid", value: uid(work.resource) },
      {
        op: "test",
        path: "/metadata/resourceVersion",
        value: work.resource.metadata.resourceVersion,
      },
      {
        op: "test",
        path: "/data/state",
        value: record(work.resource.data).state,
      },
      ...(work.volumeIdentity === undefined
        ? []
        : [
            {
              op: "test",
              path: "/metadata/annotations/pgcf.io~1volume-identity",
              value: work.volumeIdentity,
            },
          ]),
      { op: "add", path: `/data/${DATA}`, value: encoded },
    ]);
    const current = await k8s.read(
      "ConfigMap",
      "pgcf-system",
      work.resource.metadata.name,
    );
    if (
      !current ||
      uid(current) !== uid(work.resource) ||
      record(current.data).state !== work.checkpoint.identity.state ||
      record(current.data)[DATA] !== encoded
    )
      throw new Error("measurement_checkpoint_changed");
    work.resource = current;
  }
  private async flush(
    k8s: Kubernetes,
    works: Work[],
    signal: AbortSignal,
  ): Promise<void> {
    const samples = works
      .flatMap((work) => work.checkpoint.outbox)
      .slice(0, 100);
    for (const batch of measurementBatches("samples", samples)) {
      try {
        signal.throwIfAborted();
        await this.options.api.usage(
          AgentUsageRequest.parse({ samples: batch }),
          signal,
        );
      } catch {
        return;
      }
      for (const work of works) {
        const acknowledged = batch.filter(
          (sample) => sample.database_id === work.db.id,
        ).length;
        if (!acknowledged) continue;
        work.checkpoint.outbox.splice(0, acknowledged);
        try {
          await this.save(k8s, work);
        } catch {
          /* Lost checkpoint acknowledgement replays the original immutable samples. */
        }
      }
    }
  }
  private async reports(
    db: Subject,
    snapshot: Snapshot,
    signal: AbortSignal,
  ): Promise<GatewayActivityReport[]> {
    if (
      snapshot.pods.length < 1 ||
      snapshot.pods.length > 16 ||
      new Set(snapshot.pods.map((pod) => pod.uid)).size !== snapshot.pods.length
    )
      throw new Error("measurement_inventory_invalid");
    return Promise.all(
      snapshot.pods.map(async (pod) => {
        const token = await signGatewayActivity({
          keyring: snapshot.keyring,
          region: this.options.region,
          database: db.id,
          revision: db.generation,
          pod: pod.uid,
          now: this.now,
        });
        if (!isIP(pod.ip)) throw new Error("measurement_address_invalid");
        const host = isIP(pod.ip) === 6 ? `[${pod.ip}]` : pod.ip;
        const response = await (this.options.fetcher ?? fetch)(
          `http://${host}:8080${GATEWAY_ACTIVITY_PATH}`,
          {
            method: "POST",
            headers: { [GATEWAY_ACTIVITY_HEADER]: token },
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("measurement_report_unavailable");
        }
        const report = gatewayActivityReportSchema.parse(
          JSON.parse(await boundedText(response, 4096)),
        );
        const observed = Date.parse(report.observedAt);
        if (
          report.region !== this.options.region ||
          report.database !== db.id ||
          report.revision !== db.generation ||
          report.pod !== pod.uid ||
          observed < this.now - GATEWAY_ACTIVITY_FRESH_MS ||
          observed > this.now + GATEWAY_ACTIVITY_FUTURE_MS
        )
          throw new Error("measurement_report_binding_invalid");
        return report;
      }),
    );
  }
  private async collect(): Promise<void> {
    if (!this.targets.length || this.options.signal.aborted) return;
    const signal = AbortSignal.any([
      this.options.signal,
      AbortSignal.timeout(10000),
    ]);
    const k8s =
      typeof this.options.k8s === "function"
        ? this.options.k8s(signal)
        : this.options.k8s;
    const anchor = this.targets[0]!;
    if (!this.cursorLoaded) {
      try {
        this.cursor =
          (await k8s.read("ConfigMap", "pgcf-system", `storage-${anchor.id}`))
            ?.metadata.annotations?.[CURSOR] ?? "";
      } catch {
        this.cursor = "";
      }
      this.cursorLoaded = true;
    }
    const after = this.targets.filter((db) => db.id > this.cursor),
      before = this.targets.filter((db) => db.id <= this.cursor);
    const cohort = [...after, ...before].slice(
      0,
      this.options.cohort ?? MEASUREMENT_COHORT,
    );
    const candidates = cohort.filter(
      (db) => !this.cooled(db) || this.sampling.get(db.id)?.pending,
    );
    if (!candidates.length) {
      const last = cohort.at(-1);
      if (last) this.cursor = last.id;
      return;
    }
    const works: Work[] = [];
    for (const db of candidates) {
      try {
        const work = await this.owner(k8s, db);
        this.remember(work);
        works.push(work);
      } catch {
        /* A foreign or incomplete resource never becomes an idle measurement. */
      }
    }
    const persisted = new Set(
      works
        .filter((work) => work.checkpoint.outbox.length > 0)
        .map((work) => work.db.id),
    );
    const replaying = new Set(
      works
        .filter((work) => work.checkpoint.outbox.length > 0)
        .map((work) => work.db.id),
    );
    const measuring = works.filter(
      (work) => !this.cooled(work.db) && !replaying.has(work.db.id),
    );
    const due = new Set(measuring.map((work) => work.db.id));
    let snapshot: Snapshot | undefined;
    try {
      if (measuring.length) snapshot = await this.options.snapshot(signal);
    } catch {
      /* Discovery failure marks a gap without manufacturing a respondent. */
    }
    const collected = new Map<string, GatewayActivityReport[]>();
    const usedStorage = new Map<string, number | null>();
    const summaries = new Map<string, Promise<unknown>>();
    let index = 0;
    const worker = async () => {
      while (index < measuring.length && !signal.aborted) {
        const work = measuring[index++]!;
        if (snapshot) {
          usedStorage.set(
            work.db.id,
            await storageUsed(k8s, work, summaries, () => this.now),
          );
          try {
            collected.set(
              work.db.id,
              await this.reports(work.db, snapshot, signal),
            );
          } catch {
            /* This subject is explicitly incomplete. */
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, measuring.length) }, worker),
    );
    signal.throwIfAborted();
    if (snapshot) {
      try {
        if (
          signature(snapshot) !== signature(await this.options.snapshot(signal))
        )
          collected.clear();
      } catch {
        collected.clear();
      }
    }
    const activities: AgentActivityRequest["databases"] = [];
    for (const work of works) {
      if (!due.has(work.db.id)) continue;
      const reports = collected.get(work.db.id),
        checkpoint = work.checkpoint;
      if (!reports || !snapshot) {
        checkpoint.gapSince = new Date(this.now).toISOString();
        delete checkpoint.idleObservedSince;
        try {
          await this.save(k8s, work);
        } catch {
          /* A failed CAS cannot authorize an idle report. */
        }
        continue;
      }
      if (
        checkpoint.baseline?.reports.some((previous) =>
          reports.some(
            (report) =>
              report.pod === previous.pod &&
              Date.parse(report.observedAt) < Date.parse(previous.observedAt),
          ),
        )
      ) {
        checkpoint.gapSince = new Date(this.now).toISOString();
        delete checkpoint.idleObservedSince;
        collected.delete(work.db.id);
        try {
          await this.save(k8s, work);
        } catch {
          /* A backward clock cannot advance the durable baseline. */
        }
        continue;
      }
      const complete = reports.every(history);
      const inventory = snapshot.pods;
      const continuous =
        checkpoint.baseline &&
        text(checkpoint.baseline.inventory) === text(inventory) &&
        checkpoint.baseline.keyUid === snapshot.keyUid &&
        checkpoint.baseline.keyVersion === snapshot.keyVersion;
      const prior = checkpoint.baseline;
      const monotonic =
        !prior ||
        reports.every((report) => {
          const last = prior.reports.find((value) => value.pod === report.pod);
          return (
            !last ||
            !sameEpoch(last, report) ||
            [
              "ingressBytes",
              "egressBytes",
              "totalConnections",
              "connectionMilliseconds",
            ].every((name) => {
              const field = name as
                | "ingressBytes"
                | "egressBytes"
                | "totalConnections"
                | "connectionMilliseconds";
              return (
                last[field] === null ||
                report[field] === null ||
                report[field]! >= last[field]!
              );
            })
          );
        });
      const epochsMatch =
        !!prior &&
        reports.every((report) => {
          const previous = prior.reports.find(
            (value) => value.pod === report.pod,
          );
          return (
            !!previous &&
            sameEpoch(previous, report) &&
            previous.revision === report.revision
          );
        });
      const later =
        !!prior &&
        reports.every((report) => {
          const previous = prior.reports.find(
            (value) => value.pod === report.pod,
          );
          return (
            !!previous &&
            history(previous) &&
            report.observedAt > previous.observedAt
          );
        });
      const hadGap = checkpoint.gapSince !== undefined;
      const gapDetected =
        !complete || (!!prior && (!continuous || !epochsMatch)) || !monotonic;
      if (gapDetected) {
        checkpoint.gapSince = new Date(this.now).toISOString();
        delete checkpoint.idleObservedSince;
      }
      const oldest = reports.map((report) => report.observedAt).sort()[0]!;
      const recovered =
        complete &&
        continuous &&
        epochsMatch &&
        monotonic &&
        later &&
        !!checkpoint.idleObservedSince &&
        checkpoint.idleObservedSince <= oldest;
      if (checkpoint.gapSince && complete) {
        if (recovered) delete checkpoint.gapSince;
        else if (
          !checkpoint.idleObservedSince &&
          this.now >= Date.parse(checkpoint.gapSince)
        )
          checkpoint.idleObservedSince = new Date(this.now).toISOString();
      }
      const boundary = [
        ...reports.map(gatewayActivityBoundary),
        ...(checkpoint.idleObservedSince ? [checkpoint.idleObservedSince] : []),
      ]
        .sort()
        .at(-1)!;
      if (complete && !checkpoint.gapSince) {
        try {
          activities.push(
            AgentDatabaseActivity.parse({
              id: work.db.id,
              revision: work.db.generation,
              observed_at: reports
                .map((report) => report.observedAt)
                .sort()
                .at(-1),
              last_activity_at: boundary,
              ...(checkpoint.idleObservedSince
                ? { idle_observed_since: checkpoint.idleObservedSince }
                : {}),
              connections: reports.reduce(
                (sum, report) => sum + report.connections,
                0,
              ),
              busy_connections: reports.reduce(
                (sum, report) => sum + report.busyConnections,
                0,
              ),
              pending_dials: reports.reduce(
                (sum, report) => sum + report.pendingDials,
                0,
              ),
              expected_gateway_pods: inventory.map((pod) => pod.uid),
              reports,
            }),
          );
        } catch {
          /* Aggregates must preserve every authenticated respondent. */
        }
      }
      if (replaying.has(work.db.id)) {
        try {
          await this.save(k8s, work);
        } catch {
          collected.delete(work.db.id);
        }
        continue;
      }
      const previous = checkpoint.baseline;
      const pending = [...checkpoint.outbox];
      if (previous) {
        const expected = reports.map(producer).sort();
        for (const report of reports) {
          const last = previous.reports.find(
            (value) => value.pod === report.pod,
          );
          if (last)
            pending.push(
              ...differences(
                last,
                report,
                expected,
                !!continuous && ((!hadGap && !gapDetected) || !!recovered),
              ),
            );
        }
      }
      pending.push(
        UsageSample.parse({
          database_id: work.db.id,
          source: "agent",
          producer_id: this.process,
          sequence: this.now,
          observed_at: new Date(this.now).toISOString(),
          storage_used_bytes: usedStorage.get(work.db.id) ?? null,
          storage_allocated_bytes: work.allocated,
        }),
      );
      if (
        pending.length <= MAX_OUTBOX &&
        Buffer.byteLength(text({ ...checkpoint, outbox: pending })) <=
          CHECKPOINT_BYTES
      ) {
        checkpoint.outbox = pending;
        checkpoint.baseline = {
          sampledAt: new Date(this.now).toISOString(),
          inventory,
          keyUid: snapshot.keyUid,
          keyVersion: snapshot.keyVersion,
          reports,
        };
      }
      try {
        await this.save(k8s, work);
        persisted.add(work.db.id);
      } catch {
        collected.delete(work.db.id);
      }
    }
    const confirmed = new Set<string>();
    for (const work of works) {
      if (!collected.has(work.db.id) || signal.aborted) continue;
      try {
        if (
          text((await this.owner(k8s, work.db)).checkpoint.identity) ===
          text(work.checkpoint.identity)
        )
          confirmed.add(work.db.id);
      } catch {
        /* Identity/fence changes invalidate an otherwise recent report. */
      }
    }
    for (const batch of measurementBatches(
      "databases",
      activities.filter((value) => confirmed.has(value.id)),
    )) {
      if (this.options.signal.aborted) return;
      if (
        batch.some(
          (value) =>
            Date.parse(value.observed_at) <
            this.now - GATEWAY_ACTIVITY_FRESH_MS,
        )
      )
        continue;
      try {
        await this.options.api.activity(
          AgentActivityRequest.parse({ databases: batch }),
          signal,
        );
      } catch {
        /* Activity is point-in-time and is freshly sampled instead of replayed later. */
      }
    }
    if (!signal.aborted)
      await this.flush(
        k8s,
        works.filter((work) => persisted.has(work.db.id)),
        signal,
      );
    for (const work of works) this.remember(work);
    const last = cohort.at(-1);
    if (last) this.cursor = last.id;
    try {
      const resource = await k8s.read(
        "ConfigMap",
        "pgcf-system",
        `storage-${anchor.id}`,
      );
      if (
        resource &&
        resource.metadata.labels?.[DATABASE_LABEL] === anchor.id &&
        !resource.metadata.deletionTimestamp &&
        resource.metadata.resourceVersion
      )
        await k8s.patch("ConfigMap", "pgcf-system", resource.metadata.name, [
          { op: "test", path: "/metadata/uid", value: uid(resource) },
          {
            op: "test",
            path: "/metadata/resourceVersion",
            value: resource.metadata.resourceVersion,
          },
          {
            op: "add",
            path: "/metadata/annotations",
            value: { ...resource.metadata.annotations, [CURSOR]: this.cursor },
          },
        ]);
    } catch {
      /* Paging remains bounded; a missing anchor cannot authorize or erase another database. */
    }
  }
  async run(): Promise<void> {
    while (!this.options.signal.aborted) {
      const started = Date.now();
      try {
        await this.cycle();
      } catch {
        /* Only complete fresh cohorts can reach activity ingestion. */
      }
      const wait = Math.max(
        1,
        (this.options.periodMs ?? 250) - (Date.now() - started),
      );
      try {
        await delay(wait, undefined, { signal: this.options.signal });
      } catch {
        return;
      }
    }
  }
}

// Native behavioral conformance consumes the existing implementation and limits.
export {
  DATA as MEASUREMENT_CHECKPOINT_KEY,
  CURSOR as MEASUREMENT_CURSOR_ANNOTATION,
  CHECKPOINT_BYTES as MEASUREMENT_CHECKPOINT_BYTES,
  MAX_OUTBOX as MEASUREMENT_MAX_OUTBOX,
  readCheckpoint as measurementCheckpoint,
  differences as measurementDifferences,
};
