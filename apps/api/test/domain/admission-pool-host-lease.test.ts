// SPDX-License-Identifier: Apache-2.0
// Real control-plane metadata only; no live host/cgroup or mount proof is claimed.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { HostStorageLease } from "@pgcf/contracts/node-thin-storage";
import {
  claimedPostgresPoolFixture,
  servingPostgresPoolFixture,
} from "./postgres-pool-fixture.ts";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures, request } from "./fixtures.ts";
import { recordPostgresPoolIoAttestation } from "../../src/domain/postgres-pool.ts";
import { prepareThinStorageLease } from "../../src/domain/node-thin-storage-execution.ts";
async function measured(
  f: Awaited<ReturnType<typeof claimedPostgresPoolFixture>>,
) {
  const scope = f.binding.scope;
  if (scope.storage.backend !== "lvm-thin-v1")
    throw new Error("Thin fixture required");
  const profile = scope.storage.profile;
  await recordPostgresPoolIoAttestation(env, scope.binding_id, {
    v: 1,
    binding_id: scope.binding_id,
    scope_sha256: f.binding.scope_sha256,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    pool_namespace_uid: scope.pool_namespace_uid,
    pool_pod_uid: scope.pool_pod_uid,
    observed_at: Date.now(),
    device: {
      volume_group_uuid: scope.storage.volume_group_uuid,
      lv_uuid: scope.storage.lv_uuid,
      thin_id: scope.storage.thin_id,
      device_major: 253,
      device_minor: 1,
    },
    shared_pod_io: {
      pod_cgroup_inode: 11,
      device_major: 253,
      device_minor: 1,
      write_bytes_per_second: profile.write_bytes_per_second,
      write_iops_per_second: profile.write_iops_per_second,
      io_max_verified: true,
      all_writer_cgroups_descendants: true,
    },
    cgroups: scope.container_ids.map((container_id, i) => ({
      container_id,
      cgroup_inode: 100 + i,
      pid: 100 + i,
      start_ticks: 10,
      pid_namespace: 20,
      device_major: 253,
      device_minor: 1,
      write_bytes_per_second: profile.write_bytes_per_second,
      write_iops_per_second: profile.write_iops_per_second,
      io_max_verified: true,
    })),
  });
}
afterEach(async () => {
  await cleanupFixtures();
  await env.DB.prepare(
    "DELETE FROM postgres_pool_qualification_receipts WHERE candidate_release_id IN(SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(admissionFixtureReleases))
    .run();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
it("never substitutes the legacy CNPG drain permission for cleanup of an unresolved thin pool holder", async () => {
  const f = await servingPostgresPoolFixture({ thin: true });
  const response = await request(
    `/v1/databases/${f.id}/suspend`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(response.status).toBe(202);
  const stop = DatabaseWithOperation.parse(await response.json());
  const raw = JSON.parse(
    (await env.DB.prepare(
      "SELECT authority_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first<string>("authority_json"))!,
  );
  // Accepted local metadata exercises the old CNPG-only read's incorrect quiescence classification.
  for (const volume of raw.volumes)
    if (volume.database_id === f.id) {
      volume.generation = stop.database.generation;
      volume.quiesced = true;
      volume.io = [];
    }
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(raw), f.node)
    .run();
  const host = await request(
    `/agent/v1/nodes/${f.node}/storage-guard`,
    f.agent,
  );
  expect(host.status).toBe(200);
  const entry = HostStorageLease.parse(await host.json()).databases.find(
    (d) => d.database_id === f.id,
  )!;
  expect(entry.pool).toMatchObject({
    binding_id: f.binding.scope.binding_id,
    holder_generation: f.binding.scope.generation,
    state: "detaching",
  });
  expect(entry.drain).toBeNull();
  expect(entry.pool!.cleanup_authority).toBeNull();
});
it("delivers authoritative pool namespace, all writer CIDs and measured device to the slow Native identity lease", async () => {
  const f = await claimedPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
  await measured(f);
  await env.DB.prepare(
    "UPDATE nodes SET provider_instance_id='10001' WHERE id=?",
  )
    .bind(f.node)
    .run();
  const input = await prepareThinStorageLease(env, f.node, false);
  if (!input) throw new Error("Controlled qualified identity lease absent");
  const item = input!.lease.databases.find(
    (d) => d.id === f.id,
  )! as (typeof input.lease.databases)[number] & { pool?: unknown };
  expect(item.pool).toMatchObject({
    binding_id: f.binding.scope.binding_id,
    scope_sha256: f.binding.scope_sha256,
    holder_revision: f.binding.holder_revision,
    holder_generation: f.binding.scope.generation,
    holder_boot_id: f.binding.scope.boot_id,
    pool_namespace: "pgcf-pool",
    pool_namespace_uid: f.binding.scope.pool_namespace_uid,
    pool_pod_uid: f.binding.scope.pool_pod_uid,
    container_ids: f.binding.scope.container_ids,
    device: {
      lv_uuid: f.binding.scope.storage.lv_uuid,
      device_major: 253,
      device_minor: 1,
    },
  });
});
it("delivers exact thin holder custody and refuses legacy startup permission before measured pool device IO", async () => {
  const f = await claimedPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
  const response = await request(
    `/agent/v1/nodes/${f.node}/storage-guard`,
    f.agent,
  );
  expect(response.status).toBe(200);
  const lease = HostStorageLease.parse(await response.json()),
    entry = lease.databases.find((d) => d.database_id === f.id)!;
  expect(entry.pool).toMatchObject({
    binding_id: f.binding.scope.binding_id,
    scope_sha256: f.binding.scope_sha256,
    holder_revision: f.binding.holder_revision,
    holder_generation: f.binding.scope.generation,
    holder_boot_id: f.binding.scope.boot_id,
    pool_namespace: "pgcf-pool",
    pool_namespace_uid: f.binding.scope.pool_namespace_uid,
    pool_pod_uid: f.binding.scope.pool_pod_uid,
    container_ids: f.binding.scope.container_ids,
    device: null,
    cleanup_authority: null,
  });
  expect(entry.runtime_authority).toBeNull();
  expect(entry.startup_expires_at).toBeNull();
  expect(entry.startup_operation_id).toBeNull();
});
it("delivers the measured pool device and CF grant while retaining both real writer identities", async () => {
  const f = await claimedPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
  await measured(f);
  const lease = HostStorageLease.parse(
      await (
        await request(`/agent/v1/nodes/${f.node}/storage-guard`, f.agent)
      ).json(),
    ),
    entry = lease.databases.find((d) => d.database_id === f.id)!;
  expect(entry.pool!.device).toMatchObject({
    lv_uuid: f.binding.scope.storage.lv_uuid,
    device_major: 253,
    device_minor: 1,
  });
  expect(entry.pool!.container_ids).toHaveLength(2);
  expect(entry.runtime_authority?.startsWith("sa1.")).toBe(true);
  expect(entry.startup_expires_at).not.toBeNull();
  expect(entry.startup_operation_id).not.toBeNull();
  expect(entry.write_blocked).toBe(false);
});
it("a newly observed physical boot cannot reuse the old holder's startup or runtime grant", async () => {
  const f = await claimedPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
  await measured(f);
  const boot = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE node_thin_storage SET qualification_json=json_set(qualification_json,'$.boot_id',?) WHERE node_id=?",
    ).bind(boot, f.node),
    env.DB.prepare(
      "UPDATE fleet_node_release_observations SET facts_json=json_set(facts_json,'$.boot_id',?) WHERE node_id=?",
    ).bind(boot, f.node),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET observed_json=json_set(observed_json,'$.boot_id',?) WHERE node_id=?",
    ).bind(boot, f.node),
  ]);
  const response = await request(
    `/agent/v1/nodes/${f.node}/storage-guard`,
    f.agent,
  );
  expect(response.status).toBe(200);
  const lease = HostStorageLease.parse(await response.json()),
    entry = lease.databases.find((d) => d.database_id === f.id)!;
  expect(lease.boot_id).toBe(boot);
  expect(entry.pool!.holder_boot_id).toBe(f.binding.scope.boot_id);
  expect(entry.runtime_authority).toBeNull();
  expect(entry.startup_expires_at).toBeNull();
  expect(entry.write_blocked).toBe(true);
});
