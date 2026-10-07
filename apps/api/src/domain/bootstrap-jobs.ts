// SPDX-License-Identifier: Apache-2.0
import {
  hashApiKey,
  NodeId,
  OperationId,
  RegionId,
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
  NodeBootstrapStage,
  nodeStorageTrialTransition,
} from "@pgcf/contracts/node-bootstrap";
import {
  ProviderInstanceId,
  NodeProviderAudit,
  NodeProviderReceipt,
} from "@pgcf/contracts/nodes";
import { z } from "zod";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { bearer } from "../middleware/auth.ts";
import {
  bootstrapSpecHash,
  bootstrapPlatformHash,
  openBootstrapInput,
  sealBootstrapInput,
} from "../crypto/bootstrap-tickets.ts";
import {
  joinBundleReference,
  loadCurrentRegionMaterialReference,
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
  assertNodeRecoveryAuthority,
} from "./node-state.ts";
import { contaboClient, issueBootstrapTransport } from "./bootstrap-relay.ts";
import { hasAllocatedContaboHardware } from "../providers/contabo.ts";
import {
  hasVerifiedNodePreparation,
  hasNodeNetworkTargetAddresses,
  readNodeNetworkSnapshot,
  verifyNodeFirewallSnapshot,
  type NodeNetworkSnapshot,
} from "./node-network.ts";

export const NodeBootstrapConfiguration = z.strictObject({
  expected_revision: z.number().int().positive(),
  spec: NodeBootstrapSpec,
  rescue: NodeBootstrapInput.shape.rescue,
  platform: NodeBootstrapInput.shape.platform,
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
  network_authorization_json: string | null;
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
  await assertNodeRecoveryAuthority(env.DB, addition);
  if (addition.intent.request.mode === "recover" && spec.role !== "worker")
    throw new ApiError(
      "conflict",
      "Existing-instance recovery requires a surviving regional cluster",
    );
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
  await assertPeerRoutes(env, spec, addition);
  const inputHash = await bootstrapSpecHash(spec);
  if (
    value.platform &&
    (spec.role !== "controlplane" ||
      value.platform.region_id !== spec.region_id ||
      !spec.platform ||
      (await bootstrapPlatformHash(value.platform)) !==
        spec.platform.configuration_sha256)
  )
    throw new ApiError(
      "conflict",
      "Platform configuration differs from the reviewed node intent",
    );
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
  if (spec.role === "controlplane" && (!spec.platform || !value.platform))
    throw new ApiError(
      "invalid_request",
      "A new region requires reviewed platform configuration",
    );
  if (spec.transport.mode !== "relay")
    throw new ApiError(
      "invalid_request",
      "Cloudflare jobs require the configured fixed-source relay",
    );
  const joinRef = await loadCurrentRegionMaterialReference(
    env.DB,
    spec.region_id,
    "join_bundle",
  );
  let joinBundle: NodeBootstrapInput["join_bundle"] = null;
  if (spec.role === "worker") {
    const existing = await env.DB.prepare(
      "SELECT 1 present FROM nodes WHERE region_id=? AND id<>? AND lost_at IS NULL LIMIT 1",
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
    ...(value.platform ? { platform: value.platform } : {}),
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
    `INSERT INTO node_bootstrap_jobs(operation_id,node_id,region_id,input_hash,inventory_revision,sealed_revision,input_ciphertext,input_iv,input_kid,callback_hash,material_ref_json,checkpoint_json,created_at,updated_at)
    SELECT operation_id,node_id,region_id,?,?,?,?,?,?,?,?,?,?,? FROM node_additions WHERE operation_id=? AND revision=? AND status IN('audited','bootstrapping') AND provider_instance_id=?
      AND EXISTS(SELECT 1 FROM regions r WHERE r.id=node_additions.region_id AND r.bootstrap_material_revision=?)
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
      spec.role === "worker" ? JSON.stringify(joinRef) : null,
      JSON.stringify(checkpoint),
      now,
      now,
      operationId,
      value.expected_revision,
      spec.provider_instance_id,
      joinRef.revision,
    )
    .run();
  const saved = await env.DB.prepare(
    "SELECT * FROM node_bootstrap_jobs WHERE operation_id=?",
  )
    .bind(operationId)
    .first<BootstrapJobRow>();
  if (saved === null)
    throw new ApiError(
      "conflict",
      "Regional bootstrap material changed before configuration",
    );
  if (result.meta.changes !== 1 && saved.input_hash !== inputHash)
    throw new ApiError(
      "conflict",
      "Concurrent bootstrap configuration changed",
    );
  return bootstrapJobStatus(saved);
}
const PeerRouteAddresses = z.strictObject({
  ipv4: z.array(z.ipv4()).max(4),
  ipv6: z.array(z.ipv6()).max(4),
});
const PeerRoutePlan = z.looseObject({
  version: z.literal(1),
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  provider_instance_id: ProviderInstanceId,
  intent_hash: z.string().regex(/^[a-f0-9]{64}$/),
  relay: z.looseObject({
    provider_instance_id: ProviderInstanceId,
    addresses: PeerRouteAddresses,
  }),
  members: z
    .array(
      z.looseObject({
        node_id: NodeId,
        provider_instance_id: ProviderInstanceId,
        addresses: PeerRouteAddresses,
      }),
    )
    .min(1)
    .max(16),
});
async function assertPeerRoutes(
  env: Env,
  spec: NodeBootstrapSpec,
  addition: Awaited<ReturnType<typeof readNodeAddition>>,
): Promise<void> {
  if (spec.peer_ipv4 === undefined) return;
  const fail = (): never => {
    throw new ApiError(
      "conflict",
      "Peer routes require the immutable network preparation",
    );
  };
  const row = await env.DB.prepare(
    "SELECT operation_id,intent_hash,plan_sha256,plan_json,status FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(spec.operation_id)
    .first<{
      operation_id: string;
      intent_hash: string;
      plan_sha256: string;
      plan_json: string;
      status: string;
    }>();
  if (
    !row ||
    row.status === "blocked" ||
    row.intent_hash !== addition.intent_hash ||
    new TextEncoder().encode(row.plan_json).length > 65536
  )
    return fail();
  let document: unknown;
  try {
    document = JSON.parse(row.plan_json);
  } catch {
    return fail();
  }
  const parsed = PeerRoutePlan.safeParse(document);
  // The digest covers every field of the retained plan, including firewall rules.
  if (!parsed.success || (await materialHash(document)) !== row.plan_sha256)
    return fail();
  const plan = parsed.data;
  if (
    row.operation_id !== spec.operation_id ||
    plan.operation_id !== spec.operation_id ||
    plan.node_id !== spec.node_id ||
    plan.region_id !== spec.region_id ||
    plan.provider_instance_id !== spec.provider_instance_id ||
    plan.intent_hash !== addition.intent_hash ||
    spec.transport.mode !== "relay" ||
    spec.transport.issuer_region_id !== env.BOOTSTRAP_RELAY_ISSUER_REGION ||
    plan.relay.provider_instance_id !==
      env.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID ||
    plan.relay.provider_instance_id === spec.provider_instance_id ||
    new Set(plan.members.map((member) => member.node_id)).size !==
      plan.members.length ||
    new Set(plan.members.map((member) => member.provider_instance_id)).size !==
      plan.members.length
  )
    return fail();
  const target = plan.members.find(
    (member) =>
      member.node_id === spec.node_id &&
      member.provider_instance_id === spec.provider_instance_id,
  );
  if (!target?.addresses.ipv4.includes(spec.hardware.ipv4)) return fail();
  const expected = [
    ...new Set([
      ...plan.members
        .filter((member) => member.node_id !== spec.node_id)
        .flatMap((member) => member.addresses.ipv4),
      ...plan.relay.addresses.ipv4,
    ]),
  ]
    .filter((address) => address !== spec.hardware.ipv4)
    .sort();
  if (
    expected.length !== spec.peer_ipv4.length ||
    expected.some((address, index) => address !== spec.peer_ipv4![index])
  )
    throw new ApiError(
      "conflict",
      "Peer routes differ from the immutable network preparation",
    );
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
  const admission = await admissionAuthority(env, row);
  if (
    !admission.admission_authorized &&
    !(await hasBootstrapNetworkAuthority(env, row))
  )
    throw new ApiError(
      "forbidden",
      "Verified network preparation is required for native installation",
    );
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
interface DestructiveProviderAuthority {
  revision: number;
  provider_instance_id: string;
  intent_hash: string;
  audit_json: string;
  receipt_json: string;
  network: NodeNetworkSnapshot;
  provider_inventory_sha256: string;
}
const BootstrapNetworkAuthorization = z.strictObject({
  version: z.literal(1),
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  provider_instance_id: ProviderInstanceId,
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  sealed_revision: z.number().int().positive(),
  intent_hash: z.string().regex(/^[a-f0-9]{64}$/),
  binding_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  readback_at: z.iso.datetime(),
  initial_proof_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  provider_audit_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  provider_receipt_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  provider_inventory_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  authorized_revision: z.number().int().nonnegative(),
  issued_at: z.iso.datetime(),
});
async function installationBindingHash(env: Env, operationId: string) {
  const row = await env.DB.prepare(
    "SELECT binding_sha256 FROM node_installation_bindings WHERE operation_id=?",
  )
    .bind(operationId)
    .first<{ binding_sha256: string }>();
  return row?.binding_sha256 ?? null;
}
async function networkAuthorization(
  env: Env,
  row: BootstrapJobRow,
  verified: DestructiveProviderAuthority,
  revision: number,
) {
  return BootstrapNetworkAuthorization.parse({
    version: 1,
    operation_id: row.operation_id,
    node_id: row.node_id,
    region_id: row.region_id,
    provider_instance_id: verified.provider_instance_id,
    input_hash: row.input_hash,
    sealed_revision: row.sealed_revision,
    intent_hash: verified.intent_hash,
    binding_sha256: await installationBindingHash(env, row.operation_id),
    plan_sha256: verified.network.plan_sha256,
    readback_at: verified.network.readback_at,
    initial_proof_sha256: verified.network.proof_sha256,
    provider_audit_sha256: await materialHash(JSON.parse(verified.audit_json)),
    provider_receipt_sha256: await materialHash(
      JSON.parse(verified.receipt_json),
    ),
    provider_inventory_sha256: verified.provider_inventory_sha256,
    authorized_revision: revision,
    issued_at: new Date().toISOString(),
  });
}
/** Initial proof admits installation once; every continuation still checks current custody. */
export async function hasBootstrapNetworkAuthority(
  env: Env,
  row: BootstrapJobRow,
): Promise<boolean> {
  try {
    const addition = await readNodeAddition(env.DB, row.operation_id),
      checkpoint = NodeBootstrapCheckpoint.parse(
        JSON.parse(row.checkpoint_json),
      );
    if (
      !row.authorized ||
      row.admitted ||
      row.cancelled ||
      !addition.slot_held ||
      !["audited", "bootstrapping"].includes(addition.status)
    )
      return false;
    if (!checkpoint.destructive_intent)
      return hasVerifiedNodePreparation(
        env.DB,
        row.operation_id,
        addition.intent_hash,
      );
    const stage = NodeBootstrapStage.options.indexOf(checkpoint.stage);
    if (
      stage < NodeBootstrapStage.options.indexOf("disk_write_intent") ||
      stage > NodeBootstrapStage.options.indexOf("awaiting_verification") ||
      (!["running", "waiting"].includes(checkpoint.status) &&
        !(
          checkpoint.stage === "awaiting_verification" &&
          checkpoint.status === "awaiting_verification"
        ))
    )
      return false;
    if (row.network_authorization_json === null) return false;
    if (
      !row.network_authorization_json ||
      row.network_authorization_json.length > 8192
    )
      return false;
    const record = BootstrapNetworkAuthorization.parse(
        JSON.parse(row.network_authorization_json),
      ),
      snapshot = await readNodeNetworkSnapshot(env, row.operation_id);
    if (
      !snapshot ||
      record.operation_id !== row.operation_id ||
      record.node_id !== row.node_id ||
      record.region_id !== row.region_id ||
      record.input_hash !== row.input_hash ||
      record.sealed_revision !== row.sealed_revision ||
      record.authorized_revision > row.revision ||
      record.provider_instance_id !== addition.provider_instance_id ||
      record.intent_hash !== addition.intent_hash ||
      record.plan_sha256 !== snapshot.plan_sha256 ||
      record.readback_at !== snapshot.readback_at ||
      record.binding_sha256 !==
        (await installationBindingHash(env, row.operation_id)) ||
      record.provider_audit_sha256 !== (await materialHash(addition.audit)) ||
      record.provider_receipt_sha256 !== (await materialHash(addition.receipt))
    )
      return false;
    const fresh = await readBootstrapJob(env.DB, row.operation_id),
      current = await readNodeAddition(env.DB, row.operation_id),
      after = await readNodeNetworkSnapshot(env, row.operation_id);
    return (
      fresh.authorized === 1 &&
      fresh.admitted === 0 &&
      fresh.cancelled === 0 &&
      fresh.input_hash === row.input_hash &&
      fresh.sealed_revision === row.sealed_revision &&
      fresh.revision === row.revision &&
      fresh.checkpoint_json === row.checkpoint_json &&
      fresh.network_authorization_json === row.network_authorization_json &&
      current.revision === addition.revision &&
      current.intent_hash === addition.intent_hash &&
      current.provider_instance_id === addition.provider_instance_id &&
      current.slot_held &&
      ["audited", "bootstrapping"].includes(current.status) &&
      JSON.stringify(after) === JSON.stringify(snapshot)
    );
  } catch {
    return false;
  }
}
/** One explicit migration lifecycle boundary; routine predicates never call providers. */
export async function establishBootstrapNetworkAuthority(
  env: Env,
  row: BootstrapJobRow,
): Promise<boolean> {
  if (row.network_authorization_json !== null)
    return hasBootstrapNetworkAuthority(env, row);
  try {
    const addition = await readNodeAddition(env.DB, row.operation_id),
      checkpoint = NodeBootstrapCheckpoint.parse(
        JSON.parse(row.checkpoint_json),
      ),
      stage = NodeBootstrapStage.options.indexOf(checkpoint.stage);
    if (
      !row.authorized ||
      row.admitted ||
      row.cancelled ||
      !addition.slot_held ||
      !["audited", "bootstrapping"].includes(addition.status) ||
      !checkpoint.destructive_intent ||
      stage < NodeBootstrapStage.options.indexOf("disk_write_intent") ||
      stage > NodeBootstrapStage.options.indexOf("awaiting_verification") ||
      (!["running", "waiting"].includes(checkpoint.status) &&
        !(
          checkpoint.stage === "awaiting_verification" &&
          checkpoint.status === "awaiting_verification"
        ))
    )
      return false;
    if (
      !(await hasVerifiedNodePreparation(
        env.DB,
        row.operation_id,
        addition.intent_hash,
      ))
    )
      return false;
    const input = await bootstrapJobInput(env, row),
      verified = await destructiveProviderAuthority(env, row, input),
      record = await networkAuthorization(env, row, verified, row.revision);
    const result = await env.DB.prepare(
      `UPDATE node_bootstrap_jobs SET network_authorization_json=? WHERE operation_id=? AND input_hash=? AND sealed_revision=? AND revision=? AND checkpoint_json=? AND authorized=1 AND admitted=0 AND cancelled=0 AND network_authorization_json IS NULL
        AND EXISTS(SELECT 1 FROM node_additions a WHERE a.operation_id=node_bootstrap_jobs.operation_id AND a.revision=? AND a.provider_instance_id=? AND a.intent_hash=? AND a.audit_json=? AND a.receipt_json=? AND a.slot_held=1 AND a.status IN('audited','bootstrapping'))
        AND EXISTS(SELECT 1 FROM node_network_preparations p WHERE p.operation_id=node_bootstrap_jobs.operation_id AND p.revision=? AND p.plan_sha256=? AND p.plan_json=? AND p.readback_at=? AND p.status='verified' AND p.proof_sha256=? AND p.proof_expires_at=? AND julianday(p.proof_expires_at)>julianday('now'))
        AND EXISTS(SELECT 1 FROM regions r WHERE r.id=? AND r.provider='contabo' AND r.provider_region=?)
        AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.region_id=? AND n.id<>? AND n.lost_at IS NULL AND NOT EXISTS(SELECT 1 FROM json_each(?,'$.members') m WHERE n.id=json_extract(m.value,'$.node_id') AND n.provider_instance_id=json_extract(m.value,'$.provider_instance_id')))
        AND NOT EXISTS(SELECT 1 FROM json_each(?,'$.members') m WHERE json_extract(m.value,'$.node_id')<>? AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.region_id=? AND n.id=json_extract(m.value,'$.node_id') AND n.provider_instance_id=json_extract(m.value,'$.provider_instance_id') AND n.lost_at IS NULL))
        AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM node_installation_bindings b WHERE b.operation_id=node_bootstrap_jobs.operation_id)) OR EXISTS(SELECT 1 FROM node_installation_bindings b WHERE b.operation_id=node_bootstrap_jobs.operation_id AND b.binding_sha256=?))
        AND NOT EXISTS(SELECT 1 FROM json_each(?) s WHERE NOT EXISTS(SELECT 1 FROM node_network_firewalls l WHERE l.firewall_id=json_extract(s.value,'$.firewall_id') AND l.operation_id=json_extract(s.value,'$.operation_id') AND l.plan_sha256=json_extract(s.value,'$.plan_sha256') AND l.revision=json_extract(s.value,'$.revision')))
        AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM node_firewall_allocations f WHERE f.operation_id=node_bootstrap_jobs.operation_id)) OR EXISTS(SELECT 1 FROM node_firewall_allocations f WHERE f.operation_id=node_bootstrap_jobs.operation_id AND f.firewall_id IS ? AND f.state=? AND f.result_json IS ? AND f.updated_at=?))`,
    )
      .bind(
        JSON.stringify(record),
        row.operation_id,
        row.input_hash,
        row.sealed_revision,
        row.revision,
        row.checkpoint_json,
        verified.revision,
        verified.provider_instance_id,
        verified.intent_hash,
        verified.audit_json,
        verified.receipt_json,
        verified.network.revision,
        verified.network.plan_sha256,
        verified.network.plan_json,
        verified.network.readback_at,
        verified.network.proof_sha256,
        verified.network.proof_expires_at,
        row.region_id,
        verified.network.provider_region,
        row.region_id,
        row.node_id,
        verified.network.plan_json,
        verified.network.plan_json,
        row.node_id,
        row.region_id,
        record.binding_sha256,
        record.binding_sha256,
        JSON.stringify(verified.network.firewall_leases),
        verified.network.allocation === null ? null : 1,
        verified.network.allocation?.firewall_id ?? null,
        verified.network.allocation?.state ?? null,
        verified.network.allocation?.result_json ?? null,
        verified.network.allocation?.updated_at ?? null,
      )
      .run();
    const fresh = await readBootstrapJob(env.DB, row.operation_id);
    if (
      result.meta.changes !== 1 ||
      fresh.revision !== row.revision ||
      fresh.checkpoint_json !== row.checkpoint_json
    )
      return false;
    row = fresh;
    return hasBootstrapNetworkAuthority(env, row);
  } catch {
    return false;
  }
}
async function destructiveProviderAuthority(
  env: Env,
  row: BootstrapJobRow,
  input: NodeBootstrapInput,
): Promise<DestructiveProviderAuthority> {
  const addition = await readNodeAddition(env.DB, row.operation_id),
    spec = input.spec;
  if (
    !addition.slot_held ||
    !["audited", "bootstrapping"].includes(addition.status) ||
    !addition.audit ||
    !addition.receipt ||
    addition.provider_instance_id !== spec.provider_instance_id ||
    addition.audit.provider_instance_id !== spec.provider_instance_id ||
    addition.receipt.provider_instance_id !== spec.provider_instance_id ||
    addition.intent.node_id !== row.node_id ||
    addition.intent.request.region_id !== row.region_id
  )
    throw new ApiError(
      "conflict",
      "Destructive installation authority changed",
    );
  const snapshot = await env.DB.prepare(
    "SELECT revision,provider_instance_id,intent_hash,audit_json,receipt_json FROM node_additions WHERE operation_id=?",
  )
    .bind(row.operation_id)
    .first<
      Omit<
        DestructiveProviderAuthority,
        "network" | "provider_inventory_sha256"
      >
    >();
  if (
    !snapshot ||
    snapshot.revision !== addition.revision ||
    snapshot.provider_instance_id !== spec.provider_instance_id ||
    snapshot.intent_hash !== addition.intent_hash ||
    snapshot.audit_json === null ||
    snapshot.receipt_json === null ||
    JSON.stringify(NodeProviderAudit.parse(JSON.parse(snapshot.audit_json))) !==
      JSON.stringify(addition.audit) ||
    JSON.stringify(
      NodeProviderReceipt.parse(JSON.parse(snapshot.receipt_json)),
    ) !== JSON.stringify(addition.receipt)
  )
    throw new ApiError("conflict", "Provider audit snapshot changed");
  const network = await readNodeNetworkSnapshot(env, row.operation_id);
  if (
    !network ||
    network.intent_hash !== addition.intent_hash ||
    network.status !== "verified" ||
    network.proof_sha256 === null ||
    network.proof_expires_at === null ||
    Date.parse(network.proof_expires_at) <= Date.now()
  )
    throw new ApiError(
      "conflict",
      "Network authority changed before disk write",
    );
  const actual = await contaboClient(env).getInstance(
    spec.provider_instance_id,
    {
      requestId: crypto.randomUUID(),
      accounting: { operation_id: row.operation_id, stage: "prewrite" },
    },
  );
  if (
    !hasAllocatedContaboHardware(actual) ||
    actual.id !== spec.provider_instance_id ||
    actual.region !== addition.audit.provider_region ||
    actual.productId !== addition.audit.product_id ||
    actual.imageId !== addition.audit.image_id ||
    (actual.cancelDate !== null && actual.cancelDate !== "") ||
    actual.ipConfig.v4.ip !== spec.hardware.ipv4 ||
    actual.ipConfig.v4.gateway !== spec.hardware.gateway ||
    actual.ipConfig.v4.netmaskCidr !== spec.hardware.prefix_length ||
    !hasNodeNetworkTargetAddresses(network, actual) ||
    actual.macAddress.toLowerCase() !== spec.hardware.mac.toLowerCase()
  )
    throw new ApiError(
      "conflict",
      "Provider inventory changed before disk write",
    );
  if (!(await verifyNodeFirewallSnapshot(env, network)))
    throw new ApiError(
      "conflict",
      "Provider firewall changed before disk write",
    );
  const fresh = await readBootstrapJob(env.DB, row.operation_id),
    current = await readNodeAddition(env.DB, row.operation_id);
  if (
    fresh.revision !== row.revision ||
    fresh.input_hash !== row.input_hash ||
    !fresh.authorized ||
    fresh.admitted ||
    fresh.cancelled ||
    current.revision !== addition.revision ||
    current.provider_instance_id !== addition.provider_instance_id
  )
    throw new ApiError(
      "conflict",
      "Destructive checkpoint changed concurrently",
    );
  if (
    !(await hasVerifiedNodePreparation(
      env.DB,
      row.operation_id,
      current.intent_hash,
    ))
  )
    throw new ApiError(
      "conflict",
      "Initial network proof expired before disk authorization",
    );
  return {
    ...snapshot,
    network,
    provider_inventory_sha256: await materialHash(actual),
  };
}
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
  const currentAuthority = await authority(c.env, row);
  if (!currentAuthority.authorized)
    throw new ApiError("forbidden", "Bootstrap job is closed");
  if (envelope.expected_revision !== row.revision)
    throw new ApiError("conflict", "Bootstrap checkpoint revision changed");
  const input = await bootstrapJobInput(c.env, row);
  let checkpoint = NodeBootstrapCheckpoint.parse(
      JSON.parse(row.checkpoint_json),
    ),
    ref: BootstrapCredentialRef | null = null,
    providerAuthority: DestructiveProviderAuthority | null = null;
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
    const storageChanged =
      JSON.stringify(checkpoint.storage_trial ?? null) !==
      JSON.stringify(next.storage_trial ?? null);
    if (
      !nodeStorageTrialTransition(
        checkpoint.storage_trial,
        next.storage_trial,
        row.input_hash,
      ) ||
      (next.storage_trial &&
        !checkpoint.storage_trial &&
        stages.indexOf(checkpoint.stage) <
          stages.indexOf("kubernetes_joined")) ||
      (storageChanged &&
        stages.indexOf(checkpoint.stage) >=
          stages.indexOf("awaiting_verification")) ||
      (next.stage === "awaiting_verification" &&
        next.storage_trial &&
        next.storage_trial.runs.at(-1)!.stage !== "published")
    )
      throw new ApiError(
        "conflict",
        "Storage trial cannot replace ownership or erase recorded progress",
      );
    if (
      stages.indexOf(next.stage) < stages.indexOf(checkpoint.stage) ||
      (stages.indexOf(next.stage) > stages.indexOf(checkpoint.stage) + 1 &&
        !(
          input.spec.role === "worker" &&
          ((checkpoint.stage === "talos_authenticated" &&
            next.stage === "kubernetes_joined") ||
            (checkpoint.stage === "kubernetes_joined" &&
              next.stage === "awaiting_verification"))
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
    if (!checkpoint.destructive_intent && next.destructive_intent) {
      if (
        checkpoint.stage !== "image_verified" ||
        next.stage !== "disk_write_intent"
      )
        throw new ApiError(
          "conflict",
          "Disk write intent belongs to the verified image boundary",
        );
      providerAuthority = await destructiveProviderAuthority(c.env, row, input);
    }
    checkpoint = next;
  }
  const continuation =
    providerAuthority === null
      ? null
      : await networkAuthorization(
          c.env,
          row,
          providerAuthority,
          row.revision + 1,
        );
  const result = await c.env.DB.prepare(
    `UPDATE node_bootstrap_jobs SET checkpoint_json=?,material_ref_json=COALESCE(?,material_ref_json),network_authorization_json=COALESCE(network_authorization_json,?),revision=revision+1,updated_at=?
    WHERE operation_id=? AND input_hash=? AND revision=? AND sealed_revision=? AND authorized=1 AND admitted=0 AND cancelled=0
      AND (? IS NULL OR EXISTS(SELECT 1 FROM node_additions a WHERE a.operation_id=node_bootstrap_jobs.operation_id
        AND a.revision=? AND a.provider_instance_id=? AND a.intent_hash=? AND a.audit_json=? AND a.receipt_json=?
        AND a.slot_held=1 AND a.status IN ('audited','bootstrapping')))
      AND (? IS NULL OR (
        EXISTS(SELECT 1 FROM node_network_preparations p WHERE p.operation_id=node_bootstrap_jobs.operation_id
          AND p.intent_hash=? AND p.plan_sha256=? AND p.plan_json=? AND p.revision=? AND p.status='verified'
          AND p.readback_at=? AND p.proof_sha256=? AND p.proof_expires_at=?
          AND julianday(p.proof_expires_at)>julianday('now'))
        AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM node_installation_bindings b WHERE b.operation_id=node_bootstrap_jobs.operation_id)) OR EXISTS(SELECT 1 FROM node_installation_bindings b WHERE b.operation_id=node_bootstrap_jobs.operation_id AND b.binding_sha256=?))
        AND EXISTS(SELECT 1 FROM regions r WHERE r.id=node_bootstrap_jobs.region_id
          AND r.provider='contabo' AND r.provider_region=?)
        AND NOT EXISTS(SELECT 1 FROM json_each(?) s WHERE NOT EXISTS(
          SELECT 1 FROM node_network_firewalls l WHERE l.firewall_id=json_extract(s.value,'$.firewall_id')
            AND l.operation_id=json_extract(s.value,'$.operation_id') AND l.plan_sha256=json_extract(s.value,'$.plan_sha256')
            AND l.revision=json_extract(s.value,'$.revision')))
        AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.region_id=node_bootstrap_jobs.region_id
          AND n.id<>node_bootstrap_jobs.node_id AND n.lost_at IS NULL AND NOT EXISTS(
            SELECT 1 FROM json_each(?,'$.members') m WHERE json_extract(m.value,'$.node_id')=n.id
              AND json_extract(m.value,'$.provider_instance_id')=n.provider_instance_id))
        AND NOT EXISTS(SELECT 1 FROM json_each(?,'$.members') m WHERE json_extract(m.value,'$.node_id')<>node_bootstrap_jobs.node_id
          AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.region_id=node_bootstrap_jobs.region_id AND n.lost_at IS NULL
            AND n.id=json_extract(m.value,'$.node_id') AND n.provider_instance_id=json_extract(m.value,'$.provider_instance_id')))
        AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM node_firewall_allocations f WHERE f.operation_id=node_bootstrap_jobs.operation_id))
          OR EXISTS(SELECT 1 FROM node_firewall_allocations f WHERE f.operation_id=node_bootstrap_jobs.operation_id
            AND f.firewall_id IS ? AND f.state=? AND f.result_json IS ? AND f.updated_at=?))))`,
  )
    .bind(
      JSON.stringify(checkpoint),
      ref === null ? null : JSON.stringify(ref),
      continuation === null ? null : JSON.stringify(continuation),
      new Date().toISOString(),
      operationId,
      row.input_hash,
      row.revision,
      row.sealed_revision,
      providerAuthority?.revision ?? null,
      providerAuthority?.revision ?? null,
      providerAuthority?.provider_instance_id ?? null,
      providerAuthority?.intent_hash ?? null,
      providerAuthority?.audit_json ?? null,
      providerAuthority?.receipt_json ?? null,
      providerAuthority?.network.revision ?? null,
      providerAuthority?.network.intent_hash ?? null,
      providerAuthority?.network.plan_sha256 ?? null,
      providerAuthority?.network.plan_json ?? null,
      providerAuthority?.network.revision ?? null,
      providerAuthority?.network.readback_at ?? null,
      providerAuthority?.network.proof_sha256 ?? null,
      providerAuthority?.network.proof_expires_at ?? null,
      continuation?.binding_sha256 ?? null,
      continuation?.binding_sha256 ?? null,
      providerAuthority?.network.provider_region ?? null,
      JSON.stringify(providerAuthority?.network.firewall_leases ?? []),
      providerAuthority?.network.plan_json ?? "{}",
      providerAuthority?.network.plan_json ?? "{}",
      providerAuthority?.network.allocation === null || !providerAuthority
        ? null
        : 1,
      providerAuthority?.network.allocation?.firewall_id ?? null,
      providerAuthority?.network.allocation?.state ?? null,
      providerAuthority?.network.allocation?.result_json ?? null,
      providerAuthority?.network.allocation?.updated_at ?? null,
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
