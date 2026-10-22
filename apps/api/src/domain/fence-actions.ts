// SPDX-License-Identifier: Apache-2.0
import type { Env } from "../env.ts";
import { cloudflareApi } from "../providers/cloudflare.ts";
import { contaboClient, type ContaboClient } from "../providers/contabo.ts";
import {
  cnameRecord,
  isNodeZone,
  nodeHostnames,
  nodeTunnelName,
  TUNNEL_ID,
  tunnelTarget,
} from "./node-tunnel.ts";
import type { FenceActions } from "./node-loss.ts";

/**
 * The fencing steps of a lost node against the real services (ULTRA plan 9.4): the Cloudflare API
 * deletes the node's Tunnel, which also ends the validity of its token, and then the DNS records
 * that point at it, and the Contabo API powers its instance off and reports its status. Nothing a
 * service answers is kept or thrown on: a failure is one class the caller records.
 *
 * The Tunnel is found by name, because nothing else ties it to the node: the credentials of each
 * node make its Tunnel under `nodeTunnelName`, the node's addition hostname. A node that has no
 * Tunnel under that name is not fenced if it made one: its Tunnel may be alive under another name,
 * so the step fails (`tunnel_unknown`) instead of counting the Tunnel as gone. A node that never
 * read its credentials made none, and has none to delete.
 *
 * The records are the node's hostnames under the domain of the gateway zone (`nodeHostnames`: the
 * gateway's, the shell's and the shell's former one), and only those whose CNAME targets one of
 * the node's own Tunnels, deleted ones included: a record that has the node's name but points
 * elsewhere is not the node's. They are deleted after the Tunnel, which is what fences the node,
 * and a Tunnel that is already deleted is found by the same listing, so a step whose records
 * failed is repeated whole and a repeat of a finished one changes nothing. The Tunnel is deleted
 * whatever the zone is, because it is what fences the node: a node that has a Tunnel and no usable
 * zone has its Tunnel deleted, and then the step fails (`fence_unconfigured`) and is repeated until
 * the zone is there to look for the node's records.
 */

export interface FenceServices {
  cloudflare: {
    token: string;
    /** The zone and domain of the nodes' hostnames (`NODE_GATEWAY_ZONE_ID`, `NODE_GATEWAY_DOMAIN`). */
    zone: { id: string; domain: string } | null;
    fetcher?: typeof fetch;
  } | null;
  contabo: Pick<ContaboClient, "getInstance" | "stop"> | null;
}

export function fenceActions(services: FenceServices): FenceActions {
  const instance = async (providerInstanceId: string | null) => {
    if (!services.contabo || providerInstanceId === null)
      throw new Error("fence_unconfigured");
    return services.contabo.getInstance(providerInstanceId, {
      requestId: crypto.randomUUID(),
    });
  };
  return {
    async deleteTunnel(target) {
      const cloudflare = services.cloudflare;
      if (!cloudflare || cloudflare.token === "" || target.accountId === null)
        throw new Error("fence_unconfigured");
      const zone =
        cloudflare.zone !== null &&
        isNodeZone(cloudflare.zone.id, cloudflare.zone.domain)
          ? cloudflare.zone
          : null;
      const call = cloudflareApi(cloudflare.token, cloudflare.fetcher);
      const base = `/accounts/${target.accountId}/cfd_tunnel`,
        name = nodeTunnelName(target.nodeId);
      // Deleted Tunnels are listed too: a Tunnel an earlier run deleted is gone, not unknown.
      const listed = await call(
        "GET",
        `${base}?name=${encodeURIComponent(name)}&per_page=100`,
      );
      if (!Array.isArray(listed)) throw new Error("cloudflare_api_failed");
      let found = 0;
      // What the records of the node point at: each Tunnel of its name, deleted ones too.
      const targets = new Set<string>();
      for (const tunnel of listed as {
        id?: unknown;
        name?: unknown;
        deleted_at?: unknown;
      }[]) {
        if (tunnel.name !== name) continue;
        found++;
        const valid =
          typeof tunnel.id === "string" && TUNNEL_ID.test(tunnel.id);
        if (valid) targets.add(tunnelTarget(tunnel.id as string));
        if (tunnel.deleted_at) continue;
        if (!valid) throw new Error("cloudflare_api_failed");
        // A Tunnel with a connected connector cannot be deleted.
        await call("DELETE", `${base}/${tunnel.id}/connections`);
        await call("DELETE", `${base}/${tunnel.id}`);
      }
      if (found === 0 && target.tunnelMade) throw new Error("tunnel_unknown");
      if (targets.size === 0) return;
      // The Tunnel is deleted whatever the zone is; records that cannot be looked for fail the step.
      if (zone === null) throw new Error("fence_unconfigured");
      const { gateway, shell, legacyShell } = nodeHostnames(
        target.nodeId,
        zone.domain,
      );
      for (const hostname of [gateway, shell, legacyShell]) {
        const record = await cnameRecord(call, zone.id, hostname);
        if (typeof record?.content !== "string" || !targets.has(record.content))
          continue;
        if (typeof record.id !== "string")
          throw new Error("cloudflare_api_failed");
        await call("DELETE", `/zones/${zone.id}/dns_records/${record.id}`);
      }
    },
    async powerOff(target) {
      const current = await instance(target.providerInstanceId);
      if (current.status === "stopped") return;
      const result = await services.contabo!.stop(target.providerInstanceId!, {
        requestId: crypto.randomUUID(),
      });
      if (result.kind !== "accepted") throw new Error("power_off_not_accepted");
    },
    async powerState(target) {
      return (await instance(target.providerInstanceId)).status === "stopped"
        ? "stopped"
        : "other";
    },
  };
}

export function fenceActionsFromEnv(env: Env): FenceActions {
  const token = env.CLOUDFLARE_API_TOKEN,
    zoneId = env.NODE_GATEWAY_ZONE_ID,
    domain = env.NODE_GATEWAY_DOMAIN;
  const contabo =
    env.CONTABO_CLIENT_ID &&
    env.CONTABO_CLIENT_SECRET &&
    env.CONTABO_USERNAME &&
    env.CONTABO_PASSWORD
      ? contaboClient(env)
      : null;
  return fenceActions({
    cloudflare: token
      ? { token, zone: zoneId && domain ? { id: zoneId, domain } : null }
      : null,
    contabo,
  });
}
