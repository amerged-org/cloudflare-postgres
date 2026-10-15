// SPDX-License-Identifier: Apache-2.0
import {
  NodeId,
  OperationId,
  ThinStorageProfile,
  bytesToBase64url,
  newOperationId,
  timingSafeEqual,
} from "@pgcf/contracts";
import {
  FleetReleaseSpec,
  thinStorageReleaseGuardPinned,
  type ThinStorageQualification,
} from "@pgcf/contracts/releases";
import {
  THIN_QUALIFICATION_SAMPLE_WINDOWS,
  THIN_QUALIFICATION_STEPS,
  ThinQualificationCheckpoint,
  ThinQualificationCleanup,
  ThinQualificationGates,
  ThinQualificationInput,
  ThinQualificationJournal,
  ThinQualificationReport,
  ThinQualificationRequest,
  ThinQualificationRun,
  ThinQualificationSetup,
  thinQualificationCleanupVerified,
  thinQualificationGatePass,
  thinQualificationPassed,
  thinQualificationReceiptMaterial,
  thinQualificationSetupValid,
  thinStorageQualificationFromRun,
  type ThinQualificationGate,
} from "@pgcf/contracts/thin-qualification";
import { ApiError } from "../app.ts";
import {
  thinStorageSamplingCapable,
  thinStorageSamplingSql,
} from "./fleet-releases.ts";
import type { ApiContext, Env } from "../env.ts";
import { bearer, requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import {
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import {
  installationHash,
  canonicalInstallation,
} from "./node-installation.ts";
import { storageAuthorityPublicKeys } from "./storage-authority.ts";
import { signNativeRelayCapability } from "./node-thin-storage-execution.ts";

/** One executor turn; the executor deadline stays inside it. */
const LEASE_MILLISECONDS = 11 * 60 * 1000;
const conflict = (message: string): never => {
  throw new ApiError("conflict", message);
};
const closed = (): never => {
  throw new ApiError(
    "conflict",
    "Current thin qualification lease or identity changed",
  );
};
interface Row {
  id: string;
  node_id: string;
  region_id: string;
  node_uid: string;
  cluster_uid: string;
  address: string;
  release_id: string;
  spec_sha256: string;
  assignment_revision: number;
  region_revision: number;
  material_revision: number;
  profile_json: string;
  profile_sha256: string;
  driver_image: string;
  host_extension_image: string;
  postgres_image: string;
  kernel_version: string | null;
  setup_json: string | null;
  gates_json: string;
  cleanup_json: string | null;
  journal_json: string;
  step: ThinQualificationRun["step"];
  status: ThinQualificationRun["status"];
  error_code: string | null;
  lease_id: string | null;
  lease_revision: number;
  lease_expires_at: string | null;
  receipt_sha256: string | null;
  qualified_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
async function readRow(db: D1Database, id: string): Promise<Row> {
  OperationId.parse(id);
  const row = await db
    .prepare("SELECT * FROM thin_storage_qualification_runs WHERE id=?")
    .bind(id)
    .first<Row>();
  if (!row) throw new ApiError("not_found", "Thin qualification not found");
  return row;
}
function runView(row: Row): Omit<ThinQualificationRun, "qualification"> {
  return {
    id: row.id,
    node_id: row.node_id,
    region_id: row.region_id,
    node_uid: row.node_uid,
    release_id: row.release_id,
    spec_sha256: row.spec_sha256,
    profile: ThinStorageProfile.parse(JSON.parse(row.profile_json)),
    profile_sha256: row.profile_sha256,
    driver_image: row.driver_image,
    host_extension_image: row.host_extension_image,
    postgres_image: row.postgres_image,
    kernel_version: row.kernel_version,
    status: row.status,
    step: row.step,
    error_code: row.error_code,
    setup: row.setup_json
      ? ThinQualificationSetup.parse(JSON.parse(row.setup_json))
      : null,
    gates: ThinQualificationGates.parse(JSON.parse(row.gates_json)),
    cleanup: row.cleanup_json
      ? ThinQualificationCleanup.parse(JSON.parse(row.cleanup_json))
      : null,
    receipt_sha256: row.receipt_sha256,
    qualified_at: row.qualified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}
export async function readThinQualification(
  env: Pick<Env, "DB">,
  id: string,
): Promise<ThinQualificationRun> {
  const view = runView(await readRow(env.DB, id));
  return ThinQualificationRun.parse({
    ...view,
    qualification:
      view.status === "completed"
        ? thinStorageQualificationFromRun(view)
        : null,
  });
}
export async function getThinQualification(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  return c.json(await readThinQualification(c.env, id), 200);
}

/** The exact component pin a run binds; a release without it cannot be qualified. */
function pinned(spec: FleetReleaseSpec, name: string) {
  const component = spec.components.find((value) => value.name === name);
  return component &&
    component.kind === "image" &&
    component.reference.endsWith(`@sha256:${component.sha256}`)
    ? component
    : null;
}
/** Scratch qualification permits either fleet role, but placement must stay closed throughout. */
const freshNodeSql = `n.id=? AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL AND n.provider_instance_id IS NOT NULL
  AND n.database_placement_enabled=0 AND a.role IN('customer','control_relay')
  AND julianday(n.last_observed_at)>=julianday('now','-180 seconds') AND julianday(n.last_observed_at)<=julianday('now','+5 seconds')`;

/** Start one fenced scratch run on a current node with closed placement and a guard-pinned release. */
export async function startThinQualification(
  c: ApiContext,
  nodeId: string,
  raw: ThinQualificationRequest,
) {
  await requireScope(c, "admin");
  NodeId.parse(nodeId);
  const body = ThinQualificationRequest.parse(raw);
  // The Workflow follows the persisted run, so a replay also drives a run whose start was lost.
  const output = async (id: string) => {
    const run = await readThinQualification(c.env, id);
    if (run.status === "running")
      await startThinQualificationWorkflow(c.env, id);
    return c.json(run, 202);
  };
  return withIdempotency(c, {
    replay: output,
    execute: async (lease) => {
      const env = c.env;
      const source = await env.DB.prepare(
        `SELECT n.region_id,a.role,a.release_id,a.revision assignment_revision,f.revision region_revision,s.spec_json,s.spec_sha256,r.bootstrap_material_revision material_revision,
        EXISTS(SELECT 1 FROM node_region_policies p WHERE p.region_id=n.region_id AND p.compute_pool_json IS NOT NULL) pool_enabled,
        EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=n.id) thin_selected,
        (SELECT q.id FROM thin_storage_qualification_runs q WHERE q.node_id=n.id AND q.status='running') running
        FROM nodes n JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
        JOIN fleet_region_releases f ON f.region_id=n.region_id AND f.release_id=a.release_id JOIN fleet_releases s ON s.id=a.release_id
        WHERE ${freshNodeSql}`,
      )
        .bind(nodeId, body.node_uid)
        .first<{
          region_id: string;
          role: "control_relay" | "customer";
          release_id: string;
          assignment_revision: number;
          region_revision: number;
          spec_json: string;
          spec_sha256: string;
          material_revision: number;
          pool_enabled: number;
          thin_selected: number;
          running: string | null;
        }>();
      if (!source)
        return conflict(
          "Qualification requires a current ready fleet node with database placement disabled, fresh observations and its region release",
        );
      if (!(await thinStorageSamplingCapable(env.DB, source.region_id)))
        return conflict(
          "Qualification requires the confirmed sampling-controller release",
        );
      if (!source.pool_enabled)
        return conflict("Thin qualification requires the region compute pool");
      if (source.thin_selected)
        return conflict(
          "A node with selected thin storage cannot run a scratch qualification",
        );
      if (source.running)
        throw new ApiError(
          "conflict",
          "A thin qualification is already running on this node",
          { run_id: source.running },
        );
      const spec = FleetReleaseSpec.parse(JSON.parse(source.spec_json));
      if ((await installationHash(spec)) !== source.spec_sha256)
        return conflict("Approved release contents changed");
      const keys = await storageAuthorityPublicKeys(env);
      if (
        !thinStorageReleaseGuardPinned(spec) ||
        spec.storage_authority_keys_sha256 !== keys.sha256
      )
        return conflict(
          "Qualification requires a release that pins the thin guard and current storage verifier",
        );
      const driver = pinned(spec, "openebs-lvm"),
        host = pinned(spec, "pgcf-sandbox-controller"),
        postgres = pinned(spec, "postgres");
      if (
        !driver ||
        driver.reference !== body.profile.driver_image ||
        !spec.roles[source.role].components.includes(driver.name) ||
        !host ||
        !postgres
      )
        return conflict(
          "Qualification profile and release must pin the same driver, host guard and PostgreSQL images",
        );
      const ref = await loadCurrentRegionMaterialReference(
        env.DB,
        source.region_id,
        "join_bundle",
      );
      if (ref.revision !== source.material_revision)
        return conflict("Current sealed region material changed");
      const bundle = await loadRegionJoinBundle(
        env.DB,
        env.CREDENTIAL_KEYS,
        ref,
      );
      const id = newOperationId(),
        now = new Date().toISOString();
      const results = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO thin_storage_qualification_runs(id,node_id,region_id,node_uid,cluster_uid,address,release_id,spec_sha256,assignment_revision,region_revision,material_revision,profile_json,profile_sha256,driver_image,host_extension_image,postgres_image,step,status,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'setup','running',?,? FROM nodes n JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
          JOIN fleet_region_releases f ON f.region_id=n.region_id AND f.release_id=a.release_id
          WHERE ${freshNodeSql} AND ${thinStorageSamplingSql("r")} AND a.release_id=? AND a.revision=? AND f.revision=? AND r.bootstrap_material_revision=?
            AND EXISTS(SELECT 1 FROM node_region_policies p WHERE p.region_id=n.region_id AND p.compute_pool_json IS NOT NULL)
            AND NOT EXISTS(SELECT 1 FROM node_thin_storage t WHERE t.node_id=n.id)`,
        ).bind(
          id,
          nodeId,
          source.region_id,
          body.node_uid,
          bundle.kube_system_uid,
          body.address,
          source.release_id,
          source.spec_sha256,
          source.assignment_revision,
          source.region_revision,
          source.material_revision,
          canonicalInstallation(body.profile),
          await installationHash(body.profile),
          driver.reference,
          host.reference,
          postgres.reference,
          now,
          now,
          nodeId,
          body.node_uid,
          source.release_id,
          source.assignment_revision,
          source.region_revision,
          source.material_revision,
        ),
        lease.completeStatement(id, 202, {
          sql: "EXISTS(SELECT 1 FROM thin_storage_qualification_runs WHERE id=?)",
          bindings: [id],
        }),
      ]);
      if (results[0]!.meta.changes !== 1)
        return conflict("Thin qualification preconditions changed");
      return output(id);
    },
  });
}
/** Create, restart or resume the run's one Workflow; each turn fast-forwards to the persisted step. */
export async function startThinQualificationWorkflow(env: Env, id: string) {
  OperationId.parse(id);
  try {
    await env.THIN_QUALIFICATION.create({ id, params: { run_id: id } });
  } catch {
    const instance = await env.THIN_QUALIFICATION.get(id),
      state = await instance.status();
    if (["errored", "terminated", "complete"].includes(state.status))
      await instance.restart();
    else if (state.status === "paused") await instance.resume();
  }
}
/** Drive a running run again after a lost start or a stopped Workflow; an ended run stays ended. */
export async function resumeThinQualification(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  const run = await readThinQualification(c.env, id);
  if (run.status !== "running")
    return conflict("Thin qualification already ended");
  await startThinQualificationWorkflow(c.env, id);
  return c.json(run, 200);
}
/** End the measurements; cleanup still runs and the run then fails without a receipt. */
export async function cancelThinQualification(c: ApiContext, id: string) {
  await requireScope(c, "admin");
  OperationId.parse(id);
  const result = await c.env.DB.prepare(
    `UPDATE thin_storage_qualification_runs SET error_code=COALESCE(error_code,'thin_qualification_cancelled'),
    step=CASE WHEN step IN('cleanup','complete') THEN step ELSE 'cleanup' END,updated_at=? WHERE id=? AND status='running'`,
  )
    .bind(new Date().toISOString(), id)
    .run();
  const run = await readThinQualification(c.env, id);
  if (result.meta.changes !== 1)
    return conflict("Thin qualification already ended");
  await startThinQualificationWorkflow(c.env, id);
  return c.json(run, 200);
}

async function callbackBearer(env: Pick<Env, "API_KEY_PEPPER">, row: Row) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.API_KEY_PEPPER),
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
          `pgcf-thin-qualification/v1\n${row.id}\n${row.node_id}\n${row.node_uid}\n${row.lease_id}\n${row.lease_revision}\n${row.release_id}\n${row.spec_sha256}`,
        ),
      ),
    ),
  );
}
function leased(row: Row, now = Date.now()) {
  return (
    row.status === "running" &&
    row.lease_id !== null &&
    row.lease_expires_at !== null &&
    Date.parse(row.lease_expires_at) > now
  );
}
export async function authenticateThinQualification(c: ApiContext, id: string) {
  const row = await readRow(c.env.DB, id);
  if (!leased(row)) return closed();
  if (!timingSafeEqual(bearer(c), await callbackBearer(c.env, row)))
    throw new ApiError(
      "unauthorized",
      "Native thin qualification lease required",
    );
  return row;
}

/** Reserve one bounded turn for the persisted step; an active lease is never shared. */
export async function prepareThinQualificationTurn(
  env: Env,
  id: string,
  step: string,
): Promise<ThinQualificationInput | null> {
  const row = await readRow(env.DB, id);
  if (
    row.status !== "running" ||
    row.step !== step ||
    row.step === "complete" ||
    (row.lease_expires_at && Date.parse(row.lease_expires_at) > Date.now())
  )
    return null;
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE thin_storage_qualification_runs SET lease_id=?,lease_revision=lease_revision+1,lease_expires_at=?,updated_at=?
    WHERE id=? AND status='running' AND step=? AND lease_revision=? AND (lease_expires_at IS NULL OR julianday(lease_expires_at)<=julianday('now'))`,
  )
    .bind(
      newOperationId(),
      new Date(now + LEASE_MILLISECONDS).toISOString(),
      new Date(now).toISOString(),
      id,
      step,
      row.lease_revision,
    )
    .run();
  if (result.meta.changes !== 1) return null;
  const leased = await readRow(env.DB, id);
  try {
    return await thinQualificationInput(env, id);
  } catch (error) {
    // Changed node, release or material authority ends the measurements; cleanup may still run.
    await failThinQualificationTurn(
      env,
      id,
      leased.lease_id!,
      "thin_qualification_authority_changed",
    );
    throw error;
  }
}
/** Private custody for the current lease; gates keep their release, material and closed-placement fences. */
export async function thinQualificationInput(
  env: Env,
  id: string,
): Promise<ThinQualificationInput> {
  const row = await readRow(env.DB, id);
  if (!leased(row) || row.step === "complete") return closed();
  const cleanup = row.step === "cleanup";
  const node = await env.DB.prepare(
    `SELECT n.k8s_node_name,n.provider_instance_id FROM nodes n JOIN regions r ON r.id=n.region_id
    LEFT JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
    LEFT JOIN fleet_region_releases f ON f.region_id=n.region_id
    WHERE n.id=? AND n.node_uid=? AND n.region_id=? AND n.lost_at IS NULL AND n.provider_instance_id IS NOT NULL
      AND (?=1 OR (n.database_placement_enabled=0 AND a.release_id=? AND a.revision=? AND f.release_id=a.release_id AND f.revision=? AND r.bootstrap_material_revision=? AND ${thinStorageSamplingSql("r")}))`,
  )
    .bind(
      row.node_id,
      row.node_uid,
      row.region_id,
      Number(cleanup),
      row.release_id,
      row.assignment_revision,
      row.region_revision,
      row.material_revision,
    )
    .first<{ k8s_node_name: string; provider_instance_id: string }>();
  if (!node) return closed();
  const ref = await loadCurrentRegionMaterialReference(
    env.DB,
    row.region_id,
    "join_bundle",
  );
  if (!cleanup && ref.revision !== row.material_revision) return closed();
  const bundle = await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref);
  if (bundle.kube_system_uid !== row.cluster_uid) return closed();
  const release = await env.DB.prepare(
    "SELECT spec_json FROM fleet_releases WHERE id=? AND spec_sha256=?",
  )
    .bind(row.release_id, row.spec_sha256)
    .first<{ spec_json: string }>();
  if (!release) return closed();
  const host = pinned(
    FleetReleaseSpec.parse(JSON.parse(release.spec_json)),
    "pgcf-sandbox-controller",
  );
  if (!host || host.reference !== row.host_extension_image) return closed();
  const callback = new URL(
    `/internal/v1/thin-qualifications/${id}`,
    env.NODE_BOOTSTRAP_CALLBACK_URL,
  );
  if (callback.protocol !== "https:") return closed();
  return ThinQualificationInput.parse({
    run: {
      id: row.id,
      step: row.step,
      node_id: row.node_id,
      region_id: row.region_id,
      node_uid: row.node_uid,
      cluster_uid: row.cluster_uid,
      name: node.k8s_node_name,
      provider_instance_id: node.provider_instance_id,
      address: row.address,
      release_id: row.release_id,
      spec_sha256: row.spec_sha256,
      profile: JSON.parse(row.profile_json),
      profile_sha256: row.profile_sha256,
      postgres_image: row.postgres_image,
      setup: row.setup_json ? JSON.parse(row.setup_json) : null,
      lease: {
        operation_id: row.lease_id,
        revision: row.lease_revision,
        issued_at: row.updated_at,
        expires_at: row.lease_expires_at,
      },
      journal: JSON.parse(row.journal_json),
    },
    host_extension: {
      image: host.reference,
      version: host.version,
      sha256: host.sha256,
    },
    cluster_endpoint: bundle.cluster_endpoint,
    talos_admin_config: bundle.talos_admin_config,
    kubeconfig: bundle.kubeconfig,
    callback: { url: callback.href, bearer: await callbackBearer(env, row) },
  });
}
export async function thinQualificationStatus(env: Env, id: string) {
  const row = await readRow(env.DB, id);
  if (!leased(row)) return closed();
  return {
    run_id: row.id,
    step: row.step,
    lease_id: row.lease_id,
    lease_revision: row.lease_revision,
    node_uid: row.node_uid,
    release_id: row.release_id,
    spec_sha256: row.spec_sha256,
  };
}
const leaseSql = `id=? AND status='running' AND lease_id=? AND lease_revision=? AND julianday(lease_expires_at)>julianday('now')`;

/** Durable dispatch checkpoint: only new keys or dispatched->confirmed with the same nonce. */
export async function recordThinQualificationCheckpoint(
  env: Env,
  id: string,
  raw: ThinQualificationCheckpoint,
) {
  const body = ThinQualificationCheckpoint.parse(raw),
    row = await readRow(env.DB, id);
  if (!leased(row)) return closed();
  const journal = ThinQualificationJournal.parse(JSON.parse(row.journal_json));
  if (body.expected_revision !== journal.revision) return closed();
  const existing = journal.entries.find(
    (entry) => entry.key === body.entry.key,
  );
  if (
    existing &&
    (existing.state === "confirmed" ||
      body.entry.state !== "confirmed" ||
      body.entry.nonce !== existing.nonce)
  )
    return conflict("A recorded qualification step cannot be rewritten");
  // Cloudflare's receipt of each write anchors the windows its own samples are judged in.
  const entry = { ...body.entry, received_at: new Date().toISOString() };
  const next = ThinQualificationJournal.parse({
    revision: journal.revision + 1,
    entries: existing
      ? journal.entries.map((value) =>
          value.key === entry.key ? entry : value,
        )
      : [...journal.entries, entry],
  });
  const result = await env.DB.prepare(
    `UPDATE thin_storage_qualification_runs SET journal_json=?,updated_at=? WHERE ${leaseSql} AND journal_json=?`,
  )
    .bind(
      JSON.stringify(next),
      new Date().toISOString(),
      id,
      row.lease_id,
      row.lease_revision,
      row.journal_json,
    )
    .run();
  if (result.meta.changes !== 1) return closed();
  return { revision: next.revision };
}
/** Cloudflare's own measurement of its accepted samples inside a gate's journaled window: the
 * longest interval between samples during the bulk load, or the samples taken entirely while the
 * writer's LV was suspended. Without both window edges, or without a sample during the bulk load,
 * the measurement is missing and the gate cannot pass. */
async function sampleEvidence(
  env: Env,
  row: Row,
  gate: keyof typeof THIN_QUALIFICATION_SAMPLE_WINDOWS,
) {
  const journal = ThinQualificationJournal.parse(JSON.parse(row.journal_json)),
    [first, last] = THIN_QUALIFICATION_SAMPLE_WINDOWS[gate],
    edge = (key: string) =>
      journal.entries.find(
        (entry) => entry.key === key && entry.state === "confirmed",
      )?.received_at,
    from = Date.parse(edge(first) ?? ""),
    to = Date.parse(edge(last) ?? "");
  if (!(to > from)) return {};
  const samples = (
    await env.DB.prepare(
      "SELECT observed_at,received_at FROM thin_storage_qualification_samples WHERE run_id=? AND observed_at>=? AND received_at<=? ORDER BY observed_at",
    )
      .bind(row.id, new Date(from).toISOString(), new Date(to).toISOString())
      .all<{ observed_at: string; received_at: string }>()
  ).results.map((sample) => ({
    observed: Date.parse(sample.observed_at),
    received: Date.parse(sample.received_at),
  }));
  if (gate === "noflush_quiescence")
    return {
      suspended_samples: samples.filter(
        (sample) => sample.observed >= from && sample.received <= to,
      ).length,
    };
  const during = samples
    .map((sample) => sample.observed)
    .filter((observed) => observed >= from && observed <= to);
  if (!during.length) return {};
  const points = [from, ...during, to];
  return {
    longest_sample_interval_milliseconds: Math.max(
      ...points.slice(1).map((point, index) => point - points[index]!),
    ),
  };
}
function nextStep(step: string) {
  return THIN_QUALIFICATION_STEPS[
    THIN_QUALIFICATION_STEPS.indexOf(
      step as (typeof THIN_QUALIFICATION_STEPS)[number],
    ) + 1
  ];
}
/** Cloudflare decides each gate from the reported measurements; the executor's view is not trusted. */
export async function recordThinQualificationReport(
  env: Env,
  id: string,
  raw: ThinQualificationReport,
) {
  const report = ThinQualificationReport.parse(raw),
    row = await readRow(env.DB, id);
  if (!leased(row) || report.step !== row.step) return closed();
  const profile = ThinStorageProfile.parse(JSON.parse(row.profile_json)),
    now = new Date().toISOString();
  let step = nextStep(row.step) ?? "complete",
    error: string | null = null,
    setupJson = row.setup_json,
    kernel = row.kernel_version,
    gatesJson = row.gates_json,
    cleanupJson = row.cleanup_json;
  if (report.step === "setup") {
    const identity = report.setup.identity;
    if (
      !thinQualificationSetupValid(report.setup, profile) ||
      identity.node_uid !== row.node_uid ||
      identity.cluster_uid !== row.cluster_uid ||
      identity.driver_image !== row.driver_image ||
      identity.host_extension_image !== row.host_extension_image
    ) {
      error = "thin_qualification_setup_invalid";
      step = "cleanup";
    }
    setupJson = JSON.stringify(report.setup);
    kernel = identity.kernel_version;
  } else if (report.step === "cleanup") {
    cleanupJson = JSON.stringify(report.cleanup);
    step = "complete";
    if (!thinQualificationCleanupVerified(report.cleanup))
      error = "thin_qualification_cleanup_incomplete";
  } else {
    const gate = report.step as ThinQualificationGate,
      setup = row.setup_json
        ? ThinQualificationSetup.parse(JSON.parse(row.setup_json))
        : null;
    if (!setup) return closed();
    let evidence: unknown;
    if (report.step === "retained_thick_preservation") {
      const placed = await env.DB.prepare(
        "SELECT COUNT(*) count FROM databases WHERE node_id=? AND deleted_at IS NULL AND storage_profile_json IS NOT NULL",
      )
        .bind(row.node_id)
        .first<number>("count");
      evidence = {
        ...report.evidence,
        thin_profile_databases: placed ?? 0,
      };
    } else if (
      report.step === "startup_bound" ||
      report.step === "noflush_quiescence"
    )
      evidence = {
        ...report.evidence,
        ...(await sampleEvidence(env, row, report.step)),
      };
    else evidence = report.evidence;
    const pass =
      thinQualificationGatePass(gate, evidence as never, profile) &&
      (report.step !== "retained_thick_preservation" ||
        canonicalInstallation(report.evidence.baseline) ===
          canonicalInstallation(setup.thick));
    const gates = ThinQualificationGates.parse({
      ...JSON.parse(row.gates_json),
      [gate]: { pass, evidence, measured_at: now },
    });
    gatesJson = JSON.stringify(gates);
    if (!pass) {
      error = `thin_qualification_${gate}_failed`;
      step = "cleanup";
    }
  }
  const result = await env.DB.prepare(
    `UPDATE thin_storage_qualification_runs SET step=?,error_code=COALESCE(error_code,?),setup_json=?,kernel_version=?,gates_json=?,cleanup_json=?,lease_id=NULL,lease_expires_at=NULL,updated_at=?
    WHERE ${leaseSql} AND step=?`,
  )
    .bind(
      step,
      error,
      setupJson,
      kernel,
      gatesJson,
      cleanupJson,
      now,
      id,
      row.lease_id,
      row.lease_revision,
      row.step,
    )
    .run();
  if (result.meta.changes !== 1) return closed();
  return { step, status: "running" as const, waiting: false };
}
/** A turn that needs more time ends its own lease explicitly. */
export async function releaseThinQualificationTurn(env: Env, id: string) {
  const row = await readRow(env.DB, id);
  if (!leased(row)) return closed();
  const result = await env.DB.prepare(
    `UPDATE thin_storage_qualification_runs SET lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE ${leaseSql}`,
  )
    .bind(new Date().toISOString(), id, row.lease_id, row.lease_revision)
    .run();
  if (result.meta.changes !== 1) return closed();
  return { step: row.step, status: row.status, waiting: true };
}
/** The executor answered with an error, or (without a code) its container provably does not run
 * the turn: it has stopped, so exactly this lease ends now. */
export async function failThinQualificationTurn(
  env: Env,
  id: string,
  leaseId: string,
  code: string | null,
) {
  // Cleanup keeps converging on later turns; a gate or setup error ends the measurements.
  await env.DB.prepare(
    `UPDATE thin_storage_qualification_runs SET error_code=CASE WHEN step IN('cleanup','complete') THEN error_code ELSE COALESCE(error_code,?) END,
    step=CASE WHEN ?=1 AND step NOT IN('cleanup','complete') THEN 'cleanup' ELSE step END,lease_id=NULL,lease_expires_at=NULL,updated_at=?
    WHERE id=? AND status='running' AND lease_id=?`,
  )
    .bind(code, Number(code !== null), new Date().toISOString(), id, leaseId)
    .run();
}
/** A step that exhausted its bounded turns closes its measurements without inventing evidence. */
export async function expireThinQualificationStep(
  env: Env,
  id: string,
  step: string,
) {
  await env.DB.prepare(
    `UPDATE thin_storage_qualification_runs SET error_code=COALESCE(error_code,?),step=CASE WHEN step='cleanup' THEN 'complete' ELSE 'cleanup' END,updated_at=?
    WHERE id=? AND status='running' AND step=?`,
  )
    .bind(
      `thin_qualification_${step}_deadline`,
      new Date().toISOString(),
      id,
      step,
    )
    .run();
}
/** A still-held lease reports how long its turn may continue; the Workflow waits that out. */
export async function readThinQualificationStep(env: Env, id: string) {
  const row = await readRow(env.DB, id);
  return {
    step: row.step,
    status: row.status,
    lease_wait_ms: row.lease_expires_at
      ? Math.max(0, Date.parse(row.lease_expires_at) - Date.now())
      : 0,
  };
}
/** Seal a finished run: a receipt only for every gate passed by code and a verified cleanup. */
export async function completeThinQualification(env: Env, id: string) {
  const row = await readRow(env.DB, id);
  if (
    row.status !== "running" ||
    row.step !== "complete" ||
    (row.lease_expires_at && Date.parse(row.lease_expires_at) > Date.now())
  )
    return { run_id: id, status: row.status, step: row.step };
  const view = runView(row),
    now = new Date().toISOString();
  if (!row.error_code && thinQualificationPassed(view)) {
    const receipt = await installationHash(
      thinQualificationReceiptMaterial({ ...view, qualified_at: now }),
    );
    await env.DB.prepare(
      `UPDATE thin_storage_qualification_runs SET status='completed',receipt_sha256=?,qualified_at=?,completed_at=?,updated_at=?,lease_id=NULL,lease_expires_at=NULL
      WHERE id=? AND status='running' AND step='complete' AND error_code IS NULL AND gates_json=? AND cleanup_json=? AND setup_json=?`,
    )
      .bind(
        receipt,
        now,
        now,
        now,
        id,
        row.gates_json,
        row.cleanup_json,
        row.setup_json,
      )
      .run();
  } else
    await env.DB.prepare(
      `UPDATE thin_storage_qualification_runs SET status='failed',error_code=COALESCE(error_code,'thin_qualification_incomplete'),completed_at=?,updated_at=?,lease_id=NULL,lease_expires_at=NULL
      WHERE id=? AND status='running' AND step='complete'`,
    )
      .bind(now, now, id)
      .run();
  const done = await readRow(env.DB, id);
  return { run_id: id, status: done.status, step: done.step };
}

export async function issueThinQualificationTransport(
  env: Env,
  id: string,
  capability: "talos_api" | "kubernetes_api",
) {
  const input = await thinQualificationInput(env, id);
  const transport = await signNativeRelayCapability(env, {
    operation: input.run.lease.operation_id,
    node: input.run.node_id,
    region: input.run.region_id,
    revision: input.run.lease.revision,
    capability,
    address:
      capability === "talos_api"
        ? input.run.address
        : new URL(input.cluster_endpoint).hostname,
    callback: input.callback.url,
  });
  await thinQualificationInput(env, id);
  return transport;
}

/** Release approval accepts only the exact receipt of a completed qualification run. */
export async function assertThinQualificationReceipt(
  db: D1Database,
  qualification: ThinStorageQualification,
) {
  const run = await db
    .prepare(
      `SELECT 1 completed FROM thin_storage_qualification_runs WHERE status='completed' AND receipt_sha256=? AND profile_sha256=? AND driver_image=? AND host_extension_image=? AND kernel_version=? AND qualified_at=?`,
    )
    .bind(
      qualification.receipt_sha256,
      qualification.profile_sha256,
      qualification.driver_image,
      qualification.host_extension_image,
      qualification.kernel_version,
      qualification.qualified_at,
    )
    .first();
  if (!run)
    conflict(
      "Thin storage qualification must be the receipt of a completed qualification run",
    );
}
