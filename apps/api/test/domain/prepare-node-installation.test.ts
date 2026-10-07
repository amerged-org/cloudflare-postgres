// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { prepareNodeInstallationInputs } from "../../src/domain/prepare-node-installation.ts";
import {
  loadNodeInstallationBinding,
  recordNodeInstallationInspection,
  storeNodeInstallationProfile,
} from "../../src/domain/node-installation.ts";
import { composeConfiguredNodeBootstrap } from "../../src/domain/bootstrap-composition.ts";
import { readBootstrapJob } from "../../src/domain/bootstrap-jobs.ts";
import {
  boundInstallationFixture,
  installationFixture,
} from "./installation-fixtures.ts";
import { cleanupFixtures } from "./fixtures.ts";

const regions: string[] = [];
afterEach(async () => {
  for (const region of regions.splice(0))
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM node_firewall_allocations WHERE region_id=?",
      ).bind(region),
      env.DB.prepare(
        "DELETE FROM node_installation_bindings WHERE region_id=?",
      ).bind(region),
      env.DB.prepare(
        "DELETE FROM node_installation_profiles WHERE region_id=?",
      ).bind(region),
    ]);
  await cleanupFixtures();
});

async function sealedInstallation() {
  const f = await boundInstallationFixture();
  regions.push(f.fixture.region);
  const id = f.addition.intent.operation_id;
  await recordNodeInstallationInspection(f.bindings, id, 0, f.inspection);
  await composeConfiguredNodeBootstrap(f.bindings, id, {
    provider: f.provider,
  });
  const before = await readBootstrapJob(env.DB, id);
  const binding = await loadNodeInstallationBinding(f.bindings, id);
  const forbidden = vi.fn(async (): Promise<never> => {
    throw new Error("routine_provider_read_forbidden");
  });
  const provider = {
    getInstance: forbidden,
    getFirewall: forbidden,
    listFirewalls: forbidden,
    createFirewall: forbidden,
  };
  const bindings = {
    ...f.bindings,
    BOOTSTRAP_FIREWALL_BINDINGS: JSON.stringify({
      [f.actual.id]: f.binding.row.firewall_id,
    }),
  };
  return { f, id, before, binding, provider, forbidden, bindings };
}

it("reuses the sealed installation binding and job without another provider or firewall read", async () => {
  const { id, before, binding, provider, forbidden, bindings } =
    await sealedInstallation();
  expect(
    await prepareNodeInstallationInputs(bindings, id, { provider }),
  ).toEqual({
    profile_configured: true,
    binding_ready: true,
    job_configured: true,
  });
  expect(
    await prepareNodeInstallationInputs(bindings, id, { provider }),
  ).toEqual({
    profile_configured: true,
    binding_ready: true,
    job_configured: true,
  });
  expect(forbidden).not.toHaveBeenCalled();
  expect(await readBootstrapJob(env.DB, id)).toEqual(before);
  expect(await loadNodeInstallationBinding(bindings, id)).toEqual(binding);
});

it("refuses a changed configured firewall without reading the provider or changing the sealed job", async () => {
  const s = await sealedInstallation();
  await expect(
    prepareNodeInstallationInputs(
      {
        ...s.bindings,
        BOOTSTRAP_FIREWALL_BINDINGS: JSON.stringify({
          [s.f.actual.id]: crypto.randomUUID(),
        }),
      },
      s.id,
      { provider: s.provider },
    ),
  ).rejects.toThrow("Retained installation authority changed");
  expect(s.forbidden).not.toHaveBeenCalled();
  expect(await readBootstrapJob(env.DB, s.id)).toEqual(s.before);
});

it("refuses closed addition authority before reusing a sealed binding", async () => {
  const s = await sealedInstallation();
  await env.DB.prepare(
    "UPDATE node_additions SET status='cancelled',slot_held=0 WHERE operation_id=?",
  )
    .bind(s.id)
    .run();
  await expect(
    prepareNodeInstallationInputs(s.bindings, s.id, { provider: s.provider }),
  ).rejects.toThrow("Retained installation authority changed");
  expect(s.forbidden).not.toHaveBeenCalled();
  expect(await readBootstrapJob(env.DB, s.id)).toEqual(s.before);
});

it("refuses an audit for a different provider identity before reusing a sealed binding", async () => {
  const s = await sealedInstallation();
  await env.DB.prepare(
    "UPDATE node_additions SET audit_json=json_set(audit_json,'$.provider_instance_id',?) WHERE operation_id=?",
  )
    .bind(s.f.relay.id, s.id)
    .run();
  await expect(
    prepareNodeInstallationInputs(s.bindings, s.id, { provider: s.provider }),
  ).rejects.toThrow("Retained installation authority changed");
  expect(s.forbidden).not.toHaveBeenCalled();
  expect(await readBootstrapJob(env.DB, s.id)).toEqual(s.before);
});

it("refuses changed regional provider mapping before reusing a sealed binding", async () => {
  const s = await sealedInstallation();
  await env.DB.prepare(
    "UPDATE regions SET provider_region='US-central' WHERE id=?",
  )
    .bind(s.f.fixture.region)
    .run();
  await expect(
    prepareNodeInstallationInputs(s.bindings, s.id, { provider: s.provider }),
  ).rejects.toThrow("Retained installation authority changed");
  expect(s.forbidden).not.toHaveBeenCalled();
  expect(await readBootstrapJob(env.DB, s.id)).toEqual(s.before);
});

async function firewallClaim(
  s: Awaited<ReturnType<typeof sealedInstallation>>,
  state: string,
) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO node_firewall_allocations(operation_id,node_id,region_id,provider_instance_id,provider_region,product_id,image_id,intent_hash,inventory_revision,tenant_id,customer_id,request_id,name,description,state,firewall_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      s.id,
      s.f.addition.intent.node_id,
      s.f.fixture.region,
      s.f.actual.id,
      s.f.addition.audit!.provider_region,
      s.f.addition.audit!.product_id,
      s.f.addition.audit!.image_id,
      s.f.addition.intent_hash,
      s.f.addition.revision,
      s.f.actual.tenantId,
      s.f.actual.customerId,
      crypto.randomUUID(),
      "owned-fixture-" + s.id,
      "owned-fixture",
      state,
      s.f.binding.row.firewall_id,
      now,
      now,
    )
    .run();
}

it("uses a confirmed Cloudflare firewall allocation without requiring a static provider map or another read", async () => {
  const s = await sealedInstallation();
  await firewallClaim(s, "confirmed");
  expect(
    await prepareNodeInstallationInputs(
      { ...s.bindings, BOOTSTRAP_FIREWALL_BINDINGS: "{}" },
      s.id,
      { provider: s.provider },
    ),
  ).toEqual({
    profile_configured: true,
    binding_ready: true,
    job_configured: true,
  });
  expect(s.forbidden).not.toHaveBeenCalled();
  expect(await readBootstrapJob(env.DB, s.id)).toEqual(s.before);
});

it("refuses a blocked Cloudflare firewall allocation without rechecking or changing provider resources", async () => {
  const s = await sealedInstallation();
  await firewallClaim(s, "blocked");
  await expect(
    prepareNodeInstallationInputs(s.bindings, s.id, { provider: s.provider }),
  ).rejects.toThrow("Retained installation authority changed");
  expect(s.forbidden).not.toHaveBeenCalled();
  expect(await readBootstrapJob(env.DB, s.id)).toEqual(s.before);
});

it("binds the owned firewall and retained host identity automatically without fabricating an inspection", async () => {
  const f = await installationFixture();
  regions.push(f.fixture.region);
  await storeNodeInstallationProfile(f.bindings, f.fixture.region, f.profile);
  const firewallId = crypto.randomUUID();
  const now = new Date().toISOString();
  const getFirewall = vi.fn(async () => ({
    tenantId: f.actual.tenantId,
    customerId: f.actual.customerId,
    firewallId,
    name: "fixture",
    description: "fixture",
    status: "active" as const,
    instanceStatus: [],
    instances: [],
    rules: { inbound: [] },
    createdDate: now,
    updatedDate: now,
  }));
  const provider = {
    ...f.provider,
    getFirewall,
    listFirewalls: vi.fn(async () => []),
    createFirewall: vi.fn(async (): Promise<never> => {
      throw new Error("unexpected_creation");
    }),
  };
  const bindings = {
    ...f.bindings,
    BOOTSTRAP_FIREWALL_BINDINGS: JSON.stringify({ [f.actual.id]: firewallId }),
  };
  const prepare = () =>
    prepareNodeInstallationInputs(bindings, f.addition.intent.operation_id, {
      provider,
    });
  expect(await prepare()).toEqual({
    profile_configured: true,
    binding_ready: true,
    job_configured: false,
  });
  const first = await loadNodeInstallationBinding(
    bindings,
    f.addition.intent.operation_id,
  );
  expect(first?.row.inspection_json).toBeNull();
  expect(first?.row.firewall_id).toBe(firewallId);
  expect(await prepare()).toEqual({
    profile_configured: true,
    binding_ready: true,
    job_configured: false,
  });
  expect(
    (
      await loadNodeInstallationBinding(
        bindings,
        f.addition.intent.operation_id,
      )
    )?.rescue,
  ).toEqual(first?.rescue);
  expect(provider.createFirewall).not.toHaveBeenCalled();
  expect(provider.listFirewalls).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT operation_id FROM node_bootstrap_jobs WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first(),
  ).toBeNull();
});

it("leaves an unconfigured legacy operation untouched without any provider mutation", async () => {
  const f = await installationFixture();
  const provider = {
    ...f.provider,
    getFirewall: vi.fn(async (): Promise<never> => {
      throw new Error("unexpected_firewall");
    }),
    listFirewalls: vi.fn(async () => []),
    createFirewall: vi.fn(async (): Promise<never> => {
      throw new Error("unexpected_creation");
    }),
  };
  expect(
    await prepareNodeInstallationInputs(
      f.bindings,
      f.addition.intent.operation_id,
      { provider },
    ),
  ).toEqual({
    profile_configured: false,
    binding_ready: false,
    job_configured: false,
  });
  expect(provider.getInstance).not.toHaveBeenCalled();
  expect(provider.getFirewall).not.toHaveBeenCalled();
  expect(provider.createFirewall).not.toHaveBeenCalled();
});
