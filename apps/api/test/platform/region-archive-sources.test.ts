// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  DesiredResponse,
  bytesToBase64url,
  newNodeId,
} from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  cleanupFixtures,
  fixture,
  request,
  observation,
  observedBody,
} from "../domain/fixtures.ts";
import {
  encryptCustodyDocument,
  decryptCustodyDocument,
} from "../../src/crypto/bootstrap-credentials.ts";

const keys: string[] = [];
afterEach(async () => {
  if (keys.length) await env.ARCHIVE.delete(keys.splice(0));
  await env.DB.prepare("DELETE FROM region_archive_sources").run();
  await cleanupFixtures();
});
async function setup() {
  const f = await fixture();
  const source = await env.DB.prepare(
    "SELECT backup_bucket,backup_endpoint_url FROM regions WHERE id=?",
  )
    .bind(f.region)
    .first<{ backup_bucket: string; backup_endpoint_url: string }>();
  return {
    ...f,
    path: `/v1/regions/${f.foreign}/archive-sources/${f.region}`,
    input: {
      expected_revision: 0,
      bucket: source!.backup_bucket,
      endpoint_url: source!.backup_endpoint_url,
      credentials: {
        access_key_id: crypto.randomUUID(),
        secret_access_key: crypto.randomUUID(),
      },
    },
  };
}

it("publishes encrypted source-read custody only to its authorized target region and never admin responses", async () => {
  const f = await setup(),
    idem = crypto.randomUUID();
  const response = await request(f.path, f.admin, "PUT", f.input, idem);
  expect(response.status).toBe(200);
  const status = await response.json();
  expect(status).toMatchObject({
    target_region_id: f.foreign,
    source_region_id: f.region,
    revision: 1,
    source_matches_configuration: true,
    required_permission: "object-read-only",
  });
  const stored = await env.DB.prepare(
    "SELECT * FROM region_archive_sources WHERE target_region_id=?",
  )
    .bind(f.foreign)
    .first();
  expect(JSON.stringify(stored)).not.toContain(
    f.input.credentials.secret_access_key,
  );
  expect(JSON.stringify(stored)).not.toContain(
    f.input.credentials.access_key_id,
  );
  const get = await request(f.path, f.admin);
  expect(await get.json()).toEqual(status);
  expect(JSON.stringify(status)).not.toContain(
    f.input.credentials.secret_access_key,
  );
  expect(JSON.stringify(status)).not.toContain("ciphertext");
  expect((await request(f.path, f.admin, "PUT", f.input, idem)).status).toBe(
    200,
  );
  expect(
    await env.DB.prepare(
      "SELECT * FROM region_archive_sources WHERE target_region_id=?",
    )
      .bind(f.foreign)
      .first(),
  ).toEqual(stored);
  const target = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.foreignAgent)).json(),
  );
  expect(target.region.recovery_sources).toEqual({
    [f.region]: {
      bucket: f.input.bucket,
      endpoint_url: f.input.endpoint_url,
      ...f.input.credentials,
    },
  });
  const source = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(source.region.recovery_sources).toBeUndefined();
  expect((await request(f.path, f.integrator)).status).toBe(403);
  expect((await request(f.path, f.integrator, "PUT", f.input)).status).toBe(
    403,
  );
  expect((await request(f.path, f.foreignAgent)).status).toBe(401);
});

it("fences concurrent revision changes, invalid source bindings and self-relations without partial custody", async () => {
  const f = await setup();
  expect(
    (
      await request(f.path, f.admin, "PUT", {
        ...f.input,
        expected_revision: 2,
      })
    ).status,
  ).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM region_archive_sources",
    ).first("count"),
  ).toBe(0);
  expect(
    (
      await request(f.path, f.admin, "PUT", {
        ...f.input,
        bucket: "wrong-source-bucket",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        `/v1/regions/${f.region}/archive-sources/${f.region}`,
        f.admin,
        "PUT",
        f.input,
      )
    ).status,
  ).toBe(400);
  const attempts = await Promise.all([
    request(f.path, f.admin, "PUT", f.input, crypto.randomUUID()),
    request(
      f.path,
      f.admin,
      "PUT",
      {
        ...f.input,
        credentials: {
          ...f.input.credentials,
          secret_access_key: crypto.randomUUID(),
        },
      },
      crypto.randomUUID(),
    ),
  ]);
  expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    await env.DB.prepare(
      "SELECT revision FROM region_archive_sources WHERE target_region_id=?",
    )
      .bind(f.foreign)
      .first("revision"),
  ).toBe(1);
});

it("exposes source drift and sends an explicit empty authority instead of enabling a stale local fallback", async () => {
  const f = await setup();
  expect((await request(f.path, f.admin, "PUT", f.input)).status).toBe(200);
  await env.DB.prepare("UPDATE regions SET backup_bucket=? WHERE id=?")
    .bind("drifted-bucket", f.region)
    .run();
  expect(await (await request(f.path, f.admin)).json()).toMatchObject({
    source_matches_configuration: false,
  });
  const target = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.foreignAgent)).json(),
  );
  expect(target.region.recovery_sources).toEqual({});
});

it("rotates established restore configuration once and preserves source data, archive identity and in-progress initial authority", async () => {
  const f = await setup();
  expect((await request(f.path, f.admin, "PUT", f.input)).status).toBe(200);
  const source = DatabaseWithOperation.parse(
    await (await f.create("source")).json(),
  );
  const sourceRow = await env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(source.database.id)
    .first<{ archive_path: string }>();
  const prefix =
    sourceRow!.archive_path.replace(`s3://${env.ARCHIVE_BUCKET_NAME}/`, "") +
    "/database/";
  const start = Date.now() - 3_600_000,
    begin = new Date(start).toISOString(),
    end = new Date(start + 120_000).toISOString(),
    backup = begin.replace(/[-:]/g, "").slice(0, 15),
    wal = `00000001${"0".repeat(15)}1`;
  const objects = [
    [
      `${prefix}base/${backup}/backup.info`,
      `status=DONE\nbegin_time=${begin}\nend_time=${end}\nbegin_wal=${wal}\nend_wal=${wal}\nxlog_segment_size=16777216\n`,
    ],
    [`${prefix}base/${backup}/data.tar.gz`, "payload"],
    [`${prefix}wals/00000001${"0".repeat(8)}/${wal}.gz`, "wal"],
  ];
  for (const [key, value] of objects) {
    keys.push(key!);
    await env.ARCHIVE.put(key!, value!);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid) VALUES(?,?,?,1,1,4096,2000,30,128,100,?,?,?,?)",
  )
    .bind(
      newNodeId(),
      f.foreign,
      "restore-target",
      now,
      now,
      now,
      crypto.randomUUID(),
    )
    .run();
  const restored = await request(
    `/v1/databases/${source.database.id}/restore`,
    f.integrator,
    "POST",
    { mode: "full", name: "restored", region_id: f.foreign },
  );
  expect(restored.status).toBe(202);
  const target = await restored.json<{
    target_database: { id: string; storage_generation: number };
    operation: { id: string };
  }>();
  const targetId = target.target_database.id;
  const original = await env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(targetId)
    .first<Record<string, unknown>>();
  const rotation = {
    ...f.input,
    expected_revision: 1,
    credentials: {
      access_key_id: crypto.randomUUID(),
      secret_access_key: crypto.randomUUID(),
    },
  };
  expect((await request(f.path, f.admin, "PUT", rotation)).status).toBe(409);
  expect(
    await env.DB.prepare("SELECT * FROM databases WHERE id=?")
      .bind(targetId)
      .first(),
  ).toEqual(original);
  const ready = await request(
    "/agent/v1/observations",
    f.foreignAgent,
    "POST",
    observedBody([
      {
        ...observation(targetId, 1),
        recovery: {
          operation_id: target.operation.id,
          storage_generation: 2,
          verified: true,
        },
      },
    ]),
  );
  expect(ready.status).toBe(200);
  expect(
    await env.DB.prepare("SELECT status FROM operations WHERE id=?")
      .bind(target.operation.id)
      .first("status"),
  ).toBe("succeeded");
  const idem = crypto.randomUUID();
  expect((await request(f.path, f.admin, "PUT", rotation, idem)).status).toBe(
    200,
  );
  const after = await env.DB.prepare("SELECT * FROM databases WHERE id=?")
    .bind(targetId)
    .first<Record<string, unknown>>();
  expect(after).toMatchObject({
    generation: 2,
    observed_state: "provisioning",
    archive_path: original!.archive_path,
    storage_generation: original!.storage_generation,
    node_id: original!.node_id,
  });
  expect((await request(f.path, f.admin, "PUT", rotation, idem)).status).toBe(
    200,
  );
  expect(
    await env.DB.prepare("SELECT * FROM databases WHERE id=?")
      .bind(targetId)
      .first(),
  ).toEqual(after);
  expect(
    await env.DB.prepare("SELECT * FROM databases WHERE id=?")
      .bind(source.database.id)
      .first(),
  ).toEqual(sourceRow);
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.foreignAgent)).json(),
  );
  expect(desired.databases.find((d) => d.id === targetId)?.generation).toBe(2);
  expect(desired.region.recovery_sources?.[f.region]).toMatchObject(
    rotation.credentials,
  );
});

it("binds encrypted custody to both regions and revision while allowing credential-key rotation", async () => {
  const old = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const newer = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const oldRing = JSON.stringify({ active: "old", keys: { old } });
  const rotated = JSON.stringify({ active: "new", keys: { old, new: newer } });
  const identity = [
    "region-archive-source",
    "target-region",
    "source-region",
    1,
  ];
  const plaintext = JSON.stringify({
    access_key_id: crypto.randomUUID(),
    secret_access_key: crypto.randomUUID(),
  });
  const encrypted = await encryptCustodyDocument(oldRing, identity, plaintext);
  expect(await decryptCustodyDocument(rotated, identity, encrypted)).toBe(
    plaintext,
  );
  await expect(
    decryptCustodyDocument(
      rotated,
      ["region-archive-source", "foreign-target", "source-region", 1],
      encrypted,
    ),
  ).rejects.toThrow();
  await expect(
    decryptCustodyDocument(
      rotated,
      ["region-archive-source", "target-region", "foreign-source", 1],
      encrypted,
    ),
  ).rejects.toThrow();
  await expect(
    decryptCustodyDocument(
      rotated,
      ["region-archive-source", "target-region", "source-region", 2],
      encrypted,
    ),
  ).rejects.toThrow();
  expect((await encryptCustodyDocument(rotated, identity, plaintext)).kid).toBe(
    "new",
  );
});
