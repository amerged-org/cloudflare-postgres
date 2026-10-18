// SPDX-License-Identifier: Apache-2.0
import { FleetReleaseSpec, INSTALLER_PROGRESS_PATH } from "@pgcf/contracts";
import {
  installerUserData,
  type InstallerParameters,
} from "@pgcf/contracts/node-installer";
import type { NodeAddition } from "@pgcf/contracts/nodes";
import type { Env } from "../env.ts";
import {
  ContaboError,
  contaboClient,
  hasAllocatedContaboHardware,
  type ContaboClient,
  type ContaboFirewall,
  type ContaboInstance,
} from "../providers/contabo.ts";
import { installSources, issueNodeInstall } from "./node-install.ts";
import {
  markNodeAdditionFailed,
  markNodeBootstrapping,
  markNodeInstallBlocked,
  readNodeAddition,
} from "./node-state.ts";

/** The calls the install makes of Contabo (ULTRA plan 9.2). */
export type InstallProvider = Pick<
  ContaboClient,
  "getInstance" | "getFirewall" | "assignFirewall" | "rescue" | "restart"
>;

const MIB = 1024 ** 2;
/**
 * The rescue system shows less RAM than the provider sold (Stage 1: 11,960 MiB of 12 GiB), and
 * holds the image in it: the installer asserts the machine it landed on has 90 % of the RAM the
 * provider reports for the instance.
 */
const MEMORY_MIN_FRACTION = 0.9;
/**
 * Contabo may start the rescue system again after the installer's reboot (Stage 1 left it with the
 * API's restart). A node that is not enrolled this long after its `rebooting` is restarted, once:
 * a first boot enrolls within a minute or two.
 */
const RESTART_AFTER_MS = 3 * 60_000;

interface InstallRow {
  expires_at: string;
  enrolled_at: string | null;
  checkpoints_json: string;
  rescue_requested_at: string | null;
  restart_requested_at: string | null;
}
const installOf = (env: Env, nodeId: string) =>
  env.DB.prepare(
    "SELECT expires_at,enrolled_at,checkpoints_json,rescue_requested_at,restart_requested_at FROM node_installs WHERE node_id=?",
  )
    .bind(nodeId)
    .first<InstallRow>();

/** The release of the region: the node image the installer writes and the version the node enrolls as. */
async function regionRelease(env: Env, regionId: string) {
  const row = await env.DB.prepare(
    `SELECT r.spec_json FROM fleet_region_releases f JOIN fleet_releases r ON r.id=f.release_id WHERE f.region_id=?`,
  )
    .bind(regionId)
    .first<{ spec_json: string }>();
  return row === null
    ? null
    : FleetReleaseSpec.parse(JSON.parse(row.spec_json));
}

/** The resolvers the installer configures: a JSON array of one to three addresses. */
function resolvers(env: Env): string[] {
  const servers: unknown = JSON.parse(env.NODE_DNS_SERVERS ?? "null");
  if (
    !Array.isArray(servers) ||
    servers.length < 1 ||
    servers.length > 3 ||
    !servers.every((server) => typeof server === "string")
  )
    throw new Error("node_dns_servers_unconfigured");
  return servers;
}

/** What the installer asserts and writes, from the release, the instance as the provider reports it and the issued tokens. */
function parametersOf(
  env: Env,
  addition: NodeAddition,
  spec: FleetReleaseSpec,
  instance: ContaboInstance & {
    ipConfig: NonNullable<ContaboInstance["ipConfig"]>;
    macAddress: string;
    ramMb: number;
    diskMb: number;
  },
  tokens: { enrollment_token: string; progress_token: string },
): InstallerParameters {
  const origin = env.NODE_API_ORIGIN;
  if (origin === undefined) throw new Error("node_api_origin_unconfigured");
  const { image } = spec,
    { v4, v6 } = instance.ipConfig;
  return {
    imageUrl: image.url,
    imageZstSha256: image.sha256,
    imageZstBytes: image.size_bytes,
    imageRawSha256: image.raw_sha256,
    imageRawBytes: image.raw_bytes,
    diskBytes: instance.diskMb * MIB,
    memoryMinKib: Math.floor(instance.ramMb * 1024 * MEMORY_MIN_FRACTION),
    mac: instance.macAddress.toLowerCase(),
    ipv4: v4.ip,
    ipv4Prefix: v4.netmaskCidr,
    ipv4Gateway: v4.gateway,
    ...(v6 && v6.ip !== ""
      ? {
          ipv6: {
            address: v6.ip.toLowerCase(),
            prefix: v6.netmaskCidr,
            gateway: v6.gateway.toLowerCase(),
          },
        }
      : {}),
    dns: resolvers(env),
    hostname: addition.intent.requested_hostname,
    progressUrl: `${origin.replace(/\/$/, "")}${INSTALLER_PROGRESS_PATH}`,
    progressToken: tokens.progress_token,
    nodeId: addition.intent.node_id,
    region: addition.intent.request.region_id,
    apiUrl: origin,
    enrollmentToken: tokens.enrollment_token,
  };
}

/** The SSH keys the provider's rescue action wants beside the userData; the installer uses none. */
function rescueKeys(env: Env): string[] {
  const keys: unknown = JSON.parse(env.CONTABO_ORDER_SSH_KEY_IDS);
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string"))
    throw new Error("contabo_ssh_keys_unconfigured");
  return keys;
}

/**
 * The rescue system runs sshd on the public port 22, and Contabo's own cloud-config turns password
 * login on, until the installer turns it off (plan 9.2). So the instance sits behind the operator's
 * Contabo firewall, deny-all inbound (plan 8), before the rescue is requested. The firewall is
 * confirmed when it is active, no inbound rule of it accepts traffic, and a read lists the
 * instance with the status `ok`, after one assignment if the first read did not list it. Contabo
 * applies an assignment on its own time and reports the application apart from the list, so an
 * instance that is listed and not yet `ok` is waited for, not assigned again; an unconfirmed
 * firewall is asked again on the next cycle; a firewall that cannot be read confirms nothing.
 */
async function ensureNodeFirewall(
  provider: Pick<ContaboClient, "getFirewall" | "assignFirewall">,
  firewallId: string,
  instanceId: string,
  operationId: string,
): Promise<boolean> {
  const request = () => ({
    requestId: crypto.randomUUID(),
    accounting: { operation_id: operationId, stage: "firewall" as const },
  });
  // A rule that drops admits nothing; Contabo may report its final deny as one.
  const closed = (firewall: ContaboFirewall) =>
    firewall.status === "active" &&
    firewall.rules.inbound.every((rule) => rule.action === "drop");
  const listed = (firewall: ContaboFirewall) =>
    firewall.instances.some((held) => held.instanceId === instanceId);
  const applied = (firewall: ContaboFirewall) =>
    listed(firewall) &&
    firewall.instanceStatus.some(
      (held) => held.instanceId === instanceId && held.status === "ok",
    );
  try {
    let firewall = await provider.getFirewall(firewallId, request());
    if (!closed(firewall)) return false;
    if (!listed(firewall)) {
      const assignment = await provider.assignFirewall(
        firewallId,
        instanceId,
        request(),
      );
      if (assignment.kind !== "accepted") return false;
      firewall = await provider.getFirewall(firewallId, request());
    }
    return closed(firewall) && applied(firewall);
  } catch (error) {
    if (error instanceof ContaboError) return false;
    throw error;
  }
}

async function startInstall(
  env: Env,
  addition: NodeAddition,
  provider: InstallProvider,
): Promise<void> {
  const operation = addition.intent.operation_id,
    nodeId = addition.intent.node_id;
  // The rescue was claimed, and the process went down before it could record the status: the
  // installer's own report and the node's enrollment say how it went.
  if ((await installOf(env, nodeId))?.rescue_requested_at != null) {
    await markNodeBootstrapping(env.DB, operation, addition.revision);
    return;
  }
  const spec = await regionRelease(env, addition.intent.request.region_id);
  if (spec === null || addition.provider_instance_id === null) return;
  const instance = await provider.getInstance(addition.provider_instance_id, {
    requestId: crypto.randomUUID(),
    accounting: { operation_id: operation, stage: "inspection" },
  });
  if (!hasAllocatedContaboHardware(instance)) return;
  if (
    !(await ensureNodeFirewall(
      provider,
      env.CONTABO_NODE_FIREWALL_ID,
      instance.id,
      operation,
    ))
  ) {
    await markNodeInstallBlocked(env.DB, addition, "node_firewall_unconfirmed");
    return;
  }
  const keys = rescueKeys(env);
  const tokens = await issueNodeInstall(env, {
    node_id: nodeId,
    image_version: spec.os.image_version,
    sources: installSources(instance.ipConfig),
  });
  const userData = installerUserData(
    parametersOf(env, addition, spec, instance, tokens),
  );
  // The claim comes before the call, as the purchase's does: the same tokens are never sent twice.
  const claim = await env.DB.prepare(
    "UPDATE node_installs SET rescue_requested_at=? WHERE node_id=? AND rescue_requested_at IS NULL AND enrolled_at IS NULL",
  )
    .bind(new Date().toISOString(), nodeId)
    .run();
  if (claim.meta.changes !== 1) return;
  const result = await provider.rescue(
    instance.id,
    { userData, sshKeys: keys },
    {
      requestId: crypto.randomUUID(),
      accounting: { operation_id: operation, stage: "rescue" },
    },
  );
  // An answer that is not known is no refusal: the instance may be in rescue already.
  if (result.kind === "rejected")
    await markNodeAdditionFailed(
      env.DB,
      operation,
      addition.revision,
      "bootstrap_failed",
    );
  else await markNodeBootstrapping(env.DB, operation, addition.revision);
}

async function watchInstall(
  env: Env,
  addition: NodeAddition,
  provider: InstallProvider,
): Promise<void> {
  const nodeId = addition.intent.node_id,
    operation = addition.intent.operation_id,
    install = await installOf(env, nodeId);
  if (install === null || install.enrolled_at !== null) return;
  const now = Date.now(),
    checkpoints = JSON.parse(install.checkpoints_json) as {
      checkpoint: string;
      at: string;
    }[];
  // The tokens live as long as the install may take: the node that has not enrolled by then
  // never will with them.
  if (
    checkpoints.some((entry) => entry.checkpoint === "failed") ||
    Date.parse(install.expires_at) <= now
  ) {
    await markNodeAdditionFailed(
      env.DB,
      operation,
      addition.revision,
      "bootstrap_failed",
    );
    return;
  }
  const rebooted = checkpoints.find(
    (entry) => entry.checkpoint === "rebooting",
  );
  if (
    rebooted === undefined ||
    install.restart_requested_at !== null ||
    now - Date.parse(rebooted.at) < RESTART_AFTER_MS ||
    addition.provider_instance_id === null
  )
    return;
  const claim = await env.DB.prepare(
    "UPDATE node_installs SET restart_requested_at=? WHERE node_id=? AND restart_requested_at IS NULL",
  )
    .bind(new Date(now).toISOString(), nodeId)
    .run();
  if (claim.meta.changes === 1)
    await provider.restart(addition.provider_instance_id, {
      requestId: crypto.randomUUID(),
      accounting: { operation_id: operation, stage: "rescue" },
    });
}

/**
 * One pass over the install of a node (ULTRA plan 9.2), repeated by AddNode until the node has
 * enrolled and sampled. An audited server gets its tokens and the rescue that carries the
 * installer, once. A server that is being installed fails with the installer or when its tokens
 * run out, and is restarted once if it did not enroll after the installer rebooted it. The node's
 * first sample with its credentials opens it (`NodeActor`).
 */
export async function driveNodeInstall(
  env: Env,
  operationId: string,
  provider: InstallProvider = contaboClient(env),
): Promise<void> {
  const addition = await readNodeAddition(env.DB, operationId);
  if (addition.status === "audited")
    await startInstall(env, addition, provider);
  else if (addition.status === "bootstrapping")
    await watchInstall(env, addition, provider);
}
