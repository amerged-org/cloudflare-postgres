// SPDX-License-Identifier: Apache-2.0
// The Worker `pgcf-release-signer-dev`: one route, POST /sign (signer.ts).
import { createSigner, type Env } from "./signer.ts";

const signer = createSigner({
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
});

export default {
  fetch: (request: Request, env: Env): Promise<Response> =>
    signer.fetch(request, env),
};
