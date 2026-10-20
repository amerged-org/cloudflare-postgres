// SPDX-License-Identifier: Apache-2.0
// The Cloudflare API as the Worker sees it for a node's Tunnel: Tunnels, their configuration and
// DNS records, kept in memory, answering by method and path, and recording the calls.
import { expect } from "vitest";
import { nodeAdditionHostname, nodeShellHostname } from "@pgcf/contracts/nodes";

export const ACCOUNT = "0123456789abcdef0123456789abcdef";
export const ZONE = "fedcba9876543210fedcba9876543210";
export const TOKEN = "cf-api-token-" + "t".repeat(30);
export const TUNNEL_TOKEN = "tunnel-token-" + "k".repeat(40);
export const NODE = "nod_" + "a".repeat(20);
export const NAME = nodeAdditionHostname(NODE);
export const DOMAIN = "nodes.example.org";
export const GATEWAY = `${NAME}.${DOMAIN}`;
export const SHELL = `${nodeShellHostname(NODE)}.${DOMAIN}`;
/** What the shell hostname was called before it had a family of its own. */
export const LEGACY_SHELL = `${NAME}-ssh.${DOMAIN}`;
export const TUNNEL = "11111111-2222-4333-8444-555555555555";

export interface Tunnel {
  id: string;
  name: string;
  deleted_at?: string;
}
export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

/**
 * The Cloudflare API as the Worker sees it: Tunnels, their configuration and DNS records. With
 * `delay` (milliseconds) every call takes that long to answer, as a round trip does, so that calls
 * made at the same time are in flight at the same time (`peak` is the most there were, `inFlight`
 * is how many are now).
 */
export function cloudflare(
  initial: { tunnels?: Tunnel[]; records?: DnsRecord[]; delay?: number } = {},
) {
  const tunnels = [...(initial.tunnels ?? [])],
    records = [...(initial.records ?? [])],
    configurations = new Map<string, unknown>(),
    calls: { method: string; url: string; body: unknown }[] = [];
  // A record's id is never reused after the record is deleted.
  let nextRecord = records.length;
  const state = { inFlight: 0, peak: 0 };
  const answer: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? "GET",
      body =
        init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url: url.pathname + url.search, body });
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(init?.redirect).toBe("manual");
    const ok = (result: unknown) => Response.json({ success: true, result });
    const path = url.pathname.replace("/client/v4", "");
    if (path === `/accounts/${ACCOUNT}/cfd_tunnel` && method === "GET") {
      expect(url.searchParams.get("is_deleted")).toBe("false");
      return ok(
        tunnels.filter(
          (t) => t.name === url.searchParams.get("name") && !t.deleted_at,
        ),
      );
    }
    if (path === `/accounts/${ACCOUNT}/cfd_tunnel` && method === "POST") {
      const tunnel = { id: TUNNEL, name: body.name as string };
      tunnels.push(tunnel);
      return ok({ ...tunnel, token: TUNNEL_TOKEN });
    }
    if (path === `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`) {
      configurations.set(TUNNEL, body);
      return ok({ tunnel_id: TUNNEL });
    }
    if (path === `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/token`)
      return ok(TUNNEL_TOKEN);
    if (path === `/zones/${ZONE}/dns_records` && method === "GET")
      return ok(
        records.filter(
          (r) =>
            r.type === url.searchParams.get("type") &&
            r.name === url.searchParams.get("name"),
        ),
      );
    if (path === `/zones/${ZONE}/dns_records` && method === "POST") {
      const record = { id: `rec${nextRecord++}`, ...body } as DnsRecord;
      records.push(record);
      return ok(record);
    }
    const update = /\/dns_records\/(rec\d+)$/.exec(path);
    if (update && method === "PUT") {
      const record = records.find((r) => r.id === update[1])!;
      Object.assign(record, body);
      return ok(record);
    }
    if (update && method === "DELETE") {
      const at = records.findIndex((r) => r.id === update[1]);
      if (at < 0)
        return Response.json({ success: false, result: null }, { status: 404 });
      records.splice(at, 1);
      return ok({ id: update[1] });
    }
    return Response.json({ success: false, result: null }, { status: 404 });
  };
  const fetcher: typeof fetch = async (input, init) => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      if (initial.delay) await new Promise((r) => setTimeout(r, initial.delay));
      return await answer(input, init);
    } finally {
      state.inFlight -= 1;
    }
  };
  return {
    fetcher,
    tunnels,
    records,
    configurations,
    calls,
    get inFlight() {
      return state.inFlight;
    },
    get peak() {
      return state.peak;
    },
  };
}
