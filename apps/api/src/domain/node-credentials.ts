// SPDX-License-Identifier: Apache-2.0
import { NodeCredentials } from "@pgcf/contracts";
import {
  deriveNodeKeyring,
  parseRouteKeyring,
  serializeRouteKeyring,
} from "@pgcf/contracts/route-token";
import { ApiError } from "../api-error.ts";
import type { ApiContext, Env } from "../env.ts";
import type { NodeCaller } from "./node-auth.ts";
import { nodeShell, shellCredentialsRevision } from "./node-shell.ts";
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
        shell: nodeShell(env).hostname,
      };
}

/**
 * `GET /node/v1/credentials` (plan 5.3, 5.8, 8): what the node's gateway and its Tunnel need. The
 * route keyring is derived for the node and holds no key that signs for another; the Tunnel is
 * made if it is not there, and its public hostname becomes the node's gateway for the Edge. The
 * Tunnel carries a shell hostname only while NODE_SHELL_HOSTNAME is "true", and the CA key that
 * the shell trusts comes with the credentials only then and only when NODE_SSH_USER_CA_PUBLIC_KEY
 * is one valid key: without the field the node removes the key, and sshd refuses every login. The
 * revision is the one at which D1 holds the shell state of what is handed out (see
 * shellCredentialsRevision), so a node never applies a key at a revision that D1 says has none.
 */
export async function nodeCredentials(
  c: ApiContext,
  node: NodeCaller,
): Promise<Response> {
  const row = await c.env.DB.prepare(
    `SELECT n.credentials_revision,n.shell_state,r.backup_endpoint_url FROM nodes n JOIN regions r ON r.id=n.region_id
     WHERE n.id=? AND n.node_uid=?`,
  )
    .bind(node.id, node.uid)
    .first<{
      credentials_revision: number;
      shell_state: string;
      backup_endpoint_url: string;
    }>();
  if (row === null)
    throw new ApiError("unauthorized", "Invalid node credentials");
  const services = tunnelServices(c.env, row.backup_endpoint_url);
  if (services === null) throw new Error("node_tunnel_unconfigured");
  const shell = nodeShell(c.env);
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
      revision: await shellCredentialsRevision(c.env, {
        id: node.id,
        uid: node.uid,
        credentials_revision: row.credentials_revision,
        shell_state: row.shell_state,
      }),
      tunnel_token: tunnel.token,
      route_keyring: JSON.parse(serializeRouteKeyring(keyring)),
      ...(shell.caPublicKey === null
        ? {}
        : { shell_ca_public_key: shell.caPublicKey }),
    }),
    200,
    { "Cache-Control": "no-store" },
  );
}
