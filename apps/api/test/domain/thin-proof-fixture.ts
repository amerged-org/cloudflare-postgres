// SPDX-License-Identifier: Apache-2.0
// Identity proofs and slow reports against the real D1 thin execution fixture.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { NodeThinStorageAuthority } from "@pgcf/contracts";
import sources from "../../../../infra/storage/sources.lock.json" with { type: "json" };
import type { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  recordThinStorageReport,
  thinStorageInput,
} from "../../src/domain/node-thin-storage-execution.ts";

export const gib = 1024 ** 3,
  mib = 1024 ** 2,
  iso = (ms: number) => new Date(ms).toISOString();
export type Fixture = Awaited<ReturnType<typeof thinExecutionFixture>>;
export const lvs = {
  pool: {
    name: "pgcf_thinpool",
    lv_uuid: "POOLLV-1234-1234-1234-1234-1234-ABCDEF",
    size_bytes: 2 * gib,
    segtype: "thin-pool",
  },
  data: {
    name: "[pgcf_thinpool_tdata]",
    lv_uuid: "TDATAX-1234-1234-1234-1234-1234-ABCDEF",
    size_bytes: 2 * gib,
    segtype: "linear",
  },
  meta: {
    name: "[pgcf_thinpool_tmeta]",
    lv_uuid: "TMETAX-1234-1234-1234-1234-1234-ABCDEF",
    size_bytes: 128 * mib,
    segtype: "linear",
  },
};
/** An accepted identity proof, read now, as the slow loop records it. */
export async function identityProof(f: Fixture, overrides: object = {}) {
  const now = Date.now();
  const authority = NodeThinStorageAuthority.parse({
    ...f.authority,
    revision: 2,
    observed_at: iso(now),
    captured_at: iso(now),
    expires_at: iso(now + f.profile.guard_seconds * 1000),
    inventory_observed_at: iso(now),
    inventory_expires_at: iso(now + 300_000),
    inventory_revision: 2,
    physical_lvs: [lvs.pool, lvs.data, lvs.meta],
    ...overrides,
  });
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_revision=?,authority_json=?,authority_received_at=? WHERE node_id=?",
  )
    .bind(authority.revision, JSON.stringify(authority), iso(now), f.node)
    .run();
  return authority;
}
export async function row(f: Fixture) {
  return (await env.DB.prepare(
    "SELECT authority_revision,authority_json,status,error_code FROM node_thin_storage WHERE node_id=?",
  )
    .bind(f.node)
    .first<{
      authority_revision: number;
      authority_json: string;
      status: string;
      error_code: string | null;
    }>())!;
}
/** Whether this node's NodeBootstrap Durable Object was asked for an identity turn. */
export async function turnRequested(f: Fixture) {
  return await runInDurableObject(
    env.NODE_BOOTSTRAP.get(
      env.NODE_BOOTSTRAP.idFromName(`thin-storage:${f.node}`),
    ),
    async (_instance, state) =>
      (await state.storage.get<string>("thinStorageNodeId")) === f.node,
  );
}

/** Forget every turn the node's executor was asked for, as a fresh Durable Object would. */
export async function forgetTurns(f: Fixture) {
  await runInDurableObject(
    env.NODE_BOOTSTRAP.get(
      env.NODE_BOOTSTRAP.idFromName(`thin-storage:${f.node}`),
    ),
    async (_instance, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    },
  );
}

/** The executor's slow report for the current lease, as runThinStorage builds it. */
export async function report(
  f: Fixture,
  authority: object = {},
  overrides: {
    software?: object;
    system_uuid?: string;
    expected_revision?: number;
  } = {},
) {
  const input = await thinStorageInput(f.local, f.node),
    lease = input.lease;
  return recordThinStorageReport(f.local, f.node, {
    expected_revision: overrides.expected_revision ?? lease.revision,
    authority: NodeThinStorageAuthority.parse({
      ...f.authority,
      revision: lease.authority_revision + 1,
      observed_at: lease.issued_at,
      captured_at: iso(Date.now()),
      expires_at: lease.expires_at,
      physical_lvs: [lvs.pool, lvs.data, lvs.meta],
      ...authority,
    }),
    boot_id: f.qualified.bootId,
    system_uuid: overrides.system_uuid ?? f.qualified.qualification.system_uuid,
    pool_tag: null,
    action_applied: false,
    software: {
      kernel_version:
        f.qualified.spec.thin_storage_qualification!.kernel_version,
      host_extension_image:
        f.qualified.spec.thin_storage_qualification!.host_extension_image,
      host_configuration_sha256: f.host.sha256,
      driver_image_id: f.profile.driver_image,
      driver_sha256: sources.driver.binary_sha256,
      lvm_sha256: sources.driver.lvm_binary_sha256,
      tools_sha256: sources.thin_tools.binary_sha256,
      thin_tools_version: sources.thin_tools.version,
      thin_module_live: true,
      cgroup_host_view: true,
      ...overrides.software,
    },
  });
}
