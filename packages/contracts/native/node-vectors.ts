// SPDX-License-Identifier: Apache-2.0
// Conformance inputs of the node contracts, never live acceptance or product defaults. Each
// vector states whether the Zod contract accepts it; `refinement` marks a value only the
// contract's own checks refuse, which a JSON Schema alone accepts.
import type { z } from "zod";
import * as link from "../src/node-link.ts";
import * as local from "../src/node-local.ts";
import { bytesToBase64url } from "../src/encoding.ts";
import { FleetReleaseId, packagesSha256 } from "../src/releases.ts";

const id = `d${"b".repeat(19)}`,
  other = `e${"b".repeat(19)}`,
  source = `s${"b".repeat(19)}`,
  operation = `op_${"c".repeat(20)}`,
  op = (letter: string) => `op_${letter.repeat(20)}`,
  now = "2026-10-17T12:00:00.000Z",
  region = "eu-dev",
  path = (database: string, generation: number, operationId = operation) =>
    `s3://pgcf-eu/${region}/${database}/g${generation}-${operationId}`;
const node = {
  id: `nod_${"n".repeat(20)}`,
  uid: "01234567-89ab-4def-8123-0123456789ab",
  hostname: "eu1",
  region_id: region,
};
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
const reader = {
  name: "reader",
  owner: false,
  password: "q".repeat(43),
  revision: 2,
  valid_until: "2031-01-02T03:04:05.678Z",
  connection_limit: 5,
  bypass_rls: true,
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
  roles: [owner, reader, { name: "report", state: "absent" }],
  archive: { path: path(id, 1), credential },
};
const restored = {
  ...database,
  id: other,
  roles: [owner],
  archive: { path: path(other, 1), credential },
  origin: {
    kind: "restore",
    source: {
      database_id: source,
      path: path(source, 3, op("d")),
      backup_id: "20261017T110000",
      target_time: "2026-10-17T11:30:00.000Z",
      credential,
    },
  },
};
const moved = {
  ...database,
  id: source,
  storage_generation: 4,
  desired_state: "suspended",
  sleep_after_seconds: null,
  roles: [owner],
  archive: { path: path(source, 4, op("m")), credential },
  origin: {
    kind: "move",
    source: {
      database_id: source,
      path: path(source, 3, op("d")),
      backup_id: "20261017T110000",
      end: proof,
      credential,
    },
  },
};
const binary = {
  url: "https://releases.example/binary",
  sha256: "a".repeat(64),
  size_bytes: 1000,
};
const page = {
  node,
  release: {
    id: "release-25",
    binaries: {
      "pgcf-agent": binary,
      "pgcf-native-gateway": binary,
      "pgcf-archive": binary,
      "pgcf-wal-fetch": binary,
    },
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
  orders: [
    { type: "move", operation: op("v"), database: id, storage_generation: 1 },
    {
      type: "superseded",
      operation: op("s"),
      database: `x${"b".repeat(19)}`,
      storage_generation: 2,
      remove_volume: false,
    },
    {
      type: "wake",
      operation: op("w"),
      database: other,
      generation: 6,
    },
    { type: "maintenance", operation: op("t") },
  ],
  databases: [
    database,
    restored,
    moved,
    {
      ...database,
      id: `f${"b".repeat(19)}`,
      desired_state: "deleted",
      roles: [],
      archive: { path: path(`f${"b".repeat(19)}`, 1), credential },
    },
    {
      ...database,
      id: `g${"b".repeat(19)}`,
      roles: [owner],
      archive: { path: path(`g${"b".repeat(19)}`, 1), credential },
      origin: { kind: "create" },
    },
  ],
  next: `g${"b".repeat(19)}`,
};
const superseded = {
  type: "superseded",
  operation: op("s"),
  database: `x${"b".repeat(19)}`,
  storage_generation: 2,
  remove_volume: true,
};
const fenced = {
  ...page,
  release: null,
  orders: [{ type: "fence", operation: op("f") }, superseded],
  databases: [],
  next: null,
};
// A page with nothing on it but what its own rules are about.
const bare = { ...page, orders: [], databases: [], next: null };
const withDatabase = (change: object) => ({
  ...page,
  orders: [],
  databases: [{ ...database, ...change }],
});
const instance = "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c";
const observation = {
  id,
  generation: 4,
  operation,
  storage_generation: 1,
  state: "asleep",
  proven_sleep: proof,
  backup: { backup_id: "20261017T110000", timeline: 1, completed_at: now },
  archive: {
    last_segment: "000000010000000000000002",
    ready_files: 0,
    failing_since: null,
  },
};
const reportEvent = {
  at: now,
  event: "wake",
  database_id: id,
  fields: { step_start: 61, outcome: "started", total_ms: 70 },
};
const observations = (...databases: object[]) => ({
  observed_at: now,
  databases,
  orders: [],
});
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
  queued: 1,
  credentials_revision: 3,
};
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
  phases_ms: {
    admission: 9,
    volume_check: 1,
    repair_check: 1,
    mount: 1,
    pg_control: 2,
    config: 1,
    archive: 1,
    queue_wait: 1,
    start: 61,
    release: 1,
  },
};
const usageRow = {
  database: id,
  interval_start: "2026-10-17T11:00:00.000Z",
  interval_end: "2026-10-17T11:15:00.000Z",
  awake_ms: 900_000,
  ingress_bytes: 100,
  egress_bytes: 200,
  connections: 3,
  connection_ms: 5000,
};
const archiveCredential = {
  id: credential.id,
  path: path(id, 1),
  access: "read_write",
  endpoint_url: "https://account.r2.cloudflarestorage.com",
  access_key_id: "a".repeat(32),
  secret_access_key: "s".repeat(64),
  session_token: "t".repeat(400),
  expires_at: credential.expires_at,
};

const hello = {
  type: "hello",
  protocol: 1,
  agent_version: "0.1.0",
  release_id: "release-25",
  os: {
    boot_id: "2f1c8a6e-3b57-4d0a-9c1e-7a4b5d6e8f90",
    booted_at: now,
    kernel_release: "6.12.111+deb13-amd64",
    packages_sha256: "a".repeat(64),
  },
};

const journalEntry = {
  at: now,
  unit: "pgcf-agent.service",
  identifier: "pgcf-agent",
  transport: "stdout",
  priority: 6,
  message: '{"event":"agent_started","uptime_s":12}',
};
const bootReport = {
  boot_id: hello.os.boot_id,
  previous_boot_id: "9a7c1d2e-4b3f-4a65-8e10-6c5d4b3a2f10",
  kernel_release: hello.os.kernel_release,
  entries: [
    journalEntry,
    {
      at: now,
      unit: null,
      identifier: null,
      transport: "kernel",
      priority: 3,
      message: "Out of memory: Killed process 4242 (postgres)",
    },
    {
      at: now,
      unit: "init.scope",
      identifier: "systemd",
      transport: "journal",
      priority: 6,
      message: "Stopping pgcf-agent.service - PGCF node agent...",
    },
  ],
};
const probeRequest = {
  id: "5b1f0c2e-7d34-4a8b-9e61-0c3d2a4f6b81",
  probe: "journal",
  boot: -1,
  since_seconds: 3600,
  lines: 200,
};
const probeResult = {
  kind: "probe",
  diagnostic_id: probeRequest.id,
  probe: "journal",
  status: "ok",
  entries: [journalEntry],
  text: "",
};
const textResult = {
  ...probeResult,
  probe: "listeners",
  entries: [],
  text: "tcp   LISTEN 0      4096   127.0.0.1:8443     0.0.0.0:*\n",
};

type Case = [name: string, value: unknown, valid: boolean, refinement?: true];
/** The schemas the node agent reads or writes, by the name the JSON Schemas carry. */
export const nodeSchemas = {
  NodeEnrollmentSeed: link.NodeEnrollmentSeed,
  NodeEnrollmentRequest: link.NodeEnrollmentRequest,
  NodeEnrollmentResponse: link.NodeEnrollmentResponse,
  NodeRequestClaims: link.NodeRequestClaims,
  NodeCredentials: link.NodeCredentials,
  ArchiveCredential: link.ArchiveCredential,
  NodeDesiredPage: link.NodeDesiredPage,
  NodeObservationReport: link.NodeObservationReport,
  NodeSample: link.NodeSample,
  NodeVolumeReport: link.NodeVolumeReport,
  NodeEventReport: link.NodeEventReport,
  NodeBootReport: link.NodeBootReport,
  NodeProbeResult: link.NodeProbeResult,
  NodeUsageReport: link.NodeUsageReport,
  NodeFencedResponse: link.NodeFencedResponse,
  AgentLinkMessage: link.AgentLinkMessage,
  ServerLinkMessage: link.ServerLinkMessage,
  InstallerProgress: link.InstallerProgress,
  FleetReleaseId,
} as const satisfies Record<string, z.ZodType>;

const cases: Record<keyof typeof nodeSchemas, Case[]> = {
  NodeEnrollmentSeed: [
    [
      "installer-seed",
      {
        node_id: node.id,
        region,
        api_url: "https://api.example",
        enrollment_token: `pgcf_et_${"e".repeat(43)}`,
      },
      true,
    ],
    [
      "origin-with-port-and-slash",
      {
        node_id: node.id,
        region,
        api_url: "https://api.example:8443/",
        enrollment_token: `pgcf_et_${"e".repeat(43)}`,
      },
      true,
    ],
    [
      "unknown-field",
      {
        node_id: node.id,
        region,
        api_url: "https://api.example",
        enrollment_token: `pgcf_et_${"e".repeat(43)}`,
        hostname: "eu1",
      },
      false,
    ],
    [
      "url-with-path",
      {
        node_id: node.id,
        region,
        api_url: "https://api.example/pgcf",
        enrollment_token: `pgcf_et_${"e".repeat(43)}`,
      },
      false,
    ],
    [
      "url-with-query",
      {
        node_id: node.id,
        region,
        api_url: "https://api.example/?x=1",
        enrollment_token: `pgcf_et_${"e".repeat(43)}`,
      },
      false,
    ],
    [
      "plain-http",
      {
        node_id: node.id,
        region,
        api_url: "http://api.example",
        enrollment_token: `pgcf_et_${"e".repeat(43)}`,
      },
      false,
    ],
  ],
  NodeEnrollmentRequest: [
    [
      "request",
      {
        node_id: node.id,
        enrollment_token: `pgcf_et_${"e".repeat(43)}`,
        public_key: bytesToBase64url(new Uint8Array(32).fill(7)),
        image_version: "25",
      },
      true,
    ],
    [
      "short-key",
      {
        node_id: node.id,
        enrollment_token: `pgcf_et_${"e".repeat(43)}`,
        public_key: "A".repeat(42),
        image_version: "25",
      },
      false,
    ],
    [
      "noncanonical-key",
      {
        node_id: node.id,
        enrollment_token: `pgcf_et_${"e".repeat(43)}`,
        public_key: `${"A".repeat(42)}B`,
        image_version: "25",
      },
      false,
      true,
    ],
  ],
  NodeEnrollmentResponse: [
    ["identity", node, true],
    ["bad-uid", { ...node, uid: "not-a-uuid" }, false],
  ],
  NodeRequestClaims: [
    [
      "claims",
      {
        v: 1,
        node: node.id,
        uid: node.uid,
        method: "GET",
        path: "/node/v1/desired?after=dbbbbbbbbbbbbbbbbbbb&limit=200",
        body: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        iat: 1000,
        exp: 1060,
      },
      true,
    ],
    [
      "other-api",
      {
        v: 1,
        node: node.id,
        uid: node.uid,
        method: "GET",
        path: "/agent/v1/desired",
        body: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        iat: 1000,
        exp: 1060,
      },
      false,
    ],
  ],
  NodeCredentials: [
    [
      "credentials",
      {
        revision: 3,
        tunnel_token: "eyJ".padEnd(120, "A"),
        route_keyring: {
          active: "k1",
          keys: { k1: bytesToBase64url(new Uint8Array(32).fill(9)) },
        },
      },
      true,
    ],
    [
      "no-revision",
      {
        tunnel_token: "eyJ".padEnd(120, "A"),
        route_keyring: {
          active: "k1",
          keys: { k1: bytesToBase64url(new Uint8Array(32).fill(9)) },
        },
      },
      false,
    ],
    [
      "short-tunnel-token",
      {
        revision: 3,
        tunnel_token: "eyJ",
        route_keyring: {
          active: "k1",
          keys: { k1: bytesToBase64url(new Uint8Array(32).fill(9)) },
        },
      },
      false,
    ],
  ],
  ArchiveCredential: [
    ["read-write", archiveCredential, true],
    [
      "read-only-source",
      {
        ...archiveCredential,
        path: path(source, 3, op("d")),
        access: "read_only",
      },
      true,
    ],
    ["delete-access", { ...archiveCredential, access: "delete" }, false],
    [
      "no-generation",
      { ...archiveCredential, path: `s3://pgcf-eu/${region}/${id}` },
      false,
    ],
  ],
  NodeDesiredPage: [
    ["full-page", page, true],
    ["fenced-page", fenced, true],
    ["fence-with-databases", { ...fenced, databases: [database] }, false, true],
    ["fence-with-release", { ...fenced, release: page.release }, false, true],
    ["fence-with-next", { ...fenced, next: id }, false, true],
    [
      "fence-with-maintenance",
      { ...fenced, orders: [...fenced.orders, page.orders[3]] },
      false,
      true,
    ],
    [
      "fence-with-wake",
      { ...fenced, orders: [...fenced.orders, page.orders[2]] },
      false,
      true,
    ],
    [
      "with-diagnostics",
      {
        ...bare,
        diagnostics: [
          probeRequest,
          { ...probeRequest, id: eventId("d"), probe: "pool" },
        ],
      },
      true,
    ],
    [
      "nine-diagnostics",
      {
        ...bare,
        diagnostics: Array.from({ length: 9 }, (_, i) => ({
          ...probeRequest,
          id: eventId(String(i)),
        })),
      },
      false,
    ],
    [
      "diagnostic-with-a-command",
      { ...bare, diagnostics: [{ ...probeRequest, command: "ss -p" }] },
      false,
    ],
    [
      "diagnostic-of-an-unknown-probe",
      { ...bare, diagnostics: [{ ...probeRequest, probe: "shell" }] },
      false,
    ],
    [
      "diagnostic-lines-over-2000",
      { ...bare, diagnostics: [{ ...probeRequest, lines: 2001 }] },
      false,
    ],
    ["credentials-revision-zero", { ...page, credentials_revision: 0 }, false],
    [
      "no-credentials-revision",
      { ...page, credentials_revision: undefined },
      false,
    ],
    [
      "no-write-limits",
      { ...page, policy: { ...page.policy, io: undefined } },
      false,
    ],
    [
      "no-backup-job-memory",
      {
        ...page,
        policy: {
          ...page.policy,
          backup: { wal_uploads: 2, base_backups: 1 },
        },
      },
      false,
    ],
    [
      "no-release-last-page",
      { ...page, release: null, orders: [], databases: [], next: null },
      true,
    ],
    ["unknown-field", { ...page, region: region }, false],
    [
      "memory-step",
      withDatabase({ resources: { ...database.resources, memory_mib: 300 } }),
      false,
    ],
    ["postgresql-17", withDatabase({ pg_major: 17 }), false],
    ["sleep-under-a-minute", withDatabase({ sleep_after_seconds: 59 }), false],
    [
      "release-without-the-gateway",
      {
        ...page,
        release: {
          ...page.release,
          binaries: {
            ...page.release.binaries,
            "pgcf-native-gateway": undefined,
          },
        },
      },
      false,
    ],
    [
      "release-with-cloudflared",
      {
        ...page,
        release: {
          ...page.release,
          binaries: { ...page.release.binaries, cloudflared: binary },
        },
      },
      false,
    ],
    [
      "archive-of-another-database",
      withDatabase({ archive: { path: path(other, 1), credential } }),
      false,
      true,
    ],
    [
      "archive-of-another-generation",
      withDatabase({ archive: { path: path(id, 2), credential } }),
      false,
      true,
    ],
    [
      "archive-in-another-region",
      withDatabase({
        archive: {
          path: `s3://pgcf-eu/us-dev/${id}/g1-${operation}`,
          credential,
        },
      }),
      false,
      true,
    ],
    [
      "restore-from-itself",
      withDatabase({
        origin: {
          kind: "restore",
          source: {
            ...restored.origin.source,
            database_id: id,
            path: path(id, 1),
          },
        },
      }),
      false,
      true,
    ],
    [
      "restore-source-path-of-another-database",
      withDatabase({
        origin: {
          kind: "restore",
          source: { ...restored.origin.source, path: path(other, 3) },
        },
      }),
      false,
      true,
    ],
    [
      "move-from-another-database",
      {
        ...page,
        orders: [],
        databases: [
          {
            ...moved,
            origin: {
              kind: "move",
              source: {
                ...moved.origin.source,
                database_id: other,
                path: path(other, 3, op("d")),
              },
            },
          },
        ],
      },
      false,
      true,
    ],
    [
      "move-to-an-older-generation",
      {
        ...page,
        orders: [],
        databases: [
          {
            ...moved,
            origin: {
              kind: "move",
              source: {
                ...moved.origin.source,
                path: path(source, 4, op("d")),
              },
            },
          },
        ],
      },
      false,
      true,
    ],
    [
      "move-to-a-point-in-time",
      {
        ...page,
        orders: [],
        databases: [
          {
            ...moved,
            origin: {
              kind: "move",
              source: { ...moved.origin.source, target_time: now },
            },
          },
        ],
      },
      false,
    ],
    [
      "move-without-end",
      {
        ...page,
        orders: [],
        databases: [
          {
            ...moved,
            origin: {
              kind: "move",
              source: { ...moved.origin.source, end: undefined },
            },
          },
        ],
      },
      false,
    ],
    [
      "move-with-incomplete-end",
      {
        ...page,
        orders: [],
        databases: [
          {
            ...moved,
            origin: {
              kind: "move",
              source: {
                ...moved.origin.source,
                end: { ...proof, last_archived_segment: undefined },
              },
            },
          },
        ],
      },
      false,
    ],
    [
      "restore-with-end",
      withDatabase({
        origin: {
          kind: "restore",
          source: { ...restored.origin.source, end: proof },
        },
      }),
      false,
    ],
    ["no-owner", withDatabase({ roles: [reader] }), false, true],
    [
      "two-owners",
      withDatabase({ roles: [owner, { ...reader, owner: true }] }),
      false,
      true,
    ],
    ["duplicate-role", withDatabase({ roles: [owner, owner] }), false, true],
    [
      "owner-removed",
      withDatabase({ roles: [owner, { name: "app", state: "absent" }] }),
      false,
      true,
    ],
    [
      "reserved-role",
      withDatabase({ roles: [owner, { ...reader, name: "postgres" }] }),
      false,
      true,
    ],
    [
      "reserved-role-prefix",
      withDatabase({ roles: [owner, { ...reader, name: "pg_monitor_x" }] }),
      false,
      true,
    ],
    [
      "maintenance-role",
      withDatabase({ roles: [owner, { ...reader, name: "pgcf_maintenance" }] }),
      false,
      true,
    ],
    [
      "member-of-owner",
      withDatabase({ roles: [owner, { ...reader, member_of: ["app"] }] }),
      false,
      true,
    ],
    [
      "member-of-a-present-role",
      withDatabase({
        roles: [
          owner,
          reader,
          { ...reader, name: "report", member_of: ["reader"] },
        ],
      }),
      true,
    ],
    [
      "member-of-an-absent-role",
      withDatabase({
        roles: [owner, { ...reader, member_of: ["missing"] }],
      }),
      false,
      true,
    ],
    [
      "duplicate-database",
      { ...page, orders: [], databases: [database, database] },
      false,
      true,
    ],
    [
      "duplicate-order",
      { ...page, orders: [page.orders[2], page.orders[2]] },
      false,
      true,
    ],
    [
      "superseded-served-generation",
      {
        ...page,
        orders: [
          {
            type: "superseded",
            operation: op("s"),
            database: id,
            storage_generation: 1,
            remove_volume: true,
          },
        ],
      },
      false,
      true,
    ],
    [
      "superseded-older-generation",
      {
        ...page,
        orders: [
          {
            type: "superseded",
            operation: op("s"),
            database: source,
            storage_generation: 3,
            remove_volume: true,
          },
        ],
      },
      true,
    ],
  ],
  NodeObservationReport: [
    ["asleep", observations(observation), true],
    [
      "ready-after-a-refused-sleep",
      {
        ...observations({
          ...observation,
          state: "ready",
          instance,
          proven_sleep: null,
          refusal: "power_archive",
          roles: { removed: ["report"], blocked: [] },
        }),
        orders: [
          { operation: op("s"), status: "failed", reason: "volume_missing" },
        ],
      },
      true,
    ],
    [
      "storage-full",
      observations({
        ...observation,
        state: "error",
        error: "storage_full",
        proven_sleep: null,
        backup: null,
        archive: { last_segment: null, ready_files: null, failing_since: now },
      }),
      true,
    ],
    [
      "hibernated",
      observations({ ...observation, state: "hibernated" }),
      false,
    ],
    [
      "negative-backlog",
      observations({
        ...observation,
        archive: { ...observation.archive, ready_files: -1 },
      }),
      false,
    ],
    [
      "asleep-without-proof",
      observations({ ...observation, proven_sleep: null }),
      false,
      true,
    ],
    [
      "ready-with-proof",
      observations({ ...observation, state: "ready", instance }),
      false,
      true,
    ],
    [
      "ready-without-instance",
      observations({ ...observation, state: "ready", proven_sleep: null }),
      false,
      true,
    ],
    [
      "ready-without-backup",
      observations({
        ...observation,
        state: "ready",
        instance,
        proven_sleep: null,
        backup: null,
      }),
      false,
      true,
    ],
    [
      "asleep-with-instance",
      observations({ ...observation, instance }),
      false,
      true,
    ],
    ["with-events", { ...observations(), events: [reportEvent] }, true],
    [
      "event-with-a-space",
      {
        ...observations(),
        events: [{ ...reportEvent, fields: { outcome: "has a space" } }],
      },
      false,
    ],
    [
      "event-with-a-nested-field",
      {
        ...observations(),
        events: [{ ...reportEvent, fields: { outcome: { nested: 1 } } }],
      },
      false,
    ],
    [
      "event-with-an-unknown-key",
      { ...observations(), events: [{ ...reportEvent, text: "no" }] },
      false,
    ],
    [
      "event-with-too-many-fields",
      {
        ...observations(),
        events: [
          {
            ...reportEvent,
            fields: Object.fromEntries(
              Array.from({ length: 17 }, (_, i) => [`f${i}`, i]),
            ),
          },
        ],
      },
      false,
      true,
    ],
    [
      "error-without-error",
      observations({ ...observation, state: "error", proven_sleep: null }),
      false,
      true,
    ],
    [
      "refusal-while-asleep",
      observations({ ...observation, refusal: "power_busy" }),
      false,
      true,
    ],
    [
      "identifier-above-u64",
      observations({
        ...observation,
        proven_sleep: { ...proof, system_identifier: "18446744073709551616" },
      }),
      false,
      true,
    ],
    [
      "roles-while-asleep",
      observations({ ...observation, roles: { removed: [], blocked: [] } }),
      false,
      true,
    ],
    [
      "role-removed-and-blocked",
      observations({
        ...observation,
        state: "ready",
        instance,
        proven_sleep: null,
        roles: { removed: ["report"], blocked: ["report"] },
      }),
      false,
      true,
    ],
    ["duplicate-database", observations(observation, observation), false, true],
    [
      "failed-order-without-reason",
      { ...observations(), orders: [{ operation: op("s"), status: "failed" }] },
      false,
      true,
    ],
    [
      "done-order-with-reason",
      {
        ...observations(),
        orders: [
          { operation: op("s"), status: "done", reason: "volume_missing" },
        ],
      },
      false,
      true,
    ],
  ],
  NodeSample: [
    ["sample", sample, true],
    ["no-pool", { ...sample, pool: null, awake: [] }, true],
    ["no-cores", { ...sample, cpu: { cores: 0, busy_millicores: 0 } }, false],
    [
      "available-above-total",
      { ...sample, memory: { total_bytes: 1024, available_bytes: 2048 } },
      false,
      true,
    ],
    [
      "busy-above-cores",
      { ...sample, cpu: { cores: 6, busy_millicores: 6001 } },
      false,
      true,
    ],
    [
      "pool-above-total",
      { ...sample, pool: { ...sample.pool, data_used_bytes: 126 * 1024 ** 3 } },
      false,
      true,
    ],
    [
      "metadata-above-total",
      {
        ...sample,
        pool: { ...sample.pool, metadata_used_bytes: 2 * 1024 ** 3 },
      },
      false,
      true,
    ],
    [
      "pool-read-after-the-sample",
      {
        ...sample,
        pool: { ...sample.pool, observed_at: "2026-10-17T12:00:00.001Z" },
      },
      false,
      true,
    ],
    ["awake-twice", { ...sample, awake: [id, id] }, false, true],
    [
      "mounted-above-total",
      { ...sample, volumes: { total: 3, mounted: 4 } },
      false,
      true,
    ],
    [
      "age-without-segments",
      { ...sample, archive: { ready_files: 0, oldest_ready_seconds: 5 } },
      false,
      true,
    ],
    [
      "unknown-archive",
      { ...sample, archive: { ready_files: null, oldest_ready_seconds: null } },
      true,
    ],
    ["starting-above-awake", { ...sample, starting: 2 }, false, true],
    [
      "credentials-not-read-yet",
      { ...sample, credentials_revision: null },
      true,
    ],
    [
      "credentials-revision-zero",
      { ...sample, credentials_revision: 0 },
      false,
    ],
    [
      "no-credentials-revision",
      { ...sample, credentials_revision: undefined },
      false,
    ],
    ["no-volume-counts", { ...sample, volumes: undefined }, false],
  ],
  NodeVolumeReport: [
    [
      "volumes",
      {
        observed_at: now,
        volumes: [
          volume,
          { ...volume, database: other, mounted: false, filesystem: null },
        ],
      },
      true,
    ],
    [
      "unmounted-filesystem",
      { observed_at: now, volumes: [{ ...volume, mounted: false }] },
      false,
      true,
    ],
    [
      "duplicate-volume",
      { observed_at: now, volumes: [volume, volume] },
      false,
      true,
    ],
  ],
  NodeEventReport: [
    [
      "events",
      {
        events: [
          admission,
          wake,
          {
            type: "early_sleep",
            id: eventId("c"),
            at: now,
            database: other,
            generation: 2,
            for_database: id,
          },
          {
            ...admission,
            id: eventId("d"),
            start: "recovery",
            operation: null,
            decision: "admitted",
            reason: undefined,
            retry_after_seconds: undefined,
            waited_ms: 0,
          },
          {
            ...wake,
            id: eventId("e"),
            outcome: "refused",
            reason: "no_room",
            phases_ms: { admission: 1 },
          },
          {
            ...admission,
            id: eventId("f"),
            reason: "no_room",
            retry_after_seconds: undefined,
          },
        ],
      },
      true,
    ],
    ["empty", { events: [] }, false],
    ["event-without-id", { events: [{ ...wake, id: undefined }] }, false],
    ["event-id-not-a-uuid", { events: [{ ...wake, id: "wake-1" }] }, false],
    [
      "event-ids-twice",
      { events: [wake, { ...admission, id: wake.id }] },
      false,
      true,
    ],
    [
      "no-room-with-retry-hint",
      { events: [{ ...admission, reason: "no_room" }] },
      false,
      true,
    ],
    ["unknown-phase", { events: [{ ...wake, phases_ms: { boot: 1 } }] }, false],
    [
      "refused-without-reason",
      { events: [{ ...admission, reason: undefined }] },
      false,
      true,
    ],
    [
      "refused-without-retry-hint",
      { events: [{ ...admission, retry_after_seconds: undefined }] },
      false,
      true,
    ],
    [
      "admitted-with-reason",
      {
        events: [
          {
            ...admission,
            decision: "admitted",
            retry_after_seconds: undefined,
          },
        ],
      },
      false,
      true,
    ],
    [
      "admitted-with-retry-hint",
      { events: [{ ...admission, decision: "admitted", reason: undefined }] },
      false,
      true,
    ],
    [
      "refused-wake-without-reason",
      { events: [{ ...wake, outcome: "refused" }] },
      false,
      true,
    ],
    [
      "started-wake-with-reason",
      { events: [{ ...wake, reason: "no_room" }] },
      false,
      true,
    ],
    ["pool-hit", { events: [{ ...wake, outcome: "hit" }] }, false],
  ],
  NodeBootReport: [
    ["report", bootReport, true],
    [
      "no-earlier-boot-and-no-journal",
      { ...bootReport, previous_boot_id: null, entries: [] },
      true,
    ],
    [
      "message-of-2048-bytes",
      {
        ...bootReport,
        entries: [{ ...journalEntry, message: "\u00e9".repeat(1024) }],
      },
      true,
    ],
    [
      "message-of-2050-bytes",
      {
        ...bootReport,
        entries: [{ ...journalEntry, message: "\u00e9".repeat(1025) }],
      },
      false,
      true,
    ],
    [
      "priority-above-debug",
      { ...bootReport, entries: [{ ...journalEntry, priority: 8 }] },
      false,
    ],
    [
      "unit-not-a-name",
      { ...bootReport, entries: [{ ...journalEntry, unit: "" }] },
      false,
    ],
    [
      "entry-with-a-field-of-the-journal",
      { ...bootReport, entries: [{ ...journalEntry, _PID: "104" }] },
      false,
    ],
    ["boot-id-not-a-uuid", { ...bootReport, boot_id: "boot" }, false],
    [
      "no-previous-boot-id",
      { ...bootReport, previous_boot_id: undefined },
      false,
    ],
  ],
  NodeProbeResult: [
    ["journal", probeResult, true],
    ["text", textResult, true],
    [
      "failed",
      { ...textResult, status: "failed", text: "exit status: 5\n" },
      true,
    ],
    ["no-kind", { ...probeResult, kind: undefined }, false],
    ["boot-report", bootReport, false],
    ["unknown-probe", { ...probeResult, probe: "shell" }, false],
    ["unknown-status", { ...probeResult, status: "partial" }, false],
    [
      "entry-with-a-field-of-the-journal",
      { ...probeResult, entries: [{ ...journalEntry, _PID: "104" }] },
      false,
    ],
    [
      "message-of-2050-bytes",
      {
        ...probeResult,
        entries: [{ ...journalEntry, message: "\u00e9".repeat(1025) }],
      },
      false,
      true,
    ],
  ],
  NodeUsageReport: [
    ["usage", { rows: [usageRow] }, true],
    [
      "unknown-metrics",
      {
        rows: [
          {
            ...usageRow,
            awake_ms: null,
            ingress_bytes: null,
            egress_bytes: null,
            connections: null,
            connection_ms: null,
          },
        ],
      },
      true,
    ],
    [
      "adjacent-intervals",
      {
        rows: [
          usageRow,
          {
            ...usageRow,
            interval_start: usageRow.interval_end,
            interval_end: "2026-10-17T12:00:00.000Z",
          },
        ],
      },
      true,
    ],
    ["empty", { rows: [] }, false],
    ["negative-bytes", { rows: [{ ...usageRow, ingress_bytes: -1 }] }, false],
    ["named-gap", { rows: [{ ...usageRow, gaps: ["ingress_bytes"] }] }, false],
    [
      "interval-across-an-hour",
      { rows: [{ ...usageRow, interval_end: "2026-10-17T12:00:00.001Z" }] },
      false,
      true,
    ],
    [
      "empty-interval",
      { rows: [{ ...usageRow, interval_end: usageRow.interval_start }] },
      false,
      true,
    ],
    [
      "awake-above-interval",
      { rows: [{ ...usageRow, awake_ms: 900_001 }] },
      false,
      true,
    ],
    ["interval-twice", { rows: [usageRow, usageRow] }, false, true],
  ],
  NodeFencedResponse: [
    ["fenced", { error: "node_fenced" }, true],
    ["other-error", { error: "forbidden" }, false],
    ["detail", { error: "node_fenced", detail: "lost" }, false],
  ],
  AgentLinkMessage: [
    ["hello", hello, true],
    ["sample", { type: "sample", sample }, true],
    ["other-protocol", { ...hello, protocol: 2, release_id: null }, false],
    ["hello-without-os", { ...hello, os: undefined }, false],
    [
      "boot-id-not-a-uuid",
      { ...hello, os: { ...hello.os, boot_id: "boot" } },
      false,
    ],
  ],
  ServerLinkMessage: [
    ["welcome", { type: "welcome", protocol: 1 }, true],
    ["desired", { type: "desired" }, true],
    ["desired-ids", { type: "desired", ids: [id] }, true],
    ["desired-no-ids", { type: "desired", ids: [] }, false],
    ["apply", { type: "apply" }, false],
  ],
  InstallerProgress: [
    ["checkpoint", { checkpoint: "image_verified", detail: "" }, true],
    ["failed-step", { checkpoint: "failed", detail: "tools" }, true],
    ["unknown-checkpoint", { checkpoint: "booted", detail: "" }, false],
  ],
  FleetReleaseId: [
    ["release", "release-25", true],
    ["upper-case", "Release-25", false],
    ["path", "../release", false],
  ],
};

/** Every schema vector; generation fails when the contract disagrees with a stated result. */
export function nodeSchemaVectors() {
  return Object.entries(cases).flatMap(([schema, list]) =>
    list.map(([name, input, valid, refinement]) => {
      // JSON drops undefined fields, exactly as the wire does.
      const value: unknown = JSON.parse(JSON.stringify(input));
      const result =
        nodeSchemas[schema as keyof typeof nodeSchemas].safeParse(value);
      if (result.success !== valid)
        throw new Error(
          `${schema}/${name}: the contract says ${result.success}`,
        );
      return { schema, name, valid, refinement: refinement ?? false, value };
    }),
  );
}

/**
 * The digest of an installed package set (`packagesSha256`) beside the `dpkg-query` output the
 * node reads the set from: the same digest on both sides. dpkg lists by name; the digest sorts
 * whole lines, which orders `libc6-dev=` before `libc6=`. An `rc` line is a package that was
 * removed with its configuration kept, not an installed one. Debian keeps the previous kernel
 * after an update: of the kernel images the node counts only the running one, which the lock
 * holds alone.
 */
export async function packageVectors() {
  const installed = [
    ["bash", "5.2"],
    ["bsdutils", "1:2.41.5-0+deb13u1"],
    ["libc6", "2.41-1"],
    ["libc6-dev", "2.41-1"],
    ["linux-image-6.12.113+deb13-amd64", "6.12.113-1"],
    ["linux-image-amd64", "6.12.113-1"],
  ].map(([name, version]) => ({ name: name!, version: version! }));
  // dpkg-query lists the packages by name: `<status>\t<name>\t<version>`, the status abbreviated
  // to two letters and a space.
  const dpkg = (extra: [status: string, name: string, version: string]) =>
    [...installed.map(({ name, version }) => ["ii ", name, version]), extra]
      .sort((a, b) => (a[1]! < b[1]! ? -1 : 1))
      .map(([status, name, version]) => `${status}\t${name}\t${version}\n`)
      .join("");
  const sha256 = await packagesSha256(installed);
  return [
    {
      name: "removed-package",
      kernel_release: "6.12.113+deb13-amd64",
      dpkg: dpkg(["rc ", "oldpkg", "1.0-1"]),
      packages: installed,
      sha256,
    },
    {
      name: "previous-kernel-kept",
      kernel_release: "6.12.113+deb13-amd64",
      dpkg: dpkg(["ii ", "linux-image-6.12.111+deb13-amd64", "6.12.111-1"]),
      packages: installed,
      sha256,
    },
  ];
}

/** A fixed Ed25519 seed; never a node's key. */
const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PKCS8_ED25519 = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);
export async function nodeRequestVectors() {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from([...PKCS8_ED25519, ...SEED]),
    "Ed25519",
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (typeof jwk.x !== "string") throw new Error("no public key");
  const body =
    '{"observed_at":"2026-10-17T12:00:00.000Z","databases":[],"orders":[]}';
  return Promise.all(
    [
      { method: "POST", path: link.NODE_API_PATHS.observations, body },
      {
        method: "GET",
        path: `${link.NODE_API_PATHS.desired}?limit=200`,
        body: "",
      },
      { method: "GET", path: link.NODE_API_PATHS.link, body: "" },
    ].map(async (request) => {
      const claims = await link.nodeRequestClaims({
        node: node.id,
        uid: node.uid,
        method: request.method as "GET" | "POST",
        path: request.path,
        body: new TextEncoder().encode(request.body),
        now: 1_760_702_400_000,
      });
      return {
        seed: Array.from(SEED, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
        public_key: jwk.x,
        ...request,
        claims,
        token: await link.signNodeRequest(privateKey, claims),
      };
    }),
  );
}

/** Lines of the gateway channel, in the field order the Rust encoder writes. */
export function gatewayChannelVectors() {
  const writer = {
    socket: `/run/pgcf/${id}/.s.PGSQL.5432`,
    uid: 61_001,
    pid: 4242,
    instance: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c",
  };
  const entry = (mode: string, unit?: object, database = id) => ({
    database,
    generation: 3,
    operation,
    mode,
    route_revision: 7,
    ...(unit ? { writer: unit } : {}),
  });
  const result = { database: id, operation, generation: 4 };
  const request = {
    database: id,
    operation,
    generation: 4,
    route_revision: 7,
    role_revision_hash: "c".repeat(64),
    queued_at_ms: 1_760_702_400_000,
  };
  const agent: [string, unknown, boolean][] = [
    [
      "table",
      {
        type: "table",
        databases: [
          entry("running", writer),
          entry("sleeping", undefined, other),
        ],
      },
      true,
    ],
    ["empty-table", { type: "table", databases: [] }, true],
    ["quiesce", { type: "database", database: entry("quiesce", writer) }, true],
    ["retired", { type: "database", database: entry("retired") }, true],
    ["removed", { type: "removed", database: id }, true],
    [
      "refused",
      {
        type: "wake_result",
        result: {
          ...result,
          outcome: "refused",
          reason: "no_headroom",
          retry_after_seconds: 5,
        },
      },
      true,
    ],
    [
      "refused-no-room",
      {
        type: "wake_result",
        result: { ...result, outcome: "refused", reason: "no_room" },
      },
      true,
    ],
    [
      "refused-move-hold",
      {
        type: "wake_result",
        result: { ...result, outcome: "refused", reason: "moving" },
      },
      true,
    ],
    [
      "started",
      {
        type: "wake_result",
        result: {
          ...result,
          outcome: "started",
          steps_ms: { admission: 1, release: 1, start: 61 },
        },
      },
      true,
    ],
    [
      "started-without-steps",
      { type: "wake_result", result: { ...result, outcome: "started" } },
      true,
    ],
    [
      "begin",
      { type: "control", id: 9, action: "begin", database: id, generation: 3 },
      true,
    ],
    ["activity", { type: "activity", id: 10, database: id }, true],
    [
      "table-twice",
      {
        type: "table",
        databases: [entry("running", writer), entry("sleeping")],
      },
      false,
    ],
    [
      "running-without-writer",
      { type: "database", database: entry("running") },
      false,
    ],
    [
      "sleeping-with-writer",
      { type: "database", database: entry("sleeping", writer) },
      false,
    ],
    [
      "root-uid",
      { type: "database", database: entry("running", { ...writer, uid: 0 }) },
      false,
    ],
    [
      "pid-one",
      { type: "database", database: entry("running", { ...writer, pid: 1 }) },
      false,
    ],
    [
      "bare-instance",
      {
        type: "database",
        database: entry("running", {
          ...writer,
          instance: "0f6c2d8e5b7a4c1e9a3b2d4e6f8a0b1c",
        }),
      },
      false,
    ],
    [
      "relative-socket",
      {
        type: "database",
        database: entry("running", { ...writer, socket: "run/.s.PGSQL.5432" }),
      },
      false,
    ],
    [
      "parent-socket",
      {
        type: "database",
        database: entry("running", {
          ...writer,
          socket: "/run/pgcf/../etc/.s.PGSQL.5432",
        }),
      },
      false,
    ],
    [
      "long-socket",
      {
        type: "database",
        database: entry("running", {
          ...writer,
          socket: `/${"a".repeat(100)}`,
        }),
      },
      false,
    ],
    ["unknown-field", { type: "removed", database: id, extra: 1 }, false],
    ["unknown-type", { type: "stop", database: id }, false],
    [
      "started-with-reason",
      {
        type: "wake_result",
        result: { ...result, outcome: "started", reason: "no_room" },
      },
      false,
    ],
    [
      "refused-without-reason",
      { type: "wake_result", result: { ...result, outcome: "refused" } },
      false,
    ],
    [
      "no-headroom-without-retry-hint",
      {
        type: "wake_result",
        result: { ...result, outcome: "refused", reason: "no_headroom" },
      },
      false,
    ],
    [
      "no-room-with-retry-hint",
      {
        type: "wake_result",
        result: {
          ...result,
          outcome: "refused",
          reason: "no_room",
          retry_after_seconds: 5,
        },
      },
      false,
    ],
    [
      "started-with-retry-hint",
      {
        type: "wake_result",
        result: { ...result, outcome: "started", retry_after_seconds: 5 },
      },
      false,
    ],
    [
      "retry-hint-above-300",
      {
        type: "wake_result",
        result: {
          ...result,
          outcome: "refused",
          reason: "no_headroom",
          retry_after_seconds: 301,
        },
      },
      false,
    ],
    [
      "kubernetes-reason",
      {
        type: "wake_result",
        result: { ...result, outcome: "refused", reason: "thick_storage" },
      },
      false,
    ],
    [
      "pool-hit",
      { type: "wake_result", result: { ...result, outcome: "hit" } },
      false,
    ],
    [
      "pool-miss",
      {
        type: "wake_result",
        result: { ...result, outcome: "miss", reason: "no_room" },
      },
      false,
    ],
    [
      "unknown-reason",
      {
        type: "wake_result",
        result: { ...result, outcome: "refused", reason: "busy" },
      },
      false,
    ],
    [
      "step-name",
      {
        type: "wake_result",
        result: { ...result, outcome: "started", steps_ms: { Start: 1 } },
      },
      false,
    ],
    [
      "step-too-long",
      {
        type: "wake_result",
        result: { ...result, outcome: "started", steps_ms: { start: 600_001 } },
      },
      false,
    ],
    [
      "generation-zero",
      { type: "control", id: 9, action: "close", database: id, generation: 0 },
      false,
    ],
    [
      "unknown-action",
      { type: "control", id: 9, action: "stop", database: id, generation: 3 },
      false,
    ],
  ];
  const at = "2026-10-17T12:00:00.000Z",
    since = "2026-10-17T11:00:00.000Z";
  const report = {
    processEpoch: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c",
    epoch: "1a6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c",
    startedAt: since,
    counterStartedAt: since,
    observedAt: at,
    history: "complete",
    countersSince: since,
    ingressBytes: 10,
    egressBytes: 20,
    totalConnections: 3,
    connectionMilliseconds: 4000,
    connections: 2,
    authenticatedConnections: 1,
    busyConnections: 1,
    pendingDials: 1,
    lastActivityAt: "2026-10-17T11:59:00.000Z",
  };
  const unavailable = {
    ...report,
    history: "unavailable",
    countersSince: null,
    ingressBytes: null,
    egressBytes: null,
    totalConnections: null,
    connectionMilliseconds: null,
    lastActivityAt: null,
  };
  const absent = {
    ...report,
    history: "current_process_absence",
    ingressBytes: 0,
    egressBytes: 0,
    totalConnections: 0,
    connectionMilliseconds: 0,
    authenticatedConnections: 0,
    busyConnections: 0,
    lastActivityAt: null,
  };
  const activity = (value: unknown, requestId = 10) => ({
    type: "activity",
    id: requestId,
    database: id,
    report: value,
  });
  const gateway: [string, unknown, boolean][] = [
    ["wake", { type: "wake", wake: request }, true],
    [
      "status",
      {
        type: "status",
        id: 9,
        database: id,
        status: "idle",
        connections: 2,
        busy_connections: 0,
        pending_dials: 0,
      },
      true,
    ],
    ["activity", activity(report), true],
    ["activity-unavailable", activity(unavailable), true],
    ["activity-process-absence", activity(absent), true],
    [
      "activity-partial-history",
      activity({
        ...report,
        history: "partial",
        countersSince: "2026-10-17T11:30:00.000Z",
      }),
      true,
    ],
    [
      "activity-invented-keys",
      activity({ busyConnections: 0, connections: 1, lastActivityAt: now }),
      false,
    ],
    ["activity-with-region", activity({ ...report, region: region }), false],
    [
      "activity-with-pod",
      activity({ ...report, pod: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c" }),
      false,
    ],
    [
      "activity-without-last-activity",
      activity({ ...report, lastActivityAt: undefined }),
      false,
    ],
    ["activity-report-null", activity(null), false],
    ["activity-report-array", activity([1]), false],
    ["activity-report-text", activity("report"), false],
    ["activity-id-above-2-53", activity(report, 9_007_199_254_740_992), false],
    [
      "activity-busy-above-authenticated",
      activity({ ...report, busyConnections: 2 }),
      false,
    ],
    [
      "activity-unavailable-with-counters",
      activity({ ...unavailable, ingressBytes: 0 }),
      false,
    ],
    [
      "activity-before-counters",
      activity({ ...report, lastActivityAt: "2026-10-17T10:59:00.000Z" }),
      false,
    ],
    [
      "activity-absence-with-activity",
      activity({ ...absent, lastActivityAt: at }),
      false,
    ],
    [
      "upper-hash",
      {
        type: "wake",
        wake: { ...request, role_revision_hash: "C".repeat(64) },
      },
      false,
    ],
    [
      "generation-zero",
      { type: "wake", wake: { ...request, generation: 0 } },
      false,
    ],
    [
      "unknown-status",
      {
        type: "status",
        id: 9,
        database: id,
        status: "asleep",
        connections: 0,
        busy_connections: 0,
        pending_dials: 0,
      },
      false,
    ],
    [
      "status-id-above-2-53",
      {
        type: "status",
        id: 9_007_199_254_740_992,
        database: id,
        status: "idle",
        connections: 0,
        busy_connections: 0,
        pending_dials: 0,
      },
      false,
    ],
    ["unknown-type", { type: "release", database: id }, false],
  ];
  const check = (
    schema: typeof local.AgentMessage | typeof local.GatewayMessage,
    list: [string, unknown, boolean][],
  ) =>
    list.map(([name, message, valid]) => {
      if (schema.safeParse(message).success !== valid)
        throw new Error(`gateway channel ${name}: the contract disagrees`);
      return { name, line: JSON.stringify(message), valid };
    });
  return {
    agent: check(local.AgentMessage, agent),
    gateway: check(local.GatewayMessage, gateway),
  };
}

/** The DETAIL and HINT of the 57P03 that answers a refused wake, for every reason of a result. */
export function refusalVectors() {
  return local.WAKE_REASONS.map((reason) => {
    const retryAfterSeconds = local.refusalRetryHint(reason) ? 5 : undefined;
    return {
      reason,
      ...(retryAfterSeconds === undefined
        ? {}
        : { retry_after_seconds: retryAfterSeconds }),
      ...local.refusalFields(reason, retryAfterSeconds),
    };
  });
}

/** Lines of the archive socket, without their newline. */
export function archiveVectors() {
  const requests = [
    "pgcf-archive/1 archive 000000010000000000000003",
    "pgcf-archive/1 archive 00000002.history",
    "pgcf-archive/1 archive 000000010000000000000003.00000028.backup",
    "pgcf-archive/1 fetch 000000010000000000000003.partial pg_wal/RECOVERYXLOG",
    "pgcf-archive/1 fetch 00000002.history pg_wal/RECOVERYHISTORY",
    "pgcf-archive/1 archive 000000010000000000000003 extra",
    "pgcf-archive/2 archive 000000010000000000000003",
    "pgcf-archive/1 archive  000000010000000000000003",
    "pgcf-archive/1 archive 0000000a0000000000000003",
    "pgcf-archive/1 archive RECOVERYXLOG",
    "pgcf-archive/1 fetch 000000010000000000000003 base/1",
    "pgcf-archive/1 fetch 000000010000000000000003 pg_wal/../postgresql.conf",
    "pgcf-archive/1 fetch 000000010000000000000003 pg_wal/.hidden",
    "pgcf-archive/1 delete 000000010000000000000003",
    "",
  ].map((line) => {
    const request = local.parseArchiveRequest(line);
    return { line, valid: request !== null, ...(request ? { request } : {}) };
  });
  const replies = [
    "ok",
    "missing",
    "failed",
    "failed upload_timeout",
    "OK",
    "ok ",
    "failed ",
    "failed Access Denied",
    "",
  ].map((line) => {
    const reply = local.parseArchiveReply(line);
    return { line, valid: reply !== null, ...(reply ? { reply } : {}) };
  });
  const formats = [
    { type: "ok" as const },
    { type: "failed" as const, reason: "upload_timeout" },
    { type: "failed" as const, reason: "Access Denied\n" },
  ].map((reply) => ({ reply, line: local.formatArchiveReply(reply) }));
  return { requests, replies, formats };
}
