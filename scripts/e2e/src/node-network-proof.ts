// SPDX-License-Identifier: Apache-2.0
import { createPrivateKey, randomUUID } from "node:crypto";
import type { JsonWebKey, KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { NodeId, OperationId, RegionId } from "@pgcf/contracts";
import { ProviderInstanceId } from "@pgcf/contracts/nodes";
import { ContaboClient } from "../../../apps/api/src/providers/contabo.ts";
import type {
  ContaboFirewall,
  ContaboFirewallRulesInput,
} from "../../../apps/api/src/providers/contabo.ts";
import { nodeObservations } from "../../../apps/regional/src/agent/observe.ts";
import type { Resource } from "../../../apps/regional/src/agent/types.ts";
import {
  authenticated,
  assertScanWorkers,
  blocked,
  canonical,
  execute,
  fresh,
  hash,
  ip,
  scanAllPorts,
  routeSource,
  serveSourceControl,
  signed,
  tcp,
  writeArtifact,
  MAX_JSON_BYTES,
} from "./node-network-native.ts";
import type {
  ControlObservation,
  Envelope,
  ReviewedCommand,
  HttpsControl,
} from "./node-network-native.ts";
import { cidrPoolsDisjoint } from "./external-probe.ts";
import {
  capturePackets,
  packetEvidence,
  wireguardPeers,
} from "./node-network-packets.ts";

const MEASUREMENT_DOMAIN = "pgcf-node-measurement/v1\n";
export const PREPARATION_DOMAIN = "pgcf-node-preparation/v1\n";
export const VERIFICATION_DOMAIN = "pgcf-node-verification/v1\n";
type Addresses = { ipv4: string[]; ipv6: string[] };
export interface NetworkMember {
  node_id: string;
  provider_instance_id: string;
  firewall_id: string;
  addresses: Addresses;
  primary: Addresses;
  ownership_sha256: string;
  rules: ContaboFirewallRulesInput;
  rules_sha256: string;
}
export interface NetworkPlan {
  version: 1;
  operation_id: string;
  node_id: string;
  region_id: string;
  provider_instance_id: string;
  intent_hash: string;
  operators: Addresses;
  relay: { provider_instance_id: string; addresses: Addresses };
  scan_control: { ipv4: string; ipv6: string; port: number };
  members: NetworkMember[];
}
export interface VerificationBinding {
  input_hash: string;
  checkpoint_reference: string;
  cluster_uid: string;
  node_uid: string;
  node_resource_version: string;
  hostname: string;
}
export interface MeasurementBinding {
  plan_sha256: string;
  readback_at: string;
  verification: VerificationBinding | null;
}
export interface AccessObservation {
  provider_instance_id: string;
  address: string;
  relay_source: string;
  observed_at: string;
  checks: { port: 22 | 50000 | 6443; outcome: "connected" | "refused" }[];
}
export interface ScanObservation {
  provider_instance_id: string;
  address: string;
  protocol: "tcp";
  first_port: 1;
  last_port: 65535;
  scanned_ports: 65535;
  open_ports: number[];
  started_at: string;
  observed_at: string;
  before: ControlObservation;
  after: ControlObservation;
}
export type Measurement = {
  purpose: "pgcf-node-measurement/v1";
  binding_sha256: string;
  observed_at: string;
} & (
  | { kind: "access"; access: AccessObservation[] }
  | {
      kind: "scan";
      family: "ipv4" | "ipv6";
      source: string;
      scans: ScanObservation[];
    }
);
export interface CommonConfig {
  plan: NetworkPlan;
  binding: MeasurementBinding;
  measurement_keys: Record<string, string>;
  control_keys: Record<string, string>;
  kid: string;
  scan?: {
    https_control?: HttpsControl;
    source_pool?: string[];
    tcp25_control?: string;
  };
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    blocked("input_invalid");
  return value as Record<string, unknown>;
};
const exact = (value: unknown, fields: string[]) => {
  const row = object(value);
  if (Object.keys(row).sort().join(",") !== fields.sort().join(","))
    blocked("input_fields");
  return row;
};
const text = (value: unknown, pattern?: RegExp): string => {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    (pattern && !pattern.test(value))
  )
    blocked("input_invalid");
  return value;
};
const hashValue = (value: unknown) => text(value, /^[a-f0-9]{64}$/);
const uuid = (value: unknown) =>
  text(
    value,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  );
const timestamp = (value: unknown): string => {
  const at = text(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) ||
    !Number.isFinite(Date.parse(at))
  )
    blocked("timestamp_invalid");
  return at;
};
function list(value: unknown, max = 64): unknown[] {
  if (!Array.isArray(value) || value.length > max) blocked("input_invalid");
  return value;
}
function addressSet(value: unknown, cidrs = false): Addresses {
  const row = exact(value, ["ipv4", "ipv6"]);
  const result: Addresses = { ipv4: [], ipv6: [] };
  for (const family of ["ipv4", "ipv6"] as const)
    result[family] = list(row[family]).map((value) => {
      const raw = text(value),
        parts = raw.split("/"),
        address = ip(parts[0]!);
      if (
        isIP(address) !== (family === "ipv4" ? 4 : 6) ||
        (cidrs
          ? parts.length !== 2 ||
            parts[1] !== (family === "ipv4" ? "32" : "128")
          : parts.length !== 1)
      )
        blocked("family_mismatch");
      return cidrs ? `${address}/${parts[1]}` : address;
    });
  if (
    new Set([...result.ipv4, ...result.ipv6]).size !==
    result.ipv4.length + result.ipv6.length
  )
    blocked("duplicate_address");
  return result;
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
        blocked("firewall_rules_invalid");
      const ports: string[] = [];
      for (const raw of rule.destPorts) {
        const match = /^([1-9]\d{0,4})(?:-([1-9]\d{0,4}))?$/.exec(raw);
        if (!match) blocked("firewall_rules_invalid");
        const first = Number(match[1]),
          last = Number(match[2] ?? match[1]);
        if (first > last || last > 65535 || last - first > 15)
          blocked("firewall_rules_invalid");
        for (let port = first; port <= last; port++) ports.push(String(port));
      }
      const sources = addressSet(
        { ipv4: rule.srcCidr.ipv4 ?? [], ipv6: rule.srcCidr.ipv6 ?? [] },
        true,
      );
      if (
        !ports.length ||
        ports.length > 15 ||
        (!sources.ipv4.length && !sources.ipv6.length)
      )
        blocked("firewall_rules_invalid");
      return {
        protocol: rule.protocol,
        destPorts: [...new Set(ports)].sort(),
        srcCidr: { ipv4: sources.ipv4.sort(), ipv6: sources.ipv6.sort() },
        action: "accept",
        status: "active",
      };
    })
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
export function parsePlan(value: unknown, expectedSha256: string): NetworkPlan {
  const row = exact(value, [
    "version",
    "operation_id",
    "node_id",
    "region_id",
    "provider_instance_id",
    "intent_hash",
    "operators",
    "relay",
    "scan_control",
    "members",
  ]);
  if (row.version !== 1 || hash(value) !== hashValue(expectedSha256))
    blocked("plan_binding");
  OperationId.parse(row.operation_id);
  NodeId.parse(row.node_id);
  RegionId.parse(row.region_id);
  ProviderInstanceId.parse(row.provider_instance_id);
  hashValue(row.intent_hash);
  addressSet(row.operators, true);
  const relay = exact(row.relay, ["provider_instance_id", "addresses"]);
  ProviderInstanceId.parse(relay.provider_instance_id);
  addressSet(relay.addresses);
  const control = exact(row.scan_control, ["ipv4", "ipv6", "port"]);
  if (
    isIP(text(control.ipv4)) !== 4 ||
    isIP(text(control.ipv6)) !== 6 ||
    !Number.isInteger(control.port) ||
    Number(control.port) < 1 ||
    Number(control.port) > 65535
  )
    blocked("control_invalid");
  const members = list(row.members, 16);
  if (!members.length) blocked("members_missing");
  for (const value of members) {
    const member = exact(value, [
      "node_id",
      "provider_instance_id",
      "firewall_id",
      "addresses",
      "primary",
      "ownership_sha256",
      "rules",
      "rules_sha256",
    ]);
    NodeId.parse(member.node_id);
    ProviderInstanceId.parse(member.provider_instance_id);
    uuid(member.firewall_id);
    hashValue(member.ownership_sha256);
    const addresses = addressSet(member.addresses),
      primary = addressSet(member.primary);
    if (
      (!addresses.ipv4.length && !addresses.ipv6.length) ||
      [...primary.ipv4, ...primary.ipv6].some(
        (address) => ![...addresses.ipv4, ...addresses.ipv6].includes(address),
      )
    )
      blocked("member_addresses");
    const rules = exact(member.rules, ["rules"]),
      inbound = exact(rules.rules, ["inbound"]);
    if (
      hash(
        normalizedRules(
          list(inbound.inbound) as NetworkMember["rules"]["rules"]["inbound"],
        ),
      ) !== hashValue(member.rules_sha256)
    )
      blocked("rules_binding");
  }
  for (const field of ["node_id", "provider_instance_id", "firewall_id"])
    if (
      new Set(members.map((value) => object(value)[field])).size !==
      members.length
    )
      blocked("duplicate_member");
  const plan = value as NetworkPlan;
  if (
    !plan.members.some(
      (member) =>
        member.node_id === plan.node_id &&
        member.provider_instance_id === plan.provider_instance_id,
    )
  )
    blocked("node_plan_binding");
  return plan;
}
export function validateBinding(
  binding: MeasurementBinding,
  plan: NetworkPlan,
  now = Date.now(),
): void {
  exact(binding, ["plan_sha256", "readback_at", "verification"]);
  if (
    hash(plan) !== hashValue(binding.plan_sha256) ||
    Date.parse(timestamp(binding.readback_at)) > now
  )
    blocked("plan_binding");
  if (binding.verification !== null) {
    const value = exact(binding.verification, [
      "input_hash",
      "checkpoint_reference",
      "cluster_uid",
      "node_uid",
      "node_resource_version",
      "hostname",
    ]);
    hashValue(value.input_hash);
    uuid(value.cluster_uid);
    uuid(value.node_uid);
    text(value.node_resource_version, /^[0-9]{1,128}$/);
    text(value.checkpoint_reference, /^.{1,128}$/);
    text(value.hostname, /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/);
  }
}
function scope(binding: MeasurementBinding) {
  return hash(binding);
}
function outside(plan: NetworkPlan, source: string): void {
  const family = isIP(source) === 4 ? "ipv4" : "ipv6";
  if (!isIP(source)) blocked("source_invalid");
  const allowed = [
    ...plan.operators[family].map((cidr) => ip(cidr.split("/")[0]!)),
    ...plan.relay.addresses[family].map(ip),
    ...plan.members.flatMap((member) => member.addresses[family]).map(ip),
    ...plan.members
      .flatMap((member) =>
        member.rules.rules.inbound.flatMap(
          (rule) => rule.srcCidr[family] ?? [],
        ),
      )
      .map((cidr) => ip(cidr.split("/")[0]!)),
    ip(plan.scan_control[family]),
  ];
  if (allowed.includes(ip(source))) blocked("source_inside_allowlist");
}
export function assertScanSource(config: CommonConfig, source: string): void {
  outside(config.plan, source);
  if (config.scan?.https_control && isIP(source) === 4) {
    const pool = config.scan.source_pool;
    const allowlist = config.plan.members.flatMap((member) =>
      member.rules.rules.inbound.flatMap((rule) => [
        ...(rule.srcCidr.ipv4 ?? []),
        ...(rule.srcCidr.ipv6 ?? []),
      ]),
    );
    // NAT can choose another public source for another destination. Prove the
    // entire hosted runner pool is outside the actual firewall's source rules.
    if (
      !pool?.length ||
      !allowlist.length ||
      !cidrPoolsDisjoint(pool, allowlist) ||
      cidrPoolsDisjoint(pool, [`${source}/32`])
    )
      blocked("source_pool_unproven");
  }
}
export async function measureAccess(
  config: CommonConfig,
  source: string,
  key: KeyObject,
  deadline: number,
): Promise<Envelope<Measurement>> {
  validateBinding(config.binding, config.plan);
  if (config.binding.verification !== null) blocked("access_purpose");
  const family = isIP(source) === 4 ? "ipv4" : "ipv6";
  if (!config.plan.relay.addresses[family].map(ip).includes(ip(source)))
    blocked("relay_source_binding");
  const access: AccessObservation[] = [];
  for (const member of config.plan.members) {
    const address = member.addresses[family][0];
    if (!address) blocked("relay_family_unavailable");
    const checks: AccessObservation["checks"] = [];
    for (const port of [22, 50000, 6443] as const) {
      const outcome = await tcp(address, port, source, 3000, deadline);
      if (outcome !== "connected" && outcome !== "refused")
        blocked("relay_access_inconclusive");
      checks.push({ port, outcome });
    }
    if (!checks.some((check) => check.outcome === "connected"))
      blocked("relay_access_unproven");
    access.push({
      provider_instance_id: member.provider_instance_id,
      address,
      relay_source: ip(source),
      observed_at: new Date().toISOString(),
      checks,
    });
  }
  const payload: Measurement = {
    purpose: "pgcf-node-measurement/v1",
    kind: "access",
    binding_sha256: scope(config.binding),
    access,
    observed_at: new Date().toISOString(),
  };
  return signed(MEASUREMENT_DOMAIN, payload, config.kid, key);
}
export async function measureScans(
  config: CommonConfig,
  source: string,
  key: KeyObject,
  deadline: number,
): Promise<Envelope<Measurement>> {
  validateBinding(config.binding, config.plan);
  if (source === "auto") {
    if (!config.scan?.https_control || !config.scan.source_pool)
      blocked("source_unproven");
    source = await routeSource(config.plan.scan_control.ipv4, 443, deadline);
  }
  if (!config.scan?.https_control) outside(config.plan, source);
  const family = isIP(source) === 4 ? "ipv4" : "ipv6",
    scans: ScanObservation[] = [];
  let publicSource: string | null = null;
  const members =
    config.binding.verification === null
      ? config.plan.members
      : config.plan.members.filter(
          (member) => member.node_id === config.plan.node_id,
        );
  const targets = members.flatMap((member) =>
    member.addresses[family].map((address) => ({ member, address })),
  );
  let next = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(2, targets.length) }, async () => {
      while (next < targets.length) {
        const index = next++,
          { member, address } = targets[index]!;
        const scan = await scanAllPorts(
          address,
          source,
          {
            address: config.plan.scan_control[family],
            port: config.plan.scan_control.port,
            keys: config.control_keys,
            ...(config.scan?.https_control
              ? { https: config.scan.https_control }
              : {}),
          },
          deadline,
          {
            sourceCheck: (observed) => assertScanSource(config, observed),
            ...(config.scan?.tcp25_control
              ? { tcp25Control: config.scan.tcp25_control }
              : {}),
          },
        );
        if (publicSource !== null && ip(scan.public_source) !== publicSource)
          blocked("source_changed");
        publicSource = ip(scan.public_source);
        scans[index] = {
          provider_instance_id: member.provider_instance_id,
          address,
          protocol: "tcp",
          first_port: 1,
          last_port: 65535,
          scanned_ports: scan.scanned_ports,
          open_ports: scan.open_ports,
          started_at: scan.started_at,
          observed_at: scan.observed_at,
          before: scan.before,
          after: scan.after,
        };
      }
    }),
  );
  assertScanWorkers(workers);
  if (!scans.length) blocked("scan_family_unavailable");
  return signed(
    MEASUREMENT_DOMAIN,
    {
      purpose: "pgcf-node-measurement/v1",
      kind: "scan",
      binding_sha256: scope(config.binding),
      observed_at: new Date().toISOString(),
      family,
      source: publicSource!,
      scans,
    } as Measurement,
    config.kid,
    key,
  );
}
export function verifyMeasurements(
  config: CommonConfig,
  receipts: Envelope<Measurement>[],
  now: number,
): Measurement[] {
  validateBinding(config.binding, config.plan, now);
  if (receipts.length > 3) blocked("measurement_count");
  return receipts.map((envelope) => {
    exact(envelope, ["kid", "payload", "signature"]);
    const payload = authenticated(
      MEASUREMENT_DOMAIN,
      envelope,
      config.measurement_keys,
    );
    if (
      payload.purpose !== "pgcf-node-measurement/v1" ||
      payload.binding_sha256 !== scope(config.binding)
    )
      blocked("measurement_binding");
    fresh(timestamp(payload.observed_at), config.binding.readback_at, now);
    if (payload.kind === "access") {
      exact(payload, [
        "purpose",
        "kind",
        "binding_sha256",
        "observed_at",
        "access",
      ]);
      if (
        config.binding.verification !== null ||
        payload.access.length !== config.plan.members.length
      )
        blocked("access_coverage");
      const seen = new Set<string>();
      for (const access of payload.access) {
        exact(access, [
          "provider_instance_id",
          "address",
          "relay_source",
          "observed_at",
          "checks",
        ]);
        const member = config.plan.members.find(
            (member) =>
              member.provider_instance_id === access.provider_instance_id,
          ),
          family = isIP(access.address) === 4 ? "ipv4" : "ipv6";
        if (
          !member ||
          seen.has(access.provider_instance_id) ||
          !member.addresses[family].map(ip).includes(ip(access.address)) ||
          !config.plan.relay.addresses[family]
            .map(ip)
            .includes(ip(access.relay_source)) ||
          isIP(access.address) !== isIP(access.relay_source) ||
          access.checks.length !== 3 ||
          new Set(access.checks.map((check) => check.port)).size !== 3 ||
          access.checks.some(
            (check) =>
              ![22, 50000, 6443].includes(check.port) ||
              !["connected", "refused"].includes(check.outcome),
          ) ||
          !access.checks.some((check) => check.outcome === "connected")
        )
          blocked("access_binding");
        seen.add(access.provider_instance_id);
        fresh(timestamp(access.observed_at), config.binding.readback_at, now);
      }
    } else if (payload.kind === "scan") {
      exact(payload, [
        "purpose",
        "kind",
        "binding_sha256",
        "observed_at",
        "family",
        "source",
        "scans",
      ]);
      const family = payload.family;
      if (
        !["ipv4", "ipv6"].includes(family) ||
        isIP(payload.source) !== (family === "ipv4" ? 4 : 6)
      )
        blocked("family_mismatch");
      assertScanSource(config, payload.source);
      const members =
        config.binding.verification === null
          ? config.plan.members
          : config.plan.members.filter(
              (member) => member.node_id === config.plan.node_id,
            );
      const targets = members.flatMap((member) =>
        member.addresses[family].map(
          (address) => `${member.provider_instance_id}:${ip(address)}`,
        ),
      );
      if (
        !targets.length ||
        payload.scans.length !== targets.length ||
        new Set(
          payload.scans.map(
            (scan) => `${scan.provider_instance_id}:${ip(scan.address)}`,
          ),
        ).size !== targets.length
      )
        blocked("scan_coverage");
      for (const scan of payload.scans) {
        exact(scan, [
          "provider_instance_id",
          "address",
          "protocol",
          "first_port",
          "last_port",
          "scanned_ports",
          "open_ports",
          "started_at",
          "observed_at",
          "before",
          "after",
        ]);
        if (
          !targets.includes(
            `${scan.provider_instance_id}:${ip(scan.address)}`,
          ) ||
          isIP(scan.address) !== isIP(payload.source) ||
          scan.protocol !== "tcp" ||
          scan.first_port !== 1 ||
          scan.last_port !== 65535 ||
          scan.scanned_ports !== 65535 ||
          scan.open_ports.length !== 0
        )
          blocked("scan_coverage");
        fresh(timestamp(scan.started_at), config.binding.readback_at, now);
        fresh(timestamp(scan.observed_at), scan.started_at, now);
        for (const control of [scan.before, scan.after]) {
          exact(control, ["address", "port", "source", "observed_at", "nonce"]);
          if (
            ip(control.source) !== ip(payload.source) ||
            ip(control.address) !== ip(config.plan.scan_control[family]) ||
            control.port !== config.plan.scan_control.port ||
            !/^[a-f0-9]{64}$/.test(control.nonce)
          )
            blocked("control_binding");
          fresh(
            timestamp(control.observed_at),
            config.binding.readback_at,
            now,
          );
        }
        if (
          scan.before.observed_at > scan.started_at ||
          scan.after.observed_at !== scan.observed_at ||
          scan.before.nonce === scan.after.nonce
        )
          blocked("control_adjacency");
      }
    } else blocked("measurement_kind");
    return payload;
  });
}
export function firewallEvidence(
  plan: NetworkPlan,
  firewalls: ContaboFirewall[],
) {
  if (firewalls.length !== plan.members.length) blocked("firewall_coverage");
  return plan.members.map((member) => {
    const firewall = firewalls.find(
        (value) => value.firewallId === member.firewall_id,
      ),
      drop = firewall?.rules.inbound.at(-1);
    if (
      !firewall ||
      firewall.status !== "active" ||
      hash([firewall.tenantId, firewall.customerId]) !==
        member.ownership_sha256 ||
      !drop ||
      drop.action !== "drop" ||
      drop.status !== "active" ||
      drop.protocol !== "" ||
      drop.destPorts.length ||
      (drop.srcCidr.ipv4?.length ?? 0) ||
      (drop.srcCidr.ipv6?.length ?? 0) ||
      firewall.rules.inbound.filter((rule) => rule.action === "drop").length !==
        1 ||
      firewall.instances.length !== 1 ||
      firewall.instanceStatus.length !== 1 ||
      firewall.instances[0]!.instanceId !== member.provider_instance_id ||
      firewall.instanceStatus[0]!.instanceId !== member.provider_instance_id ||
      firewall.instanceStatus[0]!.status !== "ok"
    )
      blocked("firewall_binding");
    const actualPrimary = {
      ipv4: firewall.instances[0]!.ipConfig.v4.ip
        ? [ip(firewall.instances[0]!.ipConfig.v4.ip)]
        : [],
      ipv6: firewall.instances[0]!.ipConfig.v6.ip
        ? [ip(firewall.instances[0]!.ipConfig.v6.ip)]
        : [],
    };
    if (
      canonical(actualPrimary) !== canonical(member.primary) ||
      hash(normalizedRules(firewall.rules.inbound.slice(0, -1))) !==
        member.rules_sha256
    )
      blocked("firewall_readback_changed");
    return {
      firewall_id: member.firewall_id,
      provider_instance_id: member.provider_instance_id,
      rules_sha256: member.rules_sha256,
    };
  });
}
function scansFor(config: CommonConfig, measurements: Measurement[]) {
  const external = { ipv4: null, ipv6: null } as Record<
    "ipv4" | "ipv6",
    null | {
      source: string;
      positive_control: {
        address: string;
        port: number;
        outcome: "connected";
        observed_at: string;
      };
      scans: Omit<ScanObservation, "before" | "after">[];
    }
  >;
  for (const family of ["ipv4", "ipv6"] as const) {
    const members =
      config.binding.verification === null
        ? config.plan.members
        : config.plan.members.filter(
            (member) => member.node_id === config.plan.node_id,
          );
    const expected = members.flatMap((member) => member.addresses[family]);
    const receipts = measurements.filter(
      (value) => value.kind === "scan" && value.family === family,
    );
    if (receipts.length !== (expected.length ? 1 : 0))
      blocked("scan_family_coverage");
    const receipt = receipts[0];
    if (receipt?.kind !== "scan") continue;
    const last = receipt.scans.at(-1)!;
    external[family] = {
      source: receipt.source,
      positive_control: {
        address: last.after.address,
        port: last.after.port,
        outcome: "connected",
        observed_at: last.after.observed_at,
      },
      scans: receipt.scans.map((scan) => ({
        provider_instance_id: scan.provider_instance_id,
        address: scan.address,
        protocol: scan.protocol,
        first_port: scan.first_port,
        last_port: scan.last_port,
        scanned_ports: scan.scanned_ports,
        open_ports: scan.open_ports,
        started_at: scan.started_at,
        observed_at: scan.observed_at,
      })),
    };
  }
  return external;
}
export async function producePreparation(
  config: CommonConfig,
  receipts: Envelope<Measurement>[],
  key: KeyObject,
  deadline: number,
) {
  const measurements = verifyMeasurements(config, receipts, Date.now());
  if (config.binding.verification !== null) blocked("preparation_purpose");
  const accesses = measurements.filter((value) => value.kind === "access");
  if (accesses.length !== 1 || accesses[0]!.kind !== "access")
    blocked("access_coverage");
  const client = new ContaboClient({
    clientId: requiredEnv("CONTABO_CLIENT_ID"),
    clientSecret: requiredEnv("CONTABO_CLIENT_SECRET"),
    username: requiredEnv("CONTABO_USERNAME"),
    password: requiredEnv("CONTABO_PASSWORD"),
    timeoutMs: 10000,
  });
  const firewalls: ContaboFirewall[] = [];
  for (const member of config.plan.members)
    firewalls.push(
      await client.getFirewall(member.firewall_id, {
        requestId: randomUUID(),
        deadline,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      }),
    );
  verifyMeasurements(config, receipts, Date.now());
  const plan = config.plan,
    observed_at = new Date().toISOString();
  const payload = {
    version: 1,
    operation_id: plan.operation_id,
    node_id: plan.node_id,
    region_id: plan.region_id,
    provider_instance_id: plan.provider_instance_id,
    intent_hash: plan.intent_hash,
    plan_sha256: config.binding.plan_sha256,
    observed_at,
    expires_at: new Date(Date.now() + 120000).toISOString(),
    relay_provider_instance_id: plan.relay.provider_instance_id,
    access: accesses[0]!.access,
    firewalls: firewallEvidence(plan, firewalls),
    external: scansFor(config, measurements),
  };
  const artifact = signed(PREPARATION_DOMAIN, payload, config.kid, key);
  if (Buffer.byteLength(canonical(artifact)) > 65536)
    blocked("preparation_bytes");
  return artifact;
}
export interface PostjoinConfig extends CommonConfig {
  kubectl: ReviewedCommand;
  wireguard: {
    device: string;
    interfaces: ReviewedCommand;
    endpoints: ReviewedCommand;
    handshakes: ReviewedCommand;
  };
  capture: null | {
    command: ReviewedCommand;
    traffic: ReviewedCommand;
    device: string;
    duration_ms: number;
  };
}
async function kube(
  config: PostjoinConfig,
  args: string[],
  deadline: number,
): Promise<Resource> {
  const result = await execute(
    { ...config.kubectl, args: [...config.kubectl.args, ...args] },
    deadline,
  );
  return JSON.parse(result.stdout.toString("utf8")) as Resource;
}
export function boundCapacity(
  config: CommonConfig,
  namespace: Resource,
  node: Resource,
  pods: Resource[],
  namespaces: Resource[],
) {
  const binding = config.binding.verification;
  if (
    !binding ||
    namespace.metadata.uid !== binding.cluster_uid ||
    node.metadata.uid !== binding.node_uid ||
    node.metadata.resourceVersion !== binding.node_resource_version ||
    node.metadata.name !== binding.hostname ||
    node.metadata.labels?.["pgcf.io/node-id"] !== config.plan.node_id ||
    node.metadata.labels?.["pgcf.io/provider-instance-id"] !==
      config.plan.provider_instance_id
  )
    blocked("kubernetes_binding");
  const taints = object(node.spec).taints;
  if (
    !Array.isArray(taints) ||
    !taints.some(
      (taint) =>
        object(taint).key === "pgcf.io/quarantine" &&
        object(taint).value === "bootstrap" &&
        object(taint).effect === "NoSchedule",
    )
  )
    blocked("quarantine_missing");
  const measured = nodeObservations([node], pods, namespaces)[0]!;
  if (
    !measured.ready ||
    measured.storage_gib_total === null ||
    measured.storage_gib_total < 1 ||
    typeof measured.platform_reserved_cpu_millicores !== "number" ||
    measured.allocatable_cpu_millicores <=
      measured.platform_reserved_cpu_millicores ||
    measured.allocatable_memory_mib <= measured.platform_reserved_memory_mib
  )
    blocked("capacity_unavailable");
  return measured;
}
export async function produceVerification(
  config: PostjoinConfig,
  receipts: Envelope<Measurement>[],
  key: KeyObject,
  deadline: number,
) {
  const binding = config.binding.verification;
  if (!binding) blocked("verification_purpose");
  const measurements = verifyMeasurements(config, receipts, Date.now()),
    scans = scansFor(config, measurements);
  const namespace = await kube(
    config,
    ["get", "namespace", "kube-system", "-o", "json"],
    deadline,
  );
  const node = await kube(
    config,
    ["get", "node", binding.hostname, "-o", "json"],
    deadline,
  );
  const podList = object(
    await kube(
      config,
      ["get", "pods", "--all-namespaces", "-o", "json"],
      deadline,
    ),
  );
  const namespaceList = object(
    await kube(config, ["get", "namespaces", "-o", "json"], deadline),
  );
  const pods = list(podList.items, 10000) as Resource[],
    namespaces = list(namespaceList.items, 10000) as Resource[];
  const capacity = boundCapacity(config, namespace, node, pods, namespaces);
  const member = config.plan.members.find(
    (value) => value.node_id === config.plan.node_id,
  )!;
  if (member.addresses.ipv4.length !== 1 || member.addresses.ipv6.length > 1)
    blocked("verification_address_coverage");
  const expectedPeers = config.plan.members
    .filter((value) => value.node_id !== config.plan.node_id)
    .map((value) => ({
      node_id: value.node_id,
      provider_instance_id: value.provider_instance_id,
      address:
        value.primary.ipv4[0] ??
        value.primary.ipv6[0] ??
        blocked("peer_address_missing"),
    }));
  const raw = await Promise.all(
    [
      config.wireguard.interfaces,
      config.wireguard.endpoints,
      config.wireguard.handshakes,
    ].map((command) => execute(command, deadline, { maxBytes: 65536 })),
  );
  const peers = wireguardPeers(
    raw[0]!.stdout.toString("utf8"),
    raw[1]!.stdout.toString("utf8"),
    raw[2]!.stdout.toString("utf8"),
    config.wireguard.device,
    expectedPeers,
    new Date().toISOString(),
  );
  let packet_observations: {
    source_node_id: string;
    destination_node_id: string;
    captured_at: string;
    encrypted_packets: number;
    plaintext_pod_packets: 0;
  }[] = [];
  if (peers.length) {
    if (!config.capture) blocked("capture_required");
    const capture = await capturePackets(
      config.capture.command,
      config.capture.traffic,
      config.capture.device,
      config.capture.duration_ms,
      deadline,
    );
    const podAddresses = pods.flatMap((pod) => {
      if (object(pod.spec).hostNetwork === true) return [];
      const status = object(pod.status),
        addresses = status.podIPs;
      return Array.isArray(addresses)
        ? addresses.map((value) => text(object(value).ip))
        : [];
    });
    packet_observations = packetEvidence(
      capture.stdout,
      capture.stderr.toString("utf8"),
      member.primary.ipv4[0] ?? member.primary.ipv6[0]!,
      expectedPeers,
      podAddresses,
      capture.started_at,
      capture.finished_at,
    ).map((value) => ({
      source_node_id: config.plan.node_id,
      destination_node_id: value.peer.node_id,
      captured_at: value.captured_at,
      encrypted_packets: value.encrypted_packets,
      plaintext_pod_packets: value.plaintext_pod_packets,
    }));
  } else if (config.capture !== null) blocked("singleton_capture_refused");
  const finalNamespace = await kube(
      config,
      ["get", "namespace", "kube-system", "-o", "json"],
      deadline,
    ),
    finalNode = await kube(
      config,
      ["get", "node", binding.hostname, "-o", "json"],
      deadline,
    );
  const finalCapacity = boundCapacity(
    config,
    finalNamespace,
    finalNode,
    pods,
    namespaces,
  );
  if (canonical(capacity) !== canonical(finalCapacity))
    blocked("capacity_changed");
  verifyMeasurements(config, receipts, Date.now());
  const observed_at = new Date().toISOString();
  const payload = {
    purpose: "pgcf-node-verification/v1",
    operation_id: config.plan.operation_id,
    node_id: config.plan.node_id,
    region_id: config.plan.region_id,
    provider_instance_id: config.plan.provider_instance_id,
    intent_hash: config.plan.intent_hash,
    input_hash: binding.input_hash,
    checkpoint_reference: binding.checkpoint_reference,
    cluster_uid: binding.cluster_uid,
    node_uid: binding.node_uid,
    node_resource_version: binding.node_resource_version,
    observed_at,
    expires_at: new Date(Date.now() + 120000).toISOString(),
    addresses: {
      ipv4: member.addresses.ipv4[0]!,
      ipv6: member.addresses.ipv6[0] ?? null,
    },
    wireguard: { mode: "wireguard", peers, packet_observations },
    scans: Object.entries(scans).flatMap(([family, receipt]) =>
      receipt
        ? receipt.scans.map((scan) => ({
            family,
            address: scan.address,
            source: receipt.source,
            observed_at: scan.observed_at,
            scanned_ports: scan.scanned_ports,
            open_ports: scan.open_ports,
            control: {
              address: receipt.positive_control.address,
              port: receipt.positive_control.port,
              connected: true,
            },
          }))
        : [],
    ),
  };
  for (const peer of peers)
    fresh(
      peer.last_handshake_at,
      new Date(Date.now() - 180000).toISOString(),
      Date.now(),
      180000,
    );
  return signed(VERIFICATION_DOMAIN, payload, config.kid, key);
}
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) blocked("environment_missing");
  return value;
}
export async function main(mode = process.argv[2]): Promise<void> {
  const raw = requiredEnv("PGCF_NETWORK_CONFIG_JSON");
  if (Buffer.byteLength(raw) > MAX_JSON_BYTES) blocked("config_bytes");
  const config = object(JSON.parse(raw));
  const key = createPrivateKey({
    key: JSON.parse(requiredEnv("PGCF_NETWORK_SIGNING_JWK")) as JsonWebKey,
    format: "jwk",
  });
  const kid = text(config.kid, /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
  const duration = Number(config.deadline_ms ?? 120000);
  if (!Number.isInteger(duration) || duration < 1 || duration > 600000)
    blocked("deadline_invalid");
  const deadline = Date.now() + duration;
  if (mode === "control") {
    await serveSourceControl(
      text(config.address),
      Number(config.port),
      kid,
      key,
      duration,
    );
    return;
  }
  const binding = config.binding as MeasurementBinding,
    plan = parsePlan(config.plan, binding.plan_sha256);
  const common: CommonConfig = {
    plan,
    binding,
    kid,
    measurement_keys: object(config.measurement_keys) as Record<string, string>,
    control_keys: object(config.control_keys) as Record<string, string>,
    ...(config.scan ? { scan: config.scan as CommonConfig["scan"] } : {}),
  };
  let artifact: unknown;
  if (mode === "access")
    artifact = await measureAccess(common, text(config.source), key, deadline);
  else if (mode === "scan")
    artifact = await measureScans(common, text(config.source), key, deadline);
  else if (mode === "prepare")
    artifact = await producePreparation(
      common,
      list(config.measurements, 3) as Envelope<Measurement>[],
      key,
      deadline,
    );
  else if (mode === "verify")
    artifact = await produceVerification(
      {
        ...common,
        kubectl: config.kubectl as ReviewedCommand,
        wireguard: config.wireguard as PostjoinConfig["wireguard"],
        capture: config.capture as PostjoinConfig["capture"],
      },
      list(config.measurements, 2) as Envelope<Measurement>[],
      key,
      deadline,
    );
  else blocked("mode_invalid");
  const sha256 = await writeArtifact(
    requiredEnv("PGCF_NETWORK_OUTPUT"),
    artifact,
  );
  process.stdout.write(
    JSON.stringify({ event: "node_network_artifact_written", sha256 }) + "\n",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write("node_network_proof_failed\n");
    process.exitCode = 1;
  });
