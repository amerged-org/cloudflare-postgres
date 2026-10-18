// SPDX-License-Identifier: Apache-2.0
// A local caller; never included in the published Worker. The test harness gives every request it
// sends `CF-Connecting-IP: 127.0.0.1`, so a request that must arrive without a source address, as
// one from another Worker over a service binding does, goes through this Worker, which sends it
// on to the Edge named by `X-Target` without the header.
export default {
  fetch(request: Request, env: Record<string, Fetcher>) {
    const headers = new Headers(request.headers);
    const target = headers.get("X-Target")!;
    headers.delete("X-Target");
    headers.delete("CF-Connecting-IP");
    return env[target]!.fetch(new Request(request, { headers }));
  },
};
