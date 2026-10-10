// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  base64urlToBytes,
  bytesToBase64url,
  timingSafeEqual,
} from "@pgcf/contracts";
import {
  InfrastructureBackupConfig,
  InfrastructureBackupConfigInput,
  InfrastructureBackupArtifactIdentity,
  InfrastructureBackupArtifactStatus,
  InfrastructureBackupPreparedArtifact,
  InfrastructureBackupRunStatus,
  InfrastructureBackupHealth,
  type InfrastructureBackupInput,
} from "@pgcf/contracts/infrastructure-backups";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import { regionArchive } from "./archive-bindings.ts";
import { currentOperatorAuthority } from "./node-operator.ts";
import { NODE_OBSERVATION_MAX_AGE_MS } from "./placement.ts";
import {
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";

export const INFRASTRUCTURE_BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const MAX_RUN_MS = 2 * 60 * 60 * 1000;
type RunRow = {
  id: string;
  day: string;
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
    node_id: value.node_id,
    node_uid: value.node_uid,
    cluster_uid: value.cluster_uid,
    material_revision: value.material_revision,
  });
}
export async function readInfrastructureBackupConfig(db: D1Database) {
  const row = await db
    .prepare("SELECT * FROM infrastructure_backup_config WHERE singleton=1")
    .first<{
      enabled: number;
      d1_account_id: string | null;
      d1_database_id: string | null;
      d1_region_id: string | null;
      notification_recipient: string | null;
      notification_sender: string | null;
      revision: number;
      enabled_at: string | null;
      updated_at: string | null;
    }>();
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
  await env.DB.prepare(
    `UPDATE infrastructure_backup_config SET enabled=?,d1_account_id=?,d1_database_id=?,d1_region_id=?,
    notification_recipient=?,notification_sender=?,revision=revision+1,enabled_at=CASE WHEN ?=1 AND enabled=0 THEN ? WHEN ?=0 THEN NULL ELSE enabled_at END,updated_at=? WHERE singleton=1`,
  )
    .bind(
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
    )
    .run();
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
  const artifacts = await db
    .prepare(
      "SELECT * FROM infrastructure_backup_artifacts WHERE run_id=? ORDER BY id",
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
        "SELECT id FROM infrastructure_backup_runs ORDER BY day DESC LIMIT 1",
      )
      .first<string>("id"));
  if (!selected) return null;
  const { row, artifacts } = await readInfrastructureBackupRun(db, selected);
  return InfrastructureBackupRunStatus.parse({
    id: row.id,
    day: row.day,
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
  const { row, artifacts } = await readInfrastructureBackupRun(env.DB, id),
    config = await readInfrastructureBackupConfig(env.DB);
  if (
    !config.enabled ||
    config.revision !== row.config_revision ||
    !["pending", "running"].includes(row.status) ||
    Date.parse(row.expires_at) <= now
  )
    throw new Error("infrastructure_backup_authority_expired");
  return { row, artifacts, config };
}
/** Persist one UTC-day intent. Creation ambiguity resolves through the same Workflow id. */
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
    id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,config_revision,status,created_at,expires_at) VALUES(?,?,?,'pending',?,?) ON CONFLICT(day) DO NOTHING",
  )
    .bind(
      id,
      day,
      config.revision,
      at,
      new Date(now + MAX_RUN_MS).toISOString(),
    )
    .run();
  const run = await env.DB.prepare(
    "SELECT * FROM infrastructure_backup_runs WHERE day=?",
  )
    .bind(day)
    .first<RunRow>();
  if (!run || run.status !== "pending") return;
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
/** Artifact membership is fixed before exports; unavailable existing clusters fail the run. */
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
      node_id: null,
      node_uid: null,
      cluster_uid: null,
      material_revision: null,
    },
  ];
  const clusters = await env.DB.prepare(
    "SELECT id FROM regions WHERE EXISTS(SELECT 1 FROM region_bootstrap_credentials c WHERE c.region_id=regions.id AND c.purpose='join_bundle' AND c.revision=regions.bootstrap_material_revision) ORDER BY id",
  ).all<{ id: string }>();
  for (const region of clusters.results) {
    const source = await snapshotSource(env, region.id);
    identities.push({
      id: `etcd-${region.id}`,
      kind: "etcd",
      day: row.day,
      region_id: region.id,
      source_id: source.authority.binding.cluster_uid,
      node_id: source.id,
      node_uid: source.uid,
      cluster_uid: source.authority.binding.cluster_uid,
      material_revision: source.authority.binding.material_revision,
    });
  }
  await env.DB.batch(
    identities.map((artifact) =>
      env.DB.prepare(
        `INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,node_id,node_uid,cluster_uid,material_revision,status,object_key)
      VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT(run_id,id) DO NOTHING`,
      ).bind(
        id,
        artifact.id,
        artifact.kind,
        artifact.day,
        artifact.region_id,
        artifact.source_id,
        artifact.node_id,
        artifact.node_uid,
        artifact.cluster_uid,
        artifact.material_revision,
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
async function snapshotSource(
  env: Env,
  regionId: string,
  expected?: ArtifactRow,
) {
  const cutoff = new Date(
      Date.now() - NODE_OBSERVATION_MAX_AGE_MS,
    ).toISOString(),
    future = new Date(Date.now() + 5000).toISOString();
  const sources = await env.DB.prepare(
    `SELECT n.id,n.node_uid,o.facts_json,f.spec_json FROM nodes n
    JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
    JOIN fleet_releases f ON f.id=a.release_id JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid
      AND o.assignment_revision=a.revision AND o.agent_key_hash=r.agent_key_hash
    WHERE n.region_id=? AND n.ready=1 AND n.lost_at IS NULL AND o.observed_at>=? AND o.observed_at<=? ORDER BY n.id`,
  )
    .bind(regionId, cutoff, future)
    .all<{
      id: string;
      node_uid: string;
      facts_json: string;
      spec_json: string;
    }>();
  for (const node of sources.results) {
    if (
      expected &&
      (node.id !== expected.node_id || node.node_uid !== expected.node_uid)
    )
      continue;
    const facts = JSON.parse(node.facts_json) as {
        kubernetes_control_plane?: boolean;
        kubernetes_image_provenance?: { control_plane: boolean };
        components: { name: string; runtime_image_sha256?: string }[];
      },
      spec = JSON.parse(node.spec_json) as {
        components: { name: string; reference: string }[];
      };
    if (
      facts.kubernetes_control_plane !== true &&
      facts.kubernetes_image_provenance?.control_plane !== true
    )
      continue;
    const pin = spec.components.find((c) => c.name === "image/cilium/cilium"),
      live = facts.components.find((c) => c.name === "image/cilium/cilium");
    if (
      !pin ||
      !live?.runtime_image_sha256 ||
      !/^[a-f0-9]{64}$/.test(live.runtime_image_sha256)
    )
      continue;
    const authority = await currentOperatorAuthority(
      env,
      node.id,
      node.node_uid,
      expected?.material_revision ?? undefined,
    );
    if (expected && authority.binding.cluster_uid !== expected.cluster_uid)
      throw new Error("infrastructure_backup_cluster_changed");
    return {
      id: node.id,
      uid: node.node_uid,
      authority,
      cilium_image: pin.reference,
      cilium_image_id:
        pin.reference.split("@")[0] + "@sha256:" + live.runtime_image_sha256,
    };
  }
  throw new Error("infrastructure_backup_snapshot_source_unavailable");
}
export async function infrastructureBackupKey(secret: string) {
  const config = z
    .strictObject({
      active: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      keys: z.record(z.string(), z.string()),
    })
    .parse(JSON.parse(secret));
  const raw = base64urlToBytes(config.keys[config.active] ?? "");
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
      info: new TextEncoder().encode(config.active),
    },
    key,
    256,
  );
  return { kid: config.active, key: bytesToBase64url(new Uint8Array(bits)) };
}
async function scopedToken(env: Env, run: RunRow, artifact: ArtifactRow) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BOOTSTRAP_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          `infrastructure-backup|${run.id}|${artifact.id}|${artifact.node_id}|${artifact.node_uid}|${artifact.cluster_uid}|${artifact.material_revision}|${run.expires_at}`,
        ),
      ),
    ),
  );
}
export async function authorizeBackupOperator(
  env: Env,
  runId: string,
  artifactId: string,
  authorization: string | undefined,
) {
  const { row, artifacts } = await assertBackupRun(env, runId),
    artifact = artifacts.find((a) => a.id === artifactId && a.kind === "etcd");
  if (
    !artifact ||
    !timingSafeEqual(
      authorization ?? "",
      `Bearer ${await scopedToken(env, row, artifact)}`,
    )
  )
    throw new ApiError(
      "unauthorized",
      "Backup capability is invalid or expired",
    );
  const authority = await currentOperatorAuthority(
    env,
    artifact.node_id!,
    artifact.node_uid!,
    artifact.material_revision!,
  );
  if (authority.binding.cluster_uid !== artifact.cluster_uid)
    throw new ApiError("conflict", "Backup cluster authority changed");
  return artifact;
}
export async function prepareInfrastructureBackupInput(
  env: Env,
  id: string,
  d1Url: string,
): Promise<InfrastructureBackupInput> {
  const { row, artifacts } = await assertBackupRun(env, id),
    inputs: InfrastructureBackupInput["artifacts"] = [];
  for (const artifact of artifacts) {
    const identity = pickBackupIdentity(artifact);
    if (artifact.kind === "d1") {
      inputs.push({ ...identity, d1_url: d1Url });
      continue;
    }
    const source = await snapshotSource(env, artifact.region_id, artifact),
      material = JSON.parse(source.authority.material) as {
        kubeconfig: string;
        talos_admin_config: string;
      };
    const url = new URL(
      `/internal/v1/infrastructure-backups/${id}/${artifact.id}/kubernetes`,
      env.NODE_BOOTSTRAP_CALLBACK_URL,
    );
    inputs.push({
      ...identity,
      source: {
        node_id: source.id,
        node_uid: source.uid,
        node_address: source.authority.address,
        binding: source.authority.binding,
        kubeconfig: material.kubeconfig,
        talosconfig: material.talos_admin_config,
        operator_url: url.href,
        operator_token: await scopedToken(env, row, artifact),
        cilium_image: source.cilium_image,
        cilium_image_id: source.cilium_image_id,
      },
    });
  }
  return {
    run_id: id,
    artifacts: inputs,
    encryption: await infrastructureBackupKey(env.CREDENTIAL_KEYS),
  };
}
/** The export endpoint only reads the existing D1 database; signed URLs never enter status or logs. */
export async function exportControlD1(
  env: Env,
  id: string,
  fetcher: typeof fetch = fetch,
) {
  const { config } = await assertBackupRun(env, id);
  if (!env.INFRASTRUCTURE_BACKUP_CF_TOKEN)
    throw new Error("infrastructure_backup_export_secret_missing");
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.d1_account_id}/d1/database/${config.d1_database_id}/export`;
  let bookmark: string | undefined;
  for (let poll = 0; poll < 120; poll++) {
    await assertBackupRun(env, id);
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
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const result = (await response.json()) as {
      success?: boolean;
      result?: {
        status?: string;
        current_bookmark?: string;
        result?: { signed_url?: string };
        signed_url?: string;
      };
    };
    if (!response.ok || !result.success || !result.result)
      throw new Error("infrastructure_backup_d1_export_failed");
    if (result.result.status === "complete") {
      const signed =
        result.result.result?.signed_url ?? result.result.signed_url;
      if (!signed || new URL(signed).protocol !== "https:")
        throw new Error("infrastructure_backup_d1_export_invalid");
      return signed;
    }
    bookmark = result.result.current_bookmark;
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
      kind: "d1" | "etcd";
      region_id: string;
      source_id: string | null;
    }[] = [];
  if (config.d1_region_id)
    expected.push({
      kind: "d1",
      region_id: config.d1_region_id,
      source_id: config.d1_database_id,
    });
  const clusters = await env.DB.prepare(
    "SELECT id FROM regions WHERE bootstrap_material_revision>0 AND EXISTS(SELECT 1 FROM region_bootstrap_credentials c WHERE c.region_id=regions.id AND c.purpose='join_bundle' AND c.revision=regions.bootstrap_material_revision)",
  ).all<{ id: string }>();
  for (const region of clusters.results) {
    let clusterUid: string | null = null;
    if (config.enabled) {
      try {
        const reference = await loadCurrentRegionMaterialReference(
          env.DB,
          region.id,
          "join_bundle",
        );
        clusterUid = (
          await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, reference)
        ).kube_system_uid;
      } catch {
        /* Unknown current custody must never adopt an older cluster's successful archive. */
      }
    }
    expected.push({
      kind: "etcd",
      region_id: region.id,
      source_id: clusterUid,
    });
  }
  return Promise.all(
    expected.map(async (identity) => {
      const completed = await env.DB.prepare(
        "SELECT MAX(completed_at) at FROM infrastructure_backup_artifacts WHERE kind=? AND region_id=? AND source_id=? AND (?='d1' OR cluster_uid=?) AND status='complete'",
      )
        .bind(
          identity.kind,
          identity.region_id,
          identity.source_id,
          identity.kind,
          identity.source_id,
        )
        .first<string>("at");
      const failed = await env.DB.prepare(
        "SELECT r.completed_at,r.error_code FROM infrastructure_backup_runs r WHERE r.status='failed' ORDER BY r.day DESC LIMIT 1",
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
