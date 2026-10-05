// SPDX-License-Identifier: Apache-2.0
import { base64urlToBytes, RegionId } from "@pgcf/contracts";
import {
  BOOTSTRAP_PORTS,
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_PATH,
  bootstrapRelayIdentitySchema,
  signBootstrapRelay,
  type BootstrapCapability,
} from "@pgcf/contracts/bootstrap-relay";
import { NodeBootstrapTransport } from "@pgcf/contracts/node-bootstrap";
import { z } from "zod";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import { ContaboClient } from "../providers/contabo.ts";
import {
  bootstrapJobInput,
  admissionAuthority,
  type BootstrapJobRow,
} from "./bootstrap-jobs.ts";
import { readNodeAddition } from "./node-state.ts";
import { hasVerifiedNodePreparation } from "./node-network.ts";

export function contaboClient(env: Env) {
  return new ContaboClient({
    clientId: env.CONTABO_CLIENT_ID,
    clientSecret: env.CONTABO_CLIENT_SECRET,
    username: env.CONTABO_USERNAME,
    password: env.CONTABO_PASSWORD,
    maxPages: 4,
    pageSize: 100,
    timeoutMs: 20_000,
  });
}
const SigningKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
const SigningConfig = z.strictObject({
  active: SigningKey,
  keys: z.record(SigningKey, z.string().max(256)),
});
async function signingKey(secret: string) {
  const config = SigningConfig.parse(JSON.parse(secret)),
    bytes = base64urlToBytes(config.keys[config.active] ?? "");
  if (!bytes || bytes.length < 32 || bytes.length > 192)
    throw new Error("bootstrap_signing_key_invalid");
  return {
    kid: config.active,
    privateKey: await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(bytes),
      "Ed25519",
      false,
      ["sign"],
    ),
  };
}
export async function issueBootstrapTransport(
  env: Env,
  row: BootstrapJobRow,
  payload: { capability: BootstrapCapability },
  provider?: Pick<ContaboClient, "getInstance">,
): Promise<NodeBootstrapTransport> {
  const addition = await readNodeAddition(env.DB, row.operation_id);
  if (
    !(await admissionAuthority(env, row)).admission_authorized &&
    !(await hasVerifiedNodePreparation(
      env.DB,
      row.operation_id,
      addition.intent_hash,
    ))
  )
    throw new ApiError(
      "forbidden",
      "Verified network preparation is required for native installation",
    );
  if (
    !row.authorized ||
    row.admitted ||
    row.cancelled ||
    !addition.audit ||
    addition.provider_instance_id === null ||
    !["audited", "bootstrapping"].includes(addition.status)
  )
    throw new ApiError("forbidden", "Bootstrap transport authority is closed");
  const input = await bootstrapJobInput(env, row),
    spec = input.spec,
    checkpoint = JSON.parse(row.checkpoint_json) as { stage: string };
  if (
    spec.transport.mode !== "relay" ||
    spec.transport.issuer_region_id !== env.BOOTSTRAP_RELAY_ISSUER_REGION ||
    !env.BOOTSTRAP_RELAY_SERVICE
  )
    throw new ApiError("forbidden", "Trusted bootstrap relay is unavailable");
  RegionId.parse(env.BOOTSTRAP_RELAY_ISSUER_REGION);
  const relayUrl = new URL(env.BOOTSTRAP_RELAY_URL);
  if (
    !["https:", "http:"].includes(relayUrl.protocol) ||
    relayUrl.username ||
    relayUrl.password ||
    relayUrl.search ||
    relayUrl.hash ||
    relayUrl.pathname !== BOOTSTRAP_RELAY_PATH
  )
    throw new Error("bootstrap_relay_configuration_invalid");
  const response = await env.BOOTSTRAP_RELAY_SERVICE.fetch(
    new Request(new URL(BOOTSTRAP_RELAY_IDENTITY_PATH, relayUrl.href), {
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    }),
  );
  if (response.status !== 200 || response.body === null)
    throw new ApiError("conflict", "Trusted relay identity is unavailable");
  const reader = response.body.getReader(),
    bytes = new Uint8Array(2048);
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > bytes.length - length)
        throw new ApiError("conflict", "Trusted relay identity is invalid");
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes.subarray(0, length),
      ),
    );
  } catch {
    throw new ApiError("conflict", "Trusted relay identity is invalid");
  }
  const parsed = bootstrapRelayIdentitySchema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("conflict", "Trusted relay identity is invalid");
  const identity = parsed.data;
  if (
    !identity.allowed_target_regions.includes(row.region_id) ||
    !identity.capabilities.includes(payload.capability) ||
    identity.region !== env.BOOTSTRAP_RELAY_ISSUER_REGION ||
    identity.issuer_region !== env.BOOTSTRAP_RELAY_ISSUER_REGION
  )
    throw new ApiError(
      "conflict",
      "Trusted relay identity is outside the configured operation scope",
    );
  const instance = await (provider ?? contaboClient(env)).getInstance(
    addition.provider_instance_id,
    { requestId: crypto.randomUUID() },
  );
  if (
    instance.id !== spec.provider_instance_id ||
    instance.region !== addition.audit.provider_region ||
    instance.productId !== addition.audit.product_id ||
    instance.ipConfig.v4.ip !== spec.hardware.ipv4
  )
    throw new ApiError(
      "conflict",
      "Actual provider address or approved inventory changed",
    );
  let address: string;
  if (payload.capability === "rescue_ssh") {
    if (
      !row.rescue_active ||
      [
        "talos_maintenance",
        "config_prepared",
        "config_apply_intent",
        "config_applied",
        "talos_reboot_intent",
        "talos_authenticated",
        "kubernetes_bootstrap_intent",
        "kubernetes_joined",
        "cilium_install_intent",
        "cilium_installed",
        "flux_install_intent",
        "flux_installed",
        "platform_sync_intent",
        "platform_ready",
        "regional_install_intent",
        "regional_ready",
        "awaiting_verification",
        "quarantine_release_intent",
        "quarantine_released",
      ].includes(checkpoint.stage)
    )
      throw new ApiError(
        "forbidden",
        "Rescue transport is not authorized at this checkpoint",
      );
    address = instance.ipConfig.v4.ip;
  } else if (payload.capability === "talos_api") {
    if (
      [
        "created",
        "rescue_verified",
        "image_verified",
        "disk_write_intent",
        "disk_written",
        "gpt_relocation_intent",
        "gpt_relocated",
      ].includes(checkpoint.stage)
    )
      throw new ApiError(
        "forbidden",
        "Talos transport is not authorized before the installed-image reboot",
      );
    address = instance.ipConfig.v4.ip;
  } else {
    if (
      !(spec.role === "worker" && checkpoint.stage === "talos_authenticated") &&
      ![
        "kubernetes_bootstrap_intent",
        "kubernetes_joined",
        "cilium_install_intent",
        "cilium_installed",
        "flux_install_intent",
        "flux_installed",
        "platform_sync_intent",
        "platform_ready",
        "regional_install_intent",
        "regional_ready",
        "awaiting_verification",
        "quarantine_release_intent",
        "quarantine_released",
      ].includes(checkpoint.stage)
    )
      throw new ApiError(
        "forbidden",
        "Kubernetes transport is not authorized before cluster bootstrap",
      );
    address = new URL(spec.cluster_endpoint).hostname;
    if (
      input.join_bundle !== null &&
      input.join_bundle.cluster_endpoint !== spec.cluster_endpoint
    )
      throw new ApiError(
        "conflict",
        "Protected cluster endpoint differs from the job",
      );
  }
  const key = await signingKey(env.BOOTSTRAP_RELAY_SIGNING_KEYS);
  const token = await signBootstrapRelay({
    ...key,
    operation: row.operation_id,
    node: row.node_id,
    region: row.region_id,
    issuer_region: env.BOOTSTRAP_RELAY_ISSUER_REGION,
    relay_epoch: identity.relay_epoch,
    revision: row.revision + 1,
    capability: payload.capability,
    address,
  });
  return NodeBootstrapTransport.parse({
    websocket_url: (() => {
      const url = new URL(
        `/internal/v1/node-bootstrap/${row.operation_id}/relay`,
        input.callback.url,
      );
      url.protocol = "wss:";
      return url.toString();
    })(),
    token,
    expectedTarget: { ip: address, port: BOOTSTRAP_PORTS[payload.capability] },
  });
}
