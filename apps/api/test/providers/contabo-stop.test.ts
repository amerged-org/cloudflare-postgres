// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { ContaboClient } from "../../src/providers/contabo.ts";

const INSTANCE = "202345678";
function client(status: number, receipt: object = {}) {
  const calls: { url: string; method: string }[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.pathname, method: init.method ?? "GET" });
    if (url.hostname === "auth.contabo.com")
      return Response.json({
        access_token: "token",
        token_type: "Bearer",
        expires_in: 60,
      });
    return Response.json(
      {
        data: [
          {
            tenantId: "INT",
            customerId: "100",
            instanceId: Number(INSTANCE),
            action: "stop",
            ...receipt,
          },
        ],
        _links: { self: "/v1/compute/instances/" + INSTANCE },
      },
      { status },
    );
  };
  return {
    calls,
    client: new ContaboClient({
      clientId: "id",
      clientSecret: "secret",
      username: "user",
      password: "password",
      fetcher,
    }),
  };
}

it("stops an instance and returns only the provider's exact acknowledgement", async () => {
  const f = client(201);
  expect(
    await f.client.stop(INSTANCE, { requestId: crypto.randomUUID() }),
  ).toMatchObject({
    kind: "accepted",
    value: { instanceId: INSTANCE, action: "stop" },
  });
  expect(f.calls.at(-1)).toEqual({
    url: `/v1/compute/instances/${INSTANCE}/actions/stop`,
    method: "POST",
  });
});

it("reports a refusal, an unexpected answer and another action's receipt as not accepted", async () => {
  expect(
    await client(404).client.stop(INSTANCE, { requestId: crypto.randomUUID() }),
  ).toMatchObject({ kind: "rejected", code: "provider_rejected" });
  expect(
    await client(200).client.stop(INSTANCE, { requestId: crypto.randomUUID() }),
  ).toMatchObject({ kind: "unknown", code: "unexpected_status" });
  expect(
    await client(201, { action: "restart" }).client.stop(INSTANCE, {
      requestId: crypto.randomUUID(),
    }),
  ).toMatchObject({ kind: "unknown", code: "invalid_response" });
});
