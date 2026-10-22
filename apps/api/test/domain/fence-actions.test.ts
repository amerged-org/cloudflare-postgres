// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import type { Env } from "../../src/env.ts";
import {
  fenceActions,
  fenceActionsFromEnv,
} from "../../src/domain/fence-actions.ts";
import { nodeTunnelName } from "../../src/domain/node-tunnel.ts";
import { nodeAdditionHostname, nodeShellHostname } from "@pgcf/contracts/nodes";
import type { FenceTarget } from "../../src/domain/node-loss.ts";
import type { Instance } from "../../src/providers/contabo.ts";
import {
  ACCOUNT,
  DOMAIN,
  GATEWAY,
  LEGACY_SHELL,
  NODE,
  SHELL,
  TOKEN,
  TUNNEL,
  ZONE,
  cloudflare as cloudflareState,
  type DnsRecord,
} from "./cloudflare-double.ts";

const target: FenceTarget = {
  nodeId: NODE,
  regionId: "eu-dev",
  providerInstanceId: "12345",
  accountId: ACCOUNT,
  tunnelMade: true,
};
const zone = { id: ZONE, domain: DOMAIN };

/** The Cloudflare API as the Worker sees it: answers by method and path, and keeps the calls. */
function cloudflare(
  answer: (method: string, url: URL) => Response | Promise<Response>,
) {
  const calls: { method: string; url: string; authorization: string | null }[] =
    [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname + url.search,
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    expect(init?.redirect).toBe("manual");
    return answer(method, url);
  };
  return { fetcher, calls };
}
const ok = (result: unknown) => Response.json({ success: true, result });

it("deletes the Tunnel of the node after cleaning up its connections, then looks for its DNS records, and touches nothing else", async () => {
  const api = cloudflare((method, url) =>
    method !== "GET"
      ? ok({ id: TUNNEL })
      : url.pathname.includes("/dns_records")
        ? ok([])
        : ok([
            { id: TUNNEL, name: nodeTunnelName(NODE) },
            { id: "99999999-2222-4333-8444-555555555555", name: "another" },
          ]),
  );
  const actions = fenceActions({
    cloudflare: { token: TOKEN, zone, fetcher: api.fetcher },
    contabo: null,
  });
  await actions.deleteTunnel(target);
  const path = `/client/v4/accounts/${ACCOUNT}/cfd_tunnel`,
    dns = `/client/v4/zones/${ZONE}/dns_records?type=CNAME&name=`;
  expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    `GET ${path}?name=${nodeTunnelName(NODE)}&per_page=100`,
    `DELETE ${path}/${TUNNEL}/connections`,
    `DELETE ${path}/${TUNNEL}`,
    // The records come last: the Tunnel is what fences the node.
    `GET ${dns}${GATEWAY}`,
    `GET ${dns}${SHELL}`,
    `GET ${dns}${LEGACY_SHELL}`,
  ]);
  expect(api.calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(
    true,
  );
});

const OTHER_NODE = "nod_" + "b".repeat(20);
const OTHER_TUNNEL = "99999999-2222-4333-8444-555555555555";
const cname = (
  id: string,
  name: string,
  tunnel: string,
  proxied = true,
): DnsRecord => ({
  id,
  type: "CNAME",
  name,
  content: `${tunnel}.cfargotunnel.com`,
  proxied,
});
const withZone = (fetcher: typeof fetch) =>
  fenceActions({
    cloudflare: { token: TOKEN, zone, fetcher },
    contabo: null,
  });
const dnsDeletions = (api: ReturnType<typeof cloudflareState>) =>
  api.calls
    .filter((c) => c.method === "DELETE" && c.url.includes("/dns_records/"))
    .map((c) => c.url.split("/").pop());
const dnsMutations = (api: ReturnType<typeof cloudflareState>) =>
  api.calls.filter((c) => c.method !== "GET" && c.url.includes("/dns_records"));

it("deletes the proxied records of the lost node's gateway and shell next to its Tunnel, and no other record", async () => {
  const other = `${nodeAdditionHostname(OTHER_NODE)}.${DOMAIN}`,
    api = cloudflareState({
      tunnels: [
        { id: TUNNEL, name: nodeTunnelName(NODE) },
        { id: OTHER_TUNNEL, name: nodeTunnelName(OTHER_NODE) },
      ],
      records: [
        cname("rec0", GATEWAY, TUNNEL),
        cname("rec1", SHELL, TUNNEL),
        cname("rec2", LEGACY_SHELL, TUNNEL),
        cname("rec3", other, OTHER_TUNNEL),
        cname(
          "rec4",
          `${nodeShellHostname(OTHER_NODE)}.${DOMAIN}`,
          OTHER_TUNNEL,
        ),
        cname("rec5", `www.${DOMAIN}`, "elsewhere", false),
      ],
    });
  await withZone(api.fetcher).deleteTunnel(target);
  expect(api.tunnels.map((t) => [t.id, t.deleted_at !== undefined])).toEqual([
    [TUNNEL, true],
    [OTHER_TUNNEL, false],
  ]);
  expect(dnsDeletions(api)).toEqual(["rec0", "rec1", "rec2"]);
  expect(api.records.map((r) => r.id)).toEqual(["rec3", "rec4", "rec5"]);
});

it("leaves a record that carries the node's name but points at another Tunnel, or at no Tunnel", async () => {
  const api = cloudflareState({
    tunnels: [{ id: TUNNEL, name: nodeTunnelName(NODE) }],
    records: [
      cname("rec0", GATEWAY, OTHER_TUNNEL),
      { ...cname("rec1", SHELL, TUNNEL), content: "shell.example.net" },
      // An A record under the node's name is not a record that points at the Tunnel.
      { ...cname("rec2", LEGACY_SHELL, TUNNEL), type: "A" },
    ],
  });
  await withZone(api.fetcher).deleteTunnel(target);
  expect(dnsMutations(api)).toEqual([]);
  expect(api.records.map((r) => r.id)).toEqual(["rec0", "rec1", "rec2"]);
});

it("finishes the records of a Tunnel an earlier run deleted, and then changes nothing", async () => {
  // The run that deleted the Tunnel failed on its records, so the step is retried whole: the
  // listing still names the deleted Tunnel, and its identifier finds the records.
  const api = cloudflareState({
    tunnels: [
      {
        id: TUNNEL,
        name: nodeTunnelName(NODE),
        deleted_at: "2026-10-22T09:00:00Z",
      },
    ],
    records: [cname("rec0", GATEWAY, TUNNEL), cname("rec1", SHELL, TUNNEL)],
  });
  const actions = withZone(api.fetcher);
  await actions.deleteTunnel(target);
  expect(api.records).toEqual([]);
  expect(
    api.calls.filter(
      (c) => c.method === "DELETE" && c.url.includes("/cfd_tunnel/"),
    ),
  ).toEqual([]);
  // The next run finds neither Tunnel nor record to change.
  const calls = api.calls.length;
  await actions.deleteTunnel(target);
  expect(api.calls.slice(calls).filter((c) => c.method !== "GET")).toEqual([]);
});

it("looks for no records of a node without any Tunnel, and needs no zone for it", async () => {
  const none = cloudflareState({ records: [cname("rec0", GATEWAY, TUNNEL)] });
  // A node that never read its credentials made no Tunnel and no record.
  await withZone(none.fetcher).deleteTunnel({ ...target, tunnelMade: false });
  expect(none.calls.every((c) => !c.url.includes("/dns_records"))).toBe(true);
  expect(none.records).toHaveLength(1);
  const unused = cloudflareState();
  await fenceActions({
    cloudflare: { token: TOKEN, zone: null, fetcher: unused.fetcher },
    contabo: null,
  }).deleteTunnel({ ...target, tunnelMade: false });
  expect(unused.calls.every((c) => c.method === "GET")).toBe(true);
});

it("deletes the Tunnel of a node whatever the zone is, and then fails for the records, so that the step is repeated whole", async () => {
  // The Tunnel is what fences the node: a zone that is missing or unusable (a configuration slip,
  // or a gateway that has no public hostname any more) must not leave it alive.
  for (const unusable of [null, { id: "not-a-zone", domain: DOMAIN }]) {
    const api = cloudflareState({
      tunnels: [{ id: TUNNEL, name: nodeTunnelName(NODE) }],
      records: [cname("rec0", GATEWAY, TUNNEL), cname("rec1", SHELL, TUNNEL)],
    });
    await expect(
      fenceActions({
        cloudflare: { token: TOKEN, zone: unusable, fetcher: api.fetcher },
        contabo: null,
      }).deleteTunnel(target),
    ).rejects.toThrow("fence_unconfigured");
    expect(api.tunnels[0]!.deleted_at).toBeDefined();
    // No record is looked at, let alone deleted, in a zone that is not known.
    expect(api.calls.every((c) => !c.url.includes("/dns_records"))).toBe(true);
    expect(api.records).toHaveLength(2);
    // The repeat, once the zone is there, finds the deleted Tunnel and deletes the records.
    await withZone(api.fetcher).deleteTunnel(target);
    expect(api.records).toEqual([]);
  }
});

it("fails for the Tunnel before it fails for the zone: a Tunnel that is not found is unknown, with or without the zone", async () => {
  const api = cloudflareState({ records: [cname("rec0", GATEWAY, TUNNEL)] });
  await expect(
    fenceActions({
      cloudflare: { token: TOKEN, zone: null, fetcher: api.fetcher },
      contabo: null,
    }).deleteTunnel(target),
  ).rejects.toThrow("tunnel_unknown");
  expect(api.calls.every((c) => c.method === "GET")).toBe(true);
});

it("names the Tunnel like the node's addition, so that enrollment and fencing agree", () => {
  expect(nodeTunnelName(NODE)).toBe(nodeAdditionHostname(NODE));
  expect(nodeTunnelName(NODE)).toBe(`pgcf-node-${"a".repeat(20)}`);
});

it("counts a Tunnel the API lists as deleted as gone, and leaves it alone", async () => {
  const api = cloudflare((_, url) =>
    url.pathname.includes("/dns_records")
      ? ok([])
      : ok([
          {
            id: TUNNEL,
            name: nodeTunnelName(NODE),
            deleted_at: "2026-10-18T10:00:00Z",
          },
        ]),
  );
  await fenceActions({
    cloudflare: { token: TOKEN, zone, fetcher: api.fetcher },
    contabo: null,
  }).deleteTunnel(target);
  expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
});

it("does not count a node without any Tunnel as fenced: it fails closed", async () => {
  // Nothing under the node's name, or only other Tunnels: the node's Tunnel may be alive.
  for (const listed of [[], [{ id: TUNNEL, name: "another" }]]) {
    const api = cloudflare(() => ok(listed));
    const error = await fenceActions({
      cloudflare: { token: TOKEN, zone, fetcher: api.fetcher },
      contabo: null,
    })
      .deleteTunnel(target)
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("tunnel_unknown");
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  }
});

it("has no Tunnel to delete for a node that never read its credentials", async () => {
  // The Tunnel is made, under the name the node ID gives it, when the node first reads its
  // credentials. A node that never did (one of the retired Kubernetes runtime, or one lost before
  // it enrolled) has none under any name, so nothing is alive to fence and the step is done.
  for (const listed of [[], [{ id: TUNNEL, name: "another" }]]) {
    const api = cloudflare(() => ok(listed));
    await fenceActions({
      cloudflare: { token: TOKEN, zone, fetcher: api.fetcher },
      contabo: null,
    }).deleteTunnel({ ...target, tunnelMade: false });
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  }
});

it("fails on an answer it cannot trust, without the token or the answer in the error", async () => {
  const failing = [
    cloudflare(() =>
      Response.json({ success: false, errors: [{ message: TOKEN }] }),
    ),
    cloudflare(() => new Response("<html>" + TOKEN, { status: 502 })),
    cloudflare(() => ok([{ id: "not-a-uuid", name: nodeTunnelName(NODE) }])),
    cloudflare(() => ok({ not: "a list" })),
    cloudflare((method) =>
      method === "GET"
        ? ok([{ id: TUNNEL, name: nodeTunnelName(NODE) }])
        : Response.json({ success: false }, { status: 400 }),
    ),
    // The Tunnel is deleted, then the zone answers what is not a list of records ...
    cloudflare((method, url) =>
      method !== "GET"
        ? ok({ id: TUNNEL })
        : url.pathname.includes("/dns_records")
          ? ok({ not: "a list" })
          : ok([{ id: TUNNEL, name: nodeTunnelName(NODE) }]),
    ),
    // ... or refuses to delete a record of the node.
    cloudflare((method, url) =>
      method === "DELETE" && url.pathname.includes("/dns_records/")
        ? Response.json({ success: false }, { status: 403 })
        : method !== "GET"
          ? ok({ id: TUNNEL })
          : url.pathname.includes("/dns_records")
            ? ok([cname("rec0", GATEWAY, TUNNEL)])
            : ok([{ id: TUNNEL, name: nodeTunnelName(NODE) }]),
    ),
  ];
  for (const api of failing) {
    const error = await fenceActions({
      cloudflare: { token: TOKEN, zone, fetcher: api.fetcher },
      contabo: null,
    })
      .deleteTunnel(target)
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("cloudflare_api_failed");
  }
});

it("takes the zone of the records from the Worker's variables, and keeps the records for a repeat without them", async () => {
  const api = cloudflareState({
    tunnels: [{ id: TUNNEL, name: nodeTunnelName(NODE) }],
    records: [cname("rec0", GATEWAY, TUNNEL), cname("rec1", SHELL, TUNNEL)],
  });
  vi.stubGlobal("fetch", api.fetcher);
  try {
    const env = { CLOUDFLARE_API_TOKEN: TOKEN } as Env;
    // Without the variables the Tunnel is deleted all the same, and the step fails for the records.
    await expect(fenceActionsFromEnv(env).deleteTunnel(target)).rejects.toThrow(
      "fence_unconfigured",
    );
    expect(api.tunnels[0]!.deleted_at).toBeDefined();
    expect(api.records).toHaveLength(2);
    await fenceActionsFromEnv({
      ...env,
      NODE_GATEWAY_ZONE_ID: ZONE,
      NODE_GATEWAY_DOMAIN: DOMAIN,
    }).deleteTunnel(target);
    expect(api.records).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does nothing without credentials or an account", async () => {
  await expect(
    fenceActions({ cloudflare: null, contabo: null }).deleteTunnel(target),
  ).rejects.toThrow("fence_unconfigured");
  await expect(
    fenceActions({
      cloudflare: { token: TOKEN, zone },
      contabo: null,
    }).deleteTunnel({
      ...target,
      accountId: null,
    }),
  ).rejects.toThrow("fence_unconfigured");
  await expect(
    fenceActions({ cloudflare: null, contabo: null }).powerOff(target),
  ).rejects.toThrow("fence_unconfigured");
});

/** Contabo as far as fencing uses it: the status of an instance and the order to stop it. */
function contabo(status: Instance["status"], stop: "accepted" | "rejected") {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async getInstance(id: string) {
        calls.push(`get:${id}`);
        return { id, status } as Instance;
      },
      async stop(id: string) {
        calls.push(`stop:${id}`);
        return stop === "accepted"
          ? ({ kind: "accepted" } as never)
          : ({ kind: "rejected", code: "provider_rejected" } as never);
      },
    },
  };
}

it("powers an instance off through the provider and reads its status", async () => {
  const running = contabo("running", "accepted");
  const actions = fenceActions({ cloudflare: null, contabo: running.client });
  await actions.powerOff(target);
  expect(running.calls).toEqual(["get:12345", "stop:12345"]);
  expect(await actions.powerState(target)).toBe("other");
  const stopped = contabo("stopped", "rejected");
  const off = fenceActions({ cloudflare: null, contabo: stopped.client });
  // Already off: no order, whatever the provider would answer to one.
  await off.powerOff(target);
  expect(stopped.calls).toEqual(["get:12345"]);
  expect(await off.powerState(target)).toBe("stopped");
});

it("fails when the provider does not accept the order to stop", async () => {
  const refusing = contabo("running", "rejected");
  await expect(
    fenceActions({ cloudflare: null, contabo: refusing.client }).powerOff(
      target,
    ),
  ).rejects.toThrow("power_off_not_accepted");
});
