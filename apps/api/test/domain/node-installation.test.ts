// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFixtures, request } from "./fixtures.ts";
import {
  installationFixture,
  boundInstallationFixture,
} from "./installation-fixtures.ts";
import { createApp } from "../../src/app.ts";
import {
  storeNodeInstallationProfile,
  readNodeInstallationProfile,
  bindNodeInstallation,
  loadNodeInstallationBinding,
  recordNodeInstallationInspection,
  installationFirewallBinding,
  installationHash,
} from "../../src/domain/node-installation.ts";
import { validateRescueConfiguration } from "../../src/domain/rescue-configuration.ts";
import {
  reserveNodeAddition,
  recordNodeReceipt,
  recordNodeAudit,
} from "../../src/domain/node-state.ts";

const regions: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const region of regions.splice(0)) {
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM node_installation_bindings WHERE region_id=?",
      ).bind(region),
      env.DB.prepare(
        "DELETE FROM node_installation_profiles WHERE region_id=?",
      ).bind(region),
    ]);
  }
  await cleanupFixtures();
});

async function installation() {
  const f = await installationFixture();
  regions.push(f.fixture.region);
  return f;
}

it("imports the pre-established provider host identity before automatic inspection without changing an active rescue", async () => {
  const f = await installation();
  const bindings = {
    ...f.bindings,
    CONTABO_RESCUE_CONFIGURATION: JSON.stringify({ [f.actual.id]: f.entry }),
  };
  await storeNodeInstallationProfile(bindings, f.fixture.region, f.profile);
  await bindNodeInstallation(
    bindings,
    f.addition.intent.operation_id,
    f.addition.revision,
    crypto.randomUUID(),
    f.provider,
  );
  const saved = await loadNodeInstallationBinding(
    bindings,
    f.addition.intent.operation_id,
  );
  expect(saved?.rescue.ssh_host_fingerprint).toBe(f.entry.ssh_host_fingerprint);
  expect(saved?.rescue.ssh_host_key).toBe(f.entry.ssh_host_key);
  expect(await installationHash(saved?.rescue)).toBe(
    await installationHash({
      ...f.entry,
      ssh_private_key: f.profile.rescue_client_private_key,
    }),
  );
  expect(saved?.row.inspection_json).toBeNull();
});

describe("protected installation profiles", () => {
  it("seals one administrator-supplied profile and returns only its identity", async () => {
    const f = await installation(),
      path = `/v1/regions/${f.fixture.region}/installation-profile`,
      response = await request(path, f.fixture.admin, "PUT", f.profile);
    expect(response.status).toBe(201);
    const status = await response.json();
    expect(status).toEqual({
      region_id: f.fixture.region,
      configured: true,
      profile_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const row = await env.DB.prepare(
      "SELECT * FROM node_installation_profiles WHERE region_id=?",
    )
      .bind(f.fixture.region)
      .first();
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(f.body.rescue.ssh_private_key);
    expect(JSON.stringify(row)).not.toContain(f.body.platform!.tunnel_token);
    const read = await request(path, f.fixture.admin);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(status);
    const repeat = await request(path, f.fixture.admin, "PUT", f.profile);
    expect(repeat.status).toBe(201);
    expect(await repeat.json()).toEqual(status);
    expect(
      await env.DB.prepare(
        "SELECT * FROM node_installation_profiles WHERE region_id=?",
      )
        .bind(f.fixture.region)
        .first(),
    ).toEqual(row);
  });
  it("denies integrators and conflicting replacements while preserving the encrypted profile", async () => {
    const f = await installation(),
      path = `/v1/regions/${f.fixture.region}/installation-profile`;
    expect(
      (await request(path, f.fixture.integrator, "PUT", f.profile)).status,
    ).toBe(403);
    await storeNodeInstallationProfile(f.bindings, f.fixture.region, f.profile);
    expect(
      (
        await request(path, f.fixture.admin, "PUT", {
          ...f.profile,
          dns: ["192.0.2.99"],
        })
      ).status,
    ).toBe(409);
    expect(
      (await readNodeInstallationProfile(f.bindings, f.fixture.region))!
        .profile,
    ).toEqual(f.profile);
  });
  it("retains one fresh server host identity and inspection bearer across binding replay", async () => {
    const f = await installation(),
      id = f.addition.intent.operation_id,
      firewall = crypto.randomUUID();
    await storeNodeInstallationProfile(f.bindings, f.fixture.region, f.profile);
    const first = await bindNodeInstallation(
        f.bindings,
        id,
        f.addition.revision,
        firewall,
        f.provider,
      ),
      privateFirst = await loadNodeInstallationBinding(f.bindings, id);
    expect(privateFirst!.rescue.ssh_host_key).not.toBe(
      f.body.rescue.ssh_host_key,
    );
    expect(privateFirst!.rescue.ssh_private_key).toBe(
      f.profile.rescue_client_private_key,
    );
    expect(
      await bindNodeInstallation(
        f.bindings,
        id,
        f.addition.revision,
        firewall,
        f.provider,
      ),
    ).toEqual(first);
    expect(await loadNodeInstallationBinding(f.bindings, id)).toEqual(
      privateFirst,
    );
    expect(await installationFirewallBinding(env.DB, id, f.providerId)).toBe(
      firewall,
    );
    const rescue = await validateRescueConfiguration(f.bindings, f.providerId);
    expect(rescue!.ssh_host_key).toBe(privateFirst!.rescue.ssh_host_key);
    expect(rescue!.user_data).toBe(privateFirst!.rescue.user_data);
    await expect(
      bindNodeInstallation(
        f.bindings,
        id,
        f.addition.revision,
        crypto.randomUUID(),
        f.provider,
      ),
    ).rejects.toThrow("Installation configuration");
  });
  it("reuses an admitted peer's dynamic firewall binding for the next addition in the same region", async () => {
    const f = await boundInstallationFixture();
    regions.push(f.fixture.region);
    const id = f.addition.intent.operation_id,
      now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE node_region_policies SET max_nodes=2 WHERE region_id=?",
    )
      .bind(f.fixture.region)
      .run();
    await env.DB.prepare(
      "UPDATE node_additions SET status='ready' WHERE operation_id=?",
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,provider_instance_id,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,1,8192,8000,32,128,100,?,?,?)",
    )
      .bind(
        f.addition.intent.node_id,
        f.fixture.region,
        f.addition.intent.requested_hostname,
        f.providerId,
        now,
        now,
        now,
      )
      .run();
    const providerId = "3" + f.providerId.slice(1);
    let next = await reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: {
        region_id: f.fixture.region,
        mode: "adopt",
        provider_instance_id: providerId,
      },
    });
    next = await recordNodeReceipt(
      env.DB,
      next.intent.operation_id,
      next.revision,
      {
        provider_instance_id: providerId,
        request_id: null,
        reference: crypto.randomUUID(),
        received_at: now,
      },
    );
    next = await recordNodeAudit(
      env.DB,
      next.intent.operation_id,
      next.revision,
      {
        provider_instance_id: providerId,
        provider_region: "EU",
        product_id: f.addition.audit!.product_id,
        image_id: f.addition.audit!.image_id,
        reference: crypto.randomUUID(),
        observed_at: now,
      },
    );
    expect(
      await installationFirewallBinding(
        env.DB,
        next.intent.operation_id,
        f.providerId,
      ),
    ).toBe(f.binding.row.firewall_id);
  });
  it("authenticates inspection before parsing and enforces scope, freshness and generation", async () => {
    const f = await boundInstallationFixture();
    regions.push(f.fixture.region);
    const path = `https://api.invalid/internal/v1/node-installation/${f.addition.intent.operation_id}/inspection`;
    const invalid = await createApp().fetch(
      new Request(path, {
        method: "POST",
        headers: {
          Authorization: "Bearer invalid",
          "Content-Type": "application/json",
        },
        body: "invalid-json",
      }),
      f.bindings,
    );
    expect(invalid.status).toBe(401);
    const response = await createApp().fetch(
      new Request(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.binding.inspection_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expected_generation: 0,
          inspection: f.inspection,
        }),
      }),
      f.bindings,
    );
    expect(response.status).toBe(202);
    expect(
      ((await response.json()) as { inspection_generation: number })
        .inspection_generation,
    ).toBe(1);
    await expect(
      recordNodeInstallationInspection(
        f.bindings,
        f.addition.intent.operation_id,
        0,
        f.inspection,
      ),
    ).rejects.toThrow("generation changed");
    await expect(
      recordNodeInstallationInspection(
        f.bindings,
        f.addition.intent.operation_id,
        1,
        {
          ...f.inspection,
          observed_at: new Date(Date.now() - 120001).toISOString(),
        },
      ),
    ).rejects.toThrow("freshness changed");
    await expect(
      recordNodeInstallationInspection(
        f.bindings,
        f.addition.intent.operation_id,
        1,
        { ...f.inspection, binding_sha256: "a".repeat(64) },
      ),
    ).rejects.toThrow("identity");
  });
});
