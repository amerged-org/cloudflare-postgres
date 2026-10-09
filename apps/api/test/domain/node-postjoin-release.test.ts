// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "./fixtures.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { readNodePostjoinRelease } from "../../src/domain/node-postjoin-release.ts";
import { standingPostjoinFixture } from "./postjoin-fixture.ts";
import {
  loadRegionSeed,
  loadRegionJoinBundle,
  storeRegionSeed,
  storeRegionJoinBundle,
  regionSeedReference,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
import { readRegionBootstrapMaterial } from "../../src/domain/region-material-revisions.ts";
const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
it("requires an approved common installer and selected bounded pool before future order, and rejects standing drift", async () => {
  const f = await fixture();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
  });
  await expect(readNodePostjoinRelease(env, f.region)).rejects.toMatchObject({
    code: "conflict",
  });
  const selected = await standingPostjoinFixture(f.region);
  releases.push(selected.id);
  const first = await readNodePostjoinRelease(env, f.region);
  expect(first.reference.release_id).toBe(selected.id);
  expect(first.reference.recipe_sha256).toBe(
    selected.spec.roles.customer.talos_schematic_sha256,
  );
  await env.DB.prepare(
    "UPDATE node_region_policies SET compute_pool_json=json_set(compute_pool_json,'$.target_slots',0) WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  await expect(
    readNodePostjoinRelease(env, f.region, first.reference),
  ).rejects.toMatchObject({ code: "conflict" });
  await env.DB.prepare(
    "UPDATE node_region_policies SET compute_pool_json=? WHERE region_id=?",
  )
    .bind(JSON.stringify(selected.policy), f.region)
    .run();
  await env.DB.prepare(
    "UPDATE fleet_region_releases SET revision=2 WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  await expect(
    readNodePostjoinRelease(env, f.region, first.reference),
  ).rejects.toMatchObject({ code: "conflict" });
});
it("preserves omitted legacy template updates and explicitly clears a selected template", async () => {
  const f = await fixture(),
    base = {
      region_id: f.region,
      max_nodes: 2,
      purchases_enabled: false,
      order: null,
    };
  await configureNodeRegionPolicy(env.DB, base);
  const selected = await standingPostjoinFixture(f.region);
  releases.push(selected.id);
  await configureNodeRegionPolicy(env.DB, base);
  expect((await readNodePostjoinRelease(env, f.region)).policy).toEqual(
    selected.policy,
  );
  await configureNodeRegionPolicy(env.DB, { ...base, compute_pool: null });
  await expect(readNodePostjoinRelease(env, f.region)).rejects.toMatchObject({
    code: "conflict",
  });
});

it("accepts supported security-fix material syntax but refuses drift from the exact approved regional role", async () => {
  const f = await fixture();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
  });
  const selected = await standingPostjoinFixture(f.region);
  releases.push(selected.id);
  expect(
    (await readNodePostjoinRelease(env, f.region)).release.spec.roles.customer
      .talos_version,
  ).toBe("1.14.1");
  const seed = await loadRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(f.region, 2),
  );
  const join = await loadRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 2),
  );
  await storeRegionSeed(
    env.DB,
    env.CREDENTIAL_KEYS,
    regionSeedReference(f.region, 3),
    { ...seed, talos_version: "1.14.2" },
  );
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 3),
    { ...join, talos_version: "1.14.2" },
  );
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=3 WHERE id=?",
  )
    .bind(f.region)
    .run();
  expect((await readRegionBootstrapMaterial(env, f.region)).talos_version).toBe(
    "1.14.2",
  );
  await expect(readNodePostjoinRelease(env, f.region)).rejects.toMatchObject({
    code: "conflict",
  });
});
