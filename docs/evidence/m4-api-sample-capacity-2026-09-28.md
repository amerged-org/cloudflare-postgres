# M4 API-server sample capacity — 2026-09-28

Status: **bounded capacity correction qualified in source; core-only Dev
promotion pending**. The completed PVC correction remains on its independent
target source. Production capacity and complete operational acceptance remain
unproven.

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
uses a reviewed independent source and the existing core writer. Replace its
commit placeholder before use. Preserve the original source for default Rules,
the corrected target source, platform and kubelet source pins. Hold the same core
writer before its Helm release, retain the ten-resource health graph and
non-pruning/Orphan policy, then perform one guarded reference handoff and
revision-three upgrade. A new operation ledger must not replay previous install
or upgrade ledgers. Preserve old Helm storage identities while allowing revision
two to become superseded. Actual rollout and the declared runtime evidence are
pending. This operation changes no customer admission, host, database, Barman
or R2 configuration.
