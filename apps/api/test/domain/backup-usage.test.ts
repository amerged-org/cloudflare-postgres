// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  DatabaseWithOperation,
  archiveDestinationPath,
  newOperationId,
} from "@pgcf/contracts";
import {
  BACKUP_LIST_DEADLINE_MS,
  measureBackupUsage,
} from "../../src/domain/backup-usage.ts";
import { recordUsageSample } from "../../src/domain/usage.ts";
import { fixture, cleanupFixtures } from "./fixtures.ts";

const keys: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (keys.length) await env.ARCHIVE.delete(keys.splice(0));
  await cleanupFixtures();
});

it("bounds the listing deadline and never consumes a late result after timeout", async () => {
  const f = await setup(),
    empty = await env.ARCHIVE.list({ prefix: f.prefix });
  let started!: () => void, complete!: (listing: R2Objects) => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<R2Objects>((resolve) => {
    complete = resolve;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "list").mockImplementationOnce(
    () => {
      started();
      return pending;
    },
  );
  try {
    const measurement = measureBackupUsage(env, f.id);
    await entered;
    await vi.advanceTimersByTimeAsync(BACKUP_LIST_DEADLINE_MS + 1);
    const result = await measurement;
    expect(result.status).toBe("unavailable");
    expect(result.sample?.backup_bytes).toBeNull();
    complete(empty);
    await pending;
    expect(
      JSON.parse(
        (await env.DB.prepare(
          "SELECT payload FROM usage_samples WHERE database_id=?",
        )
          .bind(f.id)
          .first<string>("payload"))!,
      ).backup_bytes,
    ).toBeNull();
  } finally {
    complete(empty);
    vi.useRealTimers();
  }
});
async function setup() {
  const f = await fixture(),
    created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id,
    path = (await env.DB.prepare(
      "SELECT archive_path FROM databases WHERE id=?",
    )
      .bind(id)
      .first<string>("archive_path"))!;
  const prefix = `${f.region}/${id}/${path.slice(path.lastIndexOf("/") + 1)}/database/`;
  return { ...f, id, path, prefix };
}
async function put(prefix: string, name: string, bytes: number) {
  const key = `${prefix}${name}`;
  keys.push(key);
  await env.ARCHIVE.put(key, new Uint8Array(bytes));
}
it("records only the exact complete real R2 database prefix with actual byte sizes", async () => {
  const f = await setup();
  await put(f.prefix, "base/fixture/backup.info", 7);
  await put(f.prefix, "wals/fixture", 11);
  await put(`${f.region}/other/`, "foreign", 101);
  const result = await measureBackupUsage(env, f.id);
  expect(result.status).toBe("measured");
  expect(result.sample?.backup_bytes).toBe(18);
  expect(result.objects).toBe(2);
  const sample = await env.DB.prepare(
    "SELECT payload FROM usage_samples WHERE database_id=? AND source='backup'",
  )
    .bind(f.id)
    .first<string>("payload");
  expect(JSON.parse(sample!).backup_bytes).toBe(18);
});
it("distinguishes an exact empty prefix from an unavailable binding or list failure", async () => {
  const f = await setup();
  expect((await measureBackupUsage(env, f.id)).sample?.backup_bytes).toBe(0);
  const wrong = await measureBackupUsage(
    { ...env, ARCHIVE_BUCKET_NAME: "unmatched-bucket" },
    f.id,
  );
  expect(wrong.status).toBe("unavailable");
  expect(wrong.sample?.backup_bytes).toBeNull();
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "list").mockRejectedValueOnce(
    new Error("fixture list failure"),
  );
  const failed = await measureBackupUsage(env, f.id);
  expect(failed.status).toBe("unavailable");
  expect(failed.sample?.backup_bytes).toBeNull();
});
it("never reports a partial total from a truncated native R2 page", async () => {
  const f = await setup();
  await put(f.prefix, "fixture", 17);
  const original = env.ARCHIVE.list.bind(env.ARCHIVE);
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "list").mockImplementationOnce(
    async (...args: unknown[]) => ({
      ...(await original(args[0] as R2ListOptions)),
      truncated: true,
      cursor: "fixture-next-page",
    }),
  );
  const result = await measureBackupUsage(env, f.id);
  expect(result.status).toBe("unavailable");
  expect(result.sample?.backup_bytes).toBeNull();
});
it("refuses restored or deleted archive identity races before writing a wrong-source gauge", async () => {
  const f = await setup();
  await put(f.prefix, "fixture", 19);
  const original = env.ARCHIVE.list.bind(env.ARCHIVE);
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "list").mockImplementationOnce(
    async (...args: unknown[]) => {
      const result = await original(args[0] as R2ListOptions);
      await env.DB.prepare(
        "UPDATE databases SET archive_path=?,generation=2 WHERE id=?",
      )
        .bind(
          archiveDestinationPath(
            env.ARCHIVE_BUCKET_NAME,
            f.region,
            f.id,
            2,
            newOperationId(),
          ),
          f.id,
        )
        .run();
      return result;
    },
  );
  const result = await measureBackupUsage(env, f.id);
  expect(result.status).toBe("unavailable");
  expect(result.sample).toBeUndefined();
  expect(
    await env.DB.prepare(
      "SELECT payload FROM usage_samples WHERE database_id=? AND source='backup'",
    )
      .bind(f.id)
      .first(),
  ).toBeNull();
});

it("ignores unrelated configuration revisions while preserving exact immutable sample replay", async () => {
  const f = await setup();
  await put(f.prefix, "fixture", 23);
  const original = env.ARCHIVE.list.bind(env.ARCHIVE);
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "list").mockImplementationOnce(
    async (...args: unknown[]) => {
      const listing = await original(args[0] as R2ListOptions);
      await env.DB.prepare(
        "UPDATE databases SET generation=generation+1 WHERE id=?",
      )
        .bind(f.id)
        .run();
      return listing;
    },
  );
  const measured = await measureBackupUsage(env, f.id);
  expect(measured.status).toBe("measured");
  const identity = {
    archive_path: f.path,
    region_id: f.region,
    backup_bucket: env.ARCHIVE_BUCKET_NAME,
    deleted_at: null,
  };
  expect(
    await recordUsageSample(
      env.DB,
      { source: "backup", region_id: f.region },
      measured.sample!,
      Date.now(),
      identity,
    ),
  ).toBe("duplicate");
  await expect(
    recordUsageSample(
      env.DB,
      { source: "backup", region_id: f.region },
      { ...measured.sample!, backup_bytes: 24 },
      Date.now(),
      identity,
    ),
  ).rejects.toThrow("identity");
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM usage_samples WHERE database_id=?",
      )
        .bind(f.id)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});

it("checks source deletion atomically in the actual recorder INSERT after the outer identity recheck", async () => {
  const f = await setup();
  await put(f.prefix, "fixture", 29);
  const prepare = env.DB.prepare.bind(env.DB);
  let injected = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "run")
          return async () => {
            if (!injected) {
              injected = true;
              await prepare(
                "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
              )
                .bind(new Date().toISOString(), f.id)
                .run();
            }
            return target.run();
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  vi.spyOn(Object.getPrototypeOf(env.DB), "prepare").mockImplementation(
    (...args: unknown[]) => {
      const sql = String(args[0]),
        statement = prepare(sql);
      return sql.includes("INSERT OR IGNORE INTO usage_samples")
        ? wrap(statement)
        : statement;
    },
  );
  const result = await measureBackupUsage(env, f.id);
  expect(injected).toBe(true);
  expect(result.status).toBe("unavailable");
  expect(result.sample).toBeUndefined();
  expect(
    await prepare("SELECT payload FROM usage_samples WHERE database_id=?")
      .bind(f.id)
      .first(),
  ).toBeNull();
});

it("rejects duplicated keys and invalid object sizes without publishing a partial total", async () => {
  const f = await setup();
  await put(f.prefix, "fixture", 31);
  const original = env.ARCHIVE.list.bind(env.ARCHIVE);
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "list").mockImplementationOnce(
    async (...args: unknown[]) => {
      const listing = await original(args[0] as R2ListOptions);
      return { ...listing, objects: [...listing.objects, listing.objects[0]!] };
    },
  );
  expect((await measureBackupUsage(env, f.id)).sample?.backup_bytes).toBeNull();
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "list").mockImplementationOnce(
    async (...args: unknown[]) => {
      const listing = await original(args[0] as R2ListOptions);
      return {
        ...listing,
        objects: [
          { ...listing.objects[0]!, size: Number.MAX_SAFE_INTEGER + 1 },
        ],
      };
    },
  );
  expect((await measureBackupUsage(env, f.id)).sample?.backup_bytes).toBeNull();
});
