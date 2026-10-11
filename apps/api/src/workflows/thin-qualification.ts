// SPDX-License-Identifier: Apache-2.0
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { OperationId } from "@pgcf/contracts";
import { THIN_QUALIFICATION_STEPS } from "@pgcf/contracts/thin-qualification";
import type { Env } from "../env.ts";
import {
  completeThinQualification,
  expireThinQualificationStep,
  readThinQualificationStep,
} from "../domain/thin-qualification.ts";

/** Bounded turns per step; a reboot or recovering retained databases need several. */
const TURNS: Record<(typeof THIN_QUALIFICATION_STEPS)[number], number> = {
  setup: 8,
  data_full: 12,
  metadata_full: 40,
  noflush_quiescence: 12,
  resume_marker: 12,
  startup_bound: 12,
  trim_delete_recreate: 12,
  retained_thick_preservation: 20,
  cleanup: 20,
};

/** One durable step per gate turn; every turn resumes from the persisted journal, never by replay. */
export class ThinQualification extends WorkflowEntrypoint<
  Env,
  { run_id: string }
> {
  override async run(
    event: WorkflowEvent<{ run_id: string }>,
    step: WorkflowStep,
  ) {
    const id = OperationId.parse(event.payload.run_id),
      stub = this.env.NODE_BOOTSTRAP.get(
        this.env.NODE_BOOTSTRAP.idFromName(`thin-qualification:${id}`),
      );
    for (const name of THIN_QUALIFICATION_STEPS) {
      for (let turn = 0; ; turn++) {
        const state = await step.do(
          `${name}-${turn}`,
          // A retry is one more lease-fenced turn; an uncertain write stays journaled.
          { retries: { limit: 3, delay: "15 seconds" }, timeout: "12 minutes" },
          async () => {
            try {
              await stub.thinQualification(id, name);
            } catch {
              /* The turn outcome is the persisted run state; an uncertain write stays journaled. */
            }
            return await readThinQualificationStep(this.env, id);
          },
        );
        // An unanswered executor may still be inside its lease; no turn or deadline starts before it ends.
        if (state.lease_wait_ms > 0)
          await step.sleep(`${name}-lease-${turn}`, state.lease_wait_ms + 1000);
        if (state.status !== "running" || state.step !== name) break;
        if (turn + 1 >= TURNS[name]) {
          await step.do(`${name}-deadline`, () =>
            expireThinQualificationStep(this.env, id, name),
          );
          break;
        }
        await step.sleep(`${name}-wait-${turn}`, "15 seconds");
      }
    }
    for (let turn = 0; turn < 60; turn++) {
      const done = await step.do(`complete-${turn}`, () =>
        completeThinQualification(this.env, id),
      );
      if (done.status !== "running") return done;
      await step.sleep(`complete-wait-${turn}`, "15 seconds");
    }
    return { run_id: id, status: "running" };
  }
}
