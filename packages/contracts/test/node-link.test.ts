// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ArchiveCredential,
  NODE_API_PATHS,
  NODE_AWAKE_LIMIT,
  NODE_BOOT_REPORT_MAX_BYTES,
  NODE_DESIRED_PAGE_LIMIT_MAX,
  NODE_FENCED_PATHS,
  NODE_LINK_MESSAGE_MAX_BYTES,
  NODE_REQUEST_MAX_LIFETIME_SECONDS,
  NODE_USAGE_BATCH_MAX,
  NodeBootReport,
  NodeCredentials,
  NodeDatabaseObservation,
  NodeDesiredPage,
  NodeDesiredQuery,
  NodeEnrollmentRequest,
  NodeEnrollmentSeed,
  NodeEventReport,
  NodeFencedResponse,
  NodeObservationReport,
  NodeSample,
  NodeUsageReport,
  NodeVolumeReport,
  AgentLinkMessage,
  ServerLinkMessage,
  type NodeKey,
  nodePublicKey,
  nodeRequestClaims,
  observationVerdict,
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
  instance = "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c",
  now = "2026-10-17T12:00:00.000Z";
const credential = {
  id: `crd_${"k".repeat(20)}`,
  expires_at: "2026-10-24T12:00:00.000Z",
};
const proof = {
  system_identifier: "7428512345678901234",
  timeline: 1,
  checkpoint_lsn: "0/3000028",
  last_archived_segment: "000000010000000000000002",
  proven_at: now,
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
    backup: {
      wal_uploads: 2,
      base_backups: 1,
      memory_mib: { wal_upload: 128, wal_fetch: 192, base_backup: 256 },
    },
    io: { write_bytes_per_second: 16_000_000, write_iops: 1000 },
  },
  credentials_revision: 3,
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
    const moveSource = {
      database_id: id,
      path: `s3://pgcf-eu/eu-dev/${id}/g1-op_${"d".repeat(20)}`,
      backup_id: "20261017T110000",
      end: proof,
      credential,
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
      [{ ...moved, origin: { kind: "move", source: moveSource } }, true],
      [{ ...moved, origin: { kind: "move", source } }, false],
      [
        {
          ...moved,
          origin: {
            kind: "move",
            source: { ...moveSource, target_time: "2026-10-17T11:30:00.000Z" },
          },
        },
        false,
      ],
    ] as const)
      expect(
        NodeDesiredPage.safeParse({ ...page, databases: [entry] }).success,
      ).toBe(valid);
  });

  it("proves a move's end with the source's proven-sleep record, and a restore has none", () => {
    // The target can check that replay reached every committed transaction only against the
    // record that proved the source's sleep (plan 7.9, 9.5).
    const moveSource = {
      database_id: id,
      path: `s3://pgcf-eu/eu-dev/${id}/g1-op_${"d".repeat(20)}`,
      backup_id: "20261017T110000",
      credential,
    };
    const moved = (source: object) => ({
      ...page,
      databases: [
        {
          ...database,
          storage_generation: 2,
          archive: {
            path: `s3://pgcf-eu/eu-dev/${id}/g2-${operation}`,
            credential,
          },
          origin: { kind: "move", source },
        },
      ],
    });
    expect(
      NodeDesiredPage.safeParse(moved({ ...moveSource, end: proof })).success,
    ).toBe(true);
    for (const end of [
      undefined,
      { ...proof, timeline: 0 },
      { ...proof, last_archived_segment: "00000001" },
      { ...proof, proven_at: undefined },
      { system_identifier: proof.system_identifier },
    ])
      expect(
        NodeDesiredPage.safeParse(moved({ ...moveSource, end })).success,
      ).toBe(false);
    const restored = {
      database_id: `s${"b".repeat(19)}`,
      path: `s3://pgcf-eu/eu-dev/s${"b".repeat(19)}/g3-op_${"d".repeat(20)}`,
      backup_id: "20261017T110000",
      credential,
    };
    for (const source of [restored, { ...restored, end: proof }])
      expect(
        NodeDesiredPage.safeParse({
          ...page,
          databases: [{ ...database, origin: { kind: "restore", source } }],
        }).success,
      ).toBe(source === restored);
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
      { state: "ready", instance, proven_sleep: proof },
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
            instance,
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

  it("names the unit's instance exactly while the database is ready", () => {
    const ready = {
      ...observation,
      state: "ready",
      proven_sleep: null,
      instance,
    };
    const accepted = (change: object) =>
      NodeObservationReport.safeParse({
        observed_at: now,
        databases: [{ ...ready, ...change }],
        orders: [],
      }).success;
    expect(accepted({})).toBe(true);
    expect(accepted({ instance: undefined })).toBe(false);
    expect(accepted({ instance: "not-a-uuid" })).toBe(false);
    for (const state of ["building", "unproven", "deleted"])
      expect(accepted({ state })).toBe(false);
    expect(accepted({ state: "building", instance: undefined })).toBe(true);
    expect(
      accepted({
        state: "error",
        error: "start_failed",
        instance: undefined,
      }),
    ).toBe(true);
  });

  it("reports a database ready only with the DONE base backup of its storage generation", () => {
    const ready = {
      ...observation,
      state: "ready",
      proven_sleep: null,
      instance,
    };
    const accepted = (change: object) =>
      NodeObservationReport.safeParse({
        observed_at: now,
        databases: [{ ...ready, ...change }],
        orders: [],
      }).success;
    expect(accepted({})).toBe(true);
    expect(accepted({ backup: null })).toBe(false);
    // A database still building has none yet.
    expect(
      accepted({ state: "building", instance: undefined, backup: null }),
    ).toBe(true);
  });

  it("carries at most 64 events whose names are snake_case and whose fields are numbers or short tokens", () => {
    const accepted = (events: unknown) =>
      NodeObservationReport.safeParse({
        observed_at: now,
        databases: [],
        orders: [],
        events,
      }).success;
    const event = {
      at: now,
      event: "wake",
      database_id: id,
      fields: { step_start: 61, outcome: "started", total_ms: 70.5 },
    };
    // A report with nothing to tell carries no events.
    expect(
      NodeObservationReport.safeParse({
        observed_at: now,
        databases: [],
        orders: [],
      }).success,
    ).toBe(true);
    expect(accepted([event])).toBe(true);
    expect(accepted([{ ...event, database_id: undefined, fields: {} }])).toBe(
      true,
    );
    expect(accepted(Array.from({ length: 64 }, () => event))).toBe(true);
    expect(accepted(Array.from({ length: 65 }, () => event))).toBe(false);
    const fields = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, i]));
    expect(accepted([{ ...event, fields: fields(16) }])).toBe(true);
    expect(accepted([{ ...event, fields: fields(17) }])).toBe(false);
    for (const broken of [
      { event: "Wake" },
      { event: "a".repeat(49) },
      { at: "2026-10-17T12:00:00Z" },
      { database_id: "not-an-id" },
      { fields: undefined },
      { fields: { Step: 1 } },
      { fields: { outcome: "has a space" } },
      { fields: { outcome: "/etc/passwd" } },
      { fields: { outcome: "a".repeat(65) } },
      { fields: { ok: true } },
      { fields: { ok: { nested: 1 } } },
      { fields: { ok: Number.POSITIVE_INFINITY } },
      { extra: 1 },
    ])
      expect(accepted([{ ...event, ...broken }])).toBe(false);
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
      credentials_revision: 3,
    };
    expect(NodeSample.safeParse(sample).success).toBe(true);
    expect(NodeSample.safeParse({ ...sample, pool: null }).success).toBe(true);
    // Null until the node applied its first credentials; never zero.
    expect(
      NodeSample.safeParse({ ...sample, credentials_revision: null }).success,
    ).toBe(true);
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
      { credentials_revision: undefined },
      { credentials_revision: 0 },
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
      credentials_revision: Number.MAX_SAFE_INTEGER,
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

  it("says hello with the boot and the operating system of the node, and refuses a hello without them", () => {
    const os = {
      boot_id: "2f1c8a6e-3b57-4d0a-9c1e-7a4b5d6e8f90",
      booted_at: now,
      kernel_release: "6.12.111+deb13-amd64",
      packages_sha256: "a".repeat(64),
    };
    const hello = {
      type: "hello",
      protocol: 1,
      agent_version: "0.1.0",
      release_id: "release-25",
      os,
    };
    expect(AgentLinkMessage.safeParse(hello).success).toBe(true);
    expect(
      AgentLinkMessage.safeParse({ ...hello, os: undefined }).success,
    ).toBe(false);
    expect(AgentLinkMessage.safeParse({ ...hello, os: null }).success).toBe(
      false,
    );
    for (const change of [
      { boot_id: "not-a-uuid" },
      { booted_at: "2026-10-17T12:00:00Z" },
      { kernel_release: "" },
      { kernel_release: "k".repeat(65) },
      { kernel_release: "6.12 amd64" },
      { packages_sha256: "A".repeat(64) },
      { packages_sha256: "a".repeat(63) },
      { extra: 1 },
    ])
      expect(
        AgentLinkMessage.safeParse({ ...hello, os: { ...os, ...change } })
          .success,
        JSON.stringify(change),
      ).toBe(false);
    for (const field of Object.keys(os))
      expect(
        AgentLinkMessage.safeParse({
          ...hello,
          os: { ...os, [field]: undefined },
        }).success,
        field,
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

  it("names every admission refusal with its reason, the retry hint of awake capacity only, and every phase of a wake", () => {
    const eventId = (letter: string) =>
      `${letter.repeat(8)}-1111-4111-8111-111111111111`;
    const admission = {
      type: "admission",
      id: eventId("a"),
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
      id: eventId("b"),
      at: now,
      database: id,
      generation: 5,
      operation,
      outcome: "started",
      phases_ms: { admission: 1, start: 61, release: 1 },
    };
    expect(
      NodeEventReport.safeParse({
        events: [
          admission,
          wake,
          {
            ...wake,
            id: eventId("c"),
            outcome: "refused",
            reason: "no_room",
          },
          {
            ...admission,
            id: eventId("d"),
            reason: "no_room",
            retry_after_seconds: undefined,
          },
          {
            type: "early_sleep",
            id: eventId("e"),
            at: now,
            database: `e${"b".repeat(19)}`,
            generation: 2,
            for_database: id,
          },
          {
            ...admission,
            id: eventId("f"),
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
      { ...admission, reason: "no_room" },
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

  it("gives every event an id so a retried post is counted once", () => {
    const events = [
      {
        type: "early_sleep",
        id: "a1111111-1111-4111-8111-111111111111",
        at: now,
        database: `e${"b".repeat(19)}`,
        generation: 2,
        for_database: id,
      },
      {
        type: "wake",
        id: "b1111111-1111-4111-8111-111111111111",
        at: now,
        database: id,
        generation: 5,
        operation,
        outcome: "started",
        phases_ms: { start: 61 },
      },
    ];
    expect(NodeEventReport.safeParse({ events }).success).toBe(true);
    for (const broken of [
      events.map((event) => ({ ...event, id: undefined })),
      events.map((event) => ({ ...event, id: "not-a-uuid" })),
      [events[0], { ...events[1], id: events[0]!.id }],
      [events[0], events[0]],
    ])
      expect(NodeEventReport.safeParse({ events: broken }).success).toBe(false);
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

describe("usage", () => {
  const row = {
    database: id,
    interval_start: "2026-10-17T11:00:00.000Z",
    interval_end: "2026-10-17T11:15:00.000Z",
    awake_ms: 900_000,
    ingress_bytes: 100,
    egress_bytes: 200,
    connections: 3,
    connection_ms: 5_000,
  };
  const unknown = {
    ...row,
    awake_ms: null,
    ingress_bytes: null,
    egress_bytes: null,
    connections: null,
    connection_ms: null,
  };
  const report = (...rows: object[]) => NodeUsageReport.safeParse({ rows });

  it("has its own signed path", () => {
    expect(NODE_API_PATHS.usage).toBe("/node/v1/usage");
  });

  it("reports one database's deltas per interval, and an unknown metric as null", () => {
    expect(report(row).success).toBe(true);
    expect(report(unknown).success).toBe(true);
    // Adjacent intervals tile the hours; the same interval of another database is another row.
    expect(
      report(
        row,
        {
          ...row,
          interval_start: row.interval_end,
          interval_end: "2026-10-17T12:00:00.000Z",
        },
        { ...row, database: `e${"b".repeat(19)}` },
      ).success,
    ).toBe(true);
    for (const broken of [
      { awake_ms: undefined },
      { ingress_bytes: -1 },
      { egress_bytes: 1.5 },
      { connections: Number.MAX_SAFE_INTEGER + 1 },
      { interval_end: row.interval_start },
      { interval_end: "2026-10-17T10:59:59.999Z" },
      // An interval never crosses a UTC hour: the API rolls up by hour.
      { interval_end: "2026-10-17T12:00:00.001Z" },
      { awake_ms: 900_001 },
      // Unknown is null; the API names the gap from the null.
      { gaps: ["ingress_bytes"] },
      { process_epoch: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c" },
    ])
      expect(report({ ...row, ...broken }).success).toBe(false);
  });

  it("names each interval of a database once and carries at most one batch", () => {
    expect(report().success).toBe(false);
    expect(report(row, row).success).toBe(false);
    expect(report(row, { ...unknown }).success).toBe(false);
    const rows = Array.from({ length: NODE_USAGE_BATCH_MAX }, (_, index) => ({
      ...row,
      database: `d${String(index).padStart(19, "0")}`,
    }));
    expect(report(...rows).success).toBe(true);
    expect(report(...rows, { ...row, database: id }).success).toBe(false);
  });
});

describe("a fenced node", () => {
  const fence = { type: "fence", operation: `op_${"f".repeat(20)}` };
  const superseded = {
    type: "superseded",
    operation: `op_${"s".repeat(20)}`,
    database: `x${"b".repeat(19)}`,
    storage_generation: 2,
    remove_volume: true,
  };
  const fenced = {
    ...page,
    release: null,
    orders: [fence, superseded],
    databases: [],
    next: null,
  };

  it("is told by a page that has no database, no release and only fence and superseded orders", () => {
    expect(NodeDesiredPage.safeParse(fenced).success).toBe(true);
    for (const broken of [
      { databases: [database] },
      { release: page.release },
      { next: id },
      {
        orders: [
          fence,
          { type: "maintenance", operation: `op_${"m".repeat(20)}` },
        ],
      },
      {
        orders: [
          fence,
          {
            type: "move",
            operation: `op_${"v".repeat(20)}`,
            database: id,
            storage_generation: 1,
          },
        ],
      },
      {
        orders: [
          fence,
          {
            type: "wake",
            operation: `op_${"w".repeat(20)}`,
            database: id,
            generation: 5,
          },
        ],
      },
    ])
      expect(NodeDesiredPage.safeParse({ ...fenced, ...broken }).success).toBe(
        false,
      );
    // Without a fence order the same page is an ordinary page.
    expect(
      NodeDesiredPage.safeParse({ ...fenced, orders: [superseded] }).success,
    ).toBe(true);
  });

  it("keeps its key for the desired page and its observations only, and answers the rest node_fenced", () => {
    expect(NODE_FENCED_PATHS).toEqual([
      NODE_API_PATHS.desired,
      NODE_API_PATHS.observations,
    ]);
    expect(NodeFencedResponse.safeParse({ error: "node_fenced" }).success).toBe(
      true,
    );
    for (const body of [
      { error: "forbidden" },
      { error: "node_fenced", detail: "x" },
      {},
    ])
      expect(NodeFencedResponse.safeParse(body).success).toBe(false);
  });
});

describe("the order of generations", () => {
  const desired = { generation: 4, operation: `op_${"a".repeat(20)}` };
  const released = { generation: 5, operation: `op_${"w".repeat(20)}` };

  it("accepts an observation of the desired generation and operation", () => {
    expect(observationVerdict(desired, null, desired)).toBe("accept");
    // A refused suspend answers the suspend's own generation; it is final for it.
    const suspend = { generation: 6, operation: `op_${"u".repeat(20)}` };
    expect(
      NodeDatabaseObservation.safeParse({
        id,
        ...suspend,
        storage_generation: 1,
        state: "ready",
        instance,
        proven_sleep: null,
        refusal: "power_busy",
        backup: {
          backup_id: "20261017T110000",
          timeline: 1,
          completed_at: now,
        },
        archive: { last_segment: null, ready_files: 0, failing_since: null },
      }).success,
    ).toBe(true);
    expect(observationVerdict(suspend, null, suspend)).toBe("accept");
  });

  it("ignores an older generation and refuses the same generation of another operation", () => {
    expect(
      observationVerdict(desired, null, { ...desired, generation: 3 }),
    ).toBe("stale");
    // A concurrent suspend or resize won the D1 claim: the page wins and the agent applies it.
    expect(
      observationVerdict(desired, null, {
        ...desired,
        operation: `op_${"b".repeat(20)}`,
      }),
    ).toBe("conflict");
  });

  it("takes a generation above the page's only as the wake claim the node released", () => {
    expect(observationVerdict(desired, released, released)).toBe("accept");
    for (const [claim, observed] of [
      [null, released],
      [released, { ...released, operation: `op_${"b".repeat(20)}` }],
      [
        { ...released, generation: 6 },
        { ...released, generation: 6 },
      ],
      [released, { ...released, generation: 6 }],
    ] as const)
      expect(observationVerdict(desired, claim, observed)).toBe("conflict");
  });
});

describe("credentials and the node's policy", () => {
  const credentials = {
    revision: 3,
    tunnel_token: "eyJ".padEnd(120, "A"),
    route_keyring: {
      active: "k1",
      keys: { k1: "A".repeat(43) },
    },
  };

  it("numbers the credentials the page expects and the credentials a read returns", () => {
    expect(NodeCredentials.safeParse(credentials).success).toBe(true);
    for (const revision of [undefined, 0, -1])
      expect(
        NodeCredentials.safeParse({ ...credentials, revision }).success,
      ).toBe(false);
    for (const credentials_revision of [undefined, 0])
      expect(
        NodeDesiredPage.safeParse({ ...page, credentials_revision }).success,
      ).toBe(false);
  });

  it("carries the memory of each backup job and the write limits of a 256 MiB database", () => {
    const withPolicy = (change: object) => ({
      ...page,
      policy: { ...page.policy, ...change },
    });
    for (const broken of [
      { backup: { wal_uploads: 2, base_backups: 1 } },
      {
        backup: {
          ...page.policy.backup,
          memory_mib: { wal_upload: 128, wal_fetch: 192 },
        },
      },
      {
        backup: {
          ...page.policy.backup,
          memory_mib: { ...page.policy.backup.memory_mib, wal_upload: 0 },
        },
      },
      { io: undefined },
      { io: { ...page.policy.io, write_iops: 0 } },
      { io: { ...page.policy.io, write_bytes_per_second: 0 } },
    ])
      expect(NodeDesiredPage.safeParse(withPolicy(broken)).success).toBe(false);
  });
});

describe("the report of the previous boot", () => {
  const entry = {
    at: now,
    unit: "pgcf-agent.service",
    identifier: "pgcf-agent",
    transport: "stdout",
    priority: 6,
    message: "agent started",
  };
  const report = (entries: object[]) => ({
    boot_id: "2f1c8a6e-3b57-4d0a-9c1e-7a4b5d6e8f90",
    previous_boot_id: null,
    kernel_release: "6.12.111+deb13-amd64",
    entries,
  });

  it("takes at most 1,000 entries and names its path", () => {
    expect(NODE_API_PATHS.diagnostics).toBe("/node/v1/diagnostics");
    const thousand = Array.from({ length: 1000 }, () => entry);
    expect(NodeBootReport.safeParse(report(thousand)).success).toBe(true);
    expect(NodeBootReport.safeParse(report([...thousand, entry])).success).toBe(
      false,
    );
  });

  it("counts a message in bytes, not in characters", () => {
    const message = (text: string) =>
      NodeBootReport.safeParse(report([{ ...entry, message: text }])).success;
    expect(message("a".repeat(2048))).toBe(true);
    expect(message("\u00e9".repeat(1024))).toBe(true);
    expect(message("\u00e9".repeat(1025))).toBe(false);
    expect(message("a".repeat(2049))).toBe(false);
  });

  it("is refused beyond 1 MiB of JSON, which 1,000 full messages are", () => {
    const full = { ...entry, message: "a".repeat(2048) };
    const fits = Math.floor(
      NODE_BOOT_REPORT_MAX_BYTES / JSON.stringify(full).length,
    );
    expect(
      NodeBootReport.safeParse(
        report(Array.from({ length: fits - 1 }, () => full)),
      ).success,
    ).toBe(true);
    expect(
      NodeBootReport.safeParse(report(Array.from({ length: 1000 }, () => full)))
        .success,
    ).toBe(false);
  });
});
