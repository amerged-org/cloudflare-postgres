// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DatabaseId,
  RegionId,
  RoleName,
  isDatabaseId,
  isOperationId,
  isProjectId,
  isRegionId,
  isReservedRoleName,
  isRoleName,
  newApiKeyId,
  newDatabaseId,
  newId,
  newNodeId,
  newOperationId,
  newProjectId,
  randomString,
} from "../src/index.ts";

describe("ids", () => {
  it("generates prefixed IDs with 20 characters from [a-z0-9]", () => {
    for (const [id, prefix] of [
      [newProjectId(), "prj_"],
      [newOperationId(), "op_"],
      [newApiKeyId(), "key_"],
      [newNodeId(), "nod_"],
    ] as const) {
      expect(id.startsWith(prefix)).toBe(true);
      expect(id.slice(prefix.length)).toMatch(/^[a-z0-9]{20}$/);
    }
  });

  it("generates database IDs that start with a letter and are unique over a sample", () => {
    const sample = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      const id = newDatabaseId();
      expect(id).toMatch(/^[a-z][a-z0-9]{19}$/);
      sample.add(id);
    }
    expect(sample.size).toBe(5000);
  });

  it("uses the whole alphabet", () => {
    const seen = new Set(
      randomString("abcdefghijklmnopqrstuvwxyz0123456789", 20_000),
    );
    expect(seen.size).toBe(36);
    const ids = new Set(Array.from({ length: 1000 }, () => newId("prj_")));
    expect(ids.size).toBe(1000);
  });

  it("rejects database ID edge cases", () => {
    expect(isDatabaseId("a".repeat(20))).toBe(true);
    expect(isDatabaseId("a".repeat(19))).toBe(false);
    expect(isDatabaseId("a".repeat(21))).toBe(false);
    expect(isDatabaseId("1" + "a".repeat(19))).toBe(false);
    expect(isDatabaseId("A" + "a".repeat(19))).toBe(false);
    expect(isDatabaseId("a".repeat(19) + "_")).toBe(false);
    expect(isDatabaseId("a".repeat(20) + "\n")).toBe(false);
    expect(isDatabaseId(42)).toBe(false);
    expect(DatabaseId.safeParse("b" + "0".repeat(19)).success).toBe(true);
  });

  it("checks prefixed IDs strictly", () => {
    expect(isProjectId("prj_" + "a".repeat(20))).toBe(true);
    expect(isProjectId("prj_" + "A".repeat(20))).toBe(false);
    expect(isProjectId("op_" + "a".repeat(20))).toBe(false);
    expect(isOperationId("op_" + "a".repeat(19))).toBe(false);
  });

  it("validates region IDs", () => {
    expect(isRegionId("eu-1")).toBe(true);
    expect(isRegionId("eu")).toBe(false);
    expect(isRegionId("eu-")).toBe(false);
    expect(isRegionId("1eu")).toBe(false);
    expect(isRegionId("eu_1")).toBe(false);
    expect(RegionId.safeParse("a".repeat(33)).success).toBe(false);
  });

  it("rejects reserved role names", () => {
    for (const name of [
      "postgres",
      "streaming_replica",
      "pg_monitor",
      "pg_",
      "cnpg_pooler_pgbouncer",
    ]) {
      expect(isReservedRoleName(name)).toBe(true);
      expect(isRoleName(name)).toBe(false);
      expect(RoleName.safeParse(name).success).toBe(false);
    }
    for (const name of [
      "app",
      "reader",
      "postgres2",
      "pgx",
      "a" + "b".repeat(62),
    ]) {
      expect(isRoleName(name)).toBe(true);
    }
    expect(isRoleName("a".repeat(64))).toBe(false);
    expect(isRoleName("App")).toBe(false);
    expect(isRoleName("_app")).toBe(false);
  });
});
