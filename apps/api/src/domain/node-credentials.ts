// SPDX-License-Identifier: Apache-2.0
import { NodeCredentials, bytesToHex } from "@pgcf/contracts";
import {
  deriveNodeKeyring,
  parseRouteKeyring,
  serializeRouteKeyring,
  type RouteKeyring,
} from "@pgcf/contracts/route-token";
import { ApiError } from "../api-error.ts";
import type { ApiContext, Env } from "../env.ts";
import type { NodeCaller } from "./node-auth.ts";
import { nodeShell } from "./node-shell.ts";
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

/** The route keyring the node's gateway verifies with; throws while ROUTE_MASTER_KEYS is not a valid keyring. */
export function nodeRouteKeyring(
  env: Pick<Env, "ROUTE_MASTER_KEYS">,
  nodeId: string,
): Promise<RouteKeyring> {
  return deriveNodeKeyring(parseRouteKeyring(env.ROUTE_MASTER_KEYS), nodeId);
}

/** A digest of a keyring: its active key ID, its key IDs and its keys, in whatever order the variable lists them. */
async function keyringDigest(keyring: RouteKeyring): Promise<string> {
  const keys = [...keyring.keys].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          `pgcf-route-keyring/v1\n${serializeRouteKeyring({ active: keyring.active, keys: new Map(keys) })}`,
        ),
      ),
    ),
  );
}

/** The columns of a node's row that its credentials revision is made of. */
export interface CredentialsRow {
  id: string;
  uid: string;
  credentials_revision: number;
  shell_state: string;
  route_keyring_state: string | null;
}

/**
 * The credentials revision that goes with what this Worker version holds of a node's credentials,
 * for the node's page and for the credentials a node reads. A node reads its credentials again
 * only when the revision rises, and a change of the Worker's variables (the shell's, the route
 * master keyring) changes nothing in D1, so the first request after the change records the new
 * state in D1 and raises the revision once. D1's states and revision are one row, written in one
 * statement, and the content a request hands out comes from the variables it was given: so the
 * revision a request names always belongs to D1 holding the state of that content. While two
 * Worker versions serve at once, each request writes the state it has and the revision rises with
 * every change of hands, which ends when the deploy has spread: whichever version is left holds
 * the last revision, with its own content.
 *
 * The state is the shell's and the keyring's digest, both from the Worker's variables, so the page
 * can hold it without a call to Cloudflare. A keyring the Worker cannot read leaves what D1 holds
 * of it alone (`keyring` null). Neither state raises the revision the first time it is recorded,
 * because there is no earlier content it could differ from. The Tunnel's token is not part of the
 * revision: a node reads it with every read of its credentials, and the agent restarts the Tunnel
 * for a token that is not the one it runs on, so a revision for it would only renumber a response
 * the node acts on anyway.
 */
export async function credentialsRevision(
  env: Env,
  node: CredentialsRow,
  keyring: RouteKeyring | null,
): Promise<number> {
  const { state: shell } = nodeShell(env),
    keys = keyring === null ? null : await keyringDigest(keyring);
  if (
    node.shell_state === shell &&
    (keys === null || node.route_keyring_state === keys)
  )
    return node.credentials_revision;
  const changed = `(shell_state IS NOT ?1
      OR (?2 IS NOT NULL AND route_keyring_state IS NOT NULL AND route_keyring_state<>?2))`;
  const held = await env.DB.prepare(
    `UPDATE nodes SET credentials_revision=credentials_revision+${changed},
       updated_at=CASE WHEN ${changed} THEN ?3 ELSE updated_at END,
       shell_state=?1,route_keyring_state=COALESCE(?2,route_keyring_state)
     WHERE id=?4 AND node_uid=?5 RETURNING credentials_revision`,
  )
    .bind(shell, keys, new Date().toISOString(), node.id, node.uid)
    .first<{ credentials_revision: number }>();
  return held?.credentials_revision ?? node.credentials_revision;
}

/**
 * `GET /node/v1/credentials` (plan 5.3, 5.8, 8): what the node's gateway and its Tunnel need. The
 * route keyring is derived for the node and holds no key that signs for another; the Tunnel is
 * made if it is not there, and its public hostname becomes the node's gateway for the Edge. The
 * Tunnel carries a shell hostname only while NODE_SHELL_HOSTNAME is "true", and the CA key that
 * the shell trusts comes with the credentials only then and only when NODE_SSH_USER_CA_PUBLIC_KEY
 * is one valid key: without the field the node removes the key, and sshd refuses every login. The
 * revision is the one at which D1 holds the state of the shell and the keyring (see
 * credentialsRevision), so a node never applies them at a revision that D1 says has another. The
 * Tunnel's token is read from Cloudflare with every request and is not in the revision.
 */
export async function nodeCredentials(
  c: ApiContext,
  node: NodeCaller,
): Promise<Response> {
  const row = await c.env.DB.prepare(
    `SELECT n.credentials_revision,n.shell_state,n.route_keyring_state,r.backup_endpoint_url
     FROM nodes n JOIN regions r ON r.id=n.region_id WHERE n.id=? AND n.node_uid=?`,
  )
    .bind(node.id, node.uid)
    .first<
      Omit<CredentialsRow, "id" | "uid"> & { backup_endpoint_url: string }
    >();
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
  const keyring = await nodeRouteKeyring(c.env, node.id);
  return c.json(
    NodeCredentials.parse({
      revision: await credentialsRevision(
        c.env,
        { ...row, id: node.id, uid: node.uid },
        keyring,
      ),
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
