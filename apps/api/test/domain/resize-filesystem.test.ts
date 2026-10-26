// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  FILESYSTEM_END_GAP_BYTES,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
import { cleanupFixtures, fixture, report, request } from "./fixtures.ts";

const GIB = 1024 ** 3;
/** The size a filesystem has on a volume of `gib` GiB (the node agent's `fs_target_kib`). */
const filesystemOf = (gib: number) => gib * GIB - FILESYSTEM_END_GAP_BYTES;

const classes: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of classes.splice(0))
    await env.DB.prepare("DELETE FROM size_classes WHERE id=?").bind(id).run();
});

/** A database that is ready at its first generation, and a PATCH that grows its storage. */
async function growing(storage: number) {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  expect((await report(f, id, 1)).status).toBe(200);
  const target = "g" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  classes.push(target);
  await env.DB.prepare(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_mib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at)
     SELECT ?,memory_mib,cpu_millicores,?,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,1,created_at,updated_at FROM size_classes WHERE id=?`,
  )
    .bind(target, storage * 1024, f.size)
    .run();
  const resized = await request(`/v1/databases/${id}`, f.integrator, "PATCH", {
    size_class_id: target,
  });
  expect(resized.status).toBe(202);
  const operation = DatabaseWithOperation.parse(await resized.json()).operation;
  expect(operation.kind).toBe("database.resize");
  return { f, id, operation: operation.id };
}
const operationOf = (id: string) =>
  env.DB.prepare(
    "SELECT status,error_code,error_message,completed_at FROM operations WHERE id=?",
  )
    .bind(id)
    .first<{
      status: string;
      error_code: string | null;
      error_message: string | null;
      completed_at: string | null;
    }>();

describe("a resize ends when the filesystem has the storage", () => {
  it("stays running while the node reports a filesystem smaller than the storage, and ends with the one that has it", async () => {
    const { f, id, operation } = await growing(6);
    expect(await operationOf(operation)).toMatchObject({ status: "pending" });
    // The growth was refused (the kernel's -28): the database is ready at the new generation and
    // its filesystem is the old one. The operation is running, not done.
    expect(
      (await report(f, id, 2, "ready", { storage_bytes: filesystemOf(5) }))
        .status,
    ).toBe(200);
    expect(await operationOf(operation)).toMatchObject({
      status: "running",
      completed_at: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT observed_state,observed_generation,observed_storage_bytes FROM databases WHERE id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({
      observed_state: "ready",
      observed_generation: 2,
      observed_storage_bytes: filesystemOf(5),
    });
    // The same report again changes nothing.
    await report(f, id, 2, "ready", { storage_bytes: filesystemOf(5) });
    expect(await operationOf(operation)).toMatchObject({ status: "running" });
    // One byte short is short, and the filesystem the order asked for is enough.
    await report(f, id, 2, "ready", { storage_bytes: filesystemOf(6) - 1 });
    expect(await operationOf(operation)).toMatchObject({ status: "running" });
    expect(
      (await report(f, id, 2, "ready", { storage_bytes: filesystemOf(6) }))
        .status,
    ).toBe(200);
    expect(await operationOf(operation)).toMatchObject({
      status: "succeeded",
      error_code: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT observed_storage_bytes FROM databases WHERE id=?",
      )
        .bind(id)
        .first("observed_storage_bytes"),
    ).toBe(filesystemOf(6));
  });

  it("keeps a resize running when a report contains no filesystem size", async () => {
    const { f, id, operation } = await growing(6);
    expect(
      (await report(f, id, 2, "ready", { storage_bytes: undefined })).status,
    ).toBe(200);
    expect(await operationOf(operation)).toMatchObject({
      status: "running",
    });
    expect(
      await env.DB.prepare(
        "SELECT observed_storage_bytes FROM databases WHERE id=?",
      )
        .bind(id)
        .first("observed_storage_bytes"),
    ).toBe(filesystemOf(5));
  });

  it("ends the resize of a database that sleeps with the filesystem too", async () => {
    const { f, id, operation } = await growing(6);
    // A cold database is resized where it sleeps: its node says `asleep` with its sizes.
    await env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',suspension_reason='manual' WHERE id=?",
    )
      .bind(id)
      .run();
    await report(f, id, 2, "asleep", { storage_bytes: filesystemOf(5) });
    expect(await operationOf(operation)).toMatchObject({ status: "running" });
    await report(f, id, 2, "asleep", { storage_bytes: filesystemOf(7) });
    expect(await operationOf(operation)).toMatchObject({
      status: "succeeded",
    });
  });

  it("fails a resize whose filesystem did not grow for its own reason after 20 minutes, and a resize no node reported as before", async () => {
    const stuck = await growing(6);
    await report(stuck.f, stuck.id, 2, "ready", {
      storage_bytes: filesystemOf(5),
    });
    const silent = await growing(6);
    const old = new Date(Date.now() - 21 * 60_000).toISOString();
    await env.DB.prepare("UPDATE operations SET updated_at=? WHERE id IN(?,?)")
      .bind(old, stuck.operation, silent.operation)
      .run();
    await runCron(env);
    expect(await operationOf(stuck.operation)).toMatchObject({
      status: "failed",
      error_code: "filesystem_not_grown",
      error_message: expect.stringContaining("filesystem did not reach"),
    });
    expect(await operationOf(silent.operation)).toMatchObject({
      status: "failed",
      error_code: "operation_timeout",
    });
  });
});
