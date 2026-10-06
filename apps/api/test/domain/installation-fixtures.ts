// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import type { Env } from "../../src/env.ts";
import type { ContaboInstance } from "../../src/providers/contabo.ts";
import { NodeInstallationProfile } from "@pgcf/contracts/node-installation";
import { auditedRescueConfiguration } from "./rescue-fixtures.ts";
import {
  storeNodeInstallationProfile,
  bindNodeInstallation,
  loadNodeInstallationBinding,
  installationHash,
} from "../../src/domain/node-installation.ts";
import {
  storeRegionJoinBundle,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";

export async function installationFixture() {
  const f = await auditedRescueConfiguration();
  const profile = NodeInstallationProfile.parse({
    version: 1,
    region_id: f.fixture.region,
    provider_product_id: f.addition.audit!.product_id,
    relay_issuer_region_id: f.fixture.region,
    dns: f.body.spec.hardware.dns,
    storage: f.body.spec.storage,
    rescue_client_private_key: f.body.rescue.ssh_private_key,
    first_region: {
      cluster_name: f.body.spec.cluster_name,
      reviewed_commit: f.body.spec.platform!.reviewed_commit,
      regional_image: f.body.spec.platform!.regional_image,
      platform: { ...f.body.platform!, agent_key: f.fixture.agent },
    },
  });
  const actual: ContaboInstance & {
    ipConfig: NonNullable<ContaboInstance["ipConfig"]>;
    macAddress: string;
  } = {
    id: f.providerId,
    tenantId: "test",
    customerId: "test",
    name: "test",
    displayName: f.addition.intent.requested_hostname,
    dataCenter: "test",
    region: "EU",
    regionName: "test",
    productId: f.addition.audit!.product_id,
    productName: "test",
    imageId: f.addition.audit!.image_id,
    ipConfig: {
      v4: {
        ip: f.body.spec.hardware.ipv4,
        gateway: f.body.spec.hardware.gateway,
        netmaskCidr: f.body.spec.hardware.prefix_length,
      },
    },
    ramMb: 8192,
    cpuCores: 8,
    diskMb: 65536,
    macAddress: f.body.spec.hardware.mac,
    osType: "linux",
    applicationId: null,
    sshKeys: [],
    createdDate: new Date().toISOString(),
    cancelDate: null,
    status: "rescue",
    addOns: [],
    additionalIps: [],
  };
  const relay = {
    ...actual,
    id: "2" + f.providerId.slice(1),
    ipConfig: { v4: { ...actual.ipConfig.v4, ip: "192.0.2.19" } },
  };
  const bindings = {
    ...env,
    BOOTSTRAP_RELAY_ISSUER_REGION: f.fixture.region,
    BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID: relay.id,
    NODE_BOOTSTRAP_CALLBACK_URL: "https://api.invalid/",
  } as Env;
  const provider = {
    getInstance: vi.fn(async (id: string) => {
      if (id === actual.id) return actual;
      if (id === relay.id) return relay;
      throw new Error("unexpected_provider_instance");
    }),
  };
  return { ...f, profile, actual, relay, bindings, provider };
}
export async function boundInstallationFixture(worker = false) {
  const f = await installationFixture();
  await storeNodeInstallationProfile(f.bindings, f.fixture.region, f.profile);
  await bindNodeInstallation(
    f.bindings,
    f.addition.intent.operation_id,
    f.addition.revision,
    crypto.randomUUID(),
    f.provider,
  );
  const binding = (await loadNodeInstallationBinding(
    f.bindings,
    f.addition.intent.operation_id,
  ))!;
  const addresses = (ipv4: string) => ({ ipv4: [ipv4], ipv6: [] });
  const bundle = {
    version: 1 as const,
    cluster_name: f.profile.first_region!.cluster_name,
    cluster_endpoint: `https://${f.relay.ipConfig.v4.ip}:6443`,
    kube_system_uid: crypto.randomUUID(),
    talos_version: "1.14.1",
    kubernetes_version: "1.36.3",
    talos_machine_secrets_yaml: `cluster: ${crypto.randomUUID()}\n`,
    talos_admin_config: `context: ${crypto.randomUUID()}\n`,
    kubeconfig: `apiVersion: v1\nfixture: ${crypto.randomUUID()}\n`,
  };
  if (worker) {
    await env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,provider_instance_id,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,1,8192,8000,32,128,100,?,?,?)",
    )
      .bind(
        f.fixture.node,
        f.fixture.region,
        f.fixture.nodeName,
        f.relay.id,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    await storeRegionJoinBundle(
      f.bindings.DB,
      f.bindings.CREDENTIAL_KEYS,
      joinBundleReference(f.fixture.region, 1),
      bundle,
    );
  }
  const plan = {
    version: 1,
    operation_id: f.addition.intent.operation_id,
    node_id: f.addition.intent.node_id,
    region_id: f.fixture.region,
    provider_instance_id: f.providerId,
    intent_hash: f.addition.intent_hash,
    relay: {
      provider_instance_id: f.relay.id,
      addresses: addresses(f.relay.ipConfig.v4.ip),
    },
    members: [
      {
        node_id: f.addition.intent.node_id,
        provider_instance_id: f.providerId,
        addresses: addresses(f.actual.ipConfig.v4.ip),
      },
      ...(worker
        ? [
            {
              node_id: f.fixture.node,
              provider_instance_id: f.relay.id,
              addresses: addresses(f.relay.ipConfig.v4.ip),
            },
          ]
        : []),
    ],
  };
  const planHash = await installationHash(plan),
    now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_sha256,plan_json,status,readback_at,created_at,updated_at) VALUES(?,?,?,?,'awaiting_proof',?,?,?)",
  )
    .bind(
      f.addition.intent.operation_id,
      f.addition.intent_hash,
      planHash,
      JSON.stringify(plan),
      now,
      now,
      now,
    )
    .run();
  const hardware = f.body.spec.hardware;
  const inspection = {
    purpose: "pgcf-node-inspection/v1" as const,
    operation_id: f.addition.intent.operation_id,
    node_id: f.addition.intent.node_id,
    region_id: f.fixture.region,
    provider_instance_id: f.providerId,
    profile_sha256: binding.row.profile_sha256,
    binding_sha256: binding.row.binding_sha256,
    network_plan_sha256: planHash,
    observed_at: now,
    rescue_host_fingerprint: binding.rescue.ssh_host_fingerprint,
    hardware: {
      mac: hardware.mac,
      ipv4: hardware.ipv4,
      prefix_length: hardware.prefix_length,
      gateway: hardware.gateway,
      install_disk: hardware.install_disk,
      disk_bytes: hardware.disk_bytes,
      ram_bytes: 8 * 1024 ** 3,
    },
    image: f.body.spec.image,
  };
  return { ...f, binding, inspection, bundle };
}
