// SPDX-License-Identifier: Apache-2.0
import type { Env } from "./env.ts";
// A Durable Object evaluates this module before its first call, so it imports only what a Durable
// Object class needs: the router, the cron and the Workflows load on first use.
export { ActorWarmer } from "./actor-warmer.ts";
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
    // observable while it drains. It carries the colo the run executed in and the time of each
    // step: a run of 60 to 340 s whose statements each cross an ocean to D1 shows as a far colo.
    context.waitUntil(
      Promise.all([import("./cron.ts"), import("./colo.ts")]).then(
        async ([{ runCron }, { traceColo }]) => {
          const [result, colo] = await Promise.all([
            runCron(env),
            traceColo(1500),
          ]);
          console.log(
            JSON.stringify({ event: "cron_completed", colo, ...result }),
          );
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
