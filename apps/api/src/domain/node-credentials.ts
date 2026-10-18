// SPDX-License-Identifier: Apache-2.0
import { NodeCredentials } from "@pgcf/contracts";
import {
  deriveNodeKeyring,
  parseRouteKeyring,
  serializeRouteKeyring,
} from "@pgcf/contracts/route-token";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import type { NodeCaller } from "./node-auth.ts";
import {
  accountOf,
  ensureNodeTunnel,
  type NodeTunnelServices,
} from "./node-tunnel.ts";

/** What makes a node's Tunnel, or null while the Worker is not configured to. */
function tunnelServices(env: Env, endpoint: string): NodeTunnelServices | null {
  const accountId = accountOf(endpoint);
  return accountId === null ||
    !env.CLOUDFLARE_API_TOKEN ||
    !env.NODE_GATEWAY_ZONE_ID ||
    !env.NODE_GATEWAY_DOMAIN
    ? null
    : {
        token: env.CLOUDFLARE_API_TOKEN,
        accountId,
        zoneId: env.NODE_GATEWAY_ZONE_ID,
        domain: env.NODE_GATEWAY_DOMAIN,
      };
}

/**
 * `GET /node/v1/credentials` (plan 5.3, 5.8, 8): what the node's gateway and its Tunnel need. The
 * route keyring is derived for the node and holds no key that signs for another; the Tunnel is
 * made if it is not there, and its public hostname becomes the node's gateway for the Edge.
 */
export async function nodeCredentials(
  c: ApiContext,
  node: NodeCaller,
): Promise<Response> {
  const row = await c.env.DB.prepare(
    `SELECT n.credentials_revision,r.backup_endpoint_url FROM nodes n JOIN regions r ON r.id=n.region_id
     WHERE n.id=? AND n.node_uid=?`,
  )
    .bind(node.id, node.uid)
    .first<{ credentials_revision: number; backup_endpoint_url: string }>();
  if (row === null)
    throw new ApiError("unauthorized", "Invalid node credentials");
  const services = tunnelServices(c.env, row.backup_endpoint_url);
  if (services === null) throw new Error("node_tunnel_unconfigured");
  const tunnel = await ensureNodeTunnel(services, node.id);
  await c.env.DB.prepare(
    "UPDATE nodes SET gateway_url=?,updated_at=? WHERE id=? AND node_uid=? AND gateway_url IS NOT ?",
  )
    .bind(
      tunnel.gateway_url,
      new Date().toISOString(),
      node.id,
      node.uid,
      tunnel.gateway_url,
    )
    .run();
  const keyring = await deriveNodeKeyring(
    parseRouteKeyring(c.env.ROUTE_MASTER_KEYS),
    node.id,
  );
  return c.json(
    NodeCredentials.parse({
      revision: row.credentials_revision,
      tunnel_token: tunnel.token,
      route_keyring: JSON.parse(serializeRouteKeyring(keyring)),
    }),
    200,
    { "Cache-Control": "no-store" },
  );
}
