// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  admissionFixtureReleases,
  admissionSnapshotFixture,
} from "./admission-snapshot-fixture.ts";
import {
  cleanupFixtures,
  request,
  observedBody,
  observation,
} from "./fixtures.ts";
import { publishDatabaseAdmission } from "../../src/domain/database-admission-snapshot.ts";
import { admissionSnapshotCapable } from "../../src/domain/fleet-releases.ts";
import { FleetReleaseSpec } from "@pgcf/contracts";

afterEach(async () => {
  await cleanupFixtures();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
it("a newly observed anonymous member closes the regional cache capability before inventory insertion", async () => {
  const f = await admissionSnapshotFixture(),
    name = "unverified-" + crypto.randomUUID();
  await publishDatabaseAdmission(env, f.id);
  await env.DB.exec(
    `CREATE TRIGGER anonymous_member_fence BEFORE INSERT ON nodes WHEN NEW.k8s_node_name='${name}' AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.kind='region' AND s.scope_id=NEW.region_id AND s.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'membership lacks regional fence'); END`,
  );
  try {
    const response = await request("/agent/v1/observations", f.agent, "POST", {
      ...observedBody([]),
      nodes: [
        {
          name,
          ready: true,
          allocatable_memory_mib: 8192,
          allocatable_cpu_millicores: 4000,
          storage_gib_total: 100,
          platform_reserved_memory_mib: 1024,
          platform_reserved_cpu_millicores: 500,
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(await admissionSnapshotCapable(env.DB, f.region)).toBe(false);
    const epoch = await env.DB.prepare(
      "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first();
    expect(epoch).toEqual({
      admission_revision: f.proof.admission_epoch + 1,
      route_revision: f.proof.route_revision + 1,
    });
  } finally {
    await env.DB.exec("DROP TRIGGER anonymous_member_fence");
  }
});

it("a current ready observation closes admission before publishing a contradictory runtime state", async () => {
  const f = await admissionSnapshotFixture();
  await publishDatabaseAdmission(env, f.id);
  await env.DB.exec(
    `CREATE TRIGGER observed_admission BEFORE UPDATE OF observed_state ON databases WHEN NEW.id='${f.id}' AND OLD.observed_state='ready' AND NEW.observed_state<>'ready' AND NOT EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=NEW.id AND e.mutation_id IS NOT NULL AND e.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'runtime invalidation lacks admission fence'); END`,
  );
  try {
    const response = await request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([observation(f.id, f.proof.generation, "error")]),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: 1 });
    expect(
      await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admit(
        f.id,
        "app",
      ),
    ).toEqual({ ok: false, sqlstate: "57P03" });
    expect(
      await env.DB.prepare(
        "SELECT admission_revision,route_revision,mutation_id FROM database_admission_epochs WHERE database_id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual({
      admission_revision: f.proof.admission_epoch + 1,
      route_revision: f.proof.route_revision + 1,
      mutation_id: null,
    });
  } finally {
    await env.DB.exec("DROP TRIGGER observed_admission");
  }
});

it("current node and region release assignments fence all regional admissions", async () => {
  const f = await admissionSnapshotFixture();
  await publishDatabaseAdmission(env, f.id);
  await env.DB.exec(
    `CREATE TRIGGER fleet_node_admission BEFORE UPDATE ON fleet_node_releases WHEN NEW.node_id='${f.node}' AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.kind='region' AND s.scope_id='${f.region}' AND s.mutation_id IS NOT NULL AND s.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'fleet node assignment lacks region admission fence'); END`,
  );
  await env.DB.exec(
    `CREATE TRIGGER fleet_region_admission BEFORE UPDATE ON fleet_region_releases WHEN NEW.region_id='${f.region}' AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.kind='region' AND s.scope_id=NEW.region_id AND s.mutation_id IS NOT NULL AND s.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'fleet region assignment lacks admission fence'); END`,
  );
  try {
    expect(
      (
        await request(`/v1/nodes/${f.node}/release`, f.admin, "PUT", {
          expected_revision: 1,
          node_uid: f.nodeUid,
          release_id: f.releaseId,
          role: "customer",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
          expected_revision: 1,
          release_id: f.releaseId,
        })
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT admission_revision,route_revision,mutation_id FROM database_admission_epochs WHERE database_id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual({
      admission_revision: f.proof.admission_epoch + 2,
      route_revision: f.proof.route_revision + 2,
      mutation_id: null,
    });
  } finally {
    await env.DB.exec("DROP TRIGGER fleet_node_admission");
    await env.DB.exec("DROP TRIGGER fleet_region_admission");
  }
});

it("a current node identity or readiness loss fences its admissions before the inventory update", async () => {
  const f = await admissionSnapshotFixture();
  await env.DB.prepare(
    "UPDATE nodes SET provider_instance_id='10001' WHERE id=?",
  )
    .bind(f.node)
    .run();
  await publishDatabaseAdmission(env, f.id);
  await env.DB.exec(
    `CREATE TRIGGER node_inventory_admission BEFORE UPDATE OF ready ON nodes WHEN NEW.id='${f.node}' AND OLD.ready=1 AND NEW.ready=0 AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.kind='node' AND s.scope_id=NEW.id AND s.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'node readiness lacks admission fence'); END`,
  );
  try {
    const name = await env.DB.prepare(
      "SELECT k8s_node_name FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first<string>("k8s_node_name");
    const response = await request("/agent/v1/observations", f.agent, "POST", {
      ...observedBody([]),
      nodes: [
        {
          node_id: f.node,
          name: name!,
          node_uid: f.nodeUid,
          provider_instance_id: "10001",
          ready: false,
          allocatable_memory_mib: 8192,
          allocatable_cpu_millicores: 4000,
          storage_gib_total: 100,
          platform_reserved_memory_mib: 1024,
          platform_reserved_cpu_millicores: 500,
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT ready FROM nodes WHERE id=?")
        .bind(f.node)
        .first("ready"),
    ).toBe(0);
    expect(
      await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admit(
        f.id,
        "app",
      ),
    ).toEqual({ ok: false, sqlstate: "57P03" });
    const epoch = await env.DB.prepare(
      "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first<{ admission_revision: number; route_revision: number }>();
    await env.DB.prepare(
      "UPDATE databases SET runtime_attestation_json=? WHERE id=?",
    )
      .bind(
        JSON.stringify({
          ...f.proof,
          admission_epoch: epoch!.admission_revision,
          route_revision: epoch!.route_revision,
        }),
        f.id,
      )
      .run();
    await publishDatabaseAdmission(env, f.id);
    expect(
      await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admit(
        f.id,
        "app",
      ),
    ).toEqual({ ok: false, sqlstate: "57P03" });
  } finally {
    await env.DB.exec("DROP TRIGGER node_inventory_admission");
  }
});

it("losing a current v2 proof closes admission and a restored proof reopens at the already fenced epoch", async () => {
  const f = await admissionSnapshotFixture();
  await publishDatabaseAdmission(env, f.id);
  const image = f.desired.postgres!.image;
  const lost = {
    ...observation(f.id, f.proof.generation, "ready"),
    postgres: { image, image_id: `containerd://${image.split("@")[1]}` },
  };
  const response = await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([lost]),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ accepted: 1 });
  expect(
    await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admit(
      f.id,
      "app",
    ),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  const epochs = await env.DB.prepare(
    "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
  )
    .bind(f.id)
    .first<{ admission_revision: number; route_revision: number }>();
  expect(epochs).toEqual({
    admission_revision: f.proof.admission_epoch + 1,
    route_revision: f.proof.route_revision + 1,
  });
  const renewed = structuredClone(f.proof);
  renewed.admission_epoch = epochs!.admission_revision;
  renewed.route_revision = epochs!.route_revision;
  renewed.observed_at = Date.now();
  renewed.observation.verified_at = renewed.observed_at;
  renewed.observation.expires_at = renewed.observed_at + 60000;
  const restored = { ...lost, runtime_attestation: renewed };
  const current = await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([restored]),
  );
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({ accepted: 1 });
  expect(
    await env.DB.prepare(
      "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual(epochs);
  expect(
    await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admit(
      f.id,
      "app",
    ),
  ).toMatchObject({
    ok: true,
    target: { route_revision: epochs!.route_revision },
  });
});

it("a reported controller rollback fences cached admission and removes the incompatible desired wire capability", async () => {
  const f = await admissionSnapshotFixture();
  const spec = FleetReleaseSpec.parse(
    JSON.parse(
      (await env.DB.prepare("SELECT spec_json FROM fleet_releases WHERE id=?")
        .bind(f.releaseId)
        .first<string>("spec_json"))!,
    ),
  );
  await publishDatabaseAdmission(env, f.id);
  await env.DB.exec(
    `CREATE TRIGGER fleet_observation_admission BEFORE INSERT ON fleet_node_release_observations WHEN NEW.node_id='${f.node}' AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.kind='region' AND s.scope_id='${f.region}' AND s.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'runtime rollback lacks admission fence'); END`,
  );
  try {
    const response = await request(
      "/agent/v1/fleet-observations",
      f.agent,
      "POST",
      {
        node_id: f.node,
        node_uid: f.nodeUid,
        assignment_revision: 1,
        observed_at: new Date().toISOString(),
        facts: {
          boot_id: f.proof.boot_id,
          configuration_schema_revision: 1,
          talos_version: spec.roles.customer.talos_version,
          talos_installer: spec.roles.customer.talos_installer,
          talos_schematic_sha256: spec.roles.customer.talos_schematic_sha256,
          kubernetes_version: spec.roles.customer.kubernetes_version,
          components: spec.components
            .filter((component) =>
              spec.roles.customer.components.includes(component.name),
            )
            .map(({ name, version, sha256 }) => ({
              name,
              version,
              sha256: name === "native-controller" ? "0".repeat(64) : sha256,
            })),
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await admissionSnapshotCapable(env.DB, f.region)).toBe(false);
    const reply = await env.DATABASE_ACTOR.get(
      env.DATABASE_ACTOR.idFromName(f.id),
    ).admit(f.id, "app");
    expect(reply.ok && reply.target?.route_revision).toBeUndefined();
    const desired = (await (
      await request("/agent/v1/desired", f.agent)
    ).json()) as { databases: { admission?: unknown }[] };
    expect(
      desired.databases.some((database) => database.admission !== undefined),
    ).toBe(false);
  } finally {
    await env.DB.exec("DROP TRIGGER fleet_observation_admission");
  }
});
