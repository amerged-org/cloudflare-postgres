# M4 platform telemetry — 2026-09-28

Status: **four stateless monitoring objects Ready and actual data observed in
Dev; a namespace join defect prevents operational acceptance**. This continues
the warm single-node telemetry proof; it does not establish production
isolation, capacity, recovery or billing.

## Scope, source and bounded operation

The [held target bootstrap](../../infra/telemetry/bootstrap/flux-sync-targets.example.yaml)
uses the existing telemetry source at
`59a6b3c0ef2481287963c54b81e0ef39751bbf0d`. Three exact target files are read back
from that public commit. The existing [target inventory](../../infra/telemetry/targets/kustomization.yaml)
contains two PodMonitors and two PrometheusRules; their selectors and expressions
are unchanged. Both core and all-default-Rules stages are current-generation
Ready. Ownership inventory confirms the new writer/four objects are absent.

The first private preflight stops because a completed old CNPG Pod still matches
the selector. Its captured phase is `Succeeded`, not a failing active service.
Offline selection distinguishes terminal Pods, retaining the stopped record.
Four active Flux Pods and one active CNPG operator Pod are Ready with the named
metrics ports. The four objects pass server-side admission without persistence.
No selector, permission, network policy or existing workload is weakened.

Independent operation review finds and corrects deadline/hold-reserve and
full-source/dependency-fence gaps before invocation. A one-use ledger precedes
one separate `pgcf-telemetry-targets` Kustomization create. Its normal calls have
a 120-second bound and a reserved safety window to 150 seconds. Uncertain create
outcomes do not permit another create; only the matching operation/UID/spec may
be held by resourceVersion-guarded patch.

The writer becomes Ready in 3.814 seconds. All four actual API-admitted specs,
selection labels and separate Kustomize ownership pass. The existing 30 default
Rule UIDs/specs and source/dependency identities/specs are preserved. Only this
stateless inventory permits pruning, with Orphan deletion policy. No chart,
platform-source, host, database volume, Barman or R2 change accompanies it.

## Volume observations and corrected configuration inference

The first post-TLS Prometheus snapshot contains twelve filesystem samples and
144 Flux scalar series across four configured resource kinds. Its initial
direct `namespace` join incorrectly maps zero of four bound PVCs. The volume
values are present; this is a label-attribution defect, not missing driver
statistics. Pinned [OpenEBS LVM 1.10.1 advertises and implements volume
statistics](https://github.com/openebs/lvm-localpv/blob/e8a234cbfeef5fa16fde1330c8de2d91e31831f1/pkg/driver/agent.go#L381).
The selected chart's metric filter does not drop those series.

An initial interpretation of Talos's rendered `volumeStatsAggPeriod: 0s` as
disabled collection is premature and corrected before any write. The pinned
[Talos builder](https://github.com/siderolabs/talos/blob/2f86b9d2a29b413deddd7122a8420b8913813615/internal/app/machined/pkg/controllers/k8s/kubelet_spec.go#L240)
serializes typed configuration; [Kubernetes defaults zero duration to one
minute when loading it](https://github.com/kubernetes/kubernetes/blob/0f29094e5b73085e3802ecc1298ecae13866bfe6/pkg/kubelet/apis/config/v1beta1/defaults.go#L164).
Authenticated running `/configz` confirms `1m0s`; `/stats/summary` maps all four
PVCs and raw `/metrics` contains 24 volume-stat samples. This read-only diagnosis
completes in 0.518 seconds. No period patch, additional kubelet restart or driver
replacement is performed. Inspection of the original buffered query confirms
its twelve volume samples already carried `exported_namespace`; a cache-delay
explanation is not needed for that snapshot's failed mapping.

## Runtime observations and the remaining defect

The first bounded read-only observer completes its target/Rule checks and stops
at the direct namespace join in 1.358 seconds; its failure record is retained.
Actual generated configuration verifies the phase drop for completed Pods and
all three kubelet HTTPS/CA configurations without insecure verification.
Five selected controller scrapes are UP, match the expected Pod UIDs, use the
named HTTP metrics ports and occur after writer creation. Both platform Rule
groups select their actual source UIDs; all seven rules evaluate healthy after
creation with matching names, labels, annotations and alert durations. These
are evaluation/metadata facts, not a proof that their alerts are useful.

Buffered observations expose the defect: `overrideHonorLabels: true` preserves
the discovery target's namespace and moves conflicting exporter namespaces to
`exported_namespace`. Kubelet volume samples retain `namespace="kube-system"`;
their intrinsic PVC namespaces are in `exported_namespace`. A read-only mapping
using the intrinsic namespace finds all four PVCs, with finite coherent
capacity/used/available values. Actual API comparison binds generation to
nineteen Flux resource UIDs and verifies both observed generations/Ready values
for eighteen active objects. The two active/current-Ready recording sets exactly
match that API snapshot. The follow-up completes in 0.349 seconds and does not
repeat source activation or refetch the Prometheus response.

`PGCFPVCMetricsMissing` nevertheless produces four incorrect pending alert
instances for those same PVCs because its current `namespace` join compares
discovery namespaces. This concrete RED remains open. The smallest next repair
normalizes each operand's namespace from `exported_namespace`, retaining the
existing join and global settings. Two meaningful cases can verify that four
present PVCs produce zero missing alerts and one missing sample produces one.
It does not qualify other namespace-filtered rules or rewrite the Rule bundle.
The same saved snapshot reports one firing `TargetDown` and one firing
`PrometheusScrapeSampleLimitHit`; their causes are separate unresolved facts.
Do not advertise operational acceptance. Source pins, selectors, expressions,
network policy and label-override configuration remain unchanged here.

One actual Alertmanager status response verifies only the `null` receiver and
null routes, with no integration keys. Its serializer also supplies
`labels: {name: "null"}`. An observer assuming a name-only dictionary fails;
an empty-label interpretation also fails, and the second offline correction
accepts exactly the observed name metadata while rejecting integration keys.
The two-correction counter is retained, with no third correction, repeated
status request or notification probe. Runtime notification configuration is
observed; alert usefulness is still unqualified.

A final bounded read-only preservation check completes in 1.282 seconds: Node
UID/boot identity remains Ready without pressure, seven selected Pod identities
and restart counts are unchanged, all four PVC identities/bindings remain Bound,
PostgreSQL is Ready and both existing SQL marker counts are one. It does not
erase the alert defects or establish uninterrupted availability.

Filesystem values are operational observations; they do not measure LVM VG free
extents, prove storage limits or become customer usage authority. Sustained
cardinality/memory/storage growth, namespace/API isolation, alert usefulness,
fresh cold bootstrap, maintenance and recovery remain open. No notification is
sent. No new runtime tests or full workspace gate are run for these manifests
and bounded readbacks; stopped SDK/Barman/R2 work and prior operation counters
remain preserved.
