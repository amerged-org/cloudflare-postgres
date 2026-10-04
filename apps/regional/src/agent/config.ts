// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { RegionId } from "@pgcf/contracts";

export interface AgentConfig {
  regionId: string;
  apiUrl: string;
  agentKey: string;
  postgresImage: string;
  kubeconfigFile?: string;
  gatewayReplicas?: number;
}

export async function readConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentConfig> {
  const regionId = RegionId.parse(env.PGCF_REGION_ID);
  const apiUrl = new URL(env.PGCF_API_URL ?? "");
  if (
    apiUrl.protocol !== "https:" ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash ||
    apiUrl.pathname !== "/"
  ) {
    throw new Error("invalid_api_url");
  }
  if (env.PGCF_AGENT_KEY && env.PGCF_AGENT_KEY_FILE)
    throw new Error("ambiguous_agent_key_source");
  const agentKey = env.PGCF_AGENT_KEY_FILE
    ? (await readFile(env.PGCF_AGENT_KEY_FILE, "utf8")).trim()
    : env.PGCF_AGENT_KEY;
  if (
    !agentKey ||
    !new RegExp(`^pgcf_ak_${regionId}_[A-Za-z0-9_-]{43}$`).test(agentKey)
  )
    throw new Error("invalid_agent_key");
  const postgresImage = env.PGCF_POSTGRES_IMAGE;
  if (
    !postgresImage ||
    !/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(postgresImage)
  )
    throw new Error("pinned_postgres_image_required");
  const replicaValue = env.PGCF_GATEWAY_REPLICAS;
  if (
    replicaValue !== undefined &&
    (!/^[0-9]{1,2}$/.test(replicaValue) ||
      Number(replicaValue) < 1 ||
      Number(replicaValue) > 64)
  )
    throw new Error("invalid_gateway_replica_count");
  return {
    ...(replicaValue === undefined
      ? {}
      : { gatewayReplicas: Number(replicaValue) }),
    regionId,
    apiUrl: apiUrl.origin,
    agentKey,
    postgresImage,
    ...(env.PGCF_KUBECONFIG_FILE
      ? { kubeconfigFile: env.PGCF_KUBECONFIG_FILE }
      : {}),
  };
}
