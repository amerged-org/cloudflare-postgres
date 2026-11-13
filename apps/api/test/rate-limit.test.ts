// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { refusal, request } from "./domain/fixtures.ts";

afterEach(() => vi.restoreAllMocks());

const SOURCE = [203, 0, 113, 9].join(".");

it("refuses a source past its budget before the key is read, and admits the next one", async () => {
  const limit = vi.fn(async () => ({ success: false }));
  const bindings = { API_RATE_LIMITER: { limit } } as never;
  // An unknown key would be refused as unauthorized if the key were read first.
  const refused = await request(
    "/v1/projects",
    "unknown-key",
    "GET",
    undefined,
    null,
    { "CF-Connecting-IP": SOURCE },
    bindings,
  );
  expect(await refusal(refused)).toMatchObject({
    status: 429,
    code: "rate_limited",
  });
  expect(limit).toHaveBeenCalledWith({ key: SOURCE });
  const admitted = await request(
    "/v1/projects",
    "unknown-key",
    "GET",
    undefined,
    null,
    { "CF-Connecting-IP": SOURCE },
    { API_RATE_LIMITER: { limit: async () => ({ success: true }) } } as never,
  );
  expect(await refusal(admitted)).toMatchObject({ status: 401 });
});

it("does not count a request without a source address, such as a service binding's", async () => {
  const limit = vi.fn(async () => ({ success: true }));
  await request("/healthz", "unused", "GET", undefined, null, undefined, {
    API_RATE_LIMITER: { limit },
  } as never);
  expect(limit).not.toHaveBeenCalled();
});
