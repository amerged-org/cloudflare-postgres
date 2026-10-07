// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { contaboClient } from "../../src/domain/bootstrap-relay.ts";
import type { Env } from "../../src/env.ts";

afterEach(() => vi.restoreAllMocks());
function credentials() {
  return {
    CONTABO_CLIENT_ID: crypto.randomUUID(),
    CONTABO_CLIENT_SECRET: crypto.randomUUID(),
    CONTABO_USERNAME: crypto.randomUUID(),
    CONTABO_PASSWORD: crypto.randomUUID(),
  } as Env;
}
function instance(id: string) {
  return {
    tenantId: "INT",
    customerId: "1",
    instanceId: Number(id),
    name: "fixture",
    displayName: "fixture",
    dataCenter: "fixture",
    region: "EU",
    regionName: "fixture",
    productId: "fixture",
    productName: "fixture",
    imageId: crypto.randomUUID(),
    ipConfig: {
      v4: { ip: "198.51.100.2", netmaskCidr: 24, gateway: "198.51.100.1" },
      v6: { ip: "", netmaskCidr: 0, gateway: "" },
    },
    ramMb: 8192,
    cpuCores: 4,
    diskMb: 150000,
    osType: "Linux",
    sshKeys: [],
    createdDate: new Date().toISOString(),
    cancelDate: "",
    status: "running",
    additionalIps: [],
    macAddress: "aa:bb:cc:dd:ee:ff",
    vHostId: 1,
    vHostNumber: 1,
    vHostName: "fixture",
    addOns: [],
    productType: "nvme",
    applicationId: "",
  };
}
function provider(beforeOAuth?: () => Promise<void>) {
  let oauth = 0,
    gets = 0,
    unauthorized = false;
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "auth.contabo.com") {
        oauth++;
        await beforeOAuth?.();
        return Response.json({
          access_token: crypto.randomUUID(),
          token_type: "Bearer",
          expires_in: 60,
        });
      }
      expect(url.origin).toBe("https://api.contabo.com");
      expect(init?.method).toBe("GET");
      gets++;
      if (unauthorized) return new Response(null, { status: 401 });
      const id = url.pathname.split("/").at(-1)!;
      return Response.json({
        data: [instance(id)],
        _links: { self: url.pathname },
      });
    });
  return {
    fetcher,
    counts: () => ({ oauth, gets }),
    unauthorized: (value: boolean) => {
      unauthorized = value;
    },
  };
}

it("coalesces concurrent factory authentication while every independent read stays fresh", async () => {
  const env = credentials(),
    p = provider();
  const [first, second] = await Promise.all([
    contaboClient(env).getInstance("41", { requestId: crypto.randomUUID() }),
    contaboClient({ ...env }).getInstance("42", {
      requestId: crypto.randomUUID(),
    }),
  ]);
  expect([first.id, second.id]).toEqual(["41", "42"]);
  expect(p.counts()).toEqual({ oauth: 1, gets: 2 });
  await contaboClient(env).getInstance("41", {
    requestId: crypto.randomUUID(),
  });
  expect(p.counts()).toEqual({ oauth: 1, gets: 3 });
});

it("replaces the single authentication slot when credentials change", async () => {
  const env = credentials(),
    p = provider(),
    first = contaboClient(env),
    rotated = { ...env, CONTABO_PASSWORD: crypto.randomUUID() };
  await first.getInstance("41", { requestId: crypto.randomUUID() });
  const replacement = contaboClient(rotated);
  expect(replacement).not.toBe(first);
  await replacement.getInstance("41", { requestId: crypto.randomUUID() });
  expect(contaboClient(env)).not.toBe(first);
  await contaboClient(env).getInstance("41", {
    requestId: crypto.randomUUID(),
  });
  expect(p.counts()).toEqual({ oauth: 3, gets: 3 });
});

it("retains early token expiry and refuses a 401 without replaying its GET", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const env = credentials(),
    p = provider(),
    client = contaboClient(env);
  await client.getInstance("41", { requestId: crypto.randomUUID() });
  now += 54_999;
  await contaboClient(env).getInstance("41", {
    requestId: crypto.randomUUID(),
  });
  expect(p.counts()).toEqual({ oauth: 1, gets: 2 });
  now++;
  await contaboClient(env).getInstance("41", {
    requestId: crypto.randomUUID(),
  });
  expect(p.counts()).toEqual({ oauth: 2, gets: 3 });
  p.unauthorized(true);
  await expect(
    client.getInstance("41", { requestId: crypto.randomUUID() }),
  ).rejects.toMatchObject({ code: "unexpected_status", status: 401 });
  expect(p.counts()).toEqual({ oauth: 2, gets: 4 });
  p.unauthorized(false);
  await client.getInstance("41", { requestId: crypto.randomUUID() });
  expect(p.counts()).toEqual({ oauth: 3, gets: 5 });
});

it("a cancelled caller cannot cancel another caller's shared authentication", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
      release = resolve;
    }),
    env = credentials(),
    p = provider(() => waiting),
    abort = new AbortController(),
    first = contaboClient(env).getInstance("41", {
      requestId: crypto.randomUUID(),
      signal: abort.signal,
    }),
    firstRejected = expect(first).rejects.toMatchObject({ code: "aborted" }),
    second = contaboClient({ ...env }).getInstance("42", {
      requestId: crypto.randomUUID(),
    });
  await vi.waitFor(() => expect(p.counts().oauth).toBe(1));
  abort.abort();
  await firstRejected;
  release();
  expect((await second).id).toBe("42");
  expect(p.counts()).toEqual({ oauth: 1, gets: 1 });
});
