// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { NodeDesiredQuery } from "@pgcf/contracts";
import {
  COLD_STORAGE_SLEEP_MS,
  coldStorageTargets,
  requestColdStorageWake,
  runColdStorageCron,
  startColdStorageArchive,
} from "../../src/domain/cold-storage.ts";
import { applyLifecycleObservations } from "../../src/domain/lifecycle-observations.ts";
import { nodeDesiredPage } from "../../src/domain/node-desired.ts";
import { nodeRequest, nodeKeyPair } from "./fixtures.ts";
import { observation, report } from "./lifecycle-fixture.ts";

import {
  sleeping,
  status,
  residency,
  activePins,
  claimed,
  receipt,
  archived,
  cleanupColdFixture,
} from "./cold-storage-fixture.ts";
afterEach(cleanupColdFixture);

it("requires strictly more than 21 days of current proven sleep and explicit feature enablement", async () => {
  const f = await sleeping(COLD_STORAGE_SLEEP_MS);
  expect(
    await startColdStorageArchive(f.configured, f.id, f.current),
  ).toBeNull();
  expect(
    await startColdStorageArchive(
      { ...f.configured, COLD_STORAGE_ARCHIVAL_ENABLED: "false" },
      f.id,
      f.current + 1,
    ),
  ).toBeNull();
  expect(
    await startColdStorageArchive(f.configured, f.id, f.current + 1),
  ).not.toBeNull();
  expect(await activePins(f.id)).toBe(1);
});

it("preserves an identical sleep proof but resets the clock when a new sleep is reported without an intervening awake report", async () => {
  const f = await sleeping();
  const row = await f.row();
  const send = (proof: typeof f.proof) =>
    nodeRequest(f, "/node/v1/observations", {
      method: "POST",
      bindings: f.configured,
      body: report([
        observation({
          id: f.id,
          operation: f.operation,
          generation: row.generation,
          storage_generation: row.storage_generation,
          state: "asleep",
          proven_sleep: proof,
          backup: f.backup,
        }),
      ]),
    });
  expect((await send(f.proof)).status).toBe(200);
  expect(await residency(f.id)).toMatchObject({
    sleep_since: f.proof.proven_at,
  });
  const fresh = { ...f.proof, proven_at: new Date().toISOString() };
  expect((await send(fresh)).status).toBe(200);
  expect(await residency(f.id)).toMatchObject({ sleep_since: fresh.proven_at });
  expect((await send(fresh)).status).toBe(200);
  expect(await residency(f.id)).toMatchObject({ sleep_since: fresh.proven_at });
  expect(await startColdStorageArchive(f.configured, f.id)).toBeNull();
});

it("requires the complete current recovery proof and WAL before it claims a local database", async () => {
  const f = await sleeping();
  await env.ARCHIVE.delete(f.last);
  expect(await startColdStorageArchive(f.configured, f.id)).toBeNull();
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "local",
    node_id: f.node,
  });
  await f.put(f.last);
  await env.DB.prepare(
    "UPDATE database_recovery_points SET generation=generation+1 WHERE database_id=?",
  )
    .bind(f.id)
    .run();
  expect(await startColdStorageArchive(f.configured, f.id)).toBeNull();
  expect(await activePins(f.id)).toBe(0);
  await env.DB.prepare(
    "UPDATE database_recovery_points SET generation=(SELECT generation FROM databases WHERE id=?),proven_sleep_json=? WHERE database_id=?",
  )
    .bind(
      f.id,
      JSON.stringify({
        ...f.proof,
        last_archived_segment: "000000010000000000000003",
      }),
      f.id,
    )
    .run();
  expect(await startColdStorageArchive(f.configured, f.id)).toBeNull();
  expect(await activePins(f.id)).toBe(0);
});

it("rejects a verification of changed objects and retains the local copy", async () => {
  const f = await sleeping();
  const c = await claimed(f);
  await f.put(f.data, "different-archive-bytes");
  await applyLifecycleObservations(f.configured, f.node, {
    ...report([]),
    archive_verifications: [receipt(c.task)],
  });
  expect(await status(c.operation)).toMatchObject({
    phase: "failed",
    failure: "archive_changed",
    retirement_operation: null,
  });
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "local",
    node_id: f.node,
  });
  expect(await activePins(f.id)).toBe(0);
});

it("does not remove storage on a stale verification, and keeps a dispatched verifier pinned after cancellation", async () => {
  const f = await sleeping();
  const c = await claimed(f);
  await applyLifecycleObservations(f.configured, f.node, {
    ...report([]),
    archive_verifications: [
      { ...receipt(c.task), source_generation: c.task.source_generation + 1 },
    ],
  });
  expect((await status(c.operation)).phase).toBe("verifying");
  expect(
    await requestColdStorageWake(f.configured, f.id, { role: "app" }),
  ).toMatchObject({ handled: false, cancelledArchive: true });
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "local",
    node_id: f.node,
  });
  expect(await activePins(f.id)).toBe(1);
  await applyLifecycleObservations(f.configured, f.node, {
    ...report([]),
    archive_verifications: [receipt(c.task)],
  });
  expect(await activePins(f.id)).toBe(0);
});

it("rehydrates the same identity on the original node once, even when automatic archival is disabled", async () => {
  const f = await sleeping();
  const before = await f.row();
  await archived(f);
  const disabled = { ...f.configured, COLD_STORAGE_ARCHIVAL_ENABLED: "false" };
  const [first, second] = await Promise.all([
    requestColdStorageWake(disabled, f.id, { role: "app" }),
    requestColdStorageWake(disabled, f.id, { role: "app" }),
  ]);
  expect(second.operationId).toBe(first.operationId);
  const staged = await status(first.operationId!);
  expect(staged).toMatchObject({
    phase: "restoring",
    target_node_id: f.node,
    target_storage_generation: before.storage_generation + 1,
  });
  expect(await residency(f.id)).toMatchObject({
    node_id: null,
    storage_residency: "restoring",
  });
  const targets = await coldStorageTargets(disabled, f.node);
  expect(targets.get(f.id)?.origin).toMatchObject({
    kind: "rehydrate",
    source: { database_id: f.id, end: f.proof },
  });
  const target = observation({
    id: f.id,
    operation: first.operationId!,
    generation: staged.target_generation!,
    storage_generation: staged.target_storage_generation!,
    instance: crypto.randomUUID(),
    state: "ready",
    backup: { ...f.backup, timeline: f.proof.timeline + 1 },
    proven_sleep: null,
  });
  await applyLifecycleObservations(disabled, f.node, report([target]));
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "local",
    node_id: f.node,
    storage_generation: before.storage_generation + 1,
    sleep_since: null,
  });
  expect((await f.row()).id).toBe(f.id);
  expect(await activePins(f.id)).toBe(0);
  const response = await nodeRequest(f, "/node/v1/observations", {
    method: "POST",
    body: report([target]),
    bindings: disabled,
  });
  expect(response.status).toBe(200);
  expect(
    ((await response.json()) as { databases: { verdict: string }[] })
      .databases[0]?.verdict,
  ).toBe("accept");
  expect(
    (
      await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admit(
        f.id,
        "app",
      )
    ).ok,
  ).toBe(true);
});

it("places recovery on another qualified node in the same region when the original is full", async () => {
  const f = await sleeping();
  await archived(f);
  const key = await nodeKeyPair();
  await env.DB.prepare(
    `UPDATE nodes SET public_key=?,reported_release_id=?,os_boot_id=(SELECT os_boot_id FROM nodes WHERE id=?),os_booted_at=(SELECT os_booted_at FROM nodes WHERE id=?),os_kernel_release=(SELECT os_kernel_release FROM nodes WHERE id=?),os_packages_sha256=(SELECT os_packages_sha256 FROM nodes WHERE id=?),os_host_files_sha256=(SELECT os_host_files_sha256 FROM nodes WHERE id=?),last_observed_at=? WHERE id=?`,
  )
    .bind(
      key.publicKey,
      f.release,
      f.node,
      f.node,
      f.node,
      f.node,
      f.node,
      new Date().toISOString(),
      f.other,
    )
    .run();
  await env.DB.prepare(
    "UPDATE nodes SET last_sample_json=json_set(last_sample_json,'$.room',json('false')) WHERE id=?",
  )
    .bind(f.node)
    .run();
  const wake = await requestColdStorageWake(f.configured, f.id, {
    role: "app",
  });
  const staged = await status(wake.operationId!);
  expect(staged).toMatchObject({
    phase: "restoring",
    target_node_id: f.other,
    region_id: f.region,
  });
  const identity = (await env.DB.prepare(
    "SELECT id,node_uid uid,region_id FROM nodes WHERE id=?",
  )
    .bind(f.other)
    .first<{ id: string; uid: string; region_id: string }>())!;
  const page = await nodeDesiredPage(
    f.configured,
    { ...identity, fenced: false },
    NodeDesiredQuery.parse({}),
  );
  expect(page.databases.find((d) => d.id === f.id)?.origin?.kind).toBe(
    "rehydrate",
  );
});

it("keeps recovery durable without regional capacity and places it when capacity returns", async () => {
  const f = await sleeping();
  await archived(f);
  await env.DB.prepare(
    "UPDATE nodes SET last_sample_json=json_set(last_sample_json,'$.room',json('false')) WHERE id=?",
  )
    .bind(f.node)
    .run();
  const disabled = { ...f.configured, COLD_STORAGE_ARCHIVAL_ENABLED: "false" };
  const wake = await requestColdStorageWake(disabled, f.id, { role: "app" });
  expect(await status(wake.operationId!)).toMatchObject({
    phase: "waiting_capacity",
    target_node_id: null,
    target_storage_generation: null,
  });
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "restoring",
    node_id: null,
  });
  expect(await activePins(f.id)).toBe(2);
  expect(
    (await requestColdStorageWake(disabled, f.id, { role: "app" })).operationId,
  ).toBe(wake.operationId);
  await env.DB.prepare(
    "UPDATE nodes SET last_sample_json=json_set(last_sample_json,'$.room',json('true')) WHERE id=?",
  )
    .bind(f.node)
    .run();
  await runColdStorageCron(disabled);
  expect(await status(wake.operationId!)).toMatchObject({
    phase: "restoring",
    target_node_id: f.node,
  });
});
