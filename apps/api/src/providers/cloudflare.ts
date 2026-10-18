// SPDX-License-Identifier: Apache-2.0
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/**
 * A call of the Cloudflare API: the `result` of a successful answer. A refusal is one class,
 * `cloudflare_api_failed`, and carries nothing the API said.
 */
export type CloudflareCall = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<unknown>;

export function cloudflareApi(
  token: string,
  fetcher: typeof fetch = fetch,
): CloudflareCall {
  return async (method, path, body) => {
    const response = await fetcher(`${CLOUDFLARE_API}${path}`, {
      method,
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = (await response.json().catch(() => null)) as {
      success?: boolean;
      result?: unknown;
    } | null;
    if (!response.ok || answer?.success !== true)
      throw new Error("cloudflare_api_failed");
    return answer.result;
  };
}
