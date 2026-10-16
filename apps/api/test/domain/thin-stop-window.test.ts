// SPDX-License-Identifier: Apache-2.0
// The host lease while a thin database's sleep is being carried out, on real D1 fixtures: the
// instance Pod the node evidences stays the running writer until the controller reports the stop.
// Controlled metadata only; no live qualification or Dev evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { DatabaseWithOperation, DesiredResponse } from "@pgcf/contracts";
import {
  HostStorageLease,
  NodeStorageHeadroomResponse,
} from "@pgcf/contracts/node-thin-storage";
import { cleanupFixtures, request } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  gib,
  identityProof,
  lvs,
  mib,
  nonce,
  post,
  sample,
} from "./thin-renewal-fixture.ts";
import {
  type AwakeWriter,
  awakeWriter,
  claimsOf,
  hibernated,
  idleIntent,
  leaseEntry,
  parkedPod,
} from "./parked-tier-fixture.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
type Entry = HostStorageLease["databases"][number];

/** The window: the Pod the node evidences is the running writer of the sleep's generation. */
function expectWindow(entry: Entry, w: AwakeWriter, generation: number) {
  expect(entry).toMatchObject({
    generation,
    desired_state: "running",
    write_blocked: false,
    startup_expires_at: null,
    startup_operation_id: null,
    drain: null,
    volume: w.receipt,
    runtime_authority: expect.stringMatching(/^sa1\./),
  });
  expect(claimsOf(entry.runtime_authority)).toMatchObject({
    database_id: w.id,
    generation,
    authority_revision: entry.authority_revision,
    pod_uid: w.pod,
    lv_uuid: w.receipt.lv_uuid,
    write_allowed: true,
  });
}
const suspendedEntry = {
  desired_state: "suspended",
  startup_expires_at: null,
  startup_operation_id: null,
  runtime_authority: null,
  drain: null,
};

it("an idle sleep keeps its instance Pod the running writer until the controller reports it", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases)),
    f = w.f;
  const intent = await idleIntent(w);
  expectWindow(await leaseEntry(f, w.id), w, intent.generation);
  // Only the host guard is told. The controller needs no token to stop a suspended database, and
  // the gateway's ledger must not admit writers to it: desired state and headroom renewals carry none.
  const record = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  ).databases.find((d) => d.id === w.id)!;
  expect(record).toMatchObject({ desired_state: "suspended" });
  expect(record.storage_authority).toBeUndefined();
  const physical = {
    ...w.physical,
    thin_pool: {
      ...w.physical.thin_pool!,
      data_used_bytes_upper_bound: 64 * mib,
      metadata_used_bytes_upper_bound: mib,
    },
  };
  const renewal = await post(f, sample(f, await nonce(f), { physical }));
  expect(renewal.status).toBe(200);
  const renewed = NodeStorageHeadroomResponse.parse(renewal.body);
  expect(renewed.accepted).toBe(true);
  expect(renewed.tokens.map((token) => token.database_id)).not.toContain(w.id);
  // The controller reports the sleep done with the Pod gone: the ordinary suspended entry.
  expect(await (await hibernated(w, intent)).json()).toEqual({ accepted: 1 });
  expect(await leaseEntry(f, w.id)).toMatchObject(suspendedEntry);
});

it("a sleep that ends parked keeps the token its window had", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  const intent = await idleIntent(w);
  const window = claimsOf((await leaseEntry(w.f, w.id)).runtime_authority)!;
  await w.evidence({ generation: intent.generation });
  expect(await (await hibernated(w, intent, parkedPod(w))).json()).toEqual({
    accepted: 1,
  });
  const parked = await leaseEntry(w.f, w.id);
  expect(parked).toMatchObject({
    desired_state: "running",
    startup_operation_id: null,
    drain: null,
  });
  expect(claimsOf(parked.runtime_authority)).toMatchObject({
    database_id: window.database_id,
    generation: window.generation,
    pod_uid: window.pod_uid,
  });
});

it("a manual suspend is carried out under the same window", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  const suspended = await request(
    `/v1/databases/${w.id}/suspend`,
    w.f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(suspended.status).toBe(202);
  const stop = DatabaseWithOperation.parse(await suspended.json());
  expectWindow(await leaseEntry(w.f, w.id), w, stop.database.generation);
  // The stop deletes the instance Pod; once reported the guard may freeze the volume it left.
  expect(
    await (
      await hibernated(w, {
        operation: stop.operation.id,
        generation: stop.database.generation,
      })
    ).json(),
  ).toEqual({ accepted: 1 });
  expect(await leaseEntry(w.f, w.id)).toMatchObject(suspendedEntry);
});

it("the window needs one evidenced Pod, a current reading and a stop still under way", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases)),
    entry = () => leaseEntry(w.f, w.id);
  const intent = await idleIntent(w);
  // Well after the start, a reading that measured no Pod names no writer: as for a running
  // database, the held writer ends with the first post-ready reading.
  await env.DB.prepare(
    "UPDATE databases SET runtime_attestation_json=json_set(runtime_attestation_json,'$.observed_at',?) WHERE id=?",
  )
    .bind(Date.now() - 10_000, w.id)
    .run();
  await w.evidence({ io: [] });
  expect(await entry()).toMatchObject(suspendedEntry);
  // Neither do two.
  await w.evidence({
    io: [
      { pod_uid: w.pod, ...w.limits },
      { pod_uid: crypto.randomUUID(), ...w.limits },
    ],
  });
  expect(await entry()).toMatchObject(suspendedEntry);
  // A volume frozen at the sleep's generation is a protective stop, not a writer.
  await w.evidence({ generation: intent.generation, quiesced: true });
  expect(await entry()).toMatchObject(suspendedEntry);
  await w.evidence();
  expectWindow(await entry(), w, intent.generation);
  // A reading that is no longer current names no writer either.
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_received_at=? WHERE node_id=?",
  )
    .bind(new Date(Date.now() - 200_000).toISOString(), w.f.node)
    .run();
  expect(await entry()).toMatchObject(suspendedEntry);
  await w.evidence();
  expectWindow(await entry(), w, intent.generation);
  // A stop that timed out is over: the guard takes the volume.
  await env.DB.prepare(
    "UPDATE operations SET status='failed',error_code='power_timeout',completed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), intent.operation)
    .run();
  expect(await entry()).toMatchObject(suspendedEntry);
});

/** A reading of the node that has the volume but has not measured any Pod's io.max on it yet. */
const unmeasured = (w: AwakeWriter) =>
  identityProof(w.f, {
    physical: w.physical,
    physical_lvs: [
      lvs.pool,
      lvs.data,
      lvs.meta,
      {
        name: w.receipt.volume_handle,
        lv_uuid: w.receipt.lv_uuid,
        size_bytes: 5 * gib,
        segtype: "thin",
      },
    ],
    active_lv_uuids: [w.receipt.lv_uuid],
    volumes: [],
  });

it("a database idled before any reading measured its Pod gets the window from its held writer", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  // Ready moments ago: the controller attested the Pod under its startup hold, and the node's
  // reading has not measured it yet. The running token already trusts exactly that.
  await unmeasured(w);
  const intent = await idleIntent(w);
  expectWindow(await leaseEntry(w.f, w.id), w, intent.generation);
});

it("a sleep with neither a measured nor a held writer gets no window", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  await unmeasured(w);
  // No attestation, and none remembered by the start's hold either.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE databases SET runtime_attestation_json=NULL WHERE id=?",
    ).bind(w.id),
    env.DB.prepare(
      "UPDATE database_start_admissions SET attested_json=NULL WHERE database_id=?",
    ).bind(w.id),
  ]);
  await idleIntent(w);
  expect(await leaseEntry(w.f, w.id)).toMatchObject(suspendedEntry);
});

it("an attested Pod that differs from the measured writer gets no window", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  // The node measured the Pod's io.max while the controller's attestation names another Pod.
  await env.DB.prepare(
    "UPDATE databases SET runtime_attestation_json=json_set(runtime_attestation_json,'$.pod_uid',?) WHERE id=?",
  )
    .bind(crypto.randomUUID(), w.id)
    .run();
  await idleIntent(w);
  expect(await leaseEntry(w.f, w.id)).toMatchObject(suspendedEntry);
});

it("a deletion during the window drains as before", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  const intent = await idleIntent(w);
  expectWindow(await leaseEntry(w.f, w.id), w, intent.generation);
  const response = await request(
    `/v1/databases/${w.id}`,
    w.f.integrator,
    "DELETE",
    undefined,
    crypto.randomUUID(),
  );
  expect(response.status).toBe(202);
  const deleted = DatabaseWithOperation.parse(await response.json());
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    generation: deleted.database.generation,
    desired_state: "deleted",
    runtime_authority: null,
    drain: null,
  });
  // Once the node reads the volume quiesced at the deletion's generation, the deletion drains.
  await w.evidence({
    generation: deleted.database.generation,
    quiesced: true,
  });
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    desired_state: "deleted",
    runtime_authority: null,
    drain: {
      operation_id: deleted.operation.id,
      kind: "database.delete",
      generation: deleted.database.generation,
    },
  });
});
