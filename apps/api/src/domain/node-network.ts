// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  OperationId,
  NodeId,
  RegionId,
  Timestamp,
  bytesToHex,
  base64urlToBytes,
} from "@pgcf/contracts";
import { ProviderInstanceId } from "@pgcf/contracts/nodes";
import { importBootstrapVerificationKeys } from "@pgcf/contracts/bootstrap-relay";
import { readNodeAddition, assertNodeRecoveryAuthority } from "./node-state.ts";
import {
  ContaboClient,
  type ContaboInstance,
  type ContaboFirewall,
  type ContaboFirewallRulesInput,
} from "../providers/contabo.ts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/),
  IP = z.union([z.ipv4(), z.ipv6()]);
const MAX_MEMBERS = 16,
  MAX_BODY = 65536;
export const NODE_PREPARATION_SIGNATURE_DOMAIN = "pgcf-node-preparation/v1\n";
const Access = z.strictObject({
  provider_instance_id: ProviderInstanceId,
  address: IP,
  relay_source: IP,
  observed_at: Timestamp,
  checks: z
    .array(
      z.strictObject({
        port: z.union([z.literal(22), z.literal(50000), z.literal(6443)]),
        outcome: z.enum(["connected", "refused"]),
      }),
    )
    .length(3),
});
const Scan = z.strictObject({
  provider_instance_id: ProviderInstanceId,
  address: IP,
  protocol: z.literal("tcp"),
  first_port: z.literal(1),
  last_port: z.literal(65535),
  scanned_ports: z.literal(65535),
  open_ports: z.array(z.number().int().min(1).max(65535)).max(65535),
  started_at: Timestamp,
  observed_at: Timestamp,
});
const External = z.strictObject({
  source: IP,
  positive_control: z.strictObject({
    address: IP,
    port: z.number().int().min(1).max(65535),
    outcome: z.literal("connected"),
    observed_at: Timestamp,
  }),
  scans: z.array(Scan).min(1).max(64),
});
export const nodePreparationProofSchema = z.strictObject({
  version: z.literal(1),
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  provider_instance_id: ProviderInstanceId,
  intent_hash: Hash,
  plan_sha256: Hash,
  observed_at: Timestamp,
  expires_at: Timestamp,
  relay_provider_instance_id: ProviderInstanceId,
  access: z.array(Access).min(1).max(MAX_MEMBERS),
  firewalls: z
    .array(
      z.strictObject({
        firewall_id: z.uuid(),
        provider_instance_id: ProviderInstanceId,
        rules_sha256: Hash,
      }),
    )
    .min(1)
    .max(MAX_MEMBERS),
  external: z.strictObject({
    ipv4: External.nullable(),
    ipv6: External.nullable(),
  }),
});
export type NodePreparationProof = z.infer<typeof nodePreparationProofSchema>;
const Artifact = z.strictObject({
  kid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  payload: nodePreparationProofSchema,
  signature: z.string().max(86),
});
export interface NodeNetworkEnv {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  CONTABO_CLIENT_ID: string;
  CONTABO_CLIENT_SECRET: string;
  CONTABO_USERNAME: string;
  CONTABO_PASSWORD: string;
  BOOTSTRAP_VERIFIER_KEYS: string;
  BOOTSTRAP_FIREWALL_BINDINGS: string;
  BOOTSTRAP_OPERATOR_SOURCES: string;
  BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID: string;
  BOOTSTRAP_SCAN_CONTROL: string;
}
export interface NodeNetworkOptions {
  fetcher?: typeof fetch;
  now?: () => number;
}
interface Addresses {
  ipv4: string[];
  ipv6: string[];
}
interface Member {
  node_id: string;
  provider_instance_id: string;
  firewall_id: string;
  addresses: Addresses;
  primary: Addresses;
  ownership_sha256: string;
  rules: ContaboFirewallRulesInput;
  rules_sha256: string;
}
interface Plan {
  version: 1;
  operation_id: string;
  node_id: string;
  region_id: string;
  provider_instance_id: string;
  intent_hash: string;
  operators: Addresses;
  relay: { provider_instance_id: string; addresses: Addresses };
  scan_control: { ipv4: string; ipv6: string; port: number };
  members: Member[];
}
interface Preparation {
  operation_id: string;
  intent_hash: string;
  plan_sha256: string;
  plan_json: string;
  revision: number;
  status: string;
  readback_at: string | null;
}
interface Claim {
  request_id: string;
  state: "claimed" | "accepted" | "unknown" | "rejected" | "confirmed";
  revision: number;
}
const canonical = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(",")}}`;
export function canonicalNodePreparationProof(
  value: NodePreparationProof,
): string {
  const parsed = nodePreparationProofSchema.safeParse(value);
  if (!parsed.success) throw new Error("node_network_invalid_proof");
  return canonical(parsed.data);
}
const digest = async (value: unknown) =>
  bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(value)),
      ),
    ),
  );
function fail(): never {
  throw new Error("node_network_blocked");
}
function ip(value: string): string {
  if (!IP.safeParse(value).success) return fail();
  return z.ipv4().safeParse(value).success
    ? value
    : new URL(`https://[${value}]`).hostname.slice(1, -1);
}
const family = (value: string): keyof Addresses =>
  z.ipv4().safeParse(value).success ? "ipv4" : "ipv6";
const unique = (values: string[]) => [...new Set(values)].sort();
function addresses(instance: ContaboInstance): Addresses {
  const result = {
    ipv4: unique(
      [
        instance.ipConfig.v4.ip,
        ...instance.additionalIps.map((extra) => extra.v4.ip),
      ]
        .filter(Boolean)
        .map(ip),
    ),
    ipv6: instance.ipConfig.v6?.ip ? [ip(instance.ipConfig.v6.ip)] : [],
  };
  if ((!result.ipv4.length && !result.ipv6.length) || result.ipv4.length > 4)
    fail();
  return result;
}
const primary = (instance: ContaboInstance): Addresses => ({
  ipv4: instance.ipConfig.v4.ip ? [ip(instance.ipConfig.v4.ip)] : [],
  ipv6: instance.ipConfig.v6?.ip ? [ip(instance.ipConfig.v6.ip)] : [],
});
function cidr(value: string): string {
  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    parts[1] !== (family(parts[0]!) === "ipv4" ? "32" : "128")
  )
    fail();
  return `${ip(parts[0]!)}/${parts[1]}`;
}
function sources(values: string[]): Addresses {
  const result: Addresses = { ipv4: [], ipv6: [] };
  for (const value of values)
    result[family(value.split("/")[0]!)].push(cidr(value));
  return { ipv4: unique(result.ipv4), ipv6: unique(result.ipv6) };
}
function sourceInput(value: Addresses) {
  return {
    ...(value.ipv4.length ? { ipv4: value.ipv4 } : {}),
    ...(value.ipv6.length ? { ipv6: value.ipv6 } : {}),
  };
}
function normalizedRules(
  rules:
    | ContaboFirewallRulesInput["rules"]["inbound"]
    | ContaboFirewall["rules"]["inbound"],
): unknown[] {
  return rules
    .map((rule) => {
      if (
        rule.action !== "accept" ||
        rule.status !== "active" ||
        !["tcp", "udp"].includes(rule.protocol)
      )
        fail();
      const ports: number[] = [];
      for (const value of rule.destPorts) {
        if (!/^[1-9]\d{0,4}(?:-[1-9]\d{0,4})?$/.test(value)) fail();
        const [first, last = first] = value.split("-").map(Number);
        if (first! > last! || last! > 65535 || last! - first! > 15) fail();
        for (let port = first!; port <= last!; port++) ports.push(port);
      }
      if (!ports.length || ports.length > 15) fail();
      const v4 = unique((rule.srcCidr.ipv4 ?? []).map(cidr)),
        v6 = unique((rule.srcCidr.ipv6 ?? []).map(cidr));
      if (!v4.length && !v6.length) fail();
      return {
        protocol: rule.protocol,
        destPorts: unique(ports.map(String)),
        srcCidr: { ipv4: v4, ipv6: v6 },
        action: "accept",
        status: "active",
      };
    })
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
function drop(firewall: ContaboFirewall): boolean {
  const rule = firewall.rules.inbound.at(-1);
  return (
    !!rule &&
    rule.protocol === "" &&
    rule.destPorts.length === 0 &&
    Array.isArray(rule.srcCidr.ipv4) &&
    rule.srcCidr.ipv4.length === 0 &&
    Array.isArray(rule.srcCidr.ipv6) &&
    rule.srcCidr.ipv6.length === 0 &&
    rule.action === "drop" &&
    rule.status === "active" &&
    firewall.rules.inbound.filter((rule) => rule.action === "drop").length === 1
  );
}
function exactRules(firewall: ContaboFirewall, member: Member): boolean {
  try {
    return (
      drop(firewall) &&
      canonical(normalizedRules(firewall.rules.inbound.slice(0, -1))) ===
        canonical(normalizedRules(member.rules.rules.inbound))
    );
  } catch {
    return false;
  }
}
async function owned(
  firewall: ContaboFirewall,
  member: Member,
): Promise<boolean> {
  if (
    firewall.firewallId !== member.firewall_id ||
    firewall.status !== "active" ||
    (await digest([firewall.tenantId, firewall.customerId])) !==
      member.ownership_sha256 ||
    !drop(firewall)
  )
    return false;
  if (
    firewall.instances.length > 1 ||
    firewall.instanceStatus.length > 1 ||
    firewall.instances.some(
      (value) => value.instanceId !== member.provider_instance_id,
    ) ||
    firewall.instanceStatus.some(
      (value) => value.instanceId !== member.provider_instance_id,
    )
  )
    return false;
  const attached = firewall.instances[0];
  if (attached) {
    const actual = {
      ipv4: attached.ipConfig.v4.ip ? [ip(attached.ipConfig.v4.ip)] : [],
      ipv6: attached.ipConfig.v6.ip ? [ip(attached.ipConfig.v6.ip)] : [],
    };
    if (canonical(actual) !== canonical(member.primary)) return false;
  }
  return true;
}
const assigned = (firewall: ContaboFirewall, member: Member) =>
  firewall.instances.length === 1 &&
  firewall.instances[0]!.instanceId === member.provider_instance_id &&
  firewall.instanceStatus.length === 1 &&
  firewall.instanceStatus[0]!.instanceId === member.provider_instance_id &&
  firewall.instanceStatus[0]!.status === "ok";
function configured<T>(text: string, schema: z.ZodType<T>): T {
  if (typeof text !== "string" || text.length > MAX_BODY) return fail();
  const result = schema.safeParse(JSON.parse(text));
  if (!result.success) return fail();
  return result.data;
}
async function makePlan(
  env: NodeNetworkEnv,
  client: ContaboClient,
  operationId: string,
  request: () => { requestId: string; deadline: number },
): Promise<Plan> {
  const addition = await readNodeAddition(env.DB, operationId);
  await assertNodeRecoveryAuthority(env.DB, addition);
  if (
    !addition.slot_held ||
    !["audited", "bootstrapping", "ready"].includes(addition.status) ||
    !addition.audit ||
    !addition.provider_instance_id
  )
    fail();
  const region = await env.DB.prepare(
    "SELECT provider,provider_region FROM regions WHERE id=?",
  )
    .bind(addition.intent.request.region_id)
    .first<{ provider: string; provider_region: string }>();
  if (!region || region.provider !== "contabo") fail();
  const nodes = (
    await env.DB.prepare(
      "SELECT id,provider_instance_id FROM nodes WHERE region_id=? AND id<>? AND lost_at IS NULL ORDER BY id LIMIT 17",
    )
      .bind(addition.intent.request.region_id, addition.intent.node_id)
      .all<{ id: string; provider_instance_id: string | null }>()
  ).results;
  if (
    nodes.length >= MAX_MEMBERS ||
    nodes.some((node) => !node.provider_instance_id)
  )
    fail();
  const bindings = configured(
    env.BOOTSTRAP_FIREWALL_BINDINGS,
    z.record(ProviderInstanceId, z.uuid()),
  );
  const operator = configured(
    env.BOOTSTRAP_OPERATOR_SOURCES,
    z.array(z.string().max(64)).min(1).max(16),
  );
  const control = configured(
    env.BOOTSTRAP_SCAN_CONTROL,
    z.strictObject({
      ipv4: z.ipv4(),
      ipv6: z.ipv6(),
      port: z.number().int().min(1).max(65535),
    }),
  );
  const relayId = ProviderInstanceId.parse(
      env.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID,
    ),
    relay = await client.getInstance(relayId, request());
  if (relayId === addition.provider_instance_id) fail();
  const members: Member[] = [];
  for (const node of [
    {
      id: addition.intent.node_id,
      provider_instance_id: addition.provider_instance_id,
    },
    ...nodes,
  ]) {
    const id = ProviderInstanceId.parse(node.provider_instance_id),
      instance = await client.getInstance(id, request()),
      firewallId = bindings[id];
    if (
      !firewallId ||
      instance.region !== region.provider_region ||
      instance.tenantId !== relay.tenantId ||
      instance.customerId !== relay.customerId
    )
      fail();
    members.push({
      node_id: node.id,
      provider_instance_id: id,
      firewall_id: firewallId,
      addresses: addresses(instance),
      primary: primary(instance),
      ownership_sha256: await digest([instance.tenantId, instance.customerId]),
      rules: { rules: { inbound: [] } },
      rules_sha256: "",
    });
  }
  if (
    new Set(members.map((member) => member.firewall_id)).size !==
      members.length ||
    new Set(members.map((member) => member.provider_instance_id)).size !==
      members.length
  )
    fail();
  const operators = sources(operator),
    relayAddresses = addresses(relay);
  const management = sources([
    ...operators.ipv4,
    ...operators.ipv6,
    ...relayAddresses.ipv4.map((value) => value + "/32"),
    ...relayAddresses.ipv6.map((value) => value + "/128"),
  ]);
  for (const member of members) {
    const inbound: ContaboFirewallRulesInput["rules"]["inbound"] = [
      {
        protocol: "tcp",
        destPorts: ["22", "50000", "6443"],
        srcCidr: sourceInput(management),
        action: "accept",
        status: "active",
        displayName: "PGCF approved management",
      },
    ];
    const peers = sources(
      members
        .filter(
          (peer) => peer.provider_instance_id !== member.provider_instance_id,
        )
        .flatMap((peer) => [
          ...peer.addresses.ipv4.map((value) => value + "/32"),
          ...peer.addresses.ipv6.map((value) => value + "/128"),
        ]),
    );
    if (peers.ipv4.length || peers.ipv6.length)
      for (const [protocol, destPorts] of [
        ["tcp", ["6443", "50000", "50001", "10250", "4240"]],
        ["udp", ["8472", "51871"]],
      ] as const)
        inbound.push({
          protocol,
          destPorts: [...destPorts],
          srcCidr: sourceInput(peers),
          action: "accept",
          status: "active",
          displayName: "PGCF exact regional peers",
        });
    member.rules = { rules: { inbound } };
    member.rules_sha256 = await digest(normalizedRules(inbound));
  }
  return {
    version: 1,
    operation_id: operationId,
    node_id: addition.intent.node_id,
    region_id: addition.intent.request.region_id,
    provider_instance_id: addition.provider_instance_id,
    intent_hash: addition.intent_hash,
    operators,
    relay: { provider_instance_id: relayId, addresses: relayAddresses },
    scan_control: {
      ipv4: ip(control.ipv4),
      ipv6: ip(control.ipv6),
      port: control.port,
    },
    members: members.sort((a, b) =>
      a.provider_instance_id.localeCompare(b.provider_instance_id),
    ),
  };
}
async function prepare(
  db: D1Database,
  plan: Plan,
  now: number,
): Promise<Preparation> {
  const json = canonical(plan),
    hash = await digest(plan);
  if (new TextEncoder().encode(json).length > MAX_BODY) fail();
  await db
    .prepare(
      "INSERT OR IGNORE INTO node_network_preparations(operation_id,intent_hash,plan_sha256,plan_json,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM node_additions WHERE operation_id=? AND intent_hash=? AND slot_held=1 AND status IN('audited','bootstrapping','ready'))",
    )
    .bind(
      plan.operation_id,
      plan.intent_hash,
      hash,
      json,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      plan.operation_id,
      plan.intent_hash,
    )
    .run();
  const row = await db
    .prepare("SELECT * FROM node_network_preparations WHERE operation_id=?")
    .bind(plan.operation_id)
    .first<Preparation>();
  if (
    !row ||
    row.plan_json !== json ||
    row.plan_sha256 !== hash ||
    row.status === "blocked"
  )
    fail();
  return row;
}
async function lease(
  db: D1Database,
  preparation: Preparation,
  member: Member,
): Promise<boolean> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO node_network_firewalls(firewall_id,operation_id,plan_sha256) VALUES(?,?,?)",
    )
    .bind(member.firewall_id, preparation.operation_id, preparation.plan_sha256)
    .run();
  const row = await db
    .prepare(
      "SELECT operation_id,plan_sha256,revision FROM node_network_firewalls WHERE firewall_id=?",
    )
    .bind(member.firewall_id)
    .first<{ operation_id: string; plan_sha256: string; revision: number }>();
  if (!row) return false;
  if (row.operation_id === preparation.operation_id)
    return row.plan_sha256 === preparation.plan_sha256;
  const changed = await db
    .prepare(
      "UPDATE node_network_firewalls SET operation_id=?,plan_sha256=?,revision=revision+1 WHERE firewall_id=? AND operation_id=? AND revision=? AND EXISTS(SELECT 1 FROM node_network_preparations p JOIN node_additions a ON a.operation_id=p.operation_id WHERE p.operation_id=? AND p.status='verified' AND a.status='ready')",
    )
    .bind(
      preparation.operation_id,
      preparation.plan_sha256,
      member.firewall_id,
      row.operation_id,
      row.revision,
      row.operation_id,
    )
    .run();
  return changed.meta.changes === 1;
}
async function action(
  db: D1Database,
  preparation: Preparation,
  member: Member,
  kind: "rules" | "assign",
  matches: boolean,
  send: (
    requestId: string,
  ) => Promise<{ kind: "accepted" | "unknown" | "rejected" }>,
): Promise<boolean> {
  const read = () =>
    db
      .prepare(
        "SELECT request_id,state,revision FROM node_network_mutations WHERE operation_id=? AND firewall_id=? AND action=?",
      )
      .bind(preparation.operation_id, member.firewall_id, kind)
      .first<Claim>();
  const previous = await read();
  if (previous?.state === "rejected") return false;
  if (matches) {
    if (previous && previous.state !== "confirmed")
      await db
        .prepare(
          "UPDATE node_network_mutations SET state='confirmed',revision=revision+1 WHERE operation_id=? AND firewall_id=? AND action=? AND revision=? AND state<>'rejected'",
        )
        .bind(
          preparation.operation_id,
          member.firewall_id,
          kind,
          previous.revision,
        )
        .run();
    return true;
  }
  if (previous) return false;
  const requestId = crypto.randomUUID();
  const claim = await db
    .prepare(
      "INSERT OR IGNORE INTO node_network_mutations(operation_id,firewall_id,action,request_id,plan_sha256,state) SELECT ?,?,?,?,?,'claimed' WHERE EXISTS(SELECT 1 FROM node_network_firewalls WHERE firewall_id=? AND operation_id=? AND plan_sha256=?) AND EXISTS(SELECT 1 FROM node_additions WHERE operation_id=? AND intent_hash=? AND slot_held=1 AND status IN('audited','bootstrapping','ready'))",
    )
    .bind(
      preparation.operation_id,
      member.firewall_id,
      kind,
      requestId,
      preparation.plan_sha256,
      member.firewall_id,
      preparation.operation_id,
      preparation.plan_sha256,
      preparation.operation_id,
      preparation.intent_hash,
    )
    .run();
  if (claim.meta.changes !== 1) return false;
  let state: "accepted" | "unknown" | "rejected" = "unknown";
  try {
    state = (await send(requestId)).kind;
  } catch {
    /* A claimed mutation is never automatically dispatched again. */
  }
  await db
    .prepare(
      "UPDATE node_network_mutations SET state=?,revision=revision+1 WHERE operation_id=? AND firewall_id=? AND action=? AND request_id=? AND revision=1 AND state='claimed'",
    )
    .bind(state, preparation.operation_id, member.firewall_id, kind, requestId)
    .run();
  return false;
}
async function text(object: R2ObjectBody): Promise<string> {
  if (object.size > MAX_BODY) return fail();
  const reader = object.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > MAX_BODY) return fail();
      chunks.push(chunk.value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      data,
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function proof(
  env: NodeNetworkEnv,
  preparation: Preparation,
  plan: Plan,
  now: number,
): Promise<{
  hash: string;
  expires: string;
  oldest: number;
  observed: number;
} | null> {
  const object = await env.ARCHIVE.get(
    `node-preparation/${plan.operation_id}/proof.json`,
  );
  if (!object) return null;
  const raw = await text(object),
    document = Artifact.safeParse(JSON.parse(raw));
  if (!document.success) return null;
  const envelope = document.data,
    value = envelope.payload;
  if (
    value.operation_id !== plan.operation_id ||
    value.node_id !== plan.node_id ||
    value.region_id !== plan.region_id ||
    value.provider_instance_id !== plan.provider_instance_id ||
    value.intent_hash !== plan.intent_hash ||
    value.plan_sha256 !== preparation.plan_sha256 ||
    value.relay_provider_instance_id !== plan.relay.provider_instance_id ||
    !preparation.readback_at
  )
    return null;
  const observed = Date.parse(value.observed_at),
    expires = Date.parse(value.expires_at);
  if (
    observed < now - 120000 ||
    observed > now + 5000 ||
    expires <= now ||
    expires <= observed ||
    expires - observed > 300000 ||
    observed < Date.parse(preparation.readback_at)
  )
    return null;
  const key = (
      await importBootstrapVerificationKeys(
        JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
      )
    ).get(envelope.kid),
    signature = base64urlToBytes(envelope.signature);
  if (!key || !signature || signature.length !== 64) return null;
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      Uint8Array.from(signature),
      new TextEncoder().encode(
        NODE_PREPARATION_SIGNATURE_DOMAIN +
          canonicalNodePreparationProof(value),
      ),
    ))
  )
    return null;
  if (
    value.firewalls.length !== plan.members.length ||
    new Set(value.firewalls.map((fw) => fw.firewall_id)).size !==
      value.firewalls.length ||
    value.firewalls.some(
      (fw) =>
        !plan.members.some(
          (member) =>
            member.firewall_id === fw.firewall_id &&
            member.provider_instance_id === fw.provider_instance_id &&
            member.rules_sha256 === fw.rules_sha256,
        ),
    )
  )
    return null;
  if (
    value.access.length !== plan.members.length ||
    new Set(value.access.map((access) => access.provider_instance_id)).size !==
      value.access.length
  )
    return null;
  for (const access of value.access) {
    const member = plan.members.find(
      (member) => member.provider_instance_id === access.provider_instance_id,
    );
    if (
      !member ||
      !member.addresses[family(access.address)].includes(ip(access.address)) ||
      !plan.relay.addresses[family(access.relay_source)].includes(
        ip(access.relay_source),
      ) ||
      family(access.relay_source) !== family(access.address) ||
      new Set(access.checks.map((check) => check.port)).size !== 3 ||
      !access.checks.some((check) => check.outcome === "connected") ||
      access.observed_at < preparation.readback_at ||
      Date.parse(access.observed_at) < now - 120000 ||
      access.observed_at > value.observed_at
    )
      return null;
  }
  for (const kind of ["ipv4", "ipv6"] as const) {
    const expected = plan.members.flatMap((member) =>
        member.addresses[kind].map((address) => ({
          id: member.provider_instance_id,
          address,
        })),
      ),
      external = value.external[kind];
    if (!expected.length) {
      if (external !== null) return null;
      continue;
    }
    if (
      !external ||
      family(external.source) !== kind ||
      family(external.positive_control.address) !== kind ||
      ip(external.positive_control.address) !== plan.scan_control[kind] ||
      external.positive_control.port !== plan.scan_control.port ||
      external.scans.length !== expected.length ||
      new Set(external.scans.map((scan) => scan.address)).size !==
        expected.length
    )
      return null;
    const source = ip(external.source),
      allowed = [
        ...plan.operators[kind].map((cidr) => cidr.split("/")[0]!),
        ...plan.relay.addresses[kind],
        ...plan.members.flatMap((member) => member.addresses[kind]),
      ];
    if (
      allowed.includes(source) ||
      source === ip(external.positive_control.address) ||
      Date.parse(external.positive_control.observed_at) < now - 120000 ||
      external.positive_control.observed_at > value.observed_at ||
      external.positive_control.observed_at < preparation.readback_at
    )
      return null;
    for (const scan of external.scans)
      if (
        family(scan.address) !== kind ||
        !expected.some(
          (target) =>
            target.id === scan.provider_instance_id &&
            target.address === ip(scan.address),
        ) ||
        scan.open_ports.length ||
        scan.started_at < preparation.readback_at ||
        scan.observed_at < scan.started_at ||
        scan.observed_at > value.observed_at ||
        Date.parse(scan.observed_at) < now - 120000
      )
        return null;
  }
  const observations = [
    observed,
    ...value.access.map((access) => Date.parse(access.observed_at)),
    ...Object.values(value.external).flatMap((external) =>
      external
        ? [
            Date.parse(external.positive_control.observed_at),
            ...external.scans.map((scan) => Date.parse(scan.observed_at)),
          ]
        : [],
    ),
  ];
  return {
    hash: await digest(envelope),
    expires: value.expires_at,
    oldest: Math.min(...observations),
    observed,
  };
}
export async function ensureNodeNetwork(
  env: NodeNetworkEnv,
  operationId: string,
  options: NodeNetworkOptions = {},
): Promise<boolean> {
  try {
    OperationId.parse(operationId);
    const now = options.now ?? Date.now,
      started = now();
    if (!Number.isSafeInteger(started) || started < 0) return false;
    const deadline = Date.now() + 20000,
      request = () => ({ requestId: crypto.randomUUID(), deadline });
    const client = new ContaboClient({
      clientId: env.CONTABO_CLIENT_ID,
      clientSecret: env.CONTABO_CLIENT_SECRET,
      username: env.CONTABO_USERNAME,
      password: env.CONTABO_PASSWORD,
      fetcher: options.fetcher,
      timeoutMs: 5000,
    });
    const plan = await makePlan(env, client, operationId, request),
      preparation = await prepare(env.DB, plan, started);
    for (const member of plan.members)
      if (!(await lease(env.DB, preparation, member))) return false;
    let ready = true;
    for (const member of plan.members) {
      const firewall = await client.getFirewall(member.firewall_id, request());
      if (!(await owned(firewall, member))) return false;
      const rulesReady = await action(
        env.DB,
        preparation,
        member,
        "rules",
        exactRules(firewall, member),
        (requestId) =>
          client.putFirewallRules(member.firewall_id, member.rules, {
            requestId,
            deadline,
          }),
      );
      if (!rulesReady) {
        ready = false;
        continue;
      }
      if (
        (firewall.instances.length || firewall.instanceStatus.length) &&
        !assigned(firewall, member)
      ) {
        ready = false;
        continue;
      }
      const assignmentReady = await action(
        env.DB,
        preparation,
        member,
        "assign",
        assigned(firewall, member),
        (requestId) =>
          client.assignFirewall(
            member.firewall_id,
            member.provider_instance_id,
            { requestId, deadline },
          ),
      );
      if (!assignmentReady) ready = false;
    }
    if (!ready) return false;
    if (!preparation.readback_at) {
      const timestamp = new Date(now()).toISOString();
      const changed = await env.DB.prepare(
        "UPDATE node_network_preparations SET status='awaiting_proof',readback_at=?,revision=revision+1,updated_at=? WHERE operation_id=? AND revision=? AND readback_at IS NULL",
      )
        .bind(timestamp, timestamp, operationId, preparation.revision)
        .run();
      if (changed.meta.changes !== 1) return false;
      preparation.readback_at = timestamp;
      preparation.revision++;
    }
    const verified = await proof(env, preparation, plan, now());
    if (!verified) return false;
    if (
      canonical(await makePlan(env, client, operationId, request)) !==
      canonical(plan)
    )
      return false;
    for (const member of plan.members) {
      const current = await client.getFirewall(member.firewall_id, request());
      if (
        !(await owned(current, member)) ||
        !assigned(current, member) ||
        !exactRules(current, member)
      )
        return false;
      const leaseRow = await env.DB.prepare(
        "SELECT operation_id,plan_sha256 FROM node_network_firewalls WHERE firewall_id=?",
      )
        .bind(member.firewall_id)
        .first<{ operation_id: string; plan_sha256: string }>();
      if (
        leaseRow?.operation_id !== operationId ||
        leaseRow.plan_sha256 !== preparation.plan_sha256
      )
        return false;
    }
    const validAt = (time: number) =>
      Number.isSafeInteger(time) &&
      time >= started &&
      Date.parse(verified.expires) > time &&
      verified.oldest >= time - 120000 &&
      verified.observed <= time + 5000;
    const finished = now();
    if (!validAt(finished)) return false;

    const result = await env.DB.prepare(
      "UPDATE node_network_preparations SET status='verified',proof_sha256=?,proof_expires_at=?,revision=revision+1,updated_at=? WHERE operation_id=? AND revision=? AND plan_sha256=? AND EXISTS(SELECT 1 FROM node_additions WHERE operation_id=? AND intent_hash=? AND slot_held=1 AND status IN('audited','bootstrapping','ready'))",
    )
      .bind(
        verified.hash,
        verified.expires,
        new Date(finished).toISOString(),
        operationId,
        preparation.revision,
        preparation.plan_sha256,
        operationId,
        preparation.intent_hash,
      )
      .run();
    return result.meta.changes === 1 && validAt(now());
  } catch {
    return false;
  }
}
