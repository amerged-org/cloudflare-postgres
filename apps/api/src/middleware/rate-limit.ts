// SPDX-License-Identifier: Apache-2.0
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";

/**
 * The API's own limit per source network, counted before any key is read or any body is parsed, so
 * that anonymous callers cannot reach the control plane's database for free. A request without a
 * source address (a service binding's) is not counted here; the Edge limits its own traffic.
 */
export async function limitRequests(
  c: ApiContext,
  next: () => Promise<void>,
): Promise<void> {
  const network = c.req.header("CF-Connecting-IP");
  if (network !== undefined) {
    const outcome = await c.env.API_RATE_LIMITER.limit({ key: network });
    if (!outcome.success)
      throw new ApiError("rate_limited", "Too many requests");
  }
  await next();
}
