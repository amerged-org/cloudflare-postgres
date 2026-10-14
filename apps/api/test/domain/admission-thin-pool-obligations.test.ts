// SPDX-License-Identifier: Apache-2.0
// Actual D1/DO ownership metadata; no host mount or Dev qualification is claimed.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  DatabaseWithOperation,
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
} from "@pgcf/contracts";
import {
  PoolBindingScope,
  poolBindingScopeHash,
} from "@pgcf/contracts/postgres-pool";
import { claimedPostgresPoolFixture } from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import { identityProof, gib } from "./thin-renewal-fixture.ts";
import { cleanupFixtures } from "./fixtures.ts";
import { prepareThinStorageLease } from "../../src/domain/node-thin-storage-execution.ts";
const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  await env.DB.prepare(
    "DELETE FROM postgres_pool_qualification_receipts WHERE candidate_release_id IN(SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(admissionFixtureReleases))
    .run();
  for (const id of [
    ...releases.splice(0),
    ...admissionFixtureReleases.splice(0),
  ])
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
it("keeps a deleted database's nonterminal thin pool holder in read-only identity recovery without creating a replacement pool", async () => {
  const model = await claimedPostgresPoolFixture({ thin: true }),
    f = await thinExecutionFixture(releases);
  await identityProof(f, {
    physical: {
      ...f.authority.physical,
      free_bytes: 80 * gib,
      thin_pool: {
        ...f.authority.physical.thin_pool!,
        data_total_bytes: 16 * gib,
      },
    },
  });
  const created = DatabaseWithOperation.parse(
    await (await f.create()).json(),
  ).database;
  expect(created.node_id).toBe(f.node);
  const currentProfile = DesiredDatabaseStorage.parse(
    JSON.parse(
      (await env.DB.prepare(
        "SELECT storage_profile_json FROM databases WHERE id=?",
      )
        .bind(created.id)
        .first<string>("storage_profile_json"))!,
    ),
  );
  const source = model.binding.scope.storage;
  if (source.backend !== "lvm-thin-v1")
    throw new Error("Thin fixture required");
  const scope = PoolBindingScope.parse({
    ...model.binding.scope,
    binding_id: crypto.randomUUID(),
    database_id: created.id,
    generation: created.generation,
    node_id: f.node,
    node_uid: f.uid,
    region_id: f.region,
    boot_id: f.qualified.bootId,
    pool_pod_uid: crypto.randomUUID(),
    storage: {
      ...source,
      cnpg_cluster_uid: f.authority.cluster_uid,
      volume_group_uuid: f.authority.volume_group_uuid,
      profile: currentProfile,
    },
  });
  const receipt = DatabaseStorageVolumeReceipt.parse({
    storage_generation: source.storage_generation,
    storage_uid: source.storage_uid,
    namespace_uid: source.namespace_uid,
    cluster_uid: f.authority.cluster_uid,
    node_uid: f.uid,
    volume_group_uuid: f.authority.volume_group_uuid,
    pool_uuid: f.authority.pool_uuid,
    volume_handle: source.volume_handle,
    lv_uuid: source.lv_uuid,
    pvc_uid: source.pvc_uid,
    pv_uid: source.pv_uid,
  });
  const now = Date.now(),
    hash = await poolBindingScopeHash(scope);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO pool_pods(pod_uid,node_id,node_uid,boot_id,policy_revision,attestation_json,state,binding_id,first_observed_at,last_observed_at) VALUES(?,?,?,?,1,?,'claimed',?,?,?)",
    ).bind(
      scope.pool_pod_uid,
      f.node,
      f.uid,
      scope.boot_id,
      JSON.stringify({ ...model.pod, pod_uid: scope.pool_pod_uid }),
      scope.binding_id,
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO pool_bindings(id,database_id,node_id,node_uid,boot_id,pool_pod_uid,generation,route_revision,admission_epoch,holder_revision,scope_sha256,scope_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,'lost',?,?)",
    ).bind(
      scope.binding_id,
      created.id,
      f.node,
      f.uid,
      scope.boot_id,
      scope.pool_pod_uid,
      scope.generation,
      scope.route_revision,
      scope.admission_epoch,
      hash,
      JSON.stringify(scope),
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO database_runtime_holders(database_id,kind,revision,binding_id,state,updated_at) VALUES(?,'pool',1,?,'lost',?)",
    ).bind(created.id, scope.binding_id, now),
    env.DB.prepare(
      "UPDATE databases SET desired_state='deleted',deleted_at=?,generation=generation+1,observed_generation=generation+1,observed_state='deleted',storage_volume_json=? WHERE id=?",
    ).bind(new Date(now).toISOString(), JSON.stringify(receipt), created.id),
    env.DB.prepare(
      "DELETE FROM database_start_admissions WHERE database_id=?",
    ).bind(created.id),
  ]);
  await identityProof(f, {
    pool_uuid: null,
    write_allowed: false,
    physical: { ...f.authority.physical, thin_pool: null },
    physical_lvs: [],
    active_lv_uuids: [],
    volumes: [],
  });
  const input = await prepareThinStorageLease(f.local, f.node);
  expect(input).not.toBeNull();
  expect(input!.lease.action).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT action_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first("action_json"),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT state FROM pool_bindings WHERE id=?")
      .bind(scope.binding_id)
      .first("state"),
  ).toBe("lost");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) FROM database_start_admissions WHERE database_id=?",
    )
      .bind(created.id)
      .first("COUNT(*)"),
  ).toBe(0);
});
