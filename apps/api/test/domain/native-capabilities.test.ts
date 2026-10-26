// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation, NODE_STALE_MS } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { extendedNativeGuard } from "../../src/domain/native-capabilities.ts";
import { placePendingDatabases } from "../../src/domain/node-capacity.ts";
import { startDatabaseMove } from "../../src/domain/database-moves.ts";
import {
  addNode,
  cleanupFixtures,
  fixture,
  nodeOs,
  nodeRequest,
  qualifyExtendedNative,
  report,
  request,
  setNodePolicy,
  stageRelease,
} from "./fixtures.ts";

const extraReleases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of extraReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
type Fixture = Awaited<ReturnType<typeof fixture>>;
const createSmall = (
  f: Fixture,
  bindings?: { NATIVE_EXTENDED_RESOURCES_RELEASE_IDS?: string },
) =>
  request(
    "/v1/databases",
    f.admin,
    "POST",
    {
      project_id: f.project,
      region_id: f.region,
      size_class_id: f.size,
      name: `small-${crypto.randomUUID()}`,
      resources: { storage_mib: 500 },
    },
    undefined,
    undefined,
    bindings,
  );
const role = (
  f: Fixture,
  id: string,
  body: unknown,
  bindings?: { NATIVE_EXTENDED_RESOURCES_RELEASE_IDS?: string },
) =>
  request(
    `/v1/databases/${id}/roles`,
    f.integrator,
    "POST",
    body,
    crypto.randomUUID(),
    undefined,
    bindings,
  );

it("keeps legacy creation available but refuses new semantics with an empty or malformed release qualification", async () => {
  const f = await fixture();
  const created = await f.create();
  expect(created.status).toBe(202);
  const id = DatabaseWithOperation.parse(await created.json()).database.id;
  expect((await role(f, id, { name: "base" })).status).toBe(201);
  expect(
    (
      await role(f, id, {
        name: "legacy",
        member_of: ["base"],
        membership_options: { inherit: true, set: true },
      })
    ).status,
  ).toBe(201);
  const before = await env.DB.prepare(
    "SELECT generation FROM databases WHERE id=?",
  )
    .bind(id)
    .first("generation");
  expect(
    (
      await role(f, id, {
        name: "restricted",
        member_of: ["base"],
        membership_options: { inherit: true, set: false },
      })
    ).status,
  ).toBe(409);
  expect((await createSmall(f)).status).toBe(409);
  expect(
    (
      await createSmall(f, {
        NATIVE_EXTENDED_RESOURCES_RELEASE_IDS: "not-json",
      })
    ).status,
  ).toBe(409);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(id)
      .first("generation"),
  ).toBe(before);
  expect(
    await env.DB.prepare("SELECT COUNT(*) n FROM databases WHERE project_id=?")
      .bind(f.project)
      .first("n"),
  ).toBe(1);
});

it("requires fresh release and OS convergence throughout a mixed region, then accepts the qualified node", async () => {
  const f = await fixture();
  const qualified = await qualifyExtendedNative(f);
  const second = await addNode(f.region);
  // A ready but unenrolled placement candidate must not be silently excluded from the gate.
  expect((await createSmall(f)).status).toBe(409);
  await env.DB.prepare("UPDATE nodes SET node_uid=?,public_key=? WHERE id=?")
    .bind(crypto.randomUUID(), f.nodePublicKey, second)
    .run();
  expect((await createSmall(f)).status).toBe(409);
  await env.DB.prepare("UPDATE nodes SET lost_at=? WHERE id=?")
    .bind(new Date().toISOString(), second)
    .run();
  await env.DB.prepare("UPDATE nodes SET os_host_files_sha256=? WHERE id=?")
    .bind("0".repeat(64), f.node)
    .run();
  expect((await createSmall(f)).status).toBe(409);
  await env.DB.prepare(
    "UPDATE nodes SET os_host_files_sha256=?,last_observed_at=? WHERE id=?",
  )
    .bind(
      nodeOs().host_files_sha256,
      new Date(Date.now() - NODE_STALE_MS - 1000).toISOString(),
      f.node,
    )
    .run();
  expect((await createSmall(f)).status).toBe(409);
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date().toISOString(), f.node)
    .run();
  const created = await createSmall(f);
  expect(created.status).toBe(202);
  const id = DatabaseWithOperation.parse(await created.json()).database.id;
  expect((await role(f, id, { name: "base" })).status).toBe(201);
  expect(
    (
      await role(f, id, {
        name: "restricted",
        member_of: ["base"],
        membership_options: { inherit: true, set: false },
      })
    ).status,
  ).toBe(201);
  // The captured predicate is re-evaluated by the write, not merely a preflight boolean.
  const guard = extendedNativeGuard(
    { ...env, ...qualified.bindings },
    { nodeId: f.node },
    true,
  );
  await env.DB.prepare("UPDATE nodes SET reported_release_id=NULL WHERE id=?")
    .bind(f.node)
    .run();
  const raced = await env.DB.prepare(
    `UPDATE databases SET name='unsafe' WHERE id=? AND (${guard.sql})`,
  )
    .bind(id, ...guard.bindings)
    .run();
  expect(raced.meta.changes).toBe(0);
});

it("refuses unsafe downgrades and whole unsafe desired pages while compatible updates remain pullable", async () => {
  const f = await fixture();
  const qualified = await qualifyExtendedNative(f);
  const created = await createSmall(f);
  expect(created.status).toBe(202);
  const id = DatabaseWithOperation.parse(await created.json()).database.id;
  const next = `release-${crypto.randomUUID()}`;
  extraReleases.push(next);
  expect(
    (
      await request(
        `/v1/fleet/releases/${next}`,
        f.admin,
        "PUT",
        await stageRelease(next),
      )
    ).status,
  ).toBe(200);
  const assign = (bindings?: {
    NATIVE_EXTENDED_RESOURCES_RELEASE_IDS?: string;
  }) =>
    request(
      `/v1/regions/${f.region}/release`,
      f.admin,
      "PUT",
      { expected_revision: 1, release_id: next },
      undefined,
      undefined,
      bindings,
    );
  expect((await assign()).status).toBe(409);
  const bindings = {
    NATIVE_EXTENDED_RESOURCES_RELEASE_IDS: JSON.stringify([qualified.id, next]),
  };
  expect((await assign(bindings)).status).toBe(200);
  expect((await createSmall(f, bindings)).status).toBe(409);
  // The currently running qualified release can receive the update even before reporting again.
  await setNodePolicy(f);
  await env.DB.prepare(
    "UPDATE nodes SET last_observed_at=NULL,os_packages_sha256=? WHERE id=?",
  )
    .bind("0".repeat(64), f.node)
    .run();
  const upgrade = await nodeRequest(f, "/node/v1/desired", { bindings });
  expect(upgrade.status).toBe(200);
  expect(await upgrade.json()).toMatchObject({
    release: { id: next },
    databases: [expect.objectContaining({ id })],
  });
  // An unexpected incompatible process cannot receive a list with restrictions silently dropped.
  await env.DB.prepare(
    "UPDATE nodes SET reported_release_id='old-incompatible' WHERE id=?",
  )
    .bind(f.node)
    .run();
  const refused = await nodeRequest(f, "/node/v1/desired", { bindings });
  expect(refused.status).toBe(409);
  expect(await refused.json()).not.toHaveProperty("databases");
  expect(
    await env.DB.prepare("SELECT deleted_at FROM databases WHERE id=?")
      .bind(id)
      .first("deleted_at"),
  ).toBeNull();
});

it("does not place queued extended databases or move them onto an incompatible node", async () => {
  const f = await fixture();
  const qualified = await qualifyExtendedNative(f);
  const response = await createSmall(f);
  const id = DatabaseWithOperation.parse(await response.json()).database.id;
  const target = await addNode(f.region);
  await env.DB.prepare("UPDATE nodes SET node_uid=?,public_key=? WHERE id=?")
    .bind(crypto.randomUUID(), f.nodePublicKey, target)
    .run();
  await report(f, id, 1);
  await expect(
    startDatabaseMove(
      { ...env, ...qualified.bindings },
      { databaseId: id, targetNodeId: target },
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  await env.DB.prepare("UPDATE databases SET node_id=NULL WHERE id=?")
    .bind(id)
    .run();
  await env.DB.prepare(
    "UPDATE operations SET status='pending',completed_at=NULL WHERE database_id=? AND kind='database.create'",
  )
    .bind(id)
    .run();
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_enabled=0 WHERE id=?",
  )
    .bind(f.node)
    .run();
  expect(
    await placePendingDatabases(
      env.DB,
      f.region,
      8,
      qualified.bindings.NATIVE_EXTENDED_RESOURCES_RELEASE_IDS,
    ),
  ).toEqual([]);
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(id)
      .first("node_id"),
  ).toBeNull();
});

it("protects whole-GiB databases whose role flags alone require the new native contract", async () => {
  const f = await fixture();
  await qualifyExtendedNative(f);
  const id = DatabaseWithOperation.parse(await (await f.create()).json())
    .database.id;
  await role(f, id, { name: "base" });
  const created = await role(f, id, {
    name: "restricted",
    member_of: ["base"],
    membership_options: { inherit: true, set: false },
  });
  expect(created.status).toBe(201);
  await report(f, id, 3);
  await env.DB.prepare("UPDATE nodes SET restore_in_place_capable=1 WHERE id=?")
    .bind(f.node)
    .run();
  const restore = await request(
    `/v1/databases/${id}/restore-in-place`,
    f.integrator,
    "POST",
    {
      mode: "pitr",
      target_time: new Date(Date.now() - 60_000).toISOString(),
    },
    undefined,
    undefined,
    { NATIVE_EXTENDED_RESOURCES_RELEASE_IDS: "[]" },
  );
  expect(restore.status).toBe(409);
  expect(await restore.json()).toMatchObject({
    error: { message: expect.stringContaining("qualified native release") },
  });
  const old = `release-${crypto.randomUUID()}`;
  extraReleases.push(old);
  await request(
    `/v1/fleet/releases/${old}`,
    f.admin,
    "PUT",
    await stageRelease(old),
  );
  const downgrade = await request(
    `/v1/regions/${f.region}/release`,
    f.admin,
    "PUT",
    { expected_revision: 1, release_id: old },
  );
  expect(downgrade.status).toBe(409);
  expect(await downgrade.json()).toMatchObject({
    error: { message: expect.stringContaining("downgrade is refused") },
  });
});

it("retains the native format floor after resize, role removal and database deletion", async () => {
  const f = await fixture();
  await qualifyExtendedNative(f);
  const response = await createSmall(f);
  const id = DatabaseWithOperation.parse(await response.json()).database.id;
  const old = `release-${crypto.randomUUID()}`;
  extraReleases.push(old);
  await request(
    `/v1/fleet/releases/${old}`,
    f.admin,
    "PUT",
    await stageRelease(old),
  );
  const downgrade = () =>
    request(`/v1/regions/${f.region}/release`, f.admin, "PUT", {
      expected_revision: 1,
      release_id: old,
    });
  // A desired growth does not prove the old sub-GiB state has disappeared from disk.
  await env.DB.prepare("UPDATE databases SET own_storage_mib=1024 WHERE id=?")
    .bind(id)
    .run();
  expect((await downgrade()).status).toBe(409);
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), id)
    .run();
  expect((await downgrade()).status).toBe(409);
  await setNodePolicy(f);
  await env.DB.prepare("UPDATE nodes SET reported_release_id=? WHERE id=?")
    .bind(old, f.node)
    .run();
  expect((await nodeRequest(f, "/node/v1/desired")).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT native_extended_resources_required FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first("native_extended_resources_required"),
  ).toBe(1);
  await expect(
    env.DB.prepare(
      "UPDATE regions SET native_extended_resources_required=0 WHERE id=?",
    )
      .bind(f.region)
      .run(),
  ).rejects.toThrow();

  const roles = await fixture();
  await qualifyExtendedNative(roles);
  const whole = DatabaseWithOperation.parse(await (await roles.create()).json())
    .database.id;
  await role(roles, whole, { name: "base" });
  await role(roles, whole, {
    name: "restricted",
    member_of: ["base"],
    membership_options: { inherit: true, set: false },
  });
  await env.DB.prepare(
    "DELETE FROM roles WHERE database_id=? AND name='restricted'",
  )
    .bind(whole)
    .run();
  expect(
    await env.DB.prepare(
      "SELECT native_extended_resources_required FROM regions WHERE id=?",
    )
      .bind(roles.region)
      .first("native_extended_resources_required"),
  ).toBe(1);
});

it("keeps the normal update page available to an empty node in a region with an established floor", async () => {
  const f = await fixture();
  await qualifyExtendedNative(f);
  await setNodePolicy(f);
  await env.DB.prepare(
    "UPDATE regions SET native_extended_resources_required=1 WHERE id=?",
  )
    .bind(f.region)
    .run();
  await env.DB.prepare("UPDATE nodes SET reported_release_id=NULL WHERE id=?")
    .bind(f.node)
    .run();
  const response = await nodeRequest(f, "/node/v1/desired");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    databases: [],
    release: { id: expect.any(String) },
  });
});
