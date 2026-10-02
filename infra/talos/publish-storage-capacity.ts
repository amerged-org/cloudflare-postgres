// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const annotation = "pgcf.io/storage-gib-total";
const maxAgeMs = 300_000;
const uidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const nodePattern = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

type JsonObject = Record<string, unknown>;
type Patch = { op: "test" | "add"; path: string; value: unknown }[];
export interface NodeBinding {
  node_uid: string;
  lvmnode_uid: string;
  lvmnode_resource_version: string;
  vg_uuid: string;
}
export interface PublisherConfig {
  clusterUid: string;
  storageNamespaceUid: string;
  context: string;
  proofNotBefore: number;
  proofCompletedAt: number;
  bindings: Readonly<Record<string, NodeBinding>>;
}
export interface ClusterClient {
  get(path: string, context: string): Promise<unknown>;
  patchNode(name: string, patch: Patch, context: string): Promise<unknown>;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_cluster_object");
  return value as JsonObject;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new Error("invalid_cluster_field");
  return value;
}
function timestamp(value: unknown): number {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(raw))
    throw new Error("invalid_proof_timestamp");
  const parsed = Date.parse(raw);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !== raw.slice(0, 19)
  )
    throw new Error("invalid_proof_timestamp");
  return parsed;
}

// Quantities from the pinned CSI API describe bytes, not configured partitions.
export function parseQuantityBytes(value: unknown): number {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || raw.length > 64)
    throw new Error("invalid_vg_quantity");
  const match =
    /^\+?([0-9]+(?:\.[0-9]*)?|\.[0-9]+)([KMGTPE]i|[numkMGTPE]|[eE][+-]?[0-9]+)?$/.exec(
      raw,
    );
  if (!match) throw new Error("invalid_vg_quantity");
  const [whole = "", fraction = ""] = match[1]!.split(".");
  let numerator = BigInt((whole || "0") + fraction);
  let denominator = 10n ** BigInt(fraction.length);
  const suffix = match[2] ?? "";
  if (suffix.endsWith("i")) {
    numerator *= 1024n ** BigInt("KMGTPE".indexOf(suffix[0]!) + 1);
  } else {
    const exponent =
      suffix.length > 1 && /^[eE]/.test(suffix)
        ? Number(suffix.slice(1))
        : ((
            {
              n: -9,
              u: -6,
              m: -3,
              k: 3,
              M: 6,
              G: 9,
              T: 12,
              P: 15,
              E: 18,
            } as Record<string, number>
          )[suffix] ?? 0);
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 18)
      throw new Error("invalid_vg_quantity");
    if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
    else denominator *= 10n ** BigInt(-exponent);
  }
  if (
    numerator % denominator !== 0n ||
    numerator / denominator > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("invalid_vg_quantity");
  return Number(numerator / denominator);
}

function configFromEnvironment(
  env: NodeJS.ProcessEnv,
  now: number,
): PublisherConfig {
  const clusterUid = text(env.PGCF_STORAGE_EXPECTED_CLUSTER_UID);
  const storageNamespaceUid = text(env.PGCF_STORAGE_EXPECTED_NAMESPACE_UID);
  const context = text(env.PGCF_STORAGE_KUBE_CONTEXT);
  const proofNotBefore = timestamp(env.PGCF_STORAGE_PROOF_NOT_BEFORE);
  const proofCompletedAt = timestamp(env.PGCF_STORAGE_PROOF_COMPLETED_AT);
  if (
    !uidPattern.test(clusterUid) ||
    !uidPattern.test(storageNamespaceUid) ||
    /[\r\n\0]/.test(context)
  )
    throw new Error("invalid_expected_identity");
  validateProofWindow(proofNotBefore, proofCompletedAt, now);
  const raw = env.PGCF_STORAGE_BINDINGS_JSON;
  if (!raw || raw.length > 65_536) throw new Error("missing_storage_bindings");
  let parsed: JsonObject;
  try {
    parsed = object(JSON.parse(raw));
  } catch {
    throw new Error("invalid_storage_bindings");
  }
  const names = Object.keys(parsed);
  if (names.length === 0 || names.length > 64)
    throw new Error("invalid_storage_bindings");
  const bindings: Record<string, NodeBinding> = Object.create(null);
  for (const name of names) {
    if (!nodePattern.test(name)) throw new Error("invalid_storage_node_name");
    const candidate = object(parsed[name]);
    const node_uid = text(candidate.node_uid);
    const lvmnode_uid = text(candidate.lvmnode_uid);
    const lvmnode_resource_version = text(candidate.lvmnode_resource_version);
    const vg_uuid = text(candidate.vg_uuid);
    if (
      !uidPattern.test(node_uid) ||
      !uidPattern.test(lvmnode_uid) ||
      !/^[A-Za-z0-9-]{1,128}$/.test(vg_uuid)
    )
      throw new Error("invalid_expected_identity");
    bindings[name] = Object.freeze({
      node_uid,
      lvmnode_uid,
      lvmnode_resource_version,
      vg_uuid,
    });
  }
  return Object.freeze({
    clusterUid,
    storageNamespaceUid,
    context,
    proofNotBefore,
    proofCompletedAt,
    bindings: Object.freeze(bindings),
  });
}
function validateProofWindow(start: number, end: number, now: number): void {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    end > now ||
    end - start > maxAgeMs ||
    now - start > maxAgeMs
  )
    throw new Error("stale_storage_proof");
}

export function capacityPlan(
  config: PublisherConfig,
  name: string,
  nodeValue: unknown,
  lvmValue: unknown,
  now: number,
): { storageGiB: number; freeBytes: number; patch: Patch } {
  validateProofWindow(config.proofNotBefore, config.proofCompletedAt, now);
  const expected = config.bindings[name];
  if (!expected || !nodePattern.test(name))
    throw new Error("unapproved_storage_node");
  const node = object(nodeValue);
  const nodeMetadata = object(node.metadata);
  if (
    node.apiVersion !== "v1" ||
    node.kind !== "Node" ||
    nodeMetadata.name !== name ||
    nodeMetadata.uid !== expected.node_uid ||
    nodeMetadata.deletionTimestamp
  )
    throw new Error("foreign_node");
  const nodeVersion = text(nodeMetadata.resourceVersion);
  const lvm = object(lvmValue);
  const metadata = object(lvm.metadata);
  if (
    lvm.apiVersion !== "local.openebs.io/v1alpha1" ||
    lvm.kind !== "LVMNode" ||
    metadata.namespace !== "openebs" ||
    metadata.name !== name ||
    metadata.uid !== expected.lvmnode_uid ||
    metadata.deletionTimestamp
  )
    throw new Error("foreign_lvmnode");
  if (text(metadata.resourceVersion) !== expected.lvmnode_resource_version)
    throw new Error("unexpected_lvmnode_revision");
  const owners = metadata.ownerReferences;
  if (!Array.isArray(owners) || owners.length !== 1)
    throw new Error("foreign_lvmnode_owner");
  const owner = object(owners[0]);
  if (
    owner.apiVersion !== "v1" ||
    owner.kind !== "Node" ||
    owner.name !== name ||
    owner.uid !== expected.node_uid ||
    owner.controller !== true
  )
    throw new Error("foreign_lvmnode_owner");
  const sampleTimes: number[] = [];
  if (metadata.creationTimestamp !== undefined)
    sampleTimes.push(timestamp(metadata.creationTimestamp));
  if (Array.isArray(metadata.managedFields)) {
    for (const value of metadata.managedFields) {
      const field = object(value);
      if (
        field.time !== undefined &&
        field.fieldsV1 &&
        Object.hasOwn(object(field.fieldsV1), "f:volumeGroups")
      )
        sampleTimes.push(timestamp(field.time));
    }
  }
  if (
    !sampleTimes.some(
      (time) =>
        time >= config.proofNotBefore &&
        time <= config.proofCompletedAt &&
        now - time <= maxAgeMs,
    )
  )
    throw new Error("stale_vg_measurement");
  if (!Array.isArray(lvm.volumeGroups))
    throw new Error("missing_vg_measurement");
  const groups = lvm.volumeGroups
    .map(object)
    .filter((group) => group.name === "pgcf");
  if (groups.length !== 1) throw new Error("missing_vg_measurement");
  const group = groups[0]!;
  if (
    group.uuid !== expected.vg_uuid ||
    group.permissions !== 0 ||
    group.missingPvCount !== 0 ||
    (group.thinPools !== undefined &&
      (!Array.isArray(group.thinPools) || group.thinPools.length !== 0))
  )
    throw new Error("invalid_dedicated_vg");
  const totalBytes = parseQuantityBytes(group.size);
  const freeBytes = parseQuantityBytes(group.free);
  const storageGiB = Math.floor(totalBytes / 2 ** 30);
  if (storageGiB < 1 || freeBytes > totalBytes)
    throw new Error("invalid_vg_capacity");
  const patch: Patch = [
    { op: "test", path: "/metadata/uid", value: expected.node_uid },
    { op: "test", path: "/metadata/resourceVersion", value: nodeVersion },
  ];
  if (nodeMetadata.annotations === undefined) {
    patch.push({
      op: "add",
      path: "/metadata/annotations",
      value: { [annotation]: String(storageGiB) },
    });
  } else {
    object(nodeMetadata.annotations);
    patch.push({
      op: "add",
      path: "/metadata/annotations/pgcf.io~1storage-gib-total",
      value: String(storageGiB),
    });
  }
  return { storageGiB, freeBytes, patch };
}

class KubectlClient implements ClusterClient {
  private command(
    args: string[],
    context: string,
    input?: string,
  ): Promise<unknown> {
    return new Promise((accept, reject) => {
      const child = spawn(
        "kubectl",
        ["--context", context, "--request-timeout=15s", ...args],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let output = "";
      let failed = false;
      const kill = () => {
        failed = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(kill, 20_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (output.length + chunk.length > 4_194_304) kill();
        else output += chunk.toString("utf8");
      });
      child.stderr.resume();
      child.stdin.on("error", () => {
        failed = true;
      });
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("kubectl_unavailable"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failed || code !== 0) {
          reject(new Error("kubectl_request_failed"));
          return;
        }
        try {
          accept(JSON.parse(output));
        } catch {
          reject(new Error("invalid_kubectl_response"));
        }
      });
      child.stdin.end(input);
    });
  }
  get(path: string, context: string): Promise<unknown> {
    return this.command(["get", "--raw", path], context);
  }
  patchNode(name: string, patch: Patch, context: string): Promise<unknown> {
    return this.command(
      [
        "patch",
        "node",
        name,
        "--type=json",
        "--patch-file=/dev/stdin",
        "--output=json",
      ],
      context,
      JSON.stringify(patch),
    );
  }
}

async function assertCluster(
  config: PublisherConfig,
  client: ClusterClient,
): Promise<void> {
  const cluster = object(
    await client.get("/api/v1/namespaces/kube-system", config.context),
  );
  if (
    object(cluster.metadata).uid !== config.clusterUid ||
    object(cluster.metadata).deletionTimestamp
  )
    throw new Error("foreign_cluster");
  const namespace = object(
    await client.get("/api/v1/namespaces/openebs", config.context),
  );
  if (
    object(namespace.metadata).uid !== config.storageNamespaceUid ||
    object(namespace.metadata).deletionTimestamp
  )
    throw new Error("foreign_storage_namespace");
}

export async function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  client: ClusterClient = new KubectlClient(),
  now: () => number = Date.now,
): Promise<{
  status: "usage" | "planned" | "published";
  nodes?: number;
  storage_gib_total?: number[];
}> {
  if (args.length === 0) return { status: "usage" };
  if (args.length !== 1 || !["--plan", "--apply"].includes(args[0]!))
    throw new Error("usage_requires_plan_or_apply");
  const config = configFromEnvironment(env, now());
  const deadline = now() + 180_000;
  const checkDeadline = () => {
    if (now() >= deadline) throw new Error("storage_publish_deadline");
  };
  await assertCluster(config, client);
  const totals: number[] = [];
  for (const name of Object.keys(config.bindings)) {
    checkDeadline();
    const path = `/apis/local.openebs.io/v1alpha1/namespaces/openebs/lvmnodes/${name}`;
    const node = await client.get(`/api/v1/nodes/${name}`, config.context);
    let lvm = await client.get(path, config.context);
    let plan: ReturnType<typeof capacityPlan>;
    const freshDeadline = Math.min(deadline, now() + 30_000);
    for (;;) {
      try {
        plan = capacityPlan(config, name, node, lvm, now());
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !["unexpected_lvmnode_revision", "stale_vg_measurement"].includes(
            error.message,
          ) ||
          now() >= freshDeadline
        )
          throw error;
        await delay(1000);
        checkDeadline();
        lvm = await client.get(path, config.context);
      }
    }
    if (args[0] === "--apply") {
      checkDeadline();
      await assertCluster(config, client);
      const latest = await client.get(path, config.context);
      plan = capacityPlan(config, name, node, latest, now());
      checkDeadline();
      const updated = object(
        await client.patchNode(name, plan.patch, config.context),
      );
      const metadata = object(updated.metadata);
      if (
        metadata.uid !== config.bindings[name]!.node_uid ||
        object(metadata.annotations)[annotation] !== String(plan.storageGiB)
      )
        throw new Error("storage_publish_readback_failed");
    }
    totals.push(plan.storageGiB);
  }
  return {
    status: args[0] === "--apply" ? "published" : "planned",
    nodes: totals.length,
    storage_gib_total: totals,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await run(process.argv.slice(2), process.env);
    if (result.status === "usage")
      console.log(
        "Usage: node infra/talos/publish-storage-capacity.ts --plan|--apply; no option makes no network call. See infra/platform/README.md for required runtime inputs.",
      );
    else console.log(JSON.stringify(result));
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message
        : "storage_publish_failed";
    console.error(JSON.stringify({ status: "refused", error: code }));
    process.exitCode = 1;
  }
}
