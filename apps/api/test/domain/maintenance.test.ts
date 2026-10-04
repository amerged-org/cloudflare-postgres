// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesiredResponse,
  archiveDestinationPath,
  bytesToBase64url,
  newDatabaseId,
  newOperationId,
  newRolePassword,
} from "@pgcf/contracts";
import { MAINTENANCE_ROLE } from "@pgcf/contracts/maintenance";
import { createApp } from "../../src/app.ts";
import { keyring } from "../../src/crypto/keyring.ts";
import {
  databaseInsertStatement,
  type DatabaseInsertSnapshot,
} from "../../src/domain/databases.ts";
import {
  generateMaintenanceCredential,
  maintenanceCreationStatement,
} from "../../src/domain/maintenance.ts";
import { readDatabasePresence } from "../../src/domain/database-actor-sync.ts";
import type { SizeRow, RegionRow } from "../../src/domain/rows.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(cleanupFixtures);
async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  const id = newDatabaseId(),
    op = newOperationId(),
    now = new Date().toISOString();
  const size = (await env.DB.prepare("SELECT * FROM size_classes WHERE id=?")
    .bind(f.size)
    .first<SizeRow>())!;
  const region = (await env.DB.prepare(
    "SELECT id,backup_bucket,backup_endpoint_url,agent_key_hash FROM regions WHERE id=?",
  )
    .bind(f.region)
    .first<RegionRow>())!;
  const snapshot: DatabaseInsertSnapshot = {
    id,
    now,
    size,
    region,
    nodeId: f.node,
    body: {
      project_id: f.project,
      region_id: f.region,
      size_class_id: f.size,
      name: id,
    },
    archivePath: archiveDestinationPath(
      env.ARCHIVE_BUCKET_NAME,
      f.region,
      id,
      1,
      op,
    ),
  };
  const creation = {
    databaseId: id,
    projectId: f.project,
    createdAt: now,
    creationGeneration: 1 as const,
  };
  const encrypted = await generateMaintenanceCredential(
    env.CREDENTIAL_KEYS,
    id,
  );
  const owner = await keyring(env.CREDENTIAL_KEYS).encrypt(
    id,
    "app",
    newRolePassword(),
  );
  const statements = () => [
    databaseInsertStatement(env.DB, snapshot),
    maintenanceCreationStatement(env.DB, creation, encrypted),
    env.DB.prepare(
      "INSERT INTO roles(database_id,name,owner,password_ciphertext,password_iv,password_kid,created_at,updated_at) SELECT id,'app',1,?,?,?,?,? FROM databases WHERE id=?",
    ).bind(owner.ciphertext, owner.iv, owner.kid, now, now, id),
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,'database.create','pending',project_id,id,1,?,? FROM databases WHERE id=?",
    ).bind(op, now, now, id),
  ];
  return { id, op, snapshot, creation, encrypted, statements };
}
async function desired(agent: string) {
  const response = await request("/agent/v1/desired", agent);
  expect(response.status).toBe(200);
  return DesiredResponse.parse(await response.json());
}

describe("encrypted internal maintenance credentials", () => {
  it("roundtrips encrypted credentials with role-specific authenticated data and no public leakage", async () => {
    const f = await fixture(),
      p = await prepare(f);
    await env.DB.batch(p.statements());
    const stored = await env.DB.prepare(
      "SELECT * FROM maintenance_credentials WHERE database_id=?",
    )
      .bind(p.id)
      .first<Record<string, unknown>>();
    const password = await keyring(env.CREDENTIAL_KEYS).decrypt(
      p.id,
      MAINTENANCE_ROLE,
      p.encrypted,
    );
    expect(JSON.stringify(stored).includes(password)).toBe(false);
    expect(stored!.password_revision).toBe(1);
    await expect(
      keyring(env.CREDENTIAL_KEYS).decrypt(p.id, "app", p.encrypted),
    ).rejects.toThrow();
    await expect(
      keyring(env.CREDENTIAL_KEYS).decrypt(
        newDatabaseId(),
        MAINTENANCE_ROLE,
        p.encrypted,
      ),
    ).rejects.toThrow();
    await expect(
      keyring(env.CREDENTIAL_KEYS).decrypt(p.id, MAINTENANCE_ROLE, {
        ...p.encrypted,
        kid: "missing",
      }),
    ).rejects.toThrow();
    const db = (await desired(f.agent)).databases.find((db) => db.id === p.id)!;
    expect(db.maintenance?.password === password).toBe(true);
    expect(db.maintenance?.role).toBe(MAINTENANCE_ROLE);
    expect(db.maintenance?.revision).toBe(1);
    expect(db.roles.map((role) => role.name)).toEqual(["app"]);
    for (const path of [
      `/v1/databases/${p.id}`,
      `/v1/databases/${p.id}/roles`,
      `/v1/databases/${p.id}/roles/app/connection-uri`,
    ]) {
      const response = await request(path, f.integrator);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text.includes(password)).toBe(false);
      expect(text.includes(MAINTENANCE_ROLE)).toBe(false);
    }
    expect(
      (
        await request(
          `/v1/databases/${p.id}/roles/${MAINTENANCE_ROLE}/connection-uri`,
          f.integrator,
        )
      ).status,
    ).toBe(404);
    const presence = (await readDatabasePresence(env.DB, p.id))!;
    expect(presence.roles).toEqual(["app"]);
    const actor = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(p.id));
    await actor.seed(presence);
    expect(await actor.admit(p.id, MAINTENANCE_ROLE)).toEqual({
      ok: false,
      sqlstate: "28P01",
    });
  });
  it("refuses wrong-region access and returns no credential to the valid other-region agent", async () => {
    const f = await fixture(),
      p = await prepare(f);
    await env.DB.batch(p.statements());
    expect(
      (await desired(f.foreignAgent)).databases.some((db) => db.id === p.id),
    ).toBe(false);
    const altered = f.agent.replace(f.region, f.foreign);
    expect((await request("/agent/v1/desired", altered)).status).toBe(401);
    expect((await request("/agent/v1/desired", f.integrator)).status).toBe(401);
  });
  it("preserves an original password and revision on repeated conditional insertion", async () => {
    const f = await fixture(),
      p = await prepare(f);
    await env.DB.batch(p.statements());
    const before = await env.DB.prepare(
      "SELECT * FROM maintenance_credentials WHERE database_id=?",
    )
      .bind(p.id)
      .first();
    const replacement = await generateMaintenanceCredential(
      env.CREDENTIAL_KEYS,
      p.id,
    );
    const repeated = await env.DB.batch([
      env.DB.prepare(
        "UPDATE databases SET updated_at=updated_at WHERE id=?",
      ).bind(p.id),
      maintenanceCreationStatement(env.DB, p.creation, replacement),
    ]);
    expect(repeated[1]!.meta.changes).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT * FROM maintenance_credentials WHERE database_id=?",
      )
        .bind(p.id)
        .first(),
    ).toEqual(before);
  });
  it("writes no credential when the guarded database insert fails", async () => {
    const f = await fixture(),
      p = await prepare(f);
    await env.DB.prepare("UPDATE nodes SET schedulable=0 WHERE id=?")
      .bind(f.node)
      .run();
    const result = await env.DB.batch(p.statements());
    expect(result[0]!.meta.changes).toBe(0);
    expect(result[1]!.meta.changes).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT database_id FROM maintenance_credentials WHERE database_id=?",
      )
        .bind(p.id)
        .first(),
    ).toBeNull();
  });
  it("binds insertion to the expected project and initial creation generation", async () => {
    const f = await fixture(),
      p = await prepare(f);
    const result = await env.DB.batch([
      databaseInsertStatement(env.DB, p.snapshot),
      maintenanceCreationStatement(
        env.DB,
        { ...p.creation, projectId: f.other },
        p.encrypted,
      ),
    ]);
    expect(result[0]!.meta.changes).toBe(1);
    expect(result[1]!.meta.changes).toBe(0);
    expect(() =>
      maintenanceCreationStatement(
        env.DB,
        { ...p.creation, creationGeneration: 2 as 1 },
        p.encrypted,
      ),
    ).toThrow("initial generation");
  });
  it("reserves the exact customer role while allowing other pgcf-prefixed roles", async () => {
    const f = await fixture(),
      p = await prepare(f);
    await env.DB.batch(p.statements());
    expect(
      (
        await request(`/v1/databases/${p.id}/roles`, f.integrator, "POST", {
          name: MAINTENANCE_ROLE,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/v1/databases/${p.id}/roles`, f.integrator, "POST", {
          name: "pgcf_customer",
        })
      ).status,
    ).toBe(201);
  });
  it("deletes and emits deletion desired state with a retired maintenance credential key", async () => {
    const f = await fixture(),
      p = await prepare(f);
    await env.DB.batch(p.statements());
    const replacementKeys = JSON.stringify({
      active: "next",
      keys: {
        next: bytesToBase64url(crypto.getRandomValues(new Uint8Array(32))),
      },
    });
    const call = async (path: string, key: string, method = "GET") => {
      const context = createExecutionContext();
      const response = await createApp().fetch(
        new Request(`https://${["api", "invalid"].join(".")}${path}`, {
          method,
          headers: { Authorization: `Bearer ${key}` },
        }),
        { ...env, CREDENTIAL_KEYS: replacementKeys },
        context,
      );
      await waitOnExecutionContext(context);
      return response;
    };
    expect(
      (await call(`/v1/databases/${p.id}`, f.integrator, "DELETE")).status,
    ).toBe(202);
    const pageResponse = await call("/agent/v1/desired", f.agent);
    expect(pageResponse.status).toBe(200);
    const db = DesiredResponse.parse(await pageResponse.json()).databases.find(
      (db) => db.id === p.id,
    )!;
    expect(db.desired_state).toBe("deleted");
    expect(db.roles).toEqual([]);
    expect(db.maintenance).toBeUndefined();
  });
  it("leaves existing databases without an internal credential rather than minting on desired pulls", async () => {
    const f = await fixture(),
      response = await f.create();
    expect(response.status).toBe(202);
    const created = (await response.json()) as { database: { id: string } };
    const db = (await desired(f.agent)).databases.find(
      (db) => db.id === created.database.id,
    )!;
    expect(db.maintenance).toBeUndefined();
    await desired(f.agent);
    expect(
      await env.DB.prepare(
        "SELECT database_id FROM maintenance_credentials WHERE database_id=?",
      )
        .bind(db.id)
        .first(),
    ).toBeNull();
  });
});
