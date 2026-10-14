// SPDX-License-Identifier: Apache-2.0
import { ComputePoolPolicy } from "@pgcf/contracts/compute-pool";
import type { Env } from "../env.ts";
import { installationHash } from "./node-installation.ts";
/** The source-qualified ELF pin is effective only with the same currently sealed profile. */
export async function readPostgresPoolHostController(
  env: Pick<Env, "DB">,
  nodeId: string,
  nodeUid: string,
) {
  const row = await env.DB.prepare(
    "SELECT p.policy_json,h.profile_sha256,h.sha256 FROM node_compute_pool_policies p JOIN node_host_configurations h ON h.node_id=p.node_id AND h.node_uid=p.node_uid WHERE p.node_id=? AND p.node_uid=?",
  )
    .bind(nodeId, nodeUid)
    .first<{ policy_json: string; profile_sha256: string; sha256: string }>();
  if (!row) return undefined;
  const policy = ComputePoolPolicy.safeParse(JSON.parse(row.policy_json));
  return policy.success &&
    (await installationHash(policy.data.profile)) === row.profile_sha256
    ? {
        sha256: policy.data.profile.controller_sha256,
        policy_json: row.policy_json,
        profile_sha256: row.profile_sha256,
        host_sha256: row.sha256,
      }
    : undefined;
}
