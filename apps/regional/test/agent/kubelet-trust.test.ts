// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { test } from "node:test";
import {
  KubeletTrustReader,
  validateKubeletTrust,
} from "../../src/agent/kubelet-trust.ts";
import type { Resource } from "../../src/agent/types.ts";
import { certificate } from "../gateway/helpers.ts";

const credentials = certificate("kubernetes");
function fixture() {
  const node: Resource = {
    apiVersion: "v1",
    kind: "Node",
    metadata: { name: "kubernetes", uid: randomUUID(), resourceVersion: "1" },
  };
  const clusterUid = randomUUID();
  const resource: Resource = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `kubelet-${node.metadata.uid}`,
      namespace: "pgcf-system",
      uid: randomUUID(),
      resourceVersion: "1",
      labels: { "pgcf.io/kubelet-node-uid": node.metadata.uid! },
    },
    data: {
      node_name: node.metadata.name,
      node_uid: node.metadata.uid,
      cluster_uid: clusterUid,
      certificate_pem: credentials.cert,
      certificate_sha256: createHash("sha256")
        .update(credentials.cert, "utf8")
        .digest("hex"),
    },
  };
  return { node, clusterUid, resource, now: Date.now() };
}

test("authenticated certificate bytes bind the exact node and cluster with a DER leaf pin", () => {
  const state = fixture();
  const trust = validateKubeletTrust(
    state.resource,
    state.node,
    state.clusterUid,
    state.now,
  );
  assert.equal(trust.certificatePem, credentials.cert);
  assert.equal(
    trust.leafSha256,
    createHash("sha256")
      .update(new X509Certificate(credentials.cert).raw)
      .digest("hex"),
  );
});

test("a foreign node UID or kube-system UID cannot lend its kubelet trust", () => {
  const state = fixture();
  const data = state.resource.data as Record<string, string>;
  data.node_uid = randomUUID();
  assert.throws(
    () =>
      validateKubeletTrust(
        state.resource,
        state.node,
        state.clusterUid,
        state.now,
      ),
    /kubelet_trust_invalid/,
  );
  data.node_uid = state.node.metadata.uid!;
  data.cluster_uid = randomUUID();
  assert.throws(
    () =>
      validateKubeletTrust(
        state.resource,
        state.node,
        state.clusterUid,
        state.now,
      ),
    /kubelet_trust_invalid/,
  );
});

test("changed PEM bytes and private-key material cannot be accepted as serving trust", () => {
  const state = fixture();
  const data = state.resource.data as Record<string, string>;
  data.certificate_pem += "\n";
  assert.throws(
    () =>
      validateKubeletTrust(
        state.resource,
        state.node,
        state.clusterUid,
        state.now,
      ),
    /kubelet_trust_invalid/,
  );
  data.certificate_pem = credentials.key;
  data.certificate_sha256 = createHash("sha256")
    .update(credentials.key, "utf8")
    .digest("hex");
  assert.throws(
    () =>
      validateKubeletTrust(
        state.resource,
        state.node,
        state.clusterUid,
        state.now,
      ),
    /kubelet_trust_invalid/,
  );
});

test("expired certificates and an over-bound certificate bundle retain no usable trust", () => {
  const state = fixture();
  const expires = Date.parse(new X509Certificate(credentials.cert).validTo);
  assert.throws(
    () =>
      validateKubeletTrust(
        state.resource,
        state.node,
        state.clusterUid,
        expires + 1,
      ),
    /kubelet_trust_invalid/,
  );
  const data = state.resource.data as Record<string, string>;
  data.certificate_pem = credentials.cert + " ".repeat(16 * 1024);
  data.certificate_sha256 = createHash("sha256")
    .update(data.certificate_pem, "utf8")
    .digest("hex");
  assert.throws(
    () =>
      validateKubeletTrust(
        state.resource,
        state.node,
        state.clusterUid,
        state.now,
      ),
    /kubelet_trust_invalid/,
  );
});

test("a certificate without the exact current Kubernetes node hostname cannot define a TLS alias", () => {
  const state = fixture();
  state.node.metadata.name = "changed";
  (state.resource.data as Record<string, string>).node_name =
    state.node.metadata.name;
  assert.throws(
    () =>
      validateKubeletTrust(
        state.resource,
        state.node,
        state.clusterUid,
        state.now,
      ),
    /kubelet_trust_invalid/,
  );
});

test("missing artifacts retain the CA path while invalid artifacts fail closed and cache refresh is bounded", async () => {
  const state = fixture();
  let now = state.now,
    reads = 0,
    present = false;
  const reader = new KubeletTrustReader(
    async (kind, namespace, name) => {
      if (kind === "Namespace") {
        assert.equal(name, "kube-system");
        return {
          apiVersion: "v1",
          kind,
          metadata: { name, uid: state.clusterUid, resourceVersion: "1" },
        };
      }
      assert.deepEqual(
        [kind, namespace, name],
        ["ConfigMap", "pgcf-system", state.resource.metadata.name],
      );
      reads++;
      return present ? structuredClone(state.resource) : null;
    },
    () => now,
  );
  assert.equal(await reader.read(state.node), null);
  present = true;
  assert.equal(await reader.read(state.node), null);
  assert.equal(reads, 1);
  now += 30_000;
  assert.equal(
    (await reader.read(state.node))?.certificatePem,
    credentials.cert,
  );
  assert.equal(reads, 2);
  (state.resource.data as Record<string, string>).node_name = "changed";
  now += 30_000;
  await assert.rejects(reader.read(state.node), /kubelet_trust_invalid/);
});

test("a cached pin cannot cross a changed actual kube-system namespace identity", async () => {
  const state = fixture();
  let clusterUid = state.clusterUid;
  const reader = new KubeletTrustReader(
    async (kind) =>
      kind === "Namespace"
        ? {
            apiVersion: "v1",
            kind,
            metadata: {
              name: "kube-system",
              uid: clusterUid,
              resourceVersion: "1",
            },
          }
        : state.resource,
    () => state.now,
  );
  assert.ok(await reader.read(state.node));
  clusterUid = randomUUID();
  await assert.rejects(reader.read(state.node), /kubelet_trust_invalid/);
});
