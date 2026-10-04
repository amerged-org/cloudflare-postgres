// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";
import {
  newOperationId,
  DesiredDatabase,
  ARCHIVE_DESTINATION_PATTERN,
} from "@pgcf/contracts";
import {
  GATEWAY_RETIRE_HOLD_MS,
  GATEWAY_FENCE_NAMESPACE,
  GATEWAY_FENCE_LABEL,
  GATEWAY_CONTROL_HEADER,
  GATEWAY_CONTROL_PATH_PREFIX,
  gatewayFenceName,
  gatewayIntentSchema,
  gatewayControlReportSchema,
  gatewayPodUidSchema,
  signGatewayControl,
  type GatewayIntent,
} from "@pgcf/contracts/gateway-control";
import type { RouteKeyring } from "@pgcf/contracts/route-token";
import {
  record,
  uid,
  type Kubernetes,
  type Resource,
} from "./types.ts";

const RECEIPT = "gateway-retirement.json",
  LABEL = "pgcf.io/database-id",
  GENERATION = "pgcf.io/generation",
  UID_BINDING = "pgcf.io/gateway-fence-uid";
export interface RetirementGatewayPod {
  name: string;
  uid: string;
  ip: string;
  restarts: number;
}
export interface RetirementSnapshot {
  pods: RetirementGatewayPod[];
  keyring: RouteKeyring;
  keyUid: string;
  keyVersion: string;
}
export interface RetirementOptions {
  k8s: Kubernetes;
  signal: AbortSignal;
  snapshot(signal: AbortSignal): Promise<RetirementSnapshot>;
  now?: () => number;
  fetcher?: typeof fetch;
}
interface Receipt {
  markerUid: string;
  intent: GatewayIntent;
  publishedAt: string;
  observedAt: string;
  phase: "published" | "deleting";
  markerVersion?: string;
}
function fail(): never {
  throw new Error("gateway_retirement_recovery_required");
}
function required(value: unknown, max = 253): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    fail();
  return value;
}
function owned(
  value: Resource | null,
  name: string,
  database: string,
  deleting = false,
): Resource {
  if (
    !value ||
    value.kind !== "ConfigMap" ||
    value.metadata.namespace !== GATEWAY_FENCE_NAMESPACE ||
    value.metadata.name !== name ||
    value.metadata.labels?.[LABEL] !== database ||
    (value.metadata.deletionTimestamp && !deleting)
  )
    fail();
  gatewayPodUidSchema.parse(value.metadata.uid);
  required(value.metadata.resourceVersion, 128);
  return value;
}
function intentFrom(map: Resource, database: string): GatewayIntent {
  if (map.metadata.labels?.[GATEWAY_FENCE_LABEL] !== "true") fail();
  const intent = gatewayIntentSchema.parse(
    JSON.parse(required(record(map.data)["intent.json"], 1024)),
  );
  if (intent.database !== database) fail();
  return intent;
}
function timestamp(value: unknown, now: number): string {
  const text = required(value, 24),
    parsed = Date.parse(text);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== text ||
    parsed > now
  )
    fail();
  return text;
}
function receiptFrom(
  ledger: Resource,
  db: DesiredDatabase,
  now: number,
): Receipt | undefined {
  const text = record(ledger.data)[RECEIPT];
  if (text === undefined) return undefined;
  const raw = record(JSON.parse(required(text, 4096))),
    intent = gatewayIntentSchema.parse(raw.intent);
  gatewayPodUidSchema.parse(raw.markerUid);
  if (
    intent.database !== db.id ||
    intent.revision !== db.generation ||
    intent.mode !== "retired" ||
    !["published", "deleting"].includes(String(raw.phase))
  )
    fail();
  const publishedAt = timestamp(raw.publishedAt, now),
    observedAt = timestamp(raw.observedAt, now);
  if (observedAt < publishedAt) fail();
  if (raw.phase === "deleting") required(raw.markerVersion, 128);
  return {
    markerUid: raw.markerUid as string,
    intent,
    publishedAt,
    observedAt,
    phase: raw.phase as Receipt["phase"],
    ...(raw.markerVersion === undefined
      ? {}
      : { markerVersion: raw.markerVersion as string }),
  };
}
function privateAddress(value: unknown): string {
  const ip = required(value, 64);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (
      a === 10 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168)
    )
      return ip;
  }
  if (isIP(ip) === 6 && /^(fc|fd)/i.test(ip)) return ip;
  fail();
}
function snapshotIdentity(value: RetirementSnapshot): string {
  if (
    !Array.isArray(value.pods) ||
    value.pods.length < 1 ||
    value.pods.length > 64
  )
    fail();
  required(value.keyUid);
  required(value.keyVersion, 128);
  const ids = new Set<string>();
  const pods = value.pods
    .map((pod) => {
      gatewayPodUidSchema.parse(pod.uid);
      required(pod.name);
      privateAddress(pod.ip);
      if (
        ids.has(pod.uid) ||
        !Number.isSafeInteger(pod.restarts) ||
        pod.restarts < 0
      )
        fail();
      ids.add(pod.uid);
      return pod;
    })
    .sort((a, b) => a.uid.localeCompare(b.uid));
  return JSON.stringify({
    pods,
    keyUid: value.keyUid,
    keyVersion: value.keyVersion,
  });
}
async function reclaimed(
  k8s: Kubernetes,
  db: DesiredDatabase,
  ledger: Resource,
): Promise<void> {
  if (Number(ledger.metadata.annotations?.[GENERATION]) !== db.generation)
    fail();
  const state = record(JSON.parse(required(record(ledger.data).state, 32768)));
  if (
    typeof state.completed !== "boolean" ||
    !Array.isArray(state.volumes) ||
    !Number.isSafeInteger(state.startedAt) ||
    (state.startedAt as number) < 0 ||
    (state.startedAt as number) > Date.now() ||
    !(
      state.namespaceUid === null ||
      (typeof state.namespaceUid === "string" &&
        gatewayPodUidSchema.safeParse(state.namespaceUid).success)
    )
  )
    fail();
  const namespace = `pgcf-db-${db.id}`;
  const [ns, pvs, lvs] = await Promise.all([
    k8s.read("Namespace", undefined, namespace),
    k8s.list("PersistentVolume"),
    k8s.list("LVMVolume"),
  ]);
  if (ns) fail();
  // A finalized Namespace has no remaining namespaced objects, including its PVCs.
  const volumes = state.volumes.map((value) => record(value));
  for (const volume of volumes) {
    required(volume.name);
    required(volume.uid);
    required(volume.claimUid);
    required(volume.handle);
  }
  if (
    pvs.some(
      (pv) =>
        record(record(pv.spec).claimRef).namespace === namespace ||
        volumes.some(
          (volume) =>
            volume.name === pv.metadata.name ||
            volume.uid === pv.metadata.uid ||
            volume.handle === record(record(pv.spec).csi).volumeHandle,
        ),
    ) ||
    lvs.some(
      (lv) =>
        lv.metadata.labels?.[LABEL] === db.id ||
        volumes.some(
          (volume) =>
            volume.handle === lv.metadata.name ||
            record(volume.lvm).uid === lv.metadata.uid,
        ),
    )
  )
    fail();
}
async function saveReceipt(
  k8s: Kubernetes,
  ledger: Resource,
  receipt: Receipt,
): Promise<void> {
  await k8s.patch("ConfigMap", GATEWAY_FENCE_NAMESPACE, ledger.metadata.name, [
    { op: "test", path: "/metadata/uid", value: uid(ledger) },
    {
      op: "test",
      path: "/metadata/resourceVersion",
      value: ledger.metadata.resourceVersion,
    },
    { op: "test", path: "/data", value: ledger.data },
    {
      op: "add",
      path: "/data",
      value: { ...record(ledger.data), [RECEIPT]: JSON.stringify(receipt) },
    },
  ]);
}
async function acknowledgement(
  options: RetirementOptions,
  snapshot: RetirementSnapshot,
  intent: GatewayIntent,
  region: string,
  signal: AbortSignal,
): Promise<void> {
  const reports = await Promise.allSettled(
    snapshot.pods.map(async (pod) => {
      signal.throwIfAborted();
      const token = await signGatewayControl({
        keyring: snapshot.keyring,
        region,
        database: intent.database,
        operation: intent.operation,
        revision: intent.revision,
        pod: pod.uid,
        action: "retire",
      });
      const ip = privateAddress(pod.ip),
        host = isIP(ip) === 6 ? `[${ip}]` : ip;
      const response = await (options.fetcher ?? fetch)(
        `http://${host}:8080${GATEWAY_CONTROL_PATH_PREFIX}retire`,
        {
          method: "POST",
          headers: { [GATEWAY_CONTROL_HEADER]: token },
          redirect: "error",
          signal,
        },
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        fail();
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 4096) fail();
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
        report.mode !== "retired" ||
        report.status !== "retired" ||
        report.connections !== 0 ||
        report.busyConnections !== 0 ||
        report.pendingDials !== 0
      )
        fail();
    }),
  );
  if (reports.some((report) => report.status === "rejected")) fail();
}

/** A terminal deleted desired revision and fully reclaimed physical storage are prerequisites. */
async function runRetirement(
  input: DesiredDatabase,
  options: RetirementOptions,
): Promise<boolean> {
  const clock = options.now ?? Date.now;
  const db = DesiredDatabase.parse(input),
    now = clock();
  if (db.desired_state !== "deleted" || !Number.isSafeInteger(now) || now < 0)
    fail();
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  const k8s = options.k8s,
    name = gatewayFenceName(db.id),
    ledgerName = `delete-${db.id}`;
  let ledger = owned(
    await k8s.read("ConfigMap", GATEWAY_FENCE_NAMESPACE, ledgerName),
    ledgerName,
    db.id,
  );
  await reclaimed(k8s, db, ledger);
  let receipt = receiptFrom(ledger, db, clock());
  let map = await k8s.read("ConfigMap", GATEWAY_FENCE_NAMESPACE, name);
  const storage = await k8s.read(
    "ConfigMap",
    GATEWAY_FENCE_NAMESPACE,
    `storage-${db.id}`,
  );
  const bound = storage?.metadata.annotations?.[UID_BINDING];
  if (storage) owned(storage, `storage-${db.id}`, db.id);
  if (!map) {
    if (
      receipt?.phase === "deleting" &&
      clock() - Date.parse(receipt.observedAt) >= GATEWAY_RETIRE_HOLD_MS
    )
      return true;
    if (receipt) fail();
    if (
      !bound &&
      record(JSON.parse(required(record(ledger.data).state, 32768)))
        .completed === true
    )
      return true;
    if (!bound && db.creation?.ever_ready === false) return true;
    fail();
  }
  map = owned(map, name, db.id, Boolean(map.metadata.deletionTimestamp));
  if (
    (bound && bound !== uid(map)) ||
    (receipt && receipt.markerUid !== uid(map))
  )
    fail();
  if (map.metadata.deletionTimestamp) {
    if (
      receipt?.phase !== "deleting" ||
      receipt.markerUid !== uid(map) ||
      JSON.stringify(intentFrom(map, db.id)) !==
        JSON.stringify(receipt.intent) ||
      record(map.data)["retired-at"] !== receipt.publishedAt
    )
      fail();
    return false;
  }
  if (
    receipt?.phase === "deleting" &&
    map.metadata.resourceVersion !== receipt.markerVersion
  )
    fail();
  let intent = intentFrom(map, db.id);
  if (intent.revision > db.generation) fail();
  if (intent.mode !== "retired") {
    if (receipt || intent.revision >= db.generation) fail();
    const terminal: GatewayIntent = {
      database: db.id,
      operation: newOperationId(),
      revision: db.generation,
      mode: "retired",
    };
    signal.throwIfAborted();
    const publishedAt = new Date(clock()).toISOString();
    await k8s.patch("ConfigMap", GATEWAY_FENCE_NAMESPACE, name, [
      { op: "test", path: "/metadata/uid", value: uid(map) },
      {
        op: "test",
        path: "/metadata/resourceVersion",
        value: map.metadata.resourceVersion,
      },
      { op: "test", path: "/data", value: map.data },
      {
        op: "add",
        path: "/data",
        value: {
          ...record(map.data),
          "intent.json": JSON.stringify(terminal),
          "retired-at": publishedAt,
        },
      },
    ]);
    const current = owned(
      await k8s.read("ConfigMap", GATEWAY_FENCE_NAMESPACE, name),
      name,
      db.id,
    );
    if (
      uid(current) !== uid(map) ||
      JSON.stringify(intentFrom(current, db.id)) !== JSON.stringify(terminal) ||
      record(current.data)["retired-at"] !== publishedAt
    )
      fail();
    map = current;
    intent = terminal;
    receipt = {
      markerUid: uid(map),
      intent,
      publishedAt,
      observedAt: new Date(clock()).toISOString(),
      phase: "published",
    };
  } else {
    if (intent.revision !== db.generation) fail();
    const publishedAt = timestamp(record(map.data)["retired-at"], clock());
    if (
      receipt &&
      (receipt.publishedAt !== publishedAt ||
        JSON.stringify(receipt.intent) !== JSON.stringify(intent))
    )
      fail();
    receipt ??= {
      markerUid: uid(map),
      intent,
      publishedAt,
      observedAt: new Date(clock()).toISOString(),
      phase: "published",
    };
  }
  if (!record(ledger.data)[RECEIPT]) {
    signal.throwIfAborted();
    await saveReceipt(k8s, ledger, receipt);
    ledger = owned(
      await k8s.read("ConfigMap", GATEWAY_FENCE_NAMESPACE, ledgerName),
      ledgerName,
      db.id,
    );
    if (
      JSON.stringify(receiptFrom(ledger, db, clock())) !==
      JSON.stringify(receipt)
    )
      fail();
  }
  if (clock() - Date.parse(receipt.observedAt) < GATEWAY_RETIRE_HOLD_MS)
    return false;
  const snapshot = await options.snapshot(signal),
    identity = snapshotIdentity(snapshot);
  const region = ARCHIVE_DESTINATION_PATTERN.exec(
    db.archive.destination_path,
  )?.[2];
  if (!region) fail();
  await acknowledgement(
    options,
    snapshot,
    intent,
    region,
    AbortSignal.any([signal, AbortSignal.timeout(3000)]),
  );
  await reclaimed(k8s, db, ledger);
  if (snapshotIdentity(await options.snapshot(signal)) !== identity) fail();
  const current = owned(
    await k8s.read("ConfigMap", GATEWAY_FENCE_NAMESPACE, name),
    name,
    db.id,
  );
  if (
    uid(current) !== uid(map) ||
    current.metadata.resourceVersion !== map.metadata.resourceVersion ||
    JSON.stringify(current.data) !== JSON.stringify(map.data)
  )
    fail();
  ledger = owned(
    await k8s.read("ConfigMap", GATEWAY_FENCE_NAMESPACE, ledgerName),
    ledgerName,
    db.id,
  );
  const pending: Receipt = {
    ...receipt,
    phase: "deleting",
    markerVersion: required(current.metadata.resourceVersion, 128),
  };
  signal.throwIfAborted();
  await saveReceipt(k8s, ledger, pending);
  signal.throwIfAborted();
  await k8s.delete(
    "ConfigMap",
    GATEWAY_FENCE_NAMESPACE,
    name,
    uid(current),
    pending.markerVersion,
  );
  const remaining = await k8s.read("ConfigMap", GATEWAY_FENCE_NAMESPACE, name);
  if (!remaining) return true;
  owned(remaining, name, db.id, true);
  if (
    remaining.metadata.deletionTimestamp &&
    uid(remaining) === uid(current) &&
    JSON.stringify(intentFrom(remaining, db.id)) === JSON.stringify(intent) &&
    record(remaining.data)["retired-at"] === receipt.publishedAt
  )
    return false;
  fail();
}

export async function retireGatewayFence(
  input: DesiredDatabase,
  options: RetirementOptions,
): Promise<boolean> {
  try {
    return await runRetirement(input, options);
  } catch {
    throw new Error("gateway_retirement_recovery_required");
  }
}
