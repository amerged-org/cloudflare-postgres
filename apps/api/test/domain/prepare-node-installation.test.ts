// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { prepareNodeInstallationInputs } from "../../src/domain/prepare-node-installation.ts";
import {
  loadNodeInstallationBinding,
  storeNodeInstallationProfile,
} from "../../src/domain/node-installation.ts";
import { installationFixture } from "./installation-fixtures.ts";
import { cleanupFixtures } from "./fixtures.ts";

const regions: string[] = [];
afterEach(async () => {
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
