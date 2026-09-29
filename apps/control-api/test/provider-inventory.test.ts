// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
const path = "/v1/installation/providers/contabo/instances";
const credentials = {
  CONTABO_CLIENT_ID: "fixture-client",
  CONTABO_CLIENT_SECRET: "fixture-client-secret",
  CONTABO_API_USERNAME: "operator@example.test",
  CONTABO_API_PASSWORD: "fixture-api-password",
};
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const request = (query = "", token = "test-installation-token") =>
  new IncomingRequest(`https://control.example.test${path}${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
it("restricts provider inventory to the installation and validates a bounded two-page observed scan without disclosing provider credentials or opaque metadata", async () => {
  const upstream = vi.spyOn(globalThis, "fetch");
  const responses: Response[] = [];
  upstream.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "auth.contabo.com") {
      expect(init?.method).toBe("POST");
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("client_secret")).toBe(credentials.CONTABO_CLIENT_SECRET);
      expect(form.get("password")).toBe(credentials.CONTABO_API_PASSWORD);
      return Response.json({
        access_token: "fixture-access-token",
        token_type: "Bearer",
        expires_in: 300,
      });
    }
    expect(url.origin + url.pathname).toBe(
      "https://api.contabo.com/v1/compute/instances",
    );
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture-access-token",
    );
    expect(new Headers(init?.headers).get("x-request-id")).toMatch(
      /^[a-f0-9-]{36}$/,
    );
    return responses.shift()!;
  });
  const instance = (id: number) => ({
    instanceId: id,
    region: "EU",
    dataCenter: "European Union 2",
    status: "running",
    cpuCores: 4,
    ramMb: "8192",
    diskMb: 163840,
    ipConfig: { v4: { ip: `192.0.2.${id}` } },
    sshKeys: [42],
    defaultUser: "root",
    opaque: { password: "never-expose" },
  });
  const page = (page: number, data: unknown[], total = 2) =>
    Response.json({
      _pagination: { page, size: 1, totalElements: total, totalPages: 2 },
      data,
      _links: { next: "https://untrusted.invalid/credentials" },
    });
  try {
    expect(
      (await worker.fetch(request("", ""), { ...env, ...credentials })).status,
    ).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    expect(
      (
        await worker.fetch(request("", "cporg_not-an-installer"), {
          ...env,
          ...credentials,
        })
      ).status,
    ).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    responses.push(page(1, [instance(1)]), page(2, [instance(2)]));
    const result = await worker.fetch(request(), { ...env, ...credentials });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const body = (await result.json()) as {
      instances: { instanceId: string; ramMb: string }[];
      observation: {
        consistency: string;
        enumerationComplete: boolean;
        evidenceHash: string;
      };
      actionsEnabled: boolean;
      machineIdentityVerified: boolean;
    };
    expect(body.instances.map((i) => i.instanceId)).toEqual(["1", "2"]);
    expect(body.instances[0]!.ramMb).toBe("8192");
    expect(body.observation.consistency).toBe("observed-scan");
    expect(body.observation.enumerationComplete).toBe(true);
    expect(body.observation.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.actionsEnabled).toBe(false);
    expect(body.machineIdentityVerified).toBe(false);
    const serialized = JSON.stringify(body);
    for (const secret of [
      ...Object.values(credentials),
      "fixture-access-token",
      "never-expose",
      "sshKeys",
      "defaultUser",
      "opaque",
    ])
      expect(serialized).not.toContain(secret);
    upstream.mockClear();
    expect(
      (
        await worker.fetch(request("?backend=https://untrusted.invalid"), {
          ...env,
          ...credentials,
        })
      ).status,
    ).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    responses.push(page(1, [instance(1)]), page(2, [instance(1)]));
    const incomplete = await worker.fetch(request(), {
      ...env,
      ...credentials,
    });
    expect(incomplete.status).toBe(503);
    expect(await incomplete.json()).toEqual({
      error: { code: "provider_inventory_unavailable" },
    });
  } finally {
    upstream.mockRestore();
  }
});
