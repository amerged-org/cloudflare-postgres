// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { DatabaseRuntimeAttestation } from "../src/reclaim.ts";
import {
  DatabaseAdmissionIntent,
  GatewayAdmissionTarget,
} from "../src/database-admission.ts";
const uid = "01234567-89ab-4def-8123-0123456789ab";
const hash = "a".repeat(64);
const proof = {
  v: 2,
  database_id: "a".repeat(20),
  region_id: "eu-test",
  generation: 7,
  storage_generation: 3,
  node_uid: uid,
  boot_id: uid,
  cluster_uid: uid,
  namespace_uid: uid,
  cnpg_cluster_uid: uid,
  storage_uid: uid,
  pvc_uid: uid,
  pv_uid: uid,
  pod_uid: uid,
  container_id: hash,
  postgres_image_sha256: hash,
  memory_request_bytes: 128,
  memory_limit_bytes: 256,
  observed_at: 1000,
  configuration_fingerprint: hash,
  route_revision: 19,
  admission_epoch: 11,
  applied_role_revisions: [{ name: "app", revision: 4 }],
  tls_server_name: "database-rw.pgcf-db-aaaaaaaaaaaaaaaaaaaa.svc",
  ca_secret_uid: uid,
  ca_secret_resource_version: "81",
  ca_sha256: hash,
  pod_ip: "10.0.0.7",
  postgres_port: 5432,
  observation: {
    v: 1,
    controller_epoch: hash,
    watch_epoch: 1,
    coverage: "complete",
    verified_at: 1000,
    expires_at: 61000,
    resource_versions: {
      namespace: "1",
      cluster: "2",
      pod: "3",
      ca_secret: "81",
      storage: "5",
      pvc: "6",
      pv: "7",
      node: "8",
    },
  },
};
it("requires separate admission, CA, role and actual continuity identities in a v2 runtime proof", () => {
  expect(DatabaseRuntimeAttestation.parse(proof)).toEqual(proof);
  for (const field of [
    "ca_secret_uid",
    "ca_secret_resource_version",
    "ca_sha256",
    "observation",
    "route_revision",
    "admission_epoch",
    "applied_role_revisions",
  ]) {
    const missing = { ...proof } as Record<string, unknown>;
    delete missing[field];
    expect(DatabaseRuntimeAttestation.safeParse(missing).success).toBe(false);
  }
  expect(
    DatabaseRuntimeAttestation.safeParse({
      ...proof,
      applied_role_revisions: [
        ...proof.applied_role_revisions,
        ...proof.applied_role_revisions,
      ],
    }).success,
  ).toBe(false);
  expect(
    DatabaseRuntimeAttestation.safeParse({
      ...proof,
      observation: { ...proof.observation, verified_at: 1001 },
    }).success,
  ).toBe(false);
  expect(
    DatabaseRuntimeAttestation.safeParse({ ...proof, pod_ip: "not-an-ip" })
      .success,
  ).toBe(false);
});
it("admission revisions remain independent from configuration and physical generations", () => {
  expect(
    DatabaseAdmissionIntent.parse({
      v: 1,
      route_revision: 19,
      admission_epoch: 11,
    }),
  ).toEqual({ v: 1, route_revision: 19, admission_epoch: 11 });
  expect(
    GatewayAdmissionTarget.safeParse({
      v: 1,
      generation: 7,
      route_revision: 19,
      admission_epoch: 11,
      pod_uid: uid,
      container_id: hash,
      ca_secret_uid: uid,
      ca_secret_resource_version: "81",
      ca_sha256: hash,
      tls_server_name: proof.tls_server_name,
    }).success,
  ).toBe(true);
  expect(
    DatabaseAdmissionIntent.safeParse({ v: 1, admission_epoch: 11 }).success,
  ).toBe(false);
});
