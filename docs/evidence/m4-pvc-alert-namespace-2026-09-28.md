# M4 PVC alert namespace correction — 2026-09-28

Status: **source and target-only Dev promotion qualified; four false PVC alerts
cleared**. Core/default Rules and the original platform source remain unchanged.
API-server sample capacity and broader operational acceptance remain incomplete.

## Observed defect and bounded correction

The [platform telemetry snapshot](m4-platform-telemetry-2026-09-28.md) has four
pending `PGCFPVCMetricsMissing` alerts despite all four PVCs having filesystem
metrics. Global honor-label overriding preserves discovery namespaces and moves
resource namespaces to `exported_namespace`; the old join compares different
discovery namespaces.

Only that alert expression changes. Both operands restore `namespace` from a
nonempty `exported_namespace` using `label_replace`, retaining the existing
`on(namespace,persistentvolumeclaim)` join. The fifteen-minute delay, labels,
annotation, every other Rule, selectors and global honor-label settings remain
unchanged. No Talos-period change or additional kubelet restart is required.

Exactly two [focused cases](../../infra/telemetry/tests/pvc-metrics.test.yaml)
fail against the real old expression: four present PVCs produce four alerts
instead of zero; one missing capacity series produces four alerts instead of
one correctly attributed alert. The meaningful RED completes in 0.401 seconds.
One implementation correction passes both cases in 0.369 seconds. Fixtures use
generic labels, preserve the real delay and contain no private live values.
No matrix, additional cases or assertion weakening is introduced.

Independent source review passes. The frozen three-file candidate runs the
canonical build/format/lint/typecheck/Vitest/Node gate exactly once in an isolated
checkout, plus selected-rule syntax and the two named Promtool cases. All pass
in 16.390 seconds; source hashes remain unchanged. The 22 stopped SDK candidate
files are excluded and unchanged, not repaired or tested again. The
[test recipe](../../infra/telemetry/tests/README.md) pins the maintained Promtool
image and extracts the actual selected Rule from source.

## Runtime promotion boundary

Current authenticated observations verify three Ready sources and five Ready
writers, 32 Rules/two PodMonitors, the same revision-two core digest and Ready
PostgreSQL. The sole target writer still uses the shared telemetry source at
`59a6b3c0ef2481287963c54b81e0ef39751bbf0d`. Publish the correction, use a new
commit-pinned target-only GitRepository, hold the existing target writer by
UID/resourceVersion/spec guard, then change only its source reference and resume
the same writer. Explicitly preserve core/default Rules at their old source and
the original platform pin; cross-source dependencies alone do not prove pins.

The corrected Rule passes one server-side dry-run with exact spec in 0.453
seconds. One bounded operation then creates the separate source at
`c2d3ccb91d512f317ef7e74b3c0b12cedcb3c46c`, holds and switches the same target
writer, and becomes Ready in 5.224 seconds. Current new-source UID/spec,
generation/Ready condition, own operation marker and artifact pin are checked
before resume, during observation and at completion; old sources/dependencies
are independently fenced. All 32 Rule and two PodMonitor UIDs remain unchanged.
The sole spec delta is the expected expression. The consumed original activation
ledger is preserved; a new one-use ledger records this handoff.

A bounded read-only observer completes in 18.069 seconds. The same Rule source
UID's loaded query matches the correction after whitespace normalization;
post-handoff evaluation is healthy, retains the delay/metadata and has zero
alerts. Node UID/boot identity is Ready without pressure. Seven selected Pod UIDs and the
restart counts of their regular containers remain unchanged, as do four PVC
UIDs/bindings. PostgreSQL is Ready
and both SQL markers remain one. This is observed correction/preservation,
not uninterrupted availability or production recovery evidence.

The [held correction bootstrap](../../infra/telemetry/bootstrap/flux-sync-targets-correction.example.yaml)
provides the separate pinned source for adopters. Existing writers require the
documented guarded reference handoff, not replacement or blind apply. Other
namespace-filtered controller/upstream rules still require useful-input evidence.
Do not infer complete operational coverage from expression health. There is no
additional source/test change or full gate rerun after the frozen proof.

## Separate API-server scrape defect

One fresh read-only observation confirms the Kubernetes API-server target is
DOWN with `sample limit exceeded`: 47,231 scraped samples become 32,251 after
metric filters, exceeding the configured 20,000 cap. The aggregate sample-limit
warning's Prometheus self-job label does not identify the offending endpoint;
the actual target does. This observation takes 0.644 seconds and changes no
configuration. The capacity correction is separate from this frozen candidate.
No existing limits, alert receiver, host, workload, Barman or R2 configuration is
changed here, and no notification is sent.
