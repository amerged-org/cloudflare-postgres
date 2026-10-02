// SPDX-License-Identifier: Apache-2.0
import { HarnessError, record, string } from "./core.ts";

export interface ClusterIdentity {
  cluster_uid: string;
  namespace_uid: string;
  agent_uid: string;
  nodes: Record<string, string>;
  agent_api_url: string;
  region_id: string;
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HarnessError("agent_api_configuration_invalid");
  return url.href.replace(/\/$/, "");
}

export function assertClusterNodeIdentity(
  actual: Pick<ClusterIdentity, "cluster_uid" | "nodes">,
  expected: Pick<ClusterIdentity, "cluster_uid" | "nodes">,
): void {
  const names = Object.keys(actual.nodes).sort(),
    wanted = Object.keys(expected.nodes).sort();
  if (
    !expected.cluster_uid ||
    !wanted.length ||
    actual.cluster_uid !== expected.cluster_uid ||
    JSON.stringify(names) !== JSON.stringify(wanted) ||
    names.some(
      (name) =>
        !expected.nodes[name] || actual.nodes[name] !== expected.nodes[name],
    )
  )
    throw new HarnessError("dev_cluster_identity_mismatch");
}

export function assertClusterIdentity(
  actual: ClusterIdentity,
  expected: ClusterIdentity,
  allowedUrls: readonly string[],
): void {
  assertClusterNodeIdentity(actual, expected);
  if (
    actual.namespace_uid !== expected.namespace_uid ||
    actual.agent_uid !== expected.agent_uid ||
    actual.region_id !== expected.region_id ||
    !allowedUrls.map(canonicalUrl).includes(canonicalUrl(actual.agent_api_url))
  )
    throw new HarnessError("dev_cluster_identity_mismatch");
}

export function assertPolicyIdentity(
  value: unknown,
  name: string,
  namespace: string,
  runName: string,
  expectedUid: string | undefined,
): void {
  const metadata = record(record(value).metadata);
  if (
    !expectedUid ||
    metadata.name !== name ||
    metadata.namespace !== namespace ||
    metadata.uid !== expectedUid ||
    record(metadata.labels)["pgcf.io/e2e-run"] !== runName
  )
    throw new HarnessError("policy_identity_conflict");
}

export interface InverseProof {
  uid: string;
  expected_uid: string;
  original_url: string;
  actual_url: string;
  generation: number;
  observed_generation: number;
  replicas: number;
  available_replicas: number;
  api_seen_at: string | null;
  started_at: string;
  pod_original_url: boolean;
}

export function inverseReady(proof: InverseProof): boolean {
  return (
    proof.uid === proof.expected_uid &&
    canonicalUrl(proof.actual_url) === canonicalUrl(proof.original_url) &&
    proof.generation > 0 &&
    proof.observed_generation === proof.generation &&
    proof.replicas > 0 &&
    proof.available_replicas === proof.replicas &&
    proof.pod_original_url &&
    proof.api_seen_at !== null &&
    Date.parse(proof.api_seen_at) > Date.parse(proof.started_at)
  );
}

export function parseUidMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, uid] of Object.entries(record(value))) {
    if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(name))
      throw new HarnessError("invalid_node_identity");
    result[name] = string(uid);
  }
  if (!Object.keys(result).length)
    throw new HarnessError("invalid_node_identity");
  return result;
}

export function sameStructuredValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
