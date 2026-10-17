// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ADMISSION_REFUSALS,
  ADMISSION_REFUSAL_DETAILS,
  ArchiveCredential,
  NODE_AWAKE_LIMIT,
  NODE_DESIRED_PAGE_LIMIT_MAX,
  NODE_LINK_MESSAGE_MAX_BYTES,
  NODE_REQUEST_MAX_LIFETIME_SECONDS,
  NodeDesiredPage,
  NodeDesiredQuery,
  NodeEnrollmentRequest,
  NodeEnrollmentSeed,
  NodeEventReport,
  NodeObservationReport,
  NodeSample,
  NodeVolumeReport,
  AgentLinkMessage,
  ServerLinkMessage,
  type NodeKey,
  nodePublicKey,
  nodeRequestClaims,
  signNodeRequest,
  verifyNodeRequest,
} from "../src/node-link.ts";

async function keyPair() {
  return (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as { publicKey: NodeKey; privateKey: NodeKey };
}
const node = {
    id: `nod_${"n".repeat(20)}`,
    uid: "01234567-89ab-4def-8123-0123456789ab",
    hostname: "eu1",
    region_id: "eu-dev",
  },
  id = `d${"b".repeat(19)}`,
  operation = `op_${"c".repeat(20)}`,
  now = "2026-10-17T12:00:00.000Z";
const credential = {
  id: `crd_${"k".repeat(20)}`,
  expires_at: "2026-10-24T12:00:00.000Z",
};
const owner = {
  name: "app",
  owner: true,
  password: "p".repeat(43),
  revision: 1,
};
const database = {
  id,
  generation: 4,
  operation,
  desired_state: "running",
  route_revision: 2,
  storage_generation: 1,
  pg_major: 18,
  resources: { memory_mib: 256, cpu_millicores: 250, storage_gib: 1 },
  settings: { max_connections: 25, archive_timeout_seconds: 60 },
  sleep_after_seconds: 300,
  roles: [owner],
  archive: { path: `s3://pgcf-eu/eu-dev/${id}/g1-${operation}`, credential },
};
const binary = (name: string) => ({
  url: `https://releases.example/${name}`,
  sha256: "a".repeat(64),
  size_bytes: 1000,
});
const page = {
  node,
  release: {
    id: "release-25",
    binaries: Object.fromEntries(
      [
        "pgcf-agent",
        "pgcf-native-gateway",
        "pgcf-archive",
        "pgcf-wal-fetch",
      ].map((name) => [name, binary(name)]),
    ),
    os: {
      image_version: "25",
      debian_snapshot: "20261016T000000Z",
      package_lock: {
        url: "https://releases.example/packages.lock.json",
        sha256: "b".repeat(64),
        size_bytes: 2000,
      },
    },
  },
  policy: {
    admission: {
      memory_rule: "measured",
      memory_floor_mib: 600,
      awake_budget_mib: 9913,
      reservation_overhead_mib: 8,
      start_concurrency: 4,
      queue_wait_ms: 10_000,
      retry_after_seconds: 5,
    },
    early_sleep: { enabled: true, min_idle_seconds: 30 },
    storage: {
      reserve_bytes: 6 * 1024 ** 3,
      metadata_no_room_percent: 75,
      sample_max_age_seconds: 10,
    },
    backup: { wal_uploads: 2, base_backups: 1 },
  },
  orders: [],
  databases: [database],
  next: null,
};

describe("enrollment", () => {
  it("reads the installer's seed exactly as it writes it", () => {
    const seed = {
      node_id: node.id,
      region: "eu-dev",
      api_url: "https://api.example",
      enrollment_token: `pgcf_et_${"e".repeat(43)}`,
    };
    expect(NodeEnrollmentSeed.parse(seed)).toEqual(seed);
    expect(
      NodeEnrollmentSeed.safeParse({ ...seed, hostname: "eu1" }).success,
    ).toBe(false);
  });

  it("enrolls a 32-byte Ed25519 public key", async () => {
    const pair = await keyPair();
    const request = {
      node_id: node.id,
      enrollment_token: `pgcf_et_${"e".repeat(43)}`,
      public_key: await nodePublicKey(pair.publicKey),
      image_version: "25",
    };
    expect(NodeEnrollmentRequest.safeParse(request).success).toBe(true);
    expect(
      NodeEnrollmentRequest.safeParse({
        ...request,
        public_key: request.public_key.slice(0, 42),
      }).success,
    ).toBe(false);
  });
});

describe("signed node requests", () => {
  it("bind node, install, method, path, body and time", async () => {
    const pair = await keyPair();
    const publicKey = await nodePublicKey(pair.publicKey);
    const body = new TextEncoder().encode('{"observed_at":"x"}');
    const claims = await nodeRequestClaims({
      node: node.id,
      uid: node.uid,
      method: "POST",
      path: "/node/v1/observations",
      body,
      now: 1_000_000,
    });
    expect(claims.body).toBe(createHash("sha256").update(body).digest("hex"));
    const token = await signNodeRequest(pair.privateKey, claims);
    const expected = {
      publicKey,
      node: node.id,
      uid: node.uid,
      method: "POST",
      path: "/node/v1/observations",
      body,
      now: 1_000_000,
    };
    expect(await verifyNodeRequest(token, expected)).toEqual({
      ok: true,
      claims,
    });
    for (const [change, reason] of [
      [{ path: "/node/v1/events" }, "request_mismatch"],
      [{ method: "GET" }, "request_mismatch"],
      [{ body: new Uint8Array() }, "request_mismatch"],
      [{ uid: "11234567-89ab-4def-8123-0123456789ab" }, "node_mismatch"],
      [{ node: `nod_${"m".repeat(20)}` }, "node_mismatch"],
      [
        { now: 1_000_000 + (NODE_REQUEST_MAX_LIFETIME_SECONDS + 31) * 1000 },
        "expired",
      ],
      [{ now: 1_000_000 - 31_000 }, "not_yet_valid"],
    ] as const)
      expect(
        await verifyNodeRequest(token, { ...expected, ...change }),
      ).toEqual({ ok: false, reason });
    const other = await keyPair();
    expect(
      await verifyNodeRequest(token, {
        ...expected,
        publicKey: await nodePublicKey(other.publicKey),
      }),
    ).toEqual({ ok: false, reason: "signature" });
    expect(await verifyNodeRequest("pgcf_nr1.a.b", expected)).toEqual({
      ok: false,
      reason: "malformed",
    });
    await expect(
      signNodeRequest(pair.privateKey, {
        ...claims,
        exp: claims.iat + NODE_REQUEST_MAX_LIFETIME_SECONDS + 1,
      }),
    ).rejects.toThrow();
  });
});

describe("the per-node desired page", () => {
  it("accepts a page of this node's databases", () => {
    expect(NodeDesiredPage.safeParse(page).success).toBe(true);
    expect(
      NodeDesiredPage.safeParse({
        ...page,
        databases: [{ ...database, desired_state: "suspended" }],
      }).success,
    ).toBe(true);
  });

  it("refuses an archive that is not this database's own generation", () => {
    for (const archive of [
      `s3://pgcf-eu/eu-dev/${"x".repeat(20)}/g1-${operation}`,
      `s3://pgcf-eu/eu-dev/${id}/g2-${operation}`,
      `s3://pgcf-eu/us-dev/${id}/g1-${operation}`,
    ])
      expect(
        NodeDesiredPage.safeParse({
          ...page,
          databases: [{ ...database, archive: { path: archive, credential } }],
        }).success,
      ).toBe(false);
  });

  it("builds a storage generation only from a named origin", () => {
    const source = {
      database_id: `s${"b".repeat(19)}`,
      path: `s3://pgcf-eu/eu-dev/s${"b".repeat(19)}/g3-op_${"d".repeat(20)}`,
      backup_id: "20261017T110000",
      target_time: "2026-10-17T11:30:00.000Z",
      credential,
    };
    const moved = {
      ...database,
      storage_generation: 2,
      archive: {
        path: `s3://pgcf-eu/eu-dev/${id}/g2-${operation}`,
        credential,
      },
    };
    for (const [entry, valid] of [
      [{ ...database, origin: { kind: "create" } }, true],
      [{ ...database, origin: { kind: "restore", source } }, true],
      [
        {
          ...database,
          origin: { kind: "restore", source: { ...source, database_id: id } },
        },
        false,
      ],
      [
        {
          ...moved,
          origin: {
            kind: "move",
            source: {
              database_id: id,
              path: `s3://pgcf-eu/eu-dev/${id}/g1-op_${"d".repeat(20)}`,
              backup_id: "20261017T110000",
              credential,
            },
          },
        },
        true,
      ],
      [{ ...moved, origin: { kind: "move", source } }, false],
      [
        {
          ...moved,
          origin: {
            kind: "move",
            source: {
              database_id: id,
              path: `s3://pgcf-eu/eu-dev/${id}/g1-op_${"d".repeat(20)}`,
              backup_id: "20261017T110000",
              target_time: "2026-10-17T11:30:00.000Z",
              credential,
            },
          },
        },
        false,
      ],
    ] as const)
      expect(
        NodeDesiredPage.safeParse({ ...page, databases: [entry] }).success,
      ).toBe(valid);
  });

  it("requires exactly one owner role while the database exists", () => {
    for (const roles of [
      [],
      [owner, { ...owner, name: "other" }],
      [owner, owner],
      [owner, { name: "app", state: "absent" }],
    ])
      expect(
        NodeDesiredPage.safeParse({
          ...page,
          databases: [{ ...database, roles }],
        }).success,
      ).toBe(false);
    expect(
      NodeDesiredPage.safeParse({
        ...page,
        databases: [{ ...database, desired_state: "deleted", roles: [] }],
      }).success,
    ).toBe(true);
  });

  it("orders never retire a storage generation the page still serves", () => {
    const superseded = {
      type: "superseded",
      operation: `op_${"s".repeat(20)}`,
      database: id,
      storage_generation: 1,
      remove_volume: true,
    };
    expect(
      NodeDesiredPage.safeParse({ ...page, orders: [superseded] }).success,
    ).toBe(false);
    expect(
      NodeDesiredPage.safeParse({
        ...page,
        databases: [],
        orders: [
          superseded,
          { type: "fence", operation: `op_${"f".repeat(20)}` },
          { type: "maintenance", operation: `op_${"m".repeat(20)}` },
        ],
      }).success,
    ).toBe(true);
    expect(
      NodeDesiredPage.safeParse({
        ...page,
        orders: [
          {
            type: "move",
            operation: `op_${"v".repeat(20)}`,
            database: id,
            storage_generation: 1,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      NodeDesiredPage.safeParse({
        ...page,
        databases: [],
        orders: [superseded, superseded],
      }).success,
    ).toBe(false);
  });

  it("orders a pre-wake with the generation of its claim", () => {
    const wake = {
      type: "wake",
      operation: `op_${"w".repeat(20)}`,
      database: id,
      generation: 5,
    };
    expect(NodeDesiredPage.safeParse({ ...page, orders: [wake] }).success).toBe(
      true,
    );
    for (const broken of [
      { generation: 0 },
      { database: undefined },
      { storage_generation: 1 },
    ])
      expect(
        NodeDesiredPage.safeParse({
          ...page,
          orders: [{ ...wake, ...broken }],
        }).success,
      ).toBe(false);
  });

  it("names each database once and every release binary once", () => {
    expect(
      NodeDesiredPage.safeParse({ ...page, databases: [database, database] })
        .success,
    ).toBe(false);
    expect(
      NodeDesiredPage.safeParse({
        ...page,
        release: {
          ...page.release,
          binaries: Object.fromEntries(
            Object.entries(page.release.binaries).slice(1),
          ),
        },
      }).success,
    ).toBe(false);
    expect(NodeDesiredPage.safeParse({ ...page, release: null }).success).toBe(
      true,
    );
  });

  it("names the four binaries by their file in the release's directory, and cloudflared by the package lock only", () => {
    const release = (binaries: object) => ({
      ...page,
      release: { ...page.release, binaries },
    });
    expect(Object.keys(page.release.binaries)).toEqual([
      "pgcf-agent",
      "pgcf-native-gateway",
      "pgcf-archive",
      "pgcf-wal-fetch",
    ]);
    for (const binaries of [
      { ...page.release.binaries, cloudflared: binary("cloudflared") },
      { ...page.release.binaries, "pgcf-native-gateway": undefined },
      {
        ...page.release.binaries,
        "pgcf-agent": { ...binary("pgcf-agent"), version: "1.0.0" },
      },
    ])
      expect(NodeDesiredPage.safeParse(release(binaries)).success).toBe(false);
  });
});

describe("the desired page query", () => {
  it("pages by cursor or pulls named databases, never both", () => {
    expect(NodeDesiredQuery.parse({})).toEqual({
      limit: NODE_DESIRED_PAGE_LIMIT_MAX,
    });
    expect(NodeDesiredQuery.parse({ after: id, limit: "50" })).toEqual({
      after: id,
      limit: 50,
    });
    const ids = Array.from(
      { length: NODE_DESIRED_PAGE_LIMIT_MAX },
      (_, index) => `d${String(index).padStart(19, "0")}`,
    );
    expect(NodeDesiredQuery.safeParse({ ids: ids.join(",") }).success).toBe(
      true,
    );
    for (const query of [
      { ids: [...ids, id].join(",") },
      { ids: `${id},` },
      { ids: `${id},BAD` },
      { ids: id, after: id },
      { limit: "0" },
      { limit: String(NODE_DESIRED_PAGE_LIMIT_MAX + 1) },
    ])
      expect(NodeDesiredQuery.safeParse(query).success).toBe(false);
  });
});

describe("what a node reports", () => {
  const proof = {
    system_identifier: "7428512345678901234",
    timeline: 1,
    checkpoint_lsn: "0/3000028",
    last_archived_segment: "000000010000000000000002",
    proven_at: now,
  };
  const observation = {
    id,
    generation: 4,
    operation,
    storage_generation: 1,
    state: "asleep",
    proven_sleep: proof,
    backup: {
      backup_id: "20261017T110000",
      timeline: 1,
      completed_at: now,
    },
    archive: {
      last_segment: "000000010000000000000002",
      ready_files: 0,
      failing_since: null,
    },
  };

  it("counts a database cold only with its proven-sleep record", () => {
    expect(
      NodeObservationReport.safeParse({
        observed_at: now,
        databases: [observation],
        orders: [],
      }).success,
    ).toBe(true);
    for (const broken of [
      { proven_sleep: null },
      { state: "ready", proven_sleep: proof },
      { state: "asleep", refusal: "power_busy" },
      { proven_sleep: { ...proof, checkpoint_lsn: "0/3000028/1" } },
    ])
      expect(
        NodeObservationReport.safeParse({
          observed_at: now,
          databases: [{ ...observation, ...broken }],
          orders: [],
        }).success,
      ).toBe(false);
    expect(
      NodeObservationReport.safeParse({
        observed_at: now,
        databases: [
          {
            ...observation,
            state: "ready",
            proven_sleep: null,
            refusal: "power_archive",
          },
        ],
        orders: [
          { operation: `op_${"s".repeat(20)}`, status: "failed", reason: "x" },
        ],
      }).success,
    ).toBe(true);
    // An order ends with its result, and exactly a failure names its reason.
    for (const [result, valid] of [
      [{ status: "done" }, true],
      [{ status: "failed", reason: "no_headroom" }, true],
      [{ status: "failed" }, false],
      [{ status: "done", reason: "no_headroom" }, false],
      [{ status: "failed", reason: "No Headroom" }, false],
    ] as const)
      expect(
        NodeObservationReport.safeParse({
          observed_at: now,
          databases: [],
          orders: [{ operation: `op_${"s".repeat(20)}`, ...result }],
        }).success,
      ).toBe(valid);
  });

  it("samples memory, CPU, the pool, the volumes and the archive within their bounds", () => {
    const sample = {
      observed_at: now,
      memory: { total_bytes: 12 * 1024 ** 3, available_bytes: 9 * 1024 ** 3 },
      cpu: { cores: 6, busy_millicores: 1200 },
      pool: {
        observed_at: now,
        data_total_bytes: 125 * 1024 ** 3,
        data_used_bytes: 40 * 1024 ** 3,
        metadata_total_bytes: 1024 ** 3,
        metadata_used_bytes: 1024 ** 2,
        nominal_bytes: 300 * 1024 ** 3,
      },
      room: true,
      volumes: { total: 300, mounted: 280 },
      archive: { ready_files: 3, oldest_ready_seconds: 42 },
      awake: [id],
      awake_memory_mib: 256,
      starting: 0,
      queued: 0,
    };
    expect(NodeSample.safeParse(sample).success).toBe(true);
    expect(NodeSample.safeParse({ ...sample, pool: null }).success).toBe(true);
    // Unknown is null and never zero; nothing waiting has no age.
    expect(
      NodeSample.safeParse({
        ...sample,
        archive: { ready_files: null, oldest_ready_seconds: null },
      }).success,
    ).toBe(true);
    expect(
      NodeSample.safeParse({
        ...sample,
        archive: { ready_files: 0, oldest_ready_seconds: null },
      }).success,
    ).toBe(true);
    for (const broken of [
      { memory: { total_bytes: 1, available_bytes: 2 } },
      { cpu: { cores: 6, busy_millicores: 6001 } },
      { pool: { ...sample.pool, data_used_bytes: 126 * 1024 ** 3 } },
      { awake: [id, id] },
      { volumes: { total: 3, mounted: 4 } },
      { starting: 2 },
      { archive: { ready_files: 0, oldest_ready_seconds: 5 } },
      { archive: { ready_files: null, oldest_ready_seconds: 5 } },
      { awake_memory_mib: undefined },
    ])
      expect(NodeSample.safeParse({ ...sample, ...broken }).success).toBe(
        false,
      );
    expect(
      ServerLinkMessage.safeParse({ type: "desired", ids: [id] }).success,
    ).toBe(true);
  });

  it("fits the largest sample into one link message", () => {
    const awake = Array.from(
      { length: NODE_AWAKE_LIMIT },
      (_, index) => `d${String(index).padStart(19, "0")}`,
    );
    const sample = {
      observed_at: now,
      memory: {
        total_bytes: Number.MAX_SAFE_INTEGER,
        available_bytes: Number.MAX_SAFE_INTEGER,
      },
      cpu: { cores: 1024, busy_millicores: 1_024_000 },
      pool: {
        observed_at: now,
        data_total_bytes: Number.MAX_SAFE_INTEGER,
        data_used_bytes: Number.MAX_SAFE_INTEGER,
        metadata_total_bytes: Number.MAX_SAFE_INTEGER,
        metadata_used_bytes: Number.MAX_SAFE_INTEGER,
        nominal_bytes: Number.MAX_SAFE_INTEGER,
      },
      room: true,
      volumes: { total: Number.MAX_SAFE_INTEGER, mounted: 0 },
      archive: {
        ready_files: Number.MAX_SAFE_INTEGER,
        oldest_ready_seconds: Number.MAX_SAFE_INTEGER,
      },
      awake,
      awake_memory_mib: Number.MAX_SAFE_INTEGER,
      starting: 0,
      queued: Number.MAX_SAFE_INTEGER,
    };
    const message = { type: "sample", sample };
    expect(AgentLinkMessage.safeParse(message).success).toBe(true);
    expect(JSON.stringify(message).length).toBeLessThan(
      NODE_LINK_MESSAGE_MAX_BYTES,
    );
    expect(
      NodeSample.safeParse({ ...sample, awake: [...awake, id] }).success,
    ).toBe(false);
  });

  it("reports each volume with its filesystem while mounted", () => {
    const volume = {
      database: id,
      storage_generation: 1,
      mounted: true,
      size_bytes: 1024 ** 3,
      pool_used_bytes: 150 * 1024 ** 2,
      filesystem: {
        total_bytes: 1000 * 1024 ** 2,
        used_bytes: 140 * 1024 ** 2,
        inodes_total: 16384,
        inodes_used: 1200,
      },
    };
    expect(
      NodeVolumeReport.safeParse({ observed_at: now, volumes: [volume] })
        .success,
    ).toBe(true);
    expect(
      NodeVolumeReport.safeParse({
        observed_at: now,
        volumes: [{ ...volume, mounted: false }],
      }).success,
    ).toBe(false);
  });

  it("names every admission refusal with its detail and retry hint, and every phase of a wake", () => {
    const admission = {
      type: "admission",
      at: now,
      database: id,
      generation: 5,
      operation,
      start: "wake",
      decision: "refused",
      reason: "no_headroom",
      retry_after_seconds: 5,
      waited_ms: 10_000,
      memory_mib: 256,
    };
    const wake = {
      type: "wake",
      at: now,
      database: id,
      generation: 5,
      operation,
      outcome: "started",
      phases_ms: { admission: 1, start: 61, release: 1 },
    };
    expect(
      ADMISSION_REFUSALS.map((reason) => ADMISSION_REFUSAL_DETAILS[reason]),
    ).toEqual(["storage", "node at awake capacity"]);
    expect(
      NodeEventReport.safeParse({
        events: [
          admission,
          wake,
          { ...wake, outcome: "refused", reason: "no_room" },
          {
            type: "early_sleep",
            at: now,
            database: `e${"b".repeat(19)}`,
            generation: 2,
            for_database: id,
          },
          {
            ...admission,
            start: "recovery",
            operation: null,
            decision: "admitted",
            reason: undefined,
            retry_after_seconds: undefined,
            waited_ms: 0,
          },
        ],
      }).success,
    ).toBe(true);
    for (const event of [
      { ...admission, reason: undefined },
      { ...admission, retry_after_seconds: undefined },
      { ...admission, retry_after_seconds: 0 },
      { ...admission, decision: "admitted", retry_after_seconds: undefined },
      { ...admission, decision: "admitted", reason: undefined },
      { ...wake, outcome: "refused" },
      { ...wake, reason: "no_room" },
      { ...wake, outcome: "hit" },
      { ...wake, phases_ms: { boot: 1 } },
    ])
      expect(NodeEventReport.safeParse({ events: [event] }).success).toBe(
        false,
      );
  });

  it("scopes an archive credential to one prefix and lifetime", () => {
    const value = {
      id: credential.id,
      path: `s3://pgcf-eu/eu-dev/${id}/g1-${operation}`,
      access: "read_write",
      endpoint_url: "https://account.r2.cloudflarestorage.com",
      access_key_id: "a".repeat(32),
      secret_access_key: "s".repeat(64),
      session_token: "t".repeat(400),
      expires_at: credential.expires_at,
    };
    expect(ArchiveCredential.safeParse(value).success).toBe(true);
    expect(
      ArchiveCredential.safeParse({
        ...value,
        path: `s3://pgcf-eu/eu-dev/${id}`,
      }).success,
    ).toBe(false);
  });
});
