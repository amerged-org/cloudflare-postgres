// SPDX-License-Identifier: Apache-2.0
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { OperationId } from "@pgcf/contracts";
import { FleetPatchStatus } from "@pgcf/contracts/fleet-patches";
import type { Env } from "../env.ts";
import {
  readFleetPatch,
  assertFleetPatchAuthority,
  recordFleetPatchFailure,
  synchronizeFleetPatchRegionMaterial,
  continueFleetPatchRegion,
  restoreFleetPatchPlacements,
  refreshFleetPatchRegionStorage,
} from "../domain/fleet-patches.ts";

import { continueFleetRolloutForRegion } from "../domain/fleet-rollouts.ts";

export class PatchNode extends WorkflowEntrypoint<
  Env,
  { operation_id: string }
> {
  override async run(
    event: WorkflowEvent<{ operation_id: string }>,
    step: WorkflowStep,
  ) {
    const id = OperationId.parse(event.payload.operation_id);
    for (let cycle = 0; cycle < 120; cycle++) {
      const row = await readFleetPatch(this.env, id);
      if (row.stage === "host_ready") {
        const next = await step.do(
          `patch-next-host-${cycle}`,
          { retries: { limit: 2, delay: "15 seconds" }, timeout: "60 seconds" },
          () => continueFleetPatchRegion(this.env, id),
        );
        await step.do(
          `patch-fleet-next-host-${cycle}`,
          { retries: { limit: 2, delay: "15 seconds" }, timeout: "60 seconds" },
          () => continueFleetRolloutForRegion(this.env, row.region_id),
        );
        return {
          operation_id: id,
          stage: row.stage,
          state: row.state,
          regional_activation: "waiting_members",
          finalization_operation_id: next?.operation_id ?? null,
        };
      }
      if (row.stage === "complete") {
        const next = await step.do(
          `patch-regional-finalization-${cycle}`,
          { retries: { limit: 2, delay: "15 seconds" }, timeout: "60 seconds" },
          () => continueFleetPatchRegion(this.env, id),
        );
        if (next)
          return {
            operation_id: id,
            stage: row.stage,
            state: row.state,
            finalization_operation_id: next.operation_id,
          };
        let material: "synchronized" | "waiting_members";
        try {
          material = await step.do(
            `patch-material-readback-${cycle}`,
            {
              retries: { limit: 2, delay: "15 seconds" },
              timeout: "60 seconds",
            },
            () => synchronizeFleetPatchRegionMaterial(this.env, id),
          );
        } catch {
          await step.sleep(`patch-material-retry-${cycle}`, "15 seconds");
          continue;
        }
        if (material === "waiting_members") {
          await step.sleep(`patch-material-wait-${cycle}`, "15 seconds");
          continue;
        }

        const refresh =
          material === "synchronized"
            ? await step.do(
                `patch-host-material-refresh-${cycle}`,
                {
                  retries: { limit: 2, delay: "15 seconds" },
                  timeout: "60 seconds",
                },
                () => continueFleetPatchRegion(this.env, id),
              )
            : null;
        if (!refresh) {
          let storage = false;
          try {
            storage = await step.do(
              `patch-current-storage-${cycle}`,
              {
                retries: { limit: 0, delay: "1 second" },
                timeout: "11 minutes",
              },
              () => refreshFleetPatchRegionStorage(this.env, id),
            );
          } catch {
            /* The existing read lease/custody must resolve; terminal patch rows and counters stay unchanged. */
          }
          if (!storage) {
            await step.sleep(
              `patch-storage-qualification-${cycle}`,
              "15 seconds",
            );
            continue;
          }
        }
        const reopened =
          !refresh && material === "synchronized"
            ? await step.do(`patch-release-placement-${cycle}`, () =>
                restoreFleetPatchPlacements(this.env, id),
              )
            : false;
        if (!refresh && !reopened) {
          await step.sleep(`patch-storage-readback-${cycle}`, "15 seconds");
          continue;
        }
        await step.do(
          `patch-fleet-next-region-${cycle}`,
          { retries: { limit: 2, delay: "15 seconds" }, timeout: "60 seconds" },
          () => continueFleetRolloutForRegion(this.env, row.region_id),
        );
        return {
          operation_id: id,
          stage: row.stage,
          state: row.state,
          regional_material: material,
          finalization_operation_id: refresh?.operation_id ?? null,
          placement_reopened: reopened,
        };
      }
      if (row.state === "halted")
        return { operation_id: id, stage: row.stage, state: row.state };
      await assertFleetPatchAuthority(this.env, row);
      try {
        await step.do(
          `patch-observed-turn-${cycle}`,
          { retries: { limit: 0, delay: "1 second" }, timeout: "11 minutes" },
          async () => {
            // This namespace is separate from the immutable admitted AddNode job.
            return FleetPatchStatus.parse(
              await this.env.NODE_BOOTSTRAP.get(
                this.env.NODE_BOOTSTRAP.idFromName(`fleet-patch:${id}`),
              ).patch(id),
            );
          },
        );
      } catch (error) {
        await recordFleetPatchFailure(
          this.env,
          id,
          error instanceof Error ? error.message : "patch_execution_failed",
        );
        // The next turn reads persisted intent first. Native never reissues an uncertain OS command;
        // transient reads/CAS races can therefore recover without an operator restarting the Workflow.
      }
      await step.sleep(`patch-readback-wait-${cycle}`, "15 seconds");
    }
    return { operation_id: id, state: "awaiting_readback" };
  }
}
