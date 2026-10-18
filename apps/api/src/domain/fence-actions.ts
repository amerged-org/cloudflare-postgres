// SPDX-License-Identifier: Apache-2.0
import { nodeAdditionHostname } from "@pgcf/contracts/nodes";
import type { Env } from "../env.ts";
import { contaboClient, type ContaboClient } from "../providers/contabo.ts";
import type { FenceActions } from "./node-loss.ts";

/**
 * The fencing steps of a lost node against the real services (ULTRA plan 9.4): the Cloudflare API
 * deletes the node's Tunnel, which also ends the validity of its token, and the Contabo API powers
 * its instance off and reports its status. Nothing a service answers is kept or thrown on: a
 * failure is one class the caller records.
 *
 * The Tunnel is found by name, because nothing else ties it to the node: node enrollment must
 * create the Tunnel of each node under `nodeTunnelName`, the node's addition hostname. A node
 * that has no Tunnel under that name is not fenced: its Tunnel may be alive under another name,
 * so the step fails (`tunnel_unknown`) instead of counting the Tunnel as gone.
 */
export const nodeTunnelName = nodeAdditionHostname;

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const TUNNEL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
      const fetcher = cloudflare.fetcher ?? fetch;
      const call = async (url: string, method: "GET" | "DELETE") => {
        const response = await fetcher(url, {
          method,
          redirect: "manual",
          headers: { Authorization: `Bearer ${cloudflare.token}` },
        });
        const body = (await response.json().catch(() => null)) as {
          success?: boolean;
          result?: unknown;
        } | null;
        if (!response.ok || body?.success !== true)
          throw new Error("cloudflare_api_failed");
        return body.result;
      };
      const base = `${CLOUDFLARE_API}/accounts/${target.accountId}/cfd_tunnel`,
        name = nodeTunnelName(target.nodeId);
      // Deleted Tunnels are listed too: a Tunnel an earlier run deleted is gone, not unknown.
      const listed = await call(
        `${base}?name=${encodeURIComponent(name)}&per_page=100`,
        "GET",
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
        await call(`${base}/${tunnel.id}/connections`, "DELETE");
        await call(`${base}/${tunnel.id}`, "DELETE");
      }
      if (found === 0) throw new Error("tunnel_unknown");
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
