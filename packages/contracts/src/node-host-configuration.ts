// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId, RegionId } from "./ids.ts";
import { FleetReleaseId } from "./releases.ts";
export const NODE_HOST_PATHS = {
  settings: "/var/lib/pgcf-sandbox/settings.json",
  agent_key: "/var/lib/pgcf-sandbox/agent-key",
} as const;
const Sha = z.string().regex(/^[a-f0-9]{64}$/),
  Revision = z.number().int().min(1).max(2147483647);
export const NodeHostConfigurationRequest = z.strictObject({
  node_uid: z.uuid(),
  expected_revision: z.number().int().min(0).max(2147483646),
});
export const NodeHostConfigurationStatus = z.strictObject({
  version: z.literal(1),
  node_id: NodeId,
  node_uid: z.uuid(),
  region_id: RegionId,
  cluster_uid: z.uuid(),
  material_revision: Revision,
  revision: Revision,
  sha256: Sha,
  release_id: FleetReleaseId,
  pool_policy_revision: Revision,
  profile_sha256: Sha,
  created_at: z.iso.datetime(),
});
export type NodeHostConfigurationStatus = z.infer<
  typeof NodeHostConfigurationStatus
>;
export const NodeHostConfigurationPrivate = z.strictObject({
  status: NodeHostConfigurationStatus,
  files: z.tuple([
    z.strictObject({
      path: z.literal(NODE_HOST_PATHS.settings),
      permissions: z.literal(384),
      content: z.string().min(1).max(16384),
    }),
    z.strictObject({
      path: z.literal(NODE_HOST_PATHS.agent_key),
      permissions: z.literal(384),
      content: z.string().min(1).max(4096),
    }),
  ]),
});
export type NodeHostConfigurationPrivate = z.infer<
  typeof NodeHostConfigurationPrivate
>;
