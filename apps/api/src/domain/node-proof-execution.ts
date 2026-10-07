// SPDX-License-Identifier: Apache-2.0
import { ErrorCode, OperationId, base64urlToBytes } from "@pgcf/contracts";
import { z } from "zod";
import {
  NodeProofExecutionInput,
  NodeProofBinding,
  NodeProofMeasurement,
  type NodeProofMode,
} from "@pgcf/contracts/node-proof";
import {
  NodeBootstrapCheckpoint,
  NodeBootstrapMaintenanceBinding,
  NodeBootstrapMaintenanceObservation,
  NodeJoinBundle,
  NodeBootstrapTransport,
  type BootstrapCapability,
} from "@pgcf/contracts/node-bootstrap";
import {
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_PROBE_PATH,
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_HEADER,
  bootstrapRelayIdentitySchema,
  bootstrapRelayProbeSchema,
  bootstrapRelayClaimsSchema,
  signBootstrapRelay,
} from "@pgcf/contracts/bootstrap-relay";
import { ApiError, DIAGNOSTIC_ID_HEADER } from "../app.ts";
import { ContaboError } from "../providers/contabo.ts";
import type { Env, ApiContext } from "../env.ts";
import { bootstrapJobInput, readBootstrapJob } from "./bootstrap-jobs.ts";
import { readNodeAddition, assertNodeRecoveryAuthority } from "./node-state.ts";
import {
  loadNodeInstallationBinding,
  readNodeInstallationProfile,
  installationHash,
} from "./node-installation.ts";
import { bootstrapTransportSigningKey } from "./bootstrap-relay.ts";
import {
  assertNodeProofSourceAuthority,
  selectNodeProofSource,
  type NodeProofSourceOptions,
} from "./node-proof-source.ts";
import {
  issueNodeProofSession,
  authenticateNodeProofRequest,
  authenticateNodeProofSession,
} from "./node-proof-session.ts";
import {
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
  loadRegionSeed,
  type BootstrapCredentialRef,
} from "../crypto/bootstrap-credentials.ts";

const deny = (): never => {
  throw new ApiError("forbidden", "Network proof execution authority changed");
};
const providerDiagnosticCode = z.enum([
  "invalid_input",
  "aborted",
  "timeout",
  "network_error",
  "body_limit",
  "invalid_response",
  "pagination_incomplete",
  "provider_rejected",
  "not_dispatched",
  "unexpected_status",
  "authorization_unavailable",
]);
export const NodeProofSourceBinding = NodeProofExecutionInput.shape.claims
  .pick({
    operation_id: true,
    binding_sha256: true,
    inspection_generation: true,
    plan_sha256: true,
    input_hash: true,
  })
  .safeExtend({ source: NodeProofExecutionInput.shape.source });
export type NodeProofSourceBinding = z.infer<typeof NodeProofSourceBinding>;
export function proofSourceBinding(
  input: NodeProofExecutionInput,
): NodeProofSourceBinding {
  const claims = input.claims;
  return NodeProofSourceBinding.parse({
    operation_id: claims.operation_id,
    binding_sha256: claims.binding_sha256,
    inspection_generation: claims.inspection_generation,
    plan_sha256: claims.plan_sha256,
    input_hash: claims.input_hash,
    source: input.source,
  });
}
export async function prepareNodeProofInput(
  env: Env,
  operationId: string,
  mode: NodeProofMode,
  options: {
    sourceBinding?: NodeProofSourceBinding;
    sourceSelection?: NodeProofSourceOptions;
  } = {},
): Promise<NodeProofExecutionInput | null> {
  OperationId.parse(operationId);
  const binding = await loadNodeInstallationBinding(env, operationId);
  if (!binding) return null;
  const addition = await readNodeAddition(env.DB, operationId);
  await assertNodeRecoveryAuthority(env.DB, addition);
  if (
    !addition.slot_held ||
    !["audited", "bootstrapping"].includes(addition.status) ||
    !binding.row.inspection_json
  )
    return null;
  const row = await readBootstrapJob(env.DB, operationId);
  if (!row.authorized || row.admitted || row.cancelled) return null;
  const checkpoint = NodeBootstrapCheckpoint.parse(
    JSON.parse(row.checkpoint_json),
  );
  if (
    mode === "postjoin" &&
    (checkpoint.stage !== "awaiting_verification" ||
      addition.checkpoint?.stage !== "joined")
  )
    return null;
  const saved = await env.DB.prepare(
    "SELECT plan_json,plan_sha256,readback_at,status FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(operationId)
    .first<{
      plan_json: string;
      plan_sha256: string;
      readback_at: string | null;
      status: string;
    }>();
  if (!saved?.readback_at || saved.status === "blocked") return null;
  const plan = NodeProofExecutionInput.shape.plan.parse(
    JSON.parse(saved.plan_json),
  );
  if (
    (await installationHash(plan)) !== saved.plan_sha256 ||
    plan.intent_hash !== addition.intent_hash ||
    plan.provider_instance_id !== addition.provider_instance_id
  )
    return deny();
  const bootstrap = await bootstrapJobInput(env, row);
  const targetProfile = await readNodeInstallationProfile(env, plan.region_id);
  let sourceImage = targetProfile?.profile.first_region?.regional_image;
  if (!sourceImage) {
    const regions = await env.DB.prepare(
      "SELECT p.region_id FROM node_installation_profiles p JOIN regions r ON r.id=p.region_id WHERE r.provider_region<>(SELECT provider_region FROM regions WHERE id=?) ORDER BY p.region_id LIMIT 16",
    )
      .bind(plan.region_id)
      .all<{ region_id: string }>();
    for (const region of regions.results) {
      const profile = await readNodeInstallationProfile(env, region.region_id);
      if (profile?.profile.first_region) {
        sourceImage = profile.profile.first_region.regional_image;
        break;
      }
    }
  }
  const association = options.sourceBinding
    ? NodeProofSourceBinding.parse(options.sourceBinding)
    : null;
  if (
    association &&
    (association.operation_id !== operationId ||
      association.binding_sha256 !== binding.row.binding_sha256 ||
      association.inspection_generation !== binding.row.inspection_generation ||
      association.plan_sha256 !== saved.plan_sha256 ||
      association.input_hash !== row.input_hash)
  )
    return deny();
  const source =
    association?.source ??
    (await selectNodeProofSource(env, operationId, plan, {
      ...options.sourceSelection,
      sourceImage,
    }));
  if (!source) return null;
  await assertNodeProofSourceAuthority(env, operationId, plan, source);
  const session = await issueNodeProofSession(env, operationId, mode);
  let cluster_bundle: NodeJoinBundle | null = null;
  if (mode === "postjoin" || bootstrap.spec.role === "worker")
    cluster_bundle = NodeJoinBundle.parse(
      await loadRegionJoinBundle(
        env.DB,
        env.CREDENTIAL_KEYS,
        await loadCurrentRegionMaterialReference(
          env.DB,
          plan.region_id,
          "join_bundle",
        ),
      ),
    );
  let talos_admin_config: string | undefined;
  if (row.material_ref_json) {
    const ref = JSON.parse(row.material_ref_json) as BootstrapCredentialRef;
    if (ref.region_id !== plan.region_id) return deny();
    const material =
      ref.purpose === "region_seed"
        ? await loadRegionSeed(env.DB, env.CREDENTIAL_KEYS, ref)
        : ref.purpose === "join_bundle"
          ? await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref)
          : null;
    if (
      !material ||
      material.cluster_name !== bootstrap.spec.cluster_name ||
      material.cluster_endpoint !== bootstrap.spec.cluster_endpoint
    )
      return deny();
    talos_admin_config = material.talos_admin_config;
  }
  let maintenance:
    ReturnType<typeof NodeBootstrapMaintenanceBinding.parse> | undefined;
  if (
    mode === "preparation" &&
    NodeBootstrapCheckpoint.shape.stage.options.indexOf(checkpoint.stage) >=
      NodeBootstrapCheckpoint.shape.stage.options.indexOf(
        "rescue_reboot_intent",
      )
  )
    maintenance = NodeBootstrapMaintenanceBinding.parse({
      input_hash: row.input_hash,
      checkpoint_revision: row.revision,
      checkpoint_stage: checkpoint.stage,
      raw_bytes: bootstrap.spec.image.raw_bytes,
      install_disk: bootstrap.spec.hardware.install_disk,
      disk_bytes: bootstrap.spec.hardware.disk_bytes,
      talos_version: "1.14.1",
    });
  return NodeProofExecutionInput.parse({
    claims: session.claims,
    session_bearer: session.bearer,
    bootstrap,
    cluster_bundle,
    ...(talos_admin_config ? { talos_admin_config } : {}),
    plan,
    binding: NodeProofBinding.parse({
      plan_sha256: saved.plan_sha256,
      readback_at: saved.readback_at,
      verification: null,
      ...(maintenance ? { maintenance } : {}),
    }),
    source,
    control_keys: session.control_keys,
    api_base_url: session.claims.origin,
  });
}
interface ProofInputStore {
  getProofInput(
    operationId: string,
    sessionId: string,
  ): Promise<NodeProofExecutionInput | null>;
}
async function context(c: ApiContext, operationId: string) {
  const claims = await authenticateNodeProofRequest(c, operationId);
  const stored = await (
    c.env.NODE_BOOTSTRAP.get(
      c.env.NODE_BOOTSTRAP.idFromName(operationId),
    ) as unknown as ProofInputStore
  ).getProofInput(operationId, claims.session_id);
  if (!stored) return deny();
  const input = NodeProofExecutionInput.parse(stored);
  if (
    input.session_bearer !== c.req.header("Authorization")?.slice(7) ||
    input.claims.mode !== claims.mode
  )
    return deny();
  return input;
}
export async function authorizeNodeProofSource(
  env: Env,
  input: NodeProofExecutionInput,
) {
  await authenticateNodeProofSession(
    env,
    input.session_bearer,
    input.claims.operation_id,
  );
  await assertNodeProofSourceAuthority(
    env,
    input.claims.operation_id,
    input.plan,
    input.source,
  );
  await authenticateNodeProofSession(
    env,
    input.session_bearer,
    input.claims.operation_id,
  );
}
function target(
  input: NodeProofExecutionInput,
  capability: BootstrapCapability,
  direction: "target" | "source",
) {
  if (direction === "source") {
    const source = input.source;
    if (source.kind === "rescue" && capability === "rescue_ssh")
      return {
        ip: source.ipv4,
        port: 22 as const,
        node: source.node_id,
        region: source.region_id,
      };
    if (source.kind === "pod" && capability === "kubernetes_api")
      return {
        ip: new URL(source.access.join_bundle.cluster_endpoint).hostname,
        port: 6443 as const,
        node: source.node_id,
        region: source.region_id,
      };
    return deny();
  }
  const spec = input.bootstrap.spec;
  if (capability === "rescue_ssh" && input.claims.mode !== "preparation")
    return deny();
  return {
    ip:
      capability === "kubernetes_api"
        ? new URL(spec.cluster_endpoint).hostname
        : spec.hardware.ipv4,
    port:
      capability === "rescue_ssh"
        ? (22 as const)
        : capability === "talos_api"
          ? (50000 as const)
          : (6443 as const),
    node: spec.node_id,
    region: spec.region_id,
  };
}
async function relayIdentity(env: Env) {
  if (!env.BOOTSTRAP_RELAY_SERVICE) return deny();
  const response = await env.BOOTSTRAP_RELAY_SERVICE.fetch(
    new URL(BOOTSTRAP_RELAY_IDENTITY_PATH, env.BOOTSTRAP_RELAY_URL),
    { signal: AbortSignal.timeout(10000) },
  );
  const bytes = await boundedBody(response, 16384);
  if (!response.ok) return deny();
  const identity = bootstrapRelayIdentitySchema.parse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  if (
    identity.region !== env.BOOTSTRAP_RELAY_ISSUER_REGION ||
    identity.issuer_region !== env.BOOTSTRAP_RELAY_ISSUER_REGION
  )
    return deny();
  return identity;
}
async function boundedBody(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const signal = AbortSignal.timeout(10000);
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () =>
      reject(new ApiError("forbidden", "Network proof readback timed out"));
    signal.addEventListener("abort", abort, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const value = await Promise.race([reader.read(), stopped]);
      if (value.done) break;
      length += value.value.byteLength;
      if (length > maximum) return deny();
      chunks.push(value.value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}
export async function issueNodeProofTransport(
  c: ApiContext,
  operationId: string,
  capability: BootstrapCapability,
  direction: "target" | "source",
) {
  let stage:
    | "context"
    | "source_authority"
    | "expected_target"
    | "relay_identity"
    | "relay_scope"
    | "signing_key"
    | "sign_relay"
    | "session_recheck"
    | "response_schema" = "context";
  try {
    const input = await context(c, operationId);
    if (direction === "source") {
      stage = "source_authority";
      await authorizeNodeProofSource(c.env, input);
    }
    stage = "expected_target";
    const expected = target(input, capability, direction);
    stage = "relay_identity";
    const identity = await relayIdentity(c.env);
    stage = "relay_scope";
    if (
      !identity.allowed_target_regions.includes(expected.region) ||
      !identity.capabilities.includes(capability)
    )
      return deny();
    stage = "signing_key";
    const signing = await bootstrapTransportSigningKey(
      c.env.BOOTSTRAP_RELAY_SIGNING_KEYS,
    );
    stage = "sign_relay";
    const token = await signBootstrapRelay({
      privateKey: signing.privateKey,
      kid: signing.kid,
      operation: operationId,
      node: expected.node,
      region: expected.region,
      issuer_region: identity.issuer_region,
      relay_epoch: identity.relay_epoch,
      revision: input.claims.inspection_generation + 1,
      capability,
      address: expected.ip,
      ttlSeconds: 30,
    });
    stage = "session_recheck";
    await authenticateNodeProofRequest(c, operationId);
    stage = "response_schema";
    return NodeBootstrapTransport.parse({
      token,
      expectedTarget: { ip: expected.ip, port: expected.port },
      websocket_url: `${input.api_base_url.replace(/^https:/, "wss:")}/internal/v1/node-proof/${operationId}/relay`,
    });
  } catch (error) {
    // Diagnostics must never replace the original transport failure.
    try {
      const diagnosticId = c.res.headers.get(DIAGNOSTIC_ID_HEADER),
        code =
          error instanceof ApiError ? ErrorCode.safeParse(error.code) : null,
        providerCode =
          error instanceof ContaboError
            ? providerDiagnosticCode.safeParse(error.code)
            : null,
        providerStatus =
          error instanceof ContaboError &&
          typeof error.status === "number" &&
          Number.isInteger(error.status) &&
          error.status >= 100 &&
          error.status <= 599
            ? error.status
            : undefined;
      if (
        diagnosticId &&
        /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(diagnosticId)
      )
        console.error(
          JSON.stringify({
            event: "node_proof_transport_failed",
            stage,
            category:
              error instanceof ApiError
                ? "api_error"
                : error instanceof ContaboError
                  ? "provider_error"
                  : error instanceof z.ZodError
                    ? "schema_error"
                    : error instanceof TypeError
                      ? "type_error"
                      : error instanceof Error
                        ? "error"
                        : "unknown",
            ...(code?.success ? { code: code.data } : {}),
            ...(providerCode?.success
              ? { provider_code: providerCode.data }
              : {}),
            ...(providerStatus !== undefined
              ? { provider_status: providerStatus }
              : {}),
            diagnostic_id: diagnosticId,
          }),
        );
    } catch {
      // The original error remains authoritative if logging is unavailable.
    }
    throw error;
  }
}
export async function relayNodeProof(c: ApiContext, operationId: string) {
  const input = await context(c, operationId),
    token = c.req.header(BOOTSTRAP_RELAY_HEADER);
  if (
    c.req.header("Upgrade")?.toLowerCase() !== "websocket" ||
    !token ||
    token.length > 2048 ||
    !/^br1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
    !c.env.BOOTSTRAP_RELAY_SERVICE
  )
    return deny();
  const raw = base64urlToBytes(token.split(".")[1]!);
  if (!raw) return deny();
  const claims = bootstrapRelayClaimsSchema.parse(
    JSON.parse(new TextDecoder().decode(raw)),
  );
  const allowed = ["target", "source"].some((direction) => {
    try {
      const expected = target(
        input,
        claims.capability,
        direction as "target" | "source",
      );
      return (
        expected.ip === claims.target.address &&
        expected.port === claims.target.port &&
        expected.node === claims.node &&
        expected.region === claims.region
      );
    } catch {
      return false;
    }
  });
  if (
    !allowed ||
    claims.operation !== operationId ||
    claims.revision !== input.claims.inspection_generation + 1
  )
    return deny();
  await authorizeNodeProofSource(c.env, input);
  await authenticateNodeProofRequest(c, operationId);
  return c.env.BOOTSTRAP_RELAY_SERVICE.fetch(
    new Request(new URL(BOOTSTRAP_RELAY_PATH, c.env.BOOTSTRAP_RELAY_URL), {
      headers: { Upgrade: "websocket", [BOOTSTRAP_RELAY_HEADER]: token },
    }),
  );
}

export async function collectNodeProofAccess(
  c: ApiContext,
  operationId: string,
  raw: { binding: unknown; maintenance_observation?: unknown },
) {
  const input = await context(c, operationId);
  if (input.claims.mode !== "preparation") return deny();
  const binding = NodeProofBinding.parse(raw.binding);
  if (
    binding.plan_sha256 !== input.binding.plan_sha256 ||
    binding.readback_at !== input.binding.readback_at ||
    binding.verification !== null ||
    JSON.stringify(binding.maintenance ?? null) !==
      JSON.stringify(input.binding.maintenance ?? null)
  )
    return deny();
  const identity = await relayIdentity(c.env),
    signing = await bootstrapTransportSigningKey(
      c.env.BOOTSTRAP_RELAY_SIGNING_KEYS,
    );
  if (
    !identity.allowed_target_regions.includes(input.plan.region_id) ||
    ["rescue_ssh", "talos_api", "kubernetes_api"].some(
      (capability) =>
        !identity.capabilities.includes(capability as BootstrapCapability),
    )
  )
    return deny();
  const access = [];
  for (const member of input.plan.members) {
    const address = member.addresses.ipv4[0];
    if (!address) return deny();
    const checks = [];
    let source: string | undefined;
    let observedAt = Number.POSITIVE_INFINITY;
    for (const capability of [
      "rescue_ssh",
      "talos_api",
      "kubernetes_api",
    ] as const) {
      const token = await signBootstrapRelay({
        privateKey: signing.privateKey,
        kid: signing.kid,
        operation: operationId,
        node: member.node_id,
        region: input.plan.region_id,
        issuer_region: identity.issuer_region,
        relay_epoch: identity.relay_epoch,
        revision: input.claims.inspection_generation + 1,
        capability,
        address,
        ttlSeconds: 30,
      });
      await authenticateNodeProofRequest(c, operationId);
      const response = await c.env.BOOTSTRAP_RELAY_SERVICE!.fetch(
        new Request(
          new URL(BOOTSTRAP_RELAY_PROBE_PATH, c.env.BOOTSTRAP_RELAY_URL),
          {
            headers: { [BOOTSTRAP_RELAY_HEADER]: token },
            signal: AbortSignal.timeout(5000),
          },
        ),
      );
      const bytes = await boundedBody(response, 4096);
      if (!response.ok) return deny();
      const probe = bootstrapRelayProbeSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      if (
        probe.operation_id !== operationId ||
        probe.node_id !== member.node_id ||
        probe.address !== address ||
        probe.region_id !== input.plan.region_id ||
        probe.revision !== input.claims.inspection_generation + 1 ||
        probe.port !==
          (capability === "rescue_ssh"
            ? 22
            : capability === "talos_api"
              ? 50000
              : 6443) ||
        probe.relay_epoch !== identity.relay_epoch ||
        Date.parse(probe.observed_at) < Date.now() - 120000 ||
        Date.parse(probe.observed_at) > Date.now() + 5000 ||
        !input.plan.relay.addresses.ipv4.includes(probe.source) ||
        (source && source !== probe.source)
      )
        return deny();
      source = probe.source;
      observedAt = Math.min(observedAt, Date.parse(probe.observed_at));
      checks.push({ port: probe.port, outcome: probe.outcome });
    }
    if (!source || !checks.some((check) => check.outcome === "connected"))
      return deny();
    let maintenance;
    if (
      member.provider_instance_id === input.plan.provider_instance_id &&
      binding.maintenance
    ) {
      maintenance = NodeBootstrapMaintenanceObservation.parse(
        raw.maintenance_observation,
      );
      if (
        JSON.stringify({ ...maintenance, observed_at: undefined }) !==
          JSON.stringify({ ...binding.maintenance, observed_at: undefined }) ||
        Date.parse(maintenance.observed_at) < Date.now() - 120000 ||
        Date.parse(maintenance.observed_at) > Date.now() + 5000 ||
        !checks.some(
          (check) => check.port === 50000 && check.outcome === "connected",
        )
      )
        return deny();
    }
    access.push({
      provider_instance_id: member.provider_instance_id,
      address,
      relay_source: source,
      observed_at: new Date(observedAt).toISOString(),
      checks,
      ...(maintenance ? { talos_maintenance: maintenance } : {}),
    });
  }
  await authenticateNodeProofRequest(c, operationId);
  return NodeProofMeasurement.parse({
    purpose: "pgcf-node-measurement/v1",
    kind: "access",
    binding_sha256: await installationHash(binding),
    access,
    observed_at: new Date().toISOString(),
  });
}
