// SPDX-License-Identifier: Apache-2.0
import { createApp } from "./app.ts";
import type { Env } from "./env.ts";
import { runCron } from "./cron.ts";
export { DatabaseActor } from "./database-actor.ts";
export { RegionLink } from "./region-link.ts";
export { NodeBootstrap } from "./bootstrap-container.ts";
export { AddNode } from "./workflows/add-node.ts";
export { InfrastructureBackup } from "./workflows/infrastructure-backup.ts";
export { PatchNode } from "./workflows/patch-node.ts";
export { ThinQualification } from "./workflows/thin-qualification.ts";

const app = createApp();

export default {
  fetch: app.fetch,
  scheduled(_controller, env, context) {
    // One line per invocation makes bounded background work, such as the usage sample pruning,
    // observable while it drains.
    context.waitUntil(
      runCron(env).then((result) =>
        console.log(JSON.stringify({ event: "cron_completed", ...result })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
