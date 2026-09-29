// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { RUN_EPOCH_ANNOTATION, validRunEpoch } from "./run-epoch.ts";
import { NodeCohortJournal } from "./node-cohort-journal.ts";
import type { NodeBirth } from "./node-cohort-journal.ts";
import type { Claim, Kubernetes, Resource } from "./types.ts";

export interface NodeCohortPointer {
  uid: string;
  hash: string;
}
export interface CohortNode {
  name: string;
  uid: string;
  bootId: string;
}
export interface NodeCohortData {
  version: 1;
  environmentId: string;
  regionId: string;
  specHash: string;
  runEpoch: string;
  namespaceUid: string;
  nodes: CohortNode[];
}
export interface CohortBinding {
  environmentId: string;
  regionId: string;
  specHash: string;
  runEpoch?: string;
  namespace: string;
  namespaceUid: string;
  nodeCohort?: NodeCohortPointer;
}
export const BIRTH_ANNOTATION = "pgcf.io/execution-birth-id";
export const COHORT_UID_ANNOTATION = "pgcf.io/node-cohort-uid";
export const COHORT_HASH_ANNOTATION = "pgcf.io/node-cohort-hash";
export const COHORT_UID_PATCH_PATH =
  "/metadata/annotations/pgcf.io~1node-cohort-uid";
export const COHORT_HASH_PATCH_PATH =
  "/metadata/annotations/pgcf.io~1node-cohort-hash";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const dnsLabel = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function fields(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const canonicalCohort = (value: unknown): string =>
  JSON.stringify(canonical(value));
function nodeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value.split(".").every((part) => dnsLabel.test(part))
  );
}
export function validNodeTrackingPolicy(
  value: unknown,
): value is { version: 1 } {
  return fields(value, ["version"]) && value.version === 1;
}
export function validNodeCohortPointer(
  value: unknown,
): value is NodeCohortPointer {
  return (
    fields(value, ["uid", "hash"]) &&
    typeof value.uid === "string" &&
    uuid.test(value.uid) &&
    typeof value.hash === "string" &&
    hash.test(value.hash)
  );
}
export function validNodeCohortData(
  value: unknown,
  binding?: CohortBinding,
): value is NodeCohortData {
  if (
    !fields(value, [
      "version",
      "environmentId",
      "regionId",
      "specHash",
      "runEpoch",
      "namespaceUid",
      "nodes",
    ]) ||
    value.version !== 1 ||
    !["environmentId", "regionId", "namespaceUid"].every(
      (key) => typeof value[key] === "string" && uuid.test(value[key]),
    ) ||
    typeof value.specHash !== "string" ||
    !hash.test(value.specHash) ||
    !validRunEpoch(value.runEpoch) ||
    !Array.isArray(value.nodes) ||
    value.nodes.length < 1 ||
    value.nodes.length > 32
  )
    return false;
  let previous = "";
  const uids = new Set<string>();
  for (const item of value.nodes) {
    if (
      !fields(item, ["name", "uid", "bootId"]) ||
      !nodeName(item.name) ||
      item.name <= previous ||
      typeof item.uid !== "string" ||
      !uuid.test(item.uid) ||
      uids.has(item.uid) ||
      typeof item.bootId !== "string" ||
      !uuid.test(item.bootId)
    )
      return false;
    previous = item.name;
    uids.add(item.uid);
  }
  return (
    !binding ||
    (value.environmentId === binding.environmentId &&
      value.regionId === binding.regionId &&
      value.specHash === binding.specHash &&
      value.runEpoch === binding.runEpoch &&
      value.namespaceUid === binding.namespaceUid &&
      (!binding.nodeCohort ||
        digest(canonicalCohort(value)) === binding.nodeCohort.hash))
  );
}
export function nodeCohortAnnotationsMatch(
  resource: Resource,
  pointer?: NodeCohortPointer,
): boolean {
  const annotations = resource.metadata.annotations ?? {};
  const keys = Object.keys(annotations).filter((key) =>
    key.startsWith("pgcf.io/node-cohort-"),
  );
  if (!pointer) return keys.length === 0;
  return (
    validNodeCohortPointer(pointer) &&
    keys.length === 2 &&
    annotations[COHORT_UID_ANNOTATION] === pointer.uid &&
    annotations[COHORT_HASH_ANNOTATION] === pointer.hash
  );
}
export function nodeCohortAffinity(
  data: NodeCohortData,
): Record<string, unknown> {
  return {
    requiredDuringSchedulingIgnoredDuringExecution: {
      nodeSelectorTerms: [
        {
          matchFields: [
            {
              key: "metadata.name",
              operator: "In",
              values: data.nodes.map((node) => node.name),
            },
          ],
        },
      ],
    },
  };
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function nodeCohortPlacementMatches(
  resource: Resource,
  data: NodeCohortData,
): boolean {
  const spec =
    resource.kind === "Pooler"
      ? object(object(resource.spec?.template).spec)
      : object(resource.spec);
  const affinity = object(object(spec.affinity).nodeAffinity);
  return (
    (spec.nodeName === undefined || spec.nodeName === "") &&
    (spec.schedulerName === undefined ||
      spec.schedulerName === "" ||
      spec.schedulerName === "default-scheduler") &&
    canonicalCohort(affinity.requiredDuringSchedulingIgnoredDuringExecution) ===
      canonicalCohort(
        nodeCohortAffinity(data).requiredDuringSchedulingIgnoredDuringExecution,
      )
  );
}
export function nodesMatchCohort(
  data: NodeCohortData,
  resources: Resource[] | undefined,
): boolean {
  if (!Array.isArray(resources) || resources.length > 1000) return false;
  const names = new Set<string>();
  for (const resource of resources) {
    if (
      resource.kind !== "Node" ||
      resource.apiVersion !== "v1" ||
      names.has(resource.metadata.name)
    )
      return false;
    names.add(resource.metadata.name);
  }
  return data.nodes.every((node) => {
    const observed = resources.find(
      (resource) => resource.metadata.name === node.name,
    );
    return (
      observed !== undefined &&
      !observed.metadata.deletionTimestamp &&
      observed.metadata.uid === node.uid &&
      observed.status?.nodeInfo?.bootID === node.bootId
    );
  });
}
export function inspectNodeCohort(
  resource: Resource | null | undefined,
  binding: CohortBinding,
): { pointer: NodeCohortPointer; data: NodeCohortData } | null {
  if (
    !resource ||
    resource.kind !== "ConfigMap" ||
    resource.apiVersion !== "v1" ||
    resource.immutable !== true ||
    resource.metadata.name !== "execution-nodes" ||
    resource.metadata.namespace !== binding.namespace ||
    typeof resource.metadata.uid !== "string" ||
    !uuid.test(resource.metadata.uid) ||
    resource.metadata.deletionTimestamp ||
    resource.metadata.labels?.["app.kubernetes.io/managed-by"] !==
      "cloudflare-postgres" ||
    resource.metadata.labels?.["pgcf.io/environment-id"] !==
      binding.environmentId ||
    resource.metadata.labels?.["pgcf.io/region-id"] !== binding.regionId ||
    resource.metadata.annotations?.["pgcf.io/spec-hash"] !== binding.specHash ||
    resource.metadata.annotations?.[RUN_EPOCH_ANNOTATION] !==
      binding.runEpoch ||
    !validRunEpoch(binding.runEpoch) ||
    !fields(resource.data, ["cohort.json"]) ||
    typeof resource.data["cohort.json"] !== "string" ||
    Buffer.byteLength(resource.data["cohort.json"], "utf8") > 65_536
  )
    return null;
  const owners = resource.metadata.ownerReferences;
  if (
    owners?.length !== 1 ||
    owners[0]?.kind !== "Namespace" ||
    owners[0].apiVersion !== "v1" ||
    owners[0].name !== binding.namespace ||
    owners[0].uid !== binding.namespaceUid ||
    owners[0].controller !== true
  )
    return null;
  const bytes = resource.data["cohort.json"];
  let data: unknown;
  try {
    data = JSON.parse(bytes);
  } catch {
    return null;
  }
  if (!validNodeCohortData(data, binding) || canonicalCohort(data) !== bytes)
    return null;
  const pointer = { uid: resource.metadata.uid, hash: digest(bytes) };
  if (
    binding.nodeCohort &&
    (pointer.uid !== binding.nodeCohort.uid ||
      pointer.hash !== binding.nodeCohort.hash)
  )
    return null;
  return { pointer, data };
}
export function runtimeNodeCohortMatches(
  inventory: {
    namespace: Resource;
    cluster: Resource;
    quota: Resource;
    poolers?: Resource[];
    pods: Resource[];
    nodeCohort?: Resource | null;
    nodes?: Resource[];
  },
  binding: CohortBinding,
): boolean {
  const compute = [inventory.cluster, ...(inventory.poolers ?? [])];
  if (
    !nodeCohortAnnotationsMatch(inventory.namespace) ||
    !nodeCohortAnnotationsMatch(inventory.quota) ||
    !compute.every((resource) =>
      nodeCohortAnnotationsMatch(resource, binding.nodeCohort),
    )
  )
    return false;
  if (!binding.nodeCohort) return !inventory.nodeCohort;
  const inspected = inspectNodeCohort(inventory.nodeCohort, binding);
  if (
    !inspected ||
    !nodesMatchCohort(inspected.data, inventory.nodes) ||
    !compute.every((resource) =>
      nodeCohortPlacementMatches(resource, inspected.data),
    )
  )
    return false;
  const names = new Set(inspected.data.nodes.map((node) => node.name));
  return inventory.pods.every((pod) => {
    const node = pod.spec?.nodeName;
    return node === undefined
      ? pod.status?.phase !== "Running"
      : typeof node === "string" && names.has(node);
  });
}

export async function prepareNodeBirth(
  api: Kubernetes,
  claim: Claim,
  path: string,
  namespace: string,
  authorized: () => void,
): Promise<NodeBirth> {
  if (!api.listNodes || !validRunEpoch(claim.runEpoch))
    throw new Error("node_cohort_configuration_unavailable");
  const journal = new NodeCohortJournal(path, claim.regionId);
  try {
    const previous = journal.get(claim.environmentId);
    if (previous) {
      const reserved = journal.reserve(
        {
          operationId: claim.operationId,
          environmentId: claim.environmentId,
          regionId: claim.regionId,
          specHash: claim.specHash,
          runEpoch: claim.runEpoch,
        },
        previous.nodes,
        claim.leaseEpoch,
        false,
      );
      if (reserved.namespaceUid) {
        authorized();
        const current = await api.read("Namespace", "", namespace);
        authorized();
        if (
          !current ||
          current.metadata.uid !== reserved.namespaceUid ||
          current.metadata.annotations?.[BIRTH_ANNOTATION] !== reserved.birthId
        )
          throw new Error("node_birth_namespace_changed");
      }
      return reserved;
    }
    authorized();
    const existing = await api.read("Namespace", "", namespace);
    authorized();
    if (existing || claim.leaseEpoch !== 1)
      throw new Error("node_cohort_history_unproven");
    const observed = await api.listNodes();
    authorized();
    if (observed.length < 1 || observed.length > 32)
      throw new Error("node_cohort_inventory_unproven");
    const nodes = observed
      .map((n) => ({
        name: n.metadata.name,
        uid: n.metadata.uid ?? "",
        bootId: n.status?.nodeInfo?.bootID ?? "",
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const data = {
      version: 1,
      environmentId: claim.environmentId,
      regionId: claim.regionId,
      specHash: claim.specHash,
      runEpoch: claim.runEpoch,
      namespaceUid: claim.environmentId,
      nodes,
    };
    if (!validNodeCohortData(data) || !nodesMatchCohort(data, observed))
      throw new Error("node_cohort_inventory_unproven");
    authorized();
    return journal.reserve(
      {
        operationId: claim.operationId,
        environmentId: claim.environmentId,
        regionId: claim.regionId,
        specHash: claim.specHash,
        runEpoch: claim.runEpoch,
      },
      nodes,
      claim.leaseEpoch,
      true,
    );
  } finally {
    journal.close();
  }
}
export async function ensureNodeCohort(
  api: Kubernetes,
  binding: CohortBinding,
  authorized: () => void,
  birth: NodeBirth,
  path: string,
): Promise<{ pointer: NodeCohortPointer; data: NodeCohortData }> {
  if (
    !api.listNodes ||
    !api.executionPreflight ||
    !validRunEpoch(binding.runEpoch)
  )
    throw new Error("node_cohort_configuration_unavailable");
  const journal = new NodeCohortJournal(path, binding.regionId);
  try {
    const reserved = journal.bindNamespace(
      binding.environmentId,
      birth.birthId,
      binding.namespaceUid,
    );
    authorized();
    let current = await api.read(
      "ConfigMap",
      binding.namespace,
      "execution-nodes",
    );
    authorized();
    if (!current) {
      if (reserved.nodeCohort) throw new Error("node_cohort_history_unproven");
      const preflight = await api.executionPreflight(binding.namespace);
      authorized();
      if (
        !preflight ||
        !Array.isArray(preflight.pods) ||
        !Array.isArray(preflight.clusters) ||
        !Array.isArray(preflight.poolers) ||
        preflight.pods.length ||
        preflight.clusters.length ||
        preflight.poolers.length
      )
        throw new Error("node_cohort_history_unproven");
      const data: NodeCohortData = {
        version: 1,
        environmentId: binding.environmentId,
        regionId: binding.regionId,
        specHash: binding.specHash,
        runEpoch: binding.runEpoch!,
        namespaceUid: binding.namespaceUid,
        nodes: reserved.nodes,
      };
      const observed = await api.listNodes();
      authorized();
      if (!nodesMatchCohort(data, observed))
        throw new Error("node_cohort_birth_changed");
      const desired: Resource = {
        apiVersion: "v1",
        kind: "ConfigMap",
        immutable: true,
        metadata: {
          name: "execution-nodes",
          namespace: binding.namespace,
          labels: {
            "app.kubernetes.io/managed-by": "cloudflare-postgres",
            "pgcf.io/environment-id": binding.environmentId,
            "pgcf.io/region-id": binding.regionId,
          },
          annotations: {
            "pgcf.io/spec-hash": binding.specHash,
            [RUN_EPOCH_ANNOTATION]: binding.runEpoch,
          },
          ownerReferences: [
            {
              apiVersion: "v1",
              kind: "Namespace",
              name: binding.namespace,
              uid: binding.namespaceUid,
              controller: true,
            },
          ],
        },
        data: { "cohort.json": canonicalCohort(data) },
      };
      authorized();
      try {
        current = await api.create(desired);
      } catch {
        authorized();
        current = await api.read(
          "ConfigMap",
          binding.namespace,
          "execution-nodes",
        );
        if (!current) throw new Error("node_cohort_create_unconfirmed");
      }
      authorized();
    }
    const expected = {
      ...binding,
      ...(reserved.nodeCohort ? { nodeCohort: reserved.nodeCohort } : {}),
    };
    const inspected = inspectNodeCohort(current, expected);
    if (!inspected) throw new Error("node_cohort_identity_unproven");
    if (
      canonicalCohort(inspected.data.nodes) !== canonicalCohort(reserved.nodes)
    )
      throw new Error("node_cohort_original_members_changed");
    const observed = await api.listNodes();
    authorized();
    if (!nodesMatchCohort(inspected.data, observed))
      throw new Error("node_cohort_birth_changed");
    authorized();
    journal.bindCohort(binding.environmentId, inspected.pointer);
    return inspected;
  } finally {
    journal.close();
  }
}
