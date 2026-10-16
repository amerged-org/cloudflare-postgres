// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  DatabaseWithOperation,
  DesiredResponse,
  newOperationId,
  newNodeId,
} from "@pgcf/contracts";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";
import { reconcileFleetPostgresRelease } from "../../src/domain/fleet-postgres.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
import { placementNodes } from "../../src/domain/placement.ts";
import { placePendingDatabases } from "../../src/domain/node-capacity.ts";
const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

async function setup(cold = false, version = "18.7", schema = 1) {
  const f = await fixture(),
    created = DatabaseWithOperation.parse(await (await f.create()).json()),
    id = created.database.id;
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(id, 1)]),
  );
  let generation = 1;
  if (cold) {
    const suspended = DatabaseWithOperation.parse(
      await (
        await request(`/v1/databases/${id}/suspend`, f.admin, "POST")
      ).json(),
    );
    generation = suspended.database.generation;
    await request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([
        {
          ...observation(id, generation, "hibernated"),
          power: {
            operation: suspended.operation.id,
            revision: generation,
            state: "hibernated",
          },
        },
      ]),
    );
  }
  const releaseId = `pg-${crypto.randomUUID()}`,
    patchId = newOperationId(),
    now = new Date().toISOString(),
    uid = crypto.randomUUID(),
    image = `registry.example/postgres:${version}@sha256:${"e".repeat(64)}`;
  releases.push(releaseId);
  const names = [
    "api",
    "edge",
    "node-bootstrap",
    "regional",
    "postgres",
    "barman",
    "cloudflared",
    "cilium",
    "flux-source",
    "flux-kustomize",
    "flux-helm",
    "flux-notification",
    "cert-manager",
    "cloudnative-pg",
    "openebs-lvm",
  ];
  const role = {
    talos_version: "1.14.1",
    talos_installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
    talos_schematic_sha256: "b".repeat(64),
    talos_extensions: [],
    kubernetes_version: "1.36.5",
    components: names.slice(3),
  };
  const spec = {
    version: 1,
    versions_lock_sha256: "c".repeat(64),
    configuration_schema_revision: schema,
    components: names.map((name) => ({
      name,
      kind: ["api", "edge"].includes(name) ? "worker_bundle" : "image",
      version: name === "postgres" ? version : "1.0.0",
      reference:
        name === "postgres"
          ? image
          : `registry.example/${name}@sha256:${"d".repeat(64)}`,
      sha256: (name === "postgres" ? "e" : "d").repeat(64),
    })),
    roles: { customer: role, control_relay: structuredClone(role) },
  };
  const hash = await installationHash(spec);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE nodes SET node_uid=?,database_placement_closed_at=? WHERE id=?",
    ).bind(uid, now, f.node),
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(releaseId, JSON.stringify(spec), hash, now),
    env.DB.prepare(
      "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES(?,?,1,?)",
    ).bind(f.region, releaseId, now),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'customer',1,?)",
    ).bind(f.node, uid, releaseId, now),
    env.DB.prepare(
      `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,created_at,updated_at,deadline_at)
      VALUES(?,?,?,?,?,?,?,1,1,1,'192.0.2.18',?,0,'postgres','pending',?,?,?)`,
    ).bind(
      patchId,
      f.node,
      f.region,
      uid,
      crypto.randomUUID(),
      releaseId,
      hash,
      JSON.stringify([
        { node_id: f.node, node_uid: uid, assignment_revision: 1 },
      ]),
      now,
      now,
      new Date(Date.now() + 3600_000).toISOString(),
    ),
  ]);
  const run = () =>
    reconcileFleetPostgresRelease(env as never, f.region, releaseId, patchId);
  return { ...f, id, generation, releaseId, patchId, image, run };
}
it("persists a generation-bound image, resumes without repeated resize and requires actual running digest", async () => {
  const f = await setup();
  await env.DB.prepare("UPDATE size_classes SET enabled=0 WHERE id=?")
    .bind(f.size)
    .run();
  expect(await f.run()).toMatchObject({
    total: 1,
    pending: 1,
    applied: 0,
    deferred_cold: 0,
    errors: [],
  });
  expect(await f.run()).toMatchObject({ total: 1, pending: 1 });
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  ).databases.find((d) => d.id === f.id)!;
  expect(desired).toMatchObject({
    generation: 2,
    postgres: {
      release_id: f.releaseId,
      image: f.image,
      version: "18.7",
      configuration_schema_revision: 1,
    },
  });
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(f.id, 2)]),
  );
  expect(await f.run()).toMatchObject({ pending: 1, applied: 0 });
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 2),
        postgres: {
          image: f.image,
          image_id: `containerd://sha256:${"e".repeat(64)}`,
        },
      },
    ]),
  );
  expect(await f.run()).toMatchObject({ pending: 0, applied: 1 });
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM operations WHERE database_id=? AND kind='database.resize'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_closed_at=NULL WHERE id=?",
  )
    .bind(f.node)
    .run();
  await env.DB.prepare("UPDATE size_classes SET enabled=1 WHERE id=?")
    .bind(f.size)
    .run();
  const next = DatabaseWithOperation.parse(
    await (await f.create("inherited")).json(),
  );
  expect(
    await env.DB.prepare(
      "SELECT desired_postgres_image FROM databases WHERE id=?",
    )
      .bind(next.database.id)
      .first("desired_postgres_image"),
  ).toBe(f.image);
});
/** The next release of the node's region, assigned, with its patch at the postgres stage. */
async function nextRelease(
  f: Awaited<ReturnType<typeof setup>>,
  change: (spec: {
    components: { name: string; sha256: string; version: string }[];
  }) => void,
) {
  const spec = JSON.parse(
      (await env.DB.prepare("SELECT spec_json FROM fleet_releases WHERE id=?")
        .bind(f.releaseId)
        .first<string>("spec_json"))!,
    ),
    next = `pg-${crypto.randomUUID()}`,
    nextPatch = newOperationId(),
    now = new Date().toISOString(),
    uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("node_uid");
  change(spec);
  releases.push(next);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(next, JSON.stringify(spec), await installationHash(spec), now),
    env.DB.prepare(
      "UPDATE fleet_region_releases SET release_id=?,revision=2 WHERE region_id=?",
    ).bind(next, f.region),
    env.DB.prepare(
      "UPDATE fleet_node_releases SET release_id=?,revision=2 WHERE node_id=?",
    ).bind(next, f.node),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET stage='complete',state='confirmed' WHERE operation_id=?",
    ).bind(f.patchId),
    env.DB.prepare(
      "UPDATE nodes SET database_placement_closed_at=? WHERE id=?",
    ).bind(now, f.node),
    env.DB.prepare(
      `INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,created_at,updated_at,deadline_at)
      SELECT ?,node_id,region_id,node_uid,cluster_uid,?,?,2,2,material_revision,address,?,0,'postgres','pending',?,?,deadline_at FROM fleet_patch_operations WHERE operation_id=?`,
    ).bind(
      nextPatch,
      next,
      await installationHash(spec),
      JSON.stringify([
        { node_id: f.node, node_uid: uid, assignment_revision: 2 },
      ]),
      now,
      now,
      f.patchId,
    ),
  ]);
  return {
    release: next,
    run: () =>
      reconcileFleetPostgresRelease(env as never, f.region, next, nextPatch),
  };
}
it("confirms the stage without a resize or a generation when the release changes only its id", async () => {
  const f = await setup();
  await env.DB.prepare("UPDATE size_classes SET enabled=0 WHERE id=?")
    .bind(f.size)
    .run();
  await f.run();
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 2),
        postgres: {
          image: f.image,
          image_id: `containerd://sha256:${"e".repeat(64)}`,
        },
      },
    ]),
  );
  expect(await f.run()).toMatchObject({ pending: 0, applied: 1 });
  // The next release pins the same PostgreSQL and moves only its own id: another API digest.
  const next = await nextRelease(f, (spec) => {
    spec.components.find((c) => c.name === "api")!.sha256 = "f".repeat(64);
  });
  const before = await env.DB.prepare(
    "SELECT generation,desired_postgres_release_id FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first();
  expect(await next.run()).toMatchObject({
    total: 1,
    pending: 0,
    applied: 1,
    errors: [],
  });
  expect(
    await env.DB.prepare(
      "SELECT generation,desired_postgres_release_id FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual(before);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM operations WHERE database_id=? AND kind='database.resize'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
});
it("counts a database the turn did not update as pending when the release changes only the PostgreSQL version", async () => {
  const f = await setup(true);
  await f.run();
  const next = await nextRelease(f, (spec) => {
    spec.components.find((c) => c.name === "postgres")!.version = "18.8";
  });
  // The turn selects the database and its update changes nothing: as for one beyond the twenty a
  // turn reaches. It is on the old version, so it is not converged.
  const trigger = `ignore_postgres_pin_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.exec(
    `CREATE TRIGGER ${trigger} BEFORE UPDATE ON databases WHEN NEW.id='${f.id}' BEGIN SELECT RAISE(IGNORE); END`,
  );
  try {
    expect(await next.run()).toMatchObject({
      total: 1,
      applied: 0,
      deferred_cold: 0,
      pending: 1,
      errors: [{ database_id: f.id, code: "conflict" }],
    });
  } finally {
    await env.DB.exec(`DROP TRIGGER ${trigger}`);
  }
});
it("keeps confirmed cold databases cold and defers image application until an admitted wake", async () => {
  const f = await setup(true);
  expect(await f.run()).toMatchObject({
    total: 1,
    pending: 0,
    applied: 0,
    deferred_cold: 1,
    errors: [],
  });
  expect(await f.run()).toMatchObject({ deferred_cold: 1 });
  expect(
    await env.DB.prepare(
      "SELECT desired_state,generation,observed_generation,observed_postgres_image FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toMatchObject({
    desired_state: "suspended",
    generation: f.generation + 1,
    observed_generation: f.generation + 1,
    observed_postgres_image: null,
  });
  expect(
    (await placementNodes(env.DB, f.region))[0]!.reserved_cpu_millicores,
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM database_start_admissions WHERE database_id=?",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
  const wake = DatabaseWithOperation.parse(
    await (
      await request(`/v1/databases/${f.id}/resume`, f.admin, "POST")
    ).json(),
  );
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, wake.database.generation),
        power: {
          operation: wake.operation.id,
          revision: wake.database.generation,
          state: "awake",
        },
        postgres: { image: f.image, image_id: f.image },
      },
    ]),
  );
  expect(await f.run()).toMatchObject({
    applied: 1,
    deferred_cold: 0,
    pending: 0,
  });
});
it("refuses incompatible major/schema and invalidated patch assignment before mutations", async () => {
  const major = await setup(false, "19.1");
  await expect(major.run()).rejects.toMatchObject({ code: "invalid_request" });
  const schema = await setup(false, "18.7", 2);
  await expect(schema.run()).rejects.toMatchObject({ code: "invalid_request" });
  const stale = await setup();
  await env.DB.prepare(
    "UPDATE fleet_region_releases SET revision=2 WHERE region_id=?",
  )
    .bind(stale.region)
    .run();
  await expect(stale.run()).rejects.toMatchObject({ code: "conflict" });
  for (const f of [major, schema, stale])
    expect(
      await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
        .bind(f.id)
        .first("generation"),
    ).toBe(1);
});

it("fences an assignment change that races the resize batch itself", async () => {
  const f = await setup();
  const batch = env.DB.batch.bind(env.DB);
  let raced = false;
  vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
    if (!raced) {
      raced = true;
      await env.DB.prepare(
        "UPDATE fleet_region_releases SET revision=2 WHERE region_id=?",
      )
        .bind(f.region)
        .run();
    }
    return batch(statements);
  });
  await expect(f.run()).rejects.toMatchObject({ code: "conflict" });
  expect(
    await env.DB.prepare(
      "SELECT generation,desired_postgres_image FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toMatchObject({ generation: 1, desired_postgres_image: null });
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM operations WHERE database_id=? AND kind='database.resize'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
});

it("converges queued image pins without making maintenance wait for placement it closes", async () => {
  const f = await setup();
  const queued = DatabaseWithOperation.parse(
    await (await f.create("queued-before-pin")).json(),
  );
  await env.DB.prepare(
    "UPDATE databases SET desired_postgres_release_id=NULL,desired_postgres_image=NULL,desired_postgres_version=NULL,desired_postgres_schema_revision=NULL WHERE id=?",
  )
    .bind(queued.database.id)
    .run();
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(queued.database.id)
      .first("node_id"),
  ).toBeNull();
  expect(await f.run()).toMatchObject({
    total: 1,
    pending: 1,
    queued_unassigned: 1,
    errors: [],
  });
  expect(
    await env.DB.prepare(
      "SELECT desired_postgres_release_id,desired_postgres_image,generation FROM databases WHERE id=?",
    )
      .bind(queued.database.id)
      .first(),
  ).toMatchObject({
    desired_postgres_release_id: f.releaseId,
    desired_postgres_image: f.image,
    generation: 2,
  });
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, 2),
        postgres: { image: f.image, image_id: f.image },
      },
    ]),
  );
  expect(await f.run()).toMatchObject({
    total: 1,
    pending: 0,
    applied: 1,
    queued_unassigned: 1,
    errors: [],
  });
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_closed_at=NULL WHERE id=?",
  )
    .bind(f.node)
    .run();
  expect(await placePendingDatabases(env.DB, f.region)).toContain(
    queued.database.id,
  );
  const future = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  ).databases.find((d) => d.id === queued.database.id);
  expect(future).toMatchObject({
    generation: 2,
    postgres: { release_id: f.releaseId, image: f.image },
  });
});

it("a queued PostgreSQL image pin reserves its admission fence before changing the persisted image", async () => {
  const f = await setup(),
    queued = DatabaseWithOperation.parse(
      await (await f.create("queued-fenced-pin")).json(),
    );
  await env.DB.prepare(
    "UPDATE databases SET desired_postgres_release_id=NULL,desired_postgres_image=NULL,desired_postgres_version=NULL,desired_postgres_schema_revision=NULL WHERE id=?",
  )
    .bind(queued.database.id)
    .run();
  await env.DB.exec(
    `CREATE TRIGGER queued_postgres_admission_fence BEFORE UPDATE OF desired_postgres_image ON databases WHEN NEW.id='${queued.database.id}' AND NOT EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=NEW.id AND e.mutation_id IS NOT NULL AND e.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'queued image mutation lacks admission fence'); END`,
  );
  try {
    expect(await f.run()).toMatchObject({ queued_unassigned: 1, errors: [] });
    expect(
      await env.DB.prepare(
        "SELECT generation,desired_postgres_image FROM databases WHERE id=?",
      )
        .bind(queued.database.id)
        .first(),
    ).toEqual({ generation: 2, desired_postgres_image: f.image });
    expect(
      await env.DB.prepare(
        "SELECT mutation_id,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
      )
        .bind(queued.database.id)
        .first(),
    ).toEqual({ mutation_id: null, mutation_outcome: "committed" });
    const actor = env.DATABASE_ACTOR.get(
      env.DATABASE_ACTOR.idFromName(queued.database.id),
    );
    expect((await actor.admit(queued.database.id, "app")).ok).toBe(false);
  } finally {
    await env.DB.exec("DROP TRIGGER queued_postgres_admission_fence");
  }
});

it("patches only the current patch node and leaves another assigned database generation unchanged", async () => {
  const f = await setup();
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_closed_at=NULL WHERE id=?",
  )
    .bind(f.node)
    .run();
  const other = DatabaseWithOperation.parse(
    await (await f.create("other-node-database")).json(),
  ).database.id;
  await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([observation(other, 1)]),
  );
  const otherNode = newNodeId(),
    otherUid = crypto.randomUUID(),
    now = new Date().toISOString();
  const closedAt = await env.DB.prepare(
    "SELECT created_at FROM fleet_patch_operations WHERE operation_id=?",
  )
    .bind(f.patchId)
    .first<string>("created_at");
  const current = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string>("node_uid");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,node_uid,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,1,4096,2000,30,128,100,?,?,?)",
    ).bind(
      otherNode,
      f.region,
      f.nodeName + "-worker",
      otherUid,
      now,
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at)VALUES(?,?,?,'customer',1,?)",
    ).bind(otherNode, otherUid, f.releaseId, now),
    env.DB.prepare(
      "UPDATE databases SET node_id=?,desired_postgres_release_id=NULL,desired_postgres_image=NULL,desired_postgres_version=NULL,desired_postgres_schema_revision=NULL WHERE id=?",
    ).bind(otherNode, other),
    env.DB.prepare(
      "UPDATE nodes SET database_placement_closed_at=? WHERE region_id=?",
    ).bind(closedAt, f.region),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET cluster_nodes_json=? WHERE operation_id=?",
    ).bind(
      JSON.stringify([
        { node_id: f.node, node_uid: current, assignment_revision: 1 },
        { node_id: otherNode, node_uid: otherUid, assignment_revision: 1 },
      ]),
      f.patchId,
    ),
  ]);
  expect(await f.run()).toMatchObject({ total: 1, pending: 1, errors: [] });
  expect(
    await env.DB.prepare(
      "SELECT generation,desired_postgres_image FROM databases WHERE id=?",
    )
      .bind(other)
      .first(),
  ).toMatchObject({ generation: 1, desired_postgres_image: null });
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM operations WHERE database_id=? AND kind='database.resize'",
    )
      .bind(other)
      .first("n"),
  ).toBe(0);
});
