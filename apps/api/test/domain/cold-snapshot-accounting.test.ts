// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { Database, newOperationId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { coldSnapshotStorageView } from "../../src/domain/cold-snapshot-accounting.ts";
import { retireColdSnapshots } from "../../src/domain/cold-snapshot-retention.ts";
import { cleanup, lifecycle } from "./lifecycle-fixture.ts";
import { insertSnapshotArchive } from "./cold-snapshot-fixture.ts";
import { request } from "./fixtures.ts";

const keys: string[] = [];
afterEach(async () => {
  if (keys.length) await env.ARCHIVE.delete(keys.splice(0));
  await cleanup();
});
const get = async (f: Awaited<ReturnType<typeof lifecycle>>) => {
  const response = await request(`/v1/databases/${f.id}`, f.integrator);
  expect(response.status).toBe(200);
  return Database.parse(await response.json()).cold_snapshot_storage!;
};
async function snapshot(phase: "capturing" | "archived") {
  const f = await lifecycle(),
    row = await f.row(),
    op = newOperationId(),
    now = Date.now(),
    at = new Date(now).toISOString();
  await env.DB.prepare(
    `INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at)
    VALUES(?,'database.archive',?,?,?,1,?,?,?)`,
  )
    .bind(
      op,
      phase === "capturing" ? "running" : "succeeded",
      f.project,
      f.id,
      at,
      at,
      phase === "capturing" ? null : at,
    )
    .run();
  const prefix = await insertSnapshotArchive({
    operation: op,
    id: f.id,
    project: f.project,
    region: f.region,
    node: f.node,
    path: row.archive_path,
    at,
    phase,
  });
  await env.DB.prepare(
    "UPDATE databases SET storage_residency=?,storage_operation_id=? WHERE id=?",
  )
    .bind(phase === "capturing" ? "archiving" : "archived", op, f.id)
    .run();
  const manifest = prefix + "manifest.json",
    chunk = prefix + "chunks/00000000";
  keys.push(manifest, chunk);
  await env.ARCHIVE.put(manifest, new Uint8Array(17));
  await env.DB.prepare(
    "INSERT INTO cold_snapshot_chunks(operation,chunk_index,size_bytes,sha256,state,created_at,updated_at) VALUES(?,0,9,?,'expected',?,?)",
  )
    .bind(op, "b".repeat(64), at, at)
    .run();
  const commit = async () => {
    const payload = await env.ARCHIVE.put(chunk, new Uint8Array(9));
    await env.DB.prepare(
      "UPDATE cold_snapshot_chunks SET state='committed',r2_version=?,committed_at=? WHERE operation=?",
    )
      .bind(payload!.version, at, op)
      .run();
  };
  return { ...f, op, now, at, manifest, chunk, commit };
}

it("exposes known zero and the same bounded accounting on project-authorized get and list", async () => {
  const f = await lifecycle();
  const first = await get(f);
  expect(first).toMatchObject({
    payload_bytes: 0,
    retained_payload_bytes: 0,
    gaps: [],
  });
  expect(first.accounted_at).toBeNull();
  expect(
    await get(f),
    "unchanged reads do not invent a fresh accounting observation",
  ).toEqual(first);
  expect(Object.keys(first).sort()).toEqual([
    "accounted_at",
    "gaps",
    "payload_bytes",
    "retained_payload_bytes",
  ]);
  const listed = await request(
    `/v1/databases?project_id=${f.project}`,
    f.integrator,
  );
  expect(listed.status).toBe(200);
  const page = await listed.json<{ data: Database[] }>();
  expect(page.data[0]!.cold_snapshot_storage).toMatchObject({
    payload_bytes: 0,
    retained_payload_bytes: 0,
    gaps: [],
  });
  expect((await request(`/v1/databases/${f.id}`, f.otherKey)).status).toBe(404);
});

it("accounts acknowledged partial captures but leaves accepted unfinished PUTs unknown", async () => {
  const f = await snapshot("capturing");
  await env.DB.prepare(
    "UPDATE database_cold_storage SET snapshot_manifest_declared_at=NULL WHERE operation=?",
  )
    .bind(f.op)
    .run();
  expect(await get(f)).toMatchObject({
    payload_bytes: null,
    retained_payload_bytes: 0,
    gaps: ["upload_pending"],
  });
  await env.DB.prepare(
    "UPDATE database_cold_storage SET snapshot_manifest_declared_at=? WHERE operation=?",
  )
    .bind(f.at, f.op)
    .run();
  // Manifest acknowledged, no chunk PUT accepted: only the manifest occupies payload bytes.
  expect(await get(f)).toMatchObject({
    payload_bytes: 17,
    retained_payload_bytes: 0,
    gaps: [],
  });
  await env.DB.prepare(
    "UPDATE cold_snapshot_chunks SET state='uploading' WHERE operation=?",
  )
    .bind(f.op)
    .run();
  expect(await get(f)).toMatchObject({
    payload_bytes: null,
    retained_payload_bytes: 0,
    gaps: ["upload_pending"],
  });
  await f.commit();
  expect(await get(f)).toMatchObject({
    payload_bytes: 26,
    retained_payload_bytes: 0,
    gaps: [],
  });
});

it("separates retained source copies and reports unknown retirement until zero-byte fences are acknowledged", async () => {
  const f = await snapshot("archived");
  await f.commit();
  expect(await get(f)).toMatchObject({
    payload_bytes: 26,
    retained_payload_bytes: 0,
    gaps: [],
  });
  await env.DB.prepare(
    "UPDATE databases SET storage_residency='local' WHERE id=?",
  )
    .bind(f.id)
    .run();
  await env.DB.prepare(
    "UPDATE database_cold_storage SET snapshot_retained_until=? WHERE operation=?",
  )
    .bind(f.at, f.op)
    .run();
  expect(await get(f)).toMatchObject({
    payload_bytes: 26,
    retained_payload_bytes: 26,
    gaps: [],
  });
  await env.DB.prepare(
    "UPDATE database_cold_storage SET cleanup_fenced_at=? WHERE operation=?",
  )
    .bind(f.at, f.op)
    .run();
  expect(await get(f)).toMatchObject({
    payload_bytes: null,
    retained_payload_bytes: null,
    gaps: ["retirement_pending"],
  });
  expect((await retireColdSnapshots(env, f.now)).snapshots_retired).toBe(1);
  expect(await get(f)).toMatchObject({
    payload_bytes: 0,
    retained_payload_bytes: 0,
    gaps: [],
  });
  expect((await env.ARCHIVE.head(f.chunk))!.size).toBe(0);
  expect((await env.ARCHIVE.head(f.manifest))!.size).toBe(0);
});

it("does not turn missing or invalid ledger projections into zero", () => {
  expect(coldSnapshotStorageView(undefined)).toEqual({
    payload_bytes: null,
    retained_payload_bytes: null,
    accounted_at: null,
    gaps: ["metadata_incomplete"],
  });
  expect(
    coldSnapshotStorageView('{"payload_bytes":-1}').payload_bytes,
  ).toBeNull();
});
