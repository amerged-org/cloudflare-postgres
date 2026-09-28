# M3 usage and budget authority checkpoint — 2026-09-28

Status: **development accounting control deployment with local ledger verification; runtime qualification pending**. This checkpoint records a deployed Worker and additive D1 schema, purpose-specific credentials, exact project budget grants, and requested policy state. There are no API-managed environments, accepted usage facts, or allowance receipts. Regional admission remains closed. The regional collector, allowance supervisor, durable journal, expiry guard, and PostgreSQL stop behavior remain to be implemented and qualified.

## Implemented control authority

- Migration `0006_usage_ledger.sql` adds regional source identities and separate meter credentials, immutable usage identities, append-only revisions, exact quantities, acceptance sequences, and project accounting fences. Facts are restricted to positive subintervals within one UTC minute. `provisional`/`final` carry explicit decimal-string quantities; `gap` carries null.
- Usage reads expose fixed acceptance-watermark JSON/NDJSON pages, tenant-bound cursors, page-local totals, and explicit unknown coverage. A revision replay cannot double-ingest a fact; later corrections preserve older export snapshots. No complete-window total, observed zero, price, or invoice is fabricated from absent observations.
- Migration `0007_budget_authority.sql` adds organization grantor credentials, scoped project/environment policies, accounts with immutable periods, immutable policy revisions, allowance reservations, final-fact settlement evidence, and correction records. Quantities, policy/receipt revisions, epochs, and gap counters are exact decimal strings.
- Installer-issued `cpmtr_...` tokens carry only `usage:write`; installer-issued `cpbgt_...` tokens carry `budgets:read`, `budgets:write`, and `usage:read`. Ordinary organization `projects:write` authority does not grant budget increases, and a regional executor credential cannot ingest meter facts.
- Conditional budget writes and requested pause/resume advance authority revisions/epochs. Allowance transactions reserve across all applicable parent/environment dimensions, retain expired holds until explicit final evidence, and preserve actual overruns and historical correction/gap accounting. Replayable fence credentials use a dedicated AES-GCM Worker Secret and retained key versions.

The [implementation contract](../contracts/usage-budget-authority-v1.md), [control API guide](../../apps/control-api/README.md), and [OpenAPI](../../apps/control-api/openapi.yaml) describe the shipped shapes. Budget resources and allowance summaries continue to report `runtimeEnforced: false` and `enforcementStatus: pending_runtime`. A stored requested pause does not prove that PostgreSQL stopped.

## Bounded local verification history

The baseline was 12 Worker cases and one Node case. The accounting slice added three top-level Worker cases: one usage revision/snapshot case and two budget authority/settlement cases. The total is 15 Worker cases and one Node case. No test matrix, generated permutations, or speculative edge-case suite was added.

The usage case first failed on the absent route with `404`. After the initial implementation, its stale-parent assertion returned `400` where the contract required `409`; one bounded correction made the case green. Both budget cases first failed on missing routes with `404` and passed after the initial implementation. An expanded assertion in the existing settlement case then demonstrated that omitted positive RAM evidence incorrectly returned `200` instead of `409`. One combined repair covered the concrete metric-evidence, temporal-bound, and historical-gap authority defects; the same case became green.

The initial once-only final-gate invocation passed formatting in 1.17 seconds and lint in 1.616 seconds, then failed typecheck in 1.637 seconds on two shared-helper type errors. Work stopped and the failure was reported. The continuation copied encoded context bytes into an explicit `ArrayBuffer` and set `ignoreBOM: false`; it did not widen the feature or add tests. The targeted control-API typecheck passed in 0.992 seconds, and the edited helper's targeted format check passed.

Only the previously unrun full Vitest and `test:node` stages were then executed, passing 15 Worker cases and one Node case. The already-run broad format/lint/typecheck stages were not restarted. This record describes a stopped gate and limited continuation, rather than an uninterrupted clean full-gate run. The local cases verify software ledger behavior; they do not establish physical collection or runtime stopping.

## Verified Dev deployment

- A pre-migration D1 export was saved in an ignored private file with owner-only (`0600`) permissions.
- Additive migration `0006` completed 14 commands and `0007` completed 22. They do not alter the prior catalog, admission, environment, or operation tables. The remote migration list reported no outstanding migrations afterward.
- The updated Worker bundle was 111.70 KiB. Deployment completed in 6.31 seconds and trigger updates in 1.89 seconds; the deployed version was read back privately.
- The remote foreign-key check returned zero violations. Organization, project, environment, and operation counts matched the private pre-migration export. Environment, usage-fact, and allowance-receipt counts remained zero.
- Readback of the saved logical project preserved its ID and `active` state. Installation-authorized admission read returned `200` with `acceptingNewEnvironments: false`.
- The dedicated `ALLOWANCE_FENCE_KEYS` Worker Secret was deployed with its value hidden. No provider or bootstrap credential was reused. Its deployment does not prove a receipt encrypt/decrypt round trip; no receipt exists yet.

Credentials and deployment identities remain outside public documentation and Git. Meter/grantor tokens from the probes were retained only in the ignored local environment file.

## Verified live API behavior

1. Usage JSON returned `200` with zero records, empty page totals, a decimal-string watermark, and unknown coverage. NDJSON returned `200` with one metadata line and unknown coverage. Empty results were not presented as complete zero usage.
2. Installation-only meter issuance returned `201` with `usage:write`. Budget-grantor issuance returned `201` with `budgets:read`, `budgets:write`, and `usage:read`.
3. An ordinary organization manager's budget PUT returned `403 budget_grantor_required`. A grantor's authorized project-budget PUT returned `200` and preserved `"900719925474099312345"` exactly as a string. Reusing its stale policy revision returned `409 revision_conflict`.
4. Authorized pause/resume returned `200` with requested `paused`/`running` state while `runtimeEnforced` remained false. These probes observed D1 policy authority and did not attempt to stop PostgreSQL.
5. An executor token on usage ingestion returned `401`. A meter's unknown-environment ingestion request returned `404`; an allocator's unknown-environment request also returned `404`. Neither request created a fact, receipt, or database environment.

These checks verified deployed authority boundaries, exact quantities, and preserved data without opening admission or fabricating an environment for a positive accounting probe.

## Qualification still required

Real usage ingestion, receipt encryption/decryption and replay, settlement, and subsequent correction remain unverified live. They require a qualified API-managed environment and trustworthy source evidence; the manually created M1 lab database is not such an environment. Do not infer those paths from the successful empty reads or project-budget writes.

M6 still requires a runtime collector/supervisor, durable regional journal, restart-safe expiry enforcement, admission/allocation checks, and measured stop/overshoot behavior during normal operation and management outages. SDK, retention/archival, key recovery, broader operational qualification, native access, backups/PITR, and the remaining v1 lifecycle work are also pending. Larger settlement support requires Workers Paid or a separately qualified lower Free reference limit, as recorded in the implementation contract.

The full scope remains in [PLAN.md](../../PLAN.md). This checkpoint does not complete M3, M6, or open-source production readiness.
