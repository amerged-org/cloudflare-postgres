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
  postgresPoolQualificationScopeHash,
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
    iat: 1000,
    exp: 31000,
  });
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
    }).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
  ),
  fixture: { claims },
};
const path = new URL("qualification.generated.json", import.meta.url),
  bytes = await format(JSON.stringify(document), { parser: "json" });
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== bytes)
    throw Error("Regenerate qualification.generated.json");
} else await writeFile(path, bytes);
