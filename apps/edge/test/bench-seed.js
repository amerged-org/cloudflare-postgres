// SPDX-License-Identifier: Apache-2.0
/* global URL, Response */
// Only the relay benchmark's Edge entries (`bench/rig.ts`): an Edge handler plus one route that
// seeds a running database for the benchmark to connect to.
import { seedFixtureDatabase } from "./actor-entry.js";

export function withSeed(edge) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname !== "/__seed") return edge.fetch(request, env, ctx);
      return new Response(
        await seedFixtureDatabase(env.DB, env.DATABASE_ACTOR, {
          region: "eu-bench",
          gatewayUrl: "http://gateway.invalid/pg",
          gatewayBinding: "GATEWAY",
        }),
      );
    },
  };
}
