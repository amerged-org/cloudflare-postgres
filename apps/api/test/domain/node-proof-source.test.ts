// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../../src/env.ts";
import { NodeJoinBundle } from "@pgcf/contracts/node-bootstrap";
import { ContaboClient } from "../../src/providers/contabo.ts";
import {
  joinBundleReference,
  storeRegionJoinBundle,
} from "../../src/crypto/bootstrap-credentials.ts";
import {
  bindNodeInstallation,
  installationHash,
  storeNodeInstallationProfile,
} from "../../src/domain/node-installation.ts";
import {
  assertNodeProofSourceAuthority,
  selectNodeProofSource,
} from "../../src/domain/node-proof-source.ts";
import {
  boundInstallationFixture,
  installationFixture,
} from "./installation-fixtures.ts";
import { cleanupFixtures } from "./fixtures.ts";

const regions: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const region of regions.splice(0))
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM node_installation_bindings WHERE region_id=?",
      ).bind(region),
      env.DB.prepare(
        "DELETE FROM node_installation_profiles WHERE region_id=?",
      ).bind(region),
    ]);
  await cleanupFixtures();
});

async function fixture() {
  const target = await boundInstallationFixture();
  const source = await installationFixture();
  regions.push(target.fixture.region, source.fixture.region);
  source.actual.region = "US-central";
  source.actual.status = "running";
  source.actual.ipConfig.v4.ip = "8.8.4.4";
  source.actual.ipConfig.v6 = {
    ip: "2001:4860:4860::8844",
    gateway: "fe80::1",
    netmaskCidr: 64,
  };
  await env.DB.prepare("UPDATE regions SET provider_region=? WHERE id=?")
    .bind(source.actual.region, source.fixture.region)
    .run();
  await storeNodeInstallationProfile(
    source.bindings,
    source.fixture.region,
    source.profile,
  );
  const nodeUid = crypto.randomUUID();
  const observedAt = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,provider_instance_id,node_uid,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,?,1,8192,8000,32,128,?,?,?)",
  )
    .bind(
      source.fixture.node,
      source.fixture.region,
      source.fixture.nodeName,
      source.actual.id,
      nodeUid,
      observedAt,
      observedAt,
      observedAt,
    )
    .run();
  const bundle = NodeJoinBundle.parse({
    version: 1,
    cluster_name: source.profile.first_region!.cluster_name,
    cluster_endpoint: `https://${source.actual.ipConfig.v4.ip}:6443`,
    kube_system_uid: crypto.randomUUID(),
    talos_version: "1.14.1",
    kubernetes_version: "1.36.3",
    talos_machine_secrets_yaml: `cluster: ${crypto.randomUUID()}\n`,
    talos_admin_config: `context: ${crypto.randomUUID()}\n`,
    kubeconfig: `apiVersion: v1\nfixture: ${crypto.randomUUID()}\n`,
  });
  await storeRegionJoinBundle(
    source.bindings.DB,
    source.bindings.CREDENTIAL_KEYS,
    joinBundleReference(source.fixture.region, 1),
    bundle,
  );
  const plan = {
    version: 1,
    operation_id: target.addition.intent.operation_id,
    node_id: target.addition.intent.node_id,
    region_id: target.fixture.region,
    provider_instance_id: target.actual.id,
    intent_hash: target.addition.intent_hash,
    operators: { ipv4: ["1.1.1.1/32"], ipv6: [] as string[] },
    relay: {
      provider_instance_id: target.relay.id,
      addresses: { ipv4: [target.relay.ipConfig.v4.ip], ipv6: [] },
    },
    scan_control: { ipv4: "9.9.9.9", ipv6: "2606:4700:4700::1111", port: 443 },
    members: [
      {
        node_id: target.addition.intent.node_id,
        provider_instance_id: target.actual.id,
        addresses: { ipv4: [target.actual.ipConfig.v4.ip], ipv6: [] },
        rules: {
          rules: {
            inbound: [] as { srcCidr: { ipv4?: string[]; ipv6?: string[] } }[],
          },
        },
      },
    ],
  };
  const savePlan = async () => {
    await env.DB.prepare(
      "DELETE FROM node_network_preparations WHERE operation_id=?",
    )
      .bind(target.addition.intent.operation_id)
      .run();
    await env.DB.prepare(
      "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_json,plan_sha256,status,readback_at,created_at,updated_at) VALUES(?,?,?,?,'awaiting_proof',?,?,?)",
    )
      .bind(
        target.addition.intent.operation_id,
        target.addition.intent_hash,
        JSON.stringify(plan),
        await installationHash(plan),
        observedAt,
        observedAt,
        observedAt,
      )
      .run();
  };
  await savePlan();
  const provider = {
    getInstance: vi.fn(async (id: string) => {
      if (id === target.actual.id) return target.actual;
      if (id === source.actual.id) return source.actual;
      throw new Error("unexpected_provider_identity");
    }),
  };
  const options = {
    provider,
    sourceImage: source.profile.first_region!.regional_image,
  };
  const select = () =>
    selectNodeProofSource(
      target.bindings as Env,
      target.addition.intent.operation_id,
      plan,
      options,
    );
  return {
    target,
    source,
    bundle,
    nodeUid,
    observedAt,
    plan,
    savePlan,
    provider,
    options,
    select,
  };
}

it("selects only a fresh owned opposite-region node with exact UID and sealed join custody without changing source state", async () => {
  const f = await fixture();
  const before = await env.DB.prepare("SELECT * FROM nodes WHERE id=?")
    .bind(f.source.fixture.node)
    .first();
  const selected = await f.select();
  expect(selected).toMatchObject({
    kind: "pod",
    node_id: f.source.fixture.node,
    node_uid: f.nodeUid,
    cluster_uid: f.bundle.kube_system_uid,
    provider_instance_id: f.source.actual.id,
    ipv4: f.source.actual.ipConfig.v4.ip,
    ipv6: f.source.actual.ipConfig.v6!.ip,
    image: f.options.sourceImage,
    access: { join_bundle: f.bundle },
  });
  expect(
    await env.DB.prepare("SELECT * FROM nodes WHERE id=?")
      .bind(f.source.fixture.node)
      .first(),
  ).toEqual(before);
});

it("rejects an outside-looking source covered by any member's inbound CIDR", async () => {
  const f = await fixture();
  f.plan.members[0]!.rules.rules.inbound.push({
    srcCidr: { ipv4: ["8.8.0.0/16"] },
  });
  await f.savePlan();
  expect(await f.select()).toBeNull();
});

it("normalizes IPv6 notation before excluding the entire operator range", async () => {
  const f = await fixture();
  f.plan.operators.ipv6.push("2001:4860:4860:0000:0000:0000:0000:0000/64");
  await f.savePlan();
  expect(await f.select()).toBeNull();
});

it("refuses a changed plan before accessing any private source", async () => {
  const f = await fixture();
  f.plan.scan_control.ipv4 = "8.8.8.8";
  await expect(f.select()).rejects.toThrow(
    "Network proof source authority is unavailable or changed",
  );
  expect(f.provider.getInstance).not.toHaveBeenCalled();
});

it("never selects a terminal lost node even when its Ready observation is recent", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE nodes SET lost_at=?,lost_reason='operator declared lost' WHERE id=?",
  )
    .bind(new Date().toISOString(), f.source.fixture.node)
    .run();
  expect(await f.select()).toBeNull();
});

it("rechecks terminal D1 loss after asynchronous provider reads before returning source access", async () => {
  const f = await fixture();
  const original = f.provider.getInstance.getMockImplementation()!;
  f.provider.getInstance.mockImplementation(async (id) => {
    const actual = await original(id);
    if (id === f.source.actual.id)
      await env.DB.prepare(
        "UPDATE nodes SET lost_at=?,lost_reason='operator declared lost' WHERE id=?",
      )
        .bind(new Date().toISOString(), f.source.fixture.node)
        .run();
    return actual;
  });
  expect(await f.select()).toBeNull();
});

it("requires a current Ready observation and fresh provider allocation", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(Date.now() - 180001).toISOString(), f.source.fixture.node)
    .run();
  expect(await f.select()).toBeNull();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(f.observedAt, f.source.fixture.node)
    .run();
  f.source.actual.status = "pending_payment";
  expect(await f.select()).toBeNull();
});

it("does not expose a pod source without an administrator-configured immutable image", async () => {
  const f = await fixture();
  f.options.sourceImage = "registry.invalid/pgcf:latest";
  expect(await f.select()).toBeNull();
});

it("rejects another customer's current provider identity despite an otherwise eligible Node", async () => {
  const f = await fixture();
  f.source.actual.customerId = "different-customer";
  expect(await f.select()).toBeNull();
});

it("requires the exact audited provider identity before releasing any source custody", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE node_additions SET audit_json=? WHERE operation_id=?",
  )
    .bind(
      JSON.stringify({
        ...f.target.addition.audit,
        provider_instance_id: f.source.actual.id,
      }),
      f.target.addition.intent.operation_id,
    )
    .run();
  await expect(f.select()).rejects.toThrow(
    "Network proof source authority is unavailable or changed",
  );
  expect(f.provider.getInstance).not.toHaveBeenCalled();
});

it("uses only an active encrypted rescue binding and always refuses provider or D1 cancellation", async () => {
  const f = await fixture();
  await env.DB.prepare("DELETE FROM nodes WHERE id=?")
    .bind(f.source.fixture.node)
    .run();
  f.source.actual.status = "rescue";
  f.source.addition.audit!.provider_region = f.source.actual.region;
  await env.DB.prepare(
    "UPDATE node_additions SET audit_json=? WHERE operation_id=?",
  )
    .bind(
      JSON.stringify(f.source.addition.audit),
      f.source.addition.intent.operation_id,
    )
    .run();
  await bindNodeInstallation(
    f.source.bindings,
    f.source.addition.intent.operation_id,
    f.source.addition.revision,
    crypto.randomUUID(),
    f.source.provider,
  );
  const before = await env.DB.prepare(
    "SELECT * FROM node_installation_bindings WHERE operation_id=?",
  )
    .bind(f.source.addition.intent.operation_id)
    .first();
  const selected = await f.select();
  expect(selected).toMatchObject({
    kind: "rescue",
    operation_id: f.source.addition.intent.operation_id,
    provider_instance_id: f.source.actual.id,
    ipv4: f.source.actual.ipConfig.v4.ip,
    access: {
      rescue: { ssh_private_key: f.source.profile.rescue_client_private_key },
      inspection_generation: 0,
    },
  });
  f.source.actual.cancelDate = new Date(Date.now() + 86400000).toISOString();
  await env.DB.prepare(
    "UPDATE node_additions SET status='cancelled',slot_held=0 WHERE operation_id=?",
  )
    .bind(f.source.addition.intent.operation_id)
    .run();
  expect(await f.select()).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT * FROM node_installation_bindings WHERE operation_id=?",
    )
      .bind(f.source.addition.intent.operation_id)
      .first(),
  ).toEqual(before);
  f.source.actual.cancelDate = null;
  expect(await f.select()).toBeNull();
});

it("reuses a sealed pod association without provider reads and refuses changed or stale physical identity", async () => {
  const f = await fixture(),
    selected = await f.select();
  if (!selected || selected.kind !== "pod") throw new Error("source_missing");
  f.provider.getInstance.mockClear();
  const provider = vi
    .spyOn(ContaboClient.prototype, "getInstance")
    .mockRejectedValue(new Error("unexpected_provider_read"));
  const validate = () =>
    assertNodeProofSourceAuthority(
      f.target.bindings as Env,
      f.target.addition.intent.operation_id,
      f.plan,
      selected,
    );
  await validate();
  await validate();
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.source.fixture.node)
    .run();
  await expect(validate()).rejects.toThrow("source authority");
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,last_observed_at=? WHERE id=?",
  )
    .bind(
      f.nodeUid,
      new Date(Date.now() - 180001).toISOString(),
      f.source.fixture.node,
    )
    .run();
  await expect(validate()).rejects.toThrow("source authority");
  expect(provider).not.toHaveBeenCalled();
  expect(f.provider.getInstance).not.toHaveBeenCalled();
});

it("refuses changed cluster or credential custody and a closed target while preserving sealed source state", async () => {
  const f = await fixture(),
    selected = await f.select();
  if (!selected || selected.kind !== "pod") throw new Error("source_missing");
  const before = structuredClone(selected);
  const provider = vi
    .spyOn(ContaboClient.prototype, "getInstance")
    .mockRejectedValue(new Error("unexpected_provider_read"));
  const validate = () =>
    assertNodeProofSourceAuthority(
      f.target.bindings as Env,
      f.target.addition.intent.operation_id,
      f.plan,
      selected,
    );
  const replaceCustody = async (bundle: NodeJoinBundle) => {
    await env.DB.prepare(
      "DELETE FROM region_bootstrap_credentials WHERE region_id=? AND purpose='join_bundle' AND revision=1",
    )
      .bind(f.source.fixture.region)
      .run();
    await storeRegionJoinBundle(
      f.source.bindings.DB,
      f.source.bindings.CREDENTIAL_KEYS,
      joinBundleReference(f.source.fixture.region, 1),
      bundle,
    );
  };
  await replaceCustody({ ...f.bundle, kube_system_uid: crypto.randomUUID() });
  await expect(validate()).rejects.toThrow("source authority");
  await replaceCustody({
    ...f.bundle,
    kubeconfig: f.bundle.kubeconfig + "\nchanged",
  });
  await expect(validate()).rejects.toThrow("source authority");
  await replaceCustody(f.bundle);
  await validate();
  await env.DB.prepare(
    "UPDATE node_additions SET status='cancelled',slot_held=0 WHERE operation_id=?",
  )
    .bind(f.target.addition.intent.operation_id)
    .run();
  await expect(validate()).rejects.toThrow("source authority");
  expect(selected).toEqual(before);
  expect(provider).not.toHaveBeenCalled();
});

it("validates an exact bound rescue association locally and refuses changed binding authority", async () => {
  const f = await fixture();
  await env.DB.prepare("DELETE FROM nodes WHERE id=?")
    .bind(f.source.fixture.node)
    .run();
  f.source.actual.status = "rescue";
  await env.DB.prepare(
    "UPDATE node_additions SET audit_json=? WHERE operation_id=?",
  )
    .bind(
      JSON.stringify({
        ...f.source.addition.audit,
        provider_region: f.source.actual.region,
      }),
      f.source.addition.intent.operation_id,
    )
    .run();
  await bindNodeInstallation(
    f.source.bindings,
    f.source.addition.intent.operation_id,
    f.source.addition.revision,
    crypto.randomUUID(),
    f.source.provider,
  );
  const selected = await f.select();
  if (!selected || selected.kind !== "rescue")
    throw new Error("source_missing");
  const provider = vi
    .spyOn(ContaboClient.prototype, "getInstance")
    .mockRejectedValue(new Error("unexpected_provider_read"));
  const validate = () =>
    assertNodeProofSourceAuthority(
      f.target.bindings as Env,
      f.target.addition.intent.operation_id,
      f.plan,
      selected,
    );
  await validate();
  await env.DB.prepare(
    "UPDATE node_installation_bindings SET inspection_generation=inspection_generation+1 WHERE operation_id=?",
  )
    .bind(f.source.addition.intent.operation_id)
    .run();
  await expect(validate()).rejects.toThrow("source authority");
  expect(provider).not.toHaveBeenCalled();
});
