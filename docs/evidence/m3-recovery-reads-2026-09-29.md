# Customer recovery reads checkpoint — 2026-09-29

Source [`cda6b593b2808b00471ca97712dea2d5e92ff8cc`](https://github.com/amerged-org/cloudflare-postgres/commit/cda6b593b2808b00471ca97712dea2d5e92ff8cc) adds bounded discovery and durable task reads to the [recovery contract](../contracts/recovery-reads-v1.md). This advances M3 without completing regional creation, native access, backup/recovery or production readiness.

## Published behavior

Organization-scoped project, project-scoped environment and environment-scoped role/database collections return existing sanitized resource metadata with `currentOperationId`. Lists require `projects:read`; full task metadata retains `operations:read`. The canonical organization operation endpoint now resolves project/environment, role and database stores, including historical role credential revisions. Visible identifier collisions fail explicitly.

HMAC cursors bind collection, organization, parents, limit and descending creation/ID boundary. Limits default to 50 and are capped at 100. Pages declare observed state, not an immutable cross-page snapshot. Owned empty parents differ from foreign/missing parents; active-token predicates are rechecked in primary batches. Pending/failed resources and disabled-region metadata remain discoverable without granting execution or credential access.

The existing public serializers preserve private backup configuration and credential/lease redaction. No password is decrypted, no lease renewed and no workload operation enqueued by these reads. Migration `0011` adds five indexes only. Offline application to the restored control snapshot passes integrity/foreign-key checks; all four page orderings use indexes without temporary sorting. OpenAPI parses, all 460 local references and path parameters resolve, and operation identifiers are unique.

## Bounded verification and preserved stop

Exactly three new Worker cases cover recovery/pagination with private-profile redaction, current/historical role tasks with read-scope separation, and database tasks with regional unavailability, parent isolation, revoked actors and ambiguous identifiers. The first run exposed one fixture error: an environment result accidentally included extra claim fields. Correcting only that setup produced the required three meaningful missing-endpoint failures before implementation.

Candidate one passes all 17 cases in the four named affected Worker files in 3.021 seconds. Independent read-only implementation review passes authorization, cursor binding, collision handling and public-field selection. No runtime repair, dependency change or regional-source change was needed.

The single canonical gate ran in 11.453 seconds. Format, lint, typecheck and all 22 Worker cases passed. The Node stage passed 15 cases but stopped on three existing platform-inspection cases because the fresh checkout lacked `dist/main.js`. This is not an uninterrupted clean full gate. The unchanged regional source was compiled, frozen source hashes were rechecked, and only the previously failed platform-inspection file ran again: all three cases passed in 1.576 seconds. There is passing evidence for 40 total cases versus the 37-case baseline. No second broad gate, generated matrix, new Node case or weakened assertion followed.

## State protection and Dev activation

Before migration, one consistent private application-state snapshot captured 37 tables, 97 schema objects and 43 rows. Exact local SQLite reconstruction passed integrity and foreign-key checks. This is a local application-state restore sample; scheduled backups and fresh Cloudflare-account/key recovery remain open.

Migration `0011` applied once in 2.620 seconds and the same public source deployed once to the existing Dev Worker in 10.972 seconds. Ten bounded read-only HTTP checks pass: organization discovery recovers the original project and operation, empty owned environments are visible, anonymous/regional/foreign access is rejected, and invalid pagination/task queries fail. There is no positive role/database inventory in Dev; fixture coverage does not establish real regional SQL behavior.

Fresh secret-name readback confirms all eight existing Worker Secrets, including five Contabo credential names and the platform/bootstrap/cryptographic names. No secret values were retrieved. The direct D1 state read initially returned authorization code `7403`; its private failure is preserved. Read-only existing-login and database-info checks passed, then one repeat of the identical state read verified the migration, all five indexes, no foreign-key violations, unchanged empty managed/usage/allowance counts and closed admission. No cause is inferred from that recovery; no new login, scope or credential was introduced.

## Open scope

Positive CNPG creation/credential rotation/database ownership, native endpoint/pooling, metering/enforcement, backup/PITR and independent recovery still require installation evidence. Region admission remains closed. The stopped SQL fixture and Barman handoff were not resumed, and the prepared R2 credential still awaits its specific confirmation. The archived SDK candidate's 22 hashes are unchanged.

The local environment remains byte-identical, owner-readable and ignored. A scan of all 258 public candidate files found zero matching private token/password/key values. No local environment, private installation configuration or evidence is committed.
