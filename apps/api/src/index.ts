// SPDX-License-Identifier: Apache-2.0
import type { Env } from "./env.ts";
import {
  controlMaintenance,
  controlProducerPaused,
  maintenanceResponse,
} from "./control-maintenance.ts";
// A Durable Object evaluates this module before its first call, so it imports only what a Durable
// Object class needs: the router, the cron and the Workflows load on first use.
export { ActorWarmer } from "./actor-warmer.ts";
export { CronWatchdog } from "./cron-watchdog.ts";
export { DatabaseActor } from "./database-actor.ts";
export { NodeActor } from "./node-actor.ts";
export { TriggerActor } from "./trigger-actor.ts";
export { AddNode, InfrastructureBackup } from "./workflows/entrypoints.ts";

let app: Promise<{ fetch: ExportedHandlerFetchHandler<Env> }> | undefined;

export default {
  async fetch(request, env, context) {
    if (controlMaintenance(env)) return maintenanceResponse(request, env);
    app ??= import("./app.ts").then(({ createApp }) => createApp());
    return (await app).fetch(request, env, context);
  },
  scheduled(_controller, env, context) {
    if (controlProducerPaused(env, "scheduled")) return;
    // One line per invocation makes bounded background work, such as the usage sample pruning,
    // observable while it drains. It carries the time of each step (`step_ms`), not the colo of the
    // run, which would take a trace request in every run: Cloudflare's invocation analytics name a
    // colo and a start for most invocations, not all (they are sampled and omit some), so they are
    // read with `sampleInterval` and checked against these lines
    // (docs/operations/infrastructure-backups.md).
    context.waitUntil(
      import("./cron.ts")
        .then(({ runCron }) => runCron(env))
        .then((result) =>
          console.log(JSON.stringify({ event: "cron_completed", ...result })),
        ),
    );
  },
} satisfies ExportedHandler<Env>;
