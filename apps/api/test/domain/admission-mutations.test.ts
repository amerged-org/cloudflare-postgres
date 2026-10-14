// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import {
  withAdmissionMutation,
  withAdmissionMutationScopes,
  type AdmissionSqlGuard,
} from "../../src/domain/admission-mutations.ts";
import { reconcileDatabaseActors } from "../../src/domain/database-actor-sync.ts";
import { placePendingDatabases } from "../../src/domain/node-capacity.ts";

afterEach(cleanupFixtures);
const actorFor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
async function ready() {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_generation=generation,power_operation=NULL WHERE id=?",
  )
    .bind(created.database.id)
    .run();
  return { ...f, id: created.database.id };
}
async function unresolvedPoolHolder(f: Awaited<ReturnType<typeof ready>>) {
  const uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string>("node_uid");
  const pod = crypto.randomUUID(),
    binding = crypto.randomUUID(),
    boot = crypto.randomUUID(),
    now = Date.now();
  // Controlled local SQL ownership metadata; no mount or Dev runtime claim.
  await env.DB.prepare(
    "INSERT INTO pool_pods(pod_uid,node_id,node_uid,boot_id,policy_revision,attestation_json,state,first_observed_at,last_observed_at) VALUES(?,?,?,?,1,'{}','claimed',?,?)",
  )
    .bind(pod, f.node, uid, boot, now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO pool_bindings(id,database_id,node_id,node_uid,boot_id,pool_pod_uid,generation,route_revision,admission_epoch,holder_revision,scope_sha256,scope_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1,1,1,?,'{}','claimed',?,?)",
  )
    .bind(binding, f.id, f.node, uid, boot, pod, "a".repeat(64), now, now)
    .run();
  return binding;
}

it("a regional authority mutation durably detaches an unresolved pool holder in the same guarded business batch", async () => {
  const f = await ready(),
    binding = await unresolvedPoolHolder(f);
  await env.DB.exec(
    `CREATE TRIGGER pool_authority_fence BEFORE UPDATE ON regions WHEN NEW.id='${f.region}' AND EXISTS(SELECT 1 FROM pool_bindings WHERE id='${binding}' AND state<>'detaching') BEGIN SELECT RAISE(ABORT,'authority write retains active pool holder'); END`,
  );
  try {
    await withAdmissionMutation(
      env,
      [],
      async (mutation) => {
        const guard = mutation.scopeGuard();
        await mutation.batch([
          env.DB.prepare(
            `UPDATE regions SET gateway_url='https://next.invalid' WHERE id=? AND (${guard.sql})`,
          ).bind(f.region, ...guard.bindings),
        ]);
      },
      { kind: "region", id: f.region },
    );
    expect(
      await env.DB.prepare("SELECT state FROM pool_bindings WHERE id=?")
        .bind(binding)
        .first("state"),
    ).toBe("detaching");
  } finally {
    await env.DB.exec("DROP TRIGGER pool_authority_fence");
  }
});
it("an atomic declared-region batch fences all delayed writes after a real abort without affecting a third region", async () => {
  const a = await ready(),
    b = await ready(),
    other = await ready();
  let delayed: D1PreparedStatement | undefined;
  await env.DB.exec(
    `CREATE TRIGGER scoped_abort BEFORE UPDATE OF desired_state ON databases WHEN NEW.id='${b.id}' BEGIN SELECT RAISE(ABORT,'controlled multi-region abort'); END`,
  );
  try {
    await expect(
      withAdmissionMutationScopes(
        env,
        [
          { kind: "region", id: a.region },
          { kind: "region", id: b.region },
        ],
        async (mutation) => {
          const guard = mutation.guard;
          delayed = env.DB.prepare(
            `UPDATE databases SET desired_state='suspended' WHERE id=? AND (${guard.sql})`,
          ).bind(a.id, ...guard.bindings);
          expect((await actorFor(other.id).admit(other.id, "app")).ok).toBe(
            true,
          );
          await mutation.batch([
            delayed,
            env.DB.prepare(
              `UPDATE databases SET desired_state='suspended' WHERE id=? AND (${guard.sql})`,
            ).bind(b.id, ...guard.bindings),
          ]);
        },
      ),
    ).rejects.toThrow("controlled multi-region abort");
  } finally {
    await env.DB.exec("DROP TRIGGER scoped_abort");
  }
  expect((await delayed!.run()).meta.changes).toBe(0);
  for (const f of [a, b]) {
    expect(
      await env.DB.prepare("SELECT desired_state FROM databases WHERE id=?")
        .bind(f.id)
        .first("desired_state"),
    ).toBe("running");
    expect(
      await env.DB.prepare(
        "SELECT mutation_id,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual({ mutation_id: null, mutation_outcome: "fenced" });
  }
  expect((await actorFor(other.id).admit(other.id, "app")).ok).toBe(true);
});

it("a capability rollback cannot route or start CNPG while a pool holder outcome is unknown", async () => {
  const f = await ready();
  await unresolvedPoolHolder(f);
  expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(
    await actorFor(f.id).ensureAwake(f.id, "app", {
      deadline: Date.now() + 100,
    }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
  const desired = (await (
    await request("/agent/v1/desired", f.agent)
  ).json()) as { databases: { id: string }[] };
  expect(desired.databases.some((database) => database.id === f.id)).toBe(
    false,
  );
});

it("a committed role change cannot admit the preceding ready runtime without a power operation", async () => {
  const f = await fixture();
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const id = created.database.id;
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_generation=generation,power_operation=NULL WHERE id=?",
  )
    .bind(id)
    .run();
  const actor = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
  expect((await actor.admit(id, "app")).ok).toBe(true);
  const changed = await request(
    `/v1/databases/${id}/roles`,
    f.integrator,
    "POST",
    {
      name: "reader",
    },
  );
  expect(changed.status).toBe(201);
  const row = await env.DB.prepare(
    "SELECT generation,observed_generation,power_operation FROM databases WHERE id=?",
  )
    .bind(id)
    .first<{
      generation: number;
      observed_generation: number;
      power_operation: null;
    }>();
  expect(row).toEqual({
    generation: 2,
    observed_generation: 1,
    power_operation: null,
  });
  expect(await actor.admit(id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(await actor.admit(id, "reader")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect(
    await actor.ensureAwake(id, "app", { deadline: Date.now() + 100 }),
  ).toEqual({ ok: false, sqlstate: "57P03" });
});

it("the affected Actor barrier survives eviction and leaves an unrelated database admitted", async () => {
  const f = await ready(),
    other = await ready();
  await withAdmissionMutation(env, [f.id], async (mutation) => {
    expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
      ok: false,
      sqlstate: "57P03",
    });
    await evictDurableObject(actorFor(f.id));
    expect(await actorFor(f.id).ensureAwake(f.id, "app")).toEqual({
      ok: false,
      sqlstate: "57P03",
    });
    expect((await actorFor(other.id).admit(other.id, "app")).ok).toBe(true);
    const guard = mutation.guard(f.id);
    await mutation.batch([
      env.DB.prepare(
        `UPDATE databases SET desired_state='suspended',generation=generation+1 WHERE id=? AND ${guard.sql}`,
      ).bind(f.id, ...guard.bindings),
    ]);
  });
  expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});

it("a real aborted write is fenced before recovery and its delayed original guard cannot mutate", async () => {
  const f = await ready();
  let original: AdmissionSqlGuard | undefined;
  await env.DB.exec(
    `CREATE TRIGGER abort_admission_write BEFORE UPDATE OF desired_state ON databases WHEN NEW.id='${f.id}' BEGIN SELECT RAISE(ABORT,'guarded mutation interrupted'); END`,
  );
  try {
    await expect(
      withAdmissionMutation(env, [f.id], async (mutation) => {
        original = mutation.guard(f.id);
        await mutation.batch([
          env.DB.prepare(
            `UPDATE databases SET desired_state='suspended' WHERE id=? AND ${original.sql}`,
          ).bind(f.id, ...original.bindings),
        ]);
      }),
    ).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER abort_admission_write");
  }
  const late = await env.DB.prepare(
    `UPDATE databases SET desired_state='suspended' WHERE id=? AND ${original!.sql}`,
  )
    .bind(f.id, ...original!.bindings)
    .run();
  expect(late.meta.changes).toBe(0);
  const epoch = await env.DB.prepare(
    "SELECT admission_revision,route_revision,mutation_id,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
  )
    .bind(f.id)
    .first();
  expect(epoch).toMatchObject({
    admission_revision: 2,
    route_revision: 2,
    mutation_id: null,
    mutation_outcome: "fenced",
  });
  expect((await actorFor(f.id).admit(f.id, "app")).ok).toBe(true);
});

it("a lost response after the committed batch cannot submit a second business write", async () => {
  const f = await ready();
  let submitted = 0;
  await expect(
    withAdmissionMutation(env, [f.id], async (mutation) => {
      const guard = mutation.guard(f.id);
      submitted++;
      await mutation.batch([
        env.DB.prepare(
          `UPDATE databases SET desired_state='suspended',generation=generation+1 WHERE id=? AND ${guard.sql}`,
        ).bind(f.id, ...guard.bindings),
      ]);
      throw new Error("response interrupted after the actual committed batch");
    }),
  ).rejects.toThrow("response interrupted");
  expect(submitted).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT generation,desired_state FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ generation: 2, desired_state: "suspended" });
  expect(
    await env.DB.prepare(
      "SELECT admission_revision,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ admission_revision: 2, mutation_outcome: "committed" });
  expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});

it("a callback cannot report success without an authoritative guarded batch receipt", async () => {
  const f = await ready();
  await expect(
    withAdmissionMutation(env, [f.id], async () => "missing business receipt"),
  ).rejects.toThrow("database_admission_mutation_not_submitted");
  expect(
    await env.DB.prepare(
      "SELECT mutation_id,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ mutation_id: null, mutation_outcome: "fenced" });
});

it("a scoped epoch commit immediately hints the affected regional desired state", async () => {
  const f = await ready();
  const response = await env.REGION_LINK.get(
    env.REGION_LINK.idFromName(f.region),
  ).fetch("https://link.invalid/", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket!;
  socket.accept();
  const messages: unknown[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string));
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      agent_version: "test",
      instance_id: crypto.randomUUID(),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(messages).toContainEqual({ type: "welcome", protocol: 1 });
  try {
    await withAdmissionMutation(
      env,
      [],
      async (mutation) => {
        const guard = mutation.scopeGuard();
        await mutation.batch([
          env.DB.prepare(
            `UPDATE regions SET gateway_url='https://next.invalid' WHERE id=? AND ${guard.sql}`,
          ).bind(f.region, ...guard.bindings),
        ]);
      },
      { kind: "region", id: f.region },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages).toContainEqual({ type: "desired", ids: [f.id] });
  } finally {
    socket.close();
  }
});

it("a project scope fence rejects a new member before its existing Actor can be mutated", async () => {
  const f = await ready();
  await withAdmissionMutation(
    env,
    [],
    async (mutation) => {
      const created = await request("/v1/databases", f.integrator, "POST", {
        project_id: f.project,
        region_id: f.region,
        name: "new_member",
        size_class_id: f.size,
      });
      expect(created.status).toBe(409);
      const guard = mutation.scopeGuard();
      await mutation.batch([
        env.DB.prepare(
          `UPDATE projects SET updated_at=? WHERE id=? AND ${guard.sql}`,
        ).bind(new Date().toISOString(), f.project, ...guard.bindings),
      ]);
    },
    { kind: "project", id: f.project },
  );
});

it("pending placement cannot join a node or region while its scope is closed", async () => {
  const f = await fixture(0);
  const created = DatabaseWithOperation.parse(
    await (await f.create()).json(),
  ).database;
  expect(created.node_id).toBeNull();
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_memory_mib=4096 WHERE id=?",
  )
    .bind(f.node)
    .run();
  await withAdmissionMutation(
    env,
    [],
    async (mutation) => {
      expect(await placePendingDatabases(env.DB, f.region)).toEqual([]);
      const guard = mutation.scopeGuard();
      await mutation.batch([
        env.DB.prepare(
          `UPDATE regions SET updated_at=? WHERE id=? AND ${guard.sql}`,
        ).bind(new Date().toISOString(), f.region, ...guard.bindings),
      ]);
    },
    { kind: "region", id: f.region },
  );
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(created.id)
      .first("node_id"),
  ).toBeNull();
  expect(await placePendingDatabases(env.DB, f.region)).toEqual([created.id]);
});

it("actual role create and password reset acquire their admission fence before touching credentials", async () => {
  const f = await ready();
  await env.DB.exec(
    `CREATE TRIGGER role_admission_insert BEFORE INSERT ON roles WHEN NEW.database_id='${f.id}' AND NOT EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=NEW.database_id AND e.mutation_id IS NOT NULL AND e.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'credential write lacks admission fence'); END`,
  );
  await env.DB.exec(
    `CREATE TRIGGER role_admission_reset BEFORE UPDATE OF password_revision ON roles WHEN NEW.database_id='${f.id}' AND NOT EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=NEW.database_id AND e.mutation_id IS NOT NULL AND e.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'credential update lacks admission fence'); END`,
  );
  try {
    expect(
      (
        await request(`/v1/databases/${f.id}/roles`, f.integrator, "POST", {
          name: "reader",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          `/v1/databases/${f.id}/roles/reader/reset-password`,
          f.integrator,
          "POST",
        )
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT password_revision FROM roles WHERE database_id=? AND name='reader'",
      )
        .bind(f.id)
        .first<number>("password_revision"),
    ).toBe(2);
    expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
      ok: false,
      sqlstate: "57P03",
    });
  } finally {
    await env.DB.exec("DROP TRIGGER role_admission_insert");
    await env.DB.exec("DROP TRIGGER role_admission_reset");
  }
});

it("legacy cron repairs interruption after durable Actor closure but before D1 reservation with a positive epoch fence", async () => {
  const f = await ready(),
    mutation = crypto.randomUUID();
  expect(
    await actorFor(f.id).beginAdmissionMutation({
      database_id: f.id,
      mutation_id: mutation,
      admission_revision: 1,
      route_revision: 1,
    }),
  ).toBe(true);
  await runInDurableObject(actorFor(f.id), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE database_snapshot SET barrier=json_set(barrier,'$.started_at',?) WHERE singleton=1",
      Date.now() - 60001,
    );
  });
  await evictDurableObject(actorFor(f.id));
  expect(await actorFor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect((await reconcileDatabaseActors(env)).ids).toContain(f.id);
  expect(
    await env.DB.prepare(
      "SELECT admission_revision,route_revision,mutation_id,completed_mutation_id,mutation_outcome FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({
    admission_revision: 2,
    route_revision: 2,
    mutation_id: null,
    completed_mutation_id: mutation,
    mutation_outcome: "fenced",
  });
  const late = await env.DB.prepare(
    "UPDATE database_admission_epochs SET mutation_id=?,mutation_started_at=?,mutation_status='pending' WHERE database_id=? AND admission_revision=1 AND route_revision=1 AND mutation_id IS NULL",
  )
    .bind(mutation, new Date().toISOString(), f.id)
    .run();
  expect(late.meta.changes).toBe(0);
  expect((await actorFor(f.id).admit(f.id, "app")).ok).toBe(true);
});

it("node loss and a gateway route change acquire their scoped Actor barriers before committing", async () => {
  const lost = await ready(),
    routed = await ready();
  const uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(lost.node)
    .first<string>("node_uid");
  await env.DB.exec(
    `CREATE TRIGGER node_admission_loss BEFORE UPDATE OF lost_at ON nodes WHEN NEW.id='${lost.node}' AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.kind='node' AND s.scope_id=NEW.id AND s.mutation_id IS NOT NULL AND s.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'node loss lacks admission fence'); END`,
  );
  await env.DB.exec(
    `CREATE TRIGGER region_admission_route BEFORE UPDATE OF gateway_url ON regions WHEN NEW.id='${routed.region}' AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.kind='region' AND s.scope_id=NEW.id AND s.mutation_id IS NOT NULL AND s.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'route change lacks admission fence'); END`,
  );
  try {
    expect(
      (
        await request(`/v1/nodes/${lost.node}/mark-lost`, lost.admin, "POST", {
          expected_node_uid: uid,
          reason: "controlled local admission test",
        })
      ).status,
    ).toBe(200);
    expect(await actorFor(lost.id).admit(lost.id, "app")).toEqual({
      ok: false,
      sqlstate: "57P03",
    });
    const before = (await (
      await request(`/v1/regions/${routed.region}/configuration`, routed.admin)
    ).json()) as { configuration_sha256: string };
    expect(
      (
        await request(
          `/v1/regions/${routed.region}/configuration`,
          routed.admin,
          "PUT",
          {
            expected_configuration_sha256: before.configuration_sha256,
            gateway_url: `https://${["next", "invalid"].join(".")}/pg`,
            gateway_binding: null,
          },
        )
      ).status,
    ).toBe(200);
    const route = await actorFor(routed.id).admit(routed.id, "app");
    expect(route.ok && route.region.gateway_url).toBe(
      `https://${["next", "invalid"].join(".")}/pg`,
    );
  } finally {
    await env.DB.exec("DROP TRIGGER node_admission_loss");
    await env.DB.exec("DROP TRIGGER region_admission_route");
  }
});
