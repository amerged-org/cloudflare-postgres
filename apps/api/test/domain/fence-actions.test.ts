// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { fenceActions } from "../../src/domain/fence-actions.ts";
import { nodeTunnelName } from "../../src/domain/node-tunnel.ts";
import { nodeAdditionHostname } from "@pgcf/contracts/nodes";
import type { FenceTarget } from "../../src/domain/node-loss.ts";
import type { Instance } from "../../src/providers/contabo.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-api-token-" + "t".repeat(30);
const NODE = "nod_" + "a".repeat(20);
const target: FenceTarget = {
  nodeId: NODE,
  regionId: "eu-dev",
  providerInstanceId: "12345",
  accountId: ACCOUNT,
};
const TUNNEL = "11111111-2222-4333-8444-555555555555";

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

it("deletes the Tunnel of the node after cleaning up its connections, and nothing else", async () => {
  const api = cloudflare((method) =>
    method === "GET"
      ? ok([
          { id: TUNNEL, name: nodeTunnelName(NODE) },
          { id: "99999999-2222-4333-8444-555555555555", name: "another" },
        ])
      : ok({ id: TUNNEL }),
  );
  const actions = fenceActions({
    cloudflare: { token: TOKEN, fetcher: api.fetcher },
    contabo: null,
  });
  await actions.deleteTunnel(target);
  const path = `/client/v4/accounts/${ACCOUNT}/cfd_tunnel`;
  expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    `GET ${path}?name=${nodeTunnelName(NODE)}&per_page=100`,
    `DELETE ${path}/${TUNNEL}/connections`,
    `DELETE ${path}/${TUNNEL}`,
  ]);
  expect(api.calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(
    true,
  );
});

it("names the Tunnel like the node's addition, so that enrollment and fencing agree", () => {
  expect(nodeTunnelName(NODE)).toBe(nodeAdditionHostname(NODE));
  expect(nodeTunnelName(NODE)).toBe(`pgcf-node-${"a".repeat(20)}`);
});

it("counts a Tunnel the API lists as deleted as gone, and leaves it alone", async () => {
  const api = cloudflare(() =>
    ok([
      {
        id: TUNNEL,
        name: nodeTunnelName(NODE),
        deleted_at: "2026-10-18T10:00:00Z",
      },
    ]),
  );
  await fenceActions({
    cloudflare: { token: TOKEN, fetcher: api.fetcher },
    contabo: null,
  }).deleteTunnel(target);
  expect(api.calls).toHaveLength(1);
});

it("does not count a node without any Tunnel as fenced: it fails closed", async () => {
  // Nothing under the node's name, or only other Tunnels: the node's Tunnel may be alive.
  for (const listed of [[], [{ id: TUNNEL, name: "another" }]]) {
    const api = cloudflare(() => ok(listed));
    const error = await fenceActions({
      cloudflare: { token: TOKEN, fetcher: api.fetcher },
      contabo: null,
    })
      .deleteTunnel(target)
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("tunnel_unknown");
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
  ];
  for (const api of failing) {
    const error = await fenceActions({
      cloudflare: { token: TOKEN, fetcher: api.fetcher },
      contabo: null,
    })
      .deleteTunnel(target)
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("cloudflare_api_failed");
  }
});

it("does nothing without credentials or an account", async () => {
  await expect(
    fenceActions({ cloudflare: null, contabo: null }).deleteTunnel(target),
  ).rejects.toThrow("fence_unconfigured");
  await expect(
    fenceActions({ cloudflare: { token: TOKEN }, contabo: null }).deleteTunnel({
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
