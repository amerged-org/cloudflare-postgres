// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  DatabaseStorageVolumeReceipt,
  DatabaseWithOperation,
  DesiredResponse,
  StorageWriteClaims,
  base64urlToBytes,
  thinStorageClass,
} from "@pgcf/contracts";
import {
  cleanupFixtures,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  type Fixture,
  gib,
  identityProof,
  lvs,
  mib,
} from "./thin-renewal-fixture.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
/** A new thin database on its startup hold, whose receipt the last identity proof bound. */
async function heldWriter(f: Fixture) {
  const physical = {
    ...f.authority.physical,
    free_bytes: 80 * gib,
    thin_pool: {
      ...f.authority.physical.thin_pool!,
      data_total_bytes: 16 * gib,
    },
  };
  await identityProof(f, { physical });
  const created = DatabaseWithOperation.parse(
    await (await f.create()).json(),
  ).database;
  const receipt = DatabaseStorageVolumeReceipt.parse({
    storage_generation: 1,
    storage_uid: crypto.randomUUID(),
    namespace_uid: crypto.randomUUID(),
    cluster_uid: crypto.randomUUID(),
    node_uid: f.uid,
    volume_group_uuid: f.authority.volume_group_uuid,
    pool_uuid: f.authority.pool_uuid,
    volume_handle: `pvc-${crypto.randomUUID()}`,
    lv_uuid: "VOLUMX-1234-1234-1234-1234-1234-ABCDEF",
    pvc_uid: crypto.randomUUID(),
    pv_uid: crypto.randomUUID(),
  });
  await env.DB.prepare(
    "UPDATE databases SET storage_volume_json=? WHERE id=? AND node_id=?",
  )
    .bind(JSON.stringify(receipt), created.id, f.node)
    .run();
  // The proof read the LV, but not yet any IO limit of the Pod that now starts on it.
  await identityProof(f, {
    physical,
    physical_lvs: [
      lvs.pool,
      lvs.data,
      lvs.meta,
      {
        name: receipt.volume_handle,
        lv_uuid: receipt.lv_uuid,
        size_bytes: 5 * gib,
        segtype: "thin",
      },
    ],
    active_lv_uuids: [receipt.lv_uuid],
    volumes: [
      {
        database_id: created.id,
        generation: created.generation,
        storage_generation: 1,
        storage_uid: receipt.storage_uid,
        namespace_uid: receipt.namespace_uid,
        cluster_uid: receipt.cluster_uid,
        volume_handle: receipt.volume_handle,
        lv_uuid: receipt.lv_uuid,
        pvc_uid: receipt.pvc_uid,
        pv_uid: receipt.pv_uid,
        storage_class: thinStorageClass(f.authority.profile_sha256),
        volume_attributes_class: thinStorageClass(f.authority.profile_sha256),
        io: [],
      },
    ],
  });
  const postgres = f.qualified.spec.components.find(
    (c) => c.name === "postgres",
  )!;
  const pod = crypto.randomUUID();
  /** The controller's ready observation with its runtime attestation of the Pod. */
  const ready = (attestation: object = {}) =>
    request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([
        {
          ...observation(created.id, created.generation),
          postgres: {
            image: postgres.reference,
            image_id: `sha256:${postgres.sha256}`,
          },
          runtime_attestation: {
            v: 1,
            database_id: created.id,
            generation: created.generation,
            storage_generation: 1,
            node_uid: f.uid,
            boot_id: f.qualified.bootId,
            cluster_uid: f.authority.cluster_uid,
            namespace_uid: receipt.namespace_uid,
            cnpg_cluster_uid: receipt.cluster_uid,
            storage_uid: receipt.storage_uid,
            pvc_uid: receipt.pvc_uid,
            pv_uid: receipt.pv_uid,
            pod_uid: pod,
            container_id: "c".repeat(64),
            postgres_image_sha256: postgres.sha256,
            memory_request_bytes: 128 * mib,
            memory_limit_bytes: 512 * mib,
            observed_at: Date.now(),
            configuration_fingerprint: "f".repeat(64),
            ...attestation,
          },
        },
      ]),
    );
  const token = async () => {
    const desired = DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    );
    const value = desired.databases.find(
      (db) => db.id === created.id,
    )?.storage_authority;
    return value
      ? StorageWriteClaims.parse(
          JSON.parse(
            new TextDecoder().decode(base64urlToBytes(value.split(".")[1]!)!),
          ),
        )
      : undefined;
  };
  return { created, receipt, pod, ready, token };
}

it("signs a first token for a held writer the controller attests, before any IO evidence", async () => {
  const f = await thinExecutionFixture(releases),
    held = await heldWriter(f);
  // Without the runtime attestation of this generation's Pod there is no writer to name.
  expect(await held.token()).toBeUndefined();
  expect((await held.ready()).status).toBe(200);
  expect(await held.token()).toMatchObject({
    database_id: held.created.id,
    generation: held.created.generation,
    pod_uid: held.pod,
    lv_uuid: held.receipt.lv_uuid,
    storage_uid: held.receipt.storage_uid,
    write_allowed: true,
  });
  // The host guard receives the same signed writer.
  const guard = (await (
    await request(`/agent/v1/nodes/${f.node}/storage-guard`, f.agent)
  ).json()) as {
    databases: { database_id: string; runtime_authority: string | null }[];
  };
  expect(
    guard.databases.find((db) => db.database_id === held.created.id)
      ?.runtime_authority,
  ).toMatch(/^sa1\./);
});

it("names no held writer without a current startup hold or with an attestation of another boot", async () => {
  const f = await thinExecutionFixture(releases),
    held = await heldWriter(f);
  expect((await held.ready({ boot_id: crypto.randomUUID() })).status).toBe(200);
  expect(await held.token()).toBeUndefined();
  expect((await held.ready()).status).toBe(200);
  expect(await held.token()).toMatchObject({ pod_uid: held.pod });
  await env.DB.prepare(
    "DELETE FROM database_start_admissions WHERE database_id=?",
  )
    .bind(held.created.id)
    .run();
  expect(await held.token()).toBeUndefined();
});
