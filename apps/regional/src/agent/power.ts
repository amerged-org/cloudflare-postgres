// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";
import { ApiException } from "@kubernetes/client-node";
import type { DatabaseObservation, DesiredDatabase } from "@pgcf/contracts";
import { ARCHIVE_DESTINATION_PATTERN, isDatabaseId } from "@pgcf/contracts";
import { MAINTENANCE_ROLE } from "@pgcf/contracts/maintenance";
import {
  parseRouteKeyring,
  type RouteKeyring,
} from "@pgcf/contracts/route-token";
import {
  gatewayIntentSchema,
  gatewayFenceName,
  gatewayPodUidSchema,
  gatewayControlReportSchema,
  GATEWAY_FENCE_LABEL,
  GATEWAY_CONTROL_HEADER,
  GATEWAY_CONTROL_PATH_PREFIX,
  signGatewayControl,
  type GatewayIntent,
  type GatewayControlAction,
} from "@pgcf/contracts/gateway-control";
import {
  probeSleepSafety,
  resumeSleepSafety,
  type SleepProbeOptions,
  type SleepSafetyResult,
  type SleepRefusal,
  SLEEP_REFUSALS,
} from "./sleep.ts";
import { appliedGeneration, condition, DATABASE_LABEL } from "./observe.ts";
import {
  record,
  string,
  uid,
  type Kubernetes,
  type Log,
  type Resource,
} from "./types.ts";

export const WAKE_PHASES = [
  "wake_prepare",
  "desired_apply",
  "archive_metrics",
  "ca_publication",
  "desired_applied",
  "role_runtime_auth",
  "volume_identity",
  "runtime_unchanged",
  "fence_release",
  "observation_post",
] as const;
export type WakePhase = (typeof WAKE_PHASES)[number];
export type WakePhaseOutcome = "completed" | "pending" | "failed";
export function beginWakePhase(
  log: Log | undefined,
  phase: WakePhase,
  databaseId?: string,
  now: () => number = () => performance.now(),
): (outcome: WakePhaseOutcome) => void {
  if (!log || !WAKE_PHASES.includes(phase)) return () => {};
  let started: number;
  try {
    started = now();
  } catch {
    return () => {};
  }
  let finished = false;
  return (outcome) => {
    if (finished) return;
    finished = true;
    try {
      const ended = now();
      if (
        !Number.isFinite(started) ||
        !Number.isFinite(ended) ||
        started < 0 ||
        ended < started ||
        !["completed", "pending", "failed"].includes(outcome)
      )
        return;
      log("wake_phase", {
        phase,
        elapsedMs: Math.min(
          600000,
          Math.round((ended - started) * 1000) / 1000,
        ),
        outcome,
        ...(databaseId && isDatabaseId(databaseId)
          ? { database_id: databaseId }
          : {}),
      });
    } catch {
      /* Diagnostics cannot alter reconciliation or expose a logger failure. */
    }
  };
}
export async function measureWakePhase<T>(
  log: Log | undefined,
  phase: WakePhase,
  databaseId: string | undefined,
  work: () => Promise<T>,
  now: () => number = () => performance.now(),
): Promise<T> {
  const finish = beginWakePhase(log, phase, databaseId, now);
  let outcome: WakePhaseOutcome = "failed";
  try {
    const value = await work();
    outcome = value === null || value === false ? "pending" : "completed";
    try {
      if (record(value).state === "error") outcome = "failed";
      else if (record(value).state === "provisioning") outcome = "pending";
    } catch {
      /* A diagnostic classification cannot affect the returned value. */
    }
    finish(outcome);
    return value;
  } finally {
    finish(outcome);
  }
}

const NS = "pgcf-system",
  PROGRESS = "power.json",
  HIBERNATION = "cnpg.io/hibernation";
const POWER_REVISION = "pgcf.io/power-revision",
  POWER_OPERATION = "pgcf.io/power-operation";
const GATEWAY_FENCE_UID = "pgcf.io/gateway-fence-uid";
const MAX_WAIT = 10 * 60_000;
export interface GatewayPod {
  name: string;
  uid: string;
  ip: string;
  restarts: number;
}
interface Anchor {
  storageUid: string;
  storageState: string;
  volumeIdentity: string;
  physicalGeneration: number;
  namespaceUid: string;
  clusterUid: string;
  node: string;
  archivePath: string;
  claimName: string;
  claimUid: string;
  volumeName: string;
  volumeUid: string;
  handle: string;
  affinity: string;
  lvmName: string;
  lvmNamespace: string;
  lvmUid: string;
}
interface Progress {
  target: GatewayIntent;
  proofIntent?: GatewayIntent;
  phase:
    | "quiescing"
    | "switching"
    | "archive"
    | "proved"
    | "hibernating"
    | "hibernated"
    | "wake"
    | "awake"
    | "refused";
  startedAt: number;
  anchor: Anchor;
  refusal?: "busy" | "archive" | "unknown";
  gateways?: GatewayPod[];
  keyUid?: string;
  keyVersion?: string;
  segment?: string;
}
export type PowerObservation = DatabaseObservation;
export function desiredPower(db: DesiredDatabase): GatewayIntent | undefined {
  const value = record(db).power;
  if (value === undefined) return undefined;
  const data = record(value);
  const intent = gatewayIntentSchema.parse({
    database: db.id,
    operation: data.operation,
    revision: data.revision,
    mode: data.mode,
  });
  if (
    intent.revision !== db.generation ||
    !["manual", "idle", null].includes(data.reason as string | null) ||
    (intent.mode === "quiesce"
      ? record(db).desired_state !== "suspended"
      : db.desired_state !== "running")
  )
    throw new Error("power_intent_invalid");
  return intent;
}
class Stale extends Error {}
class Recovery extends Error {}
class Busy extends Error {}
class Unavailable extends Error {}
const UNAVAILABLE_DIAGNOSTICS = new Set([
  "gateway_private_address_unavailable",
  "protected_credentials_unavailable",
  "gateway_replica_configuration_missing",
  "gateway_inventory_incomplete",
  "gateway_inventory_invalid",
  "gateway_inventory_duplicate",
  "gateway_continuity_unknown",
  "regional_keyring_missing",
  "gateway_ack_unavailable",
  "gateway_report_overflow",
  "gateway_ack_identity_mismatch",
  "gateway_release_unacknowledged",
  "fence_continuity_lost",
  "switch_result_unknown",
  "maintenance_capability_missing",
  "maintenance_credentials_unacknowledged",
  "database_ca_missing",
  "keyring_continuity_lost",
  "gateway_inventory_changed",
  "closed_segment_not_persisted",
]);
const DIAGNOSTIC_HTTP_STATUS = new Set([
  400, 401, 403, 404, 408, 409, 410, 412, 413, 415, 422, 429, 500, 502, 503,
  504,
]);

const encoded = (value: unknown): string => JSON.stringify(value);
function required(value: unknown, maximum = 253): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw new Recovery("power_identity_missing");
  return value;
}
function owned(
  resource: Resource | null,
  name: string,
  database: string,
  namespace?: string,
): Resource {
  if (
    !resource ||
    resource.metadata.name !== name ||
    resource.metadata.namespace !== namespace ||
    resource.metadata.labels?.[DATABASE_LABEL] !== database ||
    resource.metadata.deletionTimestamp
  )
    throw new Recovery("established_database_resource_missing_or_replaced");
  required(resource.metadata.uid);
  required(resource.metadata.resourceVersion);
  return resource;
}
function privateIp(value: unknown): string {
  const ip = required(value);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (
      a === 10 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168)
    )
      return ip;
  } else if (isIP(ip) === 6 && /^(fc|fd)/i.test(ip)) return ip;
  throw new Unavailable("gateway_private_address_unavailable");
}
function decode(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Unavailable("protected_credentials_unavailable");
  const bytes = Buffer.from(value, "base64");
  const result = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!result || result.includes("\0") || bytes.toString("base64") !== value)
    throw new Unavailable("protected_credentials_unavailable");
  return result;
}
function progressFrom(map: Resource, now: number): Progress | undefined {
  const text = record(map.data)[PROGRESS];
  if (text === undefined) return undefined;
  if (typeof text !== "string" || text.length > 16384)
    throw new Recovery("power_progress_invalid");
  const value = record(JSON.parse(text)),
    anchor = record(value.anchor);
  const target = gatewayIntentSchema.parse(value.target);
  const proofIntent =
    value.proofIntent === undefined
      ? undefined
      : gatewayIntentSchema.parse(value.proofIntent);
  if (
    proofIntent &&
    (proofIntent.mode !== "quiesce" ||
      proofIntent.database !== target.database ||
      proofIntent.revision > target.revision)
  )
    throw new Recovery("power_proof_origin_invalid");
  if (
    value.refusal !== undefined &&
    !["busy", "archive", "unknown"].includes(String(value.refusal))
  )
    throw new Recovery("power_refusal_invalid");
  if (
    !Number.isSafeInteger(value.startedAt) ||
    (value.startedAt as number) < 0 ||
    (value.startedAt as number) > now ||
    ![
      "quiescing",
      "switching",
      "archive",
      "proved",
      "hibernating",
      "hibernated",
      "wake",
      "awake",
      "refused",
    ].includes(String(value.phase))
  )
    throw new Recovery("power_progress_invalid");
  for (const field of [
    "storageUid",
    "storageState",
    "volumeIdentity",
    "namespaceUid",
    "clusterUid",
    "node",
    "archivePath",
    "claimName",
    "claimUid",
    "volumeName",
    "volumeUid",
    "handle",
    "affinity",
    "lvmName",
    "lvmNamespace",
    "lvmUid",
  ]) {
    if (
      typeof anchor[field] !== "string" ||
      (anchor[field] as string).length > 4096 ||
      (field !== "affinity" && !(anchor[field] as string).length)
    )
      throw new Recovery("power_progress_invalid");
  }
  if (
    !Number.isSafeInteger(anchor.physicalGeneration) ||
    (anchor.physicalGeneration as number) < 1
  )
    throw new Recovery("power_progress_invalid");
  if (
    value.segment !== undefined &&
    (typeof value.segment !== "string" || !/^[0-9A-F]{24}$/.test(value.segment))
  )
    throw new Recovery("power_progress_invalid");
  if (
    ["archive", "proved", "hibernating", "hibernated"].includes(
      String(value.phase),
    ) &&
    (!value.segment || !proofIntent)
  )
    throw new Recovery("power_segment_missing");
  if (value.gateways !== undefined) {
    if (
      !Array.isArray(value.gateways) ||
      value.gateways.length < 1 ||
      value.gateways.length > 64
    )
      throw new Recovery("power_inventory_invalid");
    const ids = new Set<string>();
    for (const raw of value.gateways) {
      const pod = record(raw);
      required(pod.name);
      gatewayPodUidSchema.parse(pod.uid);
      privateIp(pod.ip);
      if (
        !Number.isSafeInteger(pod.restarts) ||
        (pod.restarts as number) < 0 ||
        ids.has(pod.uid as string)
      )
        throw new Recovery("power_inventory_invalid");
      ids.add(pod.uid as string);
    }
    required(value.keyUid);
    required(value.keyVersion);
  }
  if (
    ["switching", "archive", "proved", "hibernating", "hibernated"].includes(
      String(value.phase),
    ) &&
    !value.gateways
  )
    throw new Recovery("power_continuity_missing");
  return {
    ...value,
    target,
    ...(proofIntent ? { proofIntent } : {}),
  } as unknown as Progress;
}

export interface PowerOptions {
  k8s: Kubernetes | ((signal: AbortSignal) => Kubernetes);
  signal: AbortSignal;
  region: string;
  replicas?: number;
  log?: Log;
  now?: () => number;
  fetcher?: typeof fetch;
  probe?: (options: SleepProbeOptions) => Promise<SleepSafetyResult>;
  resume?: (
    options: SleepProbeOptions,
    segment: string,
  ) => Promise<SleepSafetyResult>;
}
interface Step {
  k8s: Kubernetes;
  signal: AbortSignal;
  mutations: Promise<unknown>[];
}
export class PowerCoordinator {
  private readonly options: PowerOptions;
  private readonly current = new Set<AbortController>();
  constructor(options: PowerOptions) {
    this.options = options;
  }
  private logSleepRefusal(
    phase: Progress["phase"] | undefined,
    reason?: SleepRefusal,
    error?: unknown,
  ): void {
    if (!this.options.log) return;
    const fields: Record<string, string | number | boolean> = {
      phase:
        phase &&
        [
          "quiescing",
          "switching",
          "archive",
          "proved",
          "hibernating",
          "hibernated",
          "refused",
        ].includes(phase)
          ? phase
          : "prepare",
      category: reason === undefined ? "unknown" : "probe",
      reason: "unknown",
    };
    try {
      if (reason !== undefined && SLEEP_REFUSALS.includes(reason))
        fields.reason = reason;
      else if (
        error instanceof Unavailable &&
        UNAVAILABLE_DIAGNOSTICS.has(error.message)
      ) {
        fields.category = "unavailable";
        fields.reason = error.message;
      } else if (error instanceof Busy) {
        fields.category = "busy";
        fields.reason = "gateway_busy";
      } else if (
        error instanceof ApiException &&
        typeof error.code === "number" &&
        DIAGNOSTIC_HTTP_STATUS.has(error.code)
      ) {
        fields.category = "kubernetes_http";
        fields.status = error.code;
      }
    } catch {
      /* Exception metadata is untrusted diagnostic input. */
    }
    try {
      void Promise.resolve(this.options.log("sleep_refused", fields)).catch(
        () => {},
      );
    } catch {
      /* Logging cannot change refusal, cleanup or compensation. */
    }
  }
  interrupt(): void {
    for (const controller of this.current) controller.abort();
  }
  private get now(): number {
    return (this.options.now ?? Date.now)();
  }
  private async step<T>(work: (step: Step) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.current.add(controller);
    const signal = AbortSignal.any([
      this.options.signal,
      controller.signal,
      AbortSignal.timeout(10000),
    ]);
    const step = {
      k8s:
        typeof this.options.k8s === "function"
          ? this.options.k8s(signal)
          : this.options.k8s,
      signal,
      mutations: [] as Promise<unknown>[],
    };
    try {
      return await work(step);
    } finally {
      await Promise.allSettled(step.mutations);
      controller.abort();
      this.current.delete(controller);
    }
  }
  private async mutate(
    step: Step,
    action: () => Promise<unknown>,
  ): Promise<void> {
    step.signal.throwIfAborted();
    const pending = action();
    step.mutations.push(pending);
    await pending;
  }
  private observation(
    db: DesiredDatabase,
    intent: GatewayIntent,
    state: "hibernated" | "awake",
    refusal?: "busy" | "archive" | "unknown",
  ): PowerObservation {
    return {
      id: db.id,
      generation: db.generation,
      state: refusal
        ? "error"
        : state === "hibernated"
          ? "hibernated"
          : "ready",
      ...(refusal ? { message: `sleep refused: ${refusal}` } : {}),
      archive: { continuous: false, ready_wal_files: null },
      power: {
        operation: intent.operation,
        revision: intent.revision,
        state,
        ...(refusal ? { refusal } : {}),
      },
    };
  }
  private async anchor(
    step: Step,
    db: DesiredDatabase,
  ): Promise<{ anchor: Anchor; cluster: Resource }> {
    const namespace = `pgcf-db-${db.id}`;
    const [nsValue, clusterValue, storageValue, volumes, lvms] =
      await Promise.all([
        step.k8s.read("Namespace", undefined, namespace),
        step.k8s.read("Cluster", namespace, "database"),
        step.k8s.read("ConfigMap", NS, `storage-${db.id}`),
        step.k8s.list("PersistentVolume"),
        step.k8s.list("LVMVolume"),
      ]);
    const ns = owned(nsValue, namespace, db.id),
      cluster = owned(clusterValue, "database", db.id, namespace),
      storage = owned(storageValue, `storage-${db.id}`, db.id, NS);
    if (appliedGeneration(storage) > db.generation) throw new Stale();
    const storedText = required(record(storage.data).state, 4096),
      stored = record(JSON.parse(storedText));
    if (
      stored.namespaceUid !== uid(ns) ||
      stored.clusterUid !== uid(cluster) ||
      stored.node !== db.node ||
      stored.archivePath !== db.archive.destination_path
    )
      throw new Recovery("storage_identity_changed");
    const physical = ARCHIVE_DESTINATION_PATTERN.exec(
      db.archive.destination_path,
    );
    if (!physical) throw new Recovery("archive_identity_invalid");
    const volumeText = required(
        storage.metadata.annotations?.["pgcf.io/volume-identity"],
        4096,
      ),
      identity = record(JSON.parse(volumeText));
    const matching = volumes.filter(
      (value) => value.metadata.uid === identity.volumeUid,
    );
    if (matching.length !== 1)
      throw new Recovery("persistent_volume_missing_or_replaced");
    const volume = matching[0]!,
      spec = record(volume.spec),
      ref = record(spec.claimRef);
    const handle = required(record(spec.csi).volumeHandle),
      claimName = required(ref.name);
    if (
      volume.metadata.deletionTimestamp ||
      ref.namespace !== namespace ||
      ref.uid !== identity.claimUid ||
      handle !== identity.handle ||
      record(spec.csi).driver !== "local.csi.openebs.io" ||
      spec.storageClassName !== "pgcf-lvm" ||
      record(volume.status).phase !== "Bound"
    )
      throw new Recovery("persistent_volume_identity_changed");
    const claim = await step.k8s.read(
      "PersistentVolumeClaim",
      namespace,
      claimName,
    );
    if (
      !claim ||
      claim.metadata.uid !== identity.claimUid ||
      claim.metadata.deletionTimestamp ||
      record(claim.spec).volumeName !== volume.metadata.name ||
      record(claim.status).phase !== "Bound" ||
      record(claim.spec).storageClassName !== "pgcf-lvm"
    )
      throw new Recovery("persistent_claim_missing_or_replaced");
    const lvmMatches = lvms.filter((value) => value.metadata.name === handle);
    if (lvmMatches.length !== 1 || lvmMatches[0]!.metadata.deletionTimestamp)
      throw new Recovery("lvm_volume_missing_or_replaced");
    const lvm = lvmMatches[0]!;
    const revision = Number(
      cluster.metadata.annotations?.[POWER_REVISION] ?? 0,
    );
    if (!Number.isSafeInteger(revision) || revision > db.generation)
      throw new Stale();
    return {
      cluster,
      anchor: {
        storageUid: uid(storage),
        storageState: storedText,
        volumeIdentity: volumeText,
        physicalGeneration: Number(physical[4]),
        namespaceUid: uid(ns),
        clusterUid: uid(cluster),
        node: db.node,
        archivePath: db.archive.destination_path,
        claimName,
        claimUid: uid(claim),
        volumeName: volume.metadata.name,
        volumeUid: uid(volume),
        handle,
        affinity: encoded(spec.nodeAffinity ?? null),
        lvmName: lvm.metadata.name,
        lvmNamespace: required(lvm.metadata.namespace),
        lvmUid: uid(lvm),
      },
    };
  }
  private assertAnchor(actual: Anchor, saved: Anchor): void {
    if (encoded(actual) !== encoded(saved))
      throw new Recovery("power_storage_identity_changed");
  }
  private async fence(
    step: Step,
    db: DesiredDatabase,
  ): Promise<Resource | null> {
    const [map, storage] = await Promise.all([
      step.k8s.read("ConfigMap", NS, gatewayFenceName(db.id)),
      step.k8s.read("ConfigMap", NS, `storage-${db.id}`),
    ]);
    const expectedUid = storage?.metadata.annotations?.[GATEWAY_FENCE_UID];
    if (expectedUid && (!map || uid(map) !== expectedUid))
      throw new Recovery("gateway_fence_missing_or_replaced");
    if (!map) return null;
    owned(map, gatewayFenceName(db.id), db.id, NS);
    if (map.metadata.labels?.[GATEWAY_FENCE_LABEL] !== "true")
      throw new Recovery("gateway_fence_ownership_invalid");
    const value = record(map.data)["intent.json"];
    if (typeof value !== "string" || value.length > 1024)
      throw new Recovery("gateway_fence_invalid");
    const intent = gatewayIntentSchema.parse(JSON.parse(value));
    if (intent.database !== db.id || intent.revision > db.generation)
      throw new Stale();
    return map;
  }
  private async write(
    step: Step,
    db: DesiredDatabase,
    map: Resource | null,
    intent: GatewayIntent | undefined,
    progress: Progress,
  ): Promise<Resource> {
    const name = gatewayFenceName(db.id),
      data = {
        ...record(map?.data),
        ...(intent ? { "intent.json": encoded(intent) } : {}),
        [PROGRESS]: encoded(progress),
      };
    if (data[PROGRESS].length > 16384)
      throw new Recovery("power_progress_overflow");
    if (map) {
      const prior = gatewayIntentSchema.parse(
        JSON.parse(String(record(map.data)["intent.json"])),
      );
      if (
        intent &&
        (intent.revision < prior.revision ||
          (intent.revision === prior.revision &&
            encoded(intent) !== encoded(prior)))
      )
        throw new Stale();
      const old = progressFrom(map, this.now);
      if (old && old.target.revision > progress.target.revision)
        throw new Stale();
      await this.mutate(step, () =>
        step.k8s.patch("ConfigMap", NS, name, [
          { op: "test", path: "/metadata/uid", value: uid(map) },
          {
            op: "test",
            path: "/metadata/resourceVersion",
            value: map.metadata.resourceVersion,
          },
          {
            op: "test",
            path: "/data/intent.json",
            value: record(map.data)["intent.json"],
          },
          { op: "add", path: "/data", value: data },
        ]),
      );
    } else {
      if (!intent) throw new Recovery("gateway_fence_missing");
      await this.mutate(step, () =>
        step.k8s.create({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name,
            namespace: NS,
            labels: { [DATABASE_LABEL]: db.id, [GATEWAY_FENCE_LABEL]: "true" },
          },
          data,
        }),
      );
    }
    const next = await this.fence(step, db);
    if (
      !next ||
      (map && uid(next) !== uid(map)) ||
      record(next.data)[PROGRESS] !== encoded(progress)
    )
      throw new Stale();
    return next;
  }
  private async bindFence(
    step: Step,
    db: DesiredDatabase,
    map: Resource,
  ): Promise<void> {
    const storage = owned(
      await step.k8s.read("ConfigMap", NS, `storage-${db.id}`),
      `storage-${db.id}`,
      db.id,
      NS,
    );
    if (appliedGeneration(storage) > db.generation) throw new Stale();
    const previous = storage.metadata.annotations?.[GATEWAY_FENCE_UID];
    if (previous !== undefined) {
      if (previous !== uid(map)) throw new Recovery("gateway_fence_replaced");
      return;
    }
    // This durable identity survives loss of the execution record and prevents another uncertain switch.
    await this.mutate(step, () =>
      step.k8s.patch("ConfigMap", NS, storage.metadata.name, [
        { op: "test", path: "/metadata/uid", value: uid(storage) },
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: storage.metadata.resourceVersion,
        },
        { op: "test", path: "/data/state", value: record(storage.data).state },
        {
          op: "add",
          path: "/metadata/annotations",
          value: {
            ...storage.metadata.annotations,
            [GATEWAY_FENCE_UID]: uid(map),
          },
        },
      ]),
    );
  }
  private async gateways(step: Step): Promise<GatewayPod[]> {
    const expected = this.options.replicas;
    if (
      !Number.isSafeInteger(expected) ||
      !expected ||
      expected < 1 ||
      expected > 64
    )
      throw new Unavailable("gateway_replica_configuration_missing");
    const pods = await step.k8s.list(
      "Pod",
      NS,
      "app.kubernetes.io/name=pgcf-gateway",
    );
    if (pods.length < expected || pods.length > 64)
      throw new Unavailable("gateway_inventory_incomplete");
    const ids = new Set<string>();
    return pods
      .map((pod) => {
        if (
          pod.kind !== "Pod" ||
          pod.metadata.namespace !== NS ||
          pod.metadata.labels?.["app.kubernetes.io/name"] !== "pgcf-gateway" ||
          record(pod.spec).serviceAccountName !== "pgcf-gateway"
        )
          throw new Unavailable("gateway_inventory_invalid");
        const id = gatewayPodUidSchema.parse(pod.metadata.uid);
        if (ids.has(id)) throw new Unavailable("gateway_inventory_duplicate");
        ids.add(id);
        const statuses = record(pod.status).containerStatuses;
        const gateway = Array.isArray(statuses)
          ? statuses.map(record).filter((value) => value.name === "gateway")
          : [];
        if (
          gateway.length !== 1 ||
          !Number.isSafeInteger(gateway[0]!.restartCount) ||
          (gateway[0]!.restartCount as number) < 0
        )
          throw new Unavailable("gateway_continuity_unknown");
        return {
          name: required(pod.metadata.name),
          uid: id,
          ip: privateIp(record(pod.status).podIP),
          restarts: gateway[0]!.restartCount as number,
        };
      })
      .sort((a, b) => a.uid.localeCompare(b.uid));
  }
  private async keyring(
    step: Step,
  ): Promise<{ keyring: RouteKeyring; uid: string; version: string }> {
    const secret = await step.k8s.read("Secret", NS, "pgcf-gateway");
    if (
      !secret ||
      secret.metadata.name !== "pgcf-gateway" ||
      secret.metadata.namespace !== NS ||
      secret.metadata.deletionTimestamp
    )
      throw new Unavailable("regional_keyring_missing");
    return {
      keyring: parseRouteKeyring(
        decode(record(secret.data).PGCF_ROUTE_KEY, 32768),
      ),
      uid: uid(secret),
      version: required(secret.metadata.resourceVersion),
    };
  }
  /** Read-only inventory/key access shared by bounded measurement and retirement callers. */
  async gatewaySnapshot(signal: AbortSignal): Promise<{
    pods: GatewayPod[];
    keyring: RouteKeyring;
    keyUid: string;
    keyVersion: string;
  }> {
    const scoped = AbortSignal.any([
      this.options.signal,
      signal,
      AbortSignal.timeout(3000),
    ]);
    const step: Step = {
      k8s:
        typeof this.options.k8s === "function"
          ? this.options.k8s(scoped)
          : this.options.k8s,
      signal: scoped,
      mutations: [],
    };
    const [pods, key] = await Promise.all([
      this.gateways(step),
      this.keyring(step),
    ]);
    scoped.throwIfAborted();
    return {
      pods,
      keyring: key.keyring,
      keyUid: key.uid,
      keyVersion: key.version,
    };
  }
  private async controls(
    step: Step,
    intent: GatewayIntent,
    pods: GatewayPod[],
    keys: RouteKeyring,
    action: GatewayControlAction,
  ): Promise<unknown[]> {
    const signal = AbortSignal.any([step.signal, AbortSignal.timeout(3000)]),
      reports: unknown[] = [];
    let index = 0;
    const worker = async () => {
      while (index < pods.length) {
        signal.throwIfAborted();
        const pod = pods[index++]!;
        const token = await signGatewayControl({
          keyring: keys,
          region: this.options.region,
          database: intent.database,
          operation: intent.operation,
          revision: intent.revision,
          pod: pod.uid,
          action,
        });
        const host = isIP(pod.ip) === 6 ? `[${pod.ip}]` : pod.ip;
        const response = await (this.options.fetcher ?? fetch)(
          `http://${host}:8080${GATEWAY_CONTROL_PATH_PREFIX}${action}`,
          {
            method: "POST",
            headers: { [GATEWAY_CONTROL_HEADER]: token },
            redirect: "error",
            signal,
          },
        );
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Unavailable("gateway_ack_unavailable");
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > 4096) throw new Unavailable("gateway_report_overflow");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const report = gatewayControlReportSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          ),
        );
        if (
          report.database !== intent.database ||
          report.operation !== intent.operation ||
          report.revision !== intent.revision ||
          report.pod !== pod.uid ||
          report.mode !== intent.mode
        )
          throw new Unavailable("gateway_ack_identity_mismatch");
        if (
          intent.mode === "quiesce" &&
          (report.busyConnections !== 0 ||
            report.pendingDials !== 0 ||
            !["idle", "closed"].includes(report.status))
        )
          throw new Busy();
        if (
          (action === "close" || action === "status") &&
          intent.mode === "quiesce" &&
          report.connections !== 0
        )
          throw new Busy();
        if (intent.mode === "running" && report.status !== "running")
          throw new Unavailable("gateway_release_unacknowledged");
        reports.push(report);
      }
    };
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(4, pods.length) }, worker),
    );
    const failed = results.find((value) => value.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return reports;
  }
  private async clusterIntent(
    step: Step,
    db: DesiredDatabase,
    intent: GatewayIntent,
    cluster: Resource,
    hibernation: "on" | "off",
  ): Promise<void> {
    const revision = Number(
      cluster.metadata.annotations?.[POWER_REVISION] ?? 0,
    );
    if (!Number.isSafeInteger(revision) || revision > intent.revision)
      throw new Stale();
    if (
      revision === intent.revision &&
      cluster.metadata.annotations?.[POWER_OPERATION] &&
      cluster.metadata.annotations[POWER_OPERATION] !== intent.operation
    )
      throw new Stale();
    if (
      revision === intent.revision &&
      cluster.metadata.annotations?.[POWER_OPERATION] === intent.operation &&
      cluster.metadata.annotations[HIBERNATION] === hibernation
    )
      return;
    await this.mutate(step, () =>
      step.k8s.patch("Cluster", `pgcf-db-${db.id}`, "database", [
        { op: "test", path: "/metadata/uid", value: uid(cluster) },
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: cluster.metadata.resourceVersion,
        },
        {
          op: "add",
          path: "/metadata/annotations",
          value: {
            ...cluster.metadata.annotations,
            [POWER_REVISION]: String(intent.revision),
            [POWER_OPERATION]: intent.operation,
            [HIBERNATION]: hibernation,
          },
        },
      ]),
    );
  }
  async suspend(db: DesiredDatabase): Promise<PowerObservation | null> {
    const intent = desiredPower(db)!;
    return this.step(async (step) => {
      let map: Resource | null = null,
        progress: Progress | undefined;
      try {
        const physical = await this.anchor(step, db);
        map = await this.fence(step, db);
        progress = map ? progressFrom(map, this.now) : undefined;
        if (progress) this.assertAnchor(physical.anchor, progress.anchor);
        if ((progress?.target.revision ?? 0) > intent.revision)
          throw new Stale();
        if (!progress || encoded(progress.target) !== encoded(intent)) {
          const alreadyOff =
            progress &&
            ["hibernating", "hibernated"].includes(progress.phase) &&
            physical.cluster.metadata.annotations?.[HIBERNATION] === "on" &&
            condition(physical.cluster, "cnpg.io/hibernation")?.status ===
              "True" &&
            condition(physical.cluster, "cnpg.io/hibernation")?.reason ===
              "Hibernated" &&
            (
              await step.k8s.list(
                "Pod",
                `pgcf-db-${db.id}`,
                "cnpg.io/cluster=database",
              )
            ).length === 0;
          progress = alreadyOff
            ? { ...progress!, target: intent, phase: "hibernated" }
            : {
                target: intent,
                phase: "quiescing",
                startedAt: this.now,
                anchor: physical.anchor,
              };
          map = await this.write(step, db, map, intent, progress);
          if (alreadyOff)
            await this.clusterIntent(step, db, intent, physical.cluster, "on");
        }
        if (!map) throw new Recovery("gateway_fence_missing");
        await this.bindFence(step, db, map);
        if (progress.phase === "refused")
          return this.observation(
            db,
            intent,
            "awake",
            progress.refusal ?? "unknown",
          );
        if (
          ["hibernating", "hibernated"].includes(progress.phase) &&
          physical.cluster.metadata.annotations?.[HIBERNATION] === "on"
        ) {
          const currentPods = await this.gateways(step),
            currentKey = await this.keyring(step);
          if (
            progress.phase === "hibernating" &&
            (encoded(currentPods) !== encoded(progress.gateways) ||
              currentKey.uid !== progress.keyUid ||
              currentKey.version !== progress.keyVersion)
          )
            return null;
          await this.controls(
            step,
            intent,
            currentPods,
            currentKey.keyring,
            "status",
          );
          const pods = await step.k8s.list(
            "Pod",
            `pgcf-db-${db.id}`,
            "cnpg.io/cluster=database",
          );
          if (
            condition(physical.cluster, "cnpg.io/hibernation")?.status !==
              "True" ||
            condition(physical.cluster, "cnpg.io/hibernation")?.reason !==
              "Hibernated" ||
            pods.length !== 0
          )
            return null;
          const confirmed = await this.anchor(step, db);
          this.assertAnchor(confirmed.anchor, progress.anchor);
          if (encoded(await this.gateways(step)) !== encoded(currentPods))
            return null;
          progress.phase = "hibernated";
          await this.write(step, db, map, undefined, progress);
          return this.observation(db, intent, "hibernated");
        }
        const pods = await this.gateways(step),
          key = await this.keyring(step);
        if (
          progress.gateways &&
          (encoded(pods) !== encoded(progress.gateways) ||
            key.uid !== progress.keyUid ||
            key.version !== progress.keyVersion)
        )
          throw new Unavailable("fence_continuity_lost");
        await this.controls(step, intent, pods, key.keyring, "begin");
        await this.controls(step, intent, pods, key.keyring, "close");
        if (progress.phase === "switching")
          throw new Unavailable("switch_result_unknown");
        if (!db.maintenance)
          throw new Unavailable("maintenance_capability_missing");
        const maintenance = owned(
          await step.k8s.read(
            "Secret",
            `pgcf-db-${db.id}`,
            "maintenance-credentials",
          ),
          "maintenance-credentials",
          db.id,
          `pgcf-db-${db.id}`,
        );
        if (
          decode(record(maintenance.data).username, 4096) !==
            MAINTENANCE_ROLE ||
          decode(record(maintenance.data).password, 8192) !==
            db.maintenance.password ||
          db.maintenance.role !== MAINTENANCE_ROLE
        )
          throw new Unavailable("maintenance_credentials_unacknowledged");
        const ca = owned(
          await step.k8s.read("ConfigMap", NS, `ca-${db.id}`),
          `ca-${db.id}`,
          db.id,
          NS,
        );
        const publicCa = string(record(ca.data)["ca.crt"]);
        if (!publicCa) throw new Unavailable("database_ca_missing");
        const verify = async () => {
          const active = await this.fence(step, db);
          if (
            !active ||
            uid(active) !== uid(map!) ||
            record(active.data)["intent.json"] !== encoded(intent)
          )
            throw new Stale();
          const latest = await this.anchor(step, db);
          this.assertAnchor(latest.anchor, progress!.anchor);
          const liveKey = await this.keyring(step);
          if (liveKey.uid !== key.uid || liveKey.version !== key.version)
            throw new Unavailable("keyring_continuity_lost");
          const inventory = await this.gateways(step);
          if (encoded(inventory) !== encoded(pods))
            throw new Unavailable("gateway_inventory_changed");
          return this.controls(step, intent, inventory, key.keyring, "status");
        };
        const options: SleepProbeOptions = {
          databaseId: db.id,
          namespace: `pgcf-db-${db.id}`,
          credentials: {
            user: MAINTENANCE_ROLE,
            password: db.maintenance.password,
          },
          ca: publicCa,
          signal: step.signal,
          deadline: Date.now() + 2000,
          quiescence: {
            operation: intent.operation,
            revision: intent.revision,
            gatewayPods: pods.map((pod) => pod.uid),
          },
          verifyQuiescence: verify,
          onClosedSegment: async (segment) => {
            progress = { ...progress!, phase: "archive", segment };
            const current = await this.fence(step, db);
            if (!current || uid(current) !== uid(map!)) throw new Stale();
            map = await this.write(step, db, current, undefined, progress);
          },
        };
        let safe: SleepSafetyResult;
        if (progress.segment)
          safe = await (this.options.resume ?? resumeSleepSafety)(
            options,
            progress.segment,
          );
        else {
          progress = {
            ...progress,
            phase: "switching",
            proofIntent: intent,
            gateways: pods,
            keyUid: key.uid,
            keyVersion: key.version,
          };
          map = await this.write(step, db, map, undefined, progress);
          safe = await (this.options.probe ?? probeSleepSafety)(options);
        }
        if (step.signal.aborted) return null;
        if (!safe.safe) {
          if (
            safe.reason === "archive_timeout" &&
            safe.segment &&
            progress.segment === safe.segment &&
            this.now - progress.startedAt < MAX_WAIT
          )
            return null;
          this.logSleepRefusal(progress.phase, safe.reason);
          const refusal = [
            "sql_busy",
            "prepared_work",
            "not_quiescent",
          ].includes(safe.reason)
            ? "busy"
            : safe.reason === "archive_timeout"
              ? "archive"
              : "unknown";
          progress.phase = "refused";
          progress.refusal = refusal;
          map = await this.write(step, db, map, undefined, progress);
          return this.observation(db, intent, "awake", refusal);
        }
        if (!progress.segment || progress.segment !== safe.segment)
          throw new Unavailable("closed_segment_not_persisted");
        await verify();
        progress.phase = "proved";
        map = await this.write(step, db, map, undefined, progress);
        const latest = await this.anchor(step, db);
        this.assertAnchor(latest.anchor, progress.anchor);
        progress.phase = "hibernating";
        map = await this.write(step, db, map, undefined, progress);
        await this.clusterIntent(step, db, intent, latest.cluster, "on");
        return null;
      } catch (error) {
        if (error instanceof Stale || step.signal.aborted) return null;
        if (error instanceof Recovery)
          return {
            id: db.id,
            generation: db.generation,
            state: "error",
            message: `${error.message}; recovery required`,
            archive: { continuous: false, ready_wal_files: null },
          };
        if (progress && ["hibernating", "hibernated"].includes(progress.phase))
          return null;
        if (
          error instanceof Unavailable &&
          [
            "gateway_ack_unavailable",
            "gateway_inventory_incomplete",
            "gateway_continuity_unknown",
            "gateway_private_address_unavailable",
          ].includes(error.message) &&
          progress?.phase === "quiescing" &&
          this.now - progress.startedAt < 30000
        )
          return null;
        this.logSleepRefusal(progress?.phase, undefined, error);
        if (progress && map) {
          progress.phase = "refused";
          progress.refusal = error instanceof Busy ? "busy" : "unknown";
          try {
            await this.write(step, db, map, undefined, progress);
          } catch {
            return null;
          }
        }
        return this.observation(
          db,
          intent,
          "awake",
          error instanceof Busy ? "busy" : "unknown",
        );
      }
    });
  }
  async prepareRunning(
    db: DesiredDatabase,
  ): Promise<PowerObservation | null | undefined> {
    const intent = desiredPower(db)!;
    return this.step(async (step) => {
      try {
        const map = await this.fence(step, db);
        if (
          !map &&
          db.creation?.ever_ready === false &&
          db.creation.generation === db.generation
        )
          return undefined;
        const physical = await this.anchor(step, db),
          previous = map ? progressFrom(map, this.now) : undefined;
        if (previous) this.assertAnchor(physical.anchor, previous.anchor);
        if ((previous?.target.revision ?? 0) > intent.revision)
          throw new Stale();
        const progress: Progress = {
          target: intent,
          phase: "wake",
          startedAt:
            previous?.target.revision === intent.revision
              ? previous.startedAt
              : this.now,
          anchor: physical.anchor,
        };
        if (map) await this.write(step, db, map, undefined, progress);
        await this.clusterIntent(step, db, intent, physical.cluster, "off");
        return undefined;
      } catch (error) {
        if (error instanceof Stale || step.signal.aborted) return null;
        return {
          id: db.id,
          generation: db.generation,
          state: "error",
          message: "wake identity unavailable; recovery required",
          archive: { continuous: false, ready_wal_files: null },
        };
      }
    });
  }
  /** A ready-only measurement marker uses CREATE history, never suspension authority. */
  async publishReadyFence(
    db: DesiredDatabase,
    observation: PowerObservation,
  ): Promise<PowerObservation | null> {
    if (
      observation.state !== "ready" ||
      db.desired_state !== "running" ||
      !db.creation
    )
      return observation;
    try {
      const intent = await this.step(async (step) => {
        const map = await this.fence(step, db);
        const current = map
          ? gatewayIntentSchema.parse(
              JSON.parse(String(record(map.data)["intent.json"])),
            )
          : undefined;
        if (current?.mode === "quiesce") return undefined;
        if (current?.revision === db.generation) return current;
        return gatewayIntentSchema.parse({
          database: db.id,
          operation: current?.operation ?? db.creation!.operation_id,
          revision: db.generation,
          mode: "running",
        });
      });
      if (!intent) return null;
      return await this.finishRunning(db, observation, intent);
    } catch (error) {
      return error instanceof Recovery
        ? {
            ...observation,
            state: "error",
            message: "running fence identity unavailable; recovery required",
          }
        : null;
    }
  }
  async finishRunning(
    db: DesiredDatabase,
    observation: PowerObservation,
    executionIntent?: GatewayIntent,
  ): Promise<PowerObservation | null> {
    const intent = executionIntent ?? desiredPower(db)!;
    if (observation.state !== "ready") return observation;
    return this.step(async (step) => {
      try {
        const physical = await this.anchor(step, db);
        let map = await this.fence(step, db);
        const prior = map ? progressFrom(map, this.now) : undefined;
        if (prior) this.assertAnchor(physical.anchor, prior.anchor);
        if (physical.cluster.metadata.annotations?.[HIBERNATION] === "on")
          return null;
        const progress: Progress = {
          target: intent,
          phase: "awake",
          startedAt: this.now,
          anchor: physical.anchor,
        };
        map = await this.write(step, db, map, intent, progress);
        await this.bindFence(step, db, map);
        const pods = await this.gateways(step),
          key = await this.keyring(step);
        await this.controls(step, intent, pods, key.keyring, "release");
        if (encoded(await this.gateways(step)) !== encoded(pods)) return null;
        const current = await this.fence(step, db);
        if (
          !current ||
          uid(current) !== uid(map) ||
          record(current.data)["intent.json"] !== encoded(intent)
        )
          return null;
        return db.power
          ? {
              ...observation,
              power: {
                operation: intent.operation,
                revision: intent.revision,
                state: "awake",
              },
            }
          : observation;
      } catch (error) {
        if (error instanceof Recovery)
          return {
            ...observation,
            state: "error",
            message: "wake storage identity changed; recovery required",
          };
        return null;
      }
    });
  }
}
