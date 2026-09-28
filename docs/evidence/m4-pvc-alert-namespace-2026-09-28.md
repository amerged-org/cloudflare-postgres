# M4 PVC alert namespace correction — 2026-09-28

Status: **one-expression correction and two-case proof qualified in source;
target-only runtime promotion pending**. Core/default Rules and the original
platform source remain unchanged. Operational acceptance is still incomplete.

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

Actual retained object identities, the single loaded expression, cleared false
alerts and preserved Node/database/PVC/SQL state remain the next runtime gates.
Other namespace-filtered controller/upstream rules still require useful-input
evidence. Do not infer complete operational coverage from expression health.

## Separate API-server scrape defect

One fresh read-only observation confirms the Kubernetes API-server target is
DOWN with `sample limit exceeded`: 47,231 scraped samples become 32,251 after
metric filters, exceeding the configured 20,000 cap. The aggregate sample-limit
warning's Prometheus self-job label does not identify the offending endpoint;
the actual target does. This observation takes 0.644 seconds and changes no
configuration. The capacity correction is separate from this frozen candidate.
No existing limits, alert receiver, host, workload, Barman or R2 configuration is
changed here, and no notification is sent.
