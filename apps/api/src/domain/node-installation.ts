// SPDX-License-Identifier: Apache-2.0
import {
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  hashApiKey,
  timingSafeEqual,
} from "@pgcf/contracts";
import { NodeBootstrapInput } from "@pgcf/contracts/node-bootstrap";
import {
  NodeInstallationProfile,
  NodeInstallationProfileStatus,
  NodeInstallationBindingStatus,
  NodeInstallationInspection,
  createNodeRescueHostIdentity,
} from "@pgcf/contracts/node-installation";
import { z } from "zod";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { bearer } from "../middleware/auth.ts";
import { readNodeAddition, assertNodeRecoveryAuthority } from "./node-state.ts";
import { contaboClient } from "./bootstrap-relay.ts";
import {
  hasAllocatedContaboHardware,
  type ContaboClient,
} from "../providers/contabo.ts";
import { validateRescueConfiguration } from "./rescue-configuration.ts";

interface Sealed {
  kid: string;
  iv: string;
  ciphertext: string;
}
interface ProfileRow extends Sealed {
  region_id: string;
  profile_sha256: string;
}
export interface NodeInstallationBindingRow extends Sealed {
  operation_id: string;
  node_id: string;
  region_id: string;
  provider_instance_id: string;
  profile_sha256: string;
  binding_sha256: string;
  firewall_id: string;
  inspection_hash: string;
  inspection_json: string | null;
  inspection_generation: number;
}
const Keyring = z.strictObject({
  active: z.string().min(1).max(64),
  keys: z.record(z.string(), z.string()),
});
const PrivateBinding = z.strictObject({
  rescue: NodeBootstrapInput.shape.rescue.safeExtend({
    user_data: z.string().min(1).max(32768),
  }),
  inspection_token: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export function canonicalInstallation(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalInstallation).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (name) =>
        `${JSON.stringify(name)}:${canonicalInstallation((value as Record<string, unknown>)[name])}`,
    )
    .join(",")}}`;
}
export async function installationHash(value: unknown) {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalInstallation(value)),
      ),
    ),
  );
}
const fail = (
  message = "Installation configuration is unavailable or mismatched",
): never => {
  throw new ApiError("conflict", message);
};
async function cryptKey(
  secret: string,
  kid: string,
  usage: "encrypt" | "decrypt",
) {
  const config = Keyring.parse(JSON.parse(secret)),
    raw = base64urlToBytes(config.keys[kid] ?? "");
  if (!raw || raw.length !== 32) return fail();
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(raw),
    "AES-GCM",
    false,
    [usage],
  );
}
const aad = (scope: string, kid: string) =>
  new TextEncoder().encode(`pgcf-node-installation/v1\n${scope}\n${kid}`);
async function seal(
  secret: string,
  scope: string,
  value: unknown,
): Promise<Sealed> {
  try {
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    if (plaintext.length > 512 * 1024) return fail();
    const kid = Keyring.parse(JSON.parse(secret)).active,
      iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(scope, kid) },
      await cryptKey(secret, kid, "encrypt"),
      plaintext,
    );
    return {
      kid,
      iv: bytesToBase64url(iv),
      ciphertext: bytesToBase64url(new Uint8Array(ciphertext)),
    };
  } catch {
    return fail();
  }
}
async function open(
  secret: string,
  scope: string,
  row: Sealed,
): Promise<unknown> {
  try {
    const iv = base64urlToBytes(row.iv),
      ciphertext = base64urlToBytes(row.ciphertext);
    if (
      !iv ||
      iv.length !== 12 ||
      !ciphertext ||
      ciphertext.length < 16 ||
      ciphertext.length > 512 * 1024 + 16
    )
      return fail();
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(iv),
        additionalData: aad(scope, row.kid),
      },
      await cryptKey(secret, row.kid, "decrypt"),
      Uint8Array.from(ciphertext),
    );
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        plaintext,
      ),
    );
  } catch {
    return fail();
  }
}
export async function readNodeInstallationProfile(
  env: Pick<Env, "DB" | "CREDENTIAL_KEYS">,
  regionId: string,
) {
  const row = await env.DB.prepare(
    "SELECT * FROM node_installation_profiles WHERE region_id=?",
  )
    .bind(regionId)
    .first<ProfileRow>();
  if (!row) return null;
  const parsed = NodeInstallationProfile.safeParse(
    await open(
      env.CREDENTIAL_KEYS,
      `profile\n${row.region_id}\n${row.profile_sha256}`,
      row,
    ),
  );
  if (
    !parsed.success ||
    parsed.data.region_id !== regionId ||
    (await installationHash(parsed.data)) !== row.profile_sha256
  )
    return fail();
  return { profile: parsed.data, profile_sha256: row.profile_sha256 };
}
export async function storeNodeInstallationProfile(
  env: Pick<Env, "DB" | "CREDENTIAL_KEYS" | "API_KEY_PEPPER">,
  regionId: string,
  raw: NodeInstallationProfile,
) {
  const parsed = NodeInstallationProfile.safeParse(raw);
  if (!parsed.success || parsed.data.region_id !== regionId) return fail();
  const region = await env.DB.prepare(
    "SELECT provider,agent_key_hash FROM regions WHERE id=?",
  )
    .bind(regionId)
    .first<{ provider: string; agent_key_hash: string }>();
  if (!region || region.provider !== "contabo")
    throw new ApiError("not_found", "Region is unavailable");
  if (
    parsed.data.first_region &&
    !timingSafeEqual(
      region.agent_key_hash,
      await hashApiKey(
        env.API_KEY_PEPPER,
        parsed.data.first_region.platform.agent_key,
      ),
    )
  )
    return fail("Platform agent identity differs from the issued regional key");
  const profile = parsed.data,
    hash = await installationHash(profile),
    existing = await readNodeInstallationProfile(env, regionId);
  if (existing) {
    if (existing.profile_sha256 !== hash)
      return fail("An installed profile cannot be replaced");
  } else {
    const sealed = await seal(
      env.CREDENTIAL_KEYS,
      `profile\n${regionId}\n${hash}`,
      profile,
    );
    await env.DB.prepare(
      "INSERT OR IGNORE INTO node_installation_profiles(region_id,profile_sha256,kid,iv,ciphertext,created_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        regionId,
        hash,
        sealed.kid,
        sealed.iv,
        sealed.ciphertext,
        new Date().toISOString(),
      )
      .run();
    if (
      (await readNodeInstallationProfile(env, regionId))?.profile_sha256 !==
      hash
    )
      return fail();
  }
  return NodeInstallationProfileStatus.parse({
    region_id: regionId,
    configured: true,
    profile_sha256: hash,
  });
}
export async function readNodeInstallationBinding(
  db: D1Database,
  operationId: string,
) {
  return db
    .prepare("SELECT * FROM node_installation_bindings WHERE operation_id=?")
    .bind(operationId)
    .first<NodeInstallationBindingRow>();
}
export function installationBindingStatus(row: NodeInstallationBindingRow) {
  return NodeInstallationBindingStatus.parse({
    operation_id: row.operation_id,
    node_id: row.node_id,
    region_id: row.region_id,
    provider_instance_id: row.provider_instance_id,
    profile_sha256: row.profile_sha256,
    binding_sha256: row.binding_sha256,
    firewall_id: row.firewall_id,
    inspection_generation: row.inspection_generation,
    inspected: row.inspection_json !== null,
  });
}
export async function loadNodeInstallationBinding(
  env: Pick<Env, "DB" | "CREDENTIAL_KEYS">,
  operationId: string,
) {
  const row = await readNodeInstallationBinding(env.DB, operationId);
  if (!row) return null;
  const parsed = PrivateBinding.safeParse(
    await open(
      env.CREDENTIAL_KEYS,
      `binding\n${row.operation_id}\n${row.provider_instance_id}\n${row.binding_sha256}`,
      row,
    ),
  );
  if (!parsed.success) return fail();
  return { row, ...parsed.data };
}
function sameSubnet(left: string, right: string, prefix: number) {
  const number = (address: string) =>
      address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0),
    divisor = 2 ** (32 - prefix);
  return (
    Math.floor(number(left) / divisor) === Math.floor(number(right) / divisor)
  );
}
/** Internal Workflow entry: bind the audited instance and persist fresh per-node host custody before rescue dispatch. */
export async function bindNodeInstallation(
  env: Env,
  operationId: string,
  expectedRevision: number,
  firewallId: string,
  provider: Pick<ContaboClient, "getInstance"> = contaboClient(env),
) {
  z.uuid().parse(firewallId);
  const addition = await readNodeAddition(env.DB, operationId);
  await assertNodeRecoveryAuthority(env.DB, addition);
  if (
    !addition.audit ||
    !addition.provider_instance_id ||
    !["audited", "bootstrapping"].includes(addition.status)
  )
    return fail();
  const installed = await readNodeInstallationProfile(
    env,
    addition.intent.request.region_id,
  );
  if (
    !installed ||
    installed.profile.provider_product_id !== addition.audit.product_id ||
    installed.profile.relay_issuer_region_id !==
      env.BOOTSTRAP_RELAY_ISSUER_REGION
  )
    return fail();
  const previous = await readNodeInstallationBinding(env.DB, operationId);
  if (previous) {
    if (
      previous.provider_instance_id !== addition.provider_instance_id ||
      previous.profile_sha256 !== installed.profile_sha256 ||
      previous.firewall_id !== firewallId
    )
      return fail();
    return installationBindingStatus(previous);
  }
  if (addition.revision !== expectedRevision)
    return fail("Node inventory revision changed");
  const actual = await provider.getInstance(addition.provider_instance_id, {
    requestId: crypto.randomUUID(),
    accounting: { operation_id: operationId, stage: "inspection" },
  });
  if (
    !hasAllocatedContaboHardware(actual) ||
    actual.id !== addition.provider_instance_id ||
    actual.productId !== addition.audit.product_id ||
    actual.region !== addition.audit.provider_region ||
    !["running", "stopped", "uninstalled", "rescue"].includes(actual.status) ||
    !z.ipv4().safeParse(actual.ipConfig.v4.ip).success ||
    !z.ipv4().safeParse(actual.ipConfig.v4.gateway).success ||
    actual.ipConfig.v4.netmaskCidr < 1
  )
    return fail(
      "Allocated provider inventory is required before rescue binding",
    );
  const relay = await provider.getInstance(
    env.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID,
    {
      requestId: crypto.randomUUID(),
      accounting: { operation_id: operationId, stage: "inspection" },
    },
  );
  if (
    !hasAllocatedContaboHardware(relay) ||
    relay.id === actual.id ||
    relay.tenantId !== actual.tenantId ||
    relay.customerId !== actual.customerId
  )
    return fail();
  const peers = [
    relay.ipConfig.v4.ip,
    ...relay.additionalIps.map((value) => value.v4.ip),
  ].filter(
    (address) =>
      z.ipv4().safeParse(address).success &&
      sameSubnet(
        address,
        actual.ipConfig.v4.ip,
        actual.ipConfig.v4.netmaskCidr,
      ),
  );
  let established: Awaited<ReturnType<typeof validateRescueConfiguration>>;
  if (env.CONTABO_RESCUE_CONFIGURATION !== undefined) {
    let map: unknown;
    try {
      map = JSON.parse(env.CONTABO_RESCUE_CONFIGURATION);
    } catch {
      return fail();
    }
    if (!map || typeof map !== "object" || Array.isArray(map)) return fail();
    if (Object.hasOwn(map, actual.id))
      established = await validateRescueConfiguration(
        { CONTABO_RESCUE_CONFIGURATION: env.CONTABO_RESCUE_CONFIGURATION },
        actual.id,
      );
  }
  // Existing controlled rescue custody is imported unchanged; new instances receive a unique identity.
  const host =
      established ??
      (await createNodeRescueHostIdentity({
        gateway: actual.ipConfig.v4.gateway,
        peer_ipv4: [...new Set(peers)].sort(),
      })),
    rescue = {
      ssh_private_key: installed.profile.rescue_client_private_key,
      ...host,
    },
    inspectionToken = bytesToBase64url(
      crypto.getRandomValues(new Uint8Array(64)),
    ),
    bindingHash = await installationHash({
      operation_id: operationId,
      node_id: addition.intent.node_id,
      region_id: installed.profile.region_id,
      provider_instance_id: actual.id,
      profile_sha256: installed.profile_sha256,
      firewall_id: firewallId,
      rescue_host_fingerprint: host.ssh_host_fingerprint,
    }),
    encrypted = await seal(
      env.CREDENTIAL_KEYS,
      `binding\n${operationId}\n${actual.id}\n${bindingHash}`,
      { rescue, inspection_token: inspectionToken },
    );
  await env.DB.prepare(
    `INSERT OR IGNORE INTO node_installation_bindings(operation_id,node_id,region_id,provider_instance_id,profile_sha256,binding_sha256,firewall_id,inspection_hash,kid,iv,ciphertext,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM node_additions WHERE operation_id=? AND revision=? AND provider_instance_id=? AND status IN('audited','bootstrapping'))`,
  )
    .bind(
      operationId,
      addition.intent.node_id,
      installed.profile.region_id,
      actual.id,
      installed.profile_sha256,
      bindingHash,
      firewallId,
      await hashApiKey(env.API_KEY_PEPPER, inspectionToken),
      encrypted.kid,
      encrypted.iv,
      encrypted.ciphertext,
      new Date().toISOString(),
      operationId,
      expectedRevision,
      actual.id,
    )
    .run();
  const row = await readNodeInstallationBinding(env.DB, operationId);
  if (
    !row ||
    row.provider_instance_id !== actual.id ||
    row.profile_sha256 !== installed.profile_sha256 ||
    row.firewall_id !== firewallId
  )
    return fail();
  return installationBindingStatus(row);
}
export async function installationFirewallBinding(
  db: D1Database,
  operationId: string,
  providerId: string,
) {
  const rows = await db
    .prepare(
      `SELECT b.firewall_id FROM node_installation_bindings b JOIN node_additions a ON a.operation_id=b.operation_id
    JOIN node_additions current ON current.operation_id=?
    WHERE b.provider_instance_id=? AND b.region_id=current.region_id AND a.provider_instance_id=b.provider_instance_id
      AND current.slot_held=1 AND current.status IN('audited','bootstrapping','ready')
      AND a.slot_held=1 AND a.status IN('audited','bootstrapping','ready')
      AND (a.operation_id=current.operation_id OR (a.status='ready' AND EXISTS(
        SELECT 1 FROM nodes n WHERE n.id=b.node_id AND n.region_id=b.region_id AND n.provider_instance_id=b.provider_instance_id AND n.lost_at IS NULL))) LIMIT 2`,
    )
    .bind(operationId, providerId)
    .all<{ firewall_id: string }>();
  if (rows.results.length > 1)
    return fail("Installation firewall binding is ambiguous");
  return rows.results[0]?.firewall_id;
}
export async function installationRescueBinding(
  env: Pick<Env, "DB" | "CREDENTIAL_KEYS">,
  providerId: string,
) {
  const rows = await env.DB.prepare(
    `SELECT b.operation_id FROM node_installation_bindings b JOIN node_additions a ON a.operation_id=b.operation_id
    WHERE b.provider_instance_id=? AND a.provider_instance_id=b.provider_instance_id AND a.slot_held=1 AND a.status IN('audited','bootstrapping') LIMIT 2`,
  )
    .bind(providerId)
    .all<{ operation_id: string }>();
  if (!rows.results.length) return undefined;
  if (rows.results.length !== 1) return fail();
  return (await loadNodeInstallationBinding(env, rows.results[0]!.operation_id))
    ?.rescue;
}
export async function authenticateNodeInstallationInspection(
  c: ApiContext,
  operationId: string,
) {
  const row = await readNodeInstallationBinding(c.env.DB, operationId);
  if (
    !row ||
    !timingSafeEqual(
      row.inspection_hash,
      await hashApiKey(c.env.API_KEY_PEPPER, bearer(c)),
    )
  )
    throw new ApiError(
      "unauthorized",
      "Invalid installation inspection authority",
    );
  const addition = await readNodeAddition(c.env.DB, operationId);
  if (
    !addition.slot_held ||
    !["audited", "bootstrapping"].includes(addition.status) ||
    addition.provider_instance_id !== row.provider_instance_id
  )
    throw new ApiError(
      "forbidden",
      "Installation inspection authority is closed",
    );
  return row;
}
export async function recordNodeInstallationInspection(
  env: Env,
  operationId: string,
  expectedGeneration: number,
  raw: NodeInstallationInspection,
  now = Date.now(),
) {
  const parsed = NodeInstallationInspection.safeParse(raw),
    binding = await loadNodeInstallationBinding(env, operationId),
    addition = await readNodeAddition(env.DB, operationId);
  if (
    !parsed.success ||
    !binding ||
    !addition.slot_held ||
    !["audited", "bootstrapping"].includes(addition.status)
  )
    return fail();
  const value = parsed.data,
    row = binding.row,
    observed = Date.parse(value.observed_at);
  if (
    value.operation_id !== operationId ||
    value.node_id !== row.node_id ||
    value.region_id !== row.region_id ||
    value.provider_instance_id !== row.provider_instance_id ||
    addition.provider_instance_id !== row.provider_instance_id ||
    value.profile_sha256 !== row.profile_sha256 ||
    value.binding_sha256 !== row.binding_sha256 ||
    value.rescue_host_fingerprint !== binding.rescue.ssh_host_fingerprint ||
    observed < now - 120000 ||
    observed > now + 5000
  )
    return fail("Installation inspection identity or freshness changed");
  const plan = await env.DB.prepare(
    "SELECT plan_sha256,status FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(operationId)
    .first<{ plan_sha256: string; status: string }>();
  if (
    !plan ||
    plan.status === "blocked" ||
    plan.plan_sha256 !== value.network_plan_sha256
  )
    return fail("Installation inspection network plan changed");
  const updated = await env.DB.prepare(
    "UPDATE node_installation_bindings SET inspection_json=?,inspection_generation=inspection_generation+1 WHERE operation_id=? AND binding_sha256=? AND inspection_generation=?",
  )
    .bind(
      JSON.stringify(value),
      operationId,
      row.binding_sha256,
      expectedGeneration,
    )
    .run();
  if (updated.meta.changes !== 1)
    return fail("Installation inspection generation changed");
  return installationBindingStatus(
    (await readNodeInstallationBinding(env.DB, operationId))!,
  );
}
