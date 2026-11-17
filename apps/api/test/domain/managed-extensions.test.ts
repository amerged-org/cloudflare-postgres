// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  addNode,
  cleanupFixtures,
  fixture,
  nodeRequest,
  qualifyExtendedNative,
  request,
  setNodePolicy,
  stageRelease,
} from "./fixtures.ts";

let legacyRelease: string | undefined;
let nextRelease: string | undefined;
afterEach(async () => {
  await cleanupFixtures();
  if (legacyRelease) {
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(legacyRelease)
      .run();
    legacyRelease = undefined;
  }
  if (nextRelease) {
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(nextRelease)
      .run();
    nextRelease = undefined;
  }
});

it("protects qualified lineage from release assignments issued by an older Worker", async () => {
  const f = await fixture();
  const first = (await qualifyExtendedNative(f)).id;
  const create = await request(
    "/v1/databases",
    f.admin,
    "POST",
    {
      project_id: f.project,
      region_id: f.region,
      size_class_id: f.size,
      name: "retained-compatible",
      managed_extensions: ["postgis"],
    },
    undefined,
    undefined,
    { NATIVE_MANAGED_EXTENSIONS_RELEASE_IDS: JSON.stringify([first]) },
  );
  expect(create.status).toBe(202);
  const id = DatabaseWithOperation.parse(await create.json()).database.id;
  legacyRelease = `release-${crypto.randomUUID()}`;
  nextRelease = `release-${crypto.randomUUID()}`;
  for (const release of [legacyRelease, nextRelease])
    expect(
      (
        await request(
          `/v1/fleet/releases/${release}`,
          f.admin,
          "PUT",
          await stageRelease(release),
        )
      ).status,
    ).toBe(200);
  const oldUpdate = (releaseId: string) =>
    env.DB.prepare(
      "UPDATE fleet_region_releases SET release_id=?,revision=revision+1 WHERE region_id=?",
    )
      .bind(releaseId, f.region)
      .run();
  await expect(oldUpdate(legacyRelease)).rejects.toThrow(
    "managed_extension_release_unqualified",
  );
  const assignment = (expected_revision: number) =>
    request(
      `/v1/regions/${f.region}/release`,
      f.admin,
      "PUT",
      { expected_revision, release_id: nextRelease },
      undefined,
      undefined,
      {
        NATIVE_MANAGED_EXTENSIONS_RELEASE_IDS: JSON.stringify([
          first,
          nextRelease,
        ]),
      },
    );
  expect((await assignment(0)).status).toBe(409);
  await expect(oldUpdate(nextRelease)).rejects.toThrow(
    "managed_extension_release_unqualified",
  );
  expect((await assignment(1)).status).toBe(200);
  await expect(oldUpdate(first)).resolves.toMatchObject({
    meta: { changes: 1 },
  });

  // Even a writer that replaces the assignment cannot reuse the region without qualification.
  await env.DB.prepare("DELETE FROM fleet_region_releases WHERE region_id=?")
    .bind(f.region)
    .run();
  await expect(
    env.DB.prepare(
      "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES(?,?,4,?)",
    )
      .bind(f.region, legacyRelease, new Date().toISOString())
      .run(),
  ).rejects.toThrow("managed_extension_release_unqualified");
  expect(
    await env.DB.prepare(
      "SELECT managed_extensions_json FROM databases WHERE id=?",
    )
      .bind(id)
      .first("managed_extensions_json"),
  ).toBe('["postgis"]');
});

it("admits closed managed extension opt-ins only on a qualified region and preserves its release floor", async () => {
  const f = await fixture();
  const release = await qualifyExtendedNative(f);
  const bindings = {
    NATIVE_MANAGED_EXTENSIONS_RELEASE_IDS: JSON.stringify([release.id]),
  };
  const create = (extensions: unknown, key = f.admin, enabled = bindings) =>
    request(
      "/v1/databases",
      key,
      "POST",
      {
        project_id: f.project,
        region_id: f.region,
        size_class_id: f.size,
        name: "managed-test",
        managed_extensions: extensions,
      },
      undefined,
      undefined,
      enabled,
    );
  expect((await create(["postgis", "postgis"])).status).toBe(400);
  expect((await create(["pg_trgm"])).status).toBe(400);
  expect((await create(["postgis"], f.integrator)).status).toBe(403);
  expect(
    (
      await create(["postgis"], f.admin, {
        NATIVE_MANAGED_EXTENSIONS_RELEASE_IDS: "[]",
      })
    ).status,
  ).toBe(409);

  const unqualified = await addNode(f.region);
  expect((await create(["postgis"])).status).toBe(409);
  await env.DB.prepare("UPDATE nodes SET lost_at=? WHERE id=?")
    .bind(new Date().toISOString(), unqualified)
    .run();

  const response = await create(["postgis", "pg_jsonschema"]);
  expect(response.status).toBe(202);
  const { database } = DatabaseWithOperation.parse(await response.json());
  expect(database.managed_extensions).toEqual(["pg_jsonschema", "postgis"]);
  await setNodePolicy(f);
  const desired = await nodeRequest(f, "/node/v1/desired", { bindings });
  expect(desired.status).toBe(200);
  expect(await desired.json()).toMatchObject({
    databases: [
      expect.objectContaining({
        id: database.id,
        origin: { kind: "create" },
        managed_extensions: ["pg_jsonschema", "postgis"],
      }),
    ],
  });

  legacyRelease = `release-${crypto.randomUUID()}`;
  expect(
    (
      await request(
        `/v1/fleet/releases/${legacyRelease}`,
        f.admin,
        "PUT",
        await stageRelease(legacyRelease),
      )
    ).status,
  ).toBe(200);
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), database.id)
    .run();
  expect(
    (
      await request(
        `/v1/regions/${f.region}/release`,
        f.admin,
        "PUT",
        { expected_revision: 1, release_id: legacyRelease },
        undefined,
        undefined,
        bindings,
      )
    ).status,
  ).toBe(409);
});
