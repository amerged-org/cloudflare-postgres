// SPDX-License-Identifier: Apache-2.0
import { nodeAdditionHostname, nodeShellHostname } from "@pgcf/contracts/nodes";
import { cloudflareApi, type CloudflareCall } from "../providers/cloudflare.ts";

/**
 * The Tunnel of a node (ULTRA plan 5.8): one remotely managed Tunnel, named like the node's
 * addition, that carries the node's gateway on loopback and, only while `shell` is on, its
 * operator shell. The Tunnel, its ingress and the DNS records that point at it are made by whoever
 * first asks for them and found again by every later call, so a read of the node's credentials
 * that failed half way is repeated whole. While `shell` is off, the call also removes the shell's
 * ingress rule and DNS record a node got before. The gateway (`pgcf-node-<id>`) and the shell
 * (`pgcf-shell-<id>`) hostnames are two families that Cloudflare Access guards with a wildcard each
 * (`scripts/operations/setup-access.ts`), so no hostname of one may match the other's wildcard.
 * Fencing (`fence-actions.ts`) deletes the Tunnel by the same name, because nothing else ties the
 * Tunnel to the node, and then the DNS records under `nodeHostnames` that point at it.
 */
export const nodeTunnelName = nodeAdditionHostname;

/** The gateway's `PGCF_GATEWAY_PORT` default and sshd's port, on the node's loopback. */
const GATEWAY_SERVICE = "http://127.0.0.1:8080";
const SHELL_SERVICE = "ssh://127.0.0.1:22";
export const TUNNEL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLOUDFLARE_ID = /^[0-9a-f]{32}$/;
const HOSTNAME_DOMAIN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
/** What `NodeCredentials.tunnel_token` takes. */
const TUNNEL_TOKEN = /^[A-Za-z0-9+/=_-]{32,4096}$/;

/** What a DNS record points at to reach a Tunnel. */
export const tunnelTarget = (tunnelId: string) =>
  `${tunnelId}.cfargotunnel.com`;

/** Whether the zone and its domain can hold a node's hostnames. */
export function isNodeZone(zoneId: string, domain: string): boolean {
  return CLOUDFLARE_ID.test(zoneId) && HOSTNAME_DOMAIN.test(domain);
}

/**
 * The hostnames a node has, or had, under the domain of its zone: the gateway's, the shell's and
 * the shell's former one, from before it had a family of its own (`pgcf-node-*` would cover it).
 * Credentials make and remove the records under these names and fencing deletes them.
 */
export function nodeHostnames(nodeId: string, domain: string) {
  const name = nodeTunnelName(nodeId);
  return {
    gateway: `${name}.${domain}`,
    shell: `${nodeShellHostname(nodeId)}.${domain}`,
    legacyShell: `${name}-ssh.${domain}`,
  };
}

/** The CNAME record of a hostname in a zone, if it has one. */
export async function cnameRecord(
  call: CloudflareCall,
  zoneId: string,
  hostname: string,
) {
  const records = await call(
    "GET",
    `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
  );
  if (!Array.isArray(records)) throw new Error("cloudflare_api_failed");
  return (
    records as { id?: unknown; content?: unknown; proxied?: unknown }[]
  )[0];
}

/** The Cloudflare account of a region: the one its R2 endpoint names. */
export function accountOf(endpoint: string): string | null {
  try {
    return /^([0-9a-f]{32})\./.exec(new URL(endpoint).host)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface NodeTunnelServices {
  token: string;
  /** The Cloudflare account that holds the Tunnel. */
  accountId: string;
  /** The DNS zone of `domain`. */
  zoneId: string;
  /** The domain the node's hostnames are made under. */
  domain: string;
  /**
   * Whether the node has a shell hostname. A shell hostname is reachable by whoever runs
   * cloudflared, so it stays off until Cloudflare Access guards it (ULTRA plan 8).
   */
  shell: boolean;
  fetcher?: typeof fetch;
}
export interface NodeTunnel {
  /** The node's gateway: the Edge dials it. */
  gateway_url: string;
  /** The token cloudflared runs with. */
  token: string;
}

/**
 * Runs the calls at once and returns their results in order. It returns when every call has
 * ended, and a failure is the first one in the order of the calls: a read that failed leaves no
 * call of its own running behind it, and a failed read is repeated whole.
 */
async function together<T>(calls: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(calls);
  for (const result of settled)
    if (result.status === "rejected") throw result.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

export async function ensureNodeTunnel(
  services: NodeTunnelServices,
  nodeId: string,
): Promise<NodeTunnel> {
  if (
    !CLOUDFLARE_ID.test(services.accountId) ||
    !isNodeZone(services.zoneId, services.domain)
  )
    throw new Error("invalid node tunnel configuration");
  const name = nodeTunnelName(nodeId),
    { gateway, shell, legacyShell } = nodeHostnames(nodeId, services.domain),
    call = cloudflareApi(services.token, services.fetcher),
    base = `/accounts/${services.accountId}/cfd_tunnel`;
  const listed = await call(
    "GET",
    `${base}?name=${encodeURIComponent(name)}&is_deleted=false&per_page=100`,
  );
  if (!Array.isArray(listed)) throw new Error("cloudflare_api_failed");
  const found = (
    listed as { id?: unknown; name?: unknown; deleted_at?: unknown }[]
  ).find((tunnel) => tunnel.name === name && !tunnel.deleted_at);
  const tunnel =
    found ?? (await call("POST", base, { name, config_src: "cloudflare" }));
  const id = (tunnel as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !TUNNEL_ID.test(id))
    throw new Error("cloudflare_api_failed");
  const dns = `/zones/${services.zoneId}/dns_records`;
  const recordOf = (hostname: string) =>
    cnameRecord(call, services.zoneId, hostname);
  const point = async (hostname: string) => {
    const wanted = {
      type: "CNAME",
      name: hostname,
      content: tunnelTarget(id),
      proxied: true,
      ttl: 1,
    };
    const have = await recordOf(hostname);
    if (have === undefined) await call("POST", dns, wanted);
    else if (have.content !== wanted.content || have.proxied !== true) {
      if (typeof have.id !== "string") throw new Error("cloudflare_api_failed");
      await call("PUT", `${dns}/${have.id}`, wanted);
    }
  };
  const remove = async (hostname: string) => {
    const have = await recordOf(hostname);
    if (have !== undefined) {
      if (typeof have.id !== "string") throw new Error("cloudflare_api_failed");
      await call("DELETE", `${dns}/${have.id}`);
    }
  };
  // The token, the ingress and the records wait for the Tunnel's identifier and for nothing else,
  // so they are asked at once: a read of the credentials is a round trip for the Tunnel and one
  // for the rest, and not one for each of six calls. The ingress names neither hostname that
  // `remove` deletes, so their records go too. The former name is deleted whatever `shell` says:
  // a node that got one before the rename still has the record.
  const [token] = await together<unknown>([
    call("GET", `${base}/${id}/token`),
    call("PUT", `${base}/${id}/configurations`, {
      config: {
        ingress: [
          { hostname: gateway, service: GATEWAY_SERVICE },
          ...(services.shell
            ? [{ hostname: shell, service: SHELL_SERVICE }]
            : []),
          // Anything else is refused.
          { service: "http_status:404" },
        ],
      },
    }),
    ...(services.shell ? [gateway, shell] : [gateway]).map(point),
    ...(services.shell ? [legacyShell] : [shell, legacyShell]).map(remove),
  ]);
  if (typeof token !== "string" || !TUNNEL_TOKEN.test(token))
    throw new Error("cloudflare_api_failed");
  // The gateway accepts a WebSocket upgrade at /pg only; the region contract ends the URL there.
  return { gateway_url: `https://${gateway}/pg`, token };
}
