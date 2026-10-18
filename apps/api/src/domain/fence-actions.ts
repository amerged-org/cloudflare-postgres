// SPDX-License-Identifier: Apache-2.0
import type { Env } from "../env.ts";
import { cloudflareApi } from "../providers/cloudflare.ts";
import { contaboClient, type ContaboClient } from "../providers/contabo.ts";
import { nodeTunnelName, TUNNEL_ID } from "./node-tunnel.ts";
import type { FenceActions } from "./node-loss.ts";

/**
 * The fencing steps of a lost node against the real services (ULTRA plan 9.4): the Cloudflare API
 * deletes the node's Tunnel, which also ends the validity of its token, and the Contabo API powers
 * its instance off and reports its status. Nothing a service answers is kept or thrown on: a
 * failure is one class the caller records.
 *
 * The Tunnel is found by name, because nothing else ties it to the node: the credentials of each
 * node make its Tunnel under `nodeTunnelName`, the node's addition hostname. A node that has no
 * Tunnel under that name is not fenced if it made one: its Tunnel may be alive under another name,
 * so the step fails (`tunnel_unknown`) instead of counting the Tunnel as gone. A node that never
 * read its credentials made none, and has none to delete.
 */

export interface FenceServices {
  cloudflare: { token: string; fetcher?: typeof fetch } | null;
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
      for (const tunnel of listed as {
        id?: unknown;
        name?: unknown;
        deleted_at?: unknown;
      }[]) {
        if (tunnel.name !== name) continue;
        found++;
        if (tunnel.deleted_at) continue;
        if (typeof tunnel.id !== "string" || !TUNNEL_ID.test(tunnel.id))
          throw new Error("cloudflare_api_failed");
        // A Tunnel with a connected connector cannot be deleted.
        await call("DELETE", `${base}/${tunnel.id}/connections`);
        await call("DELETE", `${base}/${tunnel.id}`);
      }
      if (found === 0 && target.tunnelMade) throw new Error("tunnel_unknown");
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
  const token = env.CLOUDFLARE_API_TOKEN;
  const contabo =
    env.CONTABO_CLIENT_ID &&
    env.CONTABO_CLIENT_SECRET &&
    env.CONTABO_USERNAME &&
    env.CONTABO_PASSWORD
      ? contaboClient(env)
      : null;
  return fenceActions({
    cloudflare: token ? { token } : null,
    contabo,
  });
}
