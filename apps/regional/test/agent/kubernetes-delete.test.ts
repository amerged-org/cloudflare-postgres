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
