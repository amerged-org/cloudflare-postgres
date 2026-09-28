# Owned logical databases checkpoint — 2026-09-29

This checkpoint adds ordinary PostgreSQL database ownership to the role/credential foundation. It does not complete the native pilot, external endpoints, backup/restore, independent budget enforcement or M3.

## Published behavior

Source commit [`218e2adb0cb316db812e9fb0b3ff24f819a29653`](https://github.com/amerged-org/cloudflare-postgres/commit/218e2adb0cb316db812e9fb0b3ff24f819a29653) implements the [owned-database contract](../contracts/owned-databases-v1.md), additive migration `0010`, scoped create/read/credential routes and a separate leased regional CNPG Database lane. All 19 public files were read back byte-for-byte from GitHub; dependencies are unchanged. First-party source remains Apache-2.0.

A caller selects a validated database name and an applied restricted role in the same ready environment. Immutable bindings include accepted environment/spec/Namespace/Cluster/role/credential identities. The existing encrypted role password and keyring are reused; no second password store exists. Current credential disclosure follows the owner's newest applied revision, with distinct database-observation and credential-verification timestamps. Queued/running database creation and password rotation use symmetric D1 transaction guards; expired leases keep the lock because effects remain uncertain. Exact old intention/result replay cannot rewind current state.

The regional executor reads its deterministic owned Database CR first and resolves a lost committed create by matching readback. Before first creation, complete bounded competing-resource inventory and a fresh restricted TLS SQL-name absence check are required. CNPG can adopt pre-existing SQL databases; this preflight prevents ordinary platform collisions but is not atomic against independent privileged administrators. Those administrators remain trusted coordinated writers. No raw database fields, DROP, arbitrary SQL, alternate host or privileged role is exposed.

Success requires fixed `ensure: present`/`template0`/Retain specification, current applied generation and stable environment/owner/Secret/Database identities. A fresh verified-TLS connection checks SQL ownership and writable restricted-role access, then creates a generated schema/table, inserts and reads a value inside a transaction. Acknowledged ROLLBACK, idle transaction state and absence of probe objects are required before reporting success. Unknown outcomes defer; uncertain committed customer writes are never replayed.

## Bounded verification

Exactly three new top-level cases failed meaningfully first: one Worker create/disclose/owner-rotation lifecycle and two regional cases covering uncertain owned creation/exact application and refusal to adopt an unmanaged SQL name. Targeted cases, the affected existing role case, regional build and affected typechecks passed on candidate one. Independent read-only reviews passed shared auth/AAD preservation, actor/current-state/lease/replay fences, owner rotation locking, CNPG behavior and SQL rollback conditions.

The frozen candidate passed one uninterrupted canonical format/lint/typecheck/Vitest/Node gate in 10.686 seconds. All 19 Worker and 18 Node cases passed, totaling 37 versus 34 previously. No repairs, extra cases, matrices or second full gate followed. A server dry-run against the installed CNPG API accepted the fixed Database specification without creating a CR or SQL database. Fixture tests and API schema acceptance do not establish real customer SQL creation/ownership.

## Control-state safeguard and Dev API

The initial D1 preflight returned account authorization code `7403`. Read-only existing-login/account and database-info checks passed; repeating the same bounded read then returned the original unchanged state. The failure is preserved and no cause is inferred from recovery. No new login, scope expansion or credential was required.

Before migration, one consistent application snapshot captured 34 tables, 84 schema objects and 42 rows. A private local SQLite reconstruction exactly matched schema/data and passed integrity and foreign-key checking. This is an application-state recovery sample, not a fresh Cloudflare-account recovery or scheduled production backup.

Migration `0010` applied in 1.470 seconds and the existing Dev Worker deployed the public source in 10.673 seconds. Readback confirms its migration record, no foreign-key violations, preserved prior counts and zero new logical databases/operations/requests. Regional admission stays closed and there remain zero API-managed environments or roles.

Live route checks return 401 for anonymous database writes and a region executor used as a customer, 200 with an empty database claim for the legitimate regional executor, and 404 for a foreign region. These prove routing/credential boundaries and an empty lane, not positive SQL database creation or owner-credential disclosure.

## Regional build artifact

One Linux amd64 image build from 43 sealed public Git inputs completed in 27.007 seconds. Network-disabled/read-only/nonroot inspection verifies Node `24.21.0`, UID/GID `1000`, `pg@8.23.0` with its retained MIT license, and matching hashes/imports for the six compiled database modules and entry point. No private environment/configuration enters the context.

Image `docker.io/library/pgcf-regional-dev:databases-3f799738d694` has OCI index `sha256:df3d3d16884dfe40c011f57684377bbecc43f89f418315e5c24d99942ec1313c` and Linux amd64 manifest `sha256:9c121682b47b51fe7249010f346058b115a16ebf9d8831977222e411d0da93a0`. The 88,477,696-byte private archive has SHA-256 `9105a8554069b5cec0bc178cb0e81392d8b0177d68d8b4e770cc843372b4e95b`. Runtime image deployment and positive SQL qualification are separate observations.

## Dev regional activation

One authenticated Talos image import completed in 11.794 seconds and exact-reference readback matched the built image. Two fresh UID/resource-version conditional patches appended only Database get/list/create authority while preserving all eleven prior rules and replaced only the controller image. The existing role-verifier configuration, journal/storage and Pod security settings were unchanged. Matching readback resolved both writes; one Recreate rollout completed in 2.049 seconds. No import or patch was replayed and no Pod was deleted directly.

Independent read-only runtime qualification passed 22 bounded checks. The current-generation Deployment and new zero-restart Pod match the intended image/configuration. Node `24.21.0`, UID `1000` and all seven selected compiled database/entry-point hashes match the artifact. Compiled DatabaseClient, RoleClient and ControlClient in the actual Pod authenticate using the configured origin/region and mounted executor token; all return empty claims.

The unchanged configuration and exact one-rule RBAC addition are verified. Journal identity, private `0700` directory/`0600` files, WAL mode, bounded empty outbox and source identity are preserved; a new session, advancing checkpoint and explicit restart gap are observed. Node/boot/pressure state, 31 non-controller Pod identities and regular/init restart counts, four Bound PV/PVC identities/specifications, source database identity/spec/current primary and both SQL marker counts are preserved. No debug container, provider call, credential-payload read, new test or broad-gate repeat accompanies this observation.

These checks qualify deployed runtime and authenticated empty lanes. Positive customer SQL database creation, ownership and real application migration remain unverified.

## Open gates and preserved scope

Qualify real CNPG role/database creation, owner migration behavior, foreign-name refusal, endpoint/TLS connectivity, backups/full/PITR restore and key/control-state recovery. Validate the trusted administrative-writer boundary and production admission before untrusted use. Metadata readiness alone is insufficient.

The scoped R2 credential remains prepared and awaits its specific confirmation; no approval was inferred from a goal continuation. Its dependent backup work and the stopped Barman handoff were not resumed. The original stopped SDK candidate remains archived unchanged. `.env.local` is unchanged, owner-readable and ignored; a scan of all 252 committed blobs found no matching private token/password/key values.
