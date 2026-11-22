// SPDX-License-Identifier: Apache-2.0
// The words about each public error code, reason and connection refusal. `docs/errors.md` is
// rendered from here (test/error-guide.test.ts keeps the two equal); a code or reason without an
// entry does not typecheck.
import { CONNECTION_REFUSALS } from "./connection-refusals.ts";
import type { ConnectionRefusalReason } from "./connection-refusals.ts";
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ERROR_REASONS,
  RETRYABLE_ERROR_REASONS,
  type ErrorCode,
  type ErrorReason,
  type RetryableErrorReason,
} from "./errors.ts";

interface Guide {
  /** What went wrong. */
  cause: string;
  /** What to change. */
  fix: string;
}
interface CodeGuide extends Guide {
  /** Whether repeating the same request can succeed. */
  retry: string;
}

export const ERROR_CODE_GUIDE = {
  invalid_request: {
    cause:
      "The request failed validation, or its body, query, path ID, cursor or `Idempotency-Key` is malformed, or the body is over 64 KiB or not `application/json`.",
    fix: "Read `error.details.fields` (each failing field with its path and what it must be) and `error.message`, correct the request and send it again.",
    retry: "No: change the request first.",
  },
  unauthorized: {
    cause:
      "The API key is missing, malformed, unknown, revoked, or its project is deleted.",
    fix: "Send `Authorization: Bearer <key>` with a live key of the project.",
    retry: "No: use a valid key.",
  },
  forbidden: {
    cause: "An integrator key was used on an admin route.",
    fix: "Use an admin key for operator routes; integrator keys cover only their project.",
    retry: "No.",
  },
  not_found: {
    cause:
      "The ID is unknown or belongs to another project, the route does not exist, or a role route addresses a deleted database.",
    fix: "Check the ID and that the key belongs to the project that owns it.",
    retry: "No.",
  },
  conflict: {
    cause:
      "The request is refused because of the state of the database or the project; `error.details.reason` names the cause (see the reasons below).",
    fix: "Act on the reason. Without a reason, read `error.message`.",
    retry:
      "By reason: a retryable reason clears by itself and the answer carries `Retry-After`; a terminal reason needs a different request or resource.",
  },
  idempotency_conflict: {
    cause:
      "The `Idempotency-Key` was used with a different request, or the call that created a credential is replayed.",
    fix: "Use a new key for a different request. A credential-creating call is not replayed: read the earlier result, or create again under a new key.",
    retry: "No.",
  },
  idempotency_in_progress: {
    cause: "A request with the same `Idempotency-Key` is still executing.",
    fix: "Wait for `Retry-After` seconds, then send the same request under the same key.",
    retry: "Yes, shortly.",
  },
  capacity_exhausted: {
    cause:
      "The node lacks memory, CPU or storage for the resize, resources or profile change now.",
    fix: "Wait for `Retry-After` seconds and repeat, or choose a smaller size.",
    retry: "Yes, later.",
  },
  service_unavailable: {
    cause:
      "The control plane is in operator maintenance; no mutation was admitted.",
    fix: "Wait for `Retry-After` seconds and repeat.",
    retry: "Yes, after `Retry-After` (60 seconds).",
  },
  rate_limited: {
    cause:
      "The caller's network sent too many requests, or webhook tests came too close together.",
    fix: "Slow down and repeat; spread requests over time.",
    retry: "Yes, after a short wait.",
  },
  internal: {
    cause: "An unexpected failure on the platform side.",
    fix: "Repeat the request under the same `Idempotency-Key`. If it persists, report the `request_id` of the answer to the operator.",
    retry: "Yes, with the same idempotency key.",
  },
} as const satisfies Record<ErrorCode, CodeGuide>;

export const ERROR_REASON_GUIDE = {
  mutation_in_progress: {
    cause:
      "Another change to the same database holds it for the moment (a wake, an idle sleep, a maintenance step).",
    fix: "Repeat the request under the same `Idempotency-Key` after `Retry-After`.",
  },
  generation_changed: {
    cause:
      "The database, or what a create or restore was based on, changed between the read and the write.",
    fix: "Read the database again and repeat the request.",
  },
  not_ready: {
    cause:
      "The database has not applied its latest change or is not running yet.",
    fix: "Wait for `Retry-After` and repeat; check the database with `GET /v1/databases/{id}`.",
  },
  operation_in_progress: {
    cause:
      "A durable archive or recovery operation must finish before this change can apply.",
    fix: "Wait for the operation (`GET /v1/operations/{id}`) or repeat after `Retry-After`.",
  },
  node_capacity: {
    cause:
      "The node lacks memory, CPU or storage for the change or the start now.",
    fix: "Repeat after `Retry-After`, or choose a smaller size.",
  },
  name_in_use: {
    cause: "A live database of the project already has this name.",
    fix: "Choose another name.",
  },
  database_deleted: {
    cause: "The database is deleted.",
    fix: "Create a new database, or restore one from a retained archive.",
  },
  project_not_empty: {
    cause:
      "The project still holds databases that are not yet confirmed deleted.",
    fix: "Delete the databases and wait until their deletion is confirmed, then delete the project.",
  },
  role_exists: {
    cause: "A role of this name exists.",
    fix: "Choose another role name, or use the existing role.",
  },
  role_limit: {
    cause: "The database holds 100 roles; a role awaiting its removal counts.",
    fix: "Delete roles that are no longer used.",
  },
  role_being_deleted: {
    cause: "A role of that name is awaiting its removal.",
    fix: "Create the role again once PostgreSQL has dropped it, or choose another name.",
  },
  role_has_members: {
    cause: "Other live roles are `member_of` this role.",
    fix: "Delete or change the member roles first.",
  },
  archive_expired: {
    cause: "The archive named for the restore is past its retention.",
    fix: "Restore from a newer archive or recovery point.",
  },
  archive_unusable: {
    cause:
      "The archive cannot serve this restore (incomplete or invalid listing or contents).",
    fix: "Choose another archive or recovery point.",
  },
  archive_digest_mismatch: {
    cause:
      "A recorded backup of the archive changed, so its digest no longer matches.",
    fix: "Choose another archive or recovery point and tell the operator.",
  },
  no_recovery_point: {
    cause:
      "No complete base backup and required WAL are available for the requested recovery time.",
    fix: "Choose a `target_time` inside the restorable window of the database.",
  },
  source_unavailable: {
    cause:
      "The source database of the restore, or its credentials, are not available.",
    fix: "Restore from a source that is still retained, or tell the operator.",
  },
  region_unavailable: {
    cause: "The source region or size of the restore is unavailable.",
    fix: "Restore into a region and size class that are enabled.",
  },
  storage_not_local: {
    cause:
      "The database is archived, so its storage cannot be replaced, moved or resized.",
    fix: "Resume the database first, then repeat the request.",
  },
} as const satisfies Record<ErrorReason, Guide>;

export const CONNECTION_REFUSAL_GUIDE = {
  rate_limited: {
    cause:
      "The caller's network or the database and role route exceeded the Edge connection limits (also an unreadable `CF-Connecting-IP`).",
    fix: "Reuse connections (pool them) and back off before connecting again.",
    retry: "Yes, after a short wait.",
  },
  database_rate_limited: {
    cause:
      "The database as a whole received more connection attempts than its limit allows.",
    fix: "Pool connections and back off.",
    retry: "Yes, after a short wait.",
  },
  admission_unavailable: {
    cause: "The Edge limiter that counts connections did not answer.",
    fix: "Connect again shortly.",
    retry: "Yes.",
  },
  wake_deadline: {
    cause:
      "The database was asleep and did not finish waking within the 60 second admission deadline. The wake continues.",
    fix: "Connect again; the database is usually awake by then.",
    retry: "Yes, at once or after a few seconds.",
  },
  database_not_accepting: {
    cause:
      "The database is not admissible now: manually suspended, still provisioning, a change not yet applied, no capacity to wake, in an error state, or more than 32 connections already wait for its wake.",
    fix: "Check `GET /v1/databases/{id}`; resume a suspended database, wait for a change to finish, or retry later.",
    retry:
      "Per cause: yes while it is starting or changing, no while suspended.",
  },
  gateway_unavailable: {
    cause:
      "The Edge could not reach the node's gateway (or the per-database gateway limit was hit).",
    fix: "Retry; if it persists the node is unavailable, so check the database state and tell the operator.",
    retry: "Yes.",
  },
  admission_interrupted: {
    cause:
      "The connection was aborted by the client, or the deadline passed after the gateway was reached.",
    fix: "Connect again; do not abort a connect to a sleeping database for 60 seconds.",
    retry: "Yes.",
  },
  duplicate_hint: {
    cause: "The connection URL repeated the `database` or `user` hint.",
    fix: "Send each hint once.",
    retry: "No: fix the client.",
  },
  method_not_allowed: {
    cause: "The HTTP query endpoint accepts POST only.",
    fix: "Send the query with POST.",
    retry: "No: fix the client.",
  },
  invalid_database_id: {
    cause: "The `database` hint is missing or not a well-formed database ID.",
    fix: "Use the database ID the API returns.",
    retry: "No: fix the configuration.",
  },
  invalid_role_name: {
    cause:
      "The `user` hint is missing or not a valid role name (reserved names such as `postgres` are not).",
    fix: "Use a role of the database.",
    retry: "No: fix the configuration.",
  },
} as const satisfies Record<ConnectionRefusalReason, CodeGuide>;

function retryOf(reason: ErrorReason): string {
  return reason in RETRYABLE_ERROR_REASONS
    ? `Yes, after ${RETRYABLE_ERROR_REASONS[reason as RetryableErrorReason]} s (\`Retry-After\`).`
    : "No: the request or the resource has to change.";
}

/** The whole of `docs/errors.md`. */
export function renderErrorGuide(): string {
  const out: string[] = [
    "# PGCF errors",
    "",
    "This page is generated from `packages/contracts/src/error-guide.ts`; do not edit it by hand.",
    "A test keeps it equal to the code list, so a new error code, reason or connection refusal fails the test until it has an entry here.",
    "",
    'Every API error body is `{"error": {"code", "message", "request_id", "details"?}}`. `details.reason` is the stable cause where one code stands for several; `details.fields` lists each field a validation refused (`path` and `expected`). `PgcfClientError` keeps `message`, `reason`, `retryAfterSeconds` (from `Retry-After`) and `fields`. Quote the `request_id` when you report a problem.',
    "",
    "## API error codes",
    "",
  ];
  for (const code of ERROR_CODES) {
    const g = ERROR_CODE_GUIDE[code];
    out.push(
      `### \`${code}\` (HTTP ${ERROR_HTTP_STATUS[code]})`,
      "",
      `- Cause: ${g.cause}`,
      `- Fix: ${g.fix}`,
      `- Retry: ${g.retry}`,
      "",
    );
  }
  out.push("## Reasons of `details.reason`", "");
  for (const reason of ERROR_REASONS) {
    const g = ERROR_REASON_GUIDE[reason];
    out.push(
      `### \`${reason}\``,
      "",
      `- Cause: ${g.cause}`,
      `- Fix: ${g.fix}`,
      `- Retry: ${retryOf(reason)}`,
      "",
    );
  }
  out.push(
    "## Connection refusals",
    "",
    "A refused database connection or HTTP query reaches the client as a PostgreSQL error: a SQLSTATE and a message. Where the Edge decides the refusal itself, the message ends with a closed reason, for example `database is not accepting connections (pgcf: database_not_accepting)`.",
    "",
  );
  for (const reason of Object.keys(
    CONNECTION_REFUSALS,
  ) as ConnectionRefusalReason[]) {
    const g = CONNECTION_REFUSAL_GUIDE[reason];
    out.push(
      `### \`${reason}\` (SQLSTATE ${CONNECTION_REFUSALS[reason].sqlstate})`,
      "",
      `- Message: \`${CONNECTION_REFUSALS[reason].message} (pgcf: ${reason})\``,
      `- Cause: ${g.cause}`,
      `- Fix: ${g.fix}`,
      `- Retry: ${g.retry}`,
      "",
    );
  }
  out.push(
    "### Refusals without a reason",
    "",
    "- `28P01 password authentication failed`: an unknown or deleted database, an unknown or deleted role, a role past its `valid_until` and a wrong password are one answer by design, so that nobody can probe which databases exist. Check the database ID, role, `valid_until` and the password, and do not retry in a loop.",
    "- `28000 startup does not match the authorized route`: the StartupMessage `database` or `user` differs from the URL hints. Fix the client.",
    "- `08P01 protocol violation`, `0A000` (replication or unsupported frontend protocol): fix the client.",
    "- `53300` with a PostgreSQL message (`too many clients`, `too many connections for role`): the cluster's `max_connections` or the role's `connection_limit`. Pool connections.",
    "",
    "## The CLI",
    "",
    "`pgcf connect` prints `pgcf: <code>: <what it means and what to change>` for a bad argument or a local port that cannot be opened. Once connected, a refusal of the database is answered by your PostgreSQL client with the messages above.",
    "",
    "More detail: [integrator handover, Appendix A](operations/integrator-handover.md#appendix-a-error-reference).",
    "",
  );
  return out.join("\n");
}
