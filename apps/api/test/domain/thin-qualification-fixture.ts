// SPDX-License-Identifier: Apache-2.0
// A completed qualification run row for authority tests; never a live qualification result.
import { newOperationId, type ThinStorageProfile } from "@pgcf/contracts";
import type {
  FleetReleaseSpec,
  ThinStorageQualification,
} from "@pgcf/contracts/releases";
import {
  thinQualificationReceiptMaterial,
  thinStorageQualificationFromRun,
} from "@pgcf/contracts/thin-qualification";
import { thinQualificationFixture } from "../../../../packages/contracts/test/thin-qualification.fixture.ts";
import {
  canonicalInstallation,
  installationHash,
} from "../../src/domain/node-installation.ts";

/** Insert the qualified base release and its completed run; return the receipt that run yields. */
export async function insertCompletedThinQualification(
  db: D1Database,
  scope: {
    node_id: string;
    region_id: string;
    node_uid: string;
    release_id: string;
    spec: FleetReleaseSpec;
    profile: ThinStorageProfile;
    host_extension_image: string;
    kernel_version: string;
  },
): Promise<ThinStorageQualification> {
  const at = new Date().toISOString(),
    base = { ...scope.spec };
  delete base.thin_storage_qualification;
  const baseId = `${scope.release_id}-base`,
    baseSha = await installationHash(base),
    evidence = thinQualificationFixture(scope.profile, {
      node_uid: scope.node_uid,
      cluster_uid: crypto.randomUUID(),
      host_extension_image: scope.host_extension_image,
      kernel_version: scope.kernel_version,
      at,
    });
  const run = {
    id: newOperationId(),
    node_id: scope.node_id,
    region_id: scope.region_id,
    node_uid: scope.node_uid,
    release_id: baseId,
    spec_sha256: baseSha,
    profile: scope.profile,
    profile_sha256: await installationHash(scope.profile),
    driver_image: scope.profile.driver_image,
    host_extension_image: scope.host_extension_image,
    postgres_image:
      scope.spec.components.find((value) => value.name === "postgres")
        ?.reference ?? `registry.example/postgres@sha256:${"d".repeat(64)}`,
    kernel_version: scope.kernel_version,
    status: "completed" as const,
    setup: evidence.setup,
    gates: evidence.gates,
    cleanup: evidence.cleanup,
    qualified_at: at,
  };
  const receipt = await installationHash(thinQualificationReceiptMaterial(run));
  await db.batch([
    db
      .prepare(
        "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
      )
      .bind(baseId, canonicalInstallation(base), baseSha, at),
    db
      .prepare(
        `INSERT INTO thin_storage_qualification_runs(id,node_id,region_id,node_uid,cluster_uid,address,release_id,spec_sha256,assignment_revision,region_revision,material_revision,profile_json,profile_sha256,driver_image,host_extension_image,postgres_image,kernel_version,setup_json,gates_json,cleanup_json,step,status,receipt_sha256,qualified_at,created_at,updated_at,completed_at)
        VALUES(?,?,?,?,?,'192.0.2.18',?,?,1,1,1,?,?,?,?,?,?,?,?,?,'complete','completed',?,?,?,?,?)`,
      )
      .bind(
        run.id,
        run.node_id,
        run.region_id,
        run.node_uid,
        evidence.setup.identity.cluster_uid,
        run.release_id,
        run.spec_sha256,
        canonicalInstallation(run.profile),
        run.profile_sha256,
        run.driver_image,
        run.host_extension_image,
        run.postgres_image,
        run.kernel_version,
        JSON.stringify(run.setup),
        JSON.stringify(run.gates),
        JSON.stringify(run.cleanup),
        receipt,
        at,
        at,
        at,
        at,
      ),
  ]);
  return thinStorageQualificationFromRun({ ...run, receipt_sha256: receipt });
}
