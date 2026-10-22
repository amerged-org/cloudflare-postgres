// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  assertNodeRecoveryAuthority,
  configureNodeRegionPolicy,
  markNodeLost,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import { declareNodeLost } from "../../src/domain/node-loss.ts";
import { applyLifecycleObservations } from "../../src/domain/lifecycle-observations.ts";
import {
  acknowledgeReinstallOverride,
  assertReinstallAllowed,
  reinstallBlockers,
} from "../../src/domain/reinstall-guard.ts";
import {
  cleanup,
  lifecycle,
  observation,
  report,
} from "./lifecycle-fixture.ts";

afterEach(cleanup);
const keyId = "key_" + "a".repeat(20);

async function node() {
  const f = await lifecycle();
  const uid = (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string>("node_uid"))!;
  const provider = (await env.DB.prepare(
    "SELECT provider_instance_id FROM nodes WHERE id=?",
  )
    .bind(f.node)
    .first<string>("provider_instance_id"))!;
  const reported = (state: "asleep" | "ready", patch = {}) =>
    applyLifecycleObservations(
      env,
      f.node,
      report([
        observation({
          id: f.id,
          generation: 1,
          operation: f.operation,
          state,
          ...patch,
        }),
      ]),
    );
  /** The fence has run its course: the Tunnel is gone and the instance is confirmed stopped. */
  const fenced = (at = new Date().toISOString()) =>
    env.DB.prepare(
      "UPDATE node_losses SET tunnel_deleted_at=?,power_off_requested_at=?,powered_off_at=? WHERE node_id=?",
    )
      .bind(at, at, at, f.node)
      .run();
  const declare = () =>
    declareNodeLost(env, f.node, { expected_node_uid: uid, reason: "gone" });
  return { ...f, uid, provider, reported, fenced, declare };
}

it("blocks a node while a database has no proven-sleep record for its current storage generation", async () => {
  const f = await node();
  // Never reported.
  expect((await reinstallBlockers(env.DB, f.node)).map((b) => b.id)).toEqual([
    f.id,
  ]);
  // Awake: the proof, if any, was taken back.
  await f.reported("ready");
  expect(await reinstallBlockers(env.DB, f.node)).toHaveLength(1);
  // Asleep with the record.
  await f.reported("asleep");
  expect(await reinstallBlockers(env.DB, f.node)).toEqual([]);
  // Awake again: a later wake takes the record back.
  await f.reported("ready");
  expect(await reinstallBlockers(env.DB, f.node)).toHaveLength(1);
  await f.reported("asleep");
  expect(await reinstallBlockers(env.DB, f.node)).toEqual([]);
  // A record of an older storage generation proves nothing about the current one.
  await env.DB.prepare("UPDATE databases SET storage_generation=2 WHERE id=?")
    .bind(f.id)
    .run();
  expect(await reinstallBlockers(env.DB, f.node)).toHaveLength(1);
  // A deleted database is nothing to protect.
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), f.id)
    .run();
  expect(await reinstallBlockers(env.DB, f.node)).toEqual([]);
});

it("takes a wake that D1 committed after the report as taking the proof back", async () => {
  const f = await node();
  await f.reported("asleep");
  expect(await reinstallBlockers(env.DB, f.node)).toEqual([]);
  // A wake claim (or any change) moved D1 to generation 2; the node crashed before it reported again.
  await env.DB.prepare("UPDATE databases SET generation=2 WHERE id=?")
    .bind(f.id)
    .run();
  expect((await reinstallBlockers(env.DB, f.node)).map((b) => b.id)).toEqual([
    f.id,
  ]);
  await f.declare();
  await f.fenced();
  await expect(assertReinstallAllowed(env.DB, f.node)).rejects.toMatchObject({
    code: "conflict",
    message: expect.stringContaining(f.id),
  });
});

it("proves a sleep again only with a report of the current generation, and keeps a newer point against an older report", async () => {
  const f = await node();
  await f.reported("asleep");
  await env.DB.prepare("UPDATE databases SET generation=2 WHERE id=?")
    .bind(f.id)
    .run();
  // A report that still answers generation 1 is stale: it proves nothing about generation 2.
  await f.reported("asleep", { generation: 1 });
  expect(await reinstallBlockers(env.DB, f.node)).toHaveLength(1);
  // The node applied generation 2 and slept again with a proof.
  await f.reported("asleep", { generation: 2 });
  expect(await reinstallBlockers(env.DB, f.node)).toEqual([]);
  // A report of a node that was a step behind arrives later, awake and on the older generation.
  await f.reported("ready", { generation: 1 });
  expect(await reinstallBlockers(env.DB, f.node)).toEqual([]);
  expect(
    await env.DB.prepare(
      "SELECT state,generation FROM database_recovery_points WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ state: "asleep", generation: 2 });
});

it("refuses a reinstall that would overwrite unarchived WAL, names the databases, and yields to the owner's acknowledgement only", async () => {
  const f = await node();
  await f.declare();
  await f.fenced();
  const refusal = await assertReinstallAllowed(env.DB, f.node).catch((e) => e);
  expect(refusal).toMatchObject({ code: "conflict" });
  expect(refusal.message).toContain(f.id);
  expect(refusal.message).toContain(`/v1/nodes/${f.node}/reinstall-override`);
  // An acknowledgement needs a node that was declared lost.
  await expect(
    acknowledgeReinstallOverride(
      env.DB,
      "nod_" + "z".repeat(20),
      keyId,
      "x",
      0,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  await acknowledgeReinstallOverride(
    env.DB,
    f.node,
    keyId,
    "accepted",
    Date.now(),
  );
  await expect(assertReinstallAllowed(env.DB, f.node)).resolves.toBeUndefined();
});

it("also waits for the fence to be complete, whatever the databases proved", async () => {
  const f = await node();
  await f.reported("asleep");
  await f.declare();
  await expect(assertReinstallAllowed(env.DB, f.node)).rejects.toMatchObject({
    code: "conflict",
    message: expect.stringContaining("not fenced"),
  });
  await f.fenced();
  await expect(assertReinstallAllowed(env.DB, f.node)).resolves.toBeUndefined();
});

it("lets the owner's acknowledgement lift the missing proofs but never an incomplete fence", async () => {
  const f = await node();
  await f.declare();
  await acknowledgeReinstallOverride(
    env.DB,
    f.node,
    keyId,
    "accepted",
    Date.now(),
  );
  await expect(assertReinstallAllowed(env.DB, f.node)).rejects.toMatchObject({
    code: "conflict",
    message: expect.stringContaining("not fenced"),
  });
  await f.fenced();
  await expect(assertReinstallAllowed(env.DB, f.node)).resolves.toBeUndefined();
});

it("guards AddNode in recover mode when it is requested and again when it is carried out", async () => {
  const f = await node();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 4,
    purchases_enabled: false,
    order: null,
  });
  await f.reported("asleep");
  // Marked lost without a fence of its own: only the proofs stand between the request and the disk.
  // A lost node is fenced, so its later reports change no proof (a wake that D1 committed does).
  await markNodeLost(env.DB, f.node, {
    expected_node_uid: f.uid,
    reason: "gone",
  });
  const request = () => ({
    mode: "recover" as const,
    region_id: f.region,
    provider_instance_id: f.provider,
    predecessor_node_id: f.node,
    expected_node_uid: f.uid,
  });
  const addition = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: request(),
  });
  await expect(
    assertNodeRecoveryAuthority(env.DB, addition),
  ).resolves.toBeUndefined();
  // The database woke between the request and the install: the guard holds at the install too.
  await env.DB.prepare("UPDATE databases SET generation=2 WHERE id=?")
    .bind(f.id)
    .run();
  await expect(
    assertNodeRecoveryAuthority(env.DB, addition),
  ).rejects.toMatchObject({ code: "conflict" });
  // And a new request is refused up front.
  await expect(
    reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: request(),
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await acknowledgeReinstallOverride(
    env.DB,
    f.node,
    keyId,
    "accepted",
    Date.now(),
  );
  await expect(
    assertNodeRecoveryAuthority(env.DB, addition),
  ).resolves.toBeUndefined();
});
