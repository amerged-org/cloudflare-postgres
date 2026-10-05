// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node";
import { kubernetesFromConfig } from "../../src/agent/kubernetes.ts";

test("PVC reads use the core API and retain resource identity", async (t) => {
  const namespace = "pgcf-test";
  const name = "database-1";
  const uid = randomUUID();
  let reads = 0;
  t.mock.method(KubeConfig.prototype, "loadFromFile", () => {});
  t.mock.method(KubeConfig.prototype, "makeApiClient", (type: unknown) => {
    if (type === CoreV1Api)
      return {
        async readNamespacedPersistentVolumeClaim(input: {
          namespace: string;
          name: string;
        }) {
          assert.deepEqual(input, { namespace, name });
          reads++;
          return {
            metadata: { namespace, name, uid, resourceVersion: "1" },
            status: { phase: "Bound" },
          };
        },
      };
    return {};
  });
  const k8s = kubernetesFromConfig(new AbortController().signal, "test-config");
  const claim = await k8s.read("PersistentVolumeClaim", namespace, name);
  assert.equal(reads, 1);
  assert.equal(claim?.kind, "PersistentVolumeClaim");
  assert.equal(claim?.apiVersion, "v1");
  assert.equal(claim?.metadata.uid, uid);
});

test("ConfigMap deletion routes exact UID and resourceVersion preconditions through the core client", async (t) => {
  const namespace = "pgcf-system",
    name = "fixture",
    uid = randomUUID(),
    resourceVersion = "12";
  let deleted = 0;
  t.mock.method(KubeConfig.prototype, "loadFromFile", () => {});
  t.mock.method(KubeConfig.prototype, "makeApiClient", (type: unknown) =>
    type === CoreV1Api
      ? {
          async deleteNamespacedConfigMap(input: unknown) {
            assert.deepEqual(input, {
              name,
              namespace,
              body: {
                preconditions: { uid, resourceVersion },
                propagationPolicy: "Foreground",
              },
            });
            deleted++;
          },
        }
      : {},
  );
  const k8s = kubernetesFromConfig(new AbortController().signal, "test-config");
  await k8s.delete("ConfigMap", namespace, name, uid, resourceVersion);
  assert.equal(deleted, 1);
});

test("Backup reads and lists use the pinned CNPG API and bounded namespaced pagination", async (t) => {
  const namespace = "pgcf-test",
    name = "base-backup",
    uid = randomUUID();
  let pages = 0;
  t.mock.method(KubeConfig.prototype, "loadFromFile", () => {});
  t.mock.method(KubeConfig.prototype, "makeApiClient", (type: unknown) =>
    type === CustomObjectsApi
      ? {
          async getNamespacedCustomObject(input: unknown) {
            assert.deepEqual(input, {
              group: "postgresql.cnpg.io",
              version: "v1",
              plural: "backups",
              namespace,
              name,
            });
            return { metadata: { name, namespace, uid, resourceVersion: "2" } };
          },
          async listNamespacedCustomObject(input: { _continue?: string }) {
            pages++;
            assert.deepEqual(input, {
              group: "postgresql.cnpg.io",
              version: "v1",
              plural: "backups",
              namespace,
              limit: 100,
              labelSelector: "cnpg.io/cluster=database",
              _continue: pages === 1 ? undefined : "next",
            });
            return {
              metadata: {
                resourceVersion: "2",
                ...(pages === 1 ? { continue: "next" } : {}),
              },
              items:
                pages === 1
                  ? [
                      {
                        metadata: {
                          name,
                          namespace,
                          uid,
                          resourceVersion: "2",
                        },
                      },
                    ]
                  : [],
            };
          },
        }
      : {},
  );
  const k8s = kubernetesFromConfig(new AbortController().signal, "test-config");
  assert.equal((await k8s.read("Backup", namespace, name))?.metadata.uid, uid);
  const backups = await k8s.list(
    "Backup",
    namespace,
    "cnpg.io/cluster=database",
  );
  assert.equal(backups[0]?.kind, "Backup");
  assert.equal(backups[0]?.apiVersion, "postgresql.cnpg.io/v1");
  assert.equal(pages, 2);
});
