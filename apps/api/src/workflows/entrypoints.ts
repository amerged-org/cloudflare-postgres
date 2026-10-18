// SPDX-License-Identifier: Apache-2.0
// The Workflow classes the Worker exports. A cold Durable Object evaluates every export of the
// Worker before it answers, so these load the module that holds a Workflow's steps (the
// providers, the node and backup domains) when a run starts, not with the Worker.
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "../env.ts";

export class AddNode extends WorkflowEntrypoint<Env, { operation_id: string }> {
  override async run(
    event: WorkflowEvent<{ operation_id: string }>,
    step: WorkflowStep,
  ) {
    const { AddNode: Implementation } = await import("./add-node.ts");
    return new Implementation(this.ctx, this.env).run(event, step);
  }
}

export class InfrastructureBackup extends WorkflowEntrypoint<
  Env,
  { run_id: string }
> {
  override async run(
    event: WorkflowEvent<{ run_id: string }>,
    step: WorkflowStep,
  ) {
    const { InfrastructureBackup: Implementation } =
      await import("./infrastructure-backup.ts");
    return new Implementation(this.ctx, this.env).run(event, step);
  }
}
