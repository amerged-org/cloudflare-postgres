// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseRuntime,
  NodeObservationReport,
  newOperationId,
  observationVerdict,
  type NodeDatabaseObservation,
  type NodeOrderResult,
  type ObservationVerdict,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { ApiContext, Env } from "../env.ts";
import { databaseActor } from "./database-actor-sync.ts";
import { recoverFailedResume, recoverQuiescence } from "./lifecycle.ts";
import { powerTransitionStatements } from "./power-transition.ts";
import { hintDatabases } from "./node-hints.ts";
import { applyLifecycleObservations } from "./lifecycle-observations.ts";
import { USAGE_SNAPSHOT_SQL } from "./resources.ts";
import {
  withAdmissionMutation,
  type AdmissionMutation,
} from "./admission-mutations.ts";
import {
  publishDatabaseAdmission,
  type PublishSteps,
} from "./database-admission-snapshot.ts";
import type { NodeCaller } from "./node-auth.ts";
import type { DatabaseRow } from "./rows.ts";

/** How long a report waits for its admission publish (about 0.1 s) before it is answered. */
const ADMISSION_PUBLISH_ANSWER_MS = 1000;
/** How long a report of a wake the Actor claimed waits for D1 to commit the claim. */
const CLAIM_WAIT_MS = 3000;
/** How often a failed wake's recovery reads the row again when another writer won its compare-and-set. */
const FAILED_WAKE_ATTEMPTS = 3;
const FAILING = "failing";
/**
 * How many databases of one report are taken at the same time. Each is independent (a report names
 * each once) and waits mostly on D1 and on its own Actor, whose cold publish usually takes 250-1100
 * ms: 8 in flight take a report in one publish time per 8 databases, not per database.
 */
const OBSERVATION_CONCURRENCY = 8;
/**
 * How long a report may keep starting databases. The agent gives up on a request after 20 s. The
 * budget stops new starts only; it does not bound the ones started. Most databases are answered
 * within `ADMISSION_PUBLISH_ANSWER_MS` of their commit, but three paths go through
 * `withAdmissionMutation` and wait for the Actor's seed and begin, about 4 D1 round trips, the
 * publish and the hint with no bound of their own: a changed runtime of a ready database
 * (`applyObservation`), an idle sleep (`idleSleep`) and a refused sleep (`recoverQuiescence`). A
 * report of a wake the Actor claimed waits up to `CLAIM_WAIT_MS` more. So the time a report takes
 * after the budget is not bounded here. It stays correct: a report with databases left unstarted
 * is refused whole (503, retryable), and one that outlasts the agent's timeout makes the agent
 * halve its next batch; the agent keeps a report that was not answered with a success and posts it
 * again, and what was applied is applied again as the same.
 */
const OBSERVATION_BUDGET_MS = 12_000;
/** A report is logged when it took this long, or named this many databases (plan 9.9). */
const LOGGED_REPORT_MS = 2000;
const LOGGED_REPORT_DATABASES = 50;

interface Row extends DatabaseRow {
  operation: string;
  restore_operation: string | null;
  restore_status: string | null;
}
const OPERATION_OF_GENERATION = `(SELECT o.id FROM operations o WHERE o.database_id=d.id AND o.generation<=d.generation
  ORDER BY o.generation DESC,o.created_at DESC,o.id DESC LIMIT 1)`;

/**
 * Where the lifecycle row of a database stands for each state the node reports. These are the
 * statements the report's own update is followed by; each is conditional on that update, through
 * the `updated_at` it wrote, so a concurrent writer's win leaves them all unapplied.
 */
class Statements {
  readonly list: D1PreparedStatement[] = [];
  private readonly db: D1Database;
  private readonly row: Row;
  private readonly now: string;
  private readonly at: string;
  private readonly generation: number;
  constructor(
    db: D1Database,
    row: Row,
    now: string,
    at: string,
    generation: number,
  ) {
    this.db = db;
    this.row = row;
    this.now = now;
    this.at = at;
    this.generation = generation;
  }
  private applied(): { sql: string; bindings: (string | number)[] } {
    return {
      sql: "EXISTS(SELECT 1 FROM databases a WHERE a.id=? AND a.generation=? AND a.updated_at=? AND a.node_id IS NOT NULL)",
      bindings: [this.row.id, this.generation, this.now],
    };
  }
  /**
   * One lifecycle event of this generation, at most once. A wake is the event of a database whose
   * power operation is the resume or wake of this generation, and a resize the event of a
   * generation that a resize asked for.
   */
  event(
    kind: "ready" | "woke" | "hibernated" | "suspended" | "resized" | "deleted",
  ): void {
    const applied = this.applied();
    const asked =
      kind === "woke"
        ? `AND EXISTS(SELECT 1 FROM operations po WHERE po.id=d.power_operation AND po.database_id=d.id
             AND po.generation=d.generation AND po.kind IN('database.resume','database.wake'))`
        : kind === "resized"
          ? `AND EXISTS(SELECT 1 FROM operations ro WHERE ro.database_id=d.id AND ro.kind='database.resize'
               AND ro.generation<=d.generation AND ro.status IN('pending','running')
               AND NOT EXISTS(SELECT 1 FROM operations newer WHERE newer.database_id=ro.database_id
                 AND newer.kind='database.resize' AND newer.generation>ro.generation))`
          : "";
    this.list.push(
      this.db
        .prepare(
          `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
           SELECT d.id,?,d.node_id,d.size_class_id,d.generation,?,${USAGE_SNAPSHOT_SQL}
           FROM databases d JOIN database_resources r ON r.database_id=d.id
           WHERE d.id=? AND d.generation=? AND ${applied.sql} ${asked}
             AND NOT EXISTS(SELECT 1 FROM lifecycle_events WHERE database_id=d.id AND kind=? AND generation=d.generation)`,
        )
        .bind(
          kind,
          this.at,
          this.row.id,
          this.generation,
          ...applied.bindings,
          kind,
        ),
    );
  }
  /** The operations of the kinds that end with this report. */
  succeed(kinds: readonly string[], id?: string | null): void {
    const applied = this.applied();
    this.list.push(
      this.db
        .prepare(
          `UPDATE operations SET status='succeeded',updated_at=?,completed_at=?
           WHERE database_id=? AND project_id=? AND generation<=? AND status IN('pending','running')
             AND kind IN(SELECT value FROM json_each(?)) ${id ? "AND id=?" : ""}
             AND NOT EXISTS(SELECT 1 FROM operations newer WHERE newer.database_id=operations.database_id
               AND newer.kind=operations.kind AND newer.kind='database.resize' AND newer.generation>operations.generation)
             AND ${applied.sql}`,
        )
        .bind(
          this.now,
          this.now,
          this.row.id,
          this.row.project_id,
          this.generation,
          JSON.stringify(kinds),
          ...(id ? [id] : []),
          ...applied.bindings,
        ),
    );
  }
  fail(kinds: readonly string[], code: string, message: string): void {
    const applied = this.applied();
    this.list.push(
      this.db
        .prepare(
          `UPDATE operations SET status='failed',error_code=?,error_message=?,updated_at=?,completed_at=?
           WHERE database_id=? AND project_id=? AND generation<=? AND status IN('pending','running')
             AND kind IN(SELECT value FROM json_each(?)) AND ${applied.sql}`,
        )
        .bind(
          code,
          message,
          this.now,
          this.now,
          this.row.id,
          this.row.project_id,
          this.generation,
          JSON.stringify(kinds),
          ...applied.bindings,
        ),
    );
  }
  /** A report that is not an end moves the pending operations of its generation to running. */
  running(): void {
    const applied = this.applied();
    this.list.push(
      this.db
        .prepare(
          `UPDATE operations SET status='running',updated_at=?
           WHERE database_id=? AND project_id=? AND generation<=? AND status='pending' AND ${applied.sql}`,
        )
        .bind(
          this.now,
          this.row.id,
          this.row.project_id,
          this.generation,
          ...applied.bindings,
        ),
    );
  }
  /** The roles the node removed or could not drop (plan 5.3). */
  roles(removed: readonly string[], blocked: readonly string[]): void {
    const applied = this.applied();
    if (removed.length)
      this.list.push(
        this.db
          .prepare(
            `UPDATE role_deletions SET status='succeeded',updated_at=?,completed_at=?
             WHERE database_id=? AND project_id=? AND status IN('pending','running') AND generation<=?
               AND role_name IN(SELECT value FROM json_each(?)) AND ${applied.sql}`,
          )
          .bind(
            this.now,
            this.now,
            this.row.id,
            this.row.project_id,
            this.generation,
            JSON.stringify(removed),
            ...applied.bindings,
          ),
        // The role is gone from PostgreSQL: its tombstone, with the credential it held, and its
        // name are free.
        this.db
          .prepare(
            `DELETE FROM roles WHERE database_id=? AND deleted_at IS NOT NULL AND name IN(SELECT value FROM json_each(?)) AND ${applied.sql}`,
          )
          .bind(this.row.id, JSON.stringify(removed), ...applied.bindings),
      );
    if (blocked.length)
      this.list.push(
        this.db
          .prepare(
            `UPDATE role_deletions SET status='failed',error_code='role_not_droppable',error_message=?,updated_at=?,completed_at=?
             WHERE database_id=? AND project_id=? AND status IN('pending','running') AND generation<=?
               AND role_name IN(SELECT value FROM json_each(?)) AND ${applied.sql}`,
          )
          .bind(
            "The role owns objects or holds privileges and cannot be dropped; it stays unable to log in until they are removed",
            this.now,
            this.now,
            this.row.id,
            this.row.project_id,
            this.generation,
            JSON.stringify(blocked),
            ...applied.bindings,
          ),
      );
  }
  /** A removal still waiting when the database sleeps ends as for any sleeping database. */
  sleepEndsRoleRemovals(): void {
    const applied = this.applied();
    this.list.push(
      this.db
        .prepare(
          `UPDATE role_deletions SET status='succeeded',updated_at=?,completed_at=?
           WHERE database_id=? AND project_id=? AND status IN('pending','running') AND generation<=? AND ${applied.sql}`,
        )
        .bind(
          this.now,
          this.now,
          this.row.id,
          this.row.project_id,
          this.generation,
          ...applied.bindings,
        ),
    );
  }
  verifyRestore(operation: string): void {
    const applied = this.applied();
    this.list.push(
      this.db
        .prepare(
          `UPDATE database_restores SET verified_at=COALESCE(verified_at,?) WHERE target_database_id=? AND operation_id=? AND ${applied.sql}`,
        )
        .bind(this.now, this.row.id, operation, ...applied.bindings),
    );
  }
}

function archiveHealth(
  row: Row,
  observation: NodeDatabaseObservation,
  now: string,
): { health: "ok" | "failing" | "unknown"; since: string | null } {
  const { archive } = observation;
  const health =
    archive.failing_since !== null
      ? FAILING
      : archive.ready_files === null
        ? "unknown"
        : "ok";
  return {
    health,
    since:
      health === FAILING
        ? archive.failing_since
        : health === row.archiving_health
          ? row.archiving_health_since
          : now,
  };
}

/** What `databases.status_message` holds at most, in characters. */
const STATUS_MESSAGE_LIMIT = 4096;
/** An error's name leads its message; the column takes the first characters of the two. */
function statusMessage(observation: NodeDatabaseObservation): string | null {
  const text =
    observation.state === "error" && observation.error
      ? `${observation.error}${observation.message ? `: ${observation.message}` : ""}`
      : (observation.message ?? null);
  return text === null
    ? null
    : Array.from(text).slice(0, STATUS_MESSAGE_LIMIT).join("");
}

/** The columns every applied report writes: the archive, the backup, the message. */
function reportedColumns(
  row: Row,
  observation: NodeDatabaseObservation,
  reportedAt: string,
  now: string,
) {
  const health = archiveHealth(row, observation, now),
    backup = observation.backup,
    newer =
      backup !== null &&
      (row.backup_observed_at == null || reportedAt > row.backup_observed_at);
  return {
    message: statusMessage(observation),
    health: health.health,
    since: health.since,
    backup_observed_at: newer ? reportedAt : (row.backup_observed_at ?? null),
    backup_health: newer ? "ok" : (row.backup_health ?? "unknown"),
    backup_last_completed_at: newer
      ? backup.completed_at
      : (row.backup_last_completed_at ?? null),
  };
}

/**
 * Applies one accepted report of a database. Returns whether D1 took it: the update is a
 * compare-and-set on the row it was made from, so a concurrent change wins and the node is told
 * its report conflicted.
 */
async function applyObservation(
  env: Env,
  node: NodeCaller,
  row: Row,
  observation: NodeDatabaseObservation,
  reportedAt: string,
): Promise<boolean> {
  const db = env.DB,
    now = new Date().toISOString(),
    generation = observation.generation,
    columns = reportedColumns(row, observation, reportedAt, now);
  const states = {
    running: row.desired_state === "running",
    suspended: row.desired_state === "suspended",
    deleted: row.desired_state === "deleted",
  };
  // What the report sets; the rest of the row stays.
  let set: {
    state: string;
    power: string;
    applied: boolean;
    runtime: string | null;
  };
  switch (observation.state) {
    case "ready":
      if (!states.running) return false;
      set = {
        state: "ready",
        power: "awake",
        applied: true,
        runtime: JSON.stringify(
          DatabaseRuntime.parse({
            database_id: row.id,
            node_id: node.id,
            generation,
            storage_generation: observation.storage_generation,
            instance: observation.instance!.toLowerCase(),
            observed_at: Date.now(),
          }),
        ),
      };
      break;
    case "asleep":
      if (states.deleted) return false;
      set = {
        state: "provisioning",
        power: "hibernated",
        applied: true,
        runtime: null,
      };
      break;
    case "building":
    case "unproven":
      if (states.deleted) return false;
      set = {
        state: "provisioning",
        power: row.observed_power ?? "awake",
        applied: false,
        runtime: null,
      };
      break;
    case "error":
      set = {
        state: "error",
        power: row.observed_power ?? "awake",
        applied: false,
        runtime: null,
      };
      break;
    case "deleted":
      if (!states.deleted) return false;
      set = { state: "deleted", power: "awake", applied: true, runtime: null };
      break;
  }
  const restoring = row.restore_operation !== null;
  if (
    observation.state === "ready" &&
    restoring &&
    row.restore_status === "failed"
  )
    return false;
  const wasReady =
    row.observed_state === "ready" &&
    row.observed_power === "awake" &&
    row.observed_generation === row.generation;
  const runtimeChanged =
    wasReady &&
    (observation.state !== "ready" ||
      !row.runtime_json ||
      (JSON.parse(row.runtime_json) as { instance?: string }).instance !==
        observation.instance?.toLowerCase());
  const execute = async (mutation?: AdmissionMutation) => {
    const guard = mutation?.guard(row.id),
      statements = new Statements(db, row, now, reportedAt, generation);
    statements.list.push(
      db
        .prepare(
          `UPDATE databases SET observed_state=?,observed_power=?,
             observed_generation=CASE WHEN ? THEN ? ELSE observed_generation END,
             runtime_json=CASE WHEN ?='ready' THEN ? ELSE NULL END,
             proven_sleep_json=CASE WHEN ?='asleep' THEN ? ELSE proven_sleep_json END,
             status_message=?,archiving_health=?,archiving_health_since=?,
             backup_observed_at=?,backup_health=?,backup_last_completed_at=?,updated_at=?
           WHERE id=? AND node_id=? AND generation=? AND updated_at=? AND desired_state=? AND observed_state=?
             AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=databases.node_id AND n.lost_at IS NULL)
             AND (${guard?.sql ?? "1=1"})`,
        )
        .bind(
          set.state,
          set.power,
          Number(set.applied),
          generation,
          observation.state,
          set.runtime,
          observation.state,
          JSON.stringify(observation.proven_sleep),
          columns.message,
          columns.health,
          columns.since,
          columns.backup_observed_at,
          columns.backup_health,
          columns.backup_last_completed_at,
          now,
          row.id,
          node.id,
          generation,
          row.updated_at,
          row.desired_state,
          row.observed_state,
          ...(guard?.bindings ?? []),
        ),
    );
    switch (observation.state) {
      case "ready":
        statements.event("ready");
        statements.event("woke");
        statements.event("resized");
        statements.succeed(
          [restoring ? "database.restore" : "database.create"],
          null,
        );
        statements.succeed(["database.resize"], null);
        statements.succeed(
          ["database.resume", "database.wake"],
          row.power_operation,
        );
        if (restoring) statements.verifyRestore(row.restore_operation!);
        statements.roles(
          observation.roles?.removed ?? [],
          observation.roles?.blocked ?? [],
        );
        break;
      case "asleep":
        // A running database the node reports asleep has its wake pending: the sleep stands, and
        // the wake's own result ends the operation that asked.
        if (states.suspended) {
          statements.event(
            row.suspension_reason === "idle" ? "hibernated" : "suspended",
          );
          statements.succeed(
            ["database.suspend", "database.hibernate"],
            row.power_operation,
          );
          statements.succeed(["database.resize"], null);
          statements.sleepEndsRoleRemovals();
        }
        break;
      case "deleted":
        statements.event("deleted");
        statements.succeed(["database.delete"], null);
        break;
      case "error":
        statements.fail(
          [
            "database.create",
            "database.restore",
            "database.resize",
            "database.resume",
            "database.wake",
          ],
          observation.error!,
          observation.message ?? observation.error!,
        );
        break;
      default:
        statements.running();
    }
    return mutation
      ? mutation.batch(statements.list)
      : db.batch(statements.list);
  };
  const committing = Date.now();
  const result = await (runtimeChanged
    ? withAdmissionMutation(env, [row.id], execute)
    : execute());
  const committed = Date.now();
  if (result[0]!.meta.changes !== 1) return false;
  return afterCommit(env, row, observation, wasReady, runtimeChanged, {
    committing,
    committed,
  });
}

/** The push that releases a waiting connection and the publish of the Actor's snapshot. */
async function afterCommit(
  env: Env,
  row: Row,
  observation: NodeDatabaseObservation,
  wasReady: boolean,
  invalidated: boolean,
  timing: { committing: number; committed: number },
): Promise<true> {
  const becameReady = observation.state === "ready" && !wasReady;
  // A waiting connection needs only the committed ready state: push it now, ahead of and
  // independent of the publish, whatever that takes. The Actor's bounded fallback read recovers
  // a lost push.
  const pushStarted = Date.now();
  let pushMilliseconds: number | null = null;
  const pushing = becameReady
    ? databaseActor(env, row.id)
        .observedReady(
          row.id,
          observation.generation,
          row.power_operation ?? null,
        )
        .catch(() => false)
        .then(() => {
          pushMilliseconds = Date.now() - pushStarted;
        })
    : undefined;
  const steps: PublishSteps = {};
  let publishedAt: number | null = null;
  const publishing = invalidated
    ? undefined
    : publishDatabaseAdmission(env, row.id, undefined, steps).then((value) => {
        publishedAt = Date.now();
        return value;
      });
  if (publishing) {
    // A publish is a few Actor RPCs and D1 reads. A failure within the bound fails this report,
    // so the node sends it again; one still running after it finishes in the background.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      publishing.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ADMISSION_PUBLISH_ANSWER_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!settled)
      void publishing.catch((error) =>
        console.error(
          JSON.stringify({
            event: "admission_publish_failed",
            database_id: row.id,
            error: error instanceof Error ? error.name : "error",
          }),
        ),
      );
  }
  if (
    becameReady ||
    (observation.state === "asleep" && row.observed_power !== "hibernated")
  )
    void Promise.all([pushing, publishing?.catch(() => undefined)]).then(() =>
      console.log(
        JSON.stringify({
          event: "observation_commit",
          database_id: row.id,
          operation: row.power_operation ?? null,
          generation: observation.generation,
          state: observation.state,
          at_ms: Date.now(),
          d1_ms: timing.committed - timing.committing,
          publish_ms:
            publishedAt === null ? null : publishedAt - timing.committed,
          push_ms: pushMilliseconds,
          publish_steps: steps,
        }),
      ),
    );
  return true;
}

/**
 * A node that put an awake database to sleep on its own, after its idle time, reports the proven
 * sleep: D1 records the sleep as the hibernation it is, a new generation with its own operation,
 * and the node's report applies to it.
 */
async function idleSleep(
  env: Env,
  node: NodeCaller,
  row: Row,
  observation: NodeDatabaseObservation,
  reportedAt: string,
): Promise<boolean> {
  const now = new Date().toISOString(),
    operation = newOperationId(),
    generation = row.generation + 1,
    columns = reportedColumns(row, observation, reportedAt, now);
  const result = await withAdmissionMutation(
    env,
    [row.id],
    async (mutation) => {
      const guard = mutation.guard(row.id),
        transition = powerTransitionStatements(
          env.DB,
          row,
          "hibernate",
          operation,
          now,
          undefined,
          guard,
        ),
        next: Row = {
          ...row,
          generation,
          desired_state: "suspended",
          suspension_reason: "idle",
          power_operation: operation,
          updated_at: now,
        },
        statements = new Statements(env.DB, next, now, reportedAt, generation);
      statements.list.push(
        env.DB.prepare(
          `UPDATE databases SET observed_state='provisioning',observed_power='hibernated',observed_generation=generation,
             runtime_json=NULL,proven_sleep_json=?,status_message=?,archiving_health=?,archiving_health_since=?,
             backup_observed_at=?,backup_health=?,backup_last_completed_at=?
           WHERE id=? AND node_id=? AND generation=? AND updated_at=? AND power_operation=? AND desired_state='suspended'`,
        ).bind(
          JSON.stringify(observation.proven_sleep),
          columns.message,
          columns.health,
          columns.since,
          columns.backup_observed_at,
          columns.backup_health,
          columns.backup_last_completed_at,
          row.id,
          node.id,
          generation,
          now,
          operation,
        ),
      );
      statements.event("hibernated");
      statements.succeed(["database.hibernate"], operation);
      statements.sleepEndsRoleRemovals();
      return mutation.batch([...transition, ...statements.list]);
    },
  );
  return result[0]!.meta.changes === 1;
}

async function readRow(
  env: Env,
  id: string,
  nodeId: string,
): Promise<Row | null> {
  return env.DB.prepare(
    `SELECT d.*,${OPERATION_OF_GENERATION} operation,x.operation_id restore_operation,ro.status restore_status
     FROM databases d LEFT JOIN database_restores x ON x.target_database_id=d.id
     LEFT JOIN operations ro ON ro.id=x.operation_id AND ro.kind='database.restore'
     WHERE d.id=? AND d.node_id=?`,
  )
    .bind(id, nodeId)
    .first<Row>();
}

/** One database of a report: the verdict on its generation, then the update that verdict allows. */
async function takeObservation(
  env: Env,
  node: NodeCaller,
  reportedAt: string,
  observation: NodeDatabaseObservation,
): Promise<ObservationVerdict> {
  let row = await readRow(env, observation.id, node.id);
  // A database this node does not serve is not this node's to report.
  if (row === null) return "stale";
  const desired = () => ({
    generation: row!.generation,
    operation: row!.operation,
  });
  const reported = {
    generation: observation.generation,
    operation: observation.operation,
  };
  let claim: { generation: number; operation: string } | null = null;
  if (observation.generation === row.generation + 1)
    claim = await databaseActor(env, row.id).pendingTicket();
  const verdict = observationVerdict(desired(), claim, reported);
  if (verdict !== "accept") return verdict;
  if (observation.generation !== row.generation) {
    // The node released a wake whose claim D1 has not committed: the report waits for the commit.
    await databaseActor(env, row.id).awaitTicketClaim(
      claim!.operation,
      CLAIM_WAIT_MS,
    );
    row = await readRow(env, observation.id, node.id);
    if (
      row === null ||
      row.generation !== observation.generation ||
      row.operation !== observation.operation
    )
      return "conflict";
  }
  // A unit of a storage generation D1 does not name is a retired volume or an unknown one; the
  // page wins and the node applies the entry it names.
  if (observation.storage_generation !== row.storage_generation)
    return "conflict";
  // A database D1 knew awake at this generation, ready or found unproven after a crash, that the
  // node reports asleep: the node slept it on its own. One never ready has no observed generation.
  if (
    observation.state === "asleep" &&
    row.desired_state === "running" &&
    row.observed_power === "awake" &&
    row.observed_generation === row.generation
  )
    return (await idleSleep(env, node, row, observation, reportedAt))
      ? "accept"
      : "conflict";
  if (observation.refusal !== undefined) {
    // A sleep the node refused: the database stays awake and wakeable (plan 3.3). The refusal is
    // final for its generation, so it ends the suspend or hibernation that asked.
    if (row.desired_state !== "suspended" || !row.power_operation)
      return "conflict";
    const recovered = await recoverQuiescence(
      env,
      {
        databaseId: row.id,
        operation: row.power_operation,
        revision: row.generation,
      },
      observation.refusal === "power_busy" ? "busy" : "archive",
      new Date().toISOString(),
    );
    if (recovered) await hintDatabases(env, [row.id]).catch(() => 0);
    return recovered ? "accept" : "conflict";
  }
  return (await applyObservation(env, node, row, observation, reportedAt))
    ? "accept"
    : "conflict";
}

/**
 * How a wake the node was ordered ended: a wake that failed ends the resume that asked, and the
 * database is suspended again (`recoverFailedResume`), since the node runs an order once and a
 * database that is to run and sleeps would otherwise be left for nothing to wake. The other orders
 * keep their results with the lifecycle (`applyLifecycleObservations`); a fence is a lost node and
 * has no row.
 */
async function failedWake(
  env: Env,
  node: NodeCaller,
  result: NodeOrderResult,
): Promise<number> {
  if (result.status !== "failed") return 0;
  // The row is read again when another writer won the compare-and-set; the result comes once.
  for (let attempt = 0; attempt < FAILED_WAKE_ATTEMPTS; attempt++) {
    const row = await env.DB.prepare(
      `SELECT d.id,d.generation FROM databases d JOIN operations o ON o.id=d.power_operation AND o.database_id=d.id AND o.kind='database.resume' AND o.status IN('pending','running')
       WHERE o.id=? AND d.node_id=? AND d.desired_state='running' AND d.deleted_at IS NULL`,
    )
      .bind(result.operation, node.id)
      .first<{ id: string; generation: number }>();
    if (row === null) return 0;
    const recovered = await recoverFailedResume(
      env,
      {
        databaseId: row.id,
        operation: result.operation,
        revision: row.generation,
      },
      result.reason ?? "wake_failed",
    );
    if (recovered) {
      await hintDatabases(env, [row.id]).catch(() => 0);
      return 1;
    }
  }
  return 0;
}

interface Taken {
  /** One verdict per database of the report, at the index the report names it. */
  verdicts: ObservationVerdict[];
  /** The databases of the report that were not started. */
  deferred: number;
  /** The longest one database took, in milliseconds. */
  slowest: number;
}

/**
 * Takes the databases of a report, `OBSERVATION_CONCURRENCY` at a time, none twice and none after
 * the budget is spent. A failure of any stops the starts; the ones in flight finish, and the first
 * failure is the report's.
 */
async function takeObservations(
  env: Env,
  node: NodeCaller,
  report: NodeObservationReport,
  started: number,
  budgetMs: number,
): Promise<Taken> {
  const { databases } = report;
  const taken: Taken = { verdicts: [], deferred: 0, slowest: 0 };
  const state: { next: number; failure?: { cause: unknown } } = { next: 0 };
  const worker = async () => {
    while (
      state.failure === undefined &&
      state.next < databases.length &&
      Date.now() - started < budgetMs
    ) {
      const index = state.next++,
        at = Date.now();
      try {
        taken.verdicts[index] = await takeObservation(
          env,
          node,
          report.observed_at,
          databases[index]!,
        );
      } catch (cause) {
        state.failure ??= { cause };
        return;
      }
      taken.slowest = Math.max(taken.slowest, Date.now() - at);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(OBSERVATION_CONCURRENCY, databases.length) },
      worker,
    ),
  );
  if (state.failure) throw state.failure.cause;
  taken.deferred = databases.length - state.next;
  return taken;
}

/** One line for a report that was large or slow: what it held and where its time went (plan 9.9). */
function logReport(
  node: NodeCaller,
  report: NodeObservationReport,
  taken: Taken,
  started: number,
): void {
  const elapsed = Date.now() - started;
  if (
    elapsed < LOGGED_REPORT_MS &&
    report.databases.length < LOGGED_REPORT_DATABASES
  )
    return;
  const counts = { accept: 0, stale: 0, conflict: 0 };
  for (const verdict of taken.verdicts) if (verdict) counts[verdict]++;
  console.log(
    JSON.stringify({
      event: "node_observation_report",
      node_id: node.id,
      databases: report.databases.length,
      ...counts,
      deferred: taken.deferred,
      elapsed_ms: elapsed,
      slowest_ms: taken.slowest,
    }),
  );
}

/**
 * `POST /node/v1/observations` (plan 5.3): what a node reports of its databases and its orders,
 * and the events of its own log.
 */
export async function nodeObservations(
  c: ApiContext,
  node: NodeCaller,
  raw: unknown,
  budgetMs = OBSERVATION_BUDGET_MS,
): Promise<Response> {
  const parsed = NodeObservationReport.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid observations");
  const report = parsed.data;
  if (Date.parse(report.observed_at) > Date.now() + 300_000)
    throw new ApiError("invalid_request", "Observation time is in the future");
  const started = Date.now();
  // A fenced node's observations are read for the results of its orders only.
  const taken: Taken = node.fenced
    ? { verdicts: [], deferred: 0, slowest: 0 }
    : await takeObservations(c.env, node, report, started, budgetMs);
  if (taken.deferred > 0) {
    logReport(node, report, taken, started);
    throw new ApiError(
      "capacity_exhausted",
      "The report did not fit its time; send it again",
      { reason: "not_ready" },
    );
  }
  const databases = node.fenced
    ? []
    : report.databases.map((observation, index) => ({
        id: observation.id,
        verdict: taken.verdicts[index]!,
      }));
  let orders = 0;
  for (const result of report.orders)
    orders += await failedWake(c.env, node, result);
  // The results of the other orders, the moves they unlock and the recovery points of the databases.
  orders += await applyLifecycleObservations(c.env, node.id, report);
  // The node's own log lines (plan 9.9): one line of Workers Logs each, kept nowhere else. A log
  // key is never replaced by a field of the same name. A report the API applied but whose answer the
  // node never got is sent again, so a line can appear twice: a query that counts events counts
  // identical lines once.
  for (const { event, at, database_id, fields } of report.events ?? [])
    console.log(
      JSON.stringify({
        ...fields,
        event: "node_event",
        node_id: node.id,
        node_event: event,
        at,
        ...(database_id === undefined ? {} : { database_id }),
      }),
    );
  logReport(node, report, taken, started);
  return c.json({ databases, orders });
}
