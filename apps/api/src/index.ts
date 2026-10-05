// SPDX-License-Identifier: Apache-2.0
import { createApp } from "./app.ts";
import type { Env } from "./env.ts";
import { runCron } from "./cron.ts";
export { DatabaseActor } from "./database-actor.ts";
export { RegionLink } from "./region-link.ts";
export { NodeBootstrap } from "./bootstrap-container.ts";
export { AddNode } from "./workflows/add-node.ts";

const app = createApp();

export default {
  fetch: app.fetch,
  scheduled(_controller, env, context) {
    context.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;
