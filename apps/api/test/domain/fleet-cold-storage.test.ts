// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request, stageRelease } from "./fixtures.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

it("refuses a native rollback after the region has stored a database only in R2", async () => {
  const f = await fixture();
  const release = `release-${crypto.randomUUID()}`;
  releases.push(release);
  const registration = await stageRelease(release);
  expect(
    (
      await request(
        `/v1/fleet/releases/${release}`,
        f.admin,
        "PUT",
        registration,
      )
    ).status,
  ).toBe(200);
  await env.DB.prepare(
    "UPDATE regions SET native_cold_storage_required=1 WHERE id=?",
  )
    .bind(f.region)
    .run();
  const assign = (qualification: string) =>
    request(
      `/v1/regions/${f.region}/release`,
      f.admin,
      "PUT",
      { expected_revision: 0, release_id: release },
      crypto.randomUUID(),
      undefined,
      { NATIVE_COLD_STORAGE_RELEASE_IDS: qualification },
    );
  expect((await assign("[]")).status).toBe(409);
  expect((await assign("malformed")).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT release_id FROM fleet_region_releases WHERE region_id=?",
    )
      .bind(f.region)
      .first(),
  ).toBeNull();
  expect((await assign(JSON.stringify([release]))).status).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT native_cold_storage_required FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first("native_cold_storage_required"),
  ).toBe(1);
});

it("does not require cold-storage qualification before the region has used the format", async () => {
  const f = await fixture();
  const release = `release-${crypto.randomUUID()}`;
  releases.push(release);
  const registration = await stageRelease(release);
  expect(
    (
      await request(
        `/v1/fleet/releases/${release}`,
        f.admin,
        "PUT",
        registration,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
        expected_revision: 0,
        release_id: release,
      })
    ).status,
  ).toBe(200);
});
