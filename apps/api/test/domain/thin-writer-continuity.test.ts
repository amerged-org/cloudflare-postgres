// SPDX-License-Identifier: Apache-2.0
// The writer token the controller and the gateway read for a running thin database, at the
// moments the node's identity proof, which names the Pod up to a minute and a half after a start,
// has not caught up: a start whose first ready report was followed by one without an attestation,
// a role change that advances the generation without starting anything, and a parked wake. The host
// lease permits every live database regardless. Real D1 fixtures; controlled metadata, no live
// evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  DatabaseStorageVolumeReceipt,
  DatabaseWithOperation,
  DesiredResponse,
  newOperationId,
  thinStorageClass,
} from "@pgcf/contracts";
import {
  cleanupFixtures,
  observation,
  observedBody,
  request,
} from "./fixtures.ts";
import {
  type AwakeWriter,
  awakeWriter,
  claimsOf,
  databaseRow,
  leaseEntry,
  parkedWriter,
  renewal,
} from "./parked-tier-fixture.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import { thinLeaseNode } from "./thin-lease-fixture.ts";
import { powerTransitionStatements } from "../../src/domain/lifecycle.ts";
import { storageHoldVolumeStatements } from "../../src/domain/storage-capacity.ts";
import {
  prepareThinStorageLease,
  storageHolds,
  thinStorageInput,
} from "../../src/domain/node-thin-storage-execution.ts";
import { gib, identityProof, lvs } from "./thin-renewal-fixture.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

/** The node's reading has the volume, active, and has not found any io.max on its Pod yet: the
 * proof reports no limit, so no Pod is measured as its writer. */
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
    volumes: [
      {
        database_id: w.id,
        generation: 1,
        storage_generation: 1,
        storage_uid: w.receipt.storage_uid,
        namespace_uid: w.receipt.namespace_uid,
        cluster_uid: w.receipt.cluster_uid,
        volume_handle: w.receipt.volume_handle,
        lv_uuid: w.receipt.lv_uuid,
        pvc_uid: w.receipt.pvc_uid,
        pv_uid: w.receipt.pv_uid,
        storage_class: thinStorageClass(w.f.authority.profile_sha256),
        volume_attributes_class: thinStorageClass(w.f.authority.profile_sha256),
        io: [],
      },
    ],
  });

/** The controller's ready report of a generation, without a runtime attestation: its read-back of
 * the Pod moved while it was built. */
function unattestedReady(w: AwakeWriter, generation: number, power?: string) {
  const postgres = w.f.qualified.spec.components.find(
    (component) => component.name === "postgres",
  )!;
  return request(
    "/agent/v1/observations",
    w.f.agent,
    "POST",
    observedBody([
      {
        ...observation(w.id, generation),
        ...(power
          ? {
              power: { operation: power, revision: generation, state: "awake" },
            }
          : {}),
        postgres: {
          image: postgres.reference,
          image_id: `sha256:${postgres.sha256}`,
        },
      },
    ]),
  );
}

/** The tokens of one accepted fast sample, the gateway's source. */
async function sampled(w: AwakeWriter) {
  const response = await renewal(w);
  expect(response.accepted).toBe(true);
  return response.tokens;
}
const desiredToken = async (w: AwakeWriter) =>
  DesiredResponse.parse(
    await (await request("/agent/v1/desired", w.f.agent)).json(),
  ).databases.find((database) => database.id === w.id)?.storage_authority;

/** What the controller and the gateway are given at this moment: the sample's and the desired
 * page's token, each naming `pod` at `generation`. The host lease permits the database whatever
 * the token says. */
async function expectWriter(w: AwakeWriter, generation: number, pod = w.pod) {
  const entry = await leaseEntry(w.f, w.id);
  expect(entry).toMatchObject({
    generation: generation + 1,
    desired_state: "running",
    write_blocked: false,
    runtime_authority: null,
  });
  const token = (await sampled(w)).find((value) => value.database_id === w.id);
  expect(claimsOf(token?.token)).toMatchObject({
    generation,
    pod_uid: pod,
    lv_uuid: w.receipt.lv_uuid,
  });
  expect(claimsOf(await desiredToken(w))).toMatchObject({
    generation,
    pod_uid: pod,
  });
  return entry;
}
const createRole = (w: AwakeWriter, name: string) =>
  request(
    `/v1/databases/${w.id}/roles`,
    w.f.integrator,
    "POST",
    { name },
    crypto.randomUUID(),
  );

it("keeps the evidenced writer's token across a role change that starts nothing", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  await expectWriter(w, 1);
  expect((await createRole(w, "reader")).status).toBe(201);
  const row = await databaseRow(w.id);
  expect(row).toMatchObject({ generation: 2, observed_generation: 1 });
  // No identity proof of generation 2 exists yet: the entry would have no token and no startup
  // grant, and the guard would stop the Pod.
  await expectWriter(w, 2);
  // The controller applies the role in place and reports generation 2 ready.
  expect((await w.ready(2)).status).toBe(200);
  await expectWriter(w, 2);
  // The proof prepared at generation 2 takes over, from the same Pod.
  await w.evidence({ generation: 2 });
  await expectWriter(w, 2);
  // And so it does for the next change and a password reset.
  const reset = await request(
    `/v1/databases/${w.id}/roles/reader/reset-password`,
    w.f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(reset.status).toBe(200);
  await expectWriter(w, 3);
}, 60_000);

it("keeps a held writer's token across a role change before any proof measured its Pod", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  await unmeasured(w);
  await expectWriter(w, 1);
  expect((await createRole(w, "reader")).status).toBe(201);
  // The start's hold and the controller's attestation of it still name the Pod.
  await expectWriter(w, 2);
  expect((await w.ready(2)).status).toBe(200);
  await expectWriter(w, 2);
  // Two changes before the controller has seen the first.
  expect((await createRole(w, "writer")).status).toBe(201);
  expect((await databaseRow(w.id)).generation).toBe(3);
  await expectWriter(w, 3);
  await w.evidence({ generation: 3 });
  await expectWriter(w, 3);
}, 60_000);

it("keeps a held writer's token when a later ready report carries no attestation", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  await unmeasured(w);
  await expectWriter(w, 1);
  // The controller's read-back moved while it built the next report: ready, without a proof.
  const accepted = await unattestedReady(w, 1);
  expect(await accepted.json()).toEqual({ accepted: 1 });
  expect((await databaseRow(w.id)).runtime_attestation_json).toBeNull();
  const entry = await expectWriter(w, 1);
  expect(entry.write_blocked).toBe(false);
  // The report that follows is attested again and agrees.
  expect((await w.ready(1)).status).toBe(200);
  await expectWriter(w, 1);
}, 60_000);

it("carries a parked wake's writer through every lease from the claim to the proof that names its io", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  const parked = await parkedWriter(w, "fast");
  const generation = parked.generation + 1;
  const resumed = await request(
    `/v1/databases/${w.id}/resume`,
    w.f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  const wake = DatabaseWithOperation.parse(await resumed.json());
  expect(wake.database.generation).toBe(generation);
  // Claimed: the parked Pod's token; the lease's startup operation is the database's own.
  const claimed = await expectWriter(w, generation);
  // The ready report commits: the held writer takes the token over.
  expect((await w.ready(generation, wake.operation.id)).status).toBe(200);
  const ready = await expectWriter(w, generation);
  expect(ready.startup_operation_id).toBe(claimed.startup_operation_id);
  // Kubelet and CNPG status writes follow within a second, and the controller's next report of
  // the generation has no attestation.
  expect(
    await (await unattestedReady(w, generation, wake.operation.id)).json(),
  ).toEqual({ accepted: 1 });
  await expectWriter(w, generation);
  // Samples renew the node's authority every couple of seconds while the proof is still the one
  // read while parked: every lease in between names the Pod.
  for (let i = 0; i < 3; i++) await expectWriter(w, generation);
  // The proof prepared at the wake's generation measures the Pod: exact evidence from then on.
  await w.evidence({ generation });
  await expectWriter(w, generation);
}, 60_000);

/** The Actor's wake claim, or the integrator's resume: the power transition itself, committed or not. */
async function transition(w: AwakeWriter, action: "wake" | "resume") {
  const operation = newOperationId();
  const [update] = await env.DB.batch(
    powerTransitionStatements(
      env.DB,
      await databaseRow(w.id),
      action,
      operation,
      new Date().toISOString(),
      action === "wake" ? "app" : undefined,
    ),
  );
  return { operation, committed: update!.meta.changes === 1 };
}

it("claims a parked wake on the proof of the start and carries the parked writer through every lease", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  // The sleep bumped the generation; the last proof still names the one the Pod was started for.
  const parked = await parkedWriter(w, "fast", { read: false });
  const claim = await transition(w, "wake");
  expect(claim.committed).toBe(true);
  const generation = parked.generation + 1;
  expect(await databaseRow(w.id)).toMatchObject({
    desired_state: "running",
    generation,
    power_operation: claim.operation,
  });
  // The parked Pod's token in the first reading of the wake, from the reading of the earlier
  // generation.
  const claimed = await expectWriter(w, generation);
  expect((await w.ready(generation, claim.operation)).status).toBe(200);
  const ready = await expectWriter(w, generation);
  expect(ready.startup_operation_id).toBe(claimed.startup_operation_id);
  // The proof prepared at the wake's generation measures the Pod: exact evidence from then on.
  await w.evidence({ generation });
  await expectWriter(w, generation);
}, 60_000);

it("names no writer when the node's reading and the controller's attestation name different Pods", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  expect((await createRole(w, "reader")).status).toBe(201);
  // The controller reports generation 2 ready with another Pod than the one the node measured.
  const other = crypto.randomUUID();
  expect(
    (
      await w.ready(2, undefined, {
        pod_uid: other,
      })
    ).status,
  ).toBe(200);
  // The host lease still permits it: one writer is the holder rule's, not a token's.
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    generation: 3,
    write_blocked: false,
    runtime_authority: null,
  });
  expect(
    (await sampled(w)).find((token) => token.database_id === w.id),
  ).toBeUndefined();
}, 60_000);

it("does not carry the previous Pod's reading into a generation a start began", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  // An ordinary wake: a new Pod starts at the next generation under a startup hold. The reading
  // that evidenced the parked Pod must not name a writer for it.
  await parkedWriter(w);
  const resumed = await request(
    `/v1/databases/${w.id}/resume`,
    w.f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(resumed.status).toBe(202);
  const entry = await leaseEntry(w.f, w.id);
  expect(entry).toMatchObject({
    desired_state: "running",
    runtime_authority: null,
    startup_expires_at: expect.any(Number),
  });
  // A role change on top of that start carries neither the old reading nor a writer.
  expect((await createRole(w, "reader")).status).toBe(201);
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    runtime_authority: null,
  });
}, 60_000);

it("keeps a start's startup grant, in the lease and in the desired page, across a role change", async () => {
  const node = await thinLeaseNode(await thinExecutionFixture(releases));
  await node.commit();
  const f = node.f,
    id = node.held.id;
  const startup = async () => {
    const entry = (await node.leaseEntries()).get(id)!;
    const record = DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    ).databases.find((database) => database.id === id)!;
    return { entry, record };
  };
  const before = await startup();
  expect(before.entry.startup_operation_id).toMatch(/^op_/);
  expect((await databaseRow(id)).generation).toBe(1);
  const created = await request(
    `/v1/databases/${id}/roles`,
    f.integrator,
    "POST",
    { name: "reader" },
    crypto.randomUUID(),
  );
  expect(created.status).toBe(201);
  expect((await databaseRow(id)).generation).toBe(2);
  const after = await startup();
  // The role change started nothing: the grant of the start under way still covers the Pod, one
  // past the row's generation, and the controller's own check of it sees the same.
  expect(after.entry).toMatchObject({
    generation: 3,
    write_blocked: false,
    startup_operation_id: before.entry.startup_operation_id,
    startup_expires_at: expect.any(Number),
  });
  expect(after.record.storage_startup).toMatchObject({
    operation_id: before.entry.startup_operation_id,
    generation: 2,
  });
}, 60_000);

it("keeps a parked wake's token and grant across a role change before the controller reports it", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  const parked = await parkedWriter(w, "fast");
  const resumed = await request(
    `/v1/databases/${w.id}/resume`,
    w.f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  const wake = DatabaseWithOperation.parse(await resumed.json());
  expect(wake.database.generation).toBe(parked.generation + 1);
  expect((await createRole(w, "reader")).status).toBe(201);
  const generation = parked.generation + 2;
  await expectWriter(w, generation);
  // The controller's report of the generation it applied the role in: ready, same Pod.
  expect((await w.ready(generation, wake.operation.id)).status).toBe(200);
  await expectWriter(w, generation);
}, 60_000);

it("does not let a role change release a protective stop", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  const operation = (await databaseRow(w.id)).power_operation;
  const protection = await env.DB.prepare(
    "SELECT id FROM operations WHERE database_id=? ORDER BY created_at LIMIT 1",
  )
    .bind(w.id)
    .first<string>("id");
  await env.DB.prepare(
    "UPDATE databases SET storage_protected_at=?,storage_protected_generation=generation,storage_protected_operation=? WHERE id=?",
  )
    .bind(new Date().toISOString(), operation ?? protection, w.id)
    .run();
  expect((await leaseEntry(w.f, w.id)).runtime_authority).toBeNull();
  expect((await createRole(w, "reader")).status).toBe(201);
  // The generation moved, the stop's marker did not: no token carries a writer over it, and the
  // host lease permits the database as every other.
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    generation: 3,
    write_blocked: false,
    runtime_authority: null,
  });
  expect(
    (await sampled(w)).find((token) => token.database_id === w.id),
  ).toBeUndefined();
}, 60_000);

it("binds a start's hold to the volume the identity proof of a later generation names", async () => {
  const f = await thinExecutionFixture(releases);
  const node = await thinLeaseNode(f);
  await node.commit();
  const id = node.held.id;
  // The Pod's volume is bound, then a role is created before any proof read it.
  const receipt = DatabaseStorageVolumeReceipt.parse({
    storage_generation: 1,
    storage_uid: crypto.randomUUID(),
    namespace_uid: crypto.randomUUID(),
    cluster_uid: crypto.randomUUID(),
    node_uid: f.uid,
    volume_group_uuid: f.authority.volume_group_uuid,
    pool_uuid: f.authority.pool_uuid,
    volume_handle: `pvc-${crypto.randomUUID()}`,
    lv_uuid: "VOLUMX-1234-1234-1234-1234-1234-ABCDEF",
    pvc_uid: crypto.randomUUID(),
    pv_uid: crypto.randomUUID(),
  });
  await env.DB.prepare("UPDATE databases SET storage_volume_json=? WHERE id=?")
    .bind(JSON.stringify(receipt), id)
    .run();
  const created = await request(
    `/v1/databases/${id}/roles`,
    f.integrator,
    "POST",
    { name: "reader" },
    crypto.randomUUID(),
  );
  expect(created.status).toBe(201);
  const generation = (await databaseRow(id)).generation;
  expect(generation).toBe(2);
  const authority = await identityProof(f, {
    physical_lvs: [
      lvs.pool,
      lvs.data,
      lvs.meta,
      {
        name: receipt.volume_handle,
        lv_uuid: receipt.lv_uuid,
        size_bytes: 5 * gib,
        segtype: "thin",
      },
    ],
    active_lv_uuids: [receipt.lv_uuid],
    volumes: [
      {
        database_id: id,
        generation,
        storage_generation: 1,
        storage_uid: receipt.storage_uid,
        namespace_uid: receipt.namespace_uid,
        cluster_uid: receipt.cluster_uid,
        volume_handle: receipt.volume_handle,
        lv_uuid: receipt.lv_uuid,
        pvc_uid: receipt.pvc_uid,
        pv_uid: receipt.pv_uid,
        storage_class: thinStorageClass(f.authority.profile_sha256),
        volume_attributes_class: thinStorageClass(f.authority.profile_sha256),
        io: [],
      },
    ],
  });
  await env.DB.batch(storageHoldVolumeStatements(env.DB, authority));
  // The hold of the start is the one the volume belongs to: it is counted once, as that volume,
  // not again as a start whose volume nobody knows.
  const hold = await env.DB.prepare(
    "SELECT generation,storage_volume_json IS NOT NULL bound FROM database_start_admissions WHERE database_id=?",
  )
    .bind(id)
    .first<{ generation: number; bound: number }>();
  expect(hold).toEqual({ generation: 1, bound: 1 });
  const holds = await storageHolds(env, f.node, f.uid, authority);
  expect(holds.newVolumes).toBe(0);
  expect(
    [...holds.exposures.keys()].some((key) => key.startsWith("unknown:")),
  ).toBe(false);
}, 60_000);

it("keeps the start's hold in the identity lease the executor reads across a role change", async () => {
  const f = await thinExecutionFixture(releases);
  const node = await thinLeaseNode(f);
  await node.commit();
  const id = node.held.id;
  // One reserved identity lease, read again as the executor would after each change.
  expect(await prepareThinStorageLease(f.local, f.node, false)).not.toBeNull();
  const startup = async () =>
    (await thinStorageInput(f.local, f.node)).lease.databases.find(
      (database) => database.id === id,
    )!;
  const before = await startup();
  expect(before.startup).toMatchObject({ generation: 1 });
  const created = await request(
    `/v1/databases/${id}/roles`,
    f.integrator,
    "POST",
    { name: "reader" },
    crypto.randomUUID(),
  );
  expect(created.status).toBe(201);
  // The executor tolerates an unstarted cgroup only under a hold of the generation it reads.
  const after = await startup();
  expect(after).toMatchObject({ generation: 2 });
  expect(after.startup).toMatchObject({
    operation_id: before.startup!.operation_id,
    generation: 2,
  });
}, 60_000);

it("does not carry a writer over a role change from a reading that found the volume frozen", async () => {
  const w = await awakeWriter(await thinExecutionFixture(releases));
  // The guard froze the volume: the node's reading of generation 1 has it quiesced.
  await w.evidence({ quiesced: true });
  expect((await createRole(w, "reader")).status).toBe(201);
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    generation: 3,
    write_blocked: false,
    runtime_authority: null,
  });
  expect(
    (await sampled(w)).find((token) => token.database_id === w.id),
  ).toBeUndefined();
}, 60_000);
