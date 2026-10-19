// SPDX-License-Identifier: Apache-2.0
import type { Env } from "./env.ts";
// A Durable Object evaluates this module before its first call, so it imports only what a Durable
// Object class needs: the router, the cron and the Workflows load on first use.
export { CronWatchdog } from "./cron-watchdog.ts";
export { DatabaseActor } from "./database-actor.ts";
export { NodeActor } from "./node-actor.ts";
export { AddNode, InfrastructureBackup } from "./workflows/entrypoints.ts";

let app: Promise<{ fetch: ExportedHandlerFetchHandler<Env> }> | undefined;

export default {
  async fetch(request, env, context) {
    app ??= import("./app.ts").then(({ createApp }) => createApp());
    return (await app).fetch(request, env, context);
  },
  scheduled(_controller, env, context) {
    // One line per invocation makes bounded background work, such as the usage sample pruning,
    // observable while it drains.
    context.waitUntil(
      import("./cron.ts")
        .then(({ runCron }) => runCron(env))
        .then((result) =>
          console.log(JSON.stringify({ event: "cron_completed", ...result })),
        ),
    );
  },
} satisfies ExportedHandler<Env>;
