// SPDX-License-Identifier: Apache-2.0
// These schemas and public structural fixtures bind the existing pq1 wire protocol.
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { z } from "zod";
import {
  POOL_QUALIFICATION_PERMISSION,
  POSTGRES_POOL_QUALIFICATION_GATES,
  PoolQualificationClaims,
  PostgresPoolQualificationScope,
  PostgresPoolQualificationChallenge,
  PostgresPoolQualificationExecution,
  PostgresPoolQualificationReport,
  PostgresPoolQualificationMeasurement,
  PostgresPoolQualificationEvidence,
  PostgresPoolQualificationInput,
  PostgresPoolQualificationRun,
  PostgresPoolQualificationProgress,
  PostgresPoolQualificationProgressReport,
  PostgresPoolQualificationProgressEvidence,
  postgresPoolQualificationScopeHash,
  postgresPoolQualificationProgressHash,
  postgresPoolQualificationNonceHash,
} from "../src/postgres-pool-qualification.ts";
import { qualificationScopeFixture } from "../test/postgres-pool-qualification.fixture.ts";
const scope = PostgresPoolQualificationScope.parse(qualificationScopeFixture()),
  scopeHash = await postgresPoolQualificationScopeHash(scope),
  claims = PoolQualificationClaims.parse({
    v: 1,
    kid: "native-test",
    scope,
    scope_sha256: scopeHash,
    challenge: {
      run_id: scope.run_id,
      scope_sha256: scopeHash,
      sequence: 1,
      nonce: "a".repeat(32),
      producer: "node_agent",
      gate: "host_mount_context",
      issued_at: 1000,
      expires_at: 61000,
    },
    execution: {
      node_uid: scope.node_uid,
      boot_id: scope.boot_id,
      candidate_release_id: scope.candidate_release_id,
      candidate_spec_sha256: scope.candidate_spec_sha256,
      verifier_keys_sha256: "9".repeat(64),
      driver_pod_uid: "00000000-0000-4000-8000-000000000099",
      driver_image: scope.software.driver_image,
      driver_sha256: scope.software.driver_sha256,
      host_extension_image: scope.software.host_extension_image,
      host_controller_sha256: scope.software.host_controller_sha256,
      kernel_version: scope.software.kernel_version,
    },
    preparation_sha256: null,
    progress_sha256: await postgresPoolQualificationProgressHash([]),
    iat: 1000,
    exp: 31000,
  });
const progress = [
  PostgresPoolQualificationProgressEvidence.parse({
    sequence: 2,
    producer: "node_agent",
    issued_at: 1000,
    started_at: 1001,
    observed_at: 1002,
    received_at: 1003,
    nonce_sha256: await postgresPoolQualificationNonceHash("a".repeat(32)),
    execution: claims.execution,
    progress: {
      gate: "finite_creator_fence",
      phase: "node_fence_ready",
      source_generation: scope.database_generation - 1,
      volume_handle: scope.volume.volume_handle,
      driver_sha256: scope.software.driver_sha256,
      deny_record_inode: 9_007_199_254_740_991,
      deny_record_sha256: "a".repeat(64),
      deny_record_scope_sha256: scopeHash,
      deny_record_fsync_errno: 0,
      agent_owner_deaths: 1,
      before_claim_requests_completed: 1,
      surviving_creation_descriptors: 0,
      dm_open_count: 0,
      foreign_mounts: 0,
      named_namespace_scan_errno: 0,
    },
  }),
  PostgresPoolQualificationProgressEvidence.parse({
    sequence: 2,
    producer: "controller",
    issued_at: 1000,
    started_at: 1004,
    observed_at: 1005,
    received_at: 1006,
    nonce_sha256: await postgresPoolQualificationNonceHash("a".repeat(32)),
    execution: claims.execution,
    progress: {
      gate: "finite_creator_fence",
      phase: "driver_delete_intent",
      driver_pod_uid: claims.execution.driver_pod_uid,
      driver_pod_name: "driver-known",
      driver_pod_resource_version: "0012",
      driver_namespace: "openebs",
      driver_daemonset_uid: "00000000-0000-4000-8000-000000000098",
      driver_image: scope.software.driver_image,
    },
  }),
];
const document = {
  constants: { ...POOL_QUALIFICATION_PERMISSION, clock_skew_ms: 5000 },
  gates: POSTGRES_POOL_QUALIFICATION_GATES,
  schemas: Object.fromEntries(
    Object.entries({
      PoolQualificationClaims,
      PostgresPoolQualificationScope,
      PostgresPoolQualificationChallenge,
      PostgresPoolQualificationExecution,
      PostgresPoolQualificationReport,
      PostgresPoolQualificationMeasurement,
      PostgresPoolQualificationEvidence,
      PostgresPoolQualificationInput,
      PostgresPoolQualificationRun,
      PostgresPoolQualificationProgress,
      PostgresPoolQualificationProgressReport,
      PostgresPoolQualificationProgressEvidence,
    }).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
  ),
  fixture: {
    claims,
    progress,
    progress_sha256: await postgresPoolQualificationProgressHash(progress),
  },
};
const path = new URL("qualification.generated.json", import.meta.url),
  bytes = await format(JSON.stringify(document), { parser: "json" });
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== bytes)
    throw Error("Regenerate qualification.generated.json");
} else await writeFile(path, bytes);
