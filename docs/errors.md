# PGCF errors

This page is generated from `packages/contracts/src/error-guide.ts`; do not edit it by hand.
A test keeps it equal to the code list, so a new error code, reason or connection refusal fails the test until it has an entry here.

Every API error body is `{"error": {"code", "message", "request_id", "details"?}}`. `details.reason` is the stable cause where one code stands for several; `details.fields` lists each field a validation refused (`path` and `expected`). `PgcfClientError` keeps `message`, `reason`, `retryAfterSeconds` (from `Retry-After`) and `fields`. Quote the `request_id` when you report a problem.

## API error codes

### `invalid_request` (HTTP 400)

- Cause: The request failed validation, or its body, query, path ID, cursor or `Idempotency-Key` is malformed, or the body is over 64 KiB or not `application/json`.
- Fix: Read `error.details.fields` (each failing field with its path and what it must be) and `error.message`, correct the request and send it again.
- Retry: No: change the request first.

### `unauthorized` (HTTP 401)

- Cause: The API key is missing, malformed, unknown, revoked, or its project is deleted.
- Fix: Send `Authorization: Bearer <key>` with a live key of the project.
- Retry: No: use a valid key.

### `forbidden` (HTTP 403)

- Cause: An integrator key was used on an admin route.
- Fix: Use an admin key for operator routes; integrator keys cover only their project.
- Retry: No.

### `not_found` (HTTP 404)

- Cause: The ID is unknown or belongs to another project, the route does not exist, or a role route addresses a deleted database.
- Fix: Check the ID and that the key belongs to the project that owns it.
- Retry: No.

### `conflict` (HTTP 409)

- Cause: The request is refused because of the state of the database or the project; `error.details.reason` names the cause (see the reasons below).
- Fix: Act on the reason. Without a reason, read `error.message`.
- Retry: By reason: a retryable reason clears by itself and the answer carries `Retry-After`; a terminal reason needs a different request or resource.

### `idempotency_conflict` (HTTP 409)

- Cause: The `Idempotency-Key` was used with a different request, or the call that created a credential is replayed.
- Fix: Use a new key for a different request. A credential-creating call is not replayed: read the earlier result, or create again under a new key.
- Retry: No.

### `idempotency_in_progress` (HTTP 409)

- Cause: A request with the same `Idempotency-Key` is still executing.
- Fix: Wait for `Retry-After` seconds, then send the same request under the same key.
- Retry: Yes, shortly.

### `capacity_exhausted` (HTTP 503)

- Cause: The node lacks memory, CPU or storage for the resize, resources or profile change now.
- Fix: Wait for `Retry-After` seconds and repeat, or choose a smaller size.
- Retry: Yes, later.

### `service_unavailable` (HTTP 503)

- Cause: The control plane is in operator maintenance; no mutation was admitted.
- Fix: Wait for `Retry-After` seconds and repeat.
- Retry: Yes, after `Retry-After` (60 seconds).

### `rate_limited` (HTTP 429)

- Cause: The caller's network sent too many requests, or webhook tests came too close together.
- Fix: Slow down and repeat; spread requests over time.
- Retry: Yes, after a short wait.

### `internal` (HTTP 500)

- Cause: An unexpected failure on the platform side.
- Fix: Repeat the request under the same `Idempotency-Key`. If it persists, report the `request_id` of the answer to the operator.
- Retry: Yes, with the same idempotency key.

## Reasons of `details.reason`

### `mutation_in_progress`

- Cause: Another change to the same database holds it for the moment (a wake, an idle sleep, a maintenance step).
- Fix: Repeat the request under the same `Idempotency-Key` after `Retry-After`.
- Retry: Yes, after 1 s (`Retry-After`).

### `generation_changed`

- Cause: The database, or what a create or restore was based on, changed between the read and the write.
- Fix: Read the database again and repeat the request.
- Retry: Yes, after 1 s (`Retry-After`).

### `not_ready`

- Cause: The database has not applied its latest change or is not running yet.
- Fix: Wait for `Retry-After` and repeat; check the database with `GET /v1/databases/{id}`.
- Retry: Yes, after 5 s (`Retry-After`).

### `operation_in_progress`

- Cause: A durable archive or recovery operation must finish before this change can apply.
- Fix: Wait for the operation (`GET /v1/operations/{id}`) or repeat after `Retry-After`.
- Retry: Yes, after 5 s (`Retry-After`).

### `node_capacity`

- Cause: The node lacks memory, CPU or storage for the change or the start now.
- Fix: Repeat after `Retry-After`, or choose a smaller size.
- Retry: Yes, after 30 s (`Retry-After`).

### `name_in_use`

- Cause: A live database of the project already has this name.
- Fix: Choose another name.
- Retry: No: the request or the resource has to change.

### `database_deleted`

- Cause: The database is deleted.
- Fix: Create a new database, or restore one from a retained archive.
- Retry: No: the request or the resource has to change.

### `project_not_empty`

- Cause: The project still holds databases that are not yet confirmed deleted.
- Fix: Delete the databases and wait until their deletion is confirmed, then delete the project.
- Retry: No: the request or the resource has to change.

### `role_exists`

- Cause: A role of this name exists.
- Fix: Choose another role name, or use the existing role.
- Retry: No: the request or the resource has to change.

### `role_limit`

- Cause: The database holds 100 roles; a role awaiting its removal counts.
- Fix: Delete roles that are no longer used.
- Retry: No: the request or the resource has to change.

### `role_being_deleted`

- Cause: A role of that name is awaiting its removal.
- Fix: Create the role again once PostgreSQL has dropped it, or choose another name.
- Retry: No: the request or the resource has to change.

### `role_has_members`

- Cause: Other live roles are `member_of` this role.
- Fix: Delete or change the member roles first.
- Retry: No: the request or the resource has to change.

### `archive_expired`

- Cause: The archive named for the restore is past its retention.
- Fix: Restore from a newer archive or recovery point.
- Retry: No: the request or the resource has to change.

### `archive_unusable`

- Cause: The archive cannot serve this restore (incomplete or invalid listing or contents).
- Fix: Choose another archive or recovery point.
- Retry: No: the request or the resource has to change.

### `archive_digest_mismatch`

- Cause: A recorded backup of the archive changed, so its digest no longer matches.
- Fix: Choose another archive or recovery point and tell the operator.
- Retry: No: the request or the resource has to change.

### `no_recovery_point`

- Cause: No complete base backup and required WAL are available for the requested recovery time.
- Fix: Choose a `target_time` inside the restorable window of the database.
- Retry: No: the request or the resource has to change.

### `source_unavailable`

- Cause: The source database of the restore, or its credentials, are not available.
- Fix: Restore from a source that is still retained, or tell the operator.
- Retry: No: the request or the resource has to change.

### `region_unavailable`

- Cause: The source region or size of the restore is unavailable.
- Fix: Restore into a region and size class that are enabled.
- Retry: No: the request or the resource has to change.

### `storage_not_local`

- Cause: The database is archived, so its storage cannot be replaced, moved or resized.
- Fix: Resume the database first, then repeat the request.
- Retry: No: the request or the resource has to change.

## Connection refusals

A refused database connection or HTTP query reaches the client as a PostgreSQL error: a SQLSTATE and a message. Where the Edge decides the refusal itself, the message ends with a closed reason, for example `database is not accepting connections (pgcf: database_not_accepting)`.

### `rate_limited` (SQLSTATE 53300)

- Message: `connection rate limit exceeded (pgcf: rate_limited)`
- Cause: The caller's network or the database and role route exceeded the Edge connection limits (also an unreadable `CF-Connecting-IP`).
- Fix: Reuse connections (pool them) and back off before connecting again.
- Retry: Yes, after a short wait.

### `database_rate_limited` (SQLSTATE 53300)

- Message: `database connection rate limit exceeded (pgcf: database_rate_limited)`
- Cause: The database as a whole received more connection attempts than its limit allows.
- Fix: Pool connections and back off.
- Retry: Yes, after a short wait.

### `admission_unavailable` (SQLSTATE 53300)

- Message: `connection admission unavailable (pgcf: admission_unavailable)`
- Cause: The Edge limiter that counts connections did not answer.
- Fix: Connect again shortly.
- Retry: Yes.

### `wake_deadline` (SQLSTATE 57P03)

- Message: `database is not ready yet (pgcf: wake_deadline)`
- Cause: The database was asleep and did not finish waking within the 60 second admission deadline. The wake continues.
- Fix: Connect again; the database is usually awake by then.
- Retry: Yes, at once or after a few seconds.

### `database_not_accepting` (SQLSTATE 57P03)

- Message: `database is not accepting connections (pgcf: database_not_accepting)`
- Cause: The database is not admissible now: manually suspended, still provisioning, a change not yet applied, no capacity to wake, in an error state, or more than 32 connections already wait for its wake.
- Fix: Check `GET /v1/databases/{id}`; resume a suspended database, wait for a change to finish, or retry later.
- Retry: Per cause: yes while it is starting or changing, no while suspended.

### `gateway_unavailable` (SQLSTATE 08006)

- Message: `gateway connection failed (pgcf: gateway_unavailable)`
- Cause: The Edge could not reach the node's gateway (or the per-database gateway limit was hit).
- Fix: Retry; if it persists the node is unavailable, so check the database state and tell the operator.
- Retry: Yes.

### `admission_interrupted` (SQLSTATE 08006)

- Message: `connection admission interrupted (pgcf: admission_interrupted)`
- Cause: The connection was aborted by the client, or the deadline passed after the gateway was reached.
- Fix: Connect again; do not abort a connect to a sleeping database for 60 seconds.
- Retry: Yes.

### `duplicate_hint` (SQLSTATE 08P01)

- Message: `duplicate connection admission hint (pgcf: duplicate_hint)`
- Cause: The connection URL repeated the `database` or `user` hint.
- Fix: Send each hint once.
- Retry: No: fix the client.

### `method_not_allowed` (SQLSTATE 08P01)

- Message: `HTTP SQL requires POST (pgcf: method_not_allowed)`
- Cause: The HTTP query endpoint accepts POST only.
- Fix: Send the query with POST.
- Retry: No: fix the client.

### `invalid_database_id` (SQLSTATE 3D000)

- Message: `database does not exist (pgcf: invalid_database_id)`
- Cause: The `database` hint is missing or not a well-formed database ID.
- Fix: Use the database ID the API returns.
- Retry: No: fix the configuration.

### `invalid_role_name` (SQLSTATE 28P01)

- Message: `authentication failed (pgcf: invalid_role_name)`
- Cause: The `user` hint is missing or not a valid role name (reserved names such as `postgres` are not).
- Fix: Use a role of the database.
- Retry: No: fix the configuration.

### Refusals without a reason

- `28P01 password authentication failed`: an unknown or deleted database, an unknown or deleted role, a role past its `valid_until` and a wrong password are one answer by design, so that nobody can probe which databases exist. Check the database ID, role, `valid_until` and the password, and do not retry in a loop.
- `28000 startup does not match the authorized route`: the StartupMessage `database` or `user` differs from the URL hints. Fix the client.
- `08P01 protocol violation`, `0A000` (replication or unsupported frontend protocol): fix the client.
- `53300` with a PostgreSQL message (`too many clients`, `too many connections for role`): the cluster's `max_connections` or the role's `connection_limit`. Pool connections.

## The CLI

`pgcf connect` prints `pgcf: <code>: <what it means and what to change>` for a bad argument or a local port that cannot be opened. Once connected, a refusal of the database is answered by your PostgreSQL client with the messages above.

More detail: [integrator handover, Appendix A](operations/integrator-handover.md#appendix-a-error-reference).
