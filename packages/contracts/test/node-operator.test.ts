// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { newNodeId } from "../src/ids.ts";
import {
  NODE_OPERATOR_KUBERNETES_HEADERS,
  NodeOperatorKubernetesBinding,
  NodeOperatorKubernetesQuery,
  nodeOperatorKubernetesHeaders,
  nodeOperatorKubernetesPath,
  parseNodeOperatorKubernetesBinding,
} from "../src/node-operator.ts";

function fixture() {
  return {
    node_uid: crypto.randomUUID(),
    cluster_uid: crypto.randomUUID(),
    node_name: "pgcf-node-fixture",
    material_revision: 3,
  };
}

it("uses the exact operator path and round-trips the four expected identity headers", () => {
  const nodeId = newNodeId(),
    binding = fixture();
  expect(nodeOperatorKubernetesPath(nodeId)).toBe(
    `/v1/nodes/${nodeId}/operator/kubernetes`,
  );
  const headers = nodeOperatorKubernetesHeaders(binding);
  expect(Object.keys(headers)).toEqual(
    Object.values(NODE_OPERATOR_KUBERNETES_HEADERS),
  );
  expect(parseNodeOperatorKubernetesBinding(new Headers(headers))).toEqual(
    binding,
  );
});

it("rejects injected targets, unknown fields and invalid Kubernetes identities", () => {
  const binding = fixture();
  expect(() => nodeOperatorKubernetesPath(`${newNodeId()}/other`)).toThrow();
  expect(
    NodeOperatorKubernetesQuery.safeParse({
      node_uid: binding.node_uid,
      address: "127.0.0.1",
    }).success,
  ).toBe(false);
  expect(
    NodeOperatorKubernetesBinding.safeParse({
      ...binding,
      node_name: "node\r\nInjected: value",
    }).success,
  ).toBe(false);
  expect(
    NodeOperatorKubernetesBinding.safeParse({
      ...binding,
      material_revision: Number.MAX_SAFE_INTEGER + 1,
    }).success,
  ).toBe(false);
});

it("rejects incomplete, duplicate and noncanonical response headers", () => {
  const binding = fixture(),
    headers = new Headers(nodeOperatorKubernetesHeaders(binding));
  headers.delete(NODE_OPERATOR_KUBERNETES_HEADERS.cluster_uid);
  expect(() => parseNodeOperatorKubernetesBinding(headers)).toThrow();
  headers.set(
    NODE_OPERATOR_KUBERNETES_HEADERS.cluster_uid,
    binding.cluster_uid,
  );
  headers.append(NODE_OPERATOR_KUBERNETES_HEADERS.node_uid, binding.node_uid);
  expect(() => parseNodeOperatorKubernetesBinding(headers)).toThrow();
  headers.set(NODE_OPERATOR_KUBERNETES_HEADERS.node_uid, binding.node_uid);
  headers.set(NODE_OPERATOR_KUBERNETES_HEADERS.material_revision, "03");
  expect(() => parseNodeOperatorKubernetesBinding(headers)).toThrow();
});
