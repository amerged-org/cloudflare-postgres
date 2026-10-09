// SPDX-License-Identifier: Apache-2.0
import {
  NodeBootstrapSpec,
  NodeJoinBundle,
  type NodePostjoinRelease,
} from "@pgcf/contracts/node-bootstrap";
import { NodeInstallationInspection } from "@pgcf/contracts/node-installation";
import { z } from "zod";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import {
  hasAllocatedContaboHardware,
  type ContaboClient,
} from "../providers/contabo.ts";
import { contaboClient } from "./bootstrap-relay.ts";
import { readNodeAddition, assertNodeRecoveryAuthority } from "./node-state.ts";
import {
  readBootstrapJob,
  bootstrapJobStatus,
  configureBootstrapJob,
  NodeBootstrapConfiguration,
} from "./bootstrap-jobs.ts";
import {
  readNodeInstallationProfile,
  loadNodeInstallationBinding,
  installationHash,
} from "./node-installation.ts";
import {
  loadRegionJoinBundle,
  loadCurrentRegionMaterialReference,
} from "../crypto/bootstrap-credentials.ts";
import { bootstrapPlatformHash } from "../crypto/bootstrap-tickets.ts";
import { readNodePostjoinRelease } from "./node-postjoin-release.ts";

const Addresses = z.strictObject({
  ipv4: z.array(z.ipv4()).max(4),
  ipv6: z.array(z.ipv6()).max(4),
});
const Plan = z.looseObject({
  operation_id: z.string(),
  node_id: z.string(),
  region_id: z.string(),
  provider_instance_id: z.string(),
  intent_hash: z.string(),
  relay: z.looseObject({
    provider_instance_id: z.string(),
    addresses: Addresses,
  }),
  members: z
    .array(
      z.looseObject({
        node_id: z.string(),
        provider_instance_id: z.string(),
        addresses: Addresses,
      }),
    )
    .min(1)
    .max(16),
});
const refuse = (message: string): never => {
  throw new ApiError("conflict", message);
};

/** Workflow composition consumes real inspector observations; absence leaves the operation waiting. */
export async function composeConfiguredNodeBootstrap(
  env: Env,
  operationId: string,
  options: {
    provider?: Pick<ContaboClient, "getInstance">;
    now?: () => number;
    postjoinRelease?: NodePostjoinRelease;
  } = {},
) {
  const addition = await readNodeAddition(env.DB, operationId);
  await assertNodeRecoveryAuthority(env.DB, addition);
  const existing = await env.DB.prepare(
    "SELECT operation_id FROM node_bootstrap_jobs WHERE operation_id=?",
  )
    .bind(operationId)
    .first();
  if (existing)
    return bootstrapJobStatus(await readBootstrapJob(env.DB, operationId));
  if (options.postjoinRelease)
    await readNodePostjoinRelease(
      env,
      addition.intent.request.region_id,
      options.postjoinRelease,
      addition.intent.node_id,
    );
  if (
    !addition.audit ||
    !addition.provider_instance_id ||
    !["audited", "bootstrapping"].includes(addition.status)
  )
    return null;
  const binding = await loadNodeInstallationBinding(env, operationId);
  if (!binding?.row.inspection_json) return null;
  const installed = await readNodeInstallationProfile(
    env,
    addition.intent.request.region_id,
  );
  if (
    !installed ||
    installed.profile_sha256 !== binding.row.profile_sha256 ||
    installed.profile.provider_product_id !== addition.audit.product_id
  )
    return refuse(
      "Installation profile differs from the audited provider selection",
    );
  const inspected = NodeInstallationInspection.safeParse(
    JSON.parse(binding.row.inspection_json),
  );
  if (!inspected.success) return refuse("Installation inspection is invalid");
  const observation = inspected.data,
    now = (options.now ?? Date.now)(),
    observed = Date.parse(observation.observed_at);
  if (observed < now - 120000 || observed > now + 5000) return null;
  if (
    observation.operation_id !== operationId ||
    observation.node_id !== addition.intent.node_id ||
    observation.region_id !== installed.profile.region_id ||
    observation.provider_instance_id !== addition.provider_instance_id ||
    observation.profile_sha256 !== installed.profile_sha256 ||
    observation.binding_sha256 !== binding.row.binding_sha256 ||
    observation.rescue_host_fingerprint !== binding.rescue.ssh_host_fingerprint
  )
    return refuse("Installation inspection identity changed");
  const actual = await (options.provider ?? contaboClient(env)).getInstance(
    addition.provider_instance_id,
    {
      requestId: crypto.randomUUID(),
      accounting: { operation_id: operationId, stage: "inspection" },
    },
  );
  if (
    !hasAllocatedContaboHardware(actual) ||
    !["running", "rescue", "stopped", "uninstalled"].includes(actual.status) ||
    actual.ramMb <= 0 ||
    actual.diskMb <= 0
  )
    return null;
  const hardware = observation.hardware;
  const providerIpv6 = actual.ipConfig.v6;
  const ipv6 = (value: string) =>
    new URL(`https://[${value}]`).hostname.slice(1, -1);
  if (
    actual.id !== addition.provider_instance_id ||
    actual.productId !== addition.audit.product_id ||
    actual.region !== addition.audit.provider_region ||
    actual.macAddress.toLowerCase() !== hardware.mac ||
    actual.ipConfig.v4.ip !== hardware.ipv4 ||
    actual.ipConfig.v4.gateway !== hardware.gateway ||
    actual.ipConfig.v4.netmaskCidr !== hardware.prefix_length ||
    (providerIpv6?.ip
      ? !hardware.ipv6 ||
        ipv6(providerIpv6.ip) !== hardware.ipv6.address ||
        providerIpv6.netmaskCidr !== hardware.ipv6.prefix_length ||
        (providerIpv6.gateway !== "" &&
          ipv6(providerIpv6.gateway) !== hardware.ipv6.gateway)
      : hardware.ipv6 !== undefined)
  )
    return refuse(
      "Installation hardware differs from current provider inventory",
    );
  const savedPlan = await env.DB.prepare(
    "SELECT plan_json,plan_sha256,status FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(operationId)
    .first<{ plan_json: string; plan_sha256: string; status: string }>();
  if (
    !savedPlan ||
    savedPlan.status === "blocked" ||
    savedPlan.plan_sha256 !== observation.network_plan_sha256
  )
    return refuse("Installation network plan changed");
  const rawPlan: unknown = JSON.parse(savedPlan.plan_json),
    parsedPlan = Plan.safeParse(rawPlan);
  if (
    !parsedPlan.success ||
    (await installationHash(rawPlan)) !== savedPlan.plan_sha256
  )
    return refuse("Installation network plan is invalid");
  const plan = parsedPlan.data;
  if (
    plan.operation_id !== operationId ||
    plan.node_id !== addition.intent.node_id ||
    plan.region_id !== installed.profile.region_id ||
    plan.provider_instance_id !== actual.id ||
    plan.intent_hash !== addition.intent_hash ||
    plan.relay.provider_instance_id !==
      env.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID ||
    installed.profile.relay_issuer_region_id !==
      env.BOOTSTRAP_RELAY_ISSUER_REGION
  )
    return refuse("Installation network plan identity changed");
  const peers = [
    ...new Set([
      ...plan.relay.addresses.ipv4,
      ...plan.members
        .filter((member) => member.node_id !== addition.intent.node_id)
        .flatMap((member) => member.addresses.ipv4),
    ]),
  ]
    .filter((address) => address !== hardware.ipv4)
    .sort();
  const requiredRam =
    observation.image.compressed_bytes +
    observation.image.raw_bytes +
    512 * 1024 ** 2;
  if (!Number.isSafeInteger(requiredRam) || hardware.ram_bytes < requiredRam)
    return refuse("Measured rescue memory cannot hold the verified image");
  const nodes = await env.DB.prepare(
    "SELECT id FROM nodes WHERE region_id=? AND id<>? AND lost_at IS NULL LIMIT 1",
  )
    .bind(installed.profile.region_id, addition.intent.node_id)
    .first();
  const role = nodes ? "worker" : "controlplane";
  let join: NodeJoinBundle | null = null;
  if (role === "worker")
    join = NodeJoinBundle.parse(
      await loadRegionJoinBundle(
        env.DB,
        env.CREDENTIAL_KEYS,
        await loadCurrentRegionMaterialReference(
          env.DB,
          installed.profile.region_id,
          "join_bundle",
        ),
      ),
    );
  if (!join && !installed.profile.first_region)
    return refuse("An empty region requires its protected platform profile");
  const first = installed.profile.first_region,
    platform = role === "controlplane" ? first!.platform : undefined;
  const spec = NodeBootstrapSpec.parse({
    version: 1,
    ...(options.postjoinRelease
      ? { postjoin_release: options.postjoinRelease }
      : {}),
    operation_id: operationId,
    node_id: addition.intent.node_id,
    region_id: installed.profile.region_id,
    provider_instance_id: actual.id,
    inventory_revision: addition.revision,
    rescue_host_fingerprint: binding.rescue.ssh_host_fingerprint,
    role,
    hostname: addition.intent.requested_hostname,
    peer_ipv4: peers,
    hardware: {
      mac: hardware.mac,
      ipv4: hardware.ipv4,
      prefix_length: hardware.prefix_length,
      gateway: hardware.gateway,
      ...(hardware.ipv6 ? { ipv6: hardware.ipv6 } : {}),
      dns: installed.profile.dns,
      install_disk: hardware.install_disk,
      disk_bytes: hardware.disk_bytes,
      rescue_ram_min_bytes: requiredRam,
    },
    image: observation.image,
    storage: installed.profile.storage,
    cluster_name: join?.cluster_name ?? first!.cluster_name,
    cluster_endpoint: join?.cluster_endpoint ?? `https://${hardware.ipv4}:6443`,
    cluster_uid: join?.kube_system_uid ?? null,
    join_bundle_sha256: join ? await installationHash(join) : null,
    ...(platform
      ? {
          platform: {
            reviewed_commit: first!.reviewed_commit,
            regional_image: first!.regional_image,
            configuration_sha256: await bootstrapPlatformHash(platform),
          },
        }
      : {}),
    transport: {
      mode: "relay",
      issuer_region_id: installed.profile.relay_issuer_region_id,
    },
  });
  const rescue = {
    ssh_private_key: binding.rescue.ssh_private_key,
    ssh_host_key: binding.rescue.ssh_host_key,
    ssh_host_fingerprint: binding.rescue.ssh_host_fingerprint,
  };
  return configureBootstrapJob(
    env,
    operationId,
    NodeBootstrapConfiguration.parse({
      expected_revision: addition.revision,
      spec,
      rescue,
      ...(platform ? { platform } : {}),
    }),
  );
}
