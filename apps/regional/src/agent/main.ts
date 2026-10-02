// SPDX-License-Identifier: Apache-2.0
import { AgentApi } from "./api-client.ts";
import { readConfig } from "./config.ts";
import { kubernetesFromConfig } from "./kubernetes.ts";
import { AgentLink } from "./link.ts";
import { AgentLoop } from "./loop.ts";
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
    const loop = new AgentLoop(
      new AgentApi(config),
      kubernetes,
      config.postgresImage,
      controller.signal,
      log,
    );
    const link = new AgentLink(config, () => loop.hint(), log);
    await Promise.all([loop.run(), link.run(controller.signal)]);
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
