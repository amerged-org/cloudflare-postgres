// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { NodeCredentials } from "@pgcf/contracts";
import {
  deriveNodeKeyring,
  parseRouteKeyring,
  serializeRouteKeyring,
} from "@pgcf/contracts/route-token";
import { nodeAdditionHostname, nodeShellHostname } from "@pgcf/contracts/nodes";
import { cleanupFixtures, fixture, nodeRequest } from "./fixtures.ts";
import {
  ACCOUNT,
  DOMAIN,
  TOKEN,
  TUNNEL_TOKEN,
  ZONE,
  cloudflare,
} from "./cloudflare-double.ts";

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanupFixtures();
});

const CREDENTIALS = "/node/v1/credentials";
/** A key pair made for these tests; its private half was deleted. */
const SHELL_CA =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDNcY+bgo/xfpIZts7k+ekO/ruRsypcSnZW0qomRI8bp";
const configured = {
  CLOUDFLARE_API_TOKEN: TOKEN,
  NODE_GATEWAY_DOMAIN: DOMAIN,
  NODE_GATEWAY_ZONE_ID: ZONE,
};
const gatewayOf = (node: string) =>
  env.DB.prepare("SELECT gateway_url FROM nodes WHERE id=?")
    .bind(node)
    .first<{ gateway_url: string | null }>()
    .then((row) => row?.gateway_url);
async function accountRegion(region: string) {
  await env.DB.prepare("UPDATE regions SET backup_endpoint_url=? WHERE id=?")
    .bind(`https://${ACCOUNT}.r2.cloudflarestorage.com`, region)
    .run();
}

it("hands a node the route keyring derived for it, the token of its Tunnel and the revision D1 holds", async () => {
  const f = await fixture(0);
  await accountRegion(f.region);
  const api = cloudflare();
  vi.stubGlobal("fetch", api.fetcher);
  const response = await nodeRequest(f, CREDENTIALS, { bindings: configured });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const credentials = NodeCredentials.parse(await response.json());
  expect(credentials.revision).toBe(1);
  expect(credentials.tunnel_token).toBe(TUNNEL_TOKEN);
  // The node holds its own keys and none of the master keys: it verifies its own routes only.
  const master = parseRouteKeyring(env.ROUTE_MASTER_KEYS);
  expect(credentials.route_keyring).toEqual(
    JSON.parse(serializeRouteKeyring(await deriveNodeKeyring(master, f.node))),
  );
  const masterKeys = JSON.parse(serializeRouteKeyring(master)).keys as Record<
    string,
    string
  >;
  for (const [kid, key] of Object.entries(credentials.route_keyring.keys))
    expect(key).not.toBe(masterKeys[kid]);
  // The Tunnel's public hostname is the node's gateway from now on.
  expect(await gatewayOf(f.node)).toBe(
    `https://${nodeAdditionHostname(f.node)}.${DOMAIN}/pg`,
  );
  await env.DB.prepare("UPDATE nodes SET credentials_revision=4 WHERE id=?")
    .bind(f.node)
    .run();
  const again = await nodeRequest(f, CREDENTIALS, { bindings: configured });
  expect(NodeCredentials.parse(await again.json()).revision).toBe(4);
});

it("makes the shell hostname of a node only while NODE_SHELL_HOSTNAME is exactly the string true, and removes it when it is not", async () => {
  const f = await fixture(0);
  await accountRegion(f.region);
  const api = cloudflare();
  vi.stubGlobal("fetch", api.fetcher);
  const hostnames = () => api.records.map((record) => record.name);
  const gateway = `${nodeAdditionHostname(f.node)}.${DOMAIN}`;
  const shell = `${nodeShellHostname(f.node)}.${DOMAIN}`;
  const ask = async (variable: string | undefined) => {
    const response = await nodeRequest(f, CREDENTIALS, {
      bindings: { ...configured, NODE_SHELL_HOSTNAME: variable },
    });
    expect(response.status).toBe(200);
  };
  await ask(undefined);
  expect(hostnames()).toEqual([gateway]);
  await ask("true");
  expect(hostnames()).toEqual([gateway, shell]);
  // Anything but the string true is off, and an existing shell hostname goes away.
  await ask("yes");
  expect(hostnames()).toEqual([gateway]);
  expect(await gatewayOf(f.node)).toBe(`https://${gateway}/pg`);
});

it("carries the CA key of the operator shell only while NODE_SHELL_HOSTNAME is true and the key is exactly one valid ssh-ed25519 line", async () => {
  const f = await fixture(0);
  await accountRegion(f.region);
  vi.stubGlobal("fetch", cloudflare().fetcher);
  const ask = async (
    shell: string | undefined,
    key: string | undefined,
  ): Promise<string | undefined> => {
    const response = await nodeRequest(f, CREDENTIALS, {
      bindings: {
        ...configured,
        NODE_SHELL_HOSTNAME: shell,
        NODE_SSH_USER_CA_PUBLIC_KEY: key,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    NodeCredentials.parse(body);
    return body.shell_ca_public_key as string | undefined;
  };
  expect(await ask("true", SHELL_CA)).toBe(SHELL_CA);
  // The key is not enough, and the hostname is not enough.
  expect(await ask(undefined, SHELL_CA)).toBeUndefined();
  expect(await ask("false", SHELL_CA)).toBeUndefined();
  expect(await ask("yes", SHELL_CA)).toBeUndefined();
  expect(await ask("true", undefined)).toBeUndefined();
  // A variable that is not exactly one valid key gives no key, and so no login.
  for (const broken of [
    "",
    `${SHELL_CA} operator@example.org`,
    `${SHELL_CA}\n`,
    `${SHELL_CA}\n${SHELL_CA}`,
    `command="true" ${SHELL_CA}`,
    SHELL_CA.replace("ssh-ed25519", "ssh-rsa"),
    SHELL_CA.slice(0, -2),
  ])
    expect(await ask("true", broken)).toBeUndefined();
});

const shellStateOf = (node: string) =>
  env.DB.prepare(
    "SELECT credentials_revision r,shell_state s FROM nodes WHERE id=?",
  )
    .bind(node)
    .first<{ r: number; s: string }>();

it("names a revision that matches its own shell state, so that a Worker version the page has not caught up with cannot leave a node with a key D1 says is gone", async () => {
  const f = await fixture(0);
  await accountRegion(f.region);
  vi.stubGlobal("fetch", cloudflare().fetcher);
  const ask = async (bindings: Record<string, string | undefined>) => {
    const response = await nodeRequest(f, CREDENTIALS, {
      bindings: { ...configured, ...bindings },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      revision: number;
      shell_ca_public_key?: string;
    };
  };
  const on = {
    NODE_SHELL_HOSTNAME: "true",
    NODE_SSH_USER_CA_PUBLIC_KEY: SHELL_CA,
  };
  // D1 holds the shell on at revision 5: the page of a Worker version that had the variables set.
  await env.DB.prepare(
    "UPDATE nodes SET credentials_revision=5,shell_state=? WHERE id=?",
  )
    .bind(`on ${SHELL_CA}`, f.node)
    .run();
  // The same version reads the credentials: nothing changes, the key comes with revision 5.
  const same = await ask(on);
  expect(same).toMatchObject({ revision: 5, shell_ca_public_key: SHELL_CA });
  expect(await shellStateOf(f.node)).toEqual({ r: 5, s: `on ${SHELL_CA}` });
  // A version with the shell off reads them before any page of it has been built: no key, and a
  // revision above the one that held it, so that the node removes the file it applied at 5.
  const off = await ask({});
  expect(off.shell_ca_public_key).toBeUndefined();
  expect(off.revision).toBe(6);
  expect(await shellStateOf(f.node)).toEqual({ r: 6, s: "off" });
  // The reverse: D1 says off, and a version with the shell on hands the key out at a new revision.
  const back = await ask(on);
  expect(back).toMatchObject({ revision: 7, shell_ca_public_key: SHELL_CA });
  expect(await shellStateOf(f.node)).toEqual({ r: 7, s: `on ${SHELL_CA}` });
});

it("answers a node whose Tunnel cannot be made with a failure, and writes no gateway", async () => {
  const f = await fixture(0);
  // No Cloudflare configuration at all, then an account the region's endpoint does not name.
  expect((await nodeRequest(f, CREDENTIALS)).status).toBe(500);
  expect(
    (await nodeRequest(f, CREDENTIALS, { bindings: configured })).status,
  ).toBe(500);
  await accountRegion(f.region);
  vi.stubGlobal("fetch", async () =>
    Response.json({ success: false, errors: [] }, { status: 500 }),
  );
  const refused = await nodeRequest(f, CREDENTIALS, { bindings: configured });
  expect(refused.status).toBe(500);
  expect(JSON.stringify(await refused.json())).not.toContain(TOKEN);
  expect(await gatewayOf(f.node)).toBeNull();
});

it("gives nothing to a node declared lost", async () => {
  const f = await fixture(0);
  await accountRegion(f.region);
  const api = cloudflare();
  vi.stubGlobal("fetch", api.fetcher);
  await env.DB.prepare(
    "UPDATE nodes SET lost_at=?,lost_reason='test' WHERE id=?",
  )
    .bind(new Date().toISOString(), f.node)
    .run();
  const response = await nodeRequest(f, CREDENTIALS, { bindings: configured });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "node_fenced" });
  expect(api.calls).toEqual([]);
});
