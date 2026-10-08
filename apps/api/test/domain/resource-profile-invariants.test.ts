// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

const profiles: string[] = [];
const resources = {
  memory_mib: 256,
  cpu_millicores: 250,
  cpu_request_millicores: 25,
  storage_gib: 5,
  max_connections: 20,
  sleep_after_seconds: 60,
  archive_timeout_seconds: 60,
  backup_retention_days: 7,
  enabled: true,
};
function profileId() {
  const id = `entry-${crypto.randomUUID().slice(0, 8)}`;
  profiles.push(id);
  return id;
}
afterEach(async () => {
  await cleanupFixtures();
  for (const id of profiles.splice(0)) {
    const classes = await env.DB.prepare(
      "SELECT size_class_id FROM resource_profile_revisions WHERE profile_id=?",
    )
      .bind(id)
      .all<{ size_class_id: string }>();
    await env.DB.prepare(
      "DELETE FROM resource_profile_revisions WHERE profile_id=?",
    )
      .bind(id)
      .run();
    await env.DB.prepare("DELETE FROM resource_profiles WHERE id=?")
      .bind(id)
      .run();
    for (const row of classes.results)
      await env.DB.prepare("DELETE FROM size_classes WHERE id=?")
        .bind(row.size_class_id)
        .run();
  }
});

it("keeps an immutable profile snapshot consistent with its generated class before any database assignment", async () => {
  const f = await fixture();
  const id = profileId();
  const response = await request(
    `/v1/resource-profiles/${id}`,
    f.admin,
    "PUT",
    { expected_revision: 0, resources },
  );
  expect(response.status).toBe(200);
  const profile = (await response.json()) as {
    size_class_id: string;
    sha256: string;
  };
  const original = await env.DB.prepare("SELECT * FROM size_classes WHERE id=?")
    .bind(profile.size_class_id)
    .first();
  const changed = await request(
    `/v1/size-classes/${profile.size_class_id}`,
    f.admin,
    "PUT",
    { ...resources, memory_mib: 512 },
  );
  expect(changed.status).toBe(409);
  const disabled = await request(
    `/v1/size-classes/${profile.size_class_id}`,
    f.admin,
    "PUT",
    { ...resources, enabled: false },
  );
  expect(disabled.status).toBe(409);
  const identicalKey = crypto.randomUUID();
  expect(
    (
      await request(
        `/v1/size-classes/${profile.size_class_id}`,
        f.admin,
        "PUT",
        resources,
        identicalKey,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        `/v1/size-classes/${profile.size_class_id}`,
        f.admin,
        "PUT",
        resources,
        identicalKey,
      )
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare("SELECT * FROM size_classes WHERE id=?")
      .bind(profile.size_class_id)
      .first(),
  ).toEqual(original);
  expect(
    await (
      await request(`/v1/resource-profiles/${id}/revisions/1`, f.admin)
    ).json(),
  ).toMatchObject({ sha256: profile.sha256, resources });
});

it("leaves no partial profile on an invalid initial revision CAS", async () => {
  const f = await fixture();
  const id = profileId();
  const idem = crypto.randomUUID();
  const beforeClasses = await env.DB.prepare(
    "SELECT count(*) count FROM size_classes",
  ).first("count");
  expect(
    (
      await request(
        `/v1/resource-profiles/${id}`,
        f.admin,
        "PUT",
        { expected_revision: 1, resources },
        idem,
      )
    ).status,
  ).toBe(409);
  expect(
    await env.DB.prepare("SELECT * FROM resource_profiles WHERE id=?")
      .bind(id)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM resource_profile_revisions WHERE profile_id=?",
    )
      .bind(id)
      .first("count"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT count(*) count FROM size_classes").first(
      "count",
    ),
  ).toBe(beforeClasses);
  expect(
    await env.DB.prepare("SELECT * FROM idempotency_keys WHERE key=?")
      .bind(idem)
      .first(),
  ).toBeNull();
});
