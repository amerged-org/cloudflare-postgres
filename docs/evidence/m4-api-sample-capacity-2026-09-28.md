# M4 API-server sample capacity — 2026-09-28

Status: **core-only Dev revision-three upgrade and two-scrape capacity proof
qualified**. A history-observer stop and a guarded same-revision unhold are
retained below. The PVC correction remains on its independent target source.
Production capacity and complete operational acceptance remain unproven.

## Measured defect and acceptance boundary

A fresh read-only snapshot confirms the API-server target DOWN with sample-limit
rejection: 47,234 raw samples become 32,254 after filters, exceeding 20,000.
Prometheus has 37,337 head series, 287,191,040 resident bytes and 2,098,781 stored
block bytes. Resident memory is bound to the instance that emits head series;
an initial observer confused the config reloader's second same-job gauge and is
corrected from the buffered response without another request.

The correction allows 40,000 for the API target, retains an explicit 20,000
default and sets the enforced ceiling to 40,000. The ceiling must permit that
exception; raising a monitor alone is clipped by the maintained Operator.
All other thirteen jobs must retain their actual 20,000 effective limit.
Honor-label, target/label limits, TLS, image, resource, storage and retention
settings are unchanged.

Runtime acceptance requires fourteen unchanged job identities, exactly one
higher effective limit, two successful API scrapes over at least ninety seconds,
finite memory below the declared 1536Mi limit, measured head-series/storage
impact, preserved 24h/4GB retention and unchanged Node/Pod/PVC/SQL state. These
snapshots are a warm lab check, not sustained production sizing evidence.

## Bounded TDD and production render

Exactly one [named test](../../infra/telemetry/tests/sample-limits/sample_limits_test.go)
calls the pinned Operator v0.94.1 configuration generator on the selected render
inputs. It does not reimplement clipping policy. The first two failures are
setup failures, not behavioral RED: an overly strict version guard rejects the
actual `v3.15.0-distroless`, then cache-only generation lacks a referenced token.
Two setup corrections preserve the actual object/version and seed derived
authorization references with dummy bytes in the offline cache. Warning/error
rejection remains enabled; no live token, client or monitor substitution is used.
A diagnostic-only run retains the actual missing-reference messages.

The meaningful RED then reports API effective limit 20,000 rather than 40,000
in 12.976 seconds. One three-field implementation correction passes the named
case in 49.002 seconds. There are no new cases, subtests or generated matrices.

The exact pinned Helm SDK4 render/digest method is reused in a new private copy.
Baseline revision two and candidate revision three are both upgrades. Baseline
configuration digest calibrates to `sha256:a9973221f4447fd250b05089ec58fda8a49cfa81776ad13b8671a9f2dad28621`;
candidate digest is `sha256:203300f8311e3127a33bd87ddeadeff2ae9684b922295f5d9572b5610977651c`.
Only Prometheus and the API ServiceMonitor change; 37 other core payloads and
all ten CRDs are identical. Input values reject duplicate keys separately from
strict rendered-manifest parsing. The pre-existing Helm table-coalescing warning
does not change the rendered filesystem-access denial or any security payload.

The single case is rebound to those exact production render inputs. Independent
review passes and the frozen five-file candidate runs the canonical
build/format/lint/typecheck/Vitest/Node gate exactly once, plus Go formatting/vet
and that one case. All pass in 141.276 seconds without candidate changes. The
22 stopped SDK files remain unchanged and excluded; no stopped work is resumed.

## Controlled core promotion

The [held core-only bootstrap](../../infra/telemetry/bootstrap/flux-sync-core-capacity.example.yaml)
pins the reviewed independent source at `8b91c9cf5e4f5346b598f5e1a5ee1fa88fdbe5c0`
and the existing core writer. Preserve the original source for default Rules,
the corrected target source, platform and kubelet source pins. Hold the same core
writer before its Helm release, retain the ten-resource health graph and
non-pruning/Orphan policy, then perform one guarded reference handoff and
revision-three upgrade. A new operation ledger must not replay previous install
or upgrade ledgers. Preserve old Helm storage identities while allowing revision
two to become superseded.

One guarded operation installs revision three with the exact candidate digest,
then stops after 27.347 seconds because its observer requires revision one to
remain in the status history. The same core writer and release are safely held.
Authoritative release readback proves `UpgradeSucceeded`, deployed revision
three and superseded revision two. A separate metadata-only wire observation
proves the original revision-one/two Secret UIDs are retained and exactly one
new deployed revision-three record exists. No Secret payload is read.

The pinned controller intentionally truncates its in-sync status projection to
the latest and an eligible previous snapshot. The observer incorrectly equates
that projection with storage retention; it is not an upgrade failure or an
unverified cache promise. The original failed observation/ledger remains sealed.
The [controller source](https://github.com/fluxcd/helm-controller/blob/v1.6.4/internal/reconcile/atomic_release.go)
distinguishes in-sync no-action handling from another upgrade.

A 92.928-second read-only observation proves all fourteen loaded job identities,
API limit 40,000 and thirteen unchanged 20,000 limits. Two successful API scrapes
over 90.199 seconds retain 32,321 samples; the sample-limit failure counter stays
416. Resident bytes are 309,436,416 then 312,844,288; head series are 49,306 then
49,772. Block bytes remain 6,856,586 and head-chunk storage 2,910,841. The bound
Prometheus filesystem uses 41,639,936 then 42,131,456 bytes of 8,350,298,112,
with positive free space. Memory stays below 1536Mi and 24h/4GB retention is
unchanged. These are measured short-window effects, not long-term projections.

Node UID/boot identity is Ready without pressure; seven selected Pod UIDs and
regular-container restart maps, four PVC UIDs/bindings, Ready PostgreSQL and both
SQL marker counts are preserved. A distinct reviewed one-use recovery changes
only the same core's suspension flag. The overlay automatically resumes the
same release; both reach current-generation Ready in 8.742 seconds, still at
revision three without another upgrade. Exact source/values/digest fences,
unhandled force/reset rejection and a reserved safety hold protect this unhold.
No original activation is replayed and no frozen source or test is changed.

This operation changes no customer admission, host, database, Barman or R2
configuration. Broader rule-input, isolation, sustained-resource, recovery and
maintenance qualification remain open.
