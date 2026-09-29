// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { MaintenanceSnapshot } from "./maintenance-types.ts";
export interface FleetBinding {
  instanceId: string;
  nodeName: string;
  nodeUid: string;
  regionId: string;
}
export interface FleetConfiguration {
  schemaVersion: 1;
  regionId: string;
  bindings: FleetBinding[];
}
export interface FleetInstance {
  instanceId: string;
  region: string;
  dataCenter: string;
  status: string;
  cpuCores: number;
  ramMb: string;
  diskMb: string;
  ipv4: string | null;
  ipv6: string | null;
}
export interface FleetProviderObservation {
  provider: "contabo";
  instances: FleetInstance[];
  observation: {
    startedAt: string;
    observedAt: string;
    consistency: "observed-scan";
    enumerationComplete: true;
    evidenceHash: string;
  };
  actionsEnabled: false;
  machineIdentityVerified: false;
}
export interface FleetNode {
  name: string;
  uid: string;
  ready: boolean;
  bootId: string | null;
  addresses: string[];
}
export type FleetBlocker =
  | "provider_missing"
  | "provider_changed"
  | "node_missing"
  | "node_changed"
  | "node_not_ready"
  | "node_unbound";
export interface FleetInspection {
  schemaVersion: 1;
  status: "observed" | "blocked";
  regionId: string;
  observedAt: string;
  providerObservation: FleetProviderObservation["observation"];
  boundNodes: {
    binding: FleetBinding;
    instance: FleetInstance;
    node: FleetNode | null;
  }[];
  unmanagedInstances: FleetInstance[];
  unmanagedNodes: FleetNode[];
  blockers: FleetBlocker[];
  evidenceHash: string;
  machineIdentityVerified: false;
  capacityReserved: false;
  actionsEnabled: false;
}
export interface FleetTransport {
  provider(): Promise<unknown>;
  nodes(): Promise<unknown[]>;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const id = /^[1-9][0-9]{0,18}$/;
const fail = () => new Error("fleet_inspection_failed");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const unsigned = (value: unknown): value is string =>
  typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/.test(value);
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function fleetConfiguration(value: unknown): FleetConfiguration {
  if (
    !object(value) ||
    Object.keys(value).length !== 3 ||
    value.schemaVersion !== 1 ||
    typeof value.regionId !== "string" ||
    !uuid.test(value.regionId) ||
    !Array.isArray(value.bindings) ||
    value.bindings.length < 1 ||
    value.bindings.length > 100
  )
    throw fail();
  const bindings = value.bindings.map((v) => {
    if (
      !object(v) ||
      Object.keys(v).length !== 4 ||
      typeof v.instanceId !== "string" ||
      !id.test(v.instanceId) ||
      typeof v.nodeName !== "string" ||
      !/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(v.nodeName) ||
      typeof v.nodeUid !== "string" ||
      !uuid.test(v.nodeUid) ||
      v.regionId !== value.regionId
    )
      throw fail();
    return {
      instanceId: v.instanceId,
      nodeName: v.nodeName,
      nodeUid: v.nodeUid,
      regionId: v.regionId as string,
    };
  });
  for (const key of ["instanceId", "nodeUid", "nodeName"] as const)
    if (new Set(bindings.map((v) => v[key])).size !== bindings.length)
      throw fail();
  return {
    schemaVersion: 1,
    regionId: value.regionId,
    bindings: bindings.sort((a, b) => a.instanceId.localeCompare(b.instanceId)),
  };
}
export function providerObservation(value: unknown): FleetProviderObservation {
  if (
    !object(value) ||
    value.provider !== "contabo" ||
    value.actionsEnabled !== false ||
    value.machineIdentityVerified !== false ||
    !Array.isArray(value.instances) ||
    value.instances.length > 1000 ||
    !object(value.observation)
  )
    throw fail();
  const o = value.observation;
  if (
    !instant(o.startedAt) ||
    !instant(o.observedAt) ||
    Date.parse(o.startedAt) > Date.parse(o.observedAt) ||
    Date.parse(o.observedAt) - Date.parse(o.startedAt) > 20000 ||
    o.consistency !== "observed-scan" ||
    o.enumerationComplete !== true ||
    typeof o.evidenceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(o.evidenceHash)
  )
    throw fail();
  const instances = value.instances.map((i) => {
    if (
      !object(i) ||
      typeof i.instanceId !== "string" ||
      !id.test(i.instanceId) ||
      !["region", "dataCenter", "status"].every(
        (k) =>
          typeof i[k] === "string" &&
          String(i[k]).length > 0 &&
          String(i[k]).length <=
            (k === "dataCenter" ? 256 : k === "status" ? 64 : 128),
      ) ||
      !Number.isSafeInteger(i.cpuCores) ||
      Number(i.cpuCores) < 0 ||
      !unsigned(i.ramMb) ||
      !unsigned(i.diskMb) ||
      (i.ipv4 !== null && (typeof i.ipv4 !== "string" || isIP(i.ipv4) !== 4)) ||
      (i.ipv6 !== null && (typeof i.ipv6 !== "string" || isIP(i.ipv6) !== 6))
    )
      throw fail();
    return {
      instanceId: i.instanceId,
      region: i.region as string,
      dataCenter: i.dataCenter as string,
      status: i.status as string,
      cpuCores: i.cpuCores as number,
      ramMb: i.ramMb,
      diskMb: i.diskMb,
      ipv4: i.ipv4 as string | null,
      ipv6: i.ipv6 as string | null,
    };
  });
  if (new Set(instances.map((i) => i.instanceId)).size !== instances.length)
    throw fail();
  return {
    provider: "contabo",
    instances,
    observation: {
      startedAt: o.startedAt,
      observedAt: o.observedAt,
      consistency: "observed-scan",
      enumerationComplete: true,
      evidenceHash: o.evidenceHash,
    },
    actionsEnabled: false,
    machineIdentityVerified: false,
  };
}
function observedNodes(value: unknown[]): FleetNode[] {
  if (!Array.isArray(value) || value.length > 1000) throw fail();
  const nodes = value.map((v) => {
    if (
      !object(v) ||
      v.apiVersion !== "v1" ||
      v.kind !== "Node" ||
      !object(v.metadata) ||
      typeof v.metadata.name !== "string" ||
      typeof v.metadata.uid !== "string" ||
      !uuid.test(v.metadata.uid) ||
      !object(v.status)
    )
      throw fail();
    const addresses = Array.isArray(v.status.addresses)
      ? v.status.addresses
      : [];
    const ips = addresses
      .filter(
        (a) =>
          object(a) && ["InternalIP", "ExternalIP"].includes(String(a.type)),
      )
      .map((a) => {
        if (
          !object(a) ||
          typeof a.address !== "string" ||
          isIP(a.address) === 0
        )
          throw fail();
        return a.address;
      });
    const info = object(v.status.nodeInfo) ? v.status.nodeInfo : {};
    return {
      name: v.metadata.name,
      uid: v.metadata.uid,
      ready:
        !v.metadata.deletionTimestamp &&
        Array.isArray(v.status.conditions) &&
        v.status.conditions.some(
          (c) => object(c) && c.type === "Ready" && c.status === "True",
        ),
      bootId:
        typeof info.bootID === "string" && uuid.test(info.bootID)
          ? info.bootID
          : null,
      addresses: [...new Set(ips)].sort(),
    };
  });
  if (
    new Set(nodes.map((n) => n.uid)).size !== nodes.length ||
    new Set(nodes.map((n) => n.name)).size !== nodes.length
  )
    throw fail();
  return nodes;
}
export async function inspectFleet(
  value: unknown,
  transport: FleetTransport,
  at?: number,
): Promise<FleetInspection> {
  const configuration = fleetConfiguration(value),
    [rawProvider, rawNodes] = await Promise.all([
      transport.provider(),
      transport.nodes(),
    ]),
    provider = providerObservation(rawProvider),
    nodes = observedNodes(rawNodes),
    now = at ?? Date.now();
  if (
    !Number.isSafeInteger(now) ||
    now < Date.parse(provider.observation.observedAt) - 5000 ||
    now - Date.parse(provider.observation.observedAt) > 60000
  )
    throw fail();
  const blockers = new Set<FleetBlocker>(),
    boundNodes: FleetInspection["boundNodes"] = [],
    selected = new Set<string>();
  for (const binding of configuration.bindings) {
    const instance = provider.instances.find(
        (i) => i.instanceId === binding.instanceId,
      ),
      node = nodes.find((n) => n.name === binding.nodeName);
    if (!instance) {
      blockers.add("provider_missing");
      continue;
    }
    selected.add(instance.instanceId);
    if (!node) blockers.add("node_missing");
    else if (node.uid !== binding.nodeUid) blockers.add("node_changed");
    else {
      if (!node.ready) blockers.add("node_not_ready");
      if (
        instance.status !== "running" ||
        ![instance.ipv4, instance.ipv6].some(
          (ip) => ip !== null && node.addresses.includes(ip),
        )
      )
        blockers.add("provider_changed");
    }
    boundNodes.push({ binding, instance, node: node ?? null });
  }
  const unmanagedInstances = provider.instances.filter(
      (i) => !selected.has(i.instanceId),
    ),
    unmanagedNodes = nodes.filter(
      (n) =>
        !configuration.bindings.some(
          (b) => b.nodeName === n.name && b.nodeUid === n.uid,
        ),
    );
  if (unmanagedNodes.length) blockers.add("node_unbound");
  const body = {
    schemaVersion: 1 as const,
    status: blockers.size ? ("blocked" as const) : ("observed" as const),
    regionId: configuration.regionId,
    observedAt: new Date(now).toISOString(),
    providerObservation: provider.observation,
    boundNodes,
    unmanagedInstances,
    unmanagedNodes,
    blockers: [...blockers].sort(),
    machineIdentityVerified: false as const,
    capacityReserved: false as const,
    actionsEnabled: false as const,
  };
  return { ...body, evidenceHash: digest(body) };
}
export function applyFleetInspection(
  snapshot: MaintenanceSnapshot,
  report: FleetInspection,
): MaintenanceSnapshot {
  const expected = snapshot.nodes.map((n) => n.uid).sort(),
    observed = report.boundNodes
      .filter((n) => n.node !== null && n.node.uid === n.binding.nodeUid)
      .map((n) => n.binding.nodeUid)
      .sort();
  const failed =
    report.status !== "observed" ||
    report.blockers.length !== 0 ||
    snapshot.regionId !== report.regionId ||
    JSON.stringify(expected) !== JSON.stringify(observed) ||
    Math.abs(Date.parse(report.observedAt) - snapshot.observedAt) > 60000;
  return failed
    ? { ...snapshot, complete: false, machineIdentity: null }
    : snapshot;
}
