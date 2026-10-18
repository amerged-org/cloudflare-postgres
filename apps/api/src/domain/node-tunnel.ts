// SPDX-License-Identifier: Apache-2.0
import { nodeAdditionHostname } from "@pgcf/contracts/nodes";
import { cloudflareApi } from "../providers/cloudflare.ts";

/**
 * The Tunnel of a node (ULTRA plan 5.8): one remotely managed Tunnel, named like the node's
 * addition, that carries the node's gateway and its operator shell, both on loopback. The Tunnel,
 * its ingress and the two DNS records that point at it are made by whoever first asks for them
 * and found again by every later call, so a read of the node's credentials that failed half way
 * is repeated whole. Fencing (`fence-actions.ts`) deletes the Tunnel by the same name, because
 * nothing else ties the Tunnel to the node.
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
  fetcher?: typeof fetch;
}
export interface NodeTunnel {
  /** The node's gateway: the Edge dials it. */
  gateway_url: string;
  /** The token cloudflared runs with. */
  token: string;
}

export async function ensureNodeTunnel(
  services: NodeTunnelServices,
  nodeId: string,
): Promise<NodeTunnel> {
  if (
    !CLOUDFLARE_ID.test(services.accountId) ||
    !CLOUDFLARE_ID.test(services.zoneId) ||
    !HOSTNAME_DOMAIN.test(services.domain)
  )
    throw new Error("invalid node tunnel configuration");
  const name = nodeTunnelName(nodeId),
    gateway = `${name}.${services.domain}`,
    shell = `${name}-ssh.${services.domain}`,
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
  await call("PUT", `${base}/${id}/configurations`, {
    config: {
      ingress: [
        { hostname: gateway, service: GATEWAY_SERVICE },
        { hostname: shell, service: SHELL_SERVICE },
        // Anything else is refused.
        { service: "http_status:404" },
      ],
    },
  });
  for (const hostname of [gateway, shell]) {
    const wanted = {
      type: "CNAME",
      name: hostname,
      content: `${id}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    };
    const records = await call(
      "GET",
      `/zones/${services.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    );
    if (!Array.isArray(records)) throw new Error("cloudflare_api_failed");
    const have = (
      records as { id?: unknown; content?: unknown; proxied?: unknown }[]
    )[0];
    if (have === undefined)
      await call("POST", `/zones/${services.zoneId}/dns_records`, wanted);
    else if (have.content !== wanted.content || have.proxied !== true) {
      if (typeof have.id !== "string") throw new Error("cloudflare_api_failed");
      await call(
        "PUT",
        `/zones/${services.zoneId}/dns_records/${have.id}`,
        wanted,
      );
    }
  }
  const token = await call("GET", `${base}/${id}/token`);
  if (typeof token !== "string" || !TUNNEL_TOKEN.test(token))
    throw new Error("cloudflare_api_failed");
  return { gateway_url: `https://${gateway}`, token };
}
