// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { Cloudflare, Kubernetes } from "../src/clients.ts";
import { checkLayout, checkReady, phase0 } from "../src/phase0-accept.ts";

test("Phase 0 accepts the Docker context and CI image qualification source layout", () => {
  const files = [
    ".dockerignore",
    "scripts/ci/image-qualification.test.ts",
    "scripts/ci/image-qualification.ts",
    "scripts/ci/registry.test.ts",
    "scripts/ci/registry.ts",
    "scripts/ci/image-profiles.test.ts",
    "scripts/ci/image-profiles.ts",
    "scripts/ci/scanner.test.ts",
    "scripts/ci/scanner.ts",
    "scripts/ci/tsconfig.json",
  ];
  const check = checkLayout(files);
  assert.equal(check.pass, true);
  assert.deepEqual(check.names, []);
});

test("Phase 0 rejects secrets under CI and paths outside the target layout", () => {
  const files = [
    "scripts/ci/.env",
    "scripts/ci/.env.production",
    "scripts/ci/.dev.vars",
    "scripts/ci/.dev.vars.production",
    "scripts/ci/review.private.json",
    "scripts/ci/config/kubeconfig",
    "scripts/ci/config/talosconfig",
    "scripts/ci/certificate.pem",
    "scripts/ci/signing.key",
    ".local/scripts/ci/scanner.ts",
    ".dockerignore.backup",
    "scanner.ts",
    "ci/scanner.ts",
    "scripts/scanner.ts",
    "scripts/other/scanner.ts",
    "scripts/circle/scanner.ts",
  ];
  const check = checkLayout(files);
  assert.equal(check.pass, false);
  assert.deepEqual(check.names, files);
});

function configuredPhase0(t: TestContext) {
  const clusterUid = randomUUID(),
    nodeUid = randomUUID(),
    nodeName = "pgcf-node";
  const releaseNames = [
    "pgcf-cilium",
    "pgcf-openebs",
    "pgcf-cert-manager",
    "pgcf-cnpg",
    "pgcf-barman",
  ];
  const env: NodeJS.ProcessEnv = {
    CLOUDFLARE_ACCOUNT_ID: randomBytes(16).toString("hex"),
    CLOUDFLARE_API_TOKEN: randomBytes(32).toString("base64url"),
    PGCF_E2E_EXPECTED_ACCOUNT_NAME: "pgcf-test",
    PGCF_E2E_KUBECONFIG: "/synthetic/pgcf-kubeconfig",
    PGCF_E2E_KUBE_CONTEXT: "pgcf-test",
    PGCF_E2E_PHASE0_ALLOWED_RESOURCES: "[]",
    PGCF_E2E_NODE_NAMES: JSON.stringify([nodeName]),
    PGCF_E2E_HELM_RELEASE_NAMES: JSON.stringify(releaseNames),
    PGCF_E2E_EXPECTED_CLUSTER_UID: clusterUid,
    PGCF_E2E_EXPECTED_NODE_UIDS: JSON.stringify({ [nodeName]: nodeUid }),
  };
  const namespaces = {
    items: [{ metadata: { name: "kube-system", uid: clusterUid } }],
  };
  const nodes = {
    items: [
      {
        metadata: { name: nodeName, uid: nodeUid },
        status: { conditions: [{ type: "Ready", status: "True" }] },
      },
    ],
  };
  const releases = {
    items: releaseNames.map((name) => ({
      metadata: { name, generation: 1 },
      status: {
        observedGeneration: 1,
        conditions: [{ type: "Ready", status: "True" }],
      },
    })),
  };
  const identityReads: string[] = [],
    proofReads: string[] = [];
  t.mock.method(Cloudflare.prototype, "verifyAccount", async () => {
    identityReads.push("account");
  });
  t.mock.method(Cloudflare.prototype, "list", async () => {
    proofReads.push("cloudflare_inventory");
    return [];
  });
  t.mock.method(Cloudflare.prototype, "buckets", async () => {
    proofReads.push("cloudflare_inventory");
    return [];
  });
  t.mock.method(Kubernetes.prototype, "read", async (resource: string) => {
    if (resource === "namespaces") {
      identityReads.push(resource);
      return namespaces;
    }
    if (resource === "nodes") {
      identityReads.push(resource);
      return nodes;
    }
    if (resource === "helmreleases.helm.toolkit.fluxcd.io") {
      proofReads.push(resource);
      return releases;
    }
    throw new Error("unexpected_phase0_resource");
  });
  return {
    env,
    namespaces,
    nodes,
    releases,
    nodeName,
    releaseNames,
    identityReads,
    proofReads,
  };
}

test("Phase 0 rejects a foreign cluster with the same Ready names before collecting proof", async (t) => {
  const fixture = configuredPhase0(t);
  fixture.namespaces.items[0]!.metadata.uid = randomUUID();
  assert.equal(
    checkReady(fixture.nodes, "nodes", [fixture.nodeName]).pass,
    true,
  );
  assert.equal(
    checkReady(fixture.releases, "releases", fixture.releaseNames).pass,
    true,
  );
  await assert.rejects(phase0(fixture.env), {
    code: "dev_cluster_identity_mismatch",
  });
  assert.deepEqual(fixture.proofReads, []);
});

test("Phase 0 rejects a recreated Ready node with the same name before collecting proof", async (t) => {
  const fixture = configuredPhase0(t);
  fixture.nodes.items[0]!.metadata.uid = randomUUID();
  assert.equal(
    checkReady(fixture.nodes, "nodes", [fixture.nodeName]).pass,
    true,
  );
  await assert.rejects(phase0(fixture.env), {
    code: "dev_cluster_identity_mismatch",
  });
  assert.deepEqual(fixture.proofReads, []);
});

test("Phase 0 requires explicit expected cluster and node UIDs before any provider read", async (t) => {
  const fixture = configuredPhase0(t);
  delete fixture.env.PGCF_E2E_EXPECTED_CLUSTER_UID;
  delete fixture.env.PGCF_E2E_EXPECTED_NODE_UIDS;
  await assert.rejects(phase0(fixture.env), {
    code: "missing_environment",
    names: ["PGCF_E2E_EXPECTED_CLUSTER_UID", "PGCF_E2E_EXPECTED_NODE_UIDS"],
  });
  assert.deepEqual(fixture.identityReads, []);
  assert.deepEqual(fixture.proofReads, []);
});

test("Phase 0 rejects expected node UIDs for a different name before any provider read", async (t) => {
  const fixture = configuredPhase0(t);
  fixture.env.PGCF_E2E_EXPECTED_NODE_UIDS = JSON.stringify({
    "pgcf-other-node": randomUUID(),
  });
  await assert.rejects(phase0(fixture.env), {
    code: "expected_node_identity_mismatch",
  });
  assert.deepEqual(fixture.identityReads, []);
  assert.deepEqual(fixture.proofReads, []);
});

test("Phase 0 preserves Ready proof for the explicitly bound cluster and nodes", async (t) => {
  const fixture = configuredPhase0(t);
  const checks = await phase0(fixture.env);
  assert.deepEqual(
    checks.filter((check) => ["nodes", "releases"].includes(check.name)),
    [
      { name: "nodes", pass: true, names: [fixture.nodeName], count: 1 },
      {
        name: "releases",
        pass: true,
        names: fixture.releaseNames,
        count: fixture.releaseNames.length,
      },
    ],
  );
  assert(fixture.identityReads.includes("namespaces"));
  assert(fixture.proofReads.length > 0);
});
