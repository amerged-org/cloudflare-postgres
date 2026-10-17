// SPDX-License-Identifier: Apache-2.0
import type { Cloudflare } from "./clients.ts";
import { string } from "./core.ts";

export interface InventoryItem {
  kind: string;
  name: string;
}

export async function cloudflareInventory(
  cf: Cloudflare,
): Promise<InventoryItem[]> {
  const [
    workers,
    databases,
    buckets,
    euBuckets,
    tunnels,
    hyperdrives,
    vpcServices,
    virtualNetworks,
  ] = await Promise.all([
    cf.list("/workers/scripts"),
    cf.list("/d1/database"),
    cf.buckets("default"),
    cf.buckets("eu"),
    cf.list("/cfd_tunnel?is_deleted=false"),
    cf.list("/hyperdrive/configs"),
    cf.list("/connectivity/directory/services"),
    cf.list("/teamnet/virtual_networks?is_deleted=false"),
  ]);
  return [
    ...workers.map((row) => ({ kind: "worker", name: string(row.id) })),
    ...databases.map((row) => ({ kind: "d1", name: string(row.name) })),
    ...buckets.map((row) => ({ kind: "r2", name: string(row.name) })),
    ...euBuckets.map((row) => ({ kind: "r2-eu", name: string(row.name) })),
    ...tunnels.map((row) => ({ kind: "tunnel", name: string(row.name) })),
    ...hyperdrives.map((row) => ({
      kind: "hyperdrive",
      name: string(row.name),
    })),
    ...vpcServices.map((row) => ({
      kind: "vpc-service",
      name: string(row.name),
    })),
    ...virtualNetworks.map((row) => ({
      kind: "virtual-network",
      name: string(row.name),
    })),
  ];
}
