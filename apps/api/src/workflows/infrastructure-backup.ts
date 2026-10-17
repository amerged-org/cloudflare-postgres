// SPDX-License-Identifier: Apache-2.0
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "../env.ts";
import {
  captureInfrastructureArtifact,
  exportControlD1,
  finishInfrastructureBackup,
  initializeInfrastructureBackup,
  readInfrastructureBackupRun,
  verifyInfrastructureArtifact,
} from "../domain/infrastructure-backups.ts";

export class InfrastructureBackup extends WorkflowEntrypoint<
  Env,
  { run_id: string }
> {
  override async run(
    event: WorkflowEvent<{ run_id: string }>,
    step: WorkflowStep,
  ) {
    const id = z.uuid().parse(event.payload.run_id);
    try {
      await step.do(
        "capture-encrypted-daily-control-backup",
        { retries: { limit: 0, delay: "1 second" }, timeout: "45 minutes" },
        async () => {
          const artifacts = await initializeInfrastructureBackup(this.env, id);
          // The signed export URL and the key stay inside this step; the Workflow persists only receipts.
          const url = await exportControlD1(this.env, id);
          for (const artifact of artifacts)
            await captureInfrastructureArtifact(this.env, id, artifact.id, url);
          return { artifacts: artifacts.length };
        },
      );
      const { artifacts } = await readInfrastructureBackupRun(this.env.DB, id);
      for (const artifact of artifacts)
        await step.do(
          `archive-full-readback-${artifact.id}`,
          { retries: { limit: 0, delay: "1 second" }, timeout: "20 minutes" },
          () => verifyInfrastructureArtifact(this.env, id, artifact.id),
        );
      await finishInfrastructureBackup(this.env, id);
      return { run_id: id, status: "complete" };
    } catch (error) {
      await finishInfrastructureBackup(this.env, id, error);
      return { run_id: id, status: "failed" };
    }
  }
}
