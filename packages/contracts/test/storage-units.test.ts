// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { SizeClassUpsert } from "../src/api.ts";
import {
  DatabaseEffectiveResources,
  DatabaseResources,
  DatabaseResourcesCreate,
  normalizeStorage,
  serializeStorage,
  serializeStorageOverride,
} from "../src/database-resources.ts";

const common = { memory_mib: 256, cpu_millicores: 250 };
const klass = {
  ...common,
  max_connections: 20,
  sleep_after_seconds: 300,
  archive_timeout_seconds: 60,
  backup_retention_days: 7,
  enabled: true,
};

describe("nominal storage units", () => {
  it("keeps old GiB requests exact and exposes an actual 500 MiB volume", () => {
    expect(SizeClassUpsert.parse({ ...klass, storage_gib: 2 })).toMatchObject({
      storage_gib: 2,
    });
    expect(normalizeStorage({ storage_gib: 2 })).toBe(2048);
    expect(SizeClassUpsert.parse({ ...klass, storage_mib: 500 })).toMatchObject(
      { storage_mib: 500 },
    );
    expect(normalizeStorage({ storage_mib: 500 })).toBe(500);
    expect(serializeStorage(2048)).toEqual({ storage_gib: 2 });
    expect(serializeStorage(500)).toEqual({ storage_mib: 500 });
    expect(
      DatabaseEffectiveResources.parse({ ...common, ...serializeStorage(500) }),
    ).toMatchObject({ storage_mib: 500 });
    expect(normalizeStorage({ storage_gib: 65536 })).toBe(67108864);
  });
  it("refuses conflicting units, misalignment and out-of-range sizes", () => {
    for (const storage of [
      { storage_gib: 1, storage_mib: 500 },
      {},
      { storage_gib: 0.5 },
      { storage_mib: 0 },
      { storage_mib: -4 },
      { storage_mib: 501 },
      { storage_mib: 500.5 },
      { storage_mib: 67108868 },
    ])
      expect(SizeClassUpsert.safeParse({ ...klass, ...storage }).success).toBe(
        false,
      );
    expect(() =>
      normalizeStorage({ storage_gib: 1, storage_mib: 500 }),
    ).toThrow("ambiguous_storage_units");
  });
  it("distinguishes an inherited override and omitted creation storage", () => {
    expect(DatabaseResourcesCreate.parse(common)).toEqual(common);
    expect(normalizeStorage({})).toBeUndefined();
    expect(normalizeStorage({ storage_mib: null })).toBeNull();
    expect(serializeStorageOverride(null)).toEqual({ storage_gib: null });
    expect(
      DatabaseResources.parse({
        memory_mib: null,
        cpu_millicores: null,
        storage_mib: null,
      }),
    ).toMatchObject({ storage_mib: null });
    expect(
      DatabaseResources.safeParse({
        memory_mib: null,
        cpu_millicores: null,
        storage_mib: null,
        storage_gib: null,
      }).success,
    ).toBe(false);
    expect(
      DatabaseResourcesCreate.safeParse({ storage_mib: 500, storage_gib: 1 })
        .success,
    ).toBe(false);
  });
});
