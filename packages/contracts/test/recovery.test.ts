// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { DatabaseRestore } from "../src/index.ts";

const request = {
  mode: "pitr",
  name: "restored",
  target_time: new Date().toISOString(),
};
it("requires a target time exactly for PITR and accepts an optional target region", () => {
  expect(DatabaseRestore.safeParse(request).success).toBe(true);
  expect(
    DatabaseRestore.safeParse({ mode: "full", name: "restored" }).success,
  ).toBe(true);
  expect(
    DatabaseRestore.safeParse({ mode: "pitr", name: "restored" }).success,
  ).toBe(false);
  expect(DatabaseRestore.safeParse({ ...request, mode: "full" }).success).toBe(
    false,
  );
  expect(
    DatabaseRestore.safeParse({ ...request, region_id: "us-test" }).success,
  ).toBe(true);
  expect(
    DatabaseRestore.safeParse({
      ...request,
      endpoint_url: "https://example.com",
    }).success,
  ).toBe(false);
});
