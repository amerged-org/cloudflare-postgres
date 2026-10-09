// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId } from "./ids.ts";

export const NODE_OPERATOR_KUBERNETES_HEADERS = {
  node_uid: "X-PGCF-Node-UID",
  cluster_uid: "X-PGCF-Cluster-UID",
  node_name: "X-PGCF-Node-Name",
  material_revision: "X-PGCF-Material-Revision",
} as const;

export const NodeOperatorKubernetesQuery = z.strictObject({
  node_uid: z.uuid(),
});
export type NodeOperatorKubernetesQuery = z.infer<
  typeof NodeOperatorKubernetesQuery
>;

/** Cloudflare's expected identity; the operator must also verify the actual Kubernetes identity. */
export const NodeOperatorKubernetesBinding = z.strictObject({
  node_uid: z.uuid(),
  cluster_uid: z.uuid(),
  node_name: z
    .string()
    .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
    .max(253),
  material_revision: z.number().int().safe().positive(),
});
export type NodeOperatorKubernetesBinding = z.infer<
  typeof NodeOperatorKubernetesBinding
>;

export function nodeOperatorKubernetesPath(nodeId: string): string {
  return `/v1/nodes/${NodeId.parse(nodeId)}/operator/kubernetes`;
}

export function nodeOperatorKubernetesHeaders(
  value: NodeOperatorKubernetesBinding,
): Record<string, string> {
  const binding = NodeOperatorKubernetesBinding.parse(value);
  return {
    [NODE_OPERATOR_KUBERNETES_HEADERS.node_uid]: binding.node_uid,
    [NODE_OPERATOR_KUBERNETES_HEADERS.cluster_uid]: binding.cluster_uid,
    [NODE_OPERATOR_KUBERNETES_HEADERS.node_name]: binding.node_name,
    [NODE_OPERATOR_KUBERNETES_HEADERS.material_revision]: String(
      binding.material_revision,
    ),
  };
}

export function parseNodeOperatorKubernetesBinding(
  headers: Pick<Headers, "get">,
): NodeOperatorKubernetesBinding {
  const revision = headers.get(
    NODE_OPERATOR_KUBERNETES_HEADERS.material_revision,
  );
  return NodeOperatorKubernetesBinding.parse({
    node_uid: headers.get(NODE_OPERATOR_KUBERNETES_HEADERS.node_uid),
    cluster_uid: headers.get(NODE_OPERATOR_KUBERNETES_HEADERS.cluster_uid),
    node_name: headers.get(NODE_OPERATOR_KUBERNETES_HEADERS.node_name),
    material_revision:
      revision !== null && /^[1-9][0-9]{0,15}$/.test(revision)
        ? Number(revision)
        : Number.NaN,
  });
}
