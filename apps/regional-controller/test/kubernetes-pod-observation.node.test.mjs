// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { kubernetesFromConfig } from "../src/kubernetes.ts";

// The real SDK deserializes a typed PodList with per-item TypeMeta omitted.
// Exercise the public adapter against an explicit local HTTP API fixture, no secrets.
// Its public kubeconfig explicitly permits loopback HTTP; production TLS is unchanged.
test("projects omitted Pod TypeMeta from the trusted SDK list and refuses explicit foreign or null types and incomplete observation", async () => {
  const pod = {
    metadata: {
      name: "database-1",
      namespace: "test-native",
      uid: "11111111-1111-4111-8111-111111111111",
      resourceVersion: "10",
      labels: { "cnpg.io/cluster": "database" },
    },
    status: { phase: "Running" },
  };
  let responsePage = {
    apiVersion: "v1",
    kind: "PodList",
    metadata: { resourceVersion: "20" },
    items: [pod],
  };
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const url = new URL(request.url, "http://localhost");
    assert.equal(url.pathname, "/api/v1/namespaces/test-native/pods");
    assert.equal(
      url.searchParams.get("labelSelector"),
      "cnpg.io/cluster=database",
    );
    assert.equal(url.searchParams.get("limit"), "100");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responsePage));
  });
  const folder = await mkdtemp(join(tmpdir(), "pgcf-pod-observation-"));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const configFile = join(folder, "public-kubeconfig.json");
    await writeFile(
      configFile,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "local-fixture",
            cluster: {
              server: `http://127.0.0.1:${server.address().port}`,
              "insecure-skip-tls-verify": true,
            },
          },
        ],
        contexts: [
          {
            name: "local-fixture",
            context: { cluster: "local-fixture", user: "local-fixture" },
          },
        ],
        "current-context": "local-fixture",
        users: [{ name: "local-fixture", user: {} }],
      }),
      { mode: 0o600 },
    );
    const api = kubernetesFromConfig(configFile);
    const observed = await api.listPods("test-native", "database");
    assert.equal(
      observed[0].kind,
      "Pod",
      "typed Pod-list endpoint must project a genuinely omitted item kind",
    );
    assert.equal(observed[0].apiVersion, "v1");
    assert.deepEqual({ ...observed[0].metadata }, pod.metadata);
    assert.deepEqual({ ...observed[0].status }, pod.status);
    assert.equal(
      Object.hasOwn(pod, "kind"),
      false,
      "projection must not mutate SDK inputs",
    );
    responsePage = { ...responsePage, items: [{ ...pod, kind: "Service" }] };
    await assert.rejects(
      api.listPods("test-native", "database"),
      /metering_inventory_identity_invalid/,
    );
    responsePage = { ...responsePage, items: [{ ...pod, apiVersion: null }] };
    await assert.rejects(
      api.listPods("test-native", "database"),
      /metering_inventory_identity_invalid/,
    );
    responsePage = {
      ...responsePage,
      metadata: { resourceVersion: "20", continue: "more-pods" },
      items: [pod],
    };
    await assert.rejects(
      api.listPods("test-native", "database"),
      /pod_observation_incomplete/,
    );
    assert.equal(
      requests,
      4,
      "no pagination or hidden follow-up calls are permitted",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
