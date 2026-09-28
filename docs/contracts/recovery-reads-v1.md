# Customer resource and operation recovery v1

Clients can recover identifiers after losing a create or rotation response, then poll the durable operation without receiving credentials. These reads use stored control state; they do not run regional work or prove current SQL reachability.

## Resource collections

Organization tokens with `projects:read` may request:

| Collection   | Path beneath `/v1/organizations/{organizationId}`              | Entry                              |
| ------------ | -------------------------------------------------------------- | ---------------------------------- |
| Projects     | `/projects`                                                    | `{project,currentOperationId}`     |
| Environments | `/projects/{projectId}/environments`                           | `{environment,currentOperationId}` |
| Roles        | `/projects/{projectId}/environments/{environmentId}/roles`     | `{role,currentOperationId}`        |
| Databases    | `/projects/{projectId}/environments/{environmentId}/databases` | `{database,currentOperationId}`    |

Each response is `{projects|environments|roles|databases:[entry],nextCursor,consistency:"observed-page",observedAt}`. Resource fields reuse the existing public item representation. Backup endpoints, archive paths and credential Secret references are redacted from environment profiles. Passwords, encrypted credentials, token hashes, lease authority and internal version tokens are never included. An operation identifier does not grant the permission to read that operation.

For projects and environments, `currentOperationId` identifies the creation operation linked by the durable request record. For roles it identifies the desired credential revision's operation; after rotation, the earlier operation remains readable by its identifier. Each logical database has one creation operation. Missing legacy request linkage yields `null`; ambiguous linkage returns `500 state_inconsistent` rather than guessing an operation.

Pending and failed resources remain discoverable. A disabled region, expired execution lease or temporarily unavailable database does not hide recovery metadata. An owned empty parent returns an empty collection; a foreign or missing parent returns `404`. Revoked organization credentials return `401`. Regional executor credentials are not customer credentials. Active-token and ownership predicates are checked in the same primary D1 read batch as the page.

## Bounded pagination

Only one `limit` and one `cursor` are accepted; unknown or repeated parameters return `400`. The default limit is 50 and the maximum is 100. Ordering is descending `(createdAt,id)` with one additional row to determine continuation. The HMAC-protected, versioned cursor binds the collection, organization, parent identifiers, page limit and boundary tuple. Tampered cursors and cursors reused for another parent, collection or limit return `400`.

Pages are observations, not a frozen cross-page snapshot. Resource status and desired credential revision can change between reads. New resources may require a fresh traversal. There is no total count, page number or implicit regional readiness guarantee. Rotating the installation bootstrap secret invalidates existing cursors; clients restart discovery.

## Canonical operation reads

`GET /v1/organizations/{organizationId}/operations/{operationId}` requires `operations:read` and accepts no query parameters. It resolves the existing project/environment operations and the separate role/database operation stores. Reads join to the owned resource and recheck active actor authority in the primary batch. Only allowlisted public operation fields are returned, including organization/project ownership and applicable environment, role, database and credential-revision identifiers.

Queued, running, failed and completed historical operations remain readable. Role/database operation status uses its existing `applied` terminal value; legacy project/environment status retains its existing values. A lookup does not reinterpret or normalize lifecycle states. More than one visible operation with the same identifier returns `500 state_inconsistent`; foreign operations remain `404` without exposing their existence.

All responses use `Cache-Control: no-store`. Reads do not decrypt credentials, renew leases, retry writes or enqueue operations. Exact POST idempotency remains available but retains its documented response semantics. Development operation history is currently retained without a configured expiry; this is not a production archival or disaster-recovery guarantee.

## Bounded verification

Exactly three new top-level Worker cases cover recovery/pagination with private-profile redaction, current/historical role tasks with read-scope separation, and database tasks with foreign/empty parent, revoked-actor and ambiguous-identifier handling. Establish meaningful RED before implementation, run named affected files during iteration, and run the canonical gate once on the frozen candidate. Real regional creation and database recovery remain separate qualification gates.
