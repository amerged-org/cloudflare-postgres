// SPDX-License-Identifier: Apache-2.0
// The native controller consumes these exact Zod schemas, constants and builder vectors.
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { format } from "prettier";
import {
  DatabaseRuntimeAttestation,
  DATABASE_RUNTIME_PROOF_MAX_AGE_MS,
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
  NodeStorageHeadroomResponse,
  NodeStorageHeadroomSample,
  ThinStorageSampleTarget,
} from "../src/node-thin-storage.ts";
import {
  gatewayControlReportSchema,
  gatewayIntentSchema,
} from "../src/gateway-control.ts";
import { gatewayActivityReportSchema } from "../src/gateway-activity.ts";
import {
  DesiredDatabase,
  DesiredResponse,
  DatabaseObservation,
  DatabaseObservationUpdate,
  ObservationRequest,
  RegionalInventory,
  ServerLinkMessage,
  SIDECAR,
  QUOTA_SLOTS,
  OWNER_ROLE_NAME,
  MAINTENANCE_ROLE,
  MAINTENANCE_BOOTSTRAP_SQL,
  AGENT_PROTOCOL_VERSION,
  LINK_MESSAGE_MAX_BYTES,
  CONFIGURATION_SCHEMA_REVISION,
  AgentActivityRequest,
  AgentUsageRequest,
  NodeThinStorageAuthority,
  ComputePoolPolicy,
  NodeStorageSample,
  THIN_INVENTORY_MAX_SECONDS,
} from "../src/index.ts";
import lock from "../../../infra/platform/versions.lock.json" with { type: "json" };
import { openEbsDriverImage } from "../../../infra/platform/openebs-image.ts";
import { physicalStorageMetrics } from "../../../apps/regional/src/agent/node-storage.ts";
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
    DatabaseObservationUpdate,
    ObservationRequest,
    RegionalInventory,
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
    NodeStorageSample,
    NodeStorageHeadroomSample,
    NodeStorageHeadroomResponse,
    ThinStorageSampleTarget,
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
    ...[false, true].map((dropping) => ({
      // A deleted role is disabled first and dropped once the Cluster names it; it has no Secret.
      name: dropping ? "role-removal-drop" : "role-removal-disable",
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
      ctx: dropping ? { ...ctx, droppingRoles: ["report_job"] } : ctx,
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
// OpenEBS LocalPV LVM exporter scrapes; the native sampler must derive the same physical facts.
const vg = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef";
// vgs counts every visible LV of the group; the exporter's LV series must number the same.
const volumeGroup = (free = 7000, lvs = 0) =>
  [
    `lvm_vg_total_size_bytes{name="pgcf"} 1e4`,
    `lvm_vg_free_size_bytes{name="pgcf"} ${free}`,
    `lvm_vg_permission{name="pgcf"} 0`,
    `lvm_vg_missing_pv_count{name="pgcf"} 0`,
    `lvm_vg_pv_count{name="pgcf"} 1`,
    `lvm_vg_lv_count{name="pgcf"} ${lvs}`,
  ].join("\n") + "\n";
const volume = (
  name: string,
  segtype: string,
  size: number | string,
  pool = "",
  gauges: Record<string, number | string> = {},
) =>
  Object.entries({
    lvm_lv_total_size_bytes: size,
    lvm_lv_health_status: 0,
    lvm_lv_permission: 1,
    ...gauges,
  })
    .map(
      ([metric, value]) =>
        `${metric}{active_status="active",device="dm-0",dm_path="/dev/mapper/pgcf-${name.replaceAll("-", "--")}",host="driver",name="${name}",path="/dev/pgcf/${name}",pool="${pool}",segtype="${segtype}",vg="pgcf"} ${value}\n`,
    )
    .join("");
const thinPool = (gauges: Record<string, number | string> = {}) =>
  volume("pgcf_thinpool", "thin-pool", 4000, "", {
    lvm_lv_mda_total_size_bytes: 10,
    lvm_lv_used_percent: 25,
    lvm_lv_mda_used_percent: 20,
    lvm_lv_when_full: 0,
    ...gauges,
  });
const thick =
  volumeGroup(7000, 1) +
  volume("pvc-a", "linear", 3000, "", { lvm_lv_used_percent: 0 });
// Run 12's lvs metadata reports the primary pool with lv_path="" and its mapper path.
const observedPool = thinPool().replaceAll(
  'path="/dev/pgcf/pgcf_thinpool"',
  'path=""',
);
const scratchPool = volume("scratch-pool", "thin-pool", 1000).replaceAll(
  'path="/dev/pgcf/scratch-pool"',
  'path=""',
);
const inactiveRaw = volume("scratch_raw", "linear", 1000)
  .replaceAll('active_status="active"', 'active_status="inactive"')
  .replaceAll('path="/dev/pgcf/scratch_raw"', 'path=""')
  .replaceAll('dm_path="/dev/mapper/pgcf-scratch_raw"', 'dm_path=""');
const qualificationInventory =
  volumeGroup(2990, 3) + observedPool + scratchPool + inactiveRaw;
const storageVectors = [
  {
    name: "thick-volume-group",
    metrics: `# HELP go_goroutines Number of goroutines.\n# TYPE go_goroutines gauge\ngo_goroutines 12\n${thick}`,
  },
  {
    name: "duplicate-volume-group-gauge",
    metrics: thick + 'lvm_vg_total_size_bytes{name="pgcf"} 10000\n',
  },
  {
    name: "read-only-volume-group",
    metrics: thick.replace(
      'lvm_vg_permission{name="pgcf"} 0',
      'lvm_vg_permission{name="pgcf"} 1',
    ),
  },
  {
    name: "thin-pool-upper-bounds",
    metrics:
      volumeGroup(5990, 2) +
      thinPool() +
      volume("pvc-thin", "thin", 2000, "pgcf_thinpool"),
  },
  {
    name: "rounded-percent-charges-next-hundredth",
    metrics: volumeGroup(5990, 1) + thinPool({ lvm_lv_used_percent: 33.33 }),
  },
  {
    name: "missing-thin-metadata-gauge",
    metrics:
      volumeGroup(5990, 1) +
      thinPool().replace(/^lvm_lv_mda_used_percent\{.*\n/m, ""),
  },
  {
    name: "non-finite-percent",
    metrics: volumeGroup(5990, 1) + thinPool({ lvm_lv_used_percent: "NaN" }),
  },
  {
    name: "thin-volume-without-pool",
    metrics:
      volumeGroup(7000, 1) + volume("pvc-thin", "thin", 2000, "pgcf_thinpool"),
  },
  {
    name: "unhealthy-volume",
    metrics:
      volumeGroup(7000, 1) +
      volume("pvc-a", "linear", 3000, "", { lvm_lv_health_status: 1 }),
  },
  {
    name: "escaped-labels-trailing-comma-and-crlf",
    metrics: (
      thick.replace('{name="pgcf"} 1e4', '{name="pgcf",} 1.0e4') +
      'lvm_lv_total_size_bytes{host="a\\"b\\\\c\\nd",name="other",vg="other"} 5\n'
    ).replaceAll("\n", "\r\n"),
  },
  {
    name: "allocation-exceeds-volume-group",
    metrics: volumeGroup(12000),
  },
  {
    // OpenEBS drops every LV series when one LV path does not resolve; vgs still counts them.
    name: "lv-series-missing",
    metrics: volumeGroup(5990, 2),
  },
  {
    name: "primary-pool-truthful-blank-path",
    metrics: volumeGroup(5990, 1) + observedPool,
  },
  {
    name: "primary-pool-foreign-mapper",
    metrics: (volumeGroup(5990, 1) + observedPool).replaceAll(
      'dm_path="/dev/mapper/pgcf-pgcf_thinpool"',
      'dm_path="/dev/mapper/other-pgcf_thinpool"',
    ),
  },
  {
    name: "scratch-inventory-refused-for-product",
    metrics: qualificationInventory,
  },
  {
    name: "qualification-scratch-pools-and-inactive-raw",
    qualification: true,
    metrics: qualificationInventory,
  },
  {
    name: "qualification-inventory-still-complete",
    qualification: true,
    metrics: qualificationInventory.replace(
      'lvm_vg_lv_count{name="pgcf"} 3',
      'lvm_vg_lv_count{name="pgcf"} 4',
    ),
  },
  {
    name: "qualification-primary-usage-still-required",
    qualification: true,
    metrics: qualificationInventory.replace(/^lvm_lv_used_percent.*\n/m, ""),
  },
  {
    name: "qualification-scratch-allocation-exceeds-vg",
    qualification: true,
    metrics: qualificationInventory.replace(
      'lvm_vg_free_size_bytes{name="pgcf"} 2990',
      'lvm_vg_free_size_bytes{name="pgcf"} 5990',
    ),
  },
].map((v) => ({
  ...v,
  volume_group_uuid: vg,
  physical: physicalStorageMetrics(
    v.metrics,
    vg,
    "qualification" in v && v.qualification ? "qualification" : "product",
  ),
}));
const files = {
  "controller.generated.json": {
    version: 1,
    schemas,
    constants: {
      DATABASE_RUNTIME_PROOF_MAX_AGE_MS,
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
      THIN_INVENTORY_MAX_SECONDS,
      AGENT_PROTOCOL_VERSION,
      LINK_MESSAGE_MAX_BYTES,
      CONFIGURATION_SCHEMA_REVISION,
      OPENEBS_DRIVER_IMAGE: openEbsDriverImage(lock),
    },
  },
  "controller-vectors.generated.json": vectors,
  "fleet-vectors.generated.json": fleetVectors,
  "node-storage-vectors.generated.json": storageVectors,
};
for (const [name, data] of Object.entries(files)) {
  const contents = await format(JSON.stringify(data), { parser: "json" }),
    path = new URL(name, base);
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== contents)
      throw new Error(`${name} is stale`);
  } else await writeFile(path, contents);
}
