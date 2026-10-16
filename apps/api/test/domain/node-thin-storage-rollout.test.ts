// SPDX-License-Identifier: Apache-2.0
// Thin write authority across a fleet rollout. A rollout moves the release, the assignment and the
// pool policy of the node in one batch, and its patch reaches the node about forty minutes later.
// Authority continues while the facts the thin qualification depends on are the ones the node was
// proven with; every admission and every change of a pinned fact stays behind the assigned release.
// Real D1 and AEAD custody fixtures with controlled metadata; no live evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { DesiredResponse } from "@pgcf/contracts";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import {
  HostStorageLease,
  NodeStorageHeadroomResponse,
} from "@pgcf/contracts/node-thin-storage";
import { cleanupFixtures, request } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  type AwakeWriter,
  awakeWriter,
  claimsOf,
  leaseEntry,
  renewal,
} from "./parked-tier-fixture.ts";
import {
  addMember,
  assignRelease,
  completePatch,
  extension,
  insertRelease,
  installer,
  kubernetes,
  observeAssignment,
  postgres,
  reordered,
  runtime,
  software,
  startPatch,
} from "./thin-rollout-fixture.ts";
import {
  gib,
  identityProof,
  nonce,
  post,
  report,
  row,
  sample,
} from "./thin-renewal-fixture.ts";
import { ensureNodeHostConfiguration } from "../../src/domain/node-host-configuration.ts";
import { prepareThinStorageLease } from "../../src/domain/node-thin-storage-execution.ts";
import {
  readCurrentNodeThinStorage,
  thinContinuitySql,
} from "../../src/domain/node-thin-storage.ts";
import { nodeThinStorageHeadroomSql } from "../../src/domain/storage-capacity.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

const awake = async () => awakeWriter(await thinExecutionFixture(releases));
const desired = async (w: AwakeWriter) =>
  DesiredResponse.parse(
    await (await request("/agent/v1/desired", w.f.agent)).json(),
  );
const lease = async (w: AwakeWriter) =>
  HostStorageLease.parse(
    await (
      await request(`/agent/v1/nodes/${w.f.node}/storage-guard`, w.f.agent)
    ).json(),
  );
const qualification = (w: AwakeWriter) =>
  env.DB.prepare(
    "SELECT qualification_json FROM node_thin_storage WHERE node_id=?",
  )
    .bind(w.f.node)
    .first<string>("qualification_json");
/** Everything the guard and the controller are given for the node, as a pause shows it. */
async function paused(w: AwakeWriter, leased = true) {
  expect(await renewal(w)).toMatchObject({
    accepted: false,
    reason: "thin_storage_sample_node_unqualified",
    authority: null,
    tokens: [],
  });
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    write_blocked: true,
    runtime_authority: null,
  });
  const page = await desired(w);
  expect(page.region).not.toHaveProperty("storage_samples");
  expect(
    page.region.storage_nodes?.find((entry) => entry.node_id === w.f.node),
  ).toMatchObject({ write_allowed: false });
  expect(
    page.databases.find((database) => database.id === w.id)?.storage_authority,
  ).toBeUndefined();
  if (leased)
    await expect(
      prepareThinStorageLease(w.f.local, w.f.node),
    ).rejects.toThrow();
}

// A release that pins the same thin facts: the controller, the gateway and the API change.

it("keeps accepting samples and renewing tokens while a rollout that pins the same thin facts is pending", async () => {
  const w = await awake(),
    f = w.f;
  let previous = (await renewal(w)).authority!.revision;
  await assignRelease(f, releases, {
    patch: { stage: "regional", state: "pending" },
  });
  for (let sampled = 0; sampled < 2; sampled++) {
    const response = await renewal(w);
    expect(response.accepted).toBe(true);
    expect(response.authority!.revision).toBe(previous + 1);
    expect(response.authority).toMatchObject({ write_allowed: true });
    expect(
      Date.parse(response.authority!.expires_at) -
        Date.parse(response.authority!.observed_at),
    ).toBeLessThanOrEqual(f.profile.guard_seconds * 1000);
    expect(response.tokens.map((token) => token.database_id)).toEqual([w.id]);
    previous = response.authority!.revision;
  }
  expect((await row(f)).status).toBe("ready");
});

it("keeps the storage_nodes entry, the storage_samples target and the database token in the desired page across the assignment", async () => {
  const w = await awake();
  await renewal(w);
  const before = await desired(w);
  await assignRelease(w.f, releases);
  const after = await desired(w);
  expect(after.region.storage_nodes).toHaveLength(1);
  expect(Object.keys(after.region.storage_nodes![0]!).sort()).toEqual(
    Object.keys(before.region.storage_nodes![0]!).sort(),
  );
  expect(after.region.storage_nodes![0]).toMatchObject({
    node_id: w.f.node,
    write_allowed: true,
    inventory_revision: expect.any(Number),
  });
  expect(after.region.storage_samples).toHaveLength(1);
  expect(
    claimsOf(
      after.databases.find((database) => database.id === w.id)
        ?.storage_authority,
    ),
  ).toMatchObject({ database_id: w.id, write_allowed: true });
});

it("serves the running entry with its token and the proven boot in the host lease during such a rollout", async () => {
  const w = await awake();
  await renewal(w);
  await assignRelease(w.f, releases);
  expect((await lease(w)).boot_id).toBe(w.f.qualified.bootId);
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    write_blocked: false,
    runtime_authority: expect.stringMatching(/^sa1\./),
  });
});

it("leases and accepts an identity turn under the new assignment, before and after its patch rewrote the host custody", async () => {
  const f = await thinExecutionFixture(releases);
  await identityProof(f);
  const assigned = await assignRelease(f, releases);
  // The node's custody is still sealed under the release it was proven with.
  const input = (await prepareThinStorageLease(f.local, f.node))!;
  expect(input.lease).toMatchObject({
    release_id: assigned.id,
    assignment_revision: assigned.assignment,
    region_revision: assigned.region,
    boot_id: f.qualified.bootId,
  });
  expect(input.host_configuration.status).toMatchObject({
    sha256: f.host.sha256,
    release_id: f.qualified.releaseId,
  });
  expect(await report(f)).toMatchObject({ accepted: true });
  expect(JSON.parse((await row(f)).authority_json)).toMatchObject({
    inventory_observed_at: input.lease.issued_at,
  });
  // Patch creation seals the same content under the new release.
  await startPatch(f, assigned, { stage: "regional", state: "pending" });
  const next = (await prepareThinStorageLease(f.local, f.node))!;
  expect(next.host_configuration.status).toMatchObject({
    sha256: f.host.sha256,
    release_id: assigned.id,
  });
  expect(await report(f)).toMatchObject({ accepted: true });
});

it("keeps authority across two rollouts in a row without a proof between them", async () => {
  const w = await awake(),
    proof = await qualification(w);
  let revision = (await renewal(w)).authority!.revision;
  for (let rollout = 0; rollout < 2; rollout++) {
    await assignRelease(w.f, releases, {
      patch: { stage: "complete", state: "confirmed" },
    });
    const response = await renewal(w);
    expect(response.accepted).toBe(true);
    expect(response.authority!.revision).toBeGreaterThan(revision);
    revision = response.authority!.revision;
  }
  expect(await qualification(w)).toBe(proof);
});

it("keeps authority while the rollout's patch is halted at regional", async () => {
  const w = await awake();
  await assignRelease(w.f, releases, {
    patch: {
      stage: "regional",
      state: "halted",
      error: "fleet_patch_regional_failed",
    },
  });
  expect(await renewal(w)).toMatchObject({ accepted: true });
  expect(await leaseEntry(w.f, w.id)).toMatchObject({ write_blocked: false });
});

it("resumes at once on a rollback to the release the node was proven with, after a release that changed a pinned fact", async () => {
  const w = await awake();
  await assignRelease(w.f, releases, { change: extension });
  expect(await renewal(w)).toMatchObject({ accepted: false });
  await assignRelease(w.f, releases, { release: w.f.qualified.releaseId });
  expect(await renewal(w)).toMatchObject({ accepted: true });
  expect(await leaseEntry(w.f, w.id)).toMatchObject({ write_blocked: false });
});

// A release that changes what the node runs or how the guard is configured stays strict from
// the assignment.

it("pauses at the assignment of a release whose receipt names another host extension digest", async () => {
  const w = await awake();
  await renewal(w);
  await assignRelease(w.f, releases, { change: extension });
  await paused(w);
});

it("pauses at the assignment of a release that changes only the Talos installer", async () => {
  const w = await awake();
  await renewal(w);
  await assignRelease(w.f, releases, { change: installer });
  await paused(w);
});

it("stops renewing when the host custody is rewritten with other content during a continuing rollout", async () => {
  const w = await awake(),
    f = w.f;
  await assignRelease(f, releases, {
    patch: { stage: "regional", state: "pending" },
  });
  expect(await renewal(w)).toMatchObject({ accepted: true });
  await env.DB.prepare(
    "UPDATE node_compute_pool_policies SET policy_json=json_set(policy_json,'$.profile.image',?) WHERE node_id=?",
  )
    .bind(`registry.invalid/sandbox@sha256:${"e".repeat(64)}`, f.node)
    .run();
  const rewritten = await ensureNodeHostConfiguration(f.local, {
    node_id: f.node,
    node_uid: f.uid,
  });
  expect(rewritten.sha256).not.toBe(f.host.sha256);
  await paused(w);
});

it("stops renewing once the observed boot id changes", async () => {
  const w = await awake();
  await assignRelease(w.f, releases);
  expect(await renewal(w)).toMatchObject({ accepted: true });
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=json_set(facts_json,'$.boot_id',?) WHERE node_id=?",
  )
    .bind(crypto.randomUUID(), w.f.node)
    .run();
  // The lease evidence is the patch's: the executor itself refuses a turn on another boot.
  await paused(w, false);
});

it("pauses when the patch of a release that changes the host custody halted at host_config", async () => {
  const w = await awake();
  await assignRelease(w.f, releases, {
    change: runtime,
    runtime: true,
    patch: {
      stage: "host_config",
      state: "halted",
      error: "fleet_patch_host_config_failed",
    },
  });
  await paused(w);
});

it("does not extend authority to a replacement node that reuses the node name", async () => {
  const w = await awake();
  await renewal(w);
  await assignRelease(w.f, releases);
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), w.f.node)
    .run();
  const page = await desired(w);
  expect(page.region).not.toHaveProperty("storage_samples");
  expect(page.region).not.toHaveProperty("storage_nodes");
  expect(
    page.databases.find((database) => database.id === w.id)?.storage_authority,
  ).toBeUndefined();
  expect(
    (await readCurrentNodeThinStorage(
      w.f.local,
      w.f.node,
      Date.now(),
      "continuing",
    ))!.authority,
  ).toBeNull();
});

it("keeps new placement and wake behind the assignment until its patch completed and one proof read it", async () => {
  const f = await thinExecutionFixture(releases),
    fits = () =>
      env.DB.prepare(
        `SELECT ${nodeThinStorageHeadroomSql()} fits FROM nodes n JOIN size_classes s ON s.id=? WHERE n.id=?`,
      )
        .bind(f.size, f.node)
        .first<number>("fits");
  // A pool that admits the start of one more database.
  const physical = {
    ...f.authority.physical,
    free_bytes: 80 * gib,
    thin_pool: {
      ...f.authority.physical.thin_pool!,
      data_total_bytes: 16 * gib,
    },
  };
  await identityProof(f, { physical });
  expect(await fits()).toBe(1);
  const assigned = await assignRelease(f, releases);
  // Authority continues; what starts a Pod does not.
  expect(
    NodeStorageHeadroomResponse.parse(
      (await post(f, sample(f, await nonce(f), { physical }))).body,
    ),
  ).toMatchObject({ accepted: true });
  expect(await fits()).toBe(0);
  await startPatch(f, assigned, { stage: "complete", state: "confirmed" });
  await observeAssignment(f);
  expect(await fits()).toBe(0);
  expect(await prepareThinStorageLease(f.local, f.node)).not.toBeNull();
  expect(await report(f, { physical })).toMatchObject({ accepted: true });
  expect(await fits()).toBe(1);
});

// The wire gate: the strict desired schema is served to a controller that parses it.

it("exposes the sampling wire only when the latest completed patch of every member declares the protocol", async () => {
  const w = await awake(),
    f = w.f,
    current = { id: f.qualified.releaseId, sha: f.qualified.specSha },
    member = await addMember(f, current),
    served = async () => {
      const page = await desired(w);
      return page.region.storage_samples?.length === 1;
    };
  expect(await served()).toBe(true);
  // The target declares the protocol and its patch is pending; the members are patched at v1.
  const next = await assignRelease(f, releases, {
    patch: { stage: "regional", state: "pending" },
  });
  expect(await served()).toBe(true);
  // A member whose latest completed patch is of a release without the protocol is not capable,
  // although it once completed a patch at one that declares it and the target declares it.
  const legacy = await insertRelease(releases, {
    ...f.qualified.spec,
    thin_storage_sampling_version: undefined,
  } as FleetReleaseSpec);
  await completePatch(f, member.id, member.uid, legacy, 1, 1);
  expect(await served()).toBe(false);
  expect((await post(f, sample(f, null))).status).toBe(404);
  // The member's next completed patch is at a release that declares it again.
  await completePatch(f, member.id, member.uid, next, 1, next.region);
  expect(await served()).toBe(true);
});

// What the continuity facts compare.

it("compares the receipt, the OS block, the keys and the pins, and nothing a controller, gateway or API release changes", async () => {
  const f = await thinExecutionFixture(releases),
    text = async (spec: FleetReleaseSpec) =>
      env.DB.prepare(
        `SELECT ${thinContinuitySql("s.spec_json", "'customer'")} text FROM fleet_releases s WHERE s.id=?`,
      )
        .bind((await insertRelease(releases, spec)).id)
        .first<string>("text"),
    base = await text(f.qualified.spec);
  expect(base).toEqual(expect.any(String));
  expect(await text(software(f.qualified.spec))).toBe(base);
  expect(await text(reordered(f.qualified.spec))).toBe(base);
  for (const change of [
    extension,
    installer,
    kubernetes,
    postgres,
    runtime,
    (spec: FleetReleaseSpec) => ({
      ...spec,
      storage_authority_keys_sha256: "1".repeat(64),
    }),
  ])
    expect(await text(change(f.qualified.spec) as FleetReleaseSpec)).not.toBe(
      base,
    );
});
