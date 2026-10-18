// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  assignRelease,
  fixture,
  cleanupFixtures,
  desiredPage,
  grantCredential,
  nodeKeyPair,
  refusal,
  request,
  report,
  verdicts,
} from "./fixtures.ts";
import { createApp } from "../../src/app.ts";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import type { Env } from "../../src/env.ts";
import { cleanupRetainedArchives } from "../../src/domain/retained-archives.ts";
import { keyring } from "../../src/crypto/keyring.ts";
import type { RoleRow } from "../../src/domain/rows.ts";
import { archiveDestinationPath, newNodeId } from "@pgcf/contracts";
import { placePendingDatabases } from "../../src/domain/node-capacity.ts";
import { withAdmissionMutation } from "../../src/domain/admission-mutations.ts";
import { addNode } from "./fixtures.ts";
import { reports, seedSamples, steady } from "./node-samples.ts";
const keys: string[] = [];
afterEach(async () => {
  if (keys.length) await env.ARCHIVE.delete(keys.splice(0));
  await cleanupFixtures();
});
async function archived(
  prepare?: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture();
  if (prepare) await prepare(f);
  const response = await f.create();
  const { database } = (await response.json()) as {
    database: { id: string; generation: number };
  };
  const row = await env.DB.prepare(
    "SELECT archive_path FROM databases WHERE id=?",
  )
    .bind(database.id)
    .first<{ archive_path: string }>();
  const prefix =
    row!.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") +
    "/database/";
  const start = Date.now() - 60 * 60 * 1000,
    begin = new Date(start).toISOString(),
    end = new Date(start + 120000).toISOString(),
    backupId = begin.replace(/[-:]/g, "").slice(0, 15),
    target = new Date(start + 180000).toISOString(),
    before = new Date(start + 60000).toISOString();
  const objects = [
    [
      `${prefix}base/${backupId}/backup.info`,
      `status=DONE\nbegin_time=${begin}\nend_time=${end}\nbegin_wal=00000001${"0".repeat(15)}1\nend_wal=00000001${"0".repeat(15)}1\nxlog_segment_size=16777216\n`,
    ],
    [`${prefix}base/${backupId}/data.tar.gz`, "payload"],
    [
      `${prefix}wals/00000001${"0".repeat(8)}/00000001${"0".repeat(15)}1.gz`,
      "wal",
    ],
  ];
  for (const [key, value] of objects) {
    keys.push(key!);
    await env.ARCHIVE.put(key!, value!);
  }
  return {
    ...f,
    id: database.id,
    generation: database.generation,
    prefix,
    target,
    before,
  };
}
it("creates and restores a database in a region whose node release is assigned", async () => {
  // Assigning the release is the rollout step of every region; it must not stop its databases.
  const f = await archived(async (node) => {
    await assignRelease(node);
  });
  const restored = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    { name: "after-release", mode: "full" },
  );
  expect(restored.status).toBe(202);
});
it("keeps a fresh restore target denied and refuses restore creation while its project scope is fenced", async () => {
  const f = await archived();
  const restored = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    { name: "fresh-denied-target", mode: "full" },
  );
  expect(restored.status).toBe(202);
  const target = (await restored.json()) as { target_database: { id: string } };
  const actor = env.DATABASE_ACTOR.get(
    env.DATABASE_ACTOR.idFromName(target.target_database.id),
  );
  expect((await actor.admit(target.target_database.id, "app")).ok).toBe(false);
  await withAdmissionMutation(
    env,
    [],
    async (mutation) => {
      const refused = await request(
        `/v1/databases/${f.id}/restore`,
        f.integrator,
        "POST",
        { name: "scope-fenced-target", mode: "full" },
      );
      // The target's own insert finds the project fenced: it changed under the request.
      expect(await refusal(refused)).toMatchObject({
        status: 409,
        reason: "generation_changed",
        retryAfter: "1",
      });
      expect(
        await env.DB.prepare(
          "SELECT count(*) n FROM databases WHERE project_id=? AND name='scope-fenced-target'",
        )
          .bind(f.project)
          .first("n"),
      ).toBe(0);
      const guard = mutation.scopeGuard();
      await mutation.batch([
        env.DB.prepare(
          `UPDATE projects SET updated_at=? WHERE id=? AND ${guard.sql}`,
        ).bind(new Date().toISOString(), f.project, ...guard.bindings),
      ]);
    },
    { kind: "project", id: f.project },
  );
});
it("places a restore where a node has room and keeps one that no node can take waiting, with its original operation", async () => {
  const f = await archived();
  const nodeOf = (id: string) =>
    env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(id)
      .first("node_id");
  // The only node runs at 90 % active RAM: the restore waits for capacity.
  await seedSamples(f.node, steady(Date.now(), 40, { ramPpm: 900_000 }));
  const delayed = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    { name: "delayed-admission", mode: "full" },
  );
  expect(delayed.status).toBe(202);
  const pending = (await delayed.json()) as {
    target_database: { id: string };
    operation: { id: string };
  };
  expect(await nodeOf(pending.target_database.id)).toBeNull();
  expect(await placePendingDatabases(env.DB, f.region)).toEqual([]);
  // A node with room reports: the waiting restore is placed on it, still with its operation.
  const spare = await addNode(f.region);
  expect(await placePendingDatabases(env.DB, f.region)).toEqual([
    pending.target_database.id,
  ]);
  expect(await nodeOf(pending.target_database.id)).toBe(spare);
  expect(
    await env.DB.prepare(
      "SELECT id FROM operations WHERE database_id=? AND kind='database.restore'",
    )
      .bind(pending.target_database.id)
      .first("id"),
  ).toBe(pending.operation.id);
  const placed = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    { name: "placed-admission", mode: "full" },
  );
  expect(placed.status).toBe(202);
  expect(
    await nodeOf(
      ((await placed.json()) as { target_database: { id: string } })
        .target_database.id,
    ),
  ).toBe(spare);
});
it("restores with the resources of its source", async () => {
  const f = await archived();
  await env.DB.prepare(
    "UPDATE databases SET own_memory_mib=1024,own_storage_gib=12 WHERE id=?",
  )
    .bind(f.id)
    .run();
  const restored = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    { name: "same-resources", mode: "full" },
  );
  expect(restored.status).toBe(202);
  const target = (await restored.json()) as {
    target_database: { id: string; resources: unknown };
  };
  expect(target.target_database.resources).toEqual({
    memory_mib: 1024,
    cpu_millicores: 500,
    storage_gib: 12,
  });
});
it("restores a source catalog into a separate target region without changing source placement or credentials", async () => {
  const f = await archived(),
    targetNode = newNodeId(),
    targetKey = await nodeKeyPair(),
    targetUid = crypto.randomUUID(),
    now = new Date().toISOString(),
    bucket = "pgcf-api-us-test";
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE regions SET backup_bucket=?,backup_endpoint_url=? WHERE id=?",
    ).bind(bucket, "https://target.r2.cloudflarestorage.com", f.foreign),
    env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid,public_key,enrolled_at) VALUES(?,?,?,1,1,4096,2000,30,128,100,?,?,?,?,?,?)",
    ).bind(
      targetNode,
      f.foreign,
      "restore-target-node",
      now,
      now,
      now,
      targetUid,
      targetKey.publicKey,
      now,
    ),
  ]);
  await reports(targetNode);
  const mapping = {
    ARCHIVE_BINDINGS: JSON.stringify({
      [f.region]: { binding: "ARCHIVE", bucket: env.ARCHIVE_BUCKET_NAME },
      [f.foreign]: { binding: "ARCHIVE_US", bucket },
    }),
  };
  const source = await env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(f.id)
    .first();
  const body = {
      mode: "full",
      name: "cross-region-restored",
      region_id: f.foreign,
    },
    path = `/v1/databases/${f.id}/restore`;
  const response = await overridden(
    path,
    f.integrator,
    body,
    mapping,
    "cross-region-restore",
  );
  expect(response.status).toBe(202);
  const result = await response.json<{
    target_database: { id: string; region_id: string };
    operation: { id: string };
  }>();
  expect(result.target_database.region_id).toBe(f.foreign);
  const target = await env.DB.prepare(
    "SELECT region_id,node_id,archive_path,storage_generation FROM databases WHERE id=?",
  )
    .bind(result.target_database.id)
    .first();
  expect(target).toEqual({
    region_id: f.foreign,
    node_id: targetNode,
    archive_path: archiveDestinationPath(
      bucket,
      f.foreign,
      result.target_database.id,
      2,
      result.operation.id,
    ),
    storage_generation: 2,
  });
  expect(
    await env.DB.prepare("SELECT * FROM databases WHERE id=?")
      .bind(f.id)
      .first(),
  ).toEqual(source);
  const replay = await overridden(
    path,
    f.integrator,
    body,
    mapping,
    "cross-region-restore",
  );
  expect(await replay.json()).toEqual(result);
  expect(
    (
      await overridden(
        path,
        f.integrator,
        { ...body, region_id: f.region },
        mapping,
        "cross-region-restore",
      )
    ).status,
  ).toBe(409);
  // The node of the target region reads the restore from the source's archive.
  await grantCredential(result.target_database.id, {
    path: (source as { archive_path: string }).archive_path,
    access: "read_only",
  });
  const targetPage = await desiredPage({
    region: f.foreign,
    admin: f.admin,
    node: targetNode,
    nodeUid: targetUid,
    nodeKey: targetKey.privateKey,
  });
  expect(
    targetPage.databases.find((d) => d.id === result.target_database.id)
      ?.origin,
  ).toMatchObject({
    kind: "restore",
    source: {
      database_id: f.id,
      path: (source as { archive_path: string }).archive_path,
    },
  });
  // The source's own node never sees the target.
  expect(
    (await desiredPage(f)).databases.some(
      (d) => d.id === result.target_database.id,
    ),
  ).toBe(false);
  expect(
    (
      await overridden(
        path,
        f.integrator,
        { ...body, name: "missing-target", region_id: "missing-test" },
        mapping,
        "missing-target-region",
      )
    ).status,
  ).toBe(409);
});

it("restores into one separate target on replay with credentials encrypted for its ID", async () => {
  const f = await archived();
  await env.DB.prepare(
    "UPDATE databases SET sleep_after_seconds=300 WHERE id=?",
  )
    .bind(f.id)
    .run();
  const body = { mode: "full", name: "restored" };
  const first = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    body,
    "restore-once",
  );
  expect(first.status).toBe(202);
  const result = (await first.json()) as {
    target_database: {
      id: string;
      observed_state: string;
      sleep_after_seconds: number | null;
    };
    operation: { id: string; kind: string };
  };
  expect(result.target_database.id).not.toBe(f.id);
  expect(result.target_database.observed_state).toBe("pending");
  expect(result.target_database.sleep_after_seconds).toBe(300);
  expect(result.operation.kind).toBe("database.restore");
  const replay = await request(
    `/v1/databases/${f.id}/restore`,
    f.integrator,
    "POST",
    body,
    "restore-once",
  );
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual(result);
  const source = await env.DB.prepare(
    "SELECT * FROM roles WHERE database_id=? AND owner=1",
  )
    .bind(f.id)
    .first<RoleRow>();
  const target = await env.DB.prepare(
    "SELECT * FROM roles WHERE database_id=? AND owner=1",
  )
    .bind(result.target_database.id)
    .first<RoleRow>();
  const decrypt = (r: RoleRow) =>
    keyring(env.CREDENTIAL_KEYS).decrypt(r.database_id, r.name, {
      ciphertext: r.password_ciphertext,
      iv: r.password_iv,
      kid: r.password_kid,
    });
  expect(await decrypt(target!)).toBe(await decrypt(source!));
  expect(target!.password_ciphertext).not.toBe(source!.password_ciphertext);
  await grantCredential(result.target_database.id, {
    path: (await env.DB.prepare("SELECT archive_path FROM databases WHERE id=?")
      .bind(f.id)
      .first<string>("archive_path"))!,
    access: "read_only",
  });
  expect(
    (await desiredPage(f)).databases.find(
      (d) => d.id === result.target_database.id,
    )?.origin,
  ).toMatchObject({ kind: "restore", source: { database_id: f.id } });
  // The node restored the database and reports it ready; that ends the restore.
  expect(await verdicts(await report(f, result.target_database.id, 1))).toEqual(
    ["accept"],
  );
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(result.operation.id)
      .first(),
  ).toEqual({ status: "succeeded" });
  expect(
    await env.DB.prepare("SELECT desired_state FROM databases WHERE id=?")
      .bind(f.id)
      .first(),
  ).toEqual({ desired_state: "running" });
});
it("retains deleted-source restore authority and rejects another tenant, missing region and expired archive", async () => {
  const f = await archived();
  expect(
    (await request(`/v1/databases/${f.id}`, f.integrator, "DELETE")).status,
  ).toBe(202);
  expect(
    (
      await request(`/v1/databases/${f.id}/restore`, f.otherKey, "POST", {
        mode: "full",
        name: "foreign",
      })
    ).status,
  ).toBe(404);
  expect(
    await refusal(
      await request(`/v1/databases/${f.id}/restore`, f.integrator, "POST", {
        mode: "full",
        name: "wrong-region",
        region_id: "missing-test",
      }),
    ),
  ).toMatchObject({ status: 409, reason: "region_unavailable" });
  expect(
    (
      await request(`/v1/databases/${f.id}/restore`, f.integrator, "POST", {
        mode: "pitr",
        name: "deleted-restore",
        target_time: f.target,
      })
    ).status,
  ).toBe(202);
  await env.DB.prepare(
    "UPDATE retained_archives SET deleted_at=?,expires_at=? WHERE source_database_id=?",
  )
    .bind(
      new Date(Date.now() - 8 * 86400000).toISOString(),
      new Date(Date.now() - 86400000).toISOString(),
      f.id,
    )
    .run();
  expect(
    await refusal(
      await request(`/v1/databases/${f.id}/restore`, f.integrator, "POST", {
        mode: "full",
        name: "expired",
      }),
    ),
  ).toEqual({
    status: 409,
    code: "conflict",
    reason: "archive_expired",
    retryAfter: null,
  });
});
it("refuses missing WAL and a target before a completed base backup without reserving target storage", async () => {
  const f = await archived();
  expect(
    await refusal(
      await request(`/v1/databases/${f.id}/restore`, f.integrator, "POST", {
        mode: "pitr",
        name: "too-early",
        target_time: f.before,
      }),
    ),
  ).toMatchObject({ status: 409, reason: "no_recovery_point" });
  await env.ARCHIVE.delete(keys.filter((k) => k.includes("/wals/")));
  expect(
    await refusal(
      await request(`/v1/databases/${f.id}/restore`, f.integrator, "POST", {
        mode: "full",
        name: "missing-wal",
      }),
    ),
  ).toMatchObject({ status: 409, reason: "no_recovery_point" });
  expect(
    await env.DB.prepare("SELECT COUNT(*) count FROM database_restores").first<{
      count: number;
    }>(),
  ).toEqual({ count: 0 });
});

async function overridden(
  path: string,
  key: string,
  body: unknown,
  override: Partial<Env>,
  idempotency: string,
  method = "POST",
) {
  const ctx = createExecutionContext();
  const result = await createApp().fetch(
    new Request(new URL(path, `https://${["api", "invalid"].join(".")}`), {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotency,
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, ...override } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return result;
}
it("completed reservation survives a lost response and replay creates neither credentials nor another target", async () => {
  const f = await archived(),
    body = { mode: "full", name: "lost-response" },
    path = `/v1/databases/${f.id}/restore`;
  const actor = {
    idFromName: (id: string) => env.DATABASE_ACTOR.idFromName(id),
    get: () => ({
      seed: async () => {
        throw new Error("response_ack_lost");
      },
    }),
  } as unknown as Env["DATABASE_ACTOR"];
  expect(
    (
      await overridden(
        path,
        f.integrator,
        body,
        { DATABASE_ACTOR: actor },
        "lost-response",
      )
    ).status,
  ).toBe(500);
  const count = await env.DB.prepare(
    "SELECT COUNT(*) count FROM database_restores WHERE source_database_id=?",
  )
    .bind(f.id)
    .first();
  expect(count).toEqual({ count: 1 });
  const replay = await request(
    path,
    f.integrator,
    "POST",
    body,
    "lost-response",
  );
  expect(replay.status).toBe(202);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM database_restores WHERE source_database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual(count);
});
it("concurrent source deletion refuses a stale restore reservation", async () => {
  const f = await archived();
  let deleted = false;
  const bucket = {
    list: async (options: R2ListOptions) => {
      if (!deleted) {
        deleted = true;
        expect(
          (await request(`/v1/databases/${f.id}`, f.integrator, "DELETE"))
            .status,
        ).toBe(202);
      }
      return env.ARCHIVE.list(options);
    },
    get: env.ARCHIVE.get.bind(env.ARCHIVE),
    delete: env.ARCHIVE.delete.bind(env.ARCHIVE),
  } as unknown as R2Bucket;
  expect(
    (
      await overridden(
        `/v1/databases/${f.id}/restore`,
        f.integrator,
        { mode: "full", name: "raced" },
        { ARCHIVE: bucket },
        "delete-race",
      )
    ).status,
  ).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM database_restores WHERE source_database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ count: 0 });
});
it("expiry cleanup deletes only the owned prefix and releases retained credentials after complete deletion", async () => {
  const f = await archived();
  expect(
    (await request(`/v1/databases/${f.id}`, f.integrator, "DELETE")).status,
  ).toBe(202);
  expect(await verdicts(await report(f, f.id, 2, "deleted"))).toEqual([
    "accept",
  ]);
  const retention = await env.DB.prepare(
    "SELECT expires_at FROM retained_archives WHERE source_database_id=?",
  )
    .bind(f.id)
    .first<{ expires_at: string }>();
  const sibling = `${f.prefix}other-generation`,
    outside = f.prefix.replace("/g1-", "/g2-") + "sibling";
  keys.push(sibling, outside);
  await env.ARCHIVE.put(sibling, "owned");
  await env.ARCHIVE.put(outside, "sibling");
  expect(
    await cleanupRetainedArchives(env, Date.parse(retention!.expires_at) - 1),
  ).toEqual({ purged: 0, objects: 0 });
  expect(
    (await cleanupRetainedArchives(env, Date.parse(retention!.expires_at)))
      .objects,
  ).toBe(4);
  expect(await env.ARCHIVE.get(outside)).not.toBeNull();
  expect(
    await cleanupRetainedArchives(env, Date.parse(retention!.expires_at)),
  ).toEqual({ purged: 1, objects: 0 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) count FROM roles WHERE database_id=?")
      .bind(f.id)
      .first(),
  ).toEqual({ count: 0 });
  expect(
    await env.DB.prepare(
      "SELECT id FROM databases WHERE id=? AND desired_state='deleted'",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ id: f.id });
});

it("refuses a known WAL gap instead of promoting at the first missing segment", async () => {
  const f = await archived(),
    gap = `${f.prefix}wals/00000001${"0".repeat(8)}/00000001${"0".repeat(15)}3.gz`;
  keys.push(gap);
  await env.ARCHIVE.put(gap, "later-wal");
  expect(
    (
      await request(`/v1/databases/${f.id}/restore`, f.integrator, "POST", {
        mode: "full",
        name: "gapped",
      })
    ).status,
  ).toBe(409);
});
