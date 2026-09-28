# Usage ledger and budget authority v1

This document describes the M3 control API implemented by `accounting.ts`, `usage.ts`, `budgets.ts`, and migrations `0006`–`0007`. The [OpenAPI contract](../../apps/control-api/openapi.yaml) defines the wire shapes. The [Dev checkpoint](../evidence/m3-usage-budget-authority-2026-09-28.md) verifies deployment, empty exports, token boundaries, exact grants, and conditional requested state. This is development control authority: the regional controller does not yet collect these facts, acquire allowances, enforce expiry, or stop PostgreSQL when authority ends. Actual ingestion, receipt replay/settlement, and runtime behavior remain unverified live; regional admission remains closed.

Every budget resource and allowance summary reports `runtimeEnforced: false` and `enforcementStatus: pending_runtime`. Those fields are assertions about the current implementation, including after pause, exhaustion, settlement, or correction. Usage and credential envelopes retain their actual reporting and issuance shapes; they do not claim runtime enforcement.

## Identity and authority

All routes use HTTPS bearer tokens. D1 stores token digests rather than reusable token values. Reissue reveals the replacement once and revokes the previous active token of the same purpose and scope. Tokens must stay in operator or regional secret stores, outside public configuration and logs.

| Identity           | Issuer and scope                                                                                                                 | Allowed accounting work                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Installation token | Adopter's `INSTALLATION_BOOTSTRAP_TOKEN` Worker Secret                                                                           | Reissue a regional meter token or an organization's budget grantor token.                                                       |
| `cpmtr_...`        | Installation-only `POST /v1/regions/{regionId}/usage-tokens/reissue`; `usage:write`                                              | Append usage revisions for environments owned by that region.                                                                   |
| `cpbgt_...`        | Installation-only `POST /v1/organizations/{organizationId}/budget-tokens/reissue`; `budgets:read`, `budgets:write`, `usage:read` | Read usage/budgets and assign, pause, or resume that organization's scoped budgets.                                             |
| `cporg_...`        | Existing organization bootstrap; accounting reads require `projects:read`                                                        | Read that organization's usage and budgets. `projects:write` never grants budget authority.                                     |
| `cprgn_...`        | Existing region registration; `operations:claim` / `operations:report`                                                           | Request/read allowances with `operations:claim` and settle them with `operations:report`. This token cannot ingest meter facts. |
| `cprsv_...`        | Returned in an allowance receipt                                                                                                 | Fence one reservation's settlement together with its exact epoch; not a general bearer identity.                                |

Meter reissue returns `regionId`, `sourceId`, integer `sourceEpoch`, `apiToken`, and `scopes`. Rotation preserves the existing source ID and epoch, so buffered facts can be replayed with the replacement meter token. There is no source-epoch advancement API in this version. Disabled regions cannot issue new meter tokens or ingest facts. Active regional tokens may still read/settle historical allowance receipts when their region is disabled.

Budget-token reissue returns `organizationId`, `apiToken`, and `scopes`. An ordinary organization token cannot issue these credentials or update a budget. A grantor token does not acquire project administration privileges. Cross-organization and cross-region resources return `404`; invalid credentials return `401`. An ordinary authenticated organization attempting a budget write receives `403 budget_grantor_required`.

## Exact resource units and usage revisions

Accounting input quantities are unsigned decimal strings: `"0"` or a nonzero digit followed by digits, up to 78 digits. No signs, leading zeroes, decimal points, exponents, JSON numbers, currency conversion, or prices are accepted. Application arithmetic uses `BigInt`; budget counters persist as decimal TEXT or JSON strings. D1 stores acceptance sequences as SQLite integers and casts them to TEXT for wire values and snapshot watermarks. Aggregates can exceed an individual input's length.

| Metric                   | Reported unit                                           |
| ------------------------ | ------------------------------------------------------- |
| `cpu_millicore_ms`       | Allocated millicores × elapsed milliseconds.            |
| `memory_byte_ms`         | Allocated memory bytes × elapsed milliseconds.          |
| `data_storage_byte_ms`   | Attributable data-volume bytes × elapsed milliseconds.  |
| `backup_storage_byte_ms` | Attributable backup bytes × elapsed milliseconds.       |
| `wal_storage_byte_ms`    | Attributable archived-WAL bytes × elapsed milliseconds. |
| `transfer_in_bytes`      | Measured incoming bytes.                                |
| `transfer_out_bytes`     | Measured outgoing bytes.                                |

The collector must state its measurement basis in retained evidence. Operational CPU utilization is not allocated CPU-time. `attribution` is one of `primary`, `replica`, `backup`, `wal`, or `platform`; the API preserves the supplied attribution and does not invent an overhead allocation policy.

`POST /v1/regions/{regionId}/usage-facts` accepts exactly:

```json
{
  "factId": "<lowercase UUID>",
  "environmentId": "<lowercase UUID>",
  "sourceId": "<lowercase UUID>",
  "sourceEpoch": 1,
  "revision": 1,
  "expectedPreviousRevision": 0,
  "metric": "cpu_millicore_ms",
  "attribution": "primary",
  "start": "2026-09-28T00:00:00.000Z",
  "end": "2026-09-28T00:01:00.000Z",
  "quantity": "9007199254740993",
  "status": "final",
  "evidenceHash": "<64 lowercase hexadecimal characters>"
}
```

Timestamps use exact UTC millisecond form. The positive interval is at most 60,000 milliseconds and lies wholly within one UTC minute. A full minute or shorter subinterval is accepted; an interval crossing a minute boundary is not. Split collector facts at the boundary rather than estimating a prorated query result. Source epoch, revision, and expected previous revision are safe JSON integers; revisions start at one and must equal `expectedPreviousRevision + 1`.

`provisional` and `final` require a quantity string, including explicit `"0"`. `gap` requires `quantity: null`: unknown usage is never zero. Fact identity is immutable across revisions: environment/ownership, source, metric, attribution, and interval cannot change. Accepted revisions are append-only. A correction appends the next revision; an identical `(factId, revision)` payload replay returns the existing fact with `200`, while conflicting payloads or stale predecessors return `409 usage_revision_conflict`. A new accepted revision returns `201`.

The response is `{ "fact": ... }`. The fact contains all input fields plus `organizationId`, `projectId`, `regionId`, decimal-string `acceptanceSequence`, and `acceptedAt`. Ownership is derived from the environment, not accepted from the caller. The supplied evidence digest is recorded; it does not mean the Worker independently measured PostgreSQL or fetched the evidence object.

## Fixed-snapshot JSON and NDJSON pages

Read `GET /v1/organizations/{organizationId}/usage` or `/usage/export` with organization read or grantor authority. Required `from` and `to` are UTC minute boundaries, with `from < to` and a maximum 31-day window. Optional `projectId` and `environmentId` must belong to the organization and agree when both are given. `limit` defaults to 50 and accepts 1–100; `cursor` follows `nextCursor`. Repeated or unknown query parameters are rejected.

The first page fixes `snapshot.watermark` to the highest organization acceptance sequence, returned as a decimal string. Each page selects the latest revision of each fact accepted at or before that watermark. Facts are ordered by `start`, then `factId`, and must be wholly inside the query window. A cursor binds the organization and all window/filter values. Corrections accepted after that snapshot appear only in a new query without the old cursor. A cursor cannot be moved to another organization or filter; the page size may change. The current cursor signature uses the installation secret, so rotating that secret invalidates previously issued cursors. There is no claim of a cross-system snapshot.

JSON pages contain `records`, `pageTotals`, `pageTotalsByStatus: { provisional, final }`, `nextCursor`, `snapshot: { watermark }`, `window: { from, to, projectId, environmentId }`, `coverage`, `latestPageAcceptedAt`, and `retention: indefinite-development-ledger`. Totals cover only non-gap quantities on that page. They are not whole-window totals, invoices, finalized totals, or proof of complete observation. `coverage` is always `{ status: "unknown", explicitGapRecords: <page count>, missingObservations: "unknown" }`; an empty result still has unknown coverage. `latestPageAcceptedAt` is the newest acceptance time on the page, or null.

The NDJSON export is the same paginated snapshot: one bare fact object per line followed by one `{ "type": "metadata", ... }` line containing the same page metadata. It is not a single complete-window download. Follow its `nextCursor` to continue; facts added or corrected later do not change an already fixed snapshot. Neither format fabricates absent facts or treats an unobserved interval as complete zero usage.

## Scoped budget policies and requested state

Use the project route `/v1/organizations/{organizationId}/projects/{projectId}/budget`, or append `/environments/{environmentId}/budget` to the project path. `GET` accepts organization read or budget-grantor authority. `PUT`, `POST .../pause`, and `POST .../resume` require the installer-issued `cpbgt_...` grantor for that organization.

`PUT` accepts exactly `expectedRevision` as an unsigned decimal string, `period: { start, end }`, and nonempty `granted` containing any of the seven metric keys with decimal-string allowances. Omitted dimensions are unlimited for that policy, and a supplied `"0"` is an explicit zero allowance. The period is a positive UTC millisecond interval whose end is in the future. First configuration expects revision `"0"`. An existing period's start/end and metric-key set are immutable; values can change under compare-and-swap. A new period requires the previous period to have ended, cannot overlap it, and cannot retrospectively cover already recorded usage or allowance intervals. Historical accounts are retained.

Pause/resume accepts exactly `{ "expectedRevision": "..." }` and requires a configured budget. Successful policy changes increment decimal-string `revision` and `executionEpoch` and record an immutable revision. Pause stores `requestedState: paused`; resume stores `running`. They do not stop/start Pods, connections, or PostgreSQL. A stale revision returns `409 revision_conflict`; a concurrent accounting transaction can return `409 accounting_conflict` and requires a fresh read before retry.

Every successful read/change returns `{ "budget": ... }` with `scope`, `revision`, `executionEpoch`, `requestedState`, `configured`, `unlimitedDimensions`, `runtimeEnforced: false`, `enforcementStatus: pending_runtime`, `account`, and `reservations`. An unconfigured budget has revision/epoch `"0"`, running requested state, `account: null`, and no reservations. A configured budget adds `reservationsTruncated` and an account containing `id`, `period`, `granted`, `consumed`, `reserved`, `remaining`, `overrun`, and decimal-string `gapCount`.

For a limited metric, remaining is `max(granted - consumed - reserved, 0)` and overrun is `max(consumed + reserved - granted, 0)`. These are authority-ledger counters, not measured runtime enforcement. The budget view includes at most the oldest 100 project/environment receipts, with `reservationsTruncated` indicating more; `expired` marks an issued receipt past its expiry. It never exposes a fence token. Account quantities and receipt revisions/epochs are exact decimal strings. The current API offers no budget deletion, historical-account listing, credit conversion, retail price catalog, invoice, threshold-event stream, or payment service.

## Allowance reservation and evidence settlement

An authenticated region requests `POST /v1/regions/{regionId}/allowance-reservations` with exactly `requestId`, `environmentId`, `leaseSeconds` (30–300), and `units`. IDs are lowercase UUIDs. Units are a nonempty metric vector with at least one positive quantity. The environment must belong to that region. `(regionId, requestId)` identifies the request: an identical replay returns its existing receipt, including after policy changes; a changed body returns `409 request_conflict`. Replaying a receipt never extends its expiry or issues new authority.

New reservations test every applicable parent-project and selected-environment budget and every limited metric, treating omitted requested dimensions as zero. Requested state must be running, active periods must cover issuance and the whole lease, and consumed + reserved + requested units must fit each grant. The same D1 transaction reserves all applicable accounts and stores the receipt; concurrent writers share a project fence and conditional account versions. A missing budget means its dimensions are unlimited; it does not provide a hard runtime cap.

The response is `{ "reservation": ... }`. The receipt contains `id`, `environmentId`, `regionId`, integer `specRevision`, `specHash`, decimal-string `epoch` and `revision`, `units`, `issuedAt`, `expiresAt`, `status`, decimal-string `gapCount`, nullable `stoppedAt`, the two non-enforcement fields, and `fenceToken`. `GET /v1/regions/{regionId}/allowance-reservations/{reservationId}` returns the same protected receipt to that region with `operations:claim`. The receipt epoch captures applicable budget execution epochs; it is not an execution lease epoch.

Expiry alone does not release reserved units. Expired issued holds remain reserved until evidence settlement; new reservations for the project are blocked by an expired issued receipt or any historical receipt gap. Applicable active-account gaps also block new authority. Advancing to a clean new policy period cannot bypass a gap bound to an old reservation/account. Pause prevents new authority, while historical readback and settlement remain possible.

`POST /v1/regions/{regionId}/allowance-reservations/{reservationId}/settlement` requires `operations:report` and exactly `fenceToken`, `epoch`, `expectedRevision`, `usageRefs: [{ factId, revision }]`, `stoppedAt`, and `stopEvidenceHash`. References contain 1–32 distinct fact IDs and safe positive revision integers. Epoch and expected receipt revision are decimal strings. The fence must match the receipt; stop time cannot precede issuance, lie in the future, or move backwards on later settlement evidence.

Each reference must identify the current accepted head, have `final` status and an explicit quantity, belong to the receipt's organization/project/environment/region, and lie inside `[issuedAt, stoppedAt]`. Pre-authority usage cannot settle the receipt. Every metric with positive reserved units needs explicit final evidence, including an explicit zero fact when actual usage was zero. Missing, provisional, or gap evidence cannot silently release its hold. Already linked facts cannot be removed or assigned to a different reservation.

Settlement charges actual accepted facts to each bound account and releases the receipt's reserved hold atomically. Actual usage is not clipped to the reservation or grant; it may report an overrun, including measured work beyond the intended expiry. Accepted normalized settlement evidence is immutable and replayable without double consumption. A changed evidence set requires the current receipt revision.

Subsequent accepted revisions of a settled fact update its immutable correction record, linked revision, receipt revision/gap counter, and all bound accounts in the same transaction as usage acceptance. A known final correction charges its exact positive or negative delta. A new provisional/gap head retains the last known charge and records a coverage gap instead of crediting unknown usage to zero; a later final head resolves that gap and corrects the historical account. Fact-head and linking fences prevent simultaneous settlement/correction from losing a delta.

## Dedicated fence-key custody and unfinished runtime work

Replayable fence credentials are encrypted in D1 with AES-256-GCM using the dedicated `ALLOWANCE_FENCE_KEYS` Worker Secret. Its JSON structure is `{ "active": "v1", "keys": { "v1": "<base64url encoding of 32 random bytes>" } }`, with at most eight named keys. Version names contain 1–32 letters, digits, `_`, `.`, or `-`. Store only this keyring in Worker Secrets; the documentation placeholder is not a key. Never reuse a Contabo/Cloudflare provider credential or the installation bootstrap token as a fence encryption key.

The encrypted receipt stores key version, random 12-byte IV, ciphertext, and a token digest. Authenticated context binds reservation ID, environment ID, region ID, and spec hash. Keep old versions available while any retained receipt needs replay/decryption; replacing the active key does not re-encrypt old receipts. Missing, malformed, or unavailable keys cause `503 fence_key_unavailable`. Key backup/recovery and historical key retirement must be explicit operator procedures before production. The current rollout must not issue live accounting receipts until that keyring is configured and recovery is verified.

M6 still needs an independent runtime supervisor, durable regional usage/allowance journal, atomic admission/allocation checks, expiry guard that survives restarts/control outages, clock/epoch handling, and measured stop/overshoot behavior. It must collect trustworthy physical resource facts, enforce all relevant dimensions, and reconcile after uncertain outcomes before these APIs can support a hard runtime cap. An API `paused` state, an accepted reservation, or a `settled` receipt is not that evidence. PostgreSQL data and retained backups must remain safe under a future enforcing stop.

## Validation and release status

This implementation adds three bounded top-level cases across `usage.test.ts` and `budgets.test.ts`: snapshot/revision export, grantor policy authority, and hierarchical reservation/settlement/correction. The total local suite passed 15 Worker cases and one Node case after a reported typecheck stop and narrow helper correction. The [release checkpoint](../evidence/m3-usage-budget-authority-2026-09-28.md) records that history and the verified Dev probes. These selected checks do not complete the collector, enforcer, backup qualification, or M3/M6 release. The dedicated fence-key Worker Secret is deployed privately, while actual ingestion, protected receipt replay, settlement, and regional stopping remain unverified live. Regional admission stays closed and runtime accounting qualification remains pending.

Larger settlement support requires Workers Paid, or an explicitly lower reference limit qualified on Workers Free. [D1 currently permits](https://developers.cloudflare.com/d1/platform/limits/) 1000 queries per paid Worker invocation, 50 on Free, and 100 bound parameters per query. The reads and transaction guards grow with the settlement's 1–32 references. These local cases do not establish all supported settlement sizes on Free or prove production D1 throughput.
