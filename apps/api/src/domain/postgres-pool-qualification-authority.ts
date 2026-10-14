// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseStorageVolumeReceipt,
  thinStorageAuthorityMatches,
  thinStorageInventory,
} from "@pgcf/contracts";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import {
  PostgresPoolPolicy,
  POSTGRES_POOL,
} from "@pgcf/contracts/postgres-pool";
import { PostgresPoolQualificationScope } from "../../../../packages/contracts/src/postgres-pool-qualification.ts";
import type { Env } from "../env.ts";
import { installationHash } from "./node-installation.ts";
import { readCurrentNodeThinStorage } from "./node-thin-storage.ts";
import { postgresPoolQualificationCapable } from "./fleet-releases.ts";
import { readPostgresPoolDatabaseContext } from "./postgres-pool-context.ts";
import type { AdmissionSqlGuard } from "./admission-mutations.ts";

import { readPostgresPoolFleetFence } from "./postgres-pool-fleet-fence.ts";
import { readPostgresPoolHostController } from "./postgres-pool-host.ts";

const brand: unique symbol = Symbol("validated-postgres-pool-qualification");
export interface PostgresPoolQualificationAuthority {
  readonly [brand]: true;
  readonly run_id: string;
  readonly scope_sha256: string;
  readonly expires_at: number;
  readonly scope: PostgresPoolQualificationScope;
  readonly policy: PostgresPoolPolicy;
  readonly policy_revision: 1;
  readonly evidence_json: string;
  readonly claim_ready: boolean;
  readonly fence: AdmissionSqlGuard;
}
interface Run {
  id: string;
  region_id: string;
  node_id: string;
  node_uid: string;
  boot_id: string;
  database_id: string;
  database_generation: number;
  candidate_release_id: string;
  candidate_spec_sha256: string;
  scope_sha256: string;
  scope_json: string;
  expires_at: number;
  spec_json: string;
  spec_sha256: string;
  evidence_json: string;
  created_at: number;
}
/** The active row is the sole override. A request cannot supply a receipt or a passed boolean. */
export async function readPostgresPoolQualificationSetup(
  env: Env,
  id: string,
  wakeGeneration: number,
  now = Date.now(),
): Promise<PostgresPoolQualificationAuthority | undefined> {
  const state = await readPostgresPoolDatabaseContext(env, id),
    { row } = state;
  if (!(await postgresPoolQualificationCapable(env.DB, row.region_id)))
    return undefined;
  const run = await env.DB.prepare(
    `SELECT q.*,s.spec_json,s.spec_sha256 FROM postgres_pool_qualification_runs q
    JOIN fleet_releases s ON s.id=q.candidate_release_id JOIN fleet_region_releases f ON f.region_id=q.region_id AND f.release_id=s.id
    JOIN fleet_node_releases a ON a.node_id=q.node_id AND a.node_uid=q.node_uid AND a.release_id=s.id
    WHERE q.database_id=? AND q.status='running' AND q.expires_at>?`,
  )
    .bind(id, now)
    .first<Run>();
  if (!run) return undefined;
  const parsed = PostgresPoolQualificationScope.safeParse(
    JSON.parse(run.scope_json),
  );
  const candidate = FleetReleaseSpec.safeParse(JSON.parse(run.spec_json));
  if (!parsed.success || !candidate.success) return undefined;
  const scope = parsed.data,
    spec = candidate.data;
  if (
    run.id !== scope.run_id ||
    run.region_id !== scope.region_id ||
    run.node_id !== scope.node_id ||
    run.node_uid !== scope.node_uid ||
    run.boot_id !== scope.boot_id ||
    run.database_id !== scope.database_id ||
    run.database_generation !== scope.database_generation ||
    run.candidate_release_id !== scope.candidate_release_id ||
    run.candidate_spec_sha256 !== scope.candidate_spec_sha256 ||
    run.spec_sha256 !== scope.candidate_spec_sha256 ||
    (await installationHash(scope)) !== run.scope_sha256 ||
    (await installationHash(spec)) !== run.spec_sha256 ||
    scope.database_generation !== wakeGeneration ||
    row.region_id !== scope.region_id ||
    row.node_id !== scope.node_id ||
    row.node_uid !== scope.node_uid ||
    row.boot_id !== scope.boot_id ||
    row.ready !== 1 ||
    row.lost_at !== null ||
    row.deleted_at !== null ||
    row.project_deleted_at !== null ||
    !(
      (row.generation === wakeGeneration - 1 &&
        row.desired_state === "suspended" &&
        row.observed_power === "hibernated" &&
        row.observed_generation === row.generation) ||
      (row.generation === wakeGeneration && row.desired_state === "running")
    ) ||
    state.fingerprint !== scope.configuration_fingerprint ||
    row.image !== scope.software.postgres_image ||
    JSON.stringify(state.desired.storage) !== JSON.stringify(scope.storage) ||
    spec.postgres_pool_qualification_version !== 1 ||
    !spec.postgres_pool_candidate ||
    spec.postgres_pool_candidate.driver_sha256 !==
      scope.software.driver_sha256 ||
    spec.postgres_pool_candidate.supervisor_sha256 !==
      scope.software.supervisor_sha256 ||
    spec.postgres_pool_candidate.host_controller_sha256 !==
      scope.software.host_controller_sha256
  )
    return undefined;
  const receipt = DatabaseStorageVolumeReceipt.safeParse(
    row.storage_volume_json ? JSON.parse(row.storage_volume_json) : null,
  );
  if (
    !receipt.success ||
    JSON.stringify(receipt.data) !== JSON.stringify(scope.volume)
  )
    return undefined;
  const pins: { [name: string]: string } = {
    "openebs-lvm": scope.software.driver_image,
    "pool-supervisor": scope.software.supervisor_image,
    postgres: scope.software.postgres_image,
    barman: scope.software.archiver_image,
    "pgcf-sandbox-controller": scope.software.host_extension_image,
  };
  if (
    !Object.entries(pins).every(([name, reference]) =>
      spec.components.some(
        (c) =>
          c.name === name && c.kind === "image" && c.reference === reference,
      ),
    )
  )
    return undefined;
  const current = await readCurrentNodeThinStorage(env, scope.node_id, now);
  if (
    !current?.authority ||
    current.row.current_qualified !== 1 ||
    current.row.cluster_uid !== scope.cluster_uid ||
    (
      JSON.parse(current.row.qualification_json ?? "null") as {
        boot_id?: unknown;
      } | null
    )?.boot_id !== scope.boot_id ||
    !thinStorageAuthorityMatches(
      scope.storage,
      current.authority,
      undefined,
      now,
    ) ||
    thinStorageInventory(current.authority).expires_at <= now ||
    spec.thin_storage_qualification?.kernel_version !==
      scope.software.kernel_version
  )
    return undefined;
  const cpu =
      state.class.cpu_request_millicores +
      POSTGRES_POOL.archiver_cpu_request_millicores,
    memory =
      Math.ceil(state.class.memory_request_bytes / 1024 ** 2) +
      POSTGRES_POOL.archiver_memory_request_mib;
  if (cpu > 2000 || memory > 2048) return undefined;
  const host = await readPostgresPoolHostController(
    env,
    scope.node_id,
    scope.node_uid,
  );
  if (!host || host.sha256 !== scope.software.host_controller_sha256)
    return undefined;
  const policy = PostgresPoolPolicy.parse({
    version: 1,
    kind: "postgres_pods",
    target_slots: 1,
    max_idle_cpu_millicores: cpu,
    max_idle_memory_mib: memory,
    idle_cpu_millicores: cpu,
    idle_memory_mib: memory,
    release_id: scope.candidate_release_id,
    class: state.class,
    driver_image: scope.software.driver_image,
    driver_sha256: scope.software.driver_sha256,
    supervisor_image: scope.software.supervisor_image,
    supervisor_sha256: scope.software.supervisor_sha256,
    host_controller_sha256: scope.software.host_controller_sha256,
    archiver_image: scope.software.archiver_image,
    archiver_sha256: spec.components.find((c) => c.name === "barman")!.sha256,
  });
  const fence: AdmissionSqlGuard = {
    sql: `EXISTS(SELECT 1 FROM postgres_pool_qualification_runs q JOIN databases d ON d.id=q.database_id
      JOIN regions qr ON qr.id=q.region_id JOIN nodes n ON n.id=d.node_id
      JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid
      JOIN fleet_node_release_observations o ON o.node_id=n.id AND o.node_uid=n.node_uid AND o.assignment_revision=a.revision
      JOIN fleet_releases s ON s.id=a.release_id WHERE q.id=? AND q.status='running' AND q.scope_sha256=? AND q.scope_json=?
      AND q.expires_at=? AND q.evidence_json=? AND q.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
      AND d.id=? AND d.generation=? AND d.node_id=? AND d.storage_profile_json=? AND d.storage_volume_json=?
      AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL AND json_extract(o.facts_json,'$.boot_id')=?
      AND s.id=? AND s.spec_sha256=?)`,
    bindings: [
      run.id,
      run.scope_sha256,
      run.scope_json,
      run.expires_at,
      run.evidence_json,
      id,
      row.generation,
      row.node_id,
      row.storage_profile_json!,
      row.storage_volume_json!,
      scope.node_uid,
      scope.boot_id,
      scope.candidate_release_id,
      scope.candidate_spec_sha256,
    ],
  };
  const fleet = await readPostgresPoolFleetFence(env.DB, row.region_id, true);
  if (!fleet) return undefined;
  fence.sql = `(${fence.sql}) AND (${fleet.sql})`;
  fence.bindings.push(...fleet.bindings);
  fence.sql += ` AND EXISTS(SELECT 1 FROM node_compute_pool_policies p JOIN node_host_configurations h ON h.node_id=p.node_id AND h.node_uid=p.node_uid
    WHERE p.node_id=? AND p.node_uid=? AND p.policy_json=? AND h.profile_sha256=? AND h.sha256=?)`;
  fence.bindings.push(
    scope.node_id,
    scope.node_uid,
    host.policy_json,
    host.profile_sha256,
    host.host_sha256,
  );
  return {
    [brand]: true,
    run_id: run.id,
    scope_sha256: run.scope_sha256,
    expires_at: run.expires_at,
    scope,
    policy,
    policy_revision: 1,
    evidence_json: run.evidence_json,
    claim_ready: prewakePrefixAccepted(run.evidence_json),
    fence,
  };
}
function prewakePrefixAccepted(raw: string): boolean {
  const journal = JSON.parse(raw) as {
    version?: unknown;
    entries?: { sequence?: unknown; measurement?: { gate?: unknown } }[];
  };
  return (
    journal.version === 1 &&
    Array.isArray(journal.entries) &&
    journal.entries.length >= 2 &&
    journal.entries[0]?.sequence === 1 &&
    journal.entries[0]?.measurement?.gate === "host_mount_context" &&
    journal.entries[1]?.sequence === 2 &&
    journal.entries[1]?.measurement?.gate === "finite_creator_fence"
  );
}
/** Only the accepted ordered prewake prefix upgrades setup into claim authority. */
export async function readPostgresPoolQualificationAuthority(
  env: Env,
  id: string,
  wakeGeneration: number,
  now = Date.now(),
) {
  const setup = await readPostgresPoolQualificationSetup(
    env,
    id,
    wakeGeneration,
    now,
  );
  return setup?.claim_ready ? setup : undefined;
}
