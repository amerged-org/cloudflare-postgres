// SPDX-License-Identifier: Apache-2.0
import {
  bytesToHex,
  base64urlToBytes,
  OperationId,
  NodeId,
  RegionId,
} from "@pgcf/contracts";
import {
  NodeAdditionRequest,
  NodeRegionPolicy,
  ProviderInstanceId,
  CostedNodeApproval,
  NodeMarkLost,
} from "@pgcf/contracts/nodes";
import { importBootstrapVerificationKeys } from "@pgcf/contracts/bootstrap-relay";
import { z } from "zod";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { page } from "./pagination.ts";
import {
  approveNodePurchase,
  cancelUnattemptedNodeAddition,
  configureNodeRegionPolicy,
  readNodeAddition,
  reserveNodeAddition,
  verifyNodeCapacity,
  verifyNodeNetwork,
  markNodeLost,
} from "../domain/node-state.ts";
import {
  bootstrapJobInput,
  bootstrapJobStatus,
  configureBootstrapJob,
  NodeBootstrapConfiguration,
  readBootstrapJob,
} from "../domain/bootstrap-jobs.ts";
import { contaboClient } from "../domain/bootstrap-relay.ts";
import { runNodeCapacity } from "../domain/node-capacity.ts";
import {
  loadRegionJoinBundle,
  joinBundleReference,
} from "../crypto/bootstrap-credentials.ts";

export const NodeCapacityPolicy = NodeRegionPolicy.safeExtend({
  autoscale_enabled: z.boolean().default(false),
  adopt_instance_ids: z.array(ProviderInstanceId).max(100).default([]),
});
export const NodePurchaseApproval = z.strictObject({
  expected_revision: z.number().int().positive(),
  approval: CostedNodeApproval,
});
export const NodeRevision = z.strictObject({
  expected_revision: z.number().int().positive(),
});
export const NodeVerificationRequest = z.strictObject({
  expected_revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function startAddNode(
  env: Env,
  operationId: string,
): Promise<void> {
  OperationId.parse(operationId);
  try {
    await env.ADD_NODE.create({
      id: operationId,
      params: { operation_id: operationId },
    });
  } catch {
    const instance = await env.ADD_NODE.get(operationId);
    const status = await instance.status();
    if (
      status.status === "errored" ||
      status.status === "terminated" ||
      status.status === "complete"
    )
      await instance.restart();
  }
}
export async function requestNodeAddition(
  c: ApiContext,
  raw: NodeAdditionRequest,
): Promise<Response> {
  await requireScope(c, "admin");
  const body = NodeAdditionRequest.parse(raw);
  const key = c.req.header("Idempotency-Key");
  if (!key)
    throw new ApiError(
      "invalid_request",
      "Node additions require an Idempotency-Key",
    );
  return withIdempotency(c, {
    replay: async (id) => nodeAdditionResponse(c, id),
    execute: async (lease) => {
      const addition = await reserveNodeAddition(c.env.DB, {
        request_key: key,
        request: body,
      });
      await lease
        .completeStatement(addition.intent.operation_id, 202, {
          sql: "EXISTS(SELECT 1 FROM node_additions WHERE operation_id=?)",
          bindings: [addition.intent.operation_id],
        })
        .run();
      c.executionCtx.waitUntil(
        startAddNode(c.env, addition.intent.operation_id),
      );
      return nodeAdditionResponse(c, addition.intent.operation_id);
    },
  });
}
export async function nodeAdditionResponse(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  c.header("Location", `/v1/nodes/additions/${id}`);
  return c.json(await readNodeAddition(c.env.DB, id), 202);
}
export async function getNodeAddition(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(await readNodeAddition(c.env.DB, id));
}
export async function markLostNode(
  c: ApiContext,
  id: string,
  raw: NodeMarkLost,
): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(await markNodeLost(c.env.DB, id, raw));
}
export async function listNodeAdditions(c: ApiContext): Promise<Response> {
  await requireScope(c, "admin");
  const pagination = page(c),
    cursor = pagination.where("created_at", "operation_id");
  const result = await c.env.DB.prepare(
    `SELECT operation_id id,created_at FROM node_additions WHERE ${cursor.sql} ORDER BY created_at DESC,operation_id DESC LIMIT ?`,
  )
    .bind(...cursor.bindings, pagination.limit + 1)
    .all<{ id: string; created_at: string }>();
  const additions = await Promise.all(
    result.results.map((row) => readNodeAddition(c.env.DB, row.id)),
  );
  const envelope = pagination.envelope(result.results);
  return c.json({
    data: additions.slice(0, pagination.limit),
    next_cursor: envelope.next_cursor,
  });
}
export async function approvePurchase(
  c: ApiContext,
  id: string,
  raw: z.infer<typeof NodePurchaseApproval>,
): Promise<Response> {
  await requireScope(c, "admin");
  const body = NodePurchaseApproval.parse(raw);
  const addition = await approveNodePurchase(
    c.env.DB,
    id,
    body.expected_revision,
    body.approval,
  );
  c.executionCtx.waitUntil(startAddNode(c.env, id));
  return c.json(addition, 202);
}
export async function cancelNodeAddition(
  c: ApiContext,
  id: string,
  raw: z.infer<typeof NodeRevision>,
): Promise<Response> {
  await requireScope(c, "admin");
  const body = NodeRevision.parse(raw);
  return c.json(
    await cancelUnattemptedNodeAddition(c.env.DB, id, body.expected_revision),
  );
}
export async function getCapacityPolicy(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  RegionId.parse(id);
  const row = await c.env.DB.prepare(
    "SELECT * FROM node_region_policies WHERE region_id=?",
  )
    .bind(id)
    .first<{
      region_id: string;
      max_nodes: number;
      purchases_enabled: number;
      order_config: string | null;
      autoscale_enabled: number;
      adopt_instance_ids: string;
    }>();
  if (!row)
    throw new ApiError("not_found", "Region capacity policy is not configured");
  return c.json(
    NodeCapacityPolicy.parse({
      ...row,
      purchases_enabled: Boolean(row.purchases_enabled),
      autoscale_enabled: Boolean(row.autoscale_enabled),
      order: row.order_config === null ? null : JSON.parse(row.order_config),
      adopt_instance_ids: JSON.parse(row.adopt_instance_ids),
    }),
  );
}
export async function setCapacityPolicy(
  c: ApiContext,
  id: string,
  raw: z.infer<typeof NodeCapacityPolicy>,
): Promise<Response> {
  await requireScope(c, "admin");
  const policy = NodeCapacityPolicy.parse(raw);
  if (policy.region_id !== id)
    throw new ApiError(
      "invalid_request",
      "Policy region differs from the route",
    );
  await configureNodeRegionPolicy(c.env.DB, {
    region_id: id,
    max_nodes: policy.max_nodes,
    purchases_enabled: policy.purchases_enabled,
    order: policy.order,
  });
  await c.env.DB.prepare(
    "UPDATE node_region_policies SET autoscale_enabled=?,adopt_instance_ids=? WHERE region_id=?",
  )
    .bind(
      Number(policy.autoscale_enabled),
      JSON.stringify(policy.adopt_instance_ids),
      id,
    )
    .run();
  return getCapacityPolicy(c, id);
}
export async function configureNodeBootstrap(
  c: ApiContext,
  id: string,
  raw: z.infer<typeof NodeBootstrapConfiguration>,
): Promise<Response> {
  await requireScope(c, "admin");
  const body = NodeBootstrapConfiguration.parse(raw),
    addition = await readNodeAddition(c.env.DB, id);
  if (!addition.audit || !addition.provider_instance_id)
    throw new ApiError(
      "conflict",
      "Bootstrap requires audited provider inventory",
    );
  const actual = await contaboClient(c.env).getInstance(
    addition.provider_instance_id,
    { requestId: crypto.randomUUID() },
  );
  if (
    actual.id !== body.spec.provider_instance_id ||
    actual.region !== addition.audit.provider_region ||
    actual.productId !== addition.audit.product_id ||
    actual.macAddress.toLowerCase() !== body.spec.hardware.mac ||
    actual.ipConfig.v4.ip !== body.spec.hardware.ipv4 ||
    actual.ipConfig.v4.gateway !== body.spec.hardware.gateway ||
    actual.ipConfig.v4.netmaskCidr !== body.spec.hardware.prefix_length ||
    !Number.isFinite(actual.diskMb) ||
    actual.diskMb <= 0 ||
    !Number.isFinite(actual.ramMb) ||
    actual.ramMb <= 0
  )
    throw new ApiError(
      "conflict",
      "Bootstrap hardware differs from current actual provider inventory",
    );
  const status = await configureBootstrapJob(c.env, id, body);
  c.executionCtx.waitUntil(startAddNode(c.env, id));
  return c.json(status, 202);
}
export async function getNodeBootstrap(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(bootstrapJobStatus(await readBootstrapJob(c.env.DB, id)));
}

const Timestamp = z.iso.datetime({ precision: 3 });
const Ip = z.union([z.ipv4(), z.ipv6()]);
const Proof = z.strictObject({
  purpose: z.literal("pgcf-node-verification/v1"),
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  provider_instance_id: ProviderInstanceId,
  intent_hash: z.string().regex(/^[a-f0-9]{64}$/),
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  checkpoint_reference: z.string().min(1).max(128),
  cluster_uid: z.uuid(),
  node_uid: z.uuid(),
  node_resource_version: z
    .string()
    .regex(/^[0-9]+$/)
    .max(128),
  observed_at: Timestamp,
  expires_at: Timestamp,
  addresses: z.strictObject({ ipv4: z.ipv4(), ipv6: z.ipv6().nullable() }),
  wireguard: z.strictObject({
    mode: z.literal("wireguard"),
    peers: z
      .array(
        z.strictObject({
          node_id: NodeId,
          provider_instance_id: ProviderInstanceId,
          address: Ip,
          public_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
          last_handshake_at: Timestamp,
        }),
      )
      .max(100),
    packet_observations: z
      .array(
        z.strictObject({
          source_node_id: NodeId,
          destination_node_id: NodeId,
          captured_at: Timestamp,
          encrypted_packets: z.number().int().positive(),
          plaintext_pod_packets: z.literal(0),
        }),
      )
      .max(200),
  }),
  scans: z
    .array(
      z.strictObject({
        family: z.enum(["ipv4", "ipv6"]),
        address: Ip,
        source: Ip,
        observed_at: Timestamp,
        scanned_ports: z.literal(65535),
        open_ports: z.array(z.number().int().min(1).max(65535)).max(100),
        control: z.strictObject({
          address: Ip,
          port: z.number().int().min(1).max(65535),
          connected: z.literal(true),
        }),
      }),
    )
    .min(1)
    .max(2),
});
const ProofEnvelope = z.strictObject({
  kid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  payload: Proof,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${canonical(object[name])}`)
    .join(",")}}`;
}
export async function verifyNodeProof(
  c: ApiContext,
  id: string,
  raw: z.infer<typeof NodeVerificationRequest>,
): Promise<Response> {
  await requireScope(c, "admin");
  const body = NodeVerificationRequest.parse(raw),
    addition = await readNodeAddition(c.env.DB, id);
  if (
    addition.revision !== body.expected_revision ||
    addition.checkpoint?.stage !== "joined" ||
    addition.status !== "bootstrapping"
  )
    throw new ApiError(
      "conflict",
      "Verification requires the current joined node checkpoint",
    );
  const row = await readBootstrapJob(c.env.DB, id),
    input = await bootstrapJobInput(c.env, row);
  const proofKey = `node-verification/${id}/${addition.checkpoint.reference}/proof.json`;
  const object = await c.env.ARCHIVE.get(proofKey);
  if (!object || object.size > 256 * 1024)
    throw new ApiError(
      "conflict",
      "Bound node verification artifact is unavailable",
    );
  const bytes = await object.arrayBuffer();
  if (
    bytes.byteLength > 256 * 1024 ||
    bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) !==
      body.sha256
  )
    throw new ApiError("conflict", "Node verification artifact digest differs");
  const envelope = ProofEnvelope.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ),
  );
  const keys = await importBootstrapVerificationKeys(
      JSON.parse(c.env.BOOTSTRAP_VERIFIER_KEYS),
    ),
    key = keys.get(envelope.kid),
    signature = base64urlToBytes(envelope.signature);
  if (
    !key ||
    !signature ||
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      Uint8Array.from(signature),
      new TextEncoder().encode(
        `pgcf-node-verification/v1\n${canonical(envelope.payload)}`,
      ),
    ))
  )
    throw new ApiError(
      "forbidden",
      "Node proof lacks the dedicated trusted verifier signature",
    );
  const proof = envelope.payload,
    now = Date.now(),
    at = Date.parse(proof.observed_at),
    expires = Date.parse(proof.expires_at);
  if (
    proof.operation_id !== id ||
    proof.node_id !== addition.intent.node_id ||
    proof.region_id !== row.region_id ||
    proof.provider_instance_id !== addition.provider_instance_id ||
    proof.intent_hash !== addition.intent_hash ||
    proof.input_hash !== row.input_hash ||
    proof.checkpoint_reference !== addition.checkpoint.reference ||
    at < Date.parse(addition.checkpoint.saved_at) ||
    at > now + 5000 ||
    at < now - 300_000 ||
    expires <= now ||
    expires > at + 600_000 ||
    proof.addresses.ipv4 !== input.spec.hardware.ipv4 ||
    (input.spec.cluster_uid !== null &&
      proof.cluster_uid !== input.spec.cluster_uid)
  )
    throw new ApiError(
      "conflict",
      "Node proof identity, checkpoint or freshness differs from the operation",
    );
  const protectedCluster = await loadRegionJoinBundle(
    c.env.DB,
    c.env.CREDENTIAL_KEYS,
    joinBundleReference(row.region_id, 1),
  );
  if (
    protectedCluster.kube_system_uid !== proof.cluster_uid ||
    protectedCluster.cluster_endpoint !== input.spec.cluster_endpoint
  )
    throw new ApiError(
      "conflict",
      "Proof cluster identity differs from actual sealed Kubernetes readback",
    );
  const actual = await contaboClient(c.env).getInstance(
    proof.provider_instance_id,
    { requestId: crypto.randomUUID() },
  );
  if (
    actual.ipConfig.v4.ip !== proof.addresses.ipv4 ||
    (actual.ipConfig.v6?.ip || null) !== proof.addresses.ipv6
  )
    throw new ApiError(
      "conflict",
      "Proof addresses differ from current provider inventory",
    );
  if (
    actual.additionalIps.some(
      (address) =>
        address.v4.ip !== "" && address.v4.ip !== proof.addresses.ipv4,
    )
  )
    throw new ApiError(
      "conflict",
      "Additional provider addresses require complete verified outside-allowlist scan coverage",
    );
  const peers = await c.env.DB.prepare(
    "SELECT id,provider_instance_id FROM nodes WHERE region_id=? AND id<>?",
  )
    .bind(row.region_id, row.node_id)
    .all<{ id: string; provider_instance_id: string | null }>();
  if (
    proof.wireguard.peers.length !== peers.results.length ||
    new Set(proof.wireguard.peers.map((peer) => peer.node_id)).size !==
      peers.results.length
  )
    throw new ApiError(
      "conflict",
      "WireGuard proof must cover every actual approved regional peer",
    );
  for (const peer of peers.results) {
    const evidence = proof.wireguard.peers.find(
      (value) => value.node_id === peer.id,
    );
    if (
      !evidence ||
      peer.provider_instance_id === null ||
      evidence.provider_instance_id !== peer.provider_instance_id ||
      Date.parse(evidence.last_handshake_at) < at - 180_000 ||
      Date.parse(evidence.last_handshake_at) > at + 5000 ||
      !proof.wireguard.packet_observations.some(
        (packet) =>
          [packet.source_node_id, packet.destination_node_id].includes(
            peer.id,
          ) &&
          [packet.source_node_id, packet.destination_node_id].includes(
            row.node_id,
          ) &&
          Date.parse(packet.captured_at) >= at - 180_000 &&
          Date.parse(packet.captured_at) <= at + 5000,
      )
    )
      throw new ApiError(
        "conflict",
        "Actual peer handshake and encrypted packet evidence are incomplete",
      );
  }
  const addresses = [
    { family: "ipv4", address: proof.addresses.ipv4 },
    ...(proof.addresses.ipv6 === null
      ? []
      : [{ family: "ipv6", address: proof.addresses.ipv6 }]),
  ];
  if (proof.scans.length !== addresses.length)
    throw new ApiError(
      "conflict",
      "Every assigned address needs an outside-allowlist scan",
    );
  for (const expected of addresses) {
    const scan = proof.scans.find(
      (value) =>
        value.family === expected.family && value.address === expected.address,
    );
    if (
      !scan ||
      scan.open_ports.length !== 0 ||
      Date.parse(scan.observed_at) < at - 180_000 ||
      Date.parse(scan.observed_at) > at + 5000 ||
      scan.source === proof.addresses.ipv4 ||
      scan.source === proof.addresses.ipv6 ||
      proof.wireguard.peers.some((peer) => peer.address === scan.source)
    )
      throw new ApiError(
        "conflict",
        "Complete controlled outside-allowlist scan proof is required",
      );
  }
  const node = await c.env.DB.prepare(
    "SELECT * FROM nodes WHERE id=? AND region_id=? AND provider_instance_id=? AND k8s_node_name=? AND ready=1 AND node_uid=?",
  )
    .bind(
      row.node_id,
      row.region_id,
      proof.provider_instance_id,
      input.spec.hostname,
      proof.node_uid,
    )
    .first<{
      last_observed_at: string;
      allocatable_memory_mib: number;
      allocatable_cpu_millicores: number;
      storage_gib_total: number;
      platform_reserved_memory_mib: number;
      platform_reserved_cpu_millicores: number;
    }>();
  if (
    !node ||
    Date.parse(node.last_observed_at) < at - 180_000 ||
    Date.parse(node.last_observed_at) > now + 5000
  )
    throw new ApiError(
      "conflict",
      "Current actual node identity and measured capacity are required",
    );
  const scope = {
    operation_id: id,
    node_id: row.node_id,
    intent_hash: addition.intent_hash,
    checkpoint_reference: addition.checkpoint.reference,
    proof_reference: `${proofKey}#${body.sha256}`,
  };
  let next = await verifyNodeNetwork(c.env.DB, id, addition.revision, {
    ...scope,
    verified_at: proof.observed_at,
  });
  next = await verifyNodeCapacity(c.env.DB, id, next.revision, {
    ...scope,
    observed_at: node.last_observed_at,
    allocatable_memory_mib: node.allocatable_memory_mib,
    allocatable_cpu_millicores: node.allocatable_cpu_millicores,
    storage_gib_total: node.storage_gib_total,
    platform_reserved_memory_mib: node.platform_reserved_memory_mib,
    platform_reserved_cpu_millicores: node.platform_reserved_cpu_millicores,
  });
  let admissionBinding = {
    checkpoint_revision: Number(
      addition.checkpoint.reference.split(":").at(-1),
    ),
    node_uid: proof.node_uid,
    resource_version: proof.node_resource_version,
    kube_system_uid: proof.cluster_uid,
    quarantine: {
      key: "pgcf.io/quarantine",
      value: "bootstrap",
      effect: "NoSchedule",
    },
  };
  if (row.admission_binding_json !== null) {
    const saved = JSON.parse(
      row.admission_binding_json,
    ) as typeof admissionBinding;
    if (
      saved.checkpoint_revision !== admissionBinding.checkpoint_revision ||
      saved.node_uid !== admissionBinding.node_uid ||
      saved.kube_system_uid !== admissionBinding.kube_system_uid
    )
      throw new ApiError(
        "conflict",
        "Original quarantine release identity cannot change",
      );
    admissionBinding = saved;
  }
  await c.env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET admission_authorized=1,admission_binding_json=?,admission_expires_at=?,updated_at=? WHERE operation_id=? AND input_hash=? AND authorized=1 AND admitted=0 AND cancelled=0",
  )
    .bind(
      JSON.stringify(admissionBinding),
      proof.expires_at,
      new Date().toISOString(),
      id,
      row.input_hash,
    )
    .run();
  c.executionCtx.waitUntil(startAddNode(c.env, id));
  return c.json(next, 202);
}

export async function capacityDecision(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  const decision = await runNodeCapacity(c.env, id, true);
  console.log(JSON.stringify({ event: "node_capacity_decision", ...decision }));
  return c.json(decision);
}
