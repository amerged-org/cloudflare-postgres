// SPDX-License-Identifier: Apache-2.0
import { OperationId, base64urlToBytes } from "@pgcf/contracts";
import {
  NodeInspectionInput,
  NodeInstallationInspection,
} from "@pgcf/contracts/node-installation";
import { NodeBootstrapTransport } from "@pgcf/contracts/node-bootstrap";
import {
  BOOTSTRAP_RELAY_HEADER,
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH,
  bootstrapRelayIdentitySchema,
  bootstrapRelayClaimsSchema,
  signBootstrapRelay,
} from "@pgcf/contracts/bootstrap-relay";
import { z } from "zod";
import { readSelectedNodeGoldenImage } from "./node-golden-image.ts";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import {
  contaboClient,
  bootstrapTransportSigningKey,
} from "./bootstrap-relay.ts";
import {
  hasAllocatedContaboHardware,
  type ContaboClient,
} from "../providers/contabo.ts";
import { readNodeAddition, assertNodeRecoveryAuthority } from "./node-state.ts";
import {
  loadNodeInstallationBinding,
  readNodeInstallationProfile,
  installationHash,
  authenticateNodeInstallationInspection,
} from "./node-installation.ts";
import { ensureNodeFirewall, type NodeNetworkOptions } from "./node-network.ts";

const deny = (): never => {
  throw new ApiError(
    "forbidden",
    "Installation inspection authority is unavailable or changed",
  );
};
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Plan = z.looseObject({
  operation_id: OperationId,
  node_id: z.string(),
  region_id: z.string(),
  provider_instance_id: z.string(),
  intent_hash: Hash,
  relay: z.looseObject({
    provider_instance_id: z.string(),
    addresses: z.looseObject({ ipv4: z.array(z.ipv4()) }),
  }),
  members: z
    .array(
      z.looseObject({
        node_id: z.string(),
        provider_instance_id: z.string(),
        firewall_id: z.uuid(),
        addresses: z.looseObject({
          ipv4: z.array(z.ipv4()),
          ipv6: z.array(z.ipv6()).optional(),
        }),
      }),
    )
    .min(1)
    .max(16),
});
export interface InspectionOptions {
  provider?: Pick<ContaboClient, "getInstance">;
  network?: NodeNetworkOptions;
  now?: () => number;
}

/** Preflight has its own identity and permits only known-host rescue inspection, never installation. */
export async function prepareNodeInspectionInput(
  env: Env,
  operationId: string,
  options: InspectionOptions = {},
): Promise<NodeInspectionInput | null> {
  OperationId.parse(operationId);
  const addition = await readNodeAddition(env.DB, operationId);
  await assertNodeRecoveryAuthority(env.DB, addition);
  if (
    !addition.slot_held ||
    !addition.audit ||
    !addition.provider_instance_id ||
    !["audited", "bootstrapping"].includes(addition.status)
  )
    return null;
  if (
    await env.DB.prepare(
      "SELECT 1 present FROM node_bootstrap_jobs WHERE operation_id=?",
    )
      .bind(operationId)
      .first()
  )
    return null;
  const binding = await loadNodeInstallationBinding(env, operationId),
    profile = await readNodeInstallationProfile(
      env,
      addition.intent.request.region_id,
    );
  if (
    !binding ||
    !profile ||
    binding.row.node_id !== addition.intent.node_id ||
    binding.row.provider_instance_id !== addition.provider_instance_id ||
    profile.profile_sha256 !== binding.row.profile_sha256 ||
    profile.profile.provider_product_id !== addition.audit.product_id ||
    profile.profile.relay_issuer_region_id !== env.BOOTSTRAP_RELAY_ISSUER_REGION
  )
    return deny();
  if (!(await ensureNodeFirewall(env, operationId, options.network)))
    return null;
  const saved = await env.DB.prepare(
    "SELECT plan_json,plan_sha256,status,readback_at FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(operationId)
    .first<{
      plan_json: string;
      plan_sha256: string;
      status: string;
      readback_at: string | null;
    }>();
  if (!saved || saved.status === "blocked" || !saved.readback_at) return null;
  const raw: unknown = JSON.parse(saved.plan_json),
    plan = Plan.safeParse(raw);
  if (
    !plan.success ||
    (await installationHash(raw)) !== saved.plan_sha256 ||
    plan.data.operation_id !== operationId ||
    plan.data.node_id !== addition.intent.node_id ||
    plan.data.region_id !== binding.row.region_id ||
    plan.data.provider_instance_id !== addition.provider_instance_id ||
    plan.data.intent_hash !== addition.intent_hash ||
    plan.data.relay.provider_instance_id !==
      env.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID
  )
    return deny();
  const member = plan.data.members.find(
    (candidate) => candidate.node_id === addition.intent.node_id,
  );
  if (
    !member ||
    member.provider_instance_id !== addition.provider_instance_id ||
    member.firewall_id !== binding.row.firewall_id
  )
    return deny();
  const actual = await (options.provider ?? contaboClient(env)).getInstance(
    addition.provider_instance_id,
    {
      requestId: crypto.randomUUID(),
      accounting: { operation_id: operationId, stage: "inspection" },
    },
  );
  if (!hasAllocatedContaboHardware(actual) || actual.status !== "rescue")
    return null;
  if (
    actual.id !== addition.provider_instance_id ||
    actual.region !== addition.audit.provider_region ||
    actual.productId !== addition.audit.product_id ||
    actual.imageId !== addition.audit.image_id ||
    (addition.intent.request.mode === "order" &&
      actual.displayName !== addition.intent.requested_hostname) ||
    !member.addresses.ipv4.includes(actual.ipConfig.v4.ip)
  )
    return deny();
  const base = new URL(env.NODE_BOOTSTRAP_CALLBACK_URL);
  const providerIpv6 = actual.ipConfig.v6;
  if (
    providerIpv6?.ip &&
    !member.addresses.ipv6?.includes(
      new URL(`https://[${providerIpv6.ip}]`).hostname.slice(1, -1),
    )
  )
    return deny();
  if (
    base.protocol !== "https:" ||
    base.pathname !== "/" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    return deny();
  const now = (options.now ?? Date.now)();
  return NodeInspectionInput.parse({
    version: 1,
    operation_id: operationId,
    node_id: addition.intent.node_id,
    region_id: binding.row.region_id,
    provider_instance_id: actual.id,
    profile_sha256: profile.profile_sha256,
    binding_sha256: binding.row.binding_sha256,
    network_plan_sha256: saved.plan_sha256,
    expected_generation: binding.row.inspection_generation,
    deadline_at: new Date(now + 540000).toISOString(),
    expected_network: {
      mac: actual.macAddress.toLowerCase(),
      ipv4: actual.ipConfig.v4.ip,
      prefix_length: actual.ipConfig.v4.netmaskCidr,
      gateway: actual.ipConfig.v4.gateway,
      ...(providerIpv6?.ip
        ? {
            ipv6: {
              address: new URL(`https://[${providerIpv6.ip}]`).hostname.slice(
                1,
                -1,
              ),
              prefix_length: providerIpv6.netmaskCidr,
              ...(providerIpv6.gateway
                ? { gateway: providerIpv6.gateway }
                : {}),
            },
          }
        : {}),
    },
    dns: profile.profile.dns,
    golden_image:
      (await readSelectedNodeGoldenImage(env, binding.row.region_id)) ??
      undefined,
    peer_ipv4: [
      ...new Set([
        ...plan.data.relay.addresses.ipv4,
        ...plan.data.members
          .filter((peer) => peer.node_id !== addition.intent.node_id)
          .flatMap((peer) => peer.addresses.ipv4),
      ]),
    ]
      .filter((ip) => ip !== actual.ipConfig.v4.ip)
      .sort(),
    rescue: {
      ssh_private_key: binding.rescue.ssh_private_key,
      ssh_host_key: binding.rescue.ssh_host_key,
      ssh_host_fingerprint: binding.rescue.ssh_host_fingerprint,
    },
    callback: {
      url: new URL(
        `/internal/v1/node-installation/${operationId}/inspection`,
        base,
      ).href,
      bearer: binding.inspection_token,
    },
    transport_url: new URL(
      `/internal/v1/node-installation/${operationId}/transport`,
      base,
    ).href,
    relay_url: new URL(
      `/internal/v1/node-installation/${operationId}/relay`,
      base.href.replace(/^https:/, "wss:"),
    ).href,
  });
}

/** Routine inspection capabilities use the stored lifecycle mapping and current CF authority. */
export async function assertNodeInspectionInputCurrent(
  env: Env,
  operationId: string,
  input: NodeInspectionInput,
): Promise<void> {
  OperationId.parse(operationId);
  const parsed = NodeInspectionInput.safeParse(input);
  if (!parsed.success) return deny();
  const value = parsed.data,
    now = Date.now();
  if (
    value.operation_id !== operationId ||
    Date.parse(value.deadline_at) <= now ||
    Date.parse(value.deadline_at) > now + 540000
  )
    return deny();
  const addition = await readNodeAddition(env.DB, operationId);
  await assertNodeRecoveryAuthority(env.DB, addition);
  if (
    !addition.slot_held ||
    !addition.audit ||
    !addition.provider_instance_id ||
    !["audited", "bootstrapping"].includes(addition.status) ||
    value.node_id !== addition.intent.node_id ||
    value.region_id !== addition.intent.request.region_id ||
    value.provider_instance_id !== addition.provider_instance_id ||
    addition.audit.provider_instance_id !== value.provider_instance_id ||
    (await env.DB.prepare(
      "SELECT 1 present FROM node_bootstrap_jobs WHERE operation_id=?",
    )
      .bind(operationId)
      .first())
  )
    return deny();
  if (
    (await installationHash(value.golden_image ?? null)) !==
    (await installationHash(
      await readSelectedNodeGoldenImage(env, value.region_id),
    ))
  )
    return deny();
  const binding = await loadNodeInstallationBinding(env, operationId),
    installed = await readNodeInstallationProfile(env, value.region_id);
  if (
    !binding ||
    !installed ||
    binding.row.node_id !== value.node_id ||
    binding.row.region_id !== value.region_id ||
    binding.row.provider_instance_id !== value.provider_instance_id ||
    binding.row.binding_sha256 !== value.binding_sha256 ||
    binding.row.profile_sha256 !== value.profile_sha256 ||
    installed.profile_sha256 !== value.profile_sha256 ||
    binding.row.inspection_generation !== value.expected_generation ||
    installed.profile.provider_product_id !== addition.audit.product_id ||
    installed.profile.relay_issuer_region_id !==
      env.BOOTSTRAP_RELAY_ISSUER_REGION ||
    installed.profile.rescue_client_private_key !==
      value.rescue.ssh_private_key ||
    binding.rescue.ssh_private_key !== value.rescue.ssh_private_key ||
    binding.rescue.ssh_host_key !== value.rescue.ssh_host_key ||
    binding.rescue.ssh_host_fingerprint !== value.rescue.ssh_host_fingerprint ||
    binding.inspection_token !== value.callback.bearer ||
    (await installationHash(installed.profile.dns)) !==
      (await installationHash(value.dns))
  )
    return deny();
  const saved = await env.DB.prepare(
    "SELECT plan_json,plan_sha256,status,readback_at FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(operationId)
    .first<{
      plan_json: string;
      plan_sha256: string;
      status: string;
      readback_at: string | null;
    }>();
  if (
    !saved ||
    saved.status === "blocked" ||
    !saved.readback_at ||
    saved.plan_sha256 !== value.network_plan_sha256
  )
    return deny();
  const raw: unknown = JSON.parse(saved.plan_json),
    plan = Plan.safeParse(raw);
  if (
    !plan.success ||
    (await installationHash(raw)) !== value.network_plan_sha256 ||
    plan.data.operation_id !== operationId ||
    plan.data.node_id !== value.node_id ||
    plan.data.region_id !== value.region_id ||
    plan.data.provider_instance_id !== value.provider_instance_id ||
    plan.data.intent_hash !== addition.intent_hash ||
    plan.data.relay.provider_instance_id !==
      env.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID
  )
    return deny();
  const member = plan.data.members.find(
    (candidate) => candidate.node_id === value.node_id,
  );
  if (
    !member ||
    member.provider_instance_id !== value.provider_instance_id ||
    member.firewall_id !== binding.row.firewall_id ||
    !member.addresses.ipv4.includes(value.expected_network.ipv4) ||
    (value.expected_network.ipv6 &&
      !member.addresses.ipv6?.includes(value.expected_network.ipv6.address))
  )
    return deny();
  const peers = [
    ...new Set([
      ...plan.data.relay.addresses.ipv4,
      ...plan.data.members
        .filter((peer) => peer.node_id !== value.node_id)
        .flatMap((peer) => peer.addresses.ipv4),
    ]),
  ]
    .filter((ip) => ip !== value.expected_network.ipv4)
    .sort();
  const base = new URL(env.NODE_BOOTSTRAP_CALLBACK_URL);
  if (
    base.protocol !== "https:" ||
    base.pathname !== "/" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    value.callback.url !==
      new URL(`/internal/v1/node-installation/${operationId}/inspection`, base)
        .href ||
    value.transport_url !==
      new URL(`/internal/v1/node-installation/${operationId}/transport`, base)
        .href ||
    value.relay_url !==
      new URL(
        `/internal/v1/node-installation/${operationId}/relay`,
        base.href.replace(/^https:/, "wss:"),
      ).href ||
    (await installationHash(peers)) !==
      (await installationHash(value.peer_ipv4))
  )
    return deny();
}
interface InspectionInputStore {
  getInspectionInput(operationId: string): Promise<NodeInspectionInput | null>;
}
async function storedInspectionInput(env: Env, operationId: string) {
  const stored = await (
    env.NODE_BOOTSTRAP.get(
      env.NODE_BOOTSTRAP.idFromName(operationId),
    ) as unknown as InspectionInputStore
  ).getInspectionInput(operationId);
  if (!stored) return deny();
  const input = NodeInspectionInput.parse(stored);
  await assertNodeInspectionInputCurrent(env, operationId, input);
  return input;
}

export async function readBootstrapRelayIdentity(
  response: Response,
  signal: AbortSignal,
) {
  if (!response.ok || !response.body) return deny();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 16384) return deny();
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of chunks) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const parsed = bootstrapRelayIdentitySchema.safeParse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    );
    if (!parsed.success) return deny();
    return parsed.data;
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

async function assertCurrentInspection(env: Env, input: NodeInspectionInput) {
  await assertNodeInspectionInputCurrent(env, input.operation_id, input);
}

export async function issueNodeInspectionTransport(
  env: Env,
  operationId: string,
  expectedGeneration: number,
): Promise<NodeBootstrapTransport> {
  const binding = await loadNodeInstallationBinding(env, operationId);
  if (!binding || binding.row.inspection_generation !== expectedGeneration)
    return deny();
  const input = await storedInspectionInput(env, operationId);
  if (
    !input ||
    input.expected_generation !== expectedGeneration ||
    !env.BOOTSTRAP_RELAY_SERVICE
  )
    return deny();
  const relay = new URL(env.BOOTSTRAP_RELAY_URL);
  if (
    !["https:", "http:"].includes(relay.protocol) ||
    relay.username ||
    relay.password ||
    relay.search ||
    relay.hash
  )
    return deny();
  const signal = AbortSignal.timeout(10000);
  const identity = await readBootstrapRelayIdentity(
    await env.BOOTSTRAP_RELAY_SERVICE.fetch(
      new URL(BOOTSTRAP_RELAY_IDENTITY_PATH, relay),
      { signal },
    ),
    signal,
  );
  if (
    identity.region !== env.BOOTSTRAP_RELAY_ISSUER_REGION ||
    identity.issuer_region !== env.BOOTSTRAP_RELAY_ISSUER_REGION ||
    !identity.allowed_target_regions.includes(input.region_id) ||
    !identity.capabilities.includes("rescue_ssh")
  )
    return deny();
  const signing = await bootstrapTransportSigningKey(
    env.BOOTSTRAP_RELAY_SIGNING_KEYS,
  );
  const token = await signBootstrapRelay({
    privateKey: signing.privateKey,
    kid: signing.kid,
    operation: operationId,
    node: input.node_id,
    region: input.region_id,
    issuer_region: identity.issuer_region,
    relay_epoch: identity.relay_epoch,
    revision: expectedGeneration + 1,
    capability: "rescue_ssh",
    address: input.expected_network.ipv4,
    ttlSeconds: 30,
  });
  await assertCurrentInspection(env, input);
  return NodeBootstrapTransport.parse({
    token,
    websocket_url: input.relay_url,
    expectedTarget: { ip: input.expected_network.ipv4, port: 22 },
  });
}

export async function relayNodeInspection(
  c: ApiContext,
  operationId: string,
): Promise<Response> {
  const binding = await authenticateNodeInstallationInspection(c, operationId);
  const token = c.req.header(BOOTSTRAP_RELAY_HEADER);
  if (
    c.req.header("Upgrade")?.toLowerCase() !== "websocket" ||
    !token ||
    token.length > BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH ||
    !/^br1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
    !c.env.BOOTSTRAP_RELAY_SERVICE
  )
    return deny();
  let claims: z.infer<typeof bootstrapRelayClaimsSchema>;
  try {
    claims = bootstrapRelayClaimsSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          base64urlToBytes(token.split(".")[1]!)!,
        ),
      ),
    );
  } catch {
    return deny();
  }
  const input = await storedInspectionInput(c.env, operationId);
  if (
    !input ||
    input.expected_generation !== binding.inspection_generation ||
    claims.operation !== operationId ||
    claims.node !== binding.node_id ||
    claims.region !== binding.region_id ||
    claims.revision !== input.expected_generation + 1 ||
    claims.capability !== "rescue_ssh" ||
    claims.target.port !== 22 ||
    claims.target.address !== input.expected_network.ipv4
  )
    return deny();
  await assertCurrentInspection(c.env, input);
  return c.env.BOOTSTRAP_RELAY_SERVICE.fetch(
    new Request(new URL(BOOTSTRAP_RELAY_PATH, c.env.BOOTSTRAP_RELAY_URL), {
      headers: { Upgrade: "websocket", [BOOTSTRAP_RELAY_HEADER]: token },
    }),
  );
}

/** Root Workflow calls this before composition. A confirmed report, not dispatch, completes inspection. */
export async function ensureNodeInstallationInspection(
  env: Env,
  operationId: string,
): Promise<boolean> {
  const binding = await loadNodeInstallationBinding(env, operationId);
  if (!binding) return false;
  if (binding.row.inspection_json) {
    const parsed = NodeInstallationInspection.safeParse(
      JSON.parse(binding.row.inspection_json),
    );
    if (
      parsed.success &&
      Date.now() - Date.parse(parsed.data.observed_at) <= 120000 &&
      Date.parse(parsed.data.observed_at) <= Date.now() + 5000
    )
      return true;
  }
  await env.NODE_BOOTSTRAP.get(
    env.NODE_BOOTSTRAP.idFromName(operationId),
  ).inspect(operationId);
  return false;
}
