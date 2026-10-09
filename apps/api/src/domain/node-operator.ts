// SPDX-License-Identifier: Apache-2.0
import { newOperationId } from "@pgcf/contracts";
import {
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_HEADER,
  bootstrapLiteralIpSchema,
  signBootstrapRelay,
} from "@pgcf/contracts/bootstrap-relay";
import {
  NodeOperatorKubernetesBinding,
  nodeOperatorKubernetesHeaders,
} from "@pgcf/contracts/node-operator";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import {
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import { bootstrapTransportSigningKey } from "./bootstrap-relay.ts";
import { readBootstrapRelayIdentity } from "./node-inspection.ts";
import { NODE_OBSERVATION_MAX_AGE_MS } from "./placement.ts";

const closed = (): never => {
  throw new ApiError(
    "conflict",
    "Current operator node or cluster authority changed",
  );
};

/** Uses only retained schema0030 node/region/custody records. */
async function current(
  env: Env,
  nodeId: string,
  expectedUid: string,
  expectedRevision?: number,
) {
  const node = await env.DB.prepare(
    "SELECT n.region_id,n.node_uid,n.k8s_node_name,n.ready,n.lost_at,n.last_observed_at,r.bootstrap_material_revision FROM nodes n JOIN regions r ON r.id=n.region_id WHERE n.id=?",
  )
    .bind(nodeId)
    .first<{
      region_id: string;
      node_uid: string | null;
      k8s_node_name: string;
      ready: number;
      lost_at: string | null;
      last_observed_at: string | null;
      bootstrap_material_revision: number;
    }>();
  if (!node) throw new ApiError("not_found", "Node not found");
  const clock = Date.now(),
    observed = Date.parse(node.last_observed_at ?? "");
  if (
    node.node_uid !== expectedUid ||
    node.ready !== 1 ||
    node.lost_at !== null ||
    !Number.isFinite(observed) ||
    observed < clock - NODE_OBSERVATION_MAX_AGE_MS ||
    observed > clock + 5000
  )
    return closed();
  if (
    expectedRevision !== undefined &&
    node.bootstrap_material_revision !== expectedRevision
  )
    return closed();
  const reference = await loadCurrentRegionMaterialReference(
    env.DB,
    node.region_id,
    "join_bundle",
  );
  if (reference.revision !== node.bootstrap_material_revision) return closed();
  const material = await loadRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    reference,
  );
  const endpoint = new URL(material.cluster_endpoint);
  const address =
    endpoint.hostname.startsWith("[") && endpoint.hostname.endsWith("]")
      ? endpoint.hostname.slice(1, -1)
      : endpoint.hostname;
  if (
    endpoint.protocol !== "https:" ||
    endpoint.port !== "6443" ||
    endpoint.pathname !== "/" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !bootstrapLiteralIpSchema.safeParse(address).success
  )
    return closed();
  const binding = NodeOperatorKubernetesBinding.parse({
    node_uid: expectedUid,
    cluster_uid: material.kube_system_uid,
    node_name: node.k8s_node_name,
    material_revision: reference.revision,
  });
  return {
    binding,
    region: node.region_id,
    address,
    material: JSON.stringify(material),
  };
}

export async function operatorKubernetes(
  c: ApiContext,
  nodeId: string,
  nodeUid: string,
): Promise<Response> {
  await requireScope(c, "admin");
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    throw new ApiError(
      "invalid_request",
      "A Kubernetes operator WebSocket is required",
    );
  const service = c.env.BOOTSTRAP_RELAY_SERVICE;
  if (!service) throw new ApiError("conflict", "Operator relay unavailable");
  const before = await current(c.env, nodeId, nodeUid);
  const checkCurrent = async () => {
    const after = await current(
      c.env,
      nodeId,
      nodeUid,
      before.binding.material_revision,
    );
    if (JSON.stringify(after) !== JSON.stringify(before)) return closed();
  };
  const endpoint = new URL(c.env.BOOTSTRAP_RELAY_URL);
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.pathname !== BOOTSTRAP_RELAY_PATH ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    return closed();
  const signal = AbortSignal.timeout(10000);
  const identityResponse = await service.fetch(
    new Request(new URL(BOOTSTRAP_RELAY_IDENTITY_PATH, endpoint), {
      signal,
      redirect: "manual",
    }),
  );
  if (identityResponse.status !== 200) return closed();
  const identity = await readBootstrapRelayIdentity(identityResponse, signal);
  if (
    identity.region !== c.env.BOOTSTRAP_RELAY_ISSUER_REGION ||
    identity.issuer_region !== identity.region ||
    !identity.allowed_target_regions.includes(before.region) ||
    !identity.capabilities.includes("kubernetes_api")
  )
    return closed();
  await checkCurrent();
  c.set("auth", undefined);
  await requireScope(c, "admin");
  const key = await bootstrapTransportSigningKey(
    c.env.BOOTSTRAP_RELAY_SIGNING_KEYS,
  );
  // The existing relay operation field correlates this administrator request; no provisioning job is created.
  const token = await signBootstrapRelay({
    ...key,
    operation: newOperationId(),
    node: nodeId,
    region: before.region,
    issuer_region: identity.region,
    relay_epoch: identity.relay_epoch,
    revision: before.binding.material_revision,
    capability: "kubernetes_api",
    address: before.address,
  });
  await checkCurrent();
  const upstream = await service.fetch(
    new Request(endpoint, {
      signal,
      redirect: "manual",
      headers: { Upgrade: "websocket", [BOOTSTRAP_RELAY_HEADER]: token },
    }),
  );
  if (upstream.status !== 101 || !upstream.webSocket) {
    void upstream.body?.cancel().catch(() => {});
    return closed();
  }
  try {
    await checkCurrent();
    c.set("auth", undefined);
    await requireScope(c, "admin");
  } catch (error) {
    try {
      upstream.webSocket.accept();
      upstream.webSocket.close(1008, "Operator authority changed");
    } catch {
      // A peer that already closed still cannot reach the operator.
    }
    throw error;
  }
  return new Response(null, {
    status: 101,
    webSocket: upstream.webSocket,
    headers: nodeOperatorKubernetesHeaders(before.binding),
  });
}
