// SPDX-License-Identifier: Apache-2.0
import {
  hashApiKey,
  OperationId,
  timingSafeEqual,
  bytesToHex,
} from "@pgcf/contracts";
import {
  NodeBootstrapAdmissionBinding,
  NodeBootstrapAdmissionReceipt,
  NodeBootstrapAuthority,
  NodeBootstrapCallback,
  NodeBootstrapCheckpoint,
  NodeBootstrapInput,
  NodeBootstrapSpec,
  NodeBootstrapStatus,
} from "@pgcf/contracts/node-bootstrap";
import { z } from "zod";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { bearer } from "../middleware/auth.ts";
import {
  bootstrapSpecHash,
  openBootstrapInput,
  sealBootstrapInput,
} from "../crypto/bootstrap-tickets.ts";
import {
  joinBundleReference,
  loadRegionJoinBundle,
  loadRegionSeed,
  regionSeedReference,
  storeRegionJoinBundle,
  storeRegionSeed,
  type BootstrapCredentialRef,
} from "../crypto/bootstrap-credentials.ts";
import {
  readNodeAddition,
  saveNodeBootstrapCheckpoint,
  verifyNodeCapacity,
  completeNodeAddition,
} from "./node-state.ts";
import { issueBootstrapTransport } from "./bootstrap-relay.ts";

export const NodeBootstrapConfiguration = z.strictObject({
  expected_revision: z.number().int().positive(),
  spec: NodeBootstrapSpec,
  rescue: NodeBootstrapInput.shape.rescue,
});
export type NodeBootstrapConfiguration = z.infer<
  typeof NodeBootstrapConfiguration
>;
export interface BootstrapJobRow {
  operation_id: string;
  node_id: string;
  region_id: string;
  input_hash: string;
  inventory_revision: number;
  sealed_revision: number;
  input_ciphertext: string;
  input_iv: string;
  input_kid: string;
  callback_hash: string;
  revision: number;
  checkpoint_json: string;
  material_ref_json: string | null;
  authorized: number;
  admitted: number;
  cancelled: number;
  rescue_active: number;
  admission_authorized: number;
  admission_binding_json: string | null;
  admission_expires_at: string | null;
  created_at: string;
  updated_at: string;
}
export async function readBootstrapJob(
  db: D1Database,
  operationId: string,
): Promise<BootstrapJobRow> {
  OperationId.parse(operationId);
  const row = await db
    .prepare("SELECT * FROM node_bootstrap_jobs WHERE operation_id=?")
    .bind(operationId)
    .first<BootstrapJobRow>();
  if (!row) throw new ApiError("not_found", "Bootstrap job not configured");
  return row;
}
export async function bootstrapJobInput(
  env: Env,
  row: BootstrapJobRow,
): Promise<NodeBootstrapInput> {
  return openBootstrapInput(env.CREDENTIAL_KEYS, {
    operation_id: row.operation_id,
    input_hash: row.input_hash,
    revision: row.sealed_revision,
    ciphertext: row.input_ciphertext,
    iv: row.input_iv,
    kid: row.input_kid,
  });
}
export async function configureBootstrapJob(
  env: Env,
  operationId: string,
  raw: NodeBootstrapConfiguration,
): Promise<NodeBootstrapStatus> {
  const value = NodeBootstrapConfiguration.parse(raw),
    addition = await readNodeAddition(env.DB, operationId);
  if (
    !addition.audit ||
    !addition.provider_instance_id ||
    !["audited", "bootstrapping"].includes(addition.status)
  )
    throw new ApiError(
      "conflict",
      "Bootstrap requires actual audited provider inventory",
    );
  const spec = value.spec;
  if (
    spec.operation_id !== operationId ||
    spec.node_id !== addition.intent.node_id ||
    spec.region_id !== addition.intent.request.region_id ||
    spec.provider_instance_id !== addition.provider_instance_id ||
    spec.hostname !== addition.intent.requested_hostname ||
    spec.inventory_revision !== value.expected_revision
  )
    throw new ApiError(
      "conflict",
      "Bootstrap identity must match the immutable audited node intent",
    );
  const inputHash = await bootstrapSpecHash(spec);
  const previous = await env.DB.prepare(
    "SELECT * FROM node_bootstrap_jobs WHERE operation_id=?",
  )
    .bind(operationId)
    .first<BootstrapJobRow>();
  if (previous) {
    if (previous.input_hash !== inputHash)
      throw new ApiError("conflict", "Bootstrap input is already immutable");
    return bootstrapJobStatus(previous);
  }
  if (addition.revision !== value.expected_revision)
    throw new ApiError("conflict", "Node inventory revision changed");
  if (spec.transport.mode !== "relay")
    throw new ApiError(
      "invalid_request",
      "Cloudflare jobs require the configured fixed-source relay",
    );
  const joinRef = joinBundleReference(spec.region_id, 1);
  let joinBundle: NodeBootstrapInput["join_bundle"] = null;
  if (spec.role === "worker") {
    const existing = await env.DB.prepare(
      "SELECT 1 present FROM nodes WHERE region_id=? AND id<>? LIMIT 1",
    )
      .bind(spec.region_id, spec.node_id)
      .first();
    if (existing === null)
      throw new ApiError(
        "conflict",
        "A worker requires an existing observed regional cluster",
      );
    joinBundle = NodeBootstrapInput.shape.join_bundle.parse(
      await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, joinRef),
    );
    if (
      joinBundle === null ||
      joinBundle.kube_system_uid !== spec.cluster_uid ||
      joinBundle.cluster_name !== spec.cluster_name ||
      joinBundle.cluster_endpoint !== spec.cluster_endpoint
    )
      throw new ApiError(
        "conflict",
        "Worker cluster identity differs from protected region custody",
      );
    const actual = await materialHash(joinBundle);
    if (actual !== spec.join_bundle_sha256)
      throw new ApiError("conflict", "Worker join bundle digest changed");
  } else {
    const cluster = await env.DB.prepare(
      "SELECT 1 present FROM nodes WHERE region_id=? LIMIT 1",
    )
      .bind(spec.region_id)
      .first();
    if (
      cluster ||
      spec.cluster_uid !== null ||
      spec.join_bundle_sha256 !== null ||
      new URL(spec.cluster_endpoint).hostname !== spec.hardware.ipv4
    )
      throw new ApiError(
        "conflict",
        "A new control plane requires an empty region and the actual reserved provider endpoint",
      );
  }
  const base = new URL(env.NODE_BOOTSTRAP_CALLBACK_URL);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error("bootstrap_callback_configuration_invalid");
  const callbackBearer = crypto.randomUUID() + crypto.randomUUID();
  const input = NodeBootstrapInput.parse({
    spec,
    input_hash: inputHash,
    rescue: value.rescue,
    join_bundle: joinBundle,
    callback: {
      url: new URL(
        `/internal/v1/node-bootstrap/${operationId}`,
        base,
      ).toString(),
      bearer: callbackBearer,
    },
  });
  const sealed = await sealBootstrapInput(env.CREDENTIAL_KEYS, input);
  const checkpoint = NodeBootstrapCheckpoint.parse({
    stage: "created",
    status: "running",
    downloaded_bytes: 0,
    written_bytes: 0,
    write_intent_offset: null,
    destructive_intent: false,
    sealed_ref: null,
    pre_reboot_boot_id: null,
    release_node_uid: null,
    release_resource_version: null,
    admission_receipt: null,
    error_code: null,
  });
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO node_bootstrap_jobs(operation_id,node_id,region_id,input_hash,inventory_revision,sealed_revision,input_ciphertext,input_iv,input_kid,callback_hash,checkpoint_json,created_at,updated_at)
    SELECT operation_id,node_id,region_id,?,?,?,?,?,?,?,?,?,? FROM node_additions WHERE operation_id=? AND revision=? AND status IN('audited','bootstrapping') AND provider_instance_id=?
    ON CONFLICT(operation_id) DO NOTHING`,
  )
    .bind(
      inputHash,
      spec.inventory_revision,
      sealed.revision,
      sealed.ciphertext,
      sealed.iv,
      sealed.kid,
      await hashApiKey(env.API_KEY_PEPPER, callbackBearer),
      JSON.stringify(checkpoint),
      now,
      now,
      operationId,
      value.expected_revision,
      spec.provider_instance_id,
    )
    .run();
  const saved = await readBootstrapJob(env.DB, operationId);
  if (result.meta.changes !== 1 && saved.input_hash !== inputHash)
    throw new ApiError(
      "conflict",
      "Concurrent bootstrap configuration changed",
    );
  return bootstrapJobStatus(saved);
}
async function materialHash(material: unknown) {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object")
      return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonical(object[name])}`)
      .join(",")}}`;
  };
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(material)),
      ),
    ),
  );
}
export function bootstrapJobStatus(row: BootstrapJobRow): NodeBootstrapStatus {
  return NodeBootstrapStatus.parse({
    operation_id: row.operation_id,
    input_hash: row.input_hash,
    revision: row.revision,
    checkpoint: JSON.parse(row.checkpoint_json),
  });
}
export async function authenticateBootstrapCallback(
  c: ApiContext,
  operationId: string,
): Promise<void> {
  const token = bearer(c),
    row = await readBootstrapJob(c.env.DB, operationId);
  if (
    !timingSafeEqual(
      row.callback_hash,
      await hashApiKey(c.env.API_KEY_PEPPER, token),
    )
  )
    throw new ApiError("unauthorized", "Invalid bootstrap authority");
  const addition = await readNodeAddition(c.env.DB, operationId);
  if (
    !row.authorized ||
    row.admitted ||
    row.cancelled ||
    ["cancelled", "ready"].includes(addition.status)
  )
    throw new ApiError("forbidden", "Bootstrap job is closed");
}
async function authority(
  env: Env,
  row: BootstrapJobRow,
): Promise<NodeBootstrapAuthority> {
  const addition = await readNodeAddition(env.DB, row.operation_id);
  if (
    !row.authorized ||
    row.admitted ||
    row.cancelled ||
    ["ready", "cancelled"].includes(addition.status)
  )
    throw new ApiError("forbidden", "Bootstrap job is closed");
  let material: NodeBootstrapAuthority["protected_material"] = null;
  if (row.material_ref_json) {
    const ref = JSON.parse(row.material_ref_json) as BootstrapCredentialRef;
    material = NodeBootstrapAuthority.shape.protected_material.parse(
      ref.purpose === "region_seed"
        ? {
            purpose: "region_seed",
            material: await loadRegionSeed(env.DB, env.CREDENTIAL_KEYS, ref),
          }
        : {
            purpose: "join_bundle",
            material: await loadRegionJoinBundle(
              env.DB,
              env.CREDENTIAL_KEYS,
              ref,
            ),
          },
    );
  }
  return NodeBootstrapAuthority.parse({
    version: 1,
    operation_id: row.operation_id,
    node_id: row.node_id,
    region_id: row.region_id,
    input_hash: row.input_hash,
    provider_instance_id: addition.provider_instance_id,
    inventory_revision: row.inventory_revision,
    revision: row.revision,
    authorized: Boolean(row.authorized),
    admitted: Boolean(row.admitted),
    cancelled: Boolean(row.cancelled),
    rescue_active: Boolean(row.rescue_active),
    ...(await admissionAuthority(env, row)),
    checkpoint: JSON.parse(row.checkpoint_json),
    protected_material: material,
  });
}
const stages = NodeBootstrapCheckpoint.shape.stage.options;
export async function bootstrapCallback(
  c: ApiContext,
  operationId: string,
  raw: unknown,
): Promise<Response> {
  await authenticateBootstrapCallback(c, operationId);
  const parsed = NodeBootstrapCallback.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(
      "invalid_request",
      "Invalid bootstrap callback envelope",
    );
  const envelope = parsed.data,
    row = await readBootstrapJob(c.env.DB, operationId);
  if (
    envelope.operation_id !== operationId ||
    envelope.node_id !== row.node_id ||
    envelope.region_id !== row.region_id ||
    envelope.input_hash !== row.input_hash
  )
    throw new ApiError(
      "forbidden",
      "Bootstrap callback identity differs from the admitted job",
    );
  if (envelope.kind === "read") return c.json(await authority(c.env, row));
  if (envelope.kind === "transport")
    return c.json(await issueBootstrapTransport(c.env, row, envelope.payload));
  if (envelope.expected_revision !== row.revision)
    throw new ApiError("conflict", "Bootstrap checkpoint revision changed");
  const input = await bootstrapJobInput(c.env, row);
  let checkpoint = NodeBootstrapCheckpoint.parse(
      JSON.parse(row.checkpoint_json),
    ),
    ref: BootstrapCredentialRef | null = null;
  if (envelope.kind === "seal") {
    const supplied = envelope.payload,
      material = supplied.material;
    if (
      material.cluster_name !== input.spec.cluster_name ||
      material.cluster_endpoint !== input.spec.cluster_endpoint ||
      (supplied.purpose === "region_seed" &&
        input.spec.role !== "controlplane") ||
      (supplied.purpose === "join_bundle" &&
        input.spec.cluster_uid !== null &&
        supplied.material.kube_system_uid !== input.spec.cluster_uid)
    )
      throw new ApiError(
        "conflict",
        "Sealed material differs from the immutable cluster identity",
      );
    if (
      supplied.purpose === "region_seed" &&
      stages.indexOf(checkpoint.stage) >= stages.indexOf("config_apply_intent")
    )
      throw new ApiError(
        "conflict",
        "Machine keys must be sealed before cluster configuration",
      );
    if (
      supplied.purpose === "join_bundle" &&
      stages.indexOf(checkpoint.stage) <
        stages.indexOf("kubernetes_bootstrap_intent")
    )
      throw new ApiError(
        "conflict",
        "Full join custody requires actual Kubernetes bootstrap readback",
      );
    ref =
      supplied.purpose === "region_seed"
        ? await storeRegionSeed(
            c.env.DB,
            c.env.CREDENTIAL_KEYS,
            regionSeedReference(row.region_id, 1),
            supplied.material,
          )
        : await storeRegionJoinBundle(
            c.env.DB,
            c.env.CREDENTIAL_KEYS,
            joinBundleReference(row.region_id, 1),
            supplied.material,
          );
    checkpoint = {
      ...checkpoint,
      sealed_ref: `${ref.purpose}:${ref.revision}`,
    };
  } else {
    const next = envelope.payload;
    if (
      stages.indexOf(next.stage) < stages.indexOf(checkpoint.stage) ||
      (stages.indexOf(next.stage) > stages.indexOf(checkpoint.stage) + 1 &&
        !(
          input.spec.role === "worker" &&
          checkpoint.stage === "talos_authenticated" &&
          next.stage === "kubernetes_joined"
        )) ||
      next.written_bytes < checkpoint.written_bytes ||
      next.downloaded_bytes < checkpoint.downloaded_bytes ||
      next.written_bytes > input.spec.image.raw_bytes ||
      next.downloaded_bytes > input.spec.image.compressed_bytes ||
      (!next.destructive_intent && checkpoint.destructive_intent) ||
      (next.written_bytes > 0 && !next.destructive_intent) ||
      next.sealed_ref !== checkpoint.sealed_ref
    )
      throw new ApiError(
        "conflict",
        "Bootstrap checkpoint cannot rewind or invent durable progress",
      );
    if (
      ["quarantine_release_intent", "quarantine_released"].includes(next.stage)
    ) {
      const admission = await admissionAuthority(c.env, row),
        binding = admission.admission_binding;
      if (
        !admission.admission_authorized ||
        binding === null ||
        next.release_node_uid !== binding.node_uid ||
        next.release_resource_version !== binding.resource_version
      )
        throw new ApiError(
          "forbidden",
          "Quarantine release is not authorized by current bound proofs",
        );
      if (next.stage === "quarantine_released") {
        if (next.admission_receipt === null)
          throw new ApiError(
            "conflict",
            "Native quarantine release readback receipt is required",
          );
        validateAdmissionReceipt(row, binding, next.admission_receipt);
      } else if (next.admission_receipt !== null)
        throw new ApiError(
          "conflict",
          "Quarantine intent cannot assert a completed release",
        );
    } else if (
      next.release_node_uid !== checkpoint.release_node_uid ||
      next.release_resource_version !== checkpoint.release_resource_version ||
      next.admission_receipt !== checkpoint.admission_receipt
    )
      throw new ApiError(
        "conflict",
        "Admission fields belong only to the authorized quarantine release",
      );
    checkpoint = next;
  }
  const result = await c.env.DB.prepare(
    `UPDATE node_bootstrap_jobs SET checkpoint_json=?,material_ref_json=COALESCE(?,material_ref_json),revision=revision+1,updated_at=?
    WHERE operation_id=? AND input_hash=? AND revision=? AND authorized=1 AND admitted=0 AND cancelled=0`,
  )
    .bind(
      JSON.stringify(checkpoint),
      ref === null ? null : JSON.stringify(ref),
      new Date().toISOString(),
      operationId,
      row.input_hash,
      row.revision,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new ApiError("conflict", "Bootstrap checkpoint changed concurrently");
  if (checkpoint.stage === "awaiting_verification") {
    const addition = await readNodeAddition(c.env.DB, operationId);
    await saveNodeBootstrapCheckpoint(
      c.env.DB,
      operationId,
      addition.revision,
      {
        stage: "joined",
        reference: `${row.input_hash}:${row.revision + 1}`,
        saved_at: new Date().toISOString(),
      },
    );
  }
  return c.json(ref === null ? { revision: row.revision + 1 } : { ref });
}

export async function admissionAuthority(
  env: Env,
  row: BootstrapJobRow,
): Promise<
  Pick<NodeBootstrapAuthority, "admission_authorized" | "admission_binding">
> {
  const binding =
    row.admission_binding_json === null
      ? null
      : NodeBootstrapAdmissionBinding.parse(
          JSON.parse(row.admission_binding_json),
        );
  const denied = { admission_authorized: false, admission_binding: binding };
  if (
    !row.admission_authorized ||
    !binding ||
    !row.admission_expires_at ||
    Date.parse(row.admission_expires_at) <= Date.now() ||
    row.cancelled ||
    row.admitted ||
    !row.authorized
  )
    return denied;
  const addition = await readNodeAddition(env.DB, row.operation_id),
    capacity = addition.capacity;
  if (
    addition.status !== "bootstrapping" ||
    !capacity ||
    !addition.network ||
    addition.checkpoint?.stage !== "joined" ||
    addition.network.checkpoint_reference !== addition.checkpoint.reference ||
    capacity.checkpoint_reference !== addition.checkpoint.reference ||
    addition.checkpoint.reference !==
      `${row.input_hash}:${binding.checkpoint_revision}`
  )
    return denied;
  const actual = await env.DB.prepare(
    `SELECT 1 valid FROM nodes WHERE id=? AND region_id=? AND provider_instance_id=? AND ready=1 AND schedulable=0 AND node_uid=?
    AND allocatable_memory_mib=? AND allocatable_cpu_millicores=? AND storage_gib_total=? AND platform_reserved_memory_mib=? AND platform_reserved_cpu_millicores=?`,
  )
    .bind(
      row.node_id,
      row.region_id,
      addition.provider_instance_id,
      binding.node_uid,
      capacity.allocatable_memory_mib,
      capacity.allocatable_cpu_millicores,
      capacity.storage_gib_total,
      capacity.platform_reserved_memory_mib,
      capacity.platform_reserved_cpu_millicores,
    )
    .first();
  return { admission_authorized: actual !== null, admission_binding: binding };
}
function validateAdmissionReceipt(
  row: BootstrapJobRow,
  binding: z.infer<typeof NodeBootstrapAdmissionBinding>,
  raw: unknown,
) {
  const receipt = NodeBootstrapAdmissionReceipt.parse(raw);
  if (
    receipt.operation_id !== row.operation_id ||
    receipt.node_id !== row.node_id ||
    receipt.region_id !== row.region_id ||
    receipt.input_hash !== row.input_hash ||
    receipt.checkpoint_revision !== binding.checkpoint_revision ||
    receipt.node_uid !== binding.node_uid ||
    receipt.kube_system_uid !== binding.kube_system_uid ||
    receipt.previous_resource_version !== binding.resource_version ||
    BigInt(receipt.resource_version) <=
      BigInt(receipt.previous_resource_version)
  )
    throw new ApiError(
      "conflict",
      "Native release receipt differs from the authorized immutable intent",
    );
  return receipt;
}
export async function finalizeNodeAdmission(
  env: Env,
  operationId: string,
): Promise<boolean> {
  const row = await readBootstrapJob(env.DB, operationId),
    checkpoint = NodeBootstrapCheckpoint.parse(JSON.parse(row.checkpoint_json));
  if (
    checkpoint.stage !== "quarantine_released" ||
    checkpoint.status !== "released" ||
    checkpoint.admission_receipt === null ||
    row.admission_binding_json === null
  )
    return false;
  const binding = NodeBootstrapAdmissionBinding.parse(
    JSON.parse(row.admission_binding_json),
  );
  validateAdmissionReceipt(row, binding, checkpoint.admission_receipt);
  if (!(await admissionAuthority(env, row)).admission_authorized) return false;
  let addition = await readNodeAddition(env.DB, operationId);
  const actual = await env.DB.prepare(
    "SELECT * FROM nodes WHERE id=? AND region_id=? AND provider_instance_id=? AND node_uid=? AND ready=1 AND schedulable=0",
  )
    .bind(
      row.node_id,
      row.region_id,
      addition.provider_instance_id,
      binding.node_uid,
    )
    .first<{
      last_observed_at: string;
      allocatable_memory_mib: number;
      allocatable_cpu_millicores: number;
      storage_gib_total: number;
      platform_reserved_memory_mib: number;
      platform_reserved_cpu_millicores: number;
    }>();
  if (!actual || !addition.capacity) return false;
  addition = await verifyNodeCapacity(env.DB, operationId, addition.revision, {
    operation_id: operationId,
    node_id: row.node_id,
    intent_hash: addition.intent_hash,
    checkpoint_reference: addition.checkpoint!.reference,
    proof_reference: addition.capacity.proof_reference,
    observed_at: actual.last_observed_at,
    allocatable_memory_mib: actual.allocatable_memory_mib,
    allocatable_cpu_millicores: actual.allocatable_cpu_millicores,
    storage_gib_total: actual.storage_gib_total,
    platform_reserved_memory_mib: actual.platform_reserved_memory_mib,
    platform_reserved_cpu_millicores: actual.platform_reserved_cpu_millicores,
  });
  await completeNodeAddition(env.DB, operationId, addition.revision);
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET admitted=1,authorized=0,admission_authorized=0,updated_at=? WHERE operation_id=? AND input_hash=?",
  )
    .bind(new Date().toISOString(), operationId, row.input_hash)
    .run();
  return true;
}
