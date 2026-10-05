// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { ContaboClient, ContaboError } from "../../src/providers/contabo.ts";

afterEach(() => vi.restoreAllMocks());
const value = () => crypto.randomUUID();
const id = () => String(crypto.getRandomValues(new Uint32Array(1))[0]! + 1);
function setup(pageSize = 100) {
  const credentials = {
      clientId: value(),
      clientSecret: value(),
      username: value(),
      password: value(),
    },
    token = value(),
    requestId = value();
  const instanceId = id(),
    imageId = value(),
    productId = "fixture-product",
    region = "EU" as const;
  const address = [
    198,
    51,
    100,
    (crypto.getRandomValues(new Uint8Array(1))[0]! % 200) + 1,
  ].join(".");
  const instance = {
    tenantId: "INT",
    customerId: id(),
    instanceId: Number(instanceId),
    name: value(),
    displayName: value(),
    dataCenter: "fixture",
    region,
    regionName: "fixture",
    productId,
    productName: "fixture",
    imageId,
    ipConfig: {
      v4: {
        ip: address,
        netmaskCidr: 24,
        gateway: [198, 51, 100, 1].join("."),
      },
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
    macAddress: ["aa", "bb", "cc", "dd", "ee", "ff"].join(":"),
    vHostId: Number(id()),
    vHostNumber: 1,
    vHostName: "fixture",
    addOns: [],
    productType: "nvme",
    applicationId: "",
  };
  const order = {
    productId,
    region,
    imageId,
    displayName: value(),
    period: 1 as const,
    defaultUser: "admin" as const,
    sshKeys: [id()],
  };
  const receipt = {
    tenantId: instance.tenantId,
    customerId: instance.customerId,
    instanceId: Number(instanceId),
    createdDate: instance.createdDate,
    imageId,
    productId,
    region,
    addOns: [],
    osType: "Linux",
    status: "provisioning",
    sshKeys: [],
  };
  const calls: { url: string; init: RequestInit }[] = [];
  let handler: (
    url: URL,
    init: RequestInit,
  ) => Response | Promise<Response> = () =>
    Response.json({
      data: [instance],
      _links: { self: "/v1/compute/instances/" + instanceId },
    });
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init });
    expect(init.redirect).toBe("error");
    if (url.hostname === "auth.contabo.com") {
      const form = new URLSearchParams(String(init.body));
      expect(form.get("password") === credentials.password).toBe(true);
      expect(form.get("grant_type")).toBe("password");
      return Response.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: 60,
      });
    }
    expect(url.origin).toBe("https://api.contabo.com");
    expect(
      new Headers(init.headers).get("Authorization") === `Bearer ${token}`,
    ).toBe(true);
    return handler(url, init);
  };
  const client = new ContaboClient({ ...credentials, fetcher, pageSize });
  return {
    client,
    fetcher,
    calls,
    credentials,
    token,
    requestId,
    instanceId,
    instance,
    order,
    receipt,
    set: (fn: typeof handler) => {
      handler = fn;
    },
    posts: () =>
      calls.filter(
        (call) =>
          new URL(call.url).hostname === "api.contabo.com" &&
          call.init.method === "POST",
      ),
  };
}
it("caches OAuth only in memory and validates instance identity without exposing provider extras", async () => {
  const f = setup();
  const result = await f.client.getInstance(f.instanceId, {
    requestId: f.requestId,
  });
  expect(result.id).toBe(f.instanceId);
  expect(result.productId).toBe(f.instance.productId);
  await f.client.getInstance(f.instanceId, { requestId: value() });
  expect(
    f.calls.filter((call) => new URL(call.url).hostname === "auth.contabo.com"),
  ).toHaveLength(1);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  await f.client.getInstance(f.instanceId, { requestId: value() });
  expect(
    f.calls.filter((call) => new URL(call.url).hostname === "auth.contabo.com"),
  ).toHaveLength(2);
  f.set(() =>
    Response.json({
      data: [{ ...f.instance, instanceId: Number(id()) }],
      _links: { self: "/v1/compute/instances" },
    }),
  );
  await expect(
    f.client.getInstance(f.instanceId, { requestId: value() }),
  ).rejects.toMatchObject({ code: "invalid_response" });
});
it("rejects unsafe numeric int64 responses and malformed IP configuration instead of rounding or guessing", async () => {
  const f = setup();
  f.set(
    () =>
      new Response(
        JSON.stringify({
          data: [{ ...f.instance, instanceId: 9007199254740992 }],
          _links: { self: "/v1/compute/instances" },
        }),
      ),
  );
  await expect(
    f.client.getInstance(f.instanceId, { requestId: f.requestId }),
  ).rejects.toMatchObject({ code: "invalid_response" });
  f.set(() =>
    Response.json({
      data: [{ ...f.instance, ipConfig: { v4: { ip: "invalid" } } }],
      _links: { self: "/v1/compute/instances" },
    }),
  );
  await expect(
    f.client.getInstance(f.instanceId, { requestId: f.requestId }),
  ).rejects.toMatchObject({ code: "invalid_response" });
});
it("reads all bounded inventory pages and refuses changing or incomplete pagination", async () => {
  const f = setup(1),
    other = { ...f.instance, instanceId: Number(id()) };
  f.set((url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    return Response.json({
      _pagination: { size: 1, totalElements: 2, totalPages: 2, page },
      data: page === 1 ? [f.instance] : [other],
      _links: {
        self: "/v1/compute/instances",
        first: "/v1/compute/instances?page=1",
        last: "/v1/compute/instances?page=2",
      },
    });
  });
  expect(
    (await f.client.listInstances({}, { requestId: f.requestId })).map(
      (instance) => instance.id,
    ),
  ).toEqual([f.instanceId, String(other.instanceId)]);
  f.set(() =>
    Response.json({
      _pagination: { size: 100, totalElements: 2, totalPages: 1, page: 1 },
      data: [f.instance],
      _links: {
        self: "/v1/compute/instances",
        first: "/v1/compute/instances",
        last: "/v1/compute/instances",
      },
    }),
  );
  await expect(
    f.client.listInstances({}, { requestId: f.requestId }),
  ).rejects.toMatchObject({ code: "pagination_incomplete" });
});
it("provider pagination links cannot send authentication to another origin or path", async () => {
  const f = setup();
  f.set(() =>
    Response.json({
      _pagination: { size: 100, totalElements: 1, totalPages: 1, page: 1 },
      data: [f.instance],
      _links: {
        self: "/v1/compute/instances",
        first: "https://contabo.com/",
        last: "/v1/compute/instances",
      },
    }),
  );
  await expect(
    f.client.listInstances({}, { requestId: f.requestId }),
  ).rejects.toMatchObject({ code: "invalid_response" });
  expect(
    f.calls.every((call) =>
      ["api.contabo.com", "auth.contabo.com"].includes(
        new URL(call.url).hostname,
      ),
    ),
  ).toBe(true);
});
it("one validated order sends explicit fields and preserves the saved tracing ID exactly", async () => {
  const f = setup();
  f.set(() =>
    Response.json(
      {
        data: [f.receipt],
        _links: { self: "/v1/compute/instances/" + f.instanceId },
      },
      { status: 201 },
    ),
  );
  const result = await f.client.order(f.order, { requestId: f.requestId });
  expect(result).toMatchObject({
    kind: "accepted",
    dispatched: true,
    requestId: f.requestId,
    value: { instanceId: f.instanceId },
  });
  expect(f.posts()).toHaveLength(1);
  const call = f.posts()[0]!;
  expect(new Headers(call.init.headers).get("x-request-id")).toBe(f.requestId);
  expect(JSON.parse(String(call.init.body))).toEqual({
    ...f.order,
    sshKeys: f.order.sshKeys.map(Number),
  });
});
it("lost order responses and ambiguous statuses perform exactly one POST and never retry", async () => {
  const f = setup();
  f.set(() => {
    throw new Error(f.credentials.password);
  });
  expect(
    await f.client.order(f.order, { requestId: f.requestId }),
  ).toMatchObject({
    kind: "unknown",
    dispatched: true,
    requestId: f.requestId,
  });
  expect(f.posts()).toHaveLength(1);
  const g = setup();
  g.set(() => new Response(g.credentials.clientSecret, { status: 503 }));
  expect(
    await g.client.order(g.order, { requestId: g.requestId }),
  ).toMatchObject({ kind: "unknown", dispatched: true, status: 503 });
  expect(g.posts()).toHaveLength(1);
});
it("unvalidated success and unexpected receipt identity remain unknown", async () => {
  const f = setup();
  f.set(() =>
    Response.json(
      {
        data: [{ ...f.receipt, productId: "different" }],
        _links: { self: "/v1/compute/instances" },
      },
      { status: 201 },
    ),
  );
  expect(
    await f.client.order(f.order, { requestId: f.requestId }),
  ).toMatchObject({
    kind: "unknown",
    code: "invalid_response",
    dispatched: true,
  });
  const g = setup();
  g.set(() => new Response("", { status: 200 }));
  expect(
    await g.client.order(g.order, { requestId: g.requestId }),
  ).toMatchObject({ kind: "unknown", dispatched: true });
});
it("HTTP admission rejection remains dispatched and carries no resource-absence claim or raw body", async () => {
  const f = setup();
  f.set(() => new Response(f.credentials.password, { status: 422 }));
  const result = await f.client.order(f.order, { requestId: f.requestId });
  expect(result).toEqual({
    kind: "rejected",
    code: "provider_rejected",
    status: 422,
    dispatched: true,
    requestId: f.requestId,
  });
  expect(JSON.stringify(result).includes(f.credentials.password)).toBe(false);
});
it("OAuth failures distinguish not-dispatched and never contact the order endpoint", async () => {
  const f = setup();
  const client = new ContaboClient({
    ...f.credentials,
    fetcher: async () => new Response(f.token, { status: 401 }),
  });
  expect(await client.order(f.order, { requestId: f.requestId })).toMatchObject(
    {
      kind: "rejected",
      code: "not_dispatched",
      dispatched: false,
      status: 401,
    },
  );
});
it("unsupported contract period and missing explicit order choices fail before network", async () => {
  const f = setup();
  await expect(
    f.client.order({ ...f.order, period: 6 } as never, {
      requestId: f.requestId,
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    f.client.order({ ...f.order, imageId: undefined } as never, {
      requestId: f.requestId,
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(f.calls).toHaveLength(0);
});
it("rescue and restart return only exact action acknowledgements, never boot readiness", async () => {
  const f = setup();
  f.set((url) =>
    Response.json(
      {
        data: [
          {
            tenantId: "INT",
            customerId: id(),
            instanceId: Number(f.instanceId),
            action: url.pathname.endsWith("rescue") ? "rescue" : "restart",
          },
        ],
        _links: { self: "/v1/compute/instances/" + f.instanceId },
      },
      { status: 201 },
    ),
  );
  const rescue = await f.client.rescue(
    f.instanceId,
    { sshKeys: [id()] },
    { requestId: f.requestId },
  );
  expect(rescue).toMatchObject({
    kind: "accepted",
    value: { instanceId: f.instanceId, action: "rescue" },
  });
  expect(rescue).not.toHaveProperty("ready");
  expect(
    await f.client.restart(f.instanceId, { requestId: value() }),
  ).toMatchObject({ kind: "accepted", value: { action: "restart" } });
  expect(f.posts()).toHaveLength(2);
});
it("request-correlated audits preserve exact identity without exposing arbitrary changes or usernames", async () => {
  const f = setup();
  f.set(() =>
    Response.json({
      _pagination: { size: 100, totalElements: 1, totalPages: 1, page: 1 },
      data: [
        {
          id: Number(id()),
          action: "CREATED",
          timestamp: new Date().toISOString(),
          tenantId: "INT",
          customerId: id(),
          changedBy: value(),
          username: f.credentials.username,
          requestId: f.requestId,
          traceId: value(),
          instanceId: Number(f.instanceId),
          changes: { secret: f.credentials.password },
        },
      ],
      _links: {
        self: "/v1/compute/instances/audits",
        first: "/v1/compute/instances/audits",
        last: "/v1/compute/instances/audits",
      },
    }),
  );
  const result = await f.client.instanceAudits(
    { requestId: f.requestId },
    { requestId: value() },
  );
  expect(result[0]).toMatchObject({
    instanceId: f.instanceId,
    requestId: f.requestId,
  });
  expect(JSON.stringify(result).includes(f.credentials.password)).toBe(false);
});
it("body and absolute deadline bounds fail closed without disclosing canaries", async () => {
  const f = setup();
  f.set(() => new Response(f.credentials.password.repeat(100000)));
  try {
    await f.client.getInstance(f.instanceId, { requestId: f.requestId });
    throw Error("expected_refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(ContaboError);
    expect(String(error).includes(f.credentials.password)).toBe(false);
  }
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.client.getInstance(f.instanceId, {
      requestId: value(),
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "aborted" });
  const count = f.calls.length;
  await expect(
    f.client.getInstance(f.instanceId, {
      requestId: value(),
      deadline: Date.now() - 1,
    }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(f.calls).toHaveLength(count);
});

function firewall(
  f: ReturnType<typeof setup>,
  firewallId: string,
  rules: unknown[],
) {
  return {
    tenantId: "INT",
    customerId: id(),
    firewallId,
    name: value(),
    description: "fixture",
    status: "active",
    instanceStatus: [
      { instanceId: Number(f.instanceId), status: "processing" },
    ],
    instances: [
      {
        instanceId: Number(f.instanceId),
        displayName: f.instance.displayName,
        name: f.instance.name,
        productId: f.instance.productId,
        ipConfig: f.instance.ipConfig,
        regionSlug: f.instance.region,
        regionName: "fixture",
        dataCenterSlug: "fixture",
        dataCenterName: "fixture",
      },
    ],
    rules: { inbound: rules },
    createdDate: new Date().toISOString(),
    updatedDate: new Date().toISOString(),
  };
}
it("firewall reads, explicit rules and assignment receipts preserve identity without claiming deployment ready", async () => {
  const f = setup(),
    firewallId = value(),
    rule = {
      protocol: "tcp" as const,
      destPorts: [String(22)],
      srcCidr: { ipv4: [f.instance.ipConfig.v4.ip + "/32"] },
      action: "accept" as const,
      status: "active" as const,
      displayName: value(),
    };
  f.set((url) =>
    url.pathname.includes("/instances/")
      ? Response.json({ _links: { self: url.pathname } }, { status: 201 })
      : Response.json({
          data: [firewall(f, firewallId, [rule])],
          _links: { self: `/v1/firewalls/${firewallId}` },
        }),
  );
  expect(
    (await f.client.getFirewall(firewallId, { requestId: f.requestId }))
      .firewallId,
  ).toBe(firewallId);
  expect(
    await f.client.putFirewallRules(
      firewallId,
      { rules: { inbound: [rule] } },
      { requestId: value() },
    ),
  ).toMatchObject({
    kind: "accepted",
    value: { firewallId, instanceStatus: [{ status: "processing" }] },
  });
  expect(
    await f.client.assignFirewall(firewallId, f.instanceId, {
      requestId: value(),
    }),
  ).toMatchObject({
    kind: "accepted",
    value: { firewallId, instanceId: f.instanceId },
  });
  expect(f.posts()).toHaveLength(1);
});
it("firewall wildcard sources, implicit protocols and wrong receipt identity cannot be treated as successful policy", async () => {
  const f = setup(),
    firewallId = value(),
    rule = {
      protocol: "tcp" as const,
      destPorts: [String(22)],
      srcCidr: { ipv4: [f.instance.ipConfig.v4.ip + "/32"] },
      action: "accept" as const,
      status: "active" as const,
      displayName: value(),
    };
  await expect(
    f.client.putFirewallRules(
      firewallId,
      {
        rules: {
          inbound: [
            { ...rule, srcCidr: { ipv4: [f.instance.ipConfig.v4.ip + "/0"] } },
          ],
        },
      },
      { requestId: f.requestId },
    ),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    f.client.putFirewallRules(
      firewallId,
      { rules: { inbound: [{ ...rule, protocol: "" } as never] } },
      { requestId: f.requestId },
    ),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(f.calls).toHaveLength(0);
  f.set(() =>
    Response.json({
      data: [firewall(f, value(), [rule])],
      _links: { self: `/v1/firewalls/${firewallId}` },
    }),
  );
  expect(
    await f.client.putFirewallRules(
      firewallId,
      { rules: { inbound: [rule] } },
      { requestId: f.requestId },
    ),
  ).toMatchObject({
    kind: "unknown",
    code: "invalid_response",
    dispatched: true,
  });
});
it("redirects and cancellation after dispatch are unknown, with exactly one mutation attempt", async () => {
  const f = setup();
  f.set(
    () =>
      new Response("", {
        status: 302,
        headers: { Location: "https://contabo.com/" },
      }),
  );
  expect(
    await f.client.order(f.order, { requestId: f.requestId }),
  ).toMatchObject({ kind: "unknown", dispatched: true, status: 302 });
  expect(f.posts()).toHaveLength(1);
  const g = setup(),
    controller = new AbortController();
  g.set(() => {
    controller.abort();
    return new Promise<Response>(() => {});
  });
  expect(
    await g.client.order(g.order, {
      requestId: g.requestId,
      signal: controller.signal,
    }),
  ).toMatchObject({ kind: "unknown", code: "aborted", dispatched: true });
  expect(g.posts()).toHaveLength(1);
});
it("several audit events for one instance remain distinct by audit identity", async () => {
  const f = setup(),
    audit = {
      id: Number(id()),
      action: "CREATED",
      timestamp: new Date().toISOString(),
      tenantId: "INT",
      customerId: id(),
      changedBy: value(),
      username: value(),
      requestId: f.requestId,
      traceId: value(),
      instanceId: Number(f.instanceId),
    };
  f.set(() =>
    Response.json({
      _pagination: { size: 100, totalElements: 2, totalPages: 1, page: 1 },
      data: [audit, { ...audit, id: Number(id()), action: "UPDATED" }],
      _links: {
        self: "/v1/compute/instances/audits",
        first: "/v1/compute/instances/audits",
        last: "/v1/compute/instances/audits",
      },
    }),
  );
  expect(
    await f.client.instanceAudits(
      { requestId: f.requestId },
      { requestId: value() },
    ),
  ).toHaveLength(2);
});
it("unsafe fractional int64 tokens cannot round into a different valid instance identity", async () => {
  const f = setup(),
    candidate = String(Number.MAX_SAFE_INTEGER - 1);
  const body = JSON.stringify({
    data: [{ ...f.instance, instanceId: Number(candidate) }],
    _links: { self: "/v1/compute/instances/" + candidate },
  }).replace(`"instanceId":${candidate}`, `"instanceId":${candidate}.5`);
  f.set(() => new Response(body));
  await expect(
    f.client.getInstance(candidate, { requestId: f.requestId }),
  ).rejects.toMatchObject({ code: "invalid_response" });
});
it("lossless string identities are preserved and secret-ID request references are encoded as exact JSON integers", async () => {
  const f = setup(),
    large = (BigInt(Number.MAX_SAFE_INTEGER) + 2n).toString();
  f.set(() =>
    Response.json({
      data: [{ ...f.instance, instanceId: large }],
      _links: { self: "/v1/compute/instances/" + large },
    }),
  );
  expect(
    (await f.client.getInstance(large, { requestId: f.requestId })).id,
  ).toBe(large);
  f.set(() =>
    Response.json(
      {
        data: [f.receipt],
        _links: { self: "/v1/compute/instances/" + f.instanceId },
      },
      { status: 201 },
    ),
  );
  await f.client.order(
    { ...f.order, rootPassword: large },
    { requestId: value() },
  );
  expect(
    String(f.posts()[0]!.init.body).includes(`"rootPassword":${large}`),
  ).toBe(true);
});
it("serializing the client never exposes cached credentials or OAuth tokens", async () => {
  const f = setup();
  await f.client.getInstance(f.instanceId, { requestId: f.requestId });
  const serialized = JSON.stringify(f.client);
  expect(
    Object.values(f.credentials).some((secret) => serialized.includes(secret)),
  ).toBe(false);
  expect(serialized.includes(f.token)).toBe(false);
});
it("firewall address families must match their explicit source fields", async () => {
  const f = setup();
  await expect(
    f.client.putFirewallRules(
      value(),
      {
        rules: {
          inbound: [
            {
              protocol: "tcp",
              destPorts: [String(22)],
              srcCidr: { ipv4: [["2001", "db8", "", "1"].join(":") + "/128"] },
              action: "accept",
              status: "active",
              displayName: value(),
            },
          ],
        },
      },
      { requestId: f.requestId },
    ),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(f.calls).toHaveLength(0);
});
it("action audit records can report the documented unassigned instance sentinel without inventing an instance", async () => {
  const f = setup();
  f.set((url) => {
    expect(url.pathname).toBe("/v1/compute/instances/actions/audits");
    expect(url.searchParams.get("requestId")).toBe(f.requestId);
    return Response.json({
      _pagination: { size: 100, totalElements: 1, totalPages: 1, page: 1 },
      data: [
        {
          id: Number(id()),
          action: "CREATED",
          timestamp: new Date().toISOString(),
          tenantId: "INT",
          customerId: id(),
          changedBy: value(),
          username: value(),
          requestId: f.requestId,
          traceId: value(),
          instanceId: 0,
        },
      ],
      _links: { self: url.pathname, first: url.pathname, last: url.pathname },
    });
  });
  expect(
    await f.client.actionAudits(
      { requestId: f.requestId },
      { requestId: value() },
    ),
  ).toMatchObject([{ instanceId: "0" }]);
});
it("an order cannot fall back to provider-generated access credentials", async () => {
  const f = setup(),
    { sshKeys, ...order } = f.order;
  expect(sshKeys.length).toBeGreaterThan(0);
  await expect(
    f.client.order(order, { requestId: f.requestId }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(f.calls).toHaveLength(0);
});
it("inventory memory is bounded across individually valid pages without returning a partial list", async () => {
  const f = setup(1),
    other = { ...f.instance, instanceId: Number(id()) };
  const bodies = [f.instance, other].map((instance, index) =>
    JSON.stringify({
      data: [instance],
      _pagination: {
        size: 1,
        totalElements: 2,
        totalPages: 2,
        page: index + 1,
      },
      _links: {
        self: "/v1/compute/instances",
        first: "/v1/compute/instances?page=1",
        last: "/v1/compute/instances?page=2",
      },
    }),
  );
  const client = new ContaboClient({
    ...f.credentials,
    fetcher: f.fetcher,
    pageSize: 1,
    maxBodyBytes: Math.max(
      ...bodies.map((body) => new TextEncoder().encode(body).length),
    ),
  });
  f.set(
    (url) =>
      new Response(bodies[Number(url.searchParams.get("page") ?? 1) - 1]),
  );
  await expect(
    client.listInstances({}, { requestId: f.requestId }),
  ).rejects.toMatchObject({ code: "pagination_incomplete" });
});
it("instance detail exposes actual MAC and disk/network metadata without filling absent IPv6", async () => {
  const f = setup();
  expect(
    await f.client.getInstance(f.instanceId, { requestId: f.requestId }),
  ).toMatchObject({
    macAddress: f.instance.macAddress,
    diskMb: f.instance.diskMb,
    ipConfig: { v4: f.instance.ipConfig.v4 },
  });
  f.set(() =>
    Response.json({
      data: [{ ...f.instance, ipConfig: { v4: f.instance.ipConfig.v4 } }],
      _links: { self: "/v1/compute/instances/" + f.instanceId },
    }),
  );
  const instance = await f.client.getInstance(f.instanceId, {
    requestId: value(),
  });
  expect(instance.ipConfig.v4).toEqual(f.instance.ipConfig.v4);
  expect(instance.ipConfig).not.toHaveProperty("v6");
});
