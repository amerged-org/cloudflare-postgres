// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseAllDocuments } from "yaml";
import { validateInput } from "../src/bootstrap.ts";
import {
  assertOwnedResource,
  assertWorkloadReady,
  platformSyncObjects,
  regionalObjects,
  renderFluxObjects,
} from "../src/platform.ts";
import { platformFixture } from "./fixture.ts";
const object = (value: unknown) => value as Record<string, unknown>;
const objects = (value: unknown) => value as Array<Record<string, unknown>>;

test("private platform custody is bound to the immutable public spec before native commands", () => {
  const input = platformFixture();
  assert.deepEqual(validateInput(input), input);
  assert.throws(
    () =>
      validateInput({
        ...input,
        platform: {
          ...input.platform,
          tunnel_token: randomBytes(64).toString("base64url"),
        },
      }),
    /platform_configuration_mismatch/,
  );
  assert.throws(
    () => validateInput({ ...input, platform: undefined }),
    /platform_configuration_mismatch/,
  );
  assert.throws(
    () =>
      validateInput({
        ...input,
        platform: {
          ...input.platform,
          region_id: "region-other",
          agent_key: `pgcf_ak_region-other_${randomBytes(32).toString("base64url")}`,
        },
      }),
    /platform_configuration_mismatch/,
  );
});

test("first-region manifests pin both source revision and regional digest, with credentials confined to Secrets", () => {
  const input = platformFixture();
  const sync = platformSyncObjects(input);
  const regional = regionalObjects(input);
  assert.equal(
    object(object(sync[0]!.spec).ref).commit,
    input.spec.platform.reviewed_commit,
  );
  assert.equal(objects(object(sync[1]!.spec).healthChecks).length, 5);
  const kustomization = regional.find((item) => item.kind === "Kustomization")!;
  const image = objects(object(kustomization.spec).images)[0]!;
  assert.equal(
    image.newName + "@" + image.digest,
    input.spec.platform.regional_image,
  );
  const secrets = regional.filter((item) => item.kind === "Secret");
  assert.equal(secrets.length, 4);
  const publicObjects = JSON.stringify(
    regional.filter((item) => item.kind !== "Secret"),
  );
  for (const value of [
    input.platform.agent_key,
    input.platform.route_keyring,
    input.platform.tunnel_token,
    input.platform.backup_s3.access_key_id,
    input.platform.backup_s3.secret_access_key,
  ])
    assert.ok(!publicObjects.includes(value));
  assert.equal(
    object(
      secrets.find((item) => object(item.metadata).name === "pgcf-agent")!.data,
    ).PGCF_AGENT_KEY,
    Buffer.from(input.platform.agent_key).toString("base64"),
  );
});

test("Flux manifest adds only the scoped quarantine toleration and retains upstream controller settings", () => {
  const input = platformFixture();
  const original = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "source-controller", namespace: "flux-system" },
    spec: {
      replicas: 1,
      template: {
        spec: {
          containers: [
            {
              name: "manager",
              image: `flux@sha256:${randomBytes(32).toString("hex")}`,
            },
          ],
          tolerations: [{ key: "upstream", operator: "Exists" }],
        },
      },
    },
  };
  const rendered = renderFluxObjects(JSON.stringify(original), input);
  const podSpec = object(object(object(rendered[0]!.spec).template).spec);
  assert.deepEqual(podSpec.tolerations, [
    original.spec.template.spec.tolerations[0],
    {
      key: "pgcf.io/quarantine",
      operator: "Equal",
      value: "bootstrap",
      effect: "NoSchedule",
    },
  ]);
  assert.deepEqual(podSpec.containers, original.spec.template.spec.containers);
  assert.equal(
    parseAllDocuments(
      rendered.map((item) => JSON.stringify(item)).join("\n---\n"),
    ).length,
    1,
  );
});

test("readback verifies the owned spec as well as its annotation, and rejects replacement or changed private data", () => {
  const input = platformFixture();
  const expected = regionalObjects(input).find(
    (item) => item.kind === "Secret",
  )!;
  const actual = {
    ...structuredClone(expected),
    metadata: {
      ...object(expected.metadata),
      uid: randomUUID(),
      resourceVersion: "1",
    },
  };
  assertOwnedResource(expected, actual);
  assert.throws(
    () => assertOwnedResource(expected, { ...actual, data: {} }),
    /platform_resource_mismatch/,
  );
  assert.throws(
    () =>
      assertOwnedResource(expected, {
        ...actual,
        metadata: { ...actual.metadata, annotations: {} },
      }),
    /platform_resource_mismatch/,
  );
});

test("Flux quota readback accepts Kubernetes canonical pod counts and keeps every owned field exact", () => {
  const input = platformFixture();
  const [expected] = renderFluxObjects(
    JSON.stringify({
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "critical-pods", namespace: "flux-system" },
      spec: {
        hard: { pods: "1000" },
        scopeSelector: {
          matchExpressions: [
            {
              operator: "In",
              scopeName: "PriorityClass",
              values: ["system-node-critical", "system-cluster-critical"],
            },
          ],
        },
      },
    }),
    input,
  );
  const actual = structuredClone(expected!);
  object(actual.metadata).uid = randomUUID();
  object(object(actual.spec).hard).pods = "1k";
  assertOwnedResource(expected!, actual);
  const changedLimit = structuredClone(actual);
  object(object(changedLimit.spec).hard).pods = "1001";
  assert.throws(
    () => assertOwnedResource(expected!, changedLimit),
    /platform_resource_mismatch/,
  );
  const fractionalLimit = structuredClone(actual);
  object(object(fractionalLimit.spec).hard).pods = "1000001m";
  assert.throws(
    () => assertOwnedResource(expected!, fractionalLimit),
    /platform_resource_mismatch/,
  );
  const unowned = structuredClone(actual);
  object(unowned.metadata).annotations = {};
  assert.throws(
    () => assertOwnedResource(expected!, unowned),
    /platform_resource_mismatch/,
  );
  const changedScope = structuredClone(actual);
  object(changedScope.spec).scopeSelector = {};
  assert.throws(
    () => assertOwnedResource(expected!, changedScope),
    /platform_resource_mismatch/,
  );
  const configMap = { ...expected!, kind: "ConfigMap" };
  assert.throws(
    () => assertOwnedResource(configMap, { ...actual, kind: "ConfigMap" }),
    /platform_resource_mismatch/,
  );
});

test("owned workload quantities accept exact numeric equivalents and retain every nonquantity field", () => {
  const input = platformFixture();
  const [expected] = renderFluxObjects(
    JSON.stringify({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "source-controller", namespace: "flux-system" },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "manager",
                resources: {
                  limits: { cpu: "1000m", memory: "1Gi" },
                  requests: { cpu: "500m", memory: "64Mi" },
                },
              },
            ],
            initContainers: [
              {
                name: "setup",
                resources: { requests: { cpu: "100m", memory: "16Mi" } },
              },
            ],
          },
        },
      },
    }),
    input,
  );
  const actual = structuredClone(expected!);
  object(actual.metadata).uid = randomUUID();
  const limits = object(
    object(
      objects(object(object(object(actual.spec).template).spec).containers)[0]!
        .resources,
    ).limits,
  );
  limits.cpu = "1";
  assertOwnedResource(expected!, actual);
  limits.cpu = "1001m";
  assert.throws(
    () => assertOwnedResource(expected!, actual),
    /platform_resource_mismatch/,
  );
  limits.cpu = "1";
  limits.memory = "1073741824";
  const requests = object(
    object(
      objects(object(object(object(actual.spec).template).spec).containers)[0]!
        .resources,
    ).requests,
  );
  requests.cpu = "0.5";
  requests.memory = "67108864";
  const setupRequests = object(
    object(
      objects(
        object(object(object(actual.spec).template).spec).initContainers,
      )[0]!.resources,
    ).requests,
  );
  setupRequests.cpu = "0.1";
  setupRequests.memory = "16777216";
  assertOwnedResource(expected!, actual);
  requests.cpu = "0.5001";
  assert.throws(
    () => assertOwnedResource(expected!, actual),
    /platform_resource_mismatch/,
  );
  requests.cpu = "0.5";
  limits.memory = "1073741825";
  assert.throws(
    () => assertOwnedResource(expected!, actual),
    /platform_resource_mismatch/,
  );
  limits.memory = "1Gi";
  object(actual.metadata).annotations = {};
  assert.throws(
    () => assertOwnedResource(expected!, actual),
    /platform_resource_mismatch/,
  );
});

test("storage quota quantities are semantic while object counts remain integral", () => {
  const [expected] = renderFluxObjects(
    JSON.stringify({
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "bounded", namespace: "flux-system" },
      spec: {
        hard: {
          "requests.cpu": "100m",
          "limits.cpu": "200m",
          "requests.memory": "64Mi",
          "requests.storage": "1Gi",
          "count/persistentvolumeclaims": "1",
        },
      },
    }),
    platformFixture(),
  );
  const actual = structuredClone(expected!);
  object(actual.metadata).uid = randomUUID();
  Object.assign(object(object(actual.spec).hard), {
    "requests.cpu": "0.1",
    "limits.cpu": "0.2",
    "requests.memory": "67108864",
    "requests.storage": "1073741824",
    "count/persistentvolumeclaims": "1000m",
  });
  assertOwnedResource(expected!, actual);
  object(object(actual.spec).hard)["requests.storage"] = "1073741825";
  assert.throws(
    () => assertOwnedResource(expected!, actual),
    /platform_resource_mismatch/,
  );
});

test("deny-all NetworkPolicy readback accepts omitted empty rules without accepting changed selectors or policy types", () => {
  const [expected] = renderFluxObjects(
    JSON.stringify({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "deny-all", namespace: "flux-system" },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        ingress: [],
        egress: [],
      },
    }),
    platformFixture(),
  );
  const actual = structuredClone(expected!);
  object(actual.metadata).uid = randomUUID();
  delete object(actual.spec).ingress;
  delete object(actual.spec).egress;
  assertOwnedResource(expected!, actual);
  object(actual.spec).egress = [{}];
  assert.throws(
    () => assertOwnedResource(expected!, actual),
    /platform_resource_mismatch/,
  );
  delete object(actual.spec).egress;
  object(actual.spec).policyTypes = ["Ingress"];
  assert.throws(
    () => assertOwnedResource(expected!, actual),
    /platform_resource_mismatch/,
  );
  object(actual.spec).policyTypes = ["Ingress", "Egress"];
  object(actual.spec).podSelector = { matchLabels: { unrelated: "true" } };
  assert.throws(
    () => assertOwnedResource(expected!, actual),
    /platform_resource_mismatch/,
  );
  object(actual.spec).podSelector = {};
  object(actual.metadata).annotations = {};
  assert.throws(
    () => assertOwnedResource(expected!, actual),
    /platform_resource_mismatch/,
  );
});

test("owned Pod readback permits only Kubernetes default eviction tolerations beside the exact quarantine toleration", () => {
  const [expected] = renderFluxObjects(
    JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "write", namespace: "flux-system" },
      spec: {
        tolerations: [
          {
            key: "pgcf.io/quarantine",
            operator: "Equal",
            value: "bootstrap",
            effect: "NoSchedule",
          },
        ],
        containers: [{ name: "writer", image: "locked" }],
      },
    }),
    platformFixture(),
  );
  const actual = structuredClone(expected!);
  object(actual.metadata).uid = randomUUID();
  objects(object(actual.spec).tolerations).push(
    {
      key: "node.kubernetes.io/not-ready",
      operator: "Exists",
      effect: "NoExecute",
      tolerationSeconds: 300,
    },
    {
      key: "node.kubernetes.io/unreachable",
      operator: "Exists",
      effect: "NoExecute",
      tolerationSeconds: 300,
    },
  );
  assertOwnedResource(expected!, actual);
  objects(object(actual.spec).tolerations)[1]!.tolerationSeconds = 301;
  assert.throws(
    () => assertOwnedResource(expected!, actual),
    /platform_resource_mismatch/,
  );
  objects(object(actual.spec).tolerations)[1]!.tolerationSeconds = 300;
  objects(object(actual.spec).tolerations).push({
    key: "unowned",
    operator: "Exists",
  });
  assert.throws(
    () => assertOwnedResource(expected!, actual),
    /platform_resource_mismatch/,
  );
});

test("readiness requires current controller observation and exact desired replicas", () => {
  const deployment = {
    metadata: { generation: 3 },
    spec: { replicas: 2 },
    status: {
      observedGeneration: 3,
      replicas: 2,
      updatedReplicas: 2,
      readyReplicas: 2,
      availableReplicas: 2,
    },
  };
  assertWorkloadReady("Deployment", deployment);
  assert.throws(
    () =>
      assertWorkloadReady("Deployment", {
        ...deployment,
        status: { ...deployment.status, observedGeneration: 2 },
      }),
    /platform_workload_not_ready/,
  );
  assert.throws(
    () =>
      assertWorkloadReady("Deployment", {
        ...deployment,
        status: { ...deployment.status, replicas: 3 },
      }),
    /platform_workload_not_ready/,
  );
  assert.throws(
    () =>
      assertWorkloadReady("Deployment", {
        ...deployment,
        status: { ...deployment.status, readyReplicas: 1 },
      }),
    /platform_workload_not_ready/,
  );
  assert.throws(
    () =>
      assertWorkloadReady("DaemonSet", {
        metadata: { generation: 1 },
        status: {
          observedGeneration: 1,
          desiredNumberScheduled: 0,
          currentNumberScheduled: 0,
          numberReady: 0,
          updatedNumberScheduled: 0,
          numberAvailable: 0,
        },
      }),
    /platform_workload_not_ready/,
  );
});
