// SPDX-License-Identifier: Apache-2.0
// The node agent consumes these exact Zod schemas, constants and configuration vectors.
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { format } from "prettier";
import {
  reclaimConfigurationInput,
  reclaimConfigurationFingerprint,
} from "../src/reclaim.ts";
import { UsageSample } from "../src/usage.ts";
import { FleetNodeReleaseObservation } from "../src/releases.ts";
import { gatewayActivityReportSchema } from "../src/gateway-activity.ts";
import {
  DesiredDatabase,
  DesiredResponse,
  DatabaseObservationUpdate,
  ObservationRequest,
  RegionalInventory,
  OWNER_ROLE_NAME,
  MAINTENANCE_ROLE,
  AgentActivityRequest,
  AgentUsageRequest,
} from "../src/index.ts";
import {
  ARCHIVE_FAILURE_MS,
  ARCHIVE_IDENTITY_QUERY,
  ARCHIVE_QUERY,
} from "../src/archive-health.ts";
const base = new URL("./", import.meta.url);
const schemas = Object.fromEntries(
  Object.entries({
    DesiredDatabase,
    DesiredResponse,
    DatabaseObservationUpdate,
    ObservationRequest,
    RegionalInventory,
    GatewayActivityReport: gatewayActivityReportSchema,
    AgentActivityRequest,
    AgentUsageRequest,
    UsageSample,
    FleetNodeReleaseObservation,
  }).map(([name, source]) => [name, z.toJSONSchema(source)]),
);
const ctx = {
  postgresImage: `registry.example/postgres:18.7@sha256:${"a".repeat(64)}`,
};
const db: z.infer<typeof DesiredDatabase> = {
  id: `d${"b".repeat(19)}`,
  generation: 1,
  desired_state: "running",
  node: "native-test-node",
  pg_major: 18,
  size: {
    memory_mib: 256,
    memory_request_mib: 128,
    cpu_millicores: 250,
    cpu_request_millicores: 25,
    storage_gib: 5,
    max_connections: 20,
    archive_timeout_seconds: 60,
    backup_retention_days: 7,
  },
  roles: [
    {
      name: "app",
      owner: true,
      password: "ppppppppppppppppppppppppppppppppppppppppppp",
      revision: 1,
    },
    {
      name: "reader_query",
      owner: false,
      password: "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
      revision: 2,
    },
  ],
  maintenance: {
    role: MAINTENANCE_ROLE,
    password: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
    revision: 1,
  },
  creation: {
    operation_id: `op_${"c".repeat(20)}`,
    generation: 1,
    status: "pending",
    ever_ready: false,
  },
  archive: {
    destination_path: `s3://native-controller-test/eu-test/d${"b".repeat(19)}/g1-op_${"c".repeat(20)}`,
    server_name: "database",
  },
};
const vectors = await Promise.all(
  [
    { name: "entry-request-limit-split", db, ctx },
    {
      name: "legacy-no-maintenance",
      db: {
        ...db,
        maintenance: undefined,
        size: {
          ...db.size,
          memory_mib: 512,
          cpu_millicores: 500,
          cpu_request_millicores: undefined,
          memory_request_mib: undefined,
        },
      },
      ctx,
    },
    {
      name: "selected-image",
      db: {
        ...db,
        postgres: {
          release_id: "release-18-7",
          image: `registry.example/postgres:18.7@sha256:${"e".repeat(64)}`,
          version: "18.7",
          configuration_schema_revision: 1 as const,
        },
      },
      ctx,
    },
    {
      name: "thin-runtime-storage",
      db: {
        ...db,
        storage: {
          backend: "lvm-thin-v1" as const,
          storage_class: `pgcf-lvm-thin-v1-${"f".repeat(16)}`,
          volume_attributes_class: `pgcf-lvm-thin-v1-${"f".repeat(16)}`,
          profile_revision: 1,
          profile_sha256: "f".repeat(64),
          node_uid: "01234567-89ab-4def-8123-012345678901",
          volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
          pool_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg",
          startup_reserve_bytes: 1048576,
          write_bytes_per_second: 1048576,
          write_iops_per_second: 10,
          guard_seconds: 15,
          drain_seconds: 10,
        },
      },
      ctx,
    },
    {
      name: "cross-region-restore",
      db: {
        ...db,
        creation: undefined,
        recovery: {
          operation_id: `op_${"c".repeat(20)}`,
          source_database_id: `s${"b".repeat(19)}`,
          source_archive_path: `s3://native-controller-source/us-test/s${"b".repeat(19)}/g1-op_${"d".repeat(20)}`,
          source_storage_generation: 1,
          source_archive: {
            region_id: "us-test",
            bucket: "native-controller-source",
            endpoint_url: "https://source.example.invalid",
            region: "auto" as const,
          },
          backup_id: "20261009T000000",
          target_time: "2026-10-09T00:00:01.000Z",
          status: "pending" as const,
          ever_ready: false,
        },
      },
      ctx,
    },
    {
      // Every attribute a role can carry: an expiry with milliseconds (the Cluster holds whole
      // seconds), a connection limit, a membership and BYPASSRLS.
      name: "role-attributes",
      db: {
        ...db,
        roles: [
          ...db.roles,
          {
            name: "report_job",
            owner: false,
            password: "s".repeat(43),
            revision: 3,
            valid_until: "2031-01-02T03:04:05.678Z",
            connection_limit: 5,
            member_of: ["reader_query"],
            bypass_rls: true as const,
          },
        ],
      },
      ctx,
    },
    {
      // A role follows the roles it is a member of; the rest keep their input order.
      name: "role-membership-order",
      db: {
        ...db,
        roles: [
          ...db.roles,
          {
            name: "leaf_job",
            owner: false,
            password: "t".repeat(43),
            revision: 1,
            member_of: ["mid_job"],
          },
          {
            name: "mid_job",
            owner: false,
            password: "u".repeat(43),
            revision: 1,
            member_of: ["base_job", "reader_query"],
          },
          {
            name: "other_job",
            owner: false,
            password: "v".repeat(43),
            revision: 1,
          },
          {
            name: "base_job",
            owner: false,
            password: "w".repeat(43),
            revision: 1,
          },
        ],
      },
      ctx,
    },
    {
      // A deleted role is named without a credential until PostgreSQL confirms its removal.
      name: "role-removal",
      db: {
        ...db,
        roles: [
          ...db.roles,
          { name: "report_job", state: "absent" as const },
          {
            name: "later_job",
            owner: false,
            password: "x".repeat(43),
            revision: 4,
          },
        ],
      },
      ctx,
    },
  ].map(async (v) => ({
    ...v,
    configuration_input: reclaimConfigurationInput(v.db, v.ctx.postgresImage),
    configuration_fingerprint: await reclaimConfigurationFingerprint(
      v.db,
      v.ctx.postgresImage,
    ),
  })),
);
const files = {
  "controller.generated.json": {
    version: 1,
    schemas,
    constants: {
      ARCHIVE_IDENTITY_QUERY,
      ARCHIVE_QUERY,
      ARCHIVE_FAILURE_MS,
      OWNER_ROLE_NAME,
      MAINTENANCE_ROLE,
    },
  },
  "controller-vectors.generated.json": vectors,
};
for (const [name, data] of Object.entries(files)) {
  const contents = await format(JSON.stringify(data), { parser: "json" }),
    path = new URL(name, base);
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== contents)
      throw new Error(`${name} is stale`);
  } else await writeFile(path, contents);
}
