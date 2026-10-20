// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { ensureNodeTunnel } from "../../src/domain/node-tunnel.ts";
import {
  ACCOUNT,
  DOMAIN,
  GATEWAY,
  LEGACY_SHELL,
  NAME,
  NODE,
  SHELL,
  TOKEN,
  TUNNEL,
  TUNNEL_TOKEN,
  ZONE,
  cloudflare,
} from "./cloudflare-double.ts";

const services = (fetcher: typeof fetch, shell = false) => ({
  token: TOKEN,
  accountId: ACCOUNT,
  zoneId: ZONE,
  domain: DOMAIN,
  shell,
  fetcher,
});
const CNAME = (name: string) => ({
  type: "CNAME",
  name,
  content: `${TUNNEL}.cfargotunnel.com`,
  proxied: true,
});
const published = (api: ReturnType<typeof cloudflare>) =>
  api.records.map(({ type, name, content, proxied }) => ({
    type,
    name,
    content,
    proxied,
  }));

it("creates the Tunnel of a node, sends its gateway to loopback and points one hostname at it, with no shell while the shell is off", async () => {
  const api = cloudflare();
  const tunnel = await ensureNodeTunnel(services(api.fetcher), NODE);
  expect(tunnel).toEqual({
    token: TUNNEL_TOKEN,
    gateway_url: `https://${GATEWAY}/pg`,
  });
  expect(api.tunnels).toEqual([{ id: TUNNEL, name: NAME }]);
  expect(
    api.calls.find((c) => c.method === "POST" && c.url.endsWith("/cfd_tunnel"))
      ?.body,
  ).toEqual({ name: NAME, config_src: "cloudflare" });
  // Anything but the gateway, which listens on 8080 on loopback, is refused: no ssh rule, no shell record.
  expect(api.configurations.get(TUNNEL)).toEqual({
    config: {
      ingress: [
        { hostname: GATEWAY, service: "http://127.0.0.1:8080" },
        { service: "http_status:404" },
      ],
    },
  });
  expect(published(api)).toEqual([CNAME(GATEWAY)]);
});

it("sends the shell to loopback and points a second hostname at the Tunnel once the shell is on", async () => {
  const api = cloudflare();
  const tunnel = await ensureNodeTunnel(services(api.fetcher, true), NODE);
  expect(tunnel).toEqual({
    token: TUNNEL_TOKEN,
    gateway_url: `https://${GATEWAY}/pg`,
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
  expect(published(api)).toEqual([CNAME(GATEWAY), CNAME(SHELL)]);
});

it("removes the shell's ingress rule and DNS record of a node on the next call once the shell is off, and then changes nothing", async () => {
  const api = cloudflare();
  await ensureNodeTunnel(services(api.fetcher, true), NODE);
  expect(published(api)).toEqual([CNAME(GATEWAY), CNAME(SHELL)]);
  const tunnel = await ensureNodeTunnel(services(api.fetcher), NODE);
  // The gateway is as before; only the shell is gone.
  expect(tunnel).toEqual({
    token: TUNNEL_TOKEN,
    gateway_url: `https://${GATEWAY}/pg`,
  });
  expect(api.configurations.get(TUNNEL)).toEqual({
    config: {
      ingress: [
        { hostname: GATEWAY, service: "http://127.0.0.1:8080" },
        { service: "http_status:404" },
      ],
    },
  });
  expect(published(api)).toEqual([CNAME(GATEWAY)]);
  // Once removed it stays removed: no creation, no deletion and no change of the gateway's record.
  const calls = api.calls.length;
  await ensureNodeTunnel(services(api.fetcher), NODE);
  expect(
    api.calls
      .slice(calls)
      .filter((c) => c.method === "POST" || c.method === "DELETE"),
  ).toEqual([]);
  expect(
    api.calls.slice(calls).filter((c) => c.url.includes("/dns_records/")),
  ).toEqual([]);
  expect(published(api)).toEqual([CNAME(GATEWAY)]);
});

it("keeps the shell out of the wildcard that guards the gateways: its hostname is not made from the gateway's", () => {
  expect(GATEWAY.startsWith("pgcf-node-")).toBe(true);
  expect(SHELL.startsWith("pgcf-shell-")).toBe(true);
  expect(SHELL.startsWith("pgcf-node-")).toBe(false);
  expect(LEGACY_SHELL.startsWith("pgcf-node-")).toBe(true);
});

it.each([false, true])(
  "deletes the DNS record of the shell's former hostname, whether the shell is on (%s) or not, and writes no ingress rule for it",
  async (shell) => {
    const api = cloudflare({
      tunnels: [{ id: TUNNEL, name: NAME }],
      records: [
        { id: "rec0", ...CNAME(GATEWAY) },
        { id: "rec1", ...CNAME(LEGACY_SHELL) },
      ],
    });
    await ensureNodeTunnel(services(api.fetcher, shell), NODE);
    // The Tunnel's configuration is replaced whole, so the former rule goes with it.
    const hostnames = (
      api.configurations.get(TUNNEL) as {
        config: { ingress: { hostname?: string }[] };
      }
    ).config.ingress.flatMap((rule) => rule.hostname ?? []);
    expect(hostnames).toEqual(shell ? [GATEWAY, SHELL] : [GATEWAY]);
    expect(published(api)).toEqual(
      shell ? [CNAME(GATEWAY), CNAME(SHELL)] : [CNAME(GATEWAY)],
    );
    // A second call finds nothing of the former name and changes no record.
    const calls = api.calls.length;
    await ensureNodeTunnel(services(api.fetcher, shell), NODE);
    expect(
      api.calls
        .slice(calls)
        .filter((c) => c.method === "POST" || c.method === "DELETE"),
    ).toEqual([]);
    expect(
      api.calls.slice(calls).filter((c) => c.url.includes("/dns_records/")),
    ).toEqual([]);
  },
);

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
  const first = await ensureNodeTunnel(services(api.fetcher, true), NODE);
  const calls = api.calls.length;
  expect(first.token).toBe(TUNNEL_TOKEN);
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  expect(api.records[1]!.content).toBe(`${TUNNEL}.cfargotunnel.com`);
  // A second time changes nothing that exists: no creation, and no update of the record that was right.
  await ensureNodeTunnel(services(api.fetcher, true), NODE);
  expect(api.calls.slice(calls).some((c) => c.method === "POST")).toBe(false);
  expect(
    api.calls.slice(calls).filter((c) => c.url.includes("/dns_records/")),
  ).toEqual([]);
});

it.each([false, true])(
  "asks Cloudflare for the configuration, the DNS records and the token at the same time once it has the Tunnel (shell %s)",
  async (shell) => {
    const api = cloudflare({ delay: 10 });
    const tunnel = await ensureNodeTunnel(services(api.fetcher, shell), NODE);
    expect(tunnel.token).toBe(TUNNEL_TOKEN);
    // The configuration, the three DNS reads and the token are in flight together (the Tunnel's
    // identifier is all they wait for); a Worker keeps six calls open at once.
    expect(api.peak).toBe(5);
    expect(published(api)).toEqual(
      shell ? [CNAME(GATEWAY), CNAME(SHELL)] : [CNAME(GATEWAY)],
    );
    // Called again with everything in place, the same five calls make no change.
    const calls = api.calls.length;
    await ensureNodeTunnel(services(api.fetcher, shell), NODE);
    expect(
      api.calls
        .slice(calls)
        .filter(
          (c) => c.method !== "GET" && !c.url.endsWith("/configurations"),
        ),
    ).toEqual([]);
  },
);

it("does not fail while a call it made is still running", async () => {
  const slow = cloudflare({ delay: 30 });
  // The token is refused at once; the calls beside it take longer.
  const fetcher: typeof fetch = (input, init) =>
    String(input).endsWith("/token")
      ? Promise.resolve(
          Response.json({ success: false, result: null }, { status: 403 }),
        )
      : slow.fetcher(input, init);
  await expect(ensureNodeTunnel(services(fetcher), NODE)).rejects.toThrow(
    /^cloudflare_api_failed$/,
  );
  expect(slow.inFlight).toBe(0);
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
