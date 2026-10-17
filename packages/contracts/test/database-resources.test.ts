// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DatabaseCreate,
  DatabaseResources,
  DatabaseResourcesCreate,
} from "../src/index.ts";

describe("database resources", () => {
  it("sets every field: a value in range, or null for the size class", () => {
    expect(
      DatabaseResources.safeParse({
        memory_mib: 512,
        cpu_millicores: 250,
        storage_gib: 10,
      }).success,
    ).toBe(true);
    expect(
      DatabaseResources.safeParse({
        memory_mib: null,
        cpu_millicores: null,
        storage_gib: null,
      }).success,
    ).toBe(true);
    // PUT replaces: a body that leaves a field out would silently hand it back.
    expect(
      DatabaseResources.safeParse({ memory_mib: 512, cpu_millicores: 250 })
        .success,
    ).toBe(false);
  });

  it("holds memory to steps of 256 MiB and CPU and storage to their floors", () => {
    for (const memory_mib of [0, 128, 300, 257, 256.5, -256])
      expect(
        DatabaseResources.safeParse({
          memory_mib,
          cpu_millicores: null,
          storage_gib: null,
        }).success,
        String(memory_mib),
      ).toBe(false);
    for (const cpu_millicores of [0, 99, 100.5])
      expect(
        DatabaseResources.safeParse({
          memory_mib: null,
          cpu_millicores,
          storage_gib: null,
        }).success,
        String(cpu_millicores),
      ).toBe(false);
    for (const storage_gib of [0, -1, 1.5])
      expect(
        DatabaseResources.safeParse({
          memory_mib: null,
          cpu_millicores: null,
          storage_gib,
        }).success,
        String(storage_gib),
      ).toBe(false);
    expect(
      DatabaseResources.safeParse({
        memory_mib: 256,
        cpu_millicores: 100,
        storage_gib: 1,
      }).success,
    ).toBe(true);
  });

  it("refuses unknown fields", () => {
    expect(
      DatabaseResources.safeParse({
        memory_mib: null,
        cpu_millicores: null,
        storage_gib: null,
        swap_mib: 0,
      }).success,
    ).toBe(false);
  });

  it("lets a create leave fields out and carries the resources next to the size class", () => {
    expect(DatabaseResourcesCreate.safeParse({}).success).toBe(true);
    expect(
      DatabaseResourcesCreate.safeParse({ memory_mib: 1024 }).success,
    ).toBe(true);
    expect(
      DatabaseResourcesCreate.safeParse({ memory_mib: null }).success,
    ).toBe(false);
    const body = {
      project_id: "prj_abcdefghij1234567890",
      region_id: "eu-1",
      name: "orders",
      size_class_id: "small",
    };
    expect(DatabaseCreate.safeParse(body).success).toBe(true);
    expect(
      DatabaseCreate.safeParse({ ...body, resources: { storage_gib: 20 } })
        .success,
    ).toBe(true);
    expect(
      DatabaseCreate.safeParse({ ...body, resources: { memory_mib: 100 } })
        .success,
    ).toBe(false);
  });
});
