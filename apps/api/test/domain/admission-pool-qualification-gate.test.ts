// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  FleetReleaseSpec,
  DesiredResponse,
  newOperationId,
} from "@pgcf/contracts";
import { postgresPoolFixture } from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures, request } from "./fixtures.ts";
import {
  postgresPoolCapable,
  postgresPoolQualificationCapable,
  readDesiredFleetRelease,
} from "../../src/domain/fleet-releases.ts";
afterEach(async () => {
  await cleanupFixtures();
  await env.DB.prepare(
    "DELETE FROM postgres_pool_qualification_receipts WHERE candidate_release_id IN(SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(admissionFixtureReleases))
    .run();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
it("a new physical patch cannot reuse an older confirmed receipt of the same release and assignment", async () => {
  const f = await postgresPoolFixture();
  expect(await postgresPoolCapable(env.DB, f.region)).toBe(true);
  await env.DB.prepare(
    `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,created_at,updated_at,deadline_at)
    SELECT ?,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,0,'preflight','pending',created_at,updated_at,deadline_at FROM fleet_patch_operations WHERE operation_id=?`,
  )
    .bind(newOperationId(), f.patchId)
    .run();
  expect(await postgresPoolCapable(env.DB, f.region)).toBe(false);
});
it("gates an isolated candidate on the whole confirmed fleet and strips CF metadata while ordinary admission stays off", async () => {
  const f = await postgresPoolFixture();
  const raw = FleetReleaseSpec.parse(
    JSON.parse(
      (await env.DB.prepare("SELECT spec_json FROM fleet_releases WHERE id=?")
        .bind(f.policy.release_id)
        .first<string>("spec_json"))!,
    ),
  );
  const { postgres_pool_version, postgres_pool_qualification, ...base } = raw;
  void postgres_pool_version;
  void postgres_pool_qualification;
  const candidate = FleetReleaseSpec.parse({
    ...base,
    postgres_pool_qualification_version: 1,
    postgres_pool_candidate: {
      host_controller_sha256: f.policy.host_controller_sha256,
      driver_sha256: "c".repeat(64),
      supervisor_sha256: base.components.find(
        (c) => c.name === "pool-supervisor",
      )!.sha256,
    },
  });
  const id = "candidate-only-" + crypto.randomUUID(),
    response = await request(
      `/v1/fleet/releases/${id}`,
      f.admin,
      "PUT",
      candidate,
    );
  expect(response.status).toBe(200);
  admissionFixtureReleases.push(id);
  const hash = ((await response.json()) as { spec_sha256: string }).spec_sha256;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_region_releases SET release_id=? WHERE region_id=?",
    ).bind(id, f.region),
    env.DB.prepare(
      "UPDATE fleet_node_releases SET release_id=? WHERE node_id=?",
    ).bind(id, f.node),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET release_id=?,spec_sha256=? WHERE operation_id=?",
    ).bind(id, hash, f.patchId),
  ]);
  expect(await postgresPoolQualificationCapable(env.DB, f.region)).toBe(true);
  expect(await postgresPoolCapable(env.DB, f.region)).toBe(false);
  // Use the direct real-D1 reader so projection failures expose their contract
  // issue here instead of being hidden behind the public error response.
  const projected = (await readDesiredFleetRelease(env.DB, f.region))!;
  expect(projected.release.spec.components).toContainEqual(
    candidate.components.find((c) => c.name === "pool-supervisor"),
  );
  for (const role of Object.values(projected.release.spec.roles))
    expect(role.components).not.toContain("pool-supervisor");
  const incomplete = structuredClone(candidate);
  incomplete.roles.customer.components =
    incomplete.roles.customer.components.filter(
      (name) => name !== "pool-supervisor",
    );
  expect(FleetReleaseSpec.safeParse(incomplete).success).toBe(false);
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(desired.region.postgres_pools).toBeUndefined();
  expect(
    desired.fleet_release!.release.spec.postgres_pool_qualification_version,
  ).toBeUndefined();
  expect(
    desired.fleet_release!.release.spec.postgres_pool_candidate,
  ).toBeUndefined();
  expect(
    desired.fleet_release!.release.spec.components.some(
      (c) => c.name === "pool-supervisor",
    ),
  ).toBe(true);
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET stage='preflight',state='pending' WHERE operation_id=?",
  )
    .bind(f.patchId)
    .run();
  expect(await postgresPoolQualificationCapable(env.DB, f.region)).toBe(false);
  const pending = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(
    pending.fleet_release!.release.spec.components.some(
      (c) => c.name === "pool-supervisor",
    ),
  ).toBe(false);
});
