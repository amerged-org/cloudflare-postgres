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
import {
  readColdSnapshotChunk,
  readColdSnapshotManifest,
  sealColdSnapshot,
} from "../../src/domain/cold-snapshots.ts";
import { observation, report } from "./lifecycle-fixture.ts";

import {
  sleeping,
  status,
  residency,
  activePins,
  claimed,
  capturing,
  declareFixtureSnapshot,
  receipt,
  archived,
  cleanupColdFixture,
} from "./cold-storage-fixture.ts";
afterEach(cleanupColdFixture);

it("requires strictly more than 21 days of current proven sleep and explicit feature enablement", async () => {
  const f = await sleeping(COLD_STORAGE_SLEEP_MS);
  expect(
    await startColdStorageArchive(
      {
        ...f.configured,
        COLD_STORAGE_ARCHIVAL_DATABASE_IDS: JSON.stringify([f.id]),
      },
      f.id,
      f.current,
    ),
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

it("limits new claims to the rollout allowlist and refuses malformed or empty scopes", async () => {
  const f = await sleeping();
  const scoped = (value: string) => ({
    ...f.configured,
    COLD_STORAGE_ARCHIVAL_DATABASE_IDS: value,
  });
  expect(await startColdStorageArchive(scoped("[]"), f.id)).toBeNull();
  expect(await startColdStorageArchive(scoped("["), f.id)).toBeNull();
  expect(await startColdStorageArchive(scoped("null"), f.id)).toBeNull();
  expect(
    await startColdStorageArchive(
      scoped(JSON.stringify([f.id, "not-a-database-id"])),
      f.id,
    ),
  ).toBeNull();
  expect(
    await startColdStorageArchive(
      scoped(JSON.stringify(["a0000000000000000000"])),
      f.id,
    ),
  ).toBeNull();
  const selected = scoped(JSON.stringify([f.id]));
  expect((await runColdStorageCron(scoped("[]"))).claimed).toBe(0);
  expect(
    await startColdStorageArchive(
      { ...selected, COLD_STORAGE_ARCHIVAL_ENABLED: "false" },
      f.id,
    ),
  ).toBeNull();
  expect(await startColdStorageArchive(selected, f.id)).not.toBeNull();
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

it("requires the exact current stopped-source proof rather than relying on legacy backup objects", async () => {
  const f = await sleeping();
  await env.ARCHIVE.delete(f.last);
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
  await env.DB.prepare(
    "UPDATE database_recovery_points SET proven_sleep_json=? WHERE database_id=?",
  )
    .bind(JSON.stringify(f.proof), f.id)
    .run();
  expect(await startColdStorageArchive(f.configured, f.id)).not.toBeNull();
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "archiving",
    node_id: f.node,
  });
});

it("does not seal or verify a snapshot with a declared but missing chunk", async () => {
  const f = await sleeping();
  const c = await capturing(f);
  const snapshot = await declareFixtureSnapshot(f, c);
  await expect(
    sealColdSnapshot(f.configured, c.caller, c.operation, snapshot.sha256),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await status(c.operation)).toMatchObject({
    phase: "capturing",
    snapshot_sealed_at: null,
    retirement_operation: null,
  });
  expect(await residency(f.id)).toMatchObject({
    node_id: f.node,
    storage_residency: "archiving",
  });
});

it("rejects a verification of changed objects and retains the local copy", async () => {
  const f = await sleeping();
  const c = await claimed(f);
  await f.put(c.chunkKey, "different-snapshot-bytes");
  await expect(
    readColdSnapshotChunk(f.configured, c.caller, c.operation, 0),
  ).rejects.toMatchObject({ code: "conflict" });
  await applyLifecycleObservations(f.configured, f.node, {
    ...report([]),
    archive_verifications: [
      {
        operation: c.operation,
        database_id: f.id,
        source_generation: c.task.source_generation,
        source_storage_generation: c.task.source_storage_generation,
        manifest_sha256: c.sha256,
        observed_at: new Date().toISOString(),
        status: "failed",
        reason: "snapshot_read_failed",
        cleaned_up: true,
      },
    ],
  });
  expect(await status(c.operation)).toMatchObject({
    phase: "failed",
    failure: "snapshot_read_failed",
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
  ).toMatchObject({ handled: true, waiting: true });
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "archiving",
    node_id: f.node,
  });
  expect(await activePins(f.id)).toBe(1);
  await applyLifecycleObservations(f.configured, f.node, {
    ...report([]),
    archive_verifications: [receipt(c.task)],
  });
  expect(await activePins(f.id)).toBe(0);
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "local",
    node_id: f.node,
  });
});

it("rehydrates the same identity on the original node once, even when automatic archival is disabled", async () => {
  const f = await sleeping();
  const before = await f.row();
  await archived(f);
  const disabled = {
    ...f.configured,
    COLD_STORAGE_ARCHIVAL_ENABLED: "false",
    COLD_STORAGE_ARCHIVAL_DATABASE_IDS: "invalid-rollout-scope",
  };
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
  expect(targets.get(f.id)?.cold_snapshot_pending).toBe(true);
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
    backup: {
      ...f.backup,
      timeline: f.proof.timeline,
      completed_at: new Date().toISOString(),
    },
    cold_snapshot_restore: {
      snapshot_operation: staged.source_operation!,
      manifest_sha256: staged.snapshot_manifest_sha256!,
      system_identifier: f.proof.system_identifier,
      timeline: f.proof.timeline,
      checkpoint_lsn: f.proof.checkpoint_lsn,
      verified_at: new Date().toISOString(),
    },
    cold_snapshot_serving: false,
    proven_sleep: null,
  });
  const stagedResponse = await nodeRequest(f, "/node/v1/observations", {
    method: "POST",
    body: report([target]),
    bindings: disabled,
  });
  expect(stagedResponse.status).toBe(200);
  const activating = await status(first.operationId!);
  expect(activating.phase).toBe("activating");
  expect(activating.target_serving_generation).toBeGreaterThan(
    activating.target_generation!,
  );
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "restoring",
    node_id: f.node,
    generation: activating.target_serving_generation,
  });
  expect(await activePins(f.id)).toBeGreaterThan(0);
  const targetCaller = {
    id: f.node,
    uid: f.nodeUid,
    region_id: f.region,
    fenced: false,
  };
  expect(
    (
      await readColdSnapshotManifest(
        disabled,
        targetCaller,
        staged.source_operation!,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await readColdSnapshotChunk(
        disabled,
        targetCaller,
        staged.source_operation!,
        0,
      )
    ).status,
  ).toBe(200);
  const servingPage = await nodeDesiredPage(
    disabled,
    { id: f.node, uid: f.nodeUid, region_id: f.region, fenced: false },
    NodeDesiredQuery.parse({}),
  );
  const servingEntry = servingPage.databases.find((d) => d.id === f.id)!;
  expect(servingEntry).toMatchObject({
    generation: activating.target_serving_generation,
    operation: first.operationId,
    cold_snapshot_pending: true,
  });
  expect(servingEntry.origin).toBeUndefined();
  expect(
    (
      await nodeRequest(f, "/node/v1/observations", {
        method: "POST",
        body: report([target]),
        bindings: disabled,
      })
    ).status,
  ).toBe(200);
  expect((await status(first.operationId!)).phase).toBe("activating");
  const serving = {
    ...target,
    generation: activating.target_serving_generation!,
    cold_snapshot_serving: true,
  };
  const response = await nodeRequest(f, "/node/v1/observations", {
    method: "POST",
    body: report([serving]),
    bindings: disabled,
  });
  expect(response.status).toBe(200);
  expect(await residency(f.id)).toMatchObject({
    storage_residency: "local",
    node_id: f.node,
    storage_generation: before.storage_generation + 1,
    sleep_since: null,
  });
  expect((await f.row()).id).toBe(f.id);
  expect(await activePins(f.id)).toBe(0);
  await expect(
    readColdSnapshotManifest(disabled, targetCaller, staged.source_operation!),
  ).rejects.toMatchObject({ code: "not_found" });
  const completedPage = await nodeDesiredPage(
    disabled,
    { id: f.node, uid: f.nodeUid, region_id: f.region, fenced: false },
    NodeDesiredQuery.parse({}),
  );
  expect(
    completedPage.databases.find((d) => d.id === f.id)?.cold_snapshot_pending,
  ).not.toBe(true);
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

it("never accepts same-timeline readiness without the exact complete-snapshot attestation", async () => {
  const f = await sleeping();
  await archived(f);
  const wake = await requestColdStorageWake(f.configured, f.id, {
    role: "app",
  });
  const staged = await status(wake.operationId!);
  const ready = observation({
    id: f.id,
    operation: staged.operation,
    generation: staged.target_generation!,
    storage_generation: staged.target_storage_generation!,
    state: "ready",
    instance: crypto.randomUUID(),
    backup: {
      ...f.backup,
      timeline: f.proof.timeline,
      completed_at: new Date().toISOString(),
    },
    proven_sleep: null,
  });
  expect(
    (
      await nodeRequest(f, "/node/v1/observations", {
        method: "POST",
        body: report([ready]),
        bindings: f.configured,
      })
    ).status,
  ).toBe(200);
  expect((await status(staged.operation)).phase).toBe("restoring");
  expect(await residency(f.id)).toMatchObject({
    node_id: null,
    storage_residency: "restoring",
  });
  const wrong = {
    ...ready,
    cold_snapshot_restore: {
      snapshot_operation: staged.source_operation!,
      manifest_sha256: "f".repeat(64),
      system_identifier: f.proof.system_identifier,
      timeline: f.proof.timeline,
      checkpoint_lsn: f.proof.checkpoint_lsn,
      verified_at: new Date().toISOString(),
    },
  };
  expect(
    (
      await nodeRequest(f, "/node/v1/observations", {
        method: "POST",
        body: report([wrong]),
        bindings: f.configured,
      })
    ).status,
  ).toBe(200);
  expect((await status(staged.operation)).phase).toBe("restoring");
  expect(await activePins(f.id)).toBe(2);
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
  expect(
    (
      await readColdSnapshotManifest(
        f.configured,
        { ...identity, fenced: false },
        staged.source_operation!,
      )
    ).status,
  ).toBe(200);
  await expect(
    readColdSnapshotManifest(
      f.configured,
      { id: f.node, uid: f.nodeUid, region_id: f.region, fenced: false },
      staged.source_operation!,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
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
  await runColdStorageCron({
    ...disabled,
    COLD_STORAGE_ARCHIVAL_ENABLED: "true",
    COLD_STORAGE_ARCHIVAL_DATABASE_IDS: "invalid-rollout-scope",
  });
  expect(await status(wake.operationId!)).toMatchObject({
    phase: "restoring",
    target_node_id: f.node,
  });
});
