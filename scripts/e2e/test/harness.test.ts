// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import {
  archiveCounts,
  assertOwned,
  evidence,
  parseArchiveObjects,
  percentile,
  timingSummary,
} from "../src/core.ts";
import { assertOpenSubset, scanPorts } from "../src/scan.ts";
import {
  checkCloudflareInventory,
  checkGitTopology,
  checkLayout,
  checkReady,
} from "../src/phase0-accept.ts";
import { quantityBytes, vgSamples } from "../src/clients.ts";
import { networkingAudit } from "../src/security.ts";

test("TCP scanner finds a real open listener and excludes a closed port", async () => {
  const host = [127, 0, 0, 1].join(".");
  const server = createServer((socket) => socket.end());
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const closed = createServer();
  closed.listen(0, host);
  await once(closed, "listening");
  const closedAddress = closed.address();
  assert(closedAddress && typeof closedAddress !== "string");
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  try {
    const result = await scanPorts(host, [address.port, closedAddress.port], {
      timeoutMs: 1000,
      concurrency: 2,
    });
    assert.deepEqual(result.open, [address.port]);
    assert.equal(result.checked, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("scanner rejects invalid inputs and subset rejects PostgreSQL", async () => {
  assert.doesNotThrow(() => assertOpenSubset([50000, 6443], [50000, 6443]));
  assert.throws(() => assertOpenSubset([5432], [50000, 6443]));
  await assert.rejects(scanPorts("not-an-address", [443]));
  await assert.rejects(scanPorts([127, 0, 0, 1].join("."), [0]));
});

test("positive evidence schema excludes generated credentials, URIs and unknown fields", () => {
  const canary = randomBytes(32).toString("base64url");
  const uri = `postgres://app:${canary}@pgcf-test.invalid/database`;
  const result = JSON.stringify(
    evidence(
      {
        event: "E3",
        pass: true,
        uri,
        key: canary,
        password: canary,
        names: ["pgcf-e2e-test", canary],
        counts: { connections: 1, credential: canary },
        timings: { read_ms: 3, nested: { canary } },
        extra: { canary },
      },
      new Set(["pgcf-e2e-test"]),
    ),
  );
  assert(!result.includes(canary));
  assert(!result.includes(uri));
  assert.deepEqual(JSON.parse(result), {
    event: "E3",
    pass: true,
    names: ["pgcf-e2e-test"],
    counts: { connections: 1 },
    timings: { read_ms: 3 },
  });
});

test("ownership is both prefixed and exact", () => {
  assert.doesNotThrow(() => assertOwned("pgcf-e2e-test", "pgcf-e2e-test"));
  for (const name of [
    "other-project",
    "pgcf-",
    "pgcf-e2e-test/extra",
    "pgcf-e2e-another",
  ])
    assert.throws(() => assertOwned(name, "pgcf-e2e-test"));
});

test("percentiles use nearest rank, validate inputs and preserve the measurements", () => {
  const values = [9, 1, 5, 3];
  assert.equal(percentile(values, 50), 3);
  assert.equal(percentile(values, 95), 9);
  assert.deepEqual(timingSummary(values), {
    count: 4,
    p50_ms: 3,
    p95_ms: 9,
    max_ms: 9,
  });
  assert.deepEqual(values, [9, 1, 5, 3]);
  assert.throws(() => percentile([], 95));
  assert.throws(() => percentile([Number.NaN], 50));
});

test("R2 parser confines objects to the owned prefix and counts actual Barman catalogs/WAL", () => {
  const prefix = "region/database/g1-operation/";
  const wal = "0".repeat(24);
  const objects = parseArchiveObjects(
    [
      { key: `${prefix}database/base/backup/backup.info`, size: 10 },
      { key: `${prefix}database/wals/segment/${wal}.gz`, size: 20 },
      { key: `${prefix}database/wals/segment/${wal}.backup`, size: 5 },
    ],
    prefix,
  );
  assert.deepEqual(archiveCounts(objects), {
    object_count: 3,
    base_backup_count: 1,
    wal_count: 1,
    bytes: 35,
  });
  assert.throws(() =>
    parseArchiveObjects([{ key: "other/backup.info", size: 0 }], prefix),
  );
  assert.throws(() =>
    parseArchiveObjects([{ key: `${prefix}backup.info`, size: -1 }], prefix),
  );
});

test("VG free uses the real pinned LVMNode shape and requires every node", () => {
  const sample = {
    items: [
      {
        metadata: { name: "pgcf-node-a", resourceVersion: "2" },
        volumeGroups: [{ name: "pgcf", free: "1.5Gi" }],
      },
    ],
  };
  assert.equal(quantityBytes("1.5Gi"), 1610612736);
  assert.deepEqual(vgSamples(sample, ["pgcf-node-a"], "pgcf"), [
    { node: "pgcf-node-a", free_bytes: 1610612736, resource_version: "2" },
  ]);
  assert.throws(() => vgSamples(sample, ["pgcf-node-missing"], "pgcf"));
  assert.throws(() => quantityBytes("NaN"));
});

test("Phase 0 checker catches stale layout, branches and scoped Cloudflare resources", () => {
  assert.equal(
    checkLayout(["PLAN.md", "apps/api/src/index.ts", "scripts/e2e/src/run.ts"])
      .pass,
    true,
  );
  assert.equal(checkLayout(["apps/old-controller/index.ts"]).pass, false);
  const worktree =
    "worktree /synthetic\nHEAD generated\nbranch refs/heads/main\n";
  assert.equal(checkGitTopology(worktree, "main\n").pass, true);
  assert.equal(checkGitTopology(worktree, "main\npgcf/old\n").pass, false);
  assert.equal(
    checkCloudflareInventory(
      [
        { kind: "worker", name: "pgcf-api-dev" },
        { kind: "worker", name: "foreign" },
      ],
      [{ kind: "worker", name: "pgcf-api-dev" }],
    ).pass,
    true,
  );
  assert.equal(
    checkCloudflareInventory([{ kind: "worker", name: "pgcf-old-dev" }], [])
      .pass,
    false,
  );
});

test("Phase 0 Ready requires the current release generation", () => {
  const resource = {
    items: [
      {
        metadata: { name: "pgcf-release", generation: 2 },
        status: {
          observedGeneration: 2,
          conditions: [{ type: "Ready", status: "True" }],
        },
      },
    ],
  };
  assert.equal(checkReady(resource, "releases", ["pgcf-release"]).pass, true);
  resource.items[0]!.status.observedGeneration = 1;
  assert.equal(checkReady(resource, "releases", ["pgcf-release"]).pass, false);
});

test("network audit allows known platform host networking and rejects data/regional exposures", () => {
  const pod = (namespace: string, name: string, spec: unknown) => ({
    metadata: { name, namespace },
    spec,
  });
  const platform = {
    items: [pod("kube-system", "cilium-test", { hostNetwork: true })],
  };
  assert.deepEqual(networkingAudit([platform], { items: [] }, "pgcf-system"), {
    workload_count: 0,
    trusted_platform_exceptions: 1,
  });
  assert.throws(() =>
    networkingAudit(
      [{ items: [pod("pgcf-db-test", "database", { hostNetwork: true })] }],
      { items: [] },
      "pgcf-system",
    ),
  );
  assert.throws(() =>
    networkingAudit(
      [
        {
          items: [
            pod("pgcf-system", "gateway", {
              containers: [{ ports: [{ hostPort: 5432 }] }],
            }),
          ],
        },
      ],
      { items: [] },
      "pgcf-system",
    ),
  );
  assert.throws(() =>
    networkingAudit(
      [],
      { items: [pod("pgcf-db-test", "database", { type: "NodePort" })] },
      "pgcf-system",
    ),
  );
});
