import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const lockPath = fileURLToPath(
  new URL("../../../infra/platform/versions.lock.json", import.meta.url),
);
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const namespace = "flux-system";
const syncName = "pgcf-platform";
const contextName = "fixture-inspection";
const commit = "a".repeat(40);
const paths = {
  nodes: "/api/v1/nodes",
  releases: `/apis/helm.toolkit.fluxcd.io/v2/namespaces/${namespace}/helmreleases`,
  oci: `/apis/source.toolkit.fluxcd.io/v1/namespaces/${namespace}/ocirepositories`,
  repositories: `/apis/source.toolkit.fluxcd.io/v1/namespaces/${namespace}/helmrepositories`,
  source: `/apis/source.toolkit.fluxcd.io/v1/namespaces/${namespace}/gitrepositories/${syncName}`,
  reconciliation: `/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/${namespace}/kustomizations/${syncName}`,
};
const allowedPaths = new Set(Object.values(paths));
const unverified = [
  "sql",
  "backup_restore",
  "replication",
  "etcd",
  "spare_capacity",
  "image_signatures",
  "tenant_isolation",
];
const bait = [
  "fixture-api-credential-bait",
  "192.0.2.41",
  "fixture-private-error-message",
];

function metadata(name, generation = 2) {
  return {
    name,
    namespace,
    uid: `fixture-uid-${name}`,
    resourceVersion: "fixture-rv",
    generation,
  };
}
function ready(generation = 2) {
  return {
    observedGeneration: generation,
    conditions: [
      {
        type: "Ready",
        status: "True",
        observedGeneration: generation,
        reason: "Succeeded",
      },
    ],
  };
}
function list(kind, apiVersion, items) {
  return {
    kind: `${kind}List`,
    apiVersion,
    metadata: { resourceVersion: "fixture-list-rv" },
    items,
  };
}
function snapshot(suspendBarman = false) {
  const releases = lock.charts.map((chart) => {
    const revision =
      chart.chartVersion.replace(/^v/, "") +
      (chart.ociManifestDigest
        ? `+${chart.ociManifestDigest.slice(7, 19)}`
        : "");
    const suspended = suspendBarman && chart.name === "plugin-barman-cloud";
    return {
      apiVersion: "helm.toolkit.fluxcd.io/v2",
      kind: "HelmRelease",
      metadata: metadata(chart.name),
      spec: chart.ociManifestDigest
        ? {
            suspend: suspended,
            chartRef: {
              kind: "OCIRepository",
              name: `${chart.name}-chart`,
              namespace,
            },
          }
        : {
            suspend: false,
            chart: {
              spec: {
                chart: chart.name,
                version: chart.chartVersion,
                sourceRef: {
                  kind: "HelmRepository",
                  name: `${chart.name}-charts`,
                  namespace,
                },
              },
            },
          },
      status: suspended
        ? {}
        : {
            ...ready(),
            lastAttemptedRevision: revision,
            lastAttemptedRevisionDigest: chart.ociManifestDigest,
            history: [
              {
                status: "deployed",
                name: chart.name,
                version: 1,
                chartName: chart.name,
                chartVersion: revision,
                appVersion: chart.appVersion,
              },
            ],
          },
    };
  });
  const oci = lock.charts
    .filter((chart) => chart.ociManifestDigest)
    .map((chart) => ({
      apiVersion: "source.toolkit.fluxcd.io/v1",
      kind: "OCIRepository",
      metadata: metadata(`${chart.name}-chart`),
      spec: { url: chart.source, ref: { digest: chart.ociManifestDigest } },
      status: {
        ...ready(),
        artifact: {
          revision: chart.ociManifestDigest,
          digest: `sha256:${chart.archiveSha256}`,
        },
      },
    }));
  const repositories = lock.charts
    .filter((chart) => !chart.ociManifestDigest)
    .map((chart) => ({
      apiVersion: "source.toolkit.fluxcd.io/v1",
      kind: "HelmRepository",
      metadata: metadata(`${chart.name}-charts`),
      spec: { url: chart.source },
      status: ready(),
    }));
  return new Map([
    [
      paths.nodes,
      list("Node", "v1", [
        {
          apiVersion: "v1",
          kind: "Node",
          metadata: {
            ...metadata("fixture-node-private"),
            namespace: undefined,
          },
          status: {
            nodeInfo: {
              osImage: `Talos (v${lock.target.talosVersion})`,
              kubeletVersion: `v${lock.target.kubernetesVersion}`,
            },
            addresses: [{ type: "InternalIP", address: bait[1] }],
            conditions: [
              { type: "Ready", status: "True" },
              ...["MemoryPressure", "DiskPressure", "PIDPressure"].map(
                (type) => ({ type, status: "False" }),
              ),
            ],
          },
        },
      ]),
    ],
    [
      paths.releases,
      list("HelmRelease", "helm.toolkit.fluxcd.io/v2", releases),
    ],
    [paths.oci, list("OCIRepository", "source.toolkit.fluxcd.io/v1", oci)],
    [
      paths.repositories,
      list("HelmRepository", "source.toolkit.fluxcd.io/v1", repositories),
    ],
    [
      paths.source,
      {
        apiVersion: "source.toolkit.fluxcd.io/v1",
        kind: "GitRepository",
        metadata: metadata(syncName),
        spec: {
          url: "https://example.invalid/platform-source",
          ref: { commit },
        },
        status: { ...ready(), artifact: { revision: `sha1:${commit}` } },
      },
    ],
    [
      paths.reconciliation,
      {
        apiVersion: "kustomize.toolkit.fluxcd.io/v1",
        kind: "Kustomization",
        metadata: metadata(syncName),
        spec: {
          sourceRef: { kind: "GitRepository", name: syncName, namespace },
        },
        status: {
          ...ready(),
          lastAppliedRevision: `sha1:${commit}`,
          lastAttemptedRevision: `sha1:${commit}`,
        },
      },
    ],
  ]);
}

async function fixture(resources, denied = false) {
  const requests = [];
  const directory = mkdtempSync(join(tmpdir(), "pgcf-platform-inspection-"));
  const kubeconfig = join(directory, "kubeconfig.json");
  const journal = join(directory, "must-not-create", "journal.sqlite");
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://fixture.invalid").pathname;
    requests.push({ method: request.method, path: pathname });
    const found = resources.get(pathname);
    const refused = denied || request.method !== "GET" || !found;
    response.writeHead(refused ? 403 : 200, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(
        refused
          ? {
              apiVersion: "v1",
              kind: "Status",
              status: "Failure",
              reason: "Forbidden",
              code: 403,
              message: bait.join(" "),
            }
          : found,
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  writeFileSync(
    kubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "inspection-cluster",
          cluster: { server: origin, "insecure-skip-tls-verify": true },
        },
        { name: "unused-cluster", cluster: { server: "http://127.0.0.1:1" } },
      ],
      users: [{ name: "inspection-user", user: { token: bait[0] } }],
      contexts: [
        {
          name: contextName,
          context: {
            cluster: "inspection-cluster",
            user: "inspection-user",
            namespace,
          },
        },
        {
          name: "unused-context",
          context: { cluster: "unused-cluster", user: "inspection-user" },
        },
      ],
      "current-context": "unused-context",
    }),
    { mode: 0o600 },
  );
  return {
    requests,
    journal,
    async run(extraEnvironment = {}) {
      const child = spawn(
        process.execPath,
        [
          entry,
          "inspect-platform",
          "--kubeconfig",
          kubeconfig,
          "--context",
          contextName,
          "--versions-lock",
          lockPath,
          "--expected-source-commit",
          commit,
        ],
        {
          env: { NODE_NO_WARNINGS: "1", NO_COLOR: "1", ...extraEnvironment },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const [code, signal] = await once(child, "close");
        assert.equal(
          signal,
          null,
          "inspection command must finish within the bounded local run",
        );
        assert.doesNotMatch(
          stderr,
          /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module/,
          "red proof must exercise the compiled entry, not a missing import",
        );
        return { code, stdout, stderr };
      } finally {
        clearTimeout(timeout);
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function report(result) {
  assert.notEqual(
    result.stdout.trim(),
    "",
    "inspect-platform must emit its observation report without controller or meter configuration",
  );
  const value = JSON.parse(result.stdout);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.mode, "platform-inspection");
  assert.equal(value.scope, "platform_components");
  return value;
}
function readOnly(requests, requireAll = true) {
  assert.ok(
    requests.length > 0,
    "inspection must read the local Kubernetes API",
  );
  assert.ok(
    requests.every(
      ({ method, path }) => method === "GET" && allowedPaths.has(path),
    ),
    "only approved platform GET reads are permitted",
  );
  if (requireAll)
    assert.deepEqual(
      new Set(requests.map((request) => request.path)),
      allowedPaths,
    );
}
function capabilities(value) {
  assert.ok(Array.isArray(value.unverified));
  const known = value.unverified.map((item) => item.toLowerCase());
  assert.ok(
    unverified.every((item) => known.includes(item)),
    "platform health must leave database/recovery/capacity/isolation guarantees unverified",
  );
}

test(
  "inspects the observed four-ready lab and reports suspended Barman without controller configuration",
  { timeout: 15_000 },
  async () => {
    const api = await fixture(snapshot(true));
    try {
      const result = await api.run();
      const observed = report(result);
      assert.equal(result.code, 1);
      assert.equal(observed.ready, false);
      assert.deepEqual(observed.checks.nodes, {
        status: "ready",
        total: 1,
        ready: 1,
        versionMatch: true,
        pressureFree: true,
      });
      assert.equal(observed.checks.releases.length, 5);
      assert.equal(
        observed.checks.releases.filter((release) => release.status === "ready")
          .length,
        4,
      );
      assert.equal(
        observed.checks.releases.find(
          (release) => release.name === "plugin-barman-cloud",
        ).status,
        "suspended",
      );
      assert.deepEqual(observed.checks.source, {
        status: "ready",
        commitMatches: true,
      });
      assert.deepEqual(observed.checks.reconciliation, {
        status: "ready",
        commitMatches: true,
      });
      capabilities(observed);
      readOnly(api.requests);
      assert.ok(
        !result.stdout.includes("fixture-node-private") &&
          !result.stdout.includes(bait[1]),
      );
    } finally {
      await api.close();
    }
  },
);

test(
  "reports all five locked releases ready and refuses a stale observed generation",
  { timeout: 30_000 },
  async () => {
    const resources = snapshot();
    const api = await fixture(resources);
    try {
      const result = await api.run();
      assert.equal(
        result.code,
        0,
        "a matching current platform snapshot must exit ready",
      );
      const observed = report(result);
      assert.equal(observed.ready, true);
      assert.deepEqual(
        observed.checks.releases.map((release) => release.name).sort(),
        lock.charts.map((chart) => chart.name).sort(),
      );
      assert.ok(
        observed.checks.releases.every(
          (release) =>
            release.status === "ready" &&
            release.chartMatches &&
            release.appMatches &&
            release.sourcePinMatches,
        ),
      );
      capabilities(observed);
      readOnly(api.requests);
      const cilium = resources
        .get(paths.releases)
        .items.find((release) => release.metadata.name === "cilium");
      cilium.status.observedGeneration = 1;
      const cnpg = resources
        .get(paths.releases)
        .items.find((release) => release.metadata.name === "cloudnative-pg");
      cnpg.status.history[0].chartVersion = lock.charts.find(
        (chart) => chart.name === "cloudnative-pg",
      ).chartVersion;
      cnpg.status.lastAttemptedRevisionDigest = `sha256:${"b".repeat(64)}`;
      const stale = await api.run();
      assert.equal(stale.code, 1);
      const notReady = report(stale);
      assert.equal(notReady.ready, false);
      assert.equal(
        notReady.checks.releases.find((release) => release.name === "cilium")
          .status,
        "not_ready",
      );
      assert.equal(
        notReady.checks.releases.find(
          (release) => release.name === "cloudnative-pg",
        ).sourcePinMatches,
        false,
      );
    } finally {
      await api.close();
    }
  },
);

test(
  "sanitizes a denied observation and performs no secret, write or journal work",
  { timeout: 15_000 },
  async () => {
    const api = await fixture(snapshot(), true);
    try {
      const result = await api.run({ PGCF_USAGE_JOURNAL_PATH: api.journal });
      assert.equal(
        result.code,
        2,
        "a denied platform read must use the generic observation-failure exit",
      );
      const observed = report(result);
      assert.equal(observed.ready, false);
      const output = result.stdout + result.stderr;
      assert.ok(
        bait.every((value) => !output.includes(value)),
        "raw API credentials, IPs and messages must never enter the report",
      );
      assert.ok(!output.includes("127.0.0.1"));
      readOnly(api.requests, false);
      assert.equal(existsSync(api.journal), false);
      assert.equal(existsSync(join(api.journal, "..")), false);
    } finally {
      await api.close();
    }
  },
);
