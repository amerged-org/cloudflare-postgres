// SPDX-License-Identifier: Apache-2.0
import {
  NODE_HOST_PATHS,
  NodeHostConfigurationPrivate,
  type NodeHostConfigurationStatus,
} from "../../../packages/contracts/src/node-host-configuration.ts";
import { parseAgentKey } from "../../../packages/contracts/src/auth.ts";

/** Fixed host-service inputs. All caller identity comes from current sealed CF custody. */
export function sandboxHostFiles(
  status: Omit<NodeHostConfigurationStatus, "sha256" | "created_at">,
  apiOrigin: string,
  agentKey: string,
  image: string,
  storageAuthority?: {
    keys: Record<string, string>;
    sha256: string;
    legacy_database_ids: string[];
  },
) {
  const url = new URL(apiOrigin),
    agent = parseAgentKey(agentKey);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    agent?.regionId !== status.region_id ||
    !/^\S+@sha256:[a-f0-9]{64}$/.test(image)
  )
    throw Error("node_host_configuration_invalid");
  const settings = {
    socket: "/run/pgcf-sandbox/controller.sock",
    state: "/var/lib/pgcf-sandbox/slots",
    shim_sockets: "/run/pgcf-sandbox/s",
    containerd_socket: "/run/containerd/containerd.sock",
    containerd_binary: "/bin/containerd",
    shim_binary: "/usr/bin/containerd-shim-runc-v2",
    runc_binary: "/usr/bin/runc",
    holder_binary: "/usr/local/bin/pgcf-node-runtime",
    namespace: "k8s.io",
    slots: 0,
    slot_lifetime_ms: 300000,
    cloudflare: {
      api_url: url.origin,
      agent_key_file: NODE_HOST_PATHS.agent_key,
      node_id: status.node_id,
      node_uid: status.node_uid,
      region_id: status.region_id,
      material_revision: status.material_revision,
      image,
      cgroup_root: "/sys/fs/cgroup/pgcf-compute",
      ...(storageAuthority ? { storage_authority: storageAuthority } : {}),
    },
  };
  return NodeHostConfigurationPrivate.shape.files.parse([
    {
      path: NODE_HOST_PATHS.settings,
      permissions: 384,
      content: JSON.stringify(settings) + "\n",
    },
    {
      path: NODE_HOST_PATHS.agent_key,
      permissions: 384,
      content: agentKey + "\n",
    },
  ]);
}
