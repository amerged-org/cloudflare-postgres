// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "./fixtures.ts";
import {
  storeRegionJoinBundle,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
import {
  reserveThinStorageLease,
  thinStorageCallbackBearer,
  dispatchThinPoolAction,
} from "../../src/domain/node-thin-storage-execution.ts";
import { createApp } from "../../src/app.ts";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import type { Env } from "../../src/env.ts";
import { installThinQualifiedFixture } from "./thin-qualified-fixture.ts";
import { ThinStorageProfile } from "@pgcf/contracts";
const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
it("the actual D1 lease keeps an uncertain dispatched pool action and invalidates its previous callback", async () => {
  const f = await fixture(),
    at = new Date().toISOString(),
    nodeUid = crypto.randomUUID(),
    clusterUid = crypto.randomUUID(),
    release = `thin-${crypto.randomUUID()}`;
  releases.push(release);
  const image = `ghcr.io/amerged-org/pgcf-regional:lvm-thin-sha-${"a".repeat(40)}@sha256:${"b".repeat(64)}`,
    vg = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef";
  const profile = {
    version: 1,
    driver_image: image,
    initial_data_bytes: 2 * 1024 ** 3,
    growth_bytes: 1024 ** 3,
    maximum_data_bytes: 8 * 1024 ** 3,
    metadata_bytes: 128 * 1024 ** 2,
    vg_reserve_bytes: 512 * 1024 ** 2,
    data_reserve_bytes: 256 * 1024 ** 2,
    metadata_reserve_bytes: 32 * 1024 ** 2,
    startup_reserve_bytes: 128 * 1024 ** 2,
    write_bytes_per_second: 1024 ** 2,
    write_iops_per_second: 100,
    guard_seconds: 120,
    drain_seconds: 10,
    maximum_volumes: 128,
    maximum_quota_gib: 7,
  };
  const spec = {
    components: [{ name: "openebs-lvm", kind: "image", reference: image }],
  };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE nodes SET node_uid=?,provider_instance_id='retained-test-instance' WHERE id=?",
    ).bind(nodeUid, f.node),
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
    ).bind(f.region),
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(release, JSON.stringify(spec), "c".repeat(64), at),
    env.DB.prepare(
      "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES(?,?,1,?)",
    ).bind(f.region, release, at),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'customer',1,?)",
    ).bind(f.node, nodeUid, release, at),
    env.DB.prepare(
      `INSERT INTO node_thin_storage(node_id,node_uid,cluster_uid,address,volume_group_uuid,profile_revision,profile_sha256,profile_json,material_revision,qualified_driver_image,status,created_at,updated_at) VALUES(?,?,?,'192.0.2.18',?,1,?,?,1,?,'selected',?,?)`,
    ).bind(
      f.node,
      nodeUid,
      clusterUid,
      vg,
      "d".repeat(64),
      JSON.stringify(profile),
      image,
      at,
      at,
    ),
  ]);
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    {
      version: 1,
      cluster_name: "fixture",
      cluster_endpoint: "https://192.0.2.18:6443/",
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml: "test-only",
      talos_admin_config: "test-only-talos-config",
      kube_system_uid: clusterUid,
      kubeconfig: "test-only-kubeconfig",
    },
  );
  const selected = {
    ...env,
    NODE_BOOTSTRAP_CALLBACK_URL: "https://api.invalid",
  } as Env;
  const qualified = await installThinQualifiedFixture(
    env.DB,
    f.node,
    ThinStorageProfile.parse(profile),
    clusterUid,
  );
  releases.push(qualified.releaseId);
  const call = async (key: string) => {
    const context = createExecutionContext();
    const response = await createApp().fetch(
      new Request(
        `https://api.invalid/internal/v1/node-thin-storage/${f.node}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ kind: "status" }),
        },
      ),
      selected,
      context,
    );
    await waitOnExecutionContext(context);
    return response;
  };
  const input = await reserveThinStorageLease(selected, f.node);
  expect(JSON.parse(input!.action_json!).state).toBe("pending");
  expect(await reserveThinStorageLease(selected, f.node)).toBeNull();
  const action = JSON.parse(input!.action_json!) as { nonce: string };
  await dispatchThinPoolAction(
    env as Env,
    f.node,
    action.nonce,
    crypto.randomUUID(),
    crypto.randomUUID(),
  );
  await expect(
    dispatchThinPoolAction(
      env as Env,
      f.node,
      action.nonce,
      crypto.randomUUID(),
      crypto.randomUUID(),
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  await env.DB.prepare(
    "UPDATE node_thin_storage SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  const resumed = await reserveThinStorageLease(selected, f.node);
  expect(JSON.parse(resumed!.action_json!).state).toBe("dispatched");
  expect(JSON.parse(resumed!.action_json!).nonce).toBe(action.nonce);
  expect(resumed?.lease_id).not.toBe(input?.lease_id);
  expect(
    (await call(await thinStorageCallbackBearer(selected, input!))).status,
  ).toBe(401);
  expect(
    (await call(await thinStorageCallbackBearer(selected, resumed!))).status,
  ).toBe(200);
});
