// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ACCESS_CLIENT_ID_HEADER,
  ACCESS_CLIENT_SECRET_HEADER,
  accessTokenState,
} from "../src/edge-policy.ts";

describe("the Access service token of an Edge", () => {
  it("is presented in the headers that Cloudflare Access reads", () => {
    expect(ACCESS_CLIENT_ID_HEADER).toBe("CF-Access-Client-Id");
    expect(ACCESS_CLIENT_SECRET_HEADER).toBe("CF-Access-Client-Secret");
  });

  it("is sent when both secrets are set and absent when neither is", () => {
    expect(accessTokenState("id", "secret")).toBe("send");
    expect(accessTokenState(undefined, undefined)).toBe("none");
    // An empty binding is not a set one.
    expect(accessTokenState("", "")).toBe("none");
  });

  it("is a configuration error when only one secret is set", () => {
    expect(accessTokenState("id", undefined)).toBe("incomplete");
    expect(accessTokenState(undefined, "secret")).toBe("incomplete");
    expect(accessTokenState("id", "")).toBe("incomplete");
    expect(accessTokenState("", "secret")).toBe("incomplete");
    // A binding that is no secret (a KV or a number) is not a value to present.
    expect(accessTokenState({}, "secret")).toBe("incomplete");
    expect(accessTokenState(1, "secret")).toBe("incomplete");
  });
});
