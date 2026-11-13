// SPDX-License-Identifier: Apache-2.0
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";

/**
 * The API's own limit per source network, counted before any key is read or any body is parsed, so
 * that anonymous callers cannot reach the control plane's database for free. A request without a
 * source address (a service binding's) is not counted here; the Edge limits its own traffic. The
 * health check and the node link path are not counted: a node's network is shared by its databases'
 * traffic, and a node must reach its link to be told to stop.
 */
export async function limitRequests(
  c: ApiContext,
  next: () => Promise<void>,
): Promise<void> {
  const network = c.req.header("CF-Connecting-IP");
  if (network !== undefined && !exemptFromLimit(c.req.path)) {
    const limiter = c.env.API_RATE_LIMITER;
    if (limiter === undefined) logUnbound();
    else {
      const outcome = await limiter.limit({ key: network });
      if (!outcome.success)
        throw new ApiError("rate_limited", "Too many requests");
    }
  }
  await next();
}

const exemptFromLimit = (path: string): boolean =>
  path === "/healthz" || path === "/node/v1" || path.startsWith("/node/v1/");

/**
 * A deployment whose namespace is not bound serves without the limit, and says so once per isolate:
 * refusing every request would take the whole API down for the one misconfigured binding.
 */
let unboundLogged = false;
function logUnbound(): void {
  if (unboundLogged) return;
  unboundLogged = true;
  console.error(JSON.stringify({ event: "rate_limiter_unbound" }));
}
