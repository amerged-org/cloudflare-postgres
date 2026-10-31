// SPDX-License-Identifier: Apache-2.0
// The cron step `database_actors` skips a database whose deletion finished more than the retention
// ago and whose node no longer reports a volume; every other database is still reconciled.
// Real D1 and the real DatabaseActor namespace; the recorded names show which Actors were called.
import { env } from "cloudflare:workers";
import {
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileDatabaseActors } from "../../src/domain/database-actor-sync.ts";
import type { Env } from "../../src/env.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(async () => {
  await cleanupFixtures();
});

const DAY_MS = 24 * 60 * 60_000;

/** The real namespace, with the name of every Actor that is asked for recorded in `names`. */
function recordingEnv() {
  const names: string[] = [];
  const namespace = {
    idFromName: (name: string) => {
      names.push(name);
      return env.DATABASE_ACTOR.idFromName(name);
    },
    get: (
      id: DurableObjectId,
      options?: DurableObjectNamespaceGetDurableObjectOptions,
    ) => env.DATABASE_ACTOR.get(id, options),
  } as unknown as Env["DATABASE_ACTOR"];
  return { names, env: { ...env, DATABASE_ACTOR: namespace } as Env };
}

interface Row {
  desired: "running" | "suspended" | "deleted";
  observed: "ready" | "deleting" | "deleted";
  generation: number;
  observedGeneration: number;
  /** Days since the row last changed; a deleted row's deletion was requested then as well. */
  ageDays: number;
}

async function insertDatabase(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  row: Row,
): Promise<void> {
  const changed = new Date(Date.now() - row.ageDays * DAY_MS).toISOString();
  const deleted = row.desired === "deleted";
  const suspended = row.desired === "suspended";
  await env.DB.prepare(
    `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,observed_state,
      generation,observed_generation,archive_path,created_at,updated_at,deleted_at,suspension_reason)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      f.project,
      f.region,
      f.node,
      id,
      f.size,
      row.desired,
      row.observed,
      row.generation,
      row.observedGeneration,
      archiveDestinationPath("test-backups", f.region, id, 1, newOperationId()),
      changed,
      changed,
      deleted ? changed : null,
      suspended ? "manual" : null,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO database_admission_epochs(database_id) VALUES(?)",
  )
    .bind(id)
    .run();
}

const running = { desired: "running", observed: "ready" } as const;
const confirmedDeleted = {
  desired: "deleted",
  observed: "deleted",
  generation: 2,
  observedGeneration: 2,
} as const;

describe("the actor reconciliation of deleted databases", () => {
  it("does not call the Actor of a database whose deletion finished long ago, and the cursor goes on past it", async () => {
    const f = await fixture();
    const [first, retired, third] = [
      newDatabaseId(),
      newDatabaseId(),
      newDatabaseId(),
    ].sort();
    await insertDatabase(f, first!, {
      ...running,
      generation: 1,
      observedGeneration: 1,
      ageDays: 0,
    });
    await insertDatabase(f, retired!, { ...confirmedDeleted, ageDays: 8 });
    await insertDatabase(f, third!, {
      ...running,
      generation: 1,
      observedGeneration: 1,
      ageDays: 0,
    });
    const { names, env: ctx } = recordingEnv();

    const page1 = await reconcileDatabaseActors(ctx, undefined, 2, Infinity);
    expect(page1.ids).toEqual([first, third]);
    expect(page1.next).toBe(third);
    expect(names).not.toContain(retired);

    const page2 = await reconcileDatabaseActors(ctx, page1.next!, 2, Infinity);
    expect(page2).toEqual({ ids: [], next: null, failed: [] });
  });

  it("still reconciles a database deleted a day ago, and its Actor answers from the deleted state", async () => {
    const f = await fixture();
    const id = newDatabaseId();
    await insertDatabase(f, id, { ...confirmedDeleted, ageDays: 1 });
    const { names, env: ctx } = recordingEnv();

    const page = await reconcileDatabaseActors(ctx, undefined, 200, Infinity);
    expect(page.ids).toContain(id);
    expect(names).toContain(id);
    const admitted = await env.DATABASE_ACTOR.get(
      env.DATABASE_ACTOR.idFromName(id),
    ).admit(id, "app");
    expect(admitted).toEqual({ ok: false, sqlstate: "3D000" });
  });

  it("reconciles a live and a suspended database whatever their age", async () => {
    const f = await fixture();
    const live = newDatabaseId();
    const suspended = newDatabaseId();
    await insertDatabase(f, live, {
      ...running,
      generation: 1,
      observedGeneration: 1,
      ageDays: 30,
    });
    await insertDatabase(f, suspended, {
      desired: "suspended",
      observed: "ready",
      generation: 1,
      observedGeneration: 1,
      ageDays: 30,
    });
    const { names, env: ctx } = recordingEnv();

    const page = await reconcileDatabaseActors(ctx, undefined, 200, Infinity);
    expect(page.ids).toEqual(expect.arrayContaining([live, suspended]));
    expect(names).toEqual(expect.arrayContaining([live, suspended]));
  });

  it("still reconciles a database deleted long ago while its cleanup is pending", async () => {
    const f = await fixture();
    const unconfirmed = newDatabaseId();
    const withVolume = newDatabaseId();
    await insertDatabase(f, unconfirmed, {
      desired: "deleted",
      observed: "deleting",
      generation: 2,
      observedGeneration: 1,
      ageDays: 8,
    });
    await insertDatabase(f, withVolume, { ...confirmedDeleted, ageDays: 8 });
    await env.DB.prepare(
      `INSERT INTO node_volumes(node_id,database_id,storage_generation,mounted,size_bytes,pool_used_bytes,observed_at)
       VALUES(?,?,1,0,1,0,?)`,
    )
      .bind(f.node, withVolume, new Date().toISOString())
      .run();
    const { names, env: ctx } = recordingEnv();

    const page = await reconcileDatabaseActors(ctx, undefined, 200, Infinity);
    expect(page.ids).toEqual(expect.arrayContaining([unconfirmed, withVolume]));
    expect(names).toEqual(expect.arrayContaining([unconfirmed, withVolume]));
  });
});
