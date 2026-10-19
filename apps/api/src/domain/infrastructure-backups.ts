// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { base64urlToBytes, bytesToBase64url } from "@pgcf/contracts";
import {
  InfrastructureBackupConfig,
  InfrastructureBackupConfigInput,
  InfrastructureBackupArtifactIdentity,
  InfrastructureBackupArtifactStatus,
  InfrastructureBackupPreparedArtifact,
  InfrastructureBackupRunStatus,
  InfrastructureBackupHealth,
} from "@pgcf/contracts/infrastructure-backups";
import { ApiError } from "../api-error.ts";
import type { Env } from "../env.ts";
import { regionArchive } from "./archive-bindings.ts";
import {
  encryptSource,
  measureSource,
  verifyEnvelope,
} from "./infrastructure-backup-envelope.ts";

export const INFRASTRUCTURE_BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const MAX_RUN_MS = 2 * 60 * 60 * 1000;
// The attempts of a day are spread over several hours: one disturbance of half an hour, such as
// a fleet rollout, must not use all three.
const RETRY_DELAY_MS = 90 * 60 * 1000;
const MAX_DAILY_ATTEMPTS = 3;
type ConfigRow = {
  enabled: number;
  d1_account_id: string | null;
  d1_database_id: string | null;
  d1_region_id: string | null;
  notification_recipient: string | null;
  notification_sender: string | null;
  revision: number;
  enabled_at: string | null;
  updated_at: string | null;
};
type RunRow = {
  id: string;
  day: string;
  attempt: number;
  config_revision: number;
  status: string;
  created_at: string;
  completed_at: string | null;
  expires_at: string;
  error_code: string | null;
};
export type ArtifactRow = z.infer<
  typeof InfrastructureBackupArtifactIdentity
> & {
  run_id: string;
  status: string;
  completed_at: string | null;
  error_code: string | null;
  object_key: string;
  kid: string | null;
  plaintext_sha256: string | null;
  plaintext_bytes: number | null;
  encrypted_sha256: string | null;
  encrypted_bytes: number | null;
};
function pickBackupIdentity(
  value: z.infer<typeof InfrastructureBackupArtifactIdentity>,
) {
  return InfrastructureBackupArtifactIdentity.parse({
    id: value.id,
    kind: value.kind,
    day: value.day,
    region_id: value.region_id,
    source_id: value.source_id,
  });
}
function configView(row: ConfigRow | null | undefined) {
  if (!row) throw new Error("infrastructure_backup_config_missing");
  return InfrastructureBackupConfig.parse({
    enabled: row.enabled === 1,
    d1_account_id: row.d1_account_id,
    d1_database_id: row.d1_database_id,
    d1_region_id: row.d1_region_id,
    notification_recipient: row.notification_recipient,
    notification_sender: row.notification_sender,
    revision: row.revision,
    enabled_at: row.enabled_at,
    updated_at: row.updated_at,
  });
}
export async function readInfrastructureBackupConfig(db: D1Database) {
  return configView(
    await db
      .prepare("SELECT * FROM infrastructure_backup_config WHERE singleton=1")
      .first<ConfigRow>(),
  );
}
export async function configureInfrastructureBackups(
  env: Env,
  value: unknown,
  now = Date.now(),
) {
  const config = InfrastructureBackupConfigInput.parse(value);
  if (
    config.enabled &&
    (!env.INFRASTRUCTURE_BACKUP || !env.INFRASTRUCTURE_BACKUP_CF_TOKEN)
  )
    throw new ApiError(
      "conflict",
      "Daily backup Workflow and D1 export secret must be installed before enabling",
    );
  if (config.d1_region_id) await backupArchive(env, config.d1_region_id);
  const at = new Date(now).toISOString();
  await env.DB.batch([
    // Notification changes keep only already-valid captures under the unchanged destination.
    // A revoked, expired or terminal run can never acquire the new revision here.
    env.DB.prepare(
      `UPDATE infrastructure_backup_runs SET config_revision=config_revision+1
      WHERE config_revision=(SELECT revision FROM infrastructure_backup_config WHERE singleton=1)
      AND status IN('pending','running') AND julianday(expires_at)>julianday(?)
      AND EXISTS(SELECT 1 FROM infrastructure_backup_config WHERE singleton=1 AND enabled=1
        AND enabled=? AND d1_account_id IS ? AND d1_database_id IS ? AND d1_region_id IS ?)`,
    ).bind(
      at,
      config.enabled ? 1 : 0,
      config.d1_account_id,
      config.d1_database_id,
      config.d1_region_id,
    ),
    env.DB.prepare(
      `UPDATE infrastructure_backup_config SET enabled=?,d1_account_id=?,d1_database_id=?,d1_region_id=?,
      notification_recipient=?,notification_sender=?,revision=revision+1,enabled_at=CASE WHEN ?=1 AND enabled=0 THEN ? WHEN ?=0 THEN NULL ELSE enabled_at END,updated_at=? WHERE singleton=1`,
    ).bind(
      config.enabled ? 1 : 0,
      config.d1_account_id,
      config.d1_database_id,
      config.d1_region_id,
      config.notification_recipient,
      config.notification_sender,
      config.enabled ? 1 : 0,
      at,
      config.enabled ? 1 : 0,
      at,
    ),
  ]);
  return readInfrastructureBackupConfig(env.DB);
}
export async function backupArchive(env: Env, regionId: string) {
  const region = await env.DB.prepare(
    "SELECT id,backup_bucket FROM regions WHERE id=?",
  )
    .bind(regionId)
    .first<{ id: string; backup_bucket: string }>();
  if (!region) throw new ApiError("not_found", "Backup region not found");
  return regionArchive(env, region).bucket;
}
export async function readInfrastructureBackupRun(db: D1Database, id: string) {
  const row = await db
    .prepare("SELECT * FROM infrastructure_backup_runs WHERE id=?")
    .bind(id)
    .first<RunRow>();
  if (!row)
    throw new ApiError("not_found", "Infrastructure backup run not found");
  // Earlier runs also hold receipts of regional etcd snapshots; they stay in D1 and are not read.
  const artifacts = await db
    .prepare(
      "SELECT * FROM infrastructure_backup_artifacts WHERE run_id=? AND kind='d1' ORDER BY id",
    )
    .bind(id)
    .all<ArtifactRow>();
  return { row, artifacts: artifacts.results };
}
export async function infrastructureBackupStatus(db: D1Database, id?: string) {
  const selected =
    id ??
    (await db
      .prepare(
        "SELECT id FROM infrastructure_backup_runs ORDER BY day DESC,attempt DESC LIMIT 1",
      )
      .first<string>("id"));
  if (!selected) return null;
  const { row, artifacts } = await readInfrastructureBackupRun(db, selected);
  return InfrastructureBackupRunStatus.parse({
    id: row.id,
    day: row.day,
    attempt: row.attempt,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
    error_code: row.error_code,
    artifacts: artifacts.map((artifact) =>
      InfrastructureBackupArtifactStatus.strip().parse(artifact),
    ),
  });
}
export async function assertBackupRun(env: Env, id: string, now = Date.now()) {
  // A notification PUT carries both revisions atomically. Read them in the same transaction
  // so an intervening carry cannot make a valid capture look revoked.
  const [runs, artifacts, configs] = await env.DB.batch<
    RunRow | ArtifactRow | ConfigRow
  >([
    env.DB.prepare("SELECT * FROM infrastructure_backup_runs WHERE id=?").bind(
      id,
    ),
    env.DB.prepare(
      "SELECT * FROM infrastructure_backup_artifacts WHERE run_id=? AND kind='d1' ORDER BY id",
    ).bind(id),
    env.DB.prepare(
      "SELECT * FROM infrastructure_backup_config WHERE singleton=1",
    ),
  ]);
  const row = runs!.results[0] as RunRow | undefined;
  if (!row)
    throw new ApiError("not_found", "Infrastructure backup run not found");
  const config = configView(configs!.results[0] as ConfigRow | undefined);
  if (
    !config.enabled ||
    config.revision !== row.config_revision ||
    !["pending", "running"].includes(row.status) ||
    Date.parse(row.expires_at) <= now
  )
    throw new Error("infrastructure_backup_authority_expired");
  return { row, artifacts: artifacts!.results as ArtifactRow[], config };
}
/** Persist one UTC-day intent per attempt. Creation ambiguity resolves through the same Workflow id. */
export async function runInfrastructureBackupCron(env: Env, now = Date.now()) {
  const at = new Date(now).toISOString(),
    config = await readInfrastructureBackupConfig(env.DB);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE infrastructure_backup_artifacts SET status='failed',error_code='infrastructure_backup_deadline' WHERE status IN('pending','prepared') AND run_id IN(SELECT id FROM infrastructure_backup_runs WHERE status IN('pending','running') AND expires_at<=?)",
    ).bind(at),
    env.DB.prepare(
      "UPDATE infrastructure_backup_runs SET status='failed',completed_at=?,error_code='infrastructure_backup_deadline' WHERE status IN('pending','running') AND expires_at<=?",
    ).bind(at, at),
  ]);
  if (!config.enabled || !env.INFRASTRUCTURE_BACKUP) return;
  const day = at.slice(0, 10),
    previous = await env.DB.prepare(
      "SELECT * FROM infrastructure_backup_runs WHERE day=? ORDER BY attempt DESC LIMIT 1",
    )
      .bind(day)
      .first<RunRow>(),
    attempt = !previous
      ? 1
      : previous.status === "failed" &&
          previous.attempt < MAX_DAILY_ATTEMPTS &&
          now - Date.parse(previous.completed_at!) >= RETRY_DELAY_MS
        ? previous.attempt + 1
        : 0;
  if (attempt) {
    // One attempt at a time across days, so a retry never competes with another capture. The run
    // takes the configuration revision in the same statement that inserts it: a notification PUT
    // landing after the read above would otherwise leave the new run revoked at birth.
    await env.DB.prepare(
      "INSERT INTO infrastructure_backup_runs(id,day,attempt,config_revision,status,created_at,expires_at) SELECT ?,?,?,revision,'pending',?,? FROM infrastructure_backup_config WHERE singleton=1 AND enabled=1 AND NOT EXISTS(SELECT 1 FROM infrastructure_backup_runs WHERE status IN('pending','running')) ON CONFLICT(day,attempt) DO NOTHING",
    )
      .bind(
        crypto.randomUUID(),
        day,
        attempt,
        at,
        new Date(now + MAX_RUN_MS).toISOString(),
      )
      .run();
  }
  // An inserted attempt is the only pending run; otherwise dispatch one of any day whose Workflow creation was uncertain.
  const run = await env.DB.prepare(
    "SELECT * FROM infrastructure_backup_runs WHERE status='pending' ORDER BY day DESC,attempt DESC LIMIT 1",
  ).first<RunRow>();
  if (!run) return;
  // Resolve the exact persisted instance; only the binding's known missing-instance result permits creation.
  try {
    const existing = await env.INFRASTRUCTURE_BACKUP.get(run.id);
    await existing.status();
    return;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/instance\.not_found|Instance does not exist/.test(error.message)
    )
      return;
  }
  try {
    await env.INFRASTRUCTURE_BACKUP.create({
      id: run.id,
      params: { run_id: run.id },
    });
  } catch {
    /* Do not blindly repeat an uncertain create; next Cron reads this exact Workflow id. */
  }
}
/** Artifact membership is fixed before the export. */
export async function initializeInfrastructureBackup(env: Env, id: string) {
  const { row, config, artifacts } = await assertBackupRun(env, id);
  if (artifacts.length) return artifacts;
  if (!config.d1_region_id || !config.d1_database_id)
    throw new Error("infrastructure_backup_config_missing");
  const identities: z.infer<typeof InfrastructureBackupArtifactIdentity>[] = [
    {
      id: "d1-control",
      kind: "d1",
      day: row.day,
      region_id: config.d1_region_id,
      source_id: config.d1_database_id,
    },
  ];
  await env.DB.batch(
    identities.map((artifact) =>
      env.DB.prepare(
        `INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,status,object_key)
      VALUES(?,?,?,?,?,?,'pending',?) ON CONFLICT(run_id,id) DO NOTHING`,
      ).bind(
        id,
        artifact.id,
        artifact.kind,
        artifact.day,
        artifact.region_id,
        artifact.source_id,
        `infrastructure/v1/${row.day}/${id}/${artifact.id}.pgcfenc`,
      ),
    ),
  );
  await env.DB.prepare(
    "UPDATE infrastructure_backup_runs SET status='running' WHERE id=? AND status='pending'",
  )
    .bind(id)
    .run();
  return (await readInfrastructureBackupRun(env.DB, id)).artifacts;
}
/** The encryption key derived from the active CREDENTIAL_KEYS version, or from `kid` when given. */
export async function infrastructureBackupKey(secret: string, kid?: string) {
  const config = z
    .strictObject({
      active: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      keys: z.record(z.string(), z.string()),
    })
    .parse(JSON.parse(secret));
  const selected = kid ?? config.active,
    raw = base64urlToBytes(
      Object.hasOwn(config.keys, selected) ? config.keys[selected]! : "",
    );
  if (raw?.length !== 32)
    throw new Error("infrastructure_backup_key_unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(raw),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("pgcf-infrastructure-backup-v1"),
      info: new TextEncoder().encode(selected),
    },
    key,
    256,
  );
  return { kid: selected, key: bytesToBase64url(new Uint8Array(bits)) };
}
/** The export endpoint only reads the existing D1 database; signed URLs never enter status or logs. */
export async function exportControlD1(
  env: Env,
  id: string,
  fetcher: typeof fetch = fetch,
) {
  const { config, row } = await assertBackupRun(env, id);
  if (!env.INFRASTRUCTURE_BACKUP_CF_TOKEN)
    throw new Error("infrastructure_backup_export_secret_missing");
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.d1_account_id}/d1/database/${config.d1_database_id}/export`;
  let bookmark: string | undefined;
  for (let poll = 0; poll < 120; poll++) {
    // D1 itself may reject queries while its export is running. Poll the same provider job
    // under the already-authorized deadline, then recheck current authority before returning.
    if (Date.now() >= Date.parse(row.expires_at))
      throw new Error("infrastructure_backup_d1_export_timeout");
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.INFRASTRUCTURE_BACKUP_CF_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        output_format: "polling",
        dump_options: { no_schema: false, no_data: false, tables: [] },
        ...(bookmark ? { current_bookmark: bookmark } : {}),
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("infrastructure_backup_d1_export_failed");
    }
    const result = (await response.json()) as {
      success?: boolean;
      result?: {
        success?: boolean;
        status?: string;
        at_bookmark?: string;
        result?: { signed_url?: string };
        signed_url?: string;
      };
    };
    if (
      !response.ok ||
      !result.success ||
      !result.result ||
      result.result.success === false ||
      result.result.status === "error"
    )
      throw new Error("infrastructure_backup_d1_export_failed");
    if (result.result.status === "complete") {
      const signed =
        result.result.result?.signed_url ?? result.result.signed_url;
      if (!signed || new URL(signed).protocol !== "https:")
        throw new Error("infrastructure_backup_d1_export_invalid");
      await assertBackupRun(env, id);
      return signed;
    }
    bookmark = result.result.at_bookmark;
    if (!bookmark) throw new Error("infrastructure_backup_d1_export_invalid");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("infrastructure_backup_d1_export_timeout");
}
export async function recordPreparedBackups(
  env: Env,
  id: string,
  values: unknown[],
) {
  const { artifacts } = await assertBackupRun(env, id),
    prepared = values.map((value) =>
      InfrastructureBackupPreparedArtifact.parse(value),
    );
  if (prepared.length !== artifacts.length)
    throw new Error("infrastructure_backup_artifact_membership_changed");
  for (const metadata of prepared) {
    const artifact = artifacts.find((a) => a.id === metadata.id);
    if (
      !artifact ||
      metadata.run_id !== id ||
      JSON.stringify(pickBackupIdentity(artifact)) !==
        JSON.stringify(pickBackupIdentity(metadata))
    )
      throw new Error("infrastructure_backup_artifact_identity_changed");
    await env.DB.prepare(
      `UPDATE infrastructure_backup_artifacts SET status='prepared',kid=?,plaintext_sha256=?,plaintext_bytes=?,encrypted_sha256=?,encrypted_bytes=? WHERE run_id=? AND id=? AND status='pending'`,
    )
      .bind(
        metadata.kid,
        metadata.plaintext_sha256,
        metadata.plaintext_bytes,
        metadata.encrypted_sha256,
        metadata.encrypted_bytes,
        id,
        metadata.id,
      )
      .run();
  }
}
const PART_BYTES = 8 * 1024 * 1024;
/** Bounded parts over the R2 binding; no public large-body API or uncertain PUT replay. */
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
/**
 * Encrypts the export at `sourceUrl` into the artifact's unique R2 object and records the prepared
 * receipt. The source is read twice: once to measure it for the envelope, once to encrypt it. The
 * plaintext is never stored and never held whole.
 */
export async function captureInfrastructureArtifact(
  env: Env,
  id: string,
  artifactId: string,
  sourceUrl: string,
  fetcher: typeof fetch = fetch,
) {
  const { artifacts } = await assertBackupRun(env, id),
    artifact = artifacts.find((value) => value.id === artifactId);
  if (!artifact || artifact.status !== "pending")
    throw new Error("infrastructure_backup_artifact_identity_changed");
  const source = async () => {
    const response = await fetcher(sourceUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("infrastructure_backup_source_refused");
    }
    return response.body;
  };
  const encryption = await infrastructureBackupKey(env.CREDENTIAL_KEYS),
    identity = {
      ...pickBackupIdentity(artifact),
      run_id: id,
      kid: encryption.kid,
      ...(await measureSource(await source())),
    };
  const bucket = await backupArchive(env, artifact.region_id);
  // An object under this run's unique key is never overwritten.
  if (await bucket.head(artifact.object_key))
    throw new Error("infrastructure_backup_object_exists");
  await assertBackupRun(env, id);
  const encrypted = encryptSource(await source(), encryption.key, identity);
  await uploadInfrastructureArtifact(
    bucket,
    artifact.object_key,
    encrypted.stream,
    { run_id: id, artifact_id: artifact.id, kid: encryption.kid },
  );
  await recordPreparedBackups(env, id, [
    { ...identity, ...(await encrypted.receipt) },
  ]);
}
/** Reads the whole committed object back and authenticates it against its prepared receipt. */
export async function verifyInfrastructureArtifact(
  env: Env,
  id: string,
  artifactId: string,
) {
  const { artifacts } = await assertBackupRun(env, id),
    artifact = artifacts.find((value) => value.id === artifactId);
  if (!artifact || artifact.status !== "prepared")
    throw new Error("infrastructure_backup_artifact_identity_changed");
  const prepared = InfrastructureBackupPreparedArtifact.parse({
    ...pickBackupIdentity(artifact),
    run_id: id,
    kid: artifact.kid,
    plaintext_sha256: artifact.plaintext_sha256,
    plaintext_bytes: artifact.plaintext_bytes,
    encrypted_sha256: artifact.encrypted_sha256,
    encrypted_bytes: artifact.encrypted_bytes,
  });
  const bucket = await backupArchive(env, artifact.region_id),
    object = await bucket.get(artifact.object_key);
  if (
    !object ||
    object.size !== prepared.encrypted_bytes ||
    object.customMetadata?.run_id !== id ||
    object.customMetadata.artifact_id !== artifact.id ||
    object.customMetadata.kid !== prepared.kid
  ) {
    await object?.body.cancel();
    throw new Error("infrastructure_backup_r2_identity_changed");
  }
  // The tag of the same object version, read before the whole object.
  const tail = await bucket.get(artifact.object_key, {
    range: { suffix: 16 },
    onlyIf: { etagMatches: object.etag },
  });
  if (!tail || !("body" in tail)) {
    await object.body.cancel();
    throw new Error("infrastructure_backup_r2_identity_changed");
  }
  const encryption = await infrastructureBackupKey(
    env.CREDENTIAL_KEYS,
    prepared.kid,
  );
  await verifyEnvelope(
    object.body,
    encryption.key,
    prepared,
    new Uint8Array(await tail.arrayBuffer()),
  );
  await completeBackupArtifact(env, id, artifact.id);
  return {
    encrypted_bytes: prepared.encrypted_bytes,
    encrypted_sha256: prepared.encrypted_sha256,
    readback_verified: true,
  };
}
export async function completeBackupArtifact(
  env: Env,
  id: string,
  artifactId: string,
) {
  await assertBackupRun(env, id);
  await env.DB.prepare(
    "UPDATE infrastructure_backup_artifacts SET status='complete',completed_at=?,error_code=NULL WHERE run_id=? AND id=? AND status='prepared'",
  )
    .bind(new Date().toISOString(), id, artifactId)
    .run();
}
export async function finishInfrastructureBackup(
  env: Env,
  id: string,
  error?: unknown,
) {
  const code =
    error instanceof Error &&
    /^infrastructure_backup_[a-z0-9_]{1,90}$/.test(error.message)
      ? error.message
      : "infrastructure_backup_execution_failed";
  const at = new Date().toISOString();
  if (error) {
    // The record keeps only the code. Which step failed is the error's class and, when its text
    // cannot carry a signed URL, a key or a path, the text: letters, digits and plain punctuation.
    const name = error instanceof Error ? error.name : typeof error,
      text = error instanceof Error ? error.message : "";
    console.error(
      JSON.stringify({
        event: "infrastructure_backup_failed",
        run_id: id,
        code,
        error_name: /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "other",
        ...(/^[A-Za-z0-9 _.,:;'()-]{1,160}$/.test(text)
          ? { detail: text }
          : {}),
      }),
    );
  }
  if (error)
    await env.DB.prepare(
      "UPDATE infrastructure_backup_artifacts SET status='failed',error_code=? WHERE run_id=? AND status!='complete'",
    )
      .bind(code, id)
      .run();
  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) n FROM infrastructure_backup_artifacts WHERE run_id=? AND status!='complete'",
  )
    .bind(id)
    .first<number>("n");
  await env.DB.prepare(
    "UPDATE infrastructure_backup_runs SET status=?,completed_at=?,error_code=? WHERE id=? AND status IN('pending','running')",
  )
    .bind(
      error || remaining ? "failed" : "complete",
      at,
      error || remaining ? code : null,
      id,
    )
    .run();
}
export async function infrastructureBackupHealth(env: Env, now = Date.now()) {
  const config = await readInfrastructureBackupConfig(env.DB),
    expected: {
      kind: "d1";
      region_id: string;
      source_id: string | null;
    }[] = [];
  if (config.d1_region_id)
    expected.push({
      kind: "d1",
      region_id: config.d1_region_id,
      source_id: config.d1_database_id,
    });
  return Promise.all(
    expected.map(async (identity) => {
      // Only a complete attempt counts, so a retry's own receipts neither clear nor reopen a failed episode.
      const completed = await env.DB.prepare(
        "SELECT MAX(a.completed_at) at FROM infrastructure_backup_artifacts a JOIN infrastructure_backup_runs r ON r.id=a.run_id AND r.status='complete' WHERE a.kind=? AND a.region_id=? AND a.source_id=? AND a.status='complete'",
      )
        .bind(identity.kind, identity.region_id, identity.source_id)
        .first<string>("at");
      const failed = await env.DB.prepare(
        "SELECT r.completed_at,r.error_code FROM infrastructure_backup_runs r WHERE r.status='failed' ORDER BY r.day DESC,r.attempt DESC LIMIT 1",
      ).first<{ completed_at: string; error_code: string }>();
      const baseline = Date.parse(completed ?? config.enabled_at ?? "");
      return InfrastructureBackupHealth.parse({
        kind: identity.kind,
        region_id: identity.region_id,
        status: !config.enabled
          ? "disabled"
          : identity.source_id === null
            ? "unknown"
            : failed &&
                Date.parse(failed.completed_at) >=
                  Date.parse(completed ?? config.enabled_at ?? "")
              ? "failing"
              : Number.isFinite(baseline) &&
                  now - baseline > INFRASTRUCTURE_BACKUP_MAX_AGE_MS
                ? "stale"
                : completed
                  ? "ok"
                  : "unknown",
        last_completed_at: completed ?? null,
        last_failed_at: failed?.completed_at ?? null,
        error_code: failed?.error_code ?? null,
      });
    }),
  );
}
