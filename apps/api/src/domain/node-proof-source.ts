// SPDX-License-Identifier: Apache-2.0
import { NodeId, OperationId, RegionId } from "@pgcf/contracts";
import {
  NodeBootstrapInput,
  NodeJoinBundle,
  NodePlatformSpec,
} from "@pgcf/contracts/node-bootstrap";
import { NodeInspectionInput } from "@pgcf/contracts/node-installation";
import { z } from "zod";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import {
  joinBundleReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import {
  hasAllocatedContaboHardware,
  type ContaboClient,
  type ContaboInstance,
} from "../providers/contabo.ts";
import { contaboClient } from "./bootstrap-relay.ts";
import {
  installationHash,
  loadNodeInstallationBinding,
  readNodeInstallationProfile,
} from "./node-installation.ts";
import { assertNodeRecoveryAuthority, readNodeAddition } from "./node-state.ts";
import { NODE_OBSERVATION_MAX_AGE_MS } from "./placement.ts";
import { validateRescueConfiguration } from "./rescue-configuration.ts";

export type Source =
  | {
      kind: "rescue";
      operation_id: string;
      node_id: string;
      region_id: string;
      provider_instance_id: string;
      ipv4: string;
      ipv6?: string;
      access: {
        rescue: NodeBootstrapInput["rescue"];
        expected_network: NodeInspectionInput["expected_network"];
        binding_sha256: string;
        inspection_generation: number;
        profile_sha256: string;
      };
    }
  | {
      kind: "pod";
      cluster_uid: string;
      node_uid: string;
      node_name: string;
      region_id: string;
      node_id: string;
      provider_instance_id: string;
      ipv4: string;
      ipv6?: string;
      image: string;
      access: { join_bundle: NodeJoinBundle };
    };

const Addresses = z.looseObject({
  ipv4: z.array(z.ipv4()).max(64),
  ipv6: z.array(z.ipv6()).max(64),
});
const Plan = z.looseObject({
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  provider_instance_id: z.string().regex(/^[1-9][0-9]*$/),
  intent_hash: z.string().regex(/^[a-f0-9]{64}$/),
  operators: z.looseObject({
    ipv4: z.array(z.string()).max(256),
    ipv6: z.array(z.string()).max(256),
  }),
  relay: z.looseObject({
    provider_instance_id: z.string().regex(/^[1-9][0-9]*$/),
    addresses: Addresses,
  }),
  scan_control: z.looseObject({
    ipv4: z.ipv4(),
    ipv6: z.ipv6(),
    port: z.number().int().min(1).max(65535),
  }),
  members: z
    .array(
      z.looseObject({
        node_id: NodeId,
        provider_instance_id: z.string().regex(/^[1-9][0-9]*$/),
        firewall_id: z.uuid().optional(),
        rules_sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        addresses: Addresses,
        rules: z.looseObject({
          rules: z.looseObject({
            inbound: z
              .array(
                z.looseObject({
                  srcCidr: z.looseObject({
                    ipv4: z.array(z.string()).max(256).optional(),
                    ipv6: z.array(z.string()).max(256).optional(),
                  }),
                }),
              )
              .max(256),
          }),
        }),
      }),
    )
    .min(1)
    .max(16),
});
export const nodeProofSourcePlanSchema = Plan;

export interface NodeProofSourceOptions {
  provider?: Pick<ContaboClient, "getInstance">;
  now?: () => number;
  /** The coordinator supplies an administrator-configured qualified immutable image. */
  sourceImage?: string;
}

const unavailable = (): never => {
  throw new ApiError(
    "conflict",
    "Network proof source authority is unavailable or changed",
  );
};
function address(value: string) {
  if (z.ipv4().safeParse(value).success)
    return {
      family: 4,
      value: value.split(".").reduce((n, part) => n * 256n + BigInt(part), 0n),
      normalized: value,
    };
  if (
    !z.ipv6().safeParse(value).success ||
    value.includes("%") ||
    value.includes(".")
  )
    return unavailable();
  const normalized = new URL(`https://[${value}]`).hostname.slice(1, -1);
  const [left = "", right = ""] = normalized.split("::"),
    first = left ? left.split(":") : [],
    last = right ? right.split(":") : [],
    groups = normalized.includes("::")
      ? [
          ...first,
          ...Array<string>(8 - first.length - last.length).fill("0"),
          ...last,
        ]
      : first;
  return {
    family: 6,
    value: groups.reduce((n, part) => n * 65536n + BigInt(`0x${part}`), 0n),
    normalized,
  };
}
function range(value: string) {
  const [host, prefix, extra] = value.split("/");
  if (
    !host ||
    prefix === undefined ||
    extra !== undefined ||
    !/^(?:0|[1-9][0-9]{0,2})$/.test(prefix)
  )
    return unavailable();
  const ip = address(host),
    width = ip.family === 4 ? 32 : 128;
  if (Number(prefix) > width) return unavailable();
  const mask = (1n << BigInt(width - Number(prefix))) - 1n;
  return { family: ip.family, first: ip.value & ~mask, last: ip.value | mask };
}
function contains(
  cidr: ReturnType<typeof range>,
  ip: ReturnType<typeof address>,
) {
  return (
    cidr.family === ip.family && cidr.first <= ip.value && ip.value <= cidr.last
  );
}
function publicAddress(value: string) {
  const ip = address(value);
  if (ip.family === 6)
    return ip.value >> 125n === 1n && !contains(range("2001:db8::/32"), ip);
  return ![
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/3",
  ].some((cidr) => contains(range(cidr), ip));
}
function exclusions(plan: z.infer<typeof Plan>) {
  const exact = (value: string) =>
    `${value}/${address(value).family === 4 ? 32 : 128}`;
  return [
    ...plan.operators.ipv4,
    ...plan.operators.ipv6,
    ...plan.relay.addresses.ipv4.map(exact),
    ...plan.relay.addresses.ipv6.map(exact),
    exact(plan.scan_control.ipv4),
    exact(plan.scan_control.ipv6),
    ...plan.members.flatMap((member) => [
      ...member.addresses.ipv4.map(exact),
      ...member.addresses.ipv6.map(exact),
      ...member.rules.rules.inbound.flatMap((rule) => [
        ...(rule.srcCidr.ipv4 ?? []),
        ...(rule.srcCidr.ipv6 ?? []),
      ]),
    ]),
  ].map(range);
}
function selectedAddresses(
  actual: ContaboInstance,
  denied: ReturnType<typeof exclusions>,
  needsIpv6: boolean,
) {
  if (!hasAllocatedContaboHardware(actual)) return null;
  const ipv4 = actual.ipConfig.v4.ip,
    ipv6 = actual.ipConfig.v6?.ip;
  if (
    !publicAddress(ipv4) ||
    (ipv6 && !publicAddress(ipv6)) ||
    (needsIpv6 && !ipv6)
  )
    return null;
  if (
    [ipv4, ...(ipv6 ? [ipv6] : [])].some((ip) =>
      denied.some((cidr) => contains(cidr, address(ip))),
    )
  )
    return null;
  return { ipv4, ...(ipv6 ? { ipv6: address(ipv6).normalized } : {}) };
}
/** The report validator uses the same complete CIDR exclusions as source selection. */
export function nodeProofSourceOutsidePlan(
  value: unknown,
  source: string,
): boolean {
  const plan = Plan.safeParse(value);
  if (!plan.success || !publicAddress(source)) return false;
  return !exclusions(plan.data).some((cidr) => contains(cidr, address(source)));
}
interface NodeRow {
  id: string;
  region_id: string;
  provider_instance_id: string;
  node_uid: string;
  k8s_node_name: string;
  provider_region: string;
}

/** Read-only source selection. Native execution rechecks actual Node UID/Ready and both address families. */
export async function selectNodeProofSource(
  env: Env,
  targetOperationId: string,
  value: unknown,
  options: NodeProofSourceOptions = {},
): Promise<Source | null> {
  const parsed = Plan.safeParse(value);
  if (!parsed.success) return unavailable();
  const plan = parsed.data;
  const target = await readNodeAddition(env.DB, targetOperationId);
  await assertNodeRecoveryAuthority(env.DB, target);
  const saved = await env.DB.prepare(
    "SELECT plan_sha256,status,readback_at FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(targetOperationId)
    .first<{
      plan_sha256: string;
      status: string;
      readback_at: string | null;
    }>();
  if (
    !target.slot_held ||
    !target.audit ||
    !target.receipt ||
    !target.provider_instance_id ||
    target.audit.provider_instance_id !== target.provider_instance_id ||
    target.receipt.provider_instance_id !== target.provider_instance_id ||
    !["audited", "bootstrapping"].includes(target.status) ||
    plan.operation_id !== targetOperationId ||
    plan.node_id !== target.intent.node_id ||
    plan.region_id !== target.intent.request.region_id ||
    plan.provider_instance_id !== target.provider_instance_id ||
    plan.intent_hash !== target.intent_hash ||
    !saved?.readback_at ||
    saved.status === "blocked" ||
    saved.plan_sha256 !== (await installationHash(value))
  )
    return unavailable();
  const denied = exclusions(plan),
    needsIpv6 = plan.members.some((member) => member.addresses.ipv6.length > 0),
    forbiddenIds = new Set([
      plan.provider_instance_id,
      plan.relay.provider_instance_id,
      ...plan.members.map((member) => member.provider_instance_id),
    ]),
    now = (options.now ?? Date.now)(),
    provider = options.provider ?? contaboClient(env);
  const inventory = new Map<string, Promise<ContaboInstance>>();
  const freshInstance = (id: string) => {
    let pending = inventory.get(id);
    if (!pending) {
      pending = provider.getInstance(id, { requestId: crypto.randomUUID() });
      inventory.set(id, pending);
    }
    return pending;
  };
  const targetActual = await freshInstance(target.provider_instance_id);
  if (
    !hasAllocatedContaboHardware(targetActual) ||
    targetActual.cancelDate !== null ||
    targetActual.id !== target.provider_instance_id ||
    targetActual.region !== target.audit.provider_region ||
    targetActual.productId !== target.audit.product_id ||
    targetActual.imageId !== target.audit.image_id ||
    (target.intent.request.mode === "order" &&
      targetActual.displayName !== target.intent.requested_hostname)
  )
    return unavailable();
  const owned = (actual: ContaboInstance, id: string, region: string) =>
    actual.id === id &&
    actual.region === region &&
    actual.region !== targetActual.region &&
    actual.customerId === targetActual.customerId &&
    actual.tenantId === targetActual.tenantId &&
    !forbiddenIds.has(actual.id);
  const currentNode = async (node: NodeRow) => {
    const at = (options.now ?? Date.now)();
    return !!(await env.DB.prepare(
      `SELECT 1 present FROM nodes n JOIN regions r ON r.id=n.region_id
       WHERE n.id=? AND n.region_id=? AND n.provider_instance_id=? AND n.node_uid=?
         AND n.k8s_node_name=? AND n.ready=1 AND n.lost_at IS NULL
         AND r.provider='contabo' AND r.provider_region=?
         AND n.last_observed_at>=? AND n.last_observed_at<=?`,
    )
      .bind(
        node.id,
        node.region_id,
        node.provider_instance_id,
        node.node_uid,
        node.k8s_node_name,
        node.provider_region,
        new Date(at - NODE_OBSERVATION_MAX_AGE_MS).toISOString(),
        new Date(at + 5000).toISOString(),
      )
      .first());
  };
  const nodes = await env.DB.prepare(
    `SELECT n.id,n.region_id,n.provider_instance_id,n.node_uid,n.k8s_node_name,r.provider_region
     FROM nodes n JOIN regions r ON r.id=n.region_id
     WHERE r.provider='contabo' AND r.provider_region<>? AND n.lost_at IS NULL AND n.ready=1
       AND n.provider_instance_id IS NOT NULL AND n.node_uid IS NOT NULL
       AND n.last_observed_at>=? AND n.last_observed_at<=?
     ORDER BY n.id LIMIT 16`,
  )
    .bind(
      targetActual.region,
      new Date(now - NODE_OBSERVATION_MAX_AGE_MS).toISOString(),
      new Date(now + 5000).toISOString(),
    )
    .all<NodeRow>();
  if (
    options.sourceImage &&
    NodePlatformSpec.shape.regional_image.safeParse(options.sourceImage).success
  ) {
    const targetProfile = await readNodeInstallationProfile(
      env,
      target.intent.request.region_id,
    );
    for (const node of nodes.results) {
      if (
        !z.uuid().safeParse(node.node_uid).success ||
        forbiddenIds.has(node.provider_instance_id)
      )
        continue;
      const sourceProfile = await readNodeInstallationProfile(
        env,
        node.region_id,
      );
      if (
        ![
          targetProfile?.profile.first_region?.regional_image,
          sourceProfile?.profile.first_region?.regional_image,
        ].includes(options.sourceImage)
      )
        continue;
      const actual = await freshInstance(node.provider_instance_id);
      if (
        !owned(actual, node.provider_instance_id, node.provider_region) ||
        actual.status !== "running" ||
        actual.cancelDate !== null
      )
        continue;
      const addresses = selectedAddresses(actual, denied, needsIpv6);
      if (!addresses) continue;
      let bundle: NodeJoinBundle;
      try {
        bundle = NodeJoinBundle.parse(
          await loadRegionJoinBundle(
            env.DB,
            env.CREDENTIAL_KEYS,
            joinBundleReference(node.region_id, 1),
          ),
        );
      } catch {
        continue;
      }
      const endpoint = new URL(bundle.cluster_endpoint);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.port !== "6443" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        continue;
      const endpointIp = endpoint.hostname.replace(/^\[|\]$/g, "");
      let endpointNode: NodeRow | null = null;
      for (const control of nodes.results.filter(
        (candidate) => candidate.region_id === node.region_id,
      )) {
        const controlActual =
          control.id === node.id
            ? actual
            : await freshInstance(control.provider_instance_id);
        if (
          hasAllocatedContaboHardware(controlActual) &&
          controlActual.status === "running" &&
          controlActual.cancelDate === null &&
          controlActual.id === control.provider_instance_id &&
          controlActual.region === control.provider_region &&
          controlActual.customerId === targetActual.customerId &&
          controlActual.tenantId === targetActual.tenantId &&
          [controlActual.ipConfig.v4.ip, controlActual.ipConfig.v6?.ip].some(
            (ip) =>
              ip && address(ip).normalized === address(endpointIp).normalized,
          )
        ) {
          endpointNode = control;
          break;
        }
      }
      if (
        !endpointNode ||
        !(await currentNode(endpointNode)) ||
        !(await currentNode(node))
      )
        continue;
      return {
        kind: "pod",
        cluster_uid: bundle.kube_system_uid,
        node_uid: node.node_uid,
        node_name: node.k8s_node_name,
        region_id: node.region_id,
        node_id: node.id,
        provider_instance_id: actual.id,
        ...addresses,
        image: options.sourceImage,
        access: { join_bundle: bundle },
      };
    }
  }
  const rescues = await env.DB.prepare(
    `SELECT b.operation_id FROM node_installation_bindings b
     JOIN node_additions a ON a.operation_id=b.operation_id JOIN regions r ON r.id=b.region_id
     WHERE r.provider='contabo' AND r.provider_region<>? AND a.status IN('audited','bootstrapping') AND a.slot_held=1
       AND NOT EXISTS(SELECT 1 FROM node_bootstrap_jobs j WHERE j.operation_id=a.operation_id AND j.cancelled=0)
     ORDER BY b.operation_id LIMIT 16`,
  )
    .bind(targetActual.region)
    .all<{ operation_id: string }>();
  for (const candidate of rescues.results) {
    const addition = await readNodeAddition(env.DB, candidate.operation_id);
    const binding = await loadNodeInstallationBinding(
      env,
      candidate.operation_id,
    );
    if (
      !binding ||
      !addition.audit ||
      !addition.receipt ||
      !addition.provider_instance_id ||
      !addition.slot_held ||
      !["audited", "bootstrapping"].includes(addition.status) ||
      addition.audit.provider_instance_id !== addition.provider_instance_id ||
      addition.receipt.provider_instance_id !== addition.provider_instance_id ||
      forbiddenIds.has(addition.provider_instance_id) ||
      binding.row.provider_instance_id !== addition.provider_instance_id ||
      binding.row.node_id !== addition.intent.node_id ||
      binding.row.region_id !== addition.intent.request.region_id
    )
      continue;
    const actual = await freshInstance(addition.provider_instance_id);
    if (
      !owned(
        actual,
        addition.provider_instance_id,
        addition.audit.provider_region,
      ) ||
      actual.status !== "rescue" ||
      actual.cancelDate !== null ||
      actual.productId !== addition.audit.product_id ||
      actual.imageId !== addition.audit.image_id ||
      (addition.intent.request.mode === "order" &&
        actual.displayName !== addition.intent.requested_hostname)
    )
      continue;
    const addresses = selectedAddresses(actual, denied, needsIpv6);
    if (!addresses || !hasAllocatedContaboHardware(actual)) continue;
    const installed = await readNodeInstallationProfile(
      env,
      binding.row.region_id,
    );
    if (
      !installed ||
      installed.profile_sha256 !== binding.row.profile_sha256 ||
      installed.profile.rescue_client_private_key !==
        binding.rescue.ssh_private_key ||
      installed.profile.provider_product_id !== actual.productId
    )
      continue;
    const rescue = NodeBootstrapInput.shape.rescue.parse({
      ssh_private_key: binding.rescue.ssh_private_key,
      ssh_host_key: binding.rescue.ssh_host_key,
      ssh_host_fingerprint: binding.rescue.ssh_host_fingerprint,
    });
    const network = NodeInspectionInput.shape.expected_network.safeParse({
      mac: actual.macAddress,
      ipv4: actual.ipConfig.v4.ip,
      prefix_length: actual.ipConfig.v4.netmaskCidr,
      gateway: actual.ipConfig.v4.gateway,
      ...(actual.ipConfig.v6?.ip
        ? {
            ipv6: {
              address: actual.ipConfig.v6.ip,
              prefix_length: actual.ipConfig.v6.netmaskCidr,
              ...(actual.ipConfig.v6.gateway
                ? { gateway: actual.ipConfig.v6.gateway }
                : {}),
            },
          }
        : {}),
    });
    if (!network.success) continue;
    if (
      !(await validateRescueConfiguration(env, actual.id, {
        spec: { rescue_host_fingerprint: rescue.ssh_host_fingerprint },
        rescue,
      }))
    )
      continue;
    const current = await env.DB.prepare(
      `SELECT 1 present FROM node_additions a JOIN node_installation_bindings b ON b.operation_id=a.operation_id
       WHERE a.operation_id=? AND a.revision=? AND a.status IN('audited','bootstrapping') AND a.slot_held=1
         AND a.provider_instance_id=? AND b.binding_sha256=? AND b.profile_sha256=? AND b.inspection_generation=?
         AND NOT EXISTS(SELECT 1 FROM node_bootstrap_jobs j WHERE j.operation_id=a.operation_id AND j.cancelled=0)`,
    )
      .bind(
        addition.intent.operation_id,
        addition.revision,
        actual.id,
        binding.row.binding_sha256,
        binding.row.profile_sha256,
        binding.row.inspection_generation,
      )
      .first();
    if (!current) continue;
    return {
      kind: "rescue",
      operation_id: addition.intent.operation_id,
      node_id: addition.intent.node_id,
      region_id: binding.row.region_id,
      provider_instance_id: actual.id,
      ...addresses,
      access: {
        rescue,
        expected_network: network.data,
        binding_sha256: binding.row.binding_sha256,
        inspection_generation: binding.row.inspection_generation,
        profile_sha256: binding.row.profile_sha256,
      },
    };
  }
  return null;
}
