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
