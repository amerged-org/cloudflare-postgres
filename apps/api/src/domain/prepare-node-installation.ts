// SPDX-License-Identifier: Apache-2.0
import type { Env } from "../env.ts";
import type { ContaboClient } from "../providers/contabo.ts";
import { readNodeAddition } from "./node-state.ts";
import {
  readNodeInstallationProfile,
  bindNodeInstallation,
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
  const firewall = await ensureNodeInstallationFirewall(
    env,
    operationId,
    options,
  );
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
