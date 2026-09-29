# Immutable compute size catalog checkpoint — 2026-09-29

The optional `computeScaling` policy lets an installation operator publish two
to eight fixed CPU/RAM sizes in a new immutable regional profile version. The
sizes have distinct bounded ASCII IDs and increase strictly in both dimensions.
`initialSizeId` must select exactly the original profile's CPU and RAM, including
when that size is not the smallest. Existing profiles omit this field and retain
their previous normalized serialization and hash. The public projection exposes
only size IDs and CPU/RAM amounts; private archive and storage references remain
redacted. The environment stores the full policy with its original immutable
resolved specification.

This source slice has no resize request, automatic decision, budget reservation,
capacity grant, D1 migration or Kubernetes effect. It does not enable scaling in
the Dev region. The [contract](../contracts/compute-scaling-v1.md) records why
those operations need a separate compute revision, funded target/overlap bound,
fleet headroom, leased quota/Cluster changes and actual Pod-resource readback.
The current CNPG single-instance topology would restart PostgreSQL during a
resource change and require client reconnection.

The task baseline was 83 automated cases. One new top-level Worker case was
added, giving 84 including six unchanged Go cases. That case first failed on
catalog publication (`400` instead of `201`) and then passed after the policy
implementation. No generated matrix or additional case was added.

The one permitted canonical gate ran format and lint successfully, then stopped
at TypeScript error `TS2345`: the already validated JSON object was passed to a
helper whose parameter required statically known numeric keys. The failure was
reported and preserved. A one-line type-only correction accepts
`Record<string, unknown>`; runtime integer bounds and strict equality still
run before/inside the helper. The owning package's typecheck passed after this
first correction. Independent review confirmed that reversing the single line
reproduces the frozen source hash and leaves legacy behavior unchanged.

The two previously unrun stages then ran once: all 30 Worker tests passed. The
regional Node run passed 45 of 48 cases; three existing platform-inspection
cases could not start because the fresh isolated worktree lacked the compiled
`dist/main.js` entry. That setup failure was reported. Building the unchanged
regional package and running only the affected test file made all three cases
pass. No source test was changed for the setup repair, and the full gate was not
repeated. The retained original gate, targeted repair and setup-failure records
remain separate private evidence.

The known-secret preflight scanned 419 public candidate files against 105
raw/encoded variants with zero matches. The final one-line change was checked
again. `.env.local` and `apps/control-api/.dev.vars` remained byte-identical,
ignored, untracked and mode 0600. `AGENTS.md` remained byte-identical at exactly
25 lines. No customer environment, size change, archive credential or node
operation was created during this source qualification.

## Public source and Dev control API

Commit [`6ec60d7`](https://github.com/amerged-org/cloudflare-postgres/commit/6ec60d776f903281ac1b7c1ef0b9923b6ee129c2)
publishes the source, OpenAPI schema, contract and test. The remote main commit
and three public blob hashes were read back. One Wrangler dry run and one
`--keep-vars` deployment used the existing Dev account and D1 binding; the new
Worker version received 100% of traffic. The same eight Secret names/types were
present before and after deployment; their values were not read or changed.
Four read-only scoped HTTP probes passed without creating resources.

This slice adds no D1 migration, Dev catalog record, customer environment,
regional image, R2 credential, Kubernetes right or physical scaling operation.
Existing admission remains closed. The Worker can validate and retain the new
optional policy when an installation operator publishes a future catalog
version. It does not currently resize or automatically scale a database.
