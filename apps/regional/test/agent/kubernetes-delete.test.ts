// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { kubernetesFromConfig } from "../../src/agent/kubernetes.ts";

test("restore Secret deletion sends exact UID and revision preconditions through the core API", async (t) => {
  const uid = randomUUID();
  const resourceVersion = "17";
  t.mock.method(KubeConfig.prototype, "loadFromFile", () => {});
  const calls: unknown[] = [];
  t.mock.method(KubeConfig.prototype, "makeApiClient", (kind: unknown) =>
    kind === CoreV1Api
      ? {
          async deleteNamespacedSecret(args: unknown) {
            calls.push(args);
            return {};
          },
        }
      : {},
  );
  const k8s = kubernetesFromConfig(
    new AbortController().signal,
    "fixture.config",
  );
  await k8s.delete(
    "Secret",
    "pgcf-test",
    "restore-superuser",
    uid,
    resourceVersion,
  );
  assert.deepEqual(calls, [
    {
      name: "restore-superuser",
      namespace: "pgcf-test",
      body: {
        preconditions: { uid, resourceVersion },
        propagationPolicy: "Foreground",
      },
    },
  ]);
});

test("primary Pod deletion sends exact UID and revision preconditions in the background", async (t) => {
  const uid = randomUUID();
  t.mock.method(KubeConfig.prototype, "loadFromFile", () => {});
  const calls: unknown[] = [];
  t.mock.method(KubeConfig.prototype, "makeApiClient", (kind: unknown) =>
    kind === CoreV1Api
      ? {
          async deleteNamespacedPod(args: unknown) {
            calls.push(args);
            return {};
          },
        }
      : {},
  );
  const k8s = kubernetesFromConfig(
    new AbortController().signal,
    "fixture.config",
  );
  await k8s.delete("Pod", "pgcf-db-test", "database-1", uid, "23");
  assert.deepEqual(calls, [
    {
      name: "database-1",
      namespace: "pgcf-db-test",
      body: {
        preconditions: { uid, resourceVersion: "23" },
        propagationPolicy: "Background",
      },
    },
  ]);
});
