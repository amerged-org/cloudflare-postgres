// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { composeConfiguredNodeBootstrap } from "../../src/domain/bootstrap-composition.ts";
import { recordNodeInstallationInspection } from "../../src/domain/node-installation.ts";
import {
  readBootstrapJob,
  bootstrapJobInput,
} from "../../src/domain/bootstrap-jobs.ts";
import { boundInstallationFixture } from "./installation-fixtures.ts";
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
async function setup(worker = false) {
  const f = await boundInstallationFixture(worker);
  regions.push(f.fixture.region);
  return f;
}
describe("provider-bound bootstrap composition", () => {
  it("joins an existing region using its protected cluster material without another platform", async () => {
    const f = await setup(true),
      id = f.addition.intent.operation_id;
    await recordNodeInstallationInspection(f.bindings, id, 0, f.inspection);
    await composeConfiguredNodeBootstrap(f.bindings, id, {
      provider: f.provider,
    });
    const input = await bootstrapJobInput(
      f.bindings,
      await readBootstrapJob(env.DB, id),
    );
    expect(input.spec.role).toBe("worker");
    expect(input.spec.cluster_uid).toBe(f.bundle.kube_system_uid);
    expect(input.spec.cluster_endpoint).toBe(f.bundle.cluster_endpoint);
    expect(input.join_bundle).toEqual(f.bundle);
    expect(input.platform).toBeUndefined();
    expect(input.spec.platform).toBeUndefined();
  });
  it("waits for an actual fresh inspection and allocated provider hardware", async () => {
    const f = await setup(),
      id = f.addition.intent.operation_id;
    expect(
      await composeConfiguredNodeBootstrap(f.bindings, id, {
        provider: f.provider,
      }),
    ).toBeNull();
    await recordNodeInstallationInspection(f.bindings, id, 0, f.inspection);
    f.actual.status = "pending_payment";
    f.actual.diskMb = null;
    f.actual.ramMb = null;
    expect(
      await composeConfiguredNodeBootstrap(f.bindings, id, {
        provider: f.provider,
      }),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM node_bootstrap_jobs WHERE operation_id=?",
      )
        .bind(id)
        .first(),
    ).toBeNull();
  });
  it("configures the first region from measured bytes and retained secrets, then preserves the sealed job", async () => {
    const f = await setup(),
      id = f.addition.intent.operation_id;
    await recordNodeInstallationInspection(f.bindings, id, 0, f.inspection);
    const status = await composeConfiguredNodeBootstrap(f.bindings, id, {
      provider: f.provider,
    });
    expect(status!.checkpoint.stage).toBe("created");
    const row = await readBootstrapJob(env.DB, id),
      input = await bootstrapJobInput(f.bindings, row);
    expect(input.spec.hardware.disk_bytes).toBe(
      f.inspection.hardware.disk_bytes,
    );
    expect(input.spec.hardware.rescue_ram_min_bytes).toBe(
      f.inspection.image.compressed_bytes +
        f.inspection.image.raw_bytes +
        512 * 1024 ** 2,
    );
    expect(input.spec.cluster_endpoint).toBe(
      `https://${f.inspection.hardware.ipv4}:6443`,
    );
    expect(input.spec.role).toBe("controlplane");
    expect(input.rescue.ssh_host_key).toBe(f.binding.rescue.ssh_host_key);
    expect(input.platform!.agent_key).toBe(f.fixture.agent);
    expect(input.spec.peer_ipv4).toEqual([f.relay.ipConfig.v4.ip]);
    expect(
      await composeConfiguredNodeBootstrap(f.bindings, id, {
        provider: f.provider,
      }),
    ).toEqual(status);
    expect(await readBootstrapJob(env.DB, id)).toEqual(row);
    expect(row.rescue_active).toBe(0);
    expect(row.admission_authorized).toBe(0);
  });
  it("rejects changed provider identity and insufficient measured RAM without creating a job", async () => {
    const f = await setup(),
      id = f.addition.intent.operation_id;
    await recordNodeInstallationInspection(f.bindings, id, 0, f.inspection);
    f.actual.macAddress = "00:00:00:00:00:00";
    await expect(
      composeConfiguredNodeBootstrap(f.bindings, id, { provider: f.provider }),
    ).rejects.toThrow("hardware differs");
    f.actual.macAddress = f.inspection.hardware.mac;
    await recordNodeInstallationInspection(f.bindings, id, 1, {
      ...f.inspection,
      hardware: { ...f.inspection.hardware, ram_bytes: 1 },
    });
    await expect(
      composeConfiguredNodeBootstrap(f.bindings, id, { provider: f.provider }),
    ).rejects.toThrow("Measured rescue memory");
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM node_bootstrap_jobs WHERE operation_id=?",
      )
        .bind(id)
        .first(),
    ).toBeNull();
  });
  it("preserves measured IPv6 gateway when the provider omits it and refuses missing or changed address/prefix evidence", async () => {
    const f = await setup(),
      id = f.addition.intent.operation_id;
    f.actual.ipConfig.v6 = {
      ip: "2001:db8:7::17",
      netmaskCidr: 64,
      gateway: "",
    };
    await recordNodeInstallationInspection(f.bindings, id, 0, f.inspection);
    await expect(
      composeConfiguredNodeBootstrap(f.bindings, id, { provider: f.provider }),
    ).rejects.toThrow("hardware differs");
    await recordNodeInstallationInspection(f.bindings, id, 1, {
      ...f.inspection,
      hardware: {
        ...f.inspection.hardware,
        ipv6: {
          address: f.actual.ipConfig.v6.ip,
          prefix_length: 64,
          gateway: "fe80::1",
        },
      },
    });
    f.actual.ipConfig.v6.netmaskCidr = 48;
    await expect(
      composeConfiguredNodeBootstrap(f.bindings, id, { provider: f.provider }),
    ).rejects.toThrow("hardware differs");
    f.actual.ipConfig.v6.netmaskCidr = 64;
    await composeConfiguredNodeBootstrap(f.bindings, id, {
      provider: f.provider,
    });
    const input = await bootstrapJobInput(
      f.bindings,
      await readBootstrapJob(env.DB, id),
    );
    expect(input.spec.hardware.ipv6).toEqual({
      address: "2001:db8:7::17",
      prefix_length: 64,
      gateway: "fe80::1",
    });
  });
});
