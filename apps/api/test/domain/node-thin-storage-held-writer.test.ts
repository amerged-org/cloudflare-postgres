// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  DatabaseStorageVolumeReceipt,
  DatabaseWithOperation,
  DesiredResponse,
  StorageWriteClaims,
  base64urlToBytes,
  newOperationId,
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
  iso,
  lvs,
  mib,
  report,
} from "./thin-renewal-fixture.ts";
import { HostStorageLease } from "@pgcf/contracts/node-thin-storage";
import { prepareThinStorageLease } from "../../src/domain/node-thin-storage-execution.ts";
import {
  readCurrentNodeThinStorage,
  storageWriteAuthorityForDatabase,
} from "../../src/domain/node-thin-storage.ts";
import type { DatabaseRow } from "../../src/domain/rows.ts";
import type { Env } from "../../src/env.ts";

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
  const authority = await identityProof(f, {
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
  const ready = (
    attestation: object = {},
    generation = created.generation,
    powerOperation?: string,
  ) =>
    request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([
        {
          ...observation(created.id, generation),
          ...(powerOperation
            ? {
                power: {
                  operation: powerOperation,
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
  return { created, receipt, pod, authority, ready, token };
}

async function hostWriter(f: Fixture, databaseId: string) {
  return HostStorageLease.parse(
    await (
      await request(`/agent/v1/nodes/${f.node}/storage-guard`, f.agent)
    ).json(),
  ).databases.find((database) => database.database_id === databaseId);
}

it("grants neither a held token nor startup authority to a proven quiesced current writer", async () => {
  const f = await thinExecutionFixture(releases),
    held = await heldWriter(f);
  expect((await held.ready()).status).toBe(200);
  await identityProof(f, {
    ...held.authority,
    volumes: held.authority.volumes.map((volume) => ({
      ...volume,
      quiesced: true,
    })),
  });
  // The physical stop independently refuses a writer, even before its durable marker is read.
  await env.DB.prepare(
    "UPDATE databases SET observed_state='provisioning' WHERE id=?",
  )
    .bind(held.created.id)
    .run();
  expect(await held.token()).toBeUndefined();
  expect(await hostWriter(f, held.created.id)).toMatchObject({
    runtime_authority: null,
    startup_expires_at: null,
    write_blocked: true,
  });
});

it("denies every current protected generation but preserves an authorized newer generation's startup", async () => {
  const f = await thinExecutionFixture(releases),
    held = await heldWriter(f);
  expect((await held.ready()).status).toBe(200);
  await prepareThinStorageLease(f.local, f.node, false);
  expect(
    await report(f, {
      physical: held.authority.physical,
      physical_lvs: held.authority.physical_lvs,
      active_lv_uuids: held.authority.active_lv_uuids,
      volumes: held.authority.volumes.map((volume) => ({
        ...volume,
        quiesced: true,
      })),
    }),
  ).toMatchObject({ accepted: true, write_allowed: true });
  expect(
    await env.DB.prepare(
      "SELECT storage_protected_generation FROM databases WHERE id=?",
    )
      .bind(held.created.id)
      .first("storage_protected_generation"),
  ).toBe(held.created.generation);
  expect(await held.token()).toBeUndefined();
  expect(await hostWriter(f, held.created.id)).toMatchObject({
    runtime_authority: null,
    startup_expires_at: null,
    write_blocked: true,
  });

  // A newer physical read of IO limits cannot itself authorize resuming the protected generation.
  await identityProof(f, {
    ...held.authority,
    volumes: held.authority.volumes.map((volume) => ({
      ...volume,
      io: [
        {
          pod_uid: held.pod,
          write_bytes_per_second: f.profile.write_bytes_per_second,
          write_iops_per_second: f.profile.write_iops_per_second,
        },
      ],
    })),
  });
  expect(await held.token()).toBeUndefined();

  // The owner-authorized recovery creates a new generation and its own bounded startup hold.
  const operation = newOperationId(),
    next = held.created.generation + 1;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE databases SET generation=?,power_operation=? WHERE id=?",
    ).bind(next, operation, held.created.id),
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,'database.wake','pending',project_id,database_id,?,created_at,updated_at FROM operations WHERE id=(SELECT operation_id FROM database_start_admissions WHERE database_id=? AND generation=?)",
    ).bind(operation, next, held.created.id, held.created.generation),
    env.DB.prepare(
      "INSERT INTO database_start_admissions(operation_id,database_id,generation,node_id,node_uid,budget_bytes,granted_at,grant_sample_observed_at,storage_budget_bytes,storage_volume_json) SELECT ?,database_id,?,node_id,node_uid,budget_bytes,granted_at,grant_sample_observed_at,storage_budget_bytes,storage_volume_json FROM database_start_admissions WHERE database_id=? AND generation=?",
    ).bind(operation, next, held.created.id, held.created.generation),
  ]);
  expect(await hostWriter(f, held.created.id)).toMatchObject({
    generation: next,
    write_blocked: false,
    startup_operation_id: operation,
    startup_expires_at: expect.any(Number),
    runtime_authority: null,
  });
  expect((await held.ready({}, next, operation)).status).toBe(200);
  expect(await held.token()).toMatchObject({
    generation: next,
    pod_uid: held.pod,
  });
  expect(await hostWriter(f, held.created.id)).toMatchObject({
    generation: next,
    write_blocked: false,
    runtime_authority: expect.stringMatching(/^sa1\./),
  });
});

it("a slow physical protection closes an admitted Actor before committing its database marker", async () => {
  const f = await thinExecutionFixture(releases),
    held = await heldWriter(f);
  expect((await held.ready()).status).toBe(200);
  const actor = env.DATABASE_ACTOR.get(
    env.DATABASE_ACTOR.idFromName(held.created.id),
  );
  expect((await actor.admit(held.created.id, "app")).ok).toBe(true);
  await env.DB.exec(
    `CREATE TRIGGER thin_protection_admission BEFORE UPDATE OF storage_protected_at ON databases WHEN NEW.id='${held.created.id}' AND NEW.storage_protected_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=NEW.id AND e.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'physical protection lacks admission fence'); END`,
  );
  try {
    await prepareThinStorageLease(f.local, f.node, false);
    expect(
      await report(f, {
        physical: held.authority.physical,
        physical_lvs: held.authority.physical_lvs,
        active_lv_uuids: held.authority.active_lv_uuids,
        volumes: held.authority.volumes.map((volume) => ({
          ...volume,
          quiesced: true,
        })),
      }),
    ).toMatchObject({ accepted: true });
    expect(await actor.admit(held.created.id, "app")).toEqual({
      ok: false,
      sqlstate: "57P03",
    });
    const before = await env.DB.prepare(
      "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(held.created.id)
      .first();
    await prepareThinStorageLease(f.local, f.node, false);
    expect(
      await report(f, {
        physical: held.authority.physical,
        physical_lvs: held.authority.physical_lvs,
        active_lv_uuids: held.authority.active_lv_uuids,
        volumes: held.authority.volumes.map((volume) => ({
          ...volume,
          quiesced: true,
        })),
      }),
    ).toMatchObject({ accepted: true });
    expect(
      await env.DB.prepare(
        "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
      )
        .bind(held.created.id)
        .first(),
    ).toEqual(before);
  } finally {
    await env.DB.exec("DROP TRIGGER thin_protection_admission");
  }
});

it("slow protection fences a startup generation as well as an already admitted database", async () => {
  const f = await thinExecutionFixture(releases),
    held = await heldWriter(f);
  await env.DB.exec(
    `CREATE TRIGGER startup_protection_admission BEFORE UPDATE OF storage_protected_at ON databases WHEN NEW.id='${held.created.id}' AND NEW.storage_protected_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=NEW.id AND e.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'startup protection lacks admission fence'); END`,
  );
  try {
    await prepareThinStorageLease(f.local, f.node, false);
    expect(
      await report(f, {
        physical: held.authority.physical,
        physical_lvs: held.authority.physical_lvs,
        active_lv_uuids: held.authority.active_lv_uuids,
        volumes: held.authority.volumes.map((volume) => ({
          ...volume,
          quiesced: true,
        })),
      }),
    ).toMatchObject({ accepted: true });
    expect(
      await env.DB.prepare(
        "SELECT storage_protected_generation FROM databases WHERE id=?",
      )
        .bind(held.created.id)
        .first("storage_protected_generation"),
    ).toBe(held.created.generation);
    expect((await held.ready()).status).toBe(200);
    expect(
      await env.DATABASE_ACTOR.get(
        env.DATABASE_ACTOR.idFromName(held.created.id),
      ).admit(held.created.id, "app"),
    ).toEqual({ ok: false, sqlstate: "57P03" });
  } finally {
    await env.DB.exec("DROP TRIGGER startup_protection_admission");
  }
});

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

it("ends held-writer tokens when a post-Ready identity read still finds an active LV without IO limits", async () => {
  const f = await thinExecutionFixture(releases),
    held = await heldWriter(f),
    now = Date.now();
  expect((await held.ready({ observed_at: now - 10_000 })).status).toBe(200);
  // A read within the clock-skew allowance still permits the first held writer.
  await identityProof(f, {
    ...held.authority,
    inventory_observed_at: iso(now - 6000),
    inventory_expires_at: iso(now + 294_000),
  });
  expect(await held.token()).toMatchObject({ pod_uid: held.pod });
  // Missing and unbounded io.max both reach the API as io: []; neither renews forever.
  await identityProof(f, held.authority);
  expect(await held.token()).toBeUndefined();
  const guard = (await (
    await request(`/agent/v1/nodes/${f.node}/storage-guard`, f.agent)
  ).json()) as {
    databases: {
      database_id: string;
      startup_expires_at: number | null;
      write_blocked: boolean;
      runtime_authority: string | null;
    }[];
  };
  expect(
    guard.databases.find((db) => db.database_id === held.created.id),
  ).toMatchObject({
    startup_expires_at: null,
    write_blocked: true,
    runtime_authority: null,
  });
});

it("keeps the held-writer allowance across fast renewals that retain pre-Ready inventory", async () => {
  const f = await thinExecutionFixture(releases),
    held = await heldWriter(f),
    now = Date.now();
  expect((await held.ready({ observed_at: now - 10_000 })).status).toBe(200);
  await identityProof(f, {
    ...held.authority,
    observed_at: iso(now),
    expires_at: iso(now + f.profile.guard_seconds * 1000),
    inventory_observed_at: iso(now - 20_000),
    inventory_expires_at: iso(now + 280_000),
  });
  expect(await held.token()).toMatchObject({ pod_uid: held.pod });
});

it("does not restart the IO grace interval when the controller refreshes a Ready attestation", async () => {
  const f = await thinExecutionFixture(releases),
    held = await heldWriter(f);
  expect((await held.ready()).status).toBe(200);
  // The first Ready observation completed this startup operation; later attestations do not.
  await env.DB.prepare(
    "UPDATE operations SET completed_at=? WHERE id=(SELECT operation_id FROM database_start_admissions WHERE database_id=? AND generation=? AND budget_bytes>0)",
  )
    .bind(iso(Date.now() - 10_000), held.created.id, held.created.generation)
    .run();
  expect((await held.ready()).status).toBe(200);
  await identityProof(f, held.authority);
  expect(await held.token()).toBeUndefined();
});

it("signs a host writer from its entry's snapshot when D1 has accepted a concurrent renewal", async () => {
  const f = await thinExecutionFixture(releases),
    held = await heldWriter(f);
  expect((await held.ready()).status).toBe(200);
  const now = Date.now(),
    current = await readCurrentNodeThinStorage(env, f.node, now),
    database = await env.DB.prepare("SELECT * FROM databases WHERE id=?")
      .bind(held.created.id)
      .first<DatabaseRow>();
  expect(current?.authority).not.toBeNull();
  await identityProof(f, {
    ...held.authority,
    revision: held.authority.revision + 1,
  });
  const token = await storageWriteAuthorityForDatabase(
    env as Env,
    database!,
    now,
    current,
  );
  expect(token).toMatch(/^sa1\./);
  const claims = StorageWriteClaims.parse(
    JSON.parse(
      new TextDecoder().decode(base64urlToBytes(token!.split(".")[1]!)!),
    ),
  );
  expect(claims.authority_revision).toBe(current!.row.authority_revision);
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
