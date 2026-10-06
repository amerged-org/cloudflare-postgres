// SPDX-License-Identifier: Apache-2.0
import { AgentApi } from "./api-client.ts";
import { readConfig } from "./config.ts";
import { kubernetesFromConfig } from "./kubernetes.ts";
import { AgentLink } from "./link.ts";
import { AgentLoop } from "./loop.ts";
import { RegionalMeasurements } from "./measurements.ts";
import { RegionalNodeMemory } from "./node-memory.ts";
import { PowerCoordinator } from "./power.ts";
import type { Log } from "./types.ts";

export const log: Log = (event, fields = {}) =>
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "PGCF regional agent: PGCF_REGION_ID, PGCF_API_URL, PGCF_AGENT_KEY (or PGCF_AGENT_KEY_FILE), PGCF_POSTGRES_IMAGE; optional PGCF_KUBECONFIG_FILE\n",
    );
    return;
  }
  const controller = new AbortController();
  const shutdown = () => {
    log("agent_shutdown");
    controller.abort();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    const config = await readConfig();
    const kubernetes = kubernetesFromConfig(
      controller.signal,
      config.kubeconfigFile,
    );
    const power = new PowerCoordinator({
      k8s: (signal) => kubernetesFromConfig(signal, config.kubeconfigFile),
      signal: controller.signal,
      region: config.regionId,
      replicas: config.gatewayReplicas,
      log,
    });
    const api = new AgentApi(config);
    const nodeMemory = new RegionalNodeMemory({
      k8s: (signal) => kubernetesFromConfig(signal, config.kubeconfigFile),
      signal: controller.signal,
      api,
    });
    const measurements = new RegionalMeasurements({
      k8s: (signal) => kubernetesFromConfig(signal, config.kubeconfigFile),
      signal: controller.signal,
      region: config.regionId,
      snapshot: (signal) => power.gatewaySnapshot(signal),
      api,
    });
    const loop = new AgentLoop(
      api,
      kubernetes,
      config.postgresImage,
      controller.signal,
      log,
      Date.now,
      fetch,
      undefined,
      power,
      measurements,
    );
    const link = new AgentLink(config, () => loop.hint(), log);
    await Promise.all([
      loop.run(),
      link.run(controller.signal),
      measurements.run(),
      nodeMemory.run(),
    ]);
  } finally {
    controller.abort();
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}

main().catch(() => {
  log("agent_startup_failed");
  process.exitCode = 1;
});
