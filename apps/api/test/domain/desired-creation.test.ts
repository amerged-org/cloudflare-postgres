// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  archiveDestinationPath,
  DatabaseWithOperation,
  DesiredResponse,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  fixture,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";

afterEach(cleanupFixtures);

async function create(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.create();
  expect(response.status).toBe(202);
  return DatabaseWithOperation.parse(await response.json());
}

async function desiredDatabase(agent: string, id: string) {
  const response = await request("/agent/v1/desired", agent);
  expect(response.status).toBe(200);
  const page = DesiredResponse.parse(await response.json());
  const database = page.databases.find((database) => database.id === id);
  expect(database).toBeDefined();
  return database!;
}

describe("authoritative creation history in desired state", () => {
  it("emits the pending original create operation before the database has been ready", async () => {
    const f = await fixture(),
      created = await create(f);
    expect(
      (await desiredDatabase(f.agent, created.database.id)).creation,
    ).toEqual({
      operation_id: created.operation.id,
      generation: 1,
      status: "pending",
      ever_ready: false,
    });
  });

  it("keeps a partially applied create bound to its original generation after a role revision", async () => {
    const f = await fixture(),
      created = await create(f);
    expect(
      (
        await request(
          `/v1/databases/${created.database.id}/roles`,
          f.integrator,
          "POST",
          { name: "reader" },
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([observation(created.database.id, 2, "provisioning")]),
        )
      ).status,
    ).toBe(200);
    const desired = await desiredDatabase(f.agent, created.database.id);
    expect(desired.generation).toBe(2);
    expect(desired.creation).toEqual({
      operation_id: created.operation.id,
      generation: 1,
      status: "running",
      ever_ready: false,
    });
  });

  it("preserves ready history after a later error and on the deletion tombstone", async () => {
    const f = await fixture(),
      created = await create(f);
    expect(
      (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([observation(created.database.id, 1)]),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/v1/databases/${created.database.id}/roles`,
          f.integrator,
          "POST",
          { name: "reader" },
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          "/agent/v1/observations",
          f.agent,
          "POST",
          observedBody([observation(created.database.id, 2, "error")]),
        )
      ).status,
    ).toBe(200);
    const creation = {
      operation_id: created.operation.id,
      generation: 1,
      status: "succeeded",
      ever_ready: true,
    };
    expect(
      (await desiredDatabase(f.agent, created.database.id)).creation,
    ).toEqual(creation);
    expect(
      (
        await request(
          `/v1/databases/${created.database.id}`,
          f.integrator,
          "DELETE",
        )
      ).status,
    ).toBe(202);
    const tombstone = await desiredDatabase(f.agent, created.database.id);
    expect(tombstone.desired_state).toBe("deleted");
    expect(tombstone.creation).toEqual(creation);
  });

  it("uses immutable ready events even if the current observation has lost its ready state", async () => {
    const f = await fixture(),
      created = await create(f),
      now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at) VALUES (?,'ready',?,?,1,?)",
      ).bind(created.database.id, f.node, f.size, now),
      env.DB.prepare(
        "UPDATE databases SET observed_state='error',observed_generation=0,generation=2 WHERE id=?",
      ).bind(created.database.id),
    ]);
    expect(
      (await desiredDatabase(f.agent, created.database.id)).creation,
    ).toEqual({
      operation_id: created.operation.id,
      generation: 1,
      status: "pending",
      ever_ready: true,
    });
  });

  it("returns null when the original create operation is missing", async () => {
    const f = await fixture(),
      created = await create(f);
    await env.DB.prepare("DELETE FROM operations WHERE id=?")
      .bind(created.operation.id)
      .run();
    expect(
      (await desiredDatabase(f.agent, created.database.id)).creation,
    ).toBeNull();
  });

  it("returns null when the archive operation belongs to a different database", async () => {
    const f = await fixture(),
      created = await create(f),
      otherResponse = await f.create("other"),
      other = DatabaseWithOperation.parse(await otherResponse.json());
    await env.DB.prepare("UPDATE databases SET archive_path=? WHERE id=?")
      .bind(
        archiveDestinationPath(
          env.ARCHIVE_BUCKET_NAME,
          f.region,
          created.database.id,
          1,
          other.operation.id,
        ),
        created.database.id,
      )
      .run();
    expect(
      (await desiredDatabase(f.agent, created.database.id)).creation,
    ).toBeNull();
  });

  it("returns null when the archive names a deletion operation", async () => {
    const f = await fixture(),
      created = await create(f),
      response = await request(
        `/v1/databases/${created.database.id}`,
        f.integrator,
        "DELETE",
      ),
      deletion = DatabaseWithOperation.parse(await response.json());
    expect(response.status).toBe(202);
    await env.DB.prepare("UPDATE databases SET archive_path=? WHERE id=?")
      .bind(
        archiveDestinationPath(
          env.ARCHIVE_BUCKET_NAME,
          f.region,
          created.database.id,
          1,
          deletion.operation.id,
        ),
        created.database.id,
      )
      .run();
    expect(
      (await desiredDatabase(f.agent, created.database.id)).creation,
    ).toBeNull();
  });

  it("binds the original failed status rather than a later create operation", async () => {
    const f = await fixture(),
      created = await create(f),
      laterOperation = newOperationId(),
      now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE operations SET status='failed',completed_at=?,updated_at=? WHERE id=?",
      ).bind(now, now, created.operation.id),
      env.DB.prepare("UPDATE databases SET generation=2 WHERE id=?").bind(
        created.database.id,
      ),
      env.DB.prepare(
        "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) VALUES (?,'database.create','running',?,?,2,?,?)",
      ).bind(laterOperation, f.project, created.database.id, now, now),
    ]);
    const desired = await desiredDatabase(f.agent, created.database.id);
    expect(desired.generation).toBe(2);
    expect(desired.creation).toEqual({
      operation_id: created.operation.id,
      generation: 1,
      status: "failed",
      ever_ready: false,
    });
  });
});
