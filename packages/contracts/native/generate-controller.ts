// SPDX-License-Identifier: Apache-2.0
// The native controller consumes these exact Zod schemas, constants and builder vectors.
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { format } from "prettier";
import {
  DatabaseRuntimeAttestation,
  reclaimConfigurationInput,
  reclaimConfigurationFingerprint,
} from "../src/reclaim.ts";
import { UsageSample } from "../src/usage.ts";
import {
  FleetReleaseFacts,
  FleetNodeReleaseObservation,
  fleetFluxReady,
  fleetChartObservation,
} from "../src/releases.ts";
import { STORAGE_AUTHORITY_LEDGER_KEY } from "../src/storage-write-authority.ts";
import {
  gatewayControlReportSchema,
  gatewayIntentSchema,
} from "../src/gateway-control.ts";
import { gatewayActivityReportSchema } from "../src/gateway-activity.ts";
import {
  DesiredDatabase,
  DesiredResponse,
  DatabaseObservation,
  ObservationRequest,
  ServerLinkMessage,
  SIDECAR,
  QUOTA_SLOTS,
  OWNER_ROLE_NAME,
  MAINTENANCE_ROLE,
  MAINTENANCE_BOOTSTRAP_SQL,
  AGENT_PROTOCOL_VERSION,
  CONFIGURATION_SCHEMA_REVISION,
  AgentActivityRequest,
  AgentUsageRequest,
  NodeThinStorageAuthority,
  ComputePoolPolicy,
} from "../src/index.ts";
import {
  ARCHIVE_IDENTITY_QUERY,
  ARCHIVE_QUERY,
} from "../../../apps/regional/src/agent/archive-probe.ts";
import {
  ARCHIVE_FAILURE_MS,
  WAL_BACKLOG_LIMIT,
} from "../../../apps/regional/src/agent/observe.ts";
import {
  buildDatabaseManifests,
  type BuildContext,
} from "../../../apps/regional/src/agent/builders/index.ts";
const base = new URL("./", import.meta.url);
const schemas = Object.fromEntries(
  Object.entries({
    DesiredDatabase,
    DesiredResponse,
    DatabaseObservation,
    ObservationRequest,
    ServerLinkMessage,
    GatewayControlReport: gatewayControlReportSchema,
    GatewayIntent: gatewayIntentSchema,
    GatewayActivityReport: gatewayActivityReportSchema,
    AgentActivityRequest,
    AgentUsageRequest,
    UsageSample,
    NodeThinStorageAuthority,
    ComputePoolPolicy,
    FleetReleaseFacts,
    FleetNodeReleaseObservation,
    DatabaseRuntimeAttestation,
  }).map(([name, source]) => [name, z.toJSONSchema(source)]),
);
const ctx: BuildContext = {
  backup: {
    bucket: "native-controller-test",
    endpointUrl: "https://backup.example.invalid",
    region: "auto",
    credentials: { accessKeyId: "unit-access", secretAccessKey: "unit-secret" },
  },
  postgresImage: `registry.example/postgres:18.7@sha256:${"a".repeat(64)}`,
  systemNamespace: "pgcf-system",
  cnpgNamespace: "cnpg-system",
  storageClass: "pgcf-lvm",
  gatewaySelector: {
    namespace: "pgcf-system",
    podLabels: { "app.kubernetes.io/name": "pgcf-gateway" },
  },
  agentSelector: {
    namespace: "pgcf-system",
    podLabels: { "app.kubernetes.io/name": "pgcf-agent" },
  },
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
      name: "assigned-sandbox-overhead",
      db,
      ctx: {
        ...ctx,
        computePool: {
          version: 1 as const,
          target_slots: 2,
          max_idle_cpu_millicores: 200,
          max_idle_memory_mib: 256,
          per_slot_cpu_millicores: 50,
          per_slot_memory_mib: 64,
          max_age_seconds: 60,
          profile: {
            release_id: "native-compute-test",
            image: `registry.example/runtime@sha256:${"a".repeat(64)}`,
            holder_sha256: "b".repeat(64),
            controller_sha256: "c".repeat(64),
            containerd_version: "2.3.6" as const,
            runc_version: "1.5.2" as const,
            architecture: "amd64" as const,
          },
        },
      },
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
    ...[false, true].map((finalized) => ({
      name: finalized
        ? "cross-region-restore-finalized"
        : "cross-region-restore-administration",
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
      ctx: {
        ...ctx,
        recoveryFinalized: finalized,
        recoverySource: {
          bucket: "native-controller-source",
          endpointUrl: "https://source.example.invalid",
          region: "auto" as const,
          credentials: {
            accessKeyId: "source-access",
            secretAccessKey: "source-secret",
          },
        },
      },
    })),
  ].map(async (v) => ({
    ...v,
    manifests: buildDatabaseManifests(v.db, v.ctx),
    configuration_input: reclaimConfigurationInput(v.db, v.ctx.postgresImage),
    configuration_fingerprint: await reclaimConfigurationFingerprint(
      v.db,
      v.ctx.postgresImage,
    ),
  })),
);
const chartPin = {
  name: "cnpg",
  kind: "chart" as const,
  reference: `oci://registry.example/cnpg@sha256:${"a".repeat(64)}`,
  version: "1.30.1",
  sha256: "a".repeat(64),
};
const fluxReady = {
  metadata: { generation: 1 },
  status: {
    observedGeneration: 1,
    conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
  },
};
const helm = {
  ...fluxReady,
  status: {
    ...fluxReady.status,
    history: [
      {
        chartVersion: "1.30.1",
        ociDigest: `sha256:${"a".repeat(64)}`,
        status: "deployed",
      },
    ],
  },
};
const source = {
  ...fluxReady,
  spec: {
    url: "oci://registry.example/cnpg",
    ref: { digest: `sha256:${"a".repeat(64)}` },
  },
  status: {
    ...fluxReady.status,
    artifact: { revision: `1.30.1@sha256:${"a".repeat(64)}` },
  },
};
const fleetVectors = [
  { name: "applied-oci", pin: chartPin, release: helm, source, chart: null },
  {
    name: "normalized-chart-version",
    pin: chartPin,
    release: {
      ...helm,
      status: {
        ...helm.status,
        history: [
          {
            ...helm.status.history[0],
            chartVersion: `1.30.1+${"a".repeat(64)}`,
          },
        ],
      },
    },
    source,
    chart: null,
  },
  {
    name: "source-revision-mismatch",
    pin: chartPin,
    release: helm,
    source: {
      ...source,
      status: {
        ...source.status,
        artifact: { revision: `sha256:${"b".repeat(64)}` },
      },
    },
    chart: null,
  },
  {
    name: "unobserved-generation",
    pin: chartPin,
    release: { ...helm, status: { ...helm.status, observedGeneration: 0 } },
    source,
    chart: null,
  },
  {
    name: "stalled-release",
    pin: chartPin,
    release: {
      ...helm,
      status: {
        ...helm.status,
        conditions: [
          ...helm.status.conditions,
          { type: "Stalled", status: "True", observedGeneration: 1 },
        ],
      },
    },
    source,
    chart: null,
  },
  {
    name: "applied-http-chart",
    pin: { ...chartPin, reference: "https://charts.example/cnpg" },
    release: helm,
    source: null,
    chart: {
      ...fluxReady,
      status: {
        ...fluxReady.status,
        artifact: { digest: `sha256:${"a".repeat(64)}` },
      },
    },
  },
].map((v) => ({
  ...v,
  ready: fleetFluxReady(v.release),
  observed: fleetChartObservation(v.pin, v.release, v.source, v.chart),
}));
const files = {
  "controller.generated.json": {
    version: 1,
    schemas,
    constants: {
      ARCHIVE_IDENTITY_QUERY,
      ARCHIVE_QUERY,
      ARCHIVE_FAILURE_MS,
      WAL_BACKLOG_LIMIT,
      SIDECAR,
      QUOTA_SLOTS,
      OWNER_ROLE_NAME,
      MAINTENANCE_ROLE,
      MAINTENANCE_BOOTSTRAP_SQL,
      STORAGE_AUTHORITY_LEDGER_KEY,
      AGENT_PROTOCOL_VERSION,
      CONFIGURATION_SCHEMA_REVISION,
    },
  },
  "controller-vectors.generated.json": vectors,
  "fleet-vectors.generated.json": fleetVectors,
};
for (const [name, data] of Object.entries(files)) {
  const contents = await format(JSON.stringify(data), { parser: "json" }),
    path = new URL(name, base);
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== contents)
      throw new Error(`${name} is stale`);
  } else await writeFile(path, contents);
}
