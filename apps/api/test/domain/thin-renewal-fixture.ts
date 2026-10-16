// SPDX-License-Identifier: Apache-2.0
// Identity proofs, headroom samples and slow reports against the real D1 thin execution fixture.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import { NodeThinStorageAuthority } from "@pgcf/contracts";
import { NodeStorageHeadroomResponse } from "@pgcf/contracts/node-thin-storage";
import sources from "../../../../infra/storage/sources.lock.json" with { type: "json" };
import { request } from "./fixtures.ts";
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
export function sample(
  f: Fixture,
  nonce: string | null,
  overrides: object = {},
) {
  return {
    nonce,
    node_uid: f.uid,
    captured_at: iso(Date.now()),
    physical: {
      ...f.authority.physical,
      thin_pool: {
        ...f.authority.physical.thin_pool!,
        data_used_bytes_upper_bound: 64 * mib,
        metadata_used_bytes_upper_bound: mib,
      },
    },
    lvs: [{ name: "pgcf_thinpool", segtype: "thin-pool", size_bytes: 2 * gib }],
    lv_count: 1,
    witnesses: {
      cluster_uid: f.authority.cluster_uid,
      boot_id: f.qualified.bootId,
      volume_group_uuid: f.authority.volume_group_uuid,
      driver_pod_uid: f.authority.driver_pod_uid,
      driver_image: f.authority.driver_image,
    },
    scrape_milliseconds: 140,
    ...overrides,
  };
}
export async function post(f: Fixture, body: unknown, key = f.agent) {
  const response = await request(
    `/agent/v1/nodes/${f.node}/storage-headroom`,
    key,
    "POST",
    body,
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}
export async function row(f: Fixture) {
  return (await env.DB.prepare(
    "SELECT authority_revision,authority_json,status,error_code,sample_nonce,sample_nonce_issued_at,sample_observed_at,sample_data_used_bytes FROM node_thin_storage WHERE node_id=?",
  )
    .bind(f.node)
    .first<{
      authority_revision: number;
      authority_json: string;
      status: string;
      error_code: string | null;
      sample_nonce: string | null;
      sample_nonce_issued_at: string | null;
      sample_observed_at: string | null;
      sample_data_used_bytes: number | null;
    }>())!;
}
/** A first nonce: the request renews nothing. */
export async function nonce(f: Fixture) {
  const first = await post(f, sample(f, null));
  expect(first.status).toBe(200);
  return NodeStorageHeadroomResponse.parse(first.body).nonce;
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
