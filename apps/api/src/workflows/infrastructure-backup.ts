// SPDX-License-Identifier: Apache-2.0
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "../env.ts";
import {
  assertBackupRun,
  backupArchive,
  completeBackupArtifact,
  exportControlD1,
  finishInfrastructureBackup,
  initializeInfrastructureBackup,
  prepareInfrastructureBackupInput,
  readInfrastructureBackupRun,
  recordPreparedBackups,
} from "../domain/infrastructure-backups.ts";

const PART_BYTES = 8 * 1024 * 1024;
/** Bounded parts over private container/R2 bindings; no public large-body API or uncertain PUT replay. */
export async function uploadInfrastructureArtifact(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  metadata: Record<string, string>,
) {
  const upload = await bucket.createMultipartUpload(key, {
      customMetadata: metadata,
      httpMetadata: { contentType: "application/octet-stream" },
    }),
    reader = stream.getReader(),
    parts: R2UploadedPart[] = [];
  let buffer = new Uint8Array(PART_BYTES),
    filled = 0,
    part = 1;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      for (let offset = 0; offset < next.value.length;) {
        const count = Math.min(PART_BYTES - filled, next.value.length - offset);
        buffer.set(next.value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === PART_BYTES) {
          parts.push(await upload.uploadPart(part++, buffer));
          buffer = new Uint8Array(PART_BYTES);
          filled = 0;
        }
      }
    }
    if (filled)
      parts.push(await upload.uploadPart(part, buffer.subarray(0, filled)));
    if (!parts.length) throw new Error("infrastructure_backup_stream_empty");
    await upload.complete(parts);
  } catch (error) {
    // A lost completion can already have committed this unique object. Observe before any cleanup.
    const committed = await bucket.head(key);
    if (!committed) {
      await upload.abort().catch(() => {});
      throw error;
    }
  } finally {
    void reader.cancel().catch(() => {});
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
    const id = z.uuid().parse(event.payload.run_id),
      stub = this.env.NODE_BOOTSTRAP.get(
        this.env.NODE_BOOTSTRAP.idFromName(`infrastructure-backup:${id}`),
      );
    try {
      await step.do(
        "capture-encrypted-daily-control-backup",
        { retries: { limit: 0, delay: "1 second" }, timeout: "45 minutes" },
        async () => {
          await initializeInfrastructureBackup(this.env, id);
          const url = await exportControlD1(this.env, id),
            input = await prepareInfrastructureBackupInput(this.env, id, url);
          const prepared = await stub.prepareInfrastructureBackup(input);
          await recordPreparedBackups(this.env, id, prepared);
          // Workflow persists only safe receipts; key, signed URL and client mTLS remain private transient input.
          return { artifacts: prepared.length };
        },
      );
      const { artifacts } = await readInfrastructureBackupRun(this.env.DB, id);
      for (const artifact of artifacts) {
        await step.do(
          `archive-full-readback-${artifact.id}`,
          { retries: { limit: 0, delay: "1 second" }, timeout: "20 minutes" },
          async () => {
            await assertBackupRun(this.env, id);
            const bucket = await backupArchive(this.env, artifact.region_id);
            let object = await bucket.get(artifact.object_key);
            if (!object) {
              await uploadInfrastructureArtifact(
                bucket,
                artifact.object_key,
                await stub.infrastructureBackupStream(id, artifact.id),
                {
                  run_id: id,
                  artifact_id: artifact.id,
                  encrypted_sha256: artifact.encrypted_sha256!,
                  kid: artifact.kid!,
                },
              );
              object = await bucket.get(artifact.object_key);
            }
            if (
              !object ||
              object.size !== artifact.encrypted_bytes ||
              object.customMetadata?.run_id !== id ||
              object.customMetadata.artifact_id !== artifact.id ||
              object.customMetadata.encrypted_sha256 !==
                artifact.encrypted_sha256 ||
              object.customMetadata.kid !== artifact.kid
            )
              throw new Error("infrastructure_backup_r2_identity_changed");
            const verified = await stub.verifyInfrastructureBackup(
              id,
              artifact.id,
              object.body,
            );
            if (
              verified.encrypted_sha256 !== artifact.encrypted_sha256 ||
              verified.plaintext_sha256 !== artifact.plaintext_sha256 ||
              verified.encrypted_bytes !== artifact.encrypted_bytes ||
              verified.plaintext_bytes !== artifact.plaintext_bytes
            )
              throw new Error("infrastructure_backup_receipt_changed");
            await completeBackupArtifact(this.env, id, artifact.id);
            return {
              encrypted_bytes: artifact.encrypted_bytes,
              encrypted_sha256: artifact.encrypted_sha256,
              readback_verified: true,
            };
          },
        );
      }
      await finishInfrastructureBackup(this.env, id);
      return { run_id: id, status: "complete" };
    } catch (error) {
      await finishInfrastructureBackup(this.env, id, error);
      return { run_id: id, status: "failed" };
    } finally {
      await stub.closeInfrastructureBackup(id).catch(() => {});
    }
  }
}
