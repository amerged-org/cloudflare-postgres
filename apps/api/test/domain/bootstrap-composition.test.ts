// SPDX-License-Identifier: Apache-2.0
import { readSelectedNodeGoldenImage } from "../../src/domain/node-golden-image.ts";
import { env } from "cloudflare:workers";
import {
  joinBundleReference,
  regionSeedReference,
  storeRegionJoinBundle,
  storeRegionSeed,
  loadRegionJoinBundle,
} from "../../src/crypto/bootstrap-credentials.ts";
import { afterEach, describe, expect, it } from "vitest";
import { composeConfiguredNodeBootstrap } from "../../src/domain/bootstrap-composition.ts";
import {
  recordNodeInstallationInspection,
  readNodeInstallationProfile,
} from "../../src/domain/node-installation.ts";
import {
  deriveRegionKeyring,
  parseRouteKeyring,
  serializeRouteKeyring,
} from "@pgcf/contracts/route-token";
import { bytesToBase64url } from "@pgcf/contracts";
import {
  readBootstrapJob,
  bootstrapJobInput,
} from "../../src/domain/bootstrap-jobs.ts";
import { boundInstallationFixture } from "./installation-fixtures.ts";
import { cleanupFixtures } from "./fixtures.ts";
import { standingPostjoinFixture } from "./postjoin-fixture.ts";
import { readNodePostjoinRelease } from "../../src/domain/node-postjoin-release.ts";
const regions: string[] = [];
const releases: string[] = [];
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
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
async function setup(worker = false) {
  const f = await boundInstallationFixture(worker);
  regions.push(f.fixture.region);
  return f;
}
describe("provider-bound bootstrap composition", () => {
  it("derives current route authority rather than reinstalling a retired profile key", async () => {
    const f = await setup(),
      id = f.addition.intent.operation_id,
      original = await readNodeInstallationProfile(
        f.bindings,
        f.fixture.region,
      ),
      master = JSON.stringify({
        active: "replacement",
        keys: {
          replacement: bytesToBase64url(
            crypto.getRandomValues(new Uint8Array(32)),
          ),
        },
      }),
      bindings = { ...f.bindings, ROUTE_MASTER_KEYS: master };
    await recordNodeInstallationInspection(bindings, id, 0, f.inspection);
    await composeConfiguredNodeBootstrap(bindings, id, {
      provider: f.provider,
    });
    const input = await bootstrapJobInput(
      bindings,
      await readBootstrapJob(env.DB, id),
    );
    expect(input.platform!.route_keyring).toBe(
      serializeRouteKeyring(
        await deriveRegionKeyring(parseRouteKeyring(master), f.fixture.region),
      ),
    );
    expect(input.platform).toEqual({
      ...original!.profile.first_region!.platform,
      route_keyring: input.platform!.route_keyring,
    });
    expect(
      await readNodeInstallationProfile(bindings, f.fixture.region),
    ).toEqual(original);
    expect(input.platform!.route_keyring).not.toBe(
      original!.profile.first_region!.platform.route_keyring,
    );
  });
  it("seals the selected common initial disk and postjoin release under the same immutable region target", async () => {
    const f = await setup(true),
      id = f.addition.intent.operation_id,
      selected = await standingPostjoinFixture(
        f.fixture.region,
        undefined,
        undefined,
        {
          url: `https://artifacts.example/raw/${f.inspection.image.compressed_sha256}`,
          sha256: f.inspection.image.compressed_sha256,
          format: "raw.xz",
          bytes: f.inspection.image.compressed_bytes,
          raw_sha256: f.inspection.image.raw_sha256,
          raw_bytes: f.inspection.image.raw_bytes,
        },
      );
    const golden = (await readSelectedNodeGoldenImage(env, f.fixture.region))!;
    f.inspection.image = {
      ...f.inspection.image,
      schematic_id: golden.schematic_id,
      installer_digest: golden.installer.split("@").at(-1)!,
      golden_image: golden,
    };
    releases.push(selected.id);
    const expected = (await readNodePostjoinRelease(env, f.fixture.region))
      .reference;
    await recordNodeInstallationInspection(f.bindings, id, 0, f.inspection);
    await composeConfiguredNodeBootstrap(f.bindings, id, {
      provider: f.provider,
      postjoinRelease: expected,
    });
    const input = await bootstrapJobInput(
      f.bindings,
      await readBootstrapJob(env.DB, id),
    );
    expect(input.spec.postjoin_release).toEqual(expected);
    expect(input.spec.image).toEqual(f.inspection.image);
    await env.DB.prepare(
      "UPDATE fleet_region_releases SET revision=2 WHERE region_id=?",
    )
      .bind(f.fixture.region)
      .run();
    // Existing sealed/destructive intent is immutable, including after policy changes.
    await composeConfiguredNodeBootstrap(f.bindings, id, {
      provider: f.provider,
      postjoinRelease: expected,
    });
    expect(
      (await bootstrapJobInput(f.bindings, await readBootstrapJob(env.DB, id)))
        .spec,
    ).toEqual(input.spec);
  });
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
  it("seals the selected active join revision for a new worker while retaining historical material", async () => {
    const f = await setup(true),
      id = f.addition.intent.operation_id;
    const upgraded = { ...f.bundle, kubernetes_version: "1.36.5" };
    const seed = {
      version: upgraded.version,
      cluster_name: upgraded.cluster_name,
      cluster_endpoint: upgraded.cluster_endpoint,
      talos_version: upgraded.talos_version,
      kubernetes_version: upgraded.kubernetes_version,
      talos_machine_secrets_yaml: upgraded.talos_machine_secrets_yaml,
      talos_admin_config: upgraded.talos_admin_config,
    };
    await storeRegionSeed(
      env.DB,
      env.CREDENTIAL_KEYS,
      regionSeedReference(f.fixture.region, 2),
      seed,
    );
    await storeRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(f.fixture.region, 2),
      upgraded,
    );
    // This fixture represents the completed activation before the worker's composition.
    await env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
    )
      .bind(f.fixture.region)
      .run();
    await recordNodeInstallationInspection(f.bindings, id, 0, f.inspection);
    await composeConfiguredNodeBootstrap(f.bindings, id, {
      provider: f.provider,
    });
    const job = await readBootstrapJob(env.DB, id);
    expect(JSON.parse(job.material_ref_json!)).toEqual(
      joinBundleReference(f.fixture.region, 2),
    );
    expect((await bootstrapJobInput(f.bindings, job)).join_bundle).toEqual(
      upgraded,
    );
    expect(
      await loadRegionJoinBundle(
        env.DB,
        env.CREDENTIAL_KEYS,
        joinBundleReference(f.fixture.region, 1),
      ),
    ).toEqual(f.bundle);
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
