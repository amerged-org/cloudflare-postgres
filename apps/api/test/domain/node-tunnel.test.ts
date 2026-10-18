// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { ensureNodeTunnel } from "../../src/domain/node-tunnel.ts";
import {
  ACCOUNT,
  DOMAIN,
  GATEWAY,
  NAME,
  NODE,
  SHELL,
  TOKEN,
  TUNNEL,
  TUNNEL_TOKEN,
  ZONE,
  cloudflare,
} from "./cloudflare-double.ts";

const services = (fetcher: typeof fetch) => ({
  token: TOKEN,
  accountId: ACCOUNT,
  zoneId: ZONE,
  domain: DOMAIN,
  fetcher,
});

it("creates the Tunnel of a node, sends its gateway and its shell to loopback and points two hostnames at it", async () => {
  const api = cloudflare();
  const tunnel = await ensureNodeTunnel(services(api.fetcher), NODE);
  expect(tunnel).toEqual({
    token: TUNNEL_TOKEN,
    gateway_url: `https://${GATEWAY}`,
  });
  expect(api.tunnels).toEqual([{ id: TUNNEL, name: NAME }]);
  expect(
    api.calls.find((c) => c.method === "POST" && c.url.endsWith("/cfd_tunnel"))
      ?.body,
  ).toEqual({ name: NAME, config_src: "cloudflare" });
  // The gateway listens on 8080 and sshd on 22, both on loopback; anything else is refused.
  expect(api.configurations.get(TUNNEL)).toEqual({
    config: {
      ingress: [
        { hostname: GATEWAY, service: "http://127.0.0.1:8080" },
        { hostname: SHELL, service: "ssh://127.0.0.1:22" },
        { service: "http_status:404" },
      ],
    },
  });
  expect(
    api.records.map(({ type, name, content, proxied }) => ({
      type,
      name,
      content,
      proxied,
    })),
  ).toEqual([
    {
      type: "CNAME",
      name: GATEWAY,
      content: `${TUNNEL}.cfargotunnel.com`,
      proxied: true,
    },
    {
      type: "CNAME",
      name: SHELL,
      content: `${TUNNEL}.cfargotunnel.com`,
      proxied: true,
    },
  ]);
});

it("finds the Tunnel it made before, creates nothing again and corrects a record that points elsewhere", async () => {
  const api = cloudflare({
    tunnels: [
      {
        id: "99999999-2222-4333-8444-555555555555",
        name: NAME,
        deleted_at: "2026-10-18T10:00:00Z",
      },
      { id: TUNNEL, name: NAME },
    ],
    records: [
      {
        id: "rec0",
        type: "CNAME",
        name: GATEWAY,
        content: `${TUNNEL}.cfargotunnel.com`,
        proxied: true,
      },
      {
        id: "rec1",
        type: "CNAME",
        name: SHELL,
        content: "elsewhere.example.org",
        proxied: true,
      },
    ],
  });
  const first = await ensureNodeTunnel(services(api.fetcher), NODE);
  const calls = api.calls.length;
  expect(first.token).toBe(TUNNEL_TOKEN);
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  expect(api.records[1]!.content).toBe(`${TUNNEL}.cfargotunnel.com`);
  // A second time changes nothing that exists: no creation, and no update of the record that was right.
  await ensureNodeTunnel(services(api.fetcher), NODE);
  expect(api.calls.slice(calls).some((c) => c.method === "POST")).toBe(false);
  expect(
    api.calls.slice(calls).filter((c) => c.url.includes("/dns_records/")),
  ).toEqual([]);
});

it("fails with the class of the API's refusal and never with what it said", async () => {
  const fetcher: typeof fetch = async () =>
    Response.json(
      { success: false, errors: [{ message: "secret detail" }] },
      { status: 403 },
    );
  await expect(ensureNodeTunnel(services(fetcher), NODE)).rejects.toThrow(
    /^cloudflare_api_failed$/,
  );
});

it("refuses a domain or an identifier that would make an odd hostname", async () => {
  const api = cloudflare();
  await expect(
    ensureNodeTunnel(
      { ...services(api.fetcher), domain: "Nodes.Example.Org/x" },
      NODE,
    ),
  ).rejects.toThrow(/invalid/);
  await expect(
    ensureNodeTunnel(services(api.fetcher), "nod_short"),
  ).rejects.toThrow();
  expect(api.calls).toEqual([]);
});
