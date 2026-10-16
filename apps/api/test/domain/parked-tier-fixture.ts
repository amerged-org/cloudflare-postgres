// SPDX-License-Identifier: Apache-2.0
// A thin database on real D1 fixtures that an idle sleep can park: the controller attests its Pod and
// the node proof evidences that Pod's io.max. Controlled metadata; no live qualification or Dev evidence.
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  DatabaseStorageVolumeReceipt,
  DatabaseWithOperation,
  StorageWriteClaims,
  base64urlToBytes,
  newOperationId,
  thinStorageClass,
} from "@pgcf/contracts";
import {
  HostStorageLease,
  NodeStorageHeadroomResponse,
} from "@pgcf/contracts/node-thin-storage";
import { observation, observedBody, request } from "./fixtures.ts";
import {
  type Fixture,
  gib,
  identityProof,
  lvs,
  mib,
  nonce,
  post,
  sample,
} from "./thin-renewal-fixture.ts";
import { powerTransitionStatements } from "../../src/domain/lifecycle.ts";
import type { DatabaseRow } from "../../src/domain/rows.ts";

export const PARKED = { cpu_millicores: 15, memory_mib: 160 } as const;

/** A ready, awake thin database: its receipt is bound, its Pod attested and io.max evidenced. */
export async function awakeWriter(f: Fixture) {
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
  const pod = crypto.randomUUID();
  const limits = {
    write_bytes_per_second: f.profile.write_bytes_per_second,
    write_iops_per_second: f.profile.write_iops_per_second,
  };
  const volume = (
    generation: number,
    io: object[],
    quiesced = false,
    changes: object = {},
  ) => ({
    database_id: created.id,
    generation,
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
    quiesced,
    io,
    ...changes,
  });
  /** What the node proof reads: the Pod's io.max on the active LV, at the given generation. */
  const reading = (
    options: {
      generation?: number;
      io?: object[];
      quiesced?: boolean;
      revision?: number;
      /** Fields of the volume entry that differ from the receipt's, for a reading of another volume. */
      volume?: object;
    } = {},
  ) => ({
    physical,
    ...(options.revision === undefined ? {} : { revision: options.revision }),
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
      volume(
        options.generation ?? created.generation,
        options.io ?? [{ pod_uid: pod, ...limits }],
        options.quiesced,
        options.volume,
      ),
    ],
  });
  /** An accepted identity proof of that reading, as the slow loop records it. */
  const evidence = (options: Parameters<typeof reading>[0] = {}) =>
    identityProof(f, reading(options));
  const postgres = f.qualified.spec.components.find(
    (c) => c.name === "postgres",
  )!;
  /** The controller's ready observation with its runtime attestation of the Pod. */
  const ready = (
    generation = created.generation,
    power?: string,
    attestation: object = {},
  ) =>
    request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([
        {
          ...observation(created.id, generation),
          ...(power
            ? {
                power: {
                  operation: power,
                  revision: generation,
                  state: "awake",
                },
              }
            : {}),
          postgres: {
            image: postgres.reference,
            image_id: `sha256:${postgres.sha256}`,
          },
          runtime_attestation: {
            v: 1,
            database_id: created.id,
            generation,
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
  await evidence();
  expect((await ready()).status).toBe(200);
  return {
    f,
    id: created.id,
    created,
    receipt,
    pod,
    limits,
    physical,
    reading,
    evidence,
    ready,
  };
}
export type AwakeWriter = Awaited<ReturnType<typeof awakeWriter>>;

export async function databaseRow(id: string) {
  return (await env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(id)
    .first<DatabaseRow>())!;
}

/** The Actor's idle intent: desired suspended/idle at the next generation with a hibernate operation. */
export async function idleIntent(w: AwakeWriter) {
  const before = await databaseRow(w.id),
    operation = newOperationId();
  await env.DB.batch(
    powerTransitionStatements(
      env.DB,
      before,
      "hibernate",
      operation,
      new Date().toISOString(),
    ),
  );
  return { operation, generation: before.generation + 1 };
}

/** The controller's confirmed idle sleep; `parked` is absent for a plain hibernation. */
export function hibernated(
  w: AwakeWriter,
  intent: { operation: string; generation: number },
  parked?: {
    pod_uid: string;
    cpu_millicores: number;
    memory_mib: number;
    wake?: "fast";
  },
) {
  return request(
    "/agent/v1/observations",
    w.f.agent,
    "POST",
    observedBody([
      {
        ...observation(w.id, intent.generation, "hibernated"),
        power: {
          operation: intent.operation,
          revision: intent.generation,
          state: "hibernated",
          ...(parked ? { parked } : {}),
        },
        archive: { continuous: false, ready_wal_files: null },
      },
    ]),
  );
}
export const parkedPod = (w: AwakeWriter) => ({
  pod_uid: w.pod,
  ...PARKED,
});

/**
 * An idle sleep that the controller confirmed as parked, through the real observation route. The
 * node's identity proof has read the volume again at the sleep's generation by then, and the
 * parked Pod's io.max is still there: the proof counts every instance Pod as a writer. With
 * `read: false` the proof has not read again yet: it still names the generation the Pod ran at.
 */
export async function parkedWriter(
  w: AwakeWriter,
  wake?: "fast",
  options: { read?: boolean } = {},
) {
  const intent = await idleIntent(w);
  if (options.read !== false)
    await w.evidence({ generation: intent.generation });
  const response = await hibernated(w, intent, {
    ...parkedPod(w),
    ...(wake === undefined ? {} : { wake }),
  });
  expect(await response.json()).toEqual({ accepted: 1 });
  return intent;
}
/** One fast sample of the awake writer's node: what the controller posts and Cloudflare answers. */
export async function renewal(w: AwakeWriter) {
  const response = await post(
    w.f,
    sample(w.f, await nonce(w.f), {
      physical: {
        ...w.physical,
        thin_pool: {
          ...w.physical.thin_pool!,
          data_used_bytes_upper_bound: 64 * mib,
          metadata_used_bytes_upper_bound: mib,
        },
      },
    }),
  );
  expect(response.status).toBe(200);
  return NodeStorageHeadroomResponse.parse(response.body);
}
export async function leaseEntry(f: Fixture, id: string) {
  const response = await request(
    `/agent/v1/nodes/${f.node}/storage-guard`,
    f.agent,
  );
  expect(response.status).toBe(200);
  return HostStorageLease.parse(await response.json()).databases.find(
    (entry) => entry.database_id === id,
  )!;
}
export function claimsOf(token: string | null | undefined) {
  if (!token) return undefined;
  return StorageWriteClaims.parse(
    JSON.parse(
      new TextDecoder().decode(base64urlToBytes(token.split(".")[1]!)!),
    ),
  );
}
