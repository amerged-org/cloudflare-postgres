// SPDX-License-Identifier: Apache-2.0
// Real local D1/Actor policy boundaries; controlled metadata is not Dev runtime acceptance.
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  newNodeId,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  AdmissionMutation,
  withAdmissionMutation,
} from "../../src/domain/admission-mutations.ts";
import { publishDatabaseAdmission } from "../../src/domain/database-admission-snapshot.ts";
import {
  fixture,
  cleanupFixtures,
  nodeKeyPair,
  report,
  request,
} from "./fixtures.ts";
import { reports } from "./node-samples.ts";
afterEach(async () => {
  await env.DB.prepare("DELETE FROM region_archive_sources").run();
  await cleanupFixtures();
});
const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
async function ready() {
  const f = await fixture(),
    created = DatabaseWithOperation.parse(await (await f.create()).json());
  expect((await report(f, created.database.id, 1)).status).toBe(200);
  await publishDatabaseAdmission(env, created.database.id);
  return { ...f, id: created.database.id };
}
async function epoch(id: string) {
  return env.DB.prepare(
    "SELECT admission_revision,route_revision,mutation_id,completed_mutation_id,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
  )
    .bind(id)
    .first<{
      admission_revision: number;
      route_revision: number;
      mutation_id: string | null;
      completed_mutation_id: string | null;
      mutation_outcome: string | null;
    }>();
}
async function trigger(sql: string) {
  await env.DB.exec(sql.replace(/\n\s*/g, " "));
}

it("archive-source custody rotation fences only established referencing restore targets", async () => {
  const f = await ready(),
    at = new Date().toISOString(),
    node = newNodeId(),
    key = await nodeKeyPair(),
    foreignNode = {
      node,
      nodeUid: crypto.randomUUID(),
      nodeKey: key.privateKey,
    };
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,node_uid,public_key,enrolled_at,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,4096,2000,30,128,100,?,?,?)",
  )
    .bind(
      node,
      f.foreign,
      `archive-target-${node.slice(4)}`,
      foreignNode.nodeUid,
      key.publicKey,
      at,
      at,
      at,
      at,
    )
    .run();
  await reports(node);
  const createTarget = async (name: string) => {
    const response = await request("/v1/databases", f.integrator, "POST", {
      project_id: f.project,
      region_id: f.foreign,
      name,
      size_class_id: f.size,
    });
    expect(response.status).toBe(202);
    return DatabaseWithOperation.parse(await response.json()).database.id;
  };
  const target = await createTarget("referencing_restore"),
    other = await createTarget("unrelated_target"),
    op = newOperationId();
  const source = await env.DB.prepare(
    "SELECT archive_path,storage_generation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<{ archive_path: string; storage_generation: number }>();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.restore','succeeded',?,?,1,?,?,?)",
    ).bind(op, f.project, target, at, at, at),
    env.DB.prepare(
      "UPDATE databases SET storage_generation=2,archive_path=?,observed_state='ready',observed_generation=generation WHERE id=?",
    ).bind(
      `s3://${env.ARCHIVE_BUCKET_NAME}/${f.foreign}/${target}/g2-${op}`,
      target,
    ),
    env.DB.prepare(
      "INSERT INTO database_restores(target_database_id,operation_id,source_database_id,source_archive_path,source_storage_generation,backup_id,verified_at,created_at) VALUES(?,?,?,?,?,'20261013T100000',?,?)",
    ).bind(
      target,
      op,
      f.id,
      source!.archive_path,
      source!.storage_generation,
      at,
      at,
    ),
  ]);
  expect((await report(foreignNode, other, 1)).status).toBe(200);
  await publishDatabaseAdmission(env, target);
  await publishDatabaseAdmission(env, other);
  const before = (await epoch(target))!,
    otherBefore = await epoch(other);
  await trigger(
    `CREATE TRIGGER archive_reference_fence BEFORE UPDATE OF generation ON databases WHEN NEW.id='${target}' AND NOT EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=NEW.id AND e.mutation_id IS NOT NULL AND e.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'archive reference write lacks admission fence'); END`,
  );
  try {
    const registered = await env.DB.prepare(
      "SELECT backup_bucket,backup_endpoint_url FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first<{ backup_bucket: string; backup_endpoint_url: string }>();
    expect(
      (
        await request(
          `/v1/regions/${f.foreign}/archive-sources/${f.region}`,
          f.admin,
          "PUT",
          {
            expected_revision: 0,
            bucket: registered!.backup_bucket,
            endpoint_url: registered!.backup_endpoint_url,
            credentials: {
              access_key_id: crypto.randomUUID(),
              secret_access_key: crypto.randomUUID(),
            },
          },
        )
      ).status,
    ).toBe(200);
    expect((await epoch(target))?.route_revision).toBe(
      before.route_revision + 1,
    );
    expect(await epoch(other)).toEqual(otherBefore);
    expect(await actor(target).admit(target, "app")).toEqual({
      ok: false,
      sqlstate: "57P03",
    });
    expect((await actor(other).admit(other, "app")).ok).toBe(true);
  } finally {
    await env.DB.exec("DROP TRIGGER archive_reference_fence");
  }
});

it("selective region membership closes only affected Actors while unrelated admission stays open", async () => {
  const f = await ready(),
    other = DatabaseWithOperation.parse(
      await (await f.create("unrelated")).json(),
    ).database.id;
  expect((await report(f, other, 1)).status).toBe(200);
  await publishDatabaseAdmission(env, other);
  await withAdmissionMutation(
    env,
    [],
    async (mutation) => {
      expect(await actor(f.id).admit(f.id, "app")).toEqual({
        ok: false,
        sqlstate: "57P03",
      });
      expect((await actor(other).admit(other, "app")).ok).toBe(true);
      expect((await f.create("membership_race")).status).toBe(409);
      const guard = mutation.guard(f.id);
      await mutation.batch([
        env.DB.prepare(
          `UPDATE databases SET status_message='selected policy boundary' WHERE id=? AND (${guard.sql})`,
        ).bind(f.id, ...guard.bindings),
      ]);
    },
    {
      kind: "region",
      id: f.region,
      databases: { sql: "d.id=?", bindings: [f.id] },
    },
  );
});

it("project removal requires terminal databases and a project membership fence before tombstoning", async () => {
  const f = await ready();
  await env.DB.prepare(
    "UPDATE databases SET observed_state='deleted' WHERE id=?",
  )
    .bind(f.id)
    .run();
  expect(
    (await request(`/v1/projects/${f.project}`, f.admin, "DELETE")).status,
  ).toBe(409);
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=?,observed_generation=generation WHERE id=?",
  )
    .bind(new Date().toISOString(), f.id)
    .run();
  await trigger(
    `CREATE TRIGGER project_policy_fence BEFORE UPDATE OF deleted_at ON projects WHEN NEW.id='${f.project}' AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.kind='project' AND s.scope_id=NEW.id AND s.mutation_id IS NOT NULL AND s.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'project write lacks admission fence'); END`,
  );
  try {
    const idem = crypto.randomUUID();
    expect(
      (
        await request(
          `/v1/projects/${f.project}`,
          f.admin,
          "DELETE",
          undefined,
          idem,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await request(
          `/v1/projects/${f.project}`,
          f.admin,
          "DELETE",
          undefined,
          idem,
        )
      ).status,
    ).toBe(204);
    expect(
      (await request(`/v1/projects/${f.project}`, f.admin, "DELETE")).status,
    ).toBe(404);
  } finally {
    await env.DB.exec("DROP TRIGGER project_policy_fence");
  }
});

it("a real project ABORT fences its delayed original SQL authority without replaying deletion", async () => {
  const f = await ready();
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',observed_state='deleted',observed_generation=generation,deleted_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), f.id)
    .run();
  const before = (await epoch(f.id))!;
  // The project fence's own reservation is the authority the aborted request held.
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS held_project_authority(mutation_id TEXT,revision INTEGER)",
  );
  await trigger(
    `CREATE TRIGGER hold_project_authority AFTER UPDATE OF mutation_status ON admission_scope_fences WHEN NEW.kind='project' AND NEW.scope_id='${f.project}' AND NEW.mutation_status='pending' BEGIN INSERT INTO held_project_authority VALUES(NEW.mutation_id,NEW.revision); END`,
  );
  await trigger(
    `CREATE TRIGGER abort_project_policy BEFORE UPDATE OF deleted_at ON projects WHEN NEW.id='${f.project}' BEGIN SELECT RAISE(ABORT,'project commit interrupted'); END`,
  );
  let held: { mutation_id: string; revision: number };
  try {
    expect(
      (await request(`/v1/projects/${f.project}`, f.admin, "DELETE")).status,
    ).toBe(500);
    held = (await env.DB.prepare(
      "SELECT mutation_id,revision FROM held_project_authority",
    ).first<{ mutation_id: string; revision: number }>())!;
  } finally {
    await env.DB.exec(
      "DROP TRIGGER abort_project_policy; DROP TRIGGER hold_project_authority; DROP TABLE held_project_authority",
    );
  }
  // The project's only database is a confirmed deletion: no member, so its epoch is untouched.
  expect(await epoch(f.id)).toEqual(before);
  expect(
    await env.DB.prepare(
      "SELECT revision,mutation_id FROM admission_scope_fences WHERE kind='project' AND scope_id=?",
    )
      .bind(f.project)
      .first(),
  ).toEqual({ revision: held.revision + 1, mutation_id: null });
  const old = new AdmissionMutation(
      env,
      [],
      { kind: "project", id: f.project },
      held.revision,
      held.mutation_id,
    ),
    guard = old.scopeGuard();
  expect(
    (
      await env.DB.prepare(
        `UPDATE projects SET deleted_at=? WHERE id=? AND (${guard.sql})`,
      )
        .bind(new Date().toISOString(), f.project, ...guard.bindings)
        .run()
    ).meta.changes,
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT deleted_at FROM projects WHERE id=?")
      .bind(f.project)
      .first("deleted_at"),
  ).toBeNull();
});
it("actual project deletion and a racing new database cannot both commit", async () => {
  const f = await ready();
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',observed_state='deleted',observed_generation=generation,deleted_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), f.id)
    .run();
  const [deleted, created] = await Promise.all([
    request(`/v1/projects/${f.project}`, f.admin, "DELETE"),
    f.create("racing_project_member"),
  ]);
  expect(deleted.status === 204 && created.status === 202).toBe(false);
  const projectDeleted = await env.DB.prepare(
    "SELECT deleted_at FROM projects WHERE id=?",
  )
    .bind(f.project)
    .first("deleted_at");
  if (projectDeleted)
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM databases WHERE project_id=? AND desired_state<>'deleted'",
      )
        .bind(f.project)
        .first<number>("n"),
    ).toBe(0);
});
