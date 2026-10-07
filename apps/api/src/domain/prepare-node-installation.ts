// SPDX-License-Identifier: Apache-2.0
import type { Env } from "../env.ts";
import type { ContaboClient } from "../providers/contabo.ts";
import { z } from "zod";
import { ApiError } from "../app.ts";
import { readNodeAddition } from "./node-state.ts";
import {
  readNodeInstallationProfile,
  bindNodeInstallation,
  loadNodeInstallationBinding,
  installationHash,
} from "./node-installation.ts";
import { ensureNodeInstallationFirewall } from "./node-firewall-allocation.ts";
import { composeConfiguredNodeBootstrap } from "./bootstrap-composition.ts";

/** A configured regional profile owns automatic input preparation; legacy sealed jobs are retained. */
export async function prepareNodeInstallationInputs(
  env: Env,
  operationId: string,
  options: {
    provider?: Pick<
      ContaboClient,
      "getInstance" | "getFirewall" | "listFirewalls" | "createFirewall"
    >;
  } = {},
) {
  const addition = await readNodeAddition(env.DB, operationId);
  const profile = await readNodeInstallationProfile(
    env,
    addition.intent.request.region_id,
  );
  if (!profile) {
    const job = await composeConfiguredNodeBootstrap(env, operationId, options);
    return {
      profile_configured: false,
      binding_ready: false,
      job_configured: job !== null,
    };
  }
  const retained = await loadNodeInstallationBinding(env, operationId);
  let firewall: string | null;
  if (retained) {
    const row = retained.row;
    const reject = (): never => {
      throw new ApiError("conflict", "Retained installation authority changed");
    };
    const region = await env.DB.prepare(
      "SELECT provider,provider_region FROM regions WHERE id=?",
    )
      .bind(row.region_id)
      .first<{ provider: string; provider_region: string }>();
    if (
      !addition.slot_held ||
      !addition.audit ||
      !["audited", "bootstrapping"].includes(addition.status) ||
      row.operation_id !== operationId ||
      row.node_id !== addition.intent.node_id ||
      row.region_id !== addition.intent.request.region_id ||
      row.provider_instance_id !== addition.provider_instance_id ||
      addition.audit.provider_instance_id !== row.provider_instance_id ||
      addition.receipt?.provider_instance_id !== row.provider_instance_id ||
      region?.provider !== "contabo" ||
      region.provider_region !== addition.audit.provider_region ||
      row.profile_sha256 !== profile.profile_sha256 ||
      profile.profile.provider_product_id !== addition.audit.product_id ||
      profile.profile.relay_issuer_region_id !==
        env.BOOTSTRAP_RELAY_ISSUER_REGION ||
      retained.rescue.ssh_private_key !==
        profile.profile.rescue_client_private_key ||
      row.binding_sha256 !==
        (await installationHash({
          operation_id: operationId,
          node_id: addition.intent.node_id,
          region_id: row.region_id,
          provider_instance_id: row.provider_instance_id,
          profile_sha256: row.profile_sha256,
          firewall_id: row.firewall_id,
          rescue_host_fingerprint: retained.rescue.ssh_host_fingerprint,
        }))
    )
      return reject();
    let configured: Record<string, string>;
    try {
      const raw = env.BOOTSTRAP_FIREWALL_BINDINGS ?? "{}";
      if (raw.length > 65536) return reject();
      configured = z
        .record(z.string().regex(/^[1-9][0-9]{0,18}$/), z.uuid())
        .parse(JSON.parse(raw));
    } catch {
      return reject();
    }
    const claim = await env.DB.prepare(
      "SELECT node_id,region_id,provider_instance_id,provider_region,product_id,image_id,intent_hash,inventory_revision,state,firewall_id FROM node_firewall_allocations WHERE operation_id=?",
    )
      .bind(operationId)
      .first<{
        node_id: string;
        region_id: string;
        provider_instance_id: string;
        provider_region: string;
        product_id: string;
        image_id: string;
        intent_hash: string;
        inventory_revision: number;
        state: string;
        firewall_id: string;
      }>();
    if (
      (configured[row.provider_instance_id] !== undefined &&
        configured[row.provider_instance_id] !== row.firewall_id) ||
      (!configured[row.provider_instance_id] && !claim) ||
      (claim &&
        (claim.state !== "confirmed" ||
          claim.node_id !== row.node_id ||
          claim.region_id !== row.region_id ||
          claim.provider_instance_id !== row.provider_instance_id ||
          claim.provider_region !== addition.audit.provider_region ||
          claim.product_id !== addition.audit.product_id ||
          claim.image_id !== addition.audit.image_id ||
          claim.intent_hash !== addition.intent_hash ||
          claim.inventory_revision > addition.revision ||
          claim.firewall_id !== row.firewall_id))
    )
      return reject();
    firewall = row.firewall_id;
  } else {
    firewall = await ensureNodeInstallationFirewall(env, operationId, options);
  }
  if (firewall === null)
    return {
      profile_configured: true,
      binding_ready: false,
      job_configured: false,
    };
  const current = await readNodeAddition(env.DB, operationId);
  await bindNodeInstallation(
    env,
    operationId,
    current.revision,
    firewall,
    options.provider,
  );
  const job = await composeConfiguredNodeBootstrap(env, operationId, options);
  return {
    profile_configured: true,
    binding_ready: true,
    job_configured: job !== null,
  };
}
