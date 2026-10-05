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

async function pageFixture() {
  const f = await setup();
  await put(f.prefix, "fixture", 3);
  const page = await env.ARCHIVE.list({ prefix: f.prefix });
  return { ...f, page, object: page.objects[0]! };
}
it("walks more than one thousand real-shaped objects and records only after valid completion", async () => {
  const f = await pageFixture();
  const first = Array.from({ length: 1000 }, (_, index) => ({
    ...f.object,
    key: `${f.prefix}wal/${index}`,
    size: 2,
  }));
  const list = vi
    .spyOn(Object.getPrototypeOf(env.ARCHIVE), "list")
    .mockResolvedValueOnce({
      ...f.page,
      objects: first,
      truncated: true,
      cursor: "second-page",
    })
    .mockResolvedValueOnce({
      ...f.page,
      objects: [{ ...f.object, key: `${f.prefix}wal/1000`, size: 7 }],
      truncated: false,
    });
  const result = await measureBackupUsage(env, f.id);
  expect(list).toHaveBeenCalledTimes(2);
  expect(list.mock.calls[1]![0]).toEqual({
    prefix: f.prefix,
    limit: 1000,
    cursor: "second-page",
  });
  expect(result.status).toBe("measured");
  expect(result.objects).toBe(1001);
  expect(result.sample?.backup_bytes).toBe(2007);
  const stored = await env.DB.prepare(
    "SELECT payload FROM usage_samples WHERE database_id=? AND source='backup'",
  )
    .bind(f.id)
    .first<string>("payload");
  expect(JSON.parse(stored!).backup_bytes).toBe(2007);
});
it("refuses missing or repeated page cursors without a partial gauge", async () => {
  const f = await pageFixture();
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "list").mockResolvedValueOnce({
    ...f.page,
    truncated: true,
    cursor: "",
  });
  const missing = await measureBackupUsage(env, f.id);
  expect(missing.status).toBe("unavailable");
  expect(missing.sample?.backup_bytes).toBeNull();
  const list = vi
    .spyOn(Object.getPrototypeOf(env.ARCHIVE), "list")
    .mockReset()
    .mockResolvedValueOnce({ ...f.page, truncated: true, cursor: "repeated" })
    .mockResolvedValueOnce({
      ...f.page,
      objects: [{ ...f.object, key: `${f.prefix}second` }],
      truncated: true,
      cursor: "repeated",
    });
  const repeated = await measureBackupUsage(env, f.id);
  expect(repeated.status).toBe("unavailable");
  expect(repeated.sample?.backup_bytes).toBeNull();
  expect(list.mock.calls.at(-1)![0]).toMatchObject({ cursor: "repeated" });
});
it("rejects cross-page duplicate and foreign keys even when the final page completes", async () => {
  const f = await pageFixture();
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "list")
    .mockResolvedValueOnce({
      ...f.page,
      truncated: true,
      cursor: "duplicate-page",
    })
    .mockResolvedValueOnce(f.page);
  const duplicate = await measureBackupUsage(env, f.id);
  expect(duplicate.status).toBe("unavailable");
  expect(duplicate.sample?.backup_bytes).toBeNull();
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "list")
    .mockReset()
    .mockResolvedValueOnce({
      ...f.page,
      truncated: true,
      cursor: "foreign-page",
    })
    .mockResolvedValueOnce({
      ...f.page,
      objects: [{ ...f.object, key: "outside/fixture" }],
    });
  const foreign = await measureBackupUsage(env, f.id);
  expect(foreign.status).toBe("unavailable");
  expect(foreign.sample?.backup_bytes).toBeNull();
});
it("drops all accumulated bytes when a later page fails", async () => {
  const f = await pageFixture();
  const list = vi
    .spyOn(Object.getPrototypeOf(env.ARCHIVE), "list")
    .mockResolvedValueOnce({
      ...f.page,
      truncated: true,
      cursor: "failed-page",
    })
    .mockRejectedValueOnce(new Error("fixture later page failure"));
  const result = await measureBackupUsage(env, f.id);
  expect(list).toHaveBeenCalledTimes(2);
  expect(result.status).toBe("unavailable");
  expect(result.sample?.backup_bytes).toBeNull();
});
it("uses one total deadline for the walk and stops after a late later page", async () => {
  const f = await pageFixture();
  let enterFirst!: () => void, enterSecond!: () => void;
  let finishFirst!: (value: R2Objects) => void,
    finishSecond!: (value: R2Objects) => void;
  const firstEntered = new Promise<void>((resolve) => {
    enterFirst = resolve;
  });
  const secondEntered = new Promise<void>((resolve) => {
    enterSecond = resolve;
  });
  const firstPending = new Promise<R2Objects>((resolve) => {
    finishFirst = resolve;
  });
  const secondPending = new Promise<R2Objects>((resolve) => {
    finishSecond = resolve;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const list = vi
    .spyOn(Object.getPrototypeOf(env.ARCHIVE), "list")
    .mockImplementationOnce(() => {
      enterFirst();
      return firstPending;
    })
    .mockImplementationOnce(() => {
      enterSecond();
      return secondPending;
    });
  try {
    const measurement = measureBackupUsage(env, f.id);
    await firstEntered;
    await vi.advanceTimersByTimeAsync(1500);
    finishFirst({ ...f.page, truncated: true, cursor: "late-page" });
    await Promise.race([
      secondEntered,
      measurement.then(() => {
        throw new Error("walk completed before second page");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(BACKUP_LIST_DEADLINE_MS - 1500 + 1);
    const result = await measurement;
    expect(result.status).toBe("unavailable");
    expect(result.sample?.backup_bytes).toBeNull();
    finishSecond({
      ...f.page,
      objects: [],
      truncated: true,
      cursor: "never-requested",
    });
    await secondPending;
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(2);
    const stored = await env.DB.prepare(
      "SELECT payload FROM usage_samples WHERE database_id=? AND source='backup'",
    )
      .bind(f.id)
      .first<string>("payload");
    expect(JSON.parse(stored!).backup_bytes).toBeNull();
  } finally {
    finishFirst(f.page);
    finishSecond(f.page);
    vi.useRealTimers();
  }
});
it("bounds page count even when every page supplies a fresh cursor", async () => {
  const f = await pageFixture();
  let calls = 0;
  vi.spyOn(Object.getPrototypeOf(env.ARCHIVE), "list").mockImplementation(
    async () => ({
      ...f.page,
      objects: [{ ...f.object, key: `${f.prefix}page-${++calls}` }],
      truncated: true,
      cursor: `page-${calls}`,
    }),
  );
  const result = await measureBackupUsage(env, f.id);
  expect(calls).toBe(16);
  expect(result.status).toBe("unavailable");
  expect(result.sample?.backup_bytes).toBeNull();
});

it("bounds retained key memory and opaque cursor size without partial samples", async () => {
  const f = await pageFixture();
  let pages = 0;
  const list = vi
    .spyOn(Object.getPrototypeOf(env.ARCHIVE), "list")
    .mockImplementation(async () => {
      const page = ++pages;
      return {
        ...f.page,
        objects: Array.from({ length: 1000 }, (_, index) => ({
          ...f.object,
          key: `${f.prefix}${page}-${index}-${"x".repeat(900)}`,
        })),
        truncated: true,
        cursor: `page-${page}`,
      };
    });
  const bounded = await measureBackupUsage(env, f.id);
  expect(pages).toBeLessThan(16);
  expect(bounded.status).toBe("unavailable");
  expect(bounded.sample?.backup_bytes).toBeNull();
  list.mockReset().mockResolvedValueOnce({
    ...f.page,
    truncated: true,
    cursor: "x".repeat(2049),
  });
  const oversized = await measureBackupUsage(env, f.id);
  expect(list).toHaveBeenCalledTimes(1);
  expect(oversized.status).toBe("unavailable");
  expect(oversized.sample?.backup_bytes).toBeNull();
});
it("accepts the finite object ceiling only with a completing page and safe byte sum", async () => {
  const f = await pageFixture();
  let pages = 0;
  const list = vi
    .spyOn(Object.getPrototypeOf(env.ARCHIVE), "list")
    .mockImplementation(async () => {
      const page = ++pages;
      return {
        ...f.page,
        objects: Array.from({ length: 1000 }, (_, index) => ({
          ...f.object,
          key: `${f.prefix}${page}-${index}`,
          size: 1,
        })),
        truncated: page < 16,
        cursor: `page-${page}`,
      };
    });
  const complete = await measureBackupUsage(env, f.id);
  expect(pages).toBe(16);
  expect(complete.status).toBe("measured");
  expect(complete.objects).toBe(16000);
  expect(complete.sample?.backup_bytes).toBe(16000);
  list
    .mockReset()
    .mockResolvedValueOnce({
      ...f.page,
      objects: [{ ...f.object, size: Number.MAX_SAFE_INTEGER }],
      truncated: true,
      cursor: "overflow",
    })
    .mockResolvedValueOnce({
      ...f.page,
      objects: [{ ...f.object, key: `${f.prefix}overflow`, size: 1 }],
    });
  const overflow = await measureBackupUsage(env, f.id);
  expect(overflow.status).toBe("unavailable");
  expect(overflow.sample?.backup_bytes).toBeNull();
});
