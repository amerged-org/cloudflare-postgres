# Operational telemetry qualification

Status: **core, default Rules and four platform monitoring objects Ready in
Dev**. Core source `8b91c9cf5e4f5346b598f5e1a5ee1fa88fdbe5c0` supplies deployed
Helm revision three; default Rules retain `59a6b3c0ef2481287963c54b81e0ef39751bbf0d`.
Core/CRDs and two bound telemetry PVCs are preserved. A separate pinned target source owns the four stateless platform
objects after the guarded correction. Five controller targets and seven
selected Rule evaluations pass, and four false PVC-missing alerts are cleared.
API-server capacity passes a measured two-scrape window while keeping all
thirteen other effective limits unchanged. Other namespace-sensitive input
coverage and sustained/isolation/recovery evidence keep operational acceptance
incomplete. This is a warm one-node feasibility continuation,
not fresh-bootstrap or production acceptance. Actual Alertmanager configuration
has only the null receiver and no integration. See
[the API capacity evidence](../../docs/evidence/m4-api-sample-capacity-2026-09-28.md),
[the platform telemetry evidence](../../docs/evidence/m4-platform-telemetry-2026-09-28.md),
[the ordered bootstrap evidence](../../docs/evidence/m4-telemetry-bootstrap-order-2026-09-28.md)
and [the historical install failure](../../docs/evidence/m4-telemetry-install-2026-09-28.md).

The core-only [capacity bootstrap](bootstrap/flux-sync-core-capacity.example.yaml)
uses the existing core writer with its unchanged ten-resource health graph and
held default. Existing writers require a guarded source-reference handoff.
The revision-three observer initially stopped on a bounded status-history
projection; retained metadata-only storage proof and one same-revision unhold
restore current readiness without another upgrade. Both records are preserved.

Reuse kube-prometheus-stack 91.8.0 / Prometheus Operator v0.94.1, with Prometheus, Alertmanager, kube-state-metrics and node-exporter. The chart archive and OCI manifest are verified; six selected runtime images use verified manifest digests with Linux/amd64 support. `versions.lock.json` records identities. Publisher signatures and runtime image compatibility are not yet qualified.

## Ownership and installation order

Flux owns this release and its values. Existing Flux-owned Cilium, OpenEBS and cert-manager are dependencies. Barman adoption and R2 access are independent, held tasks. Keep this separate from the existing platform source. A controlled qualification installation may proceed only with current admission, network-denial, identity/image and capacity prerequisites; complete the generated-Pod/TLS/target/alert evidence before claiming operational readiness.

The root Kustomization contains two namespaces, the main namespace quota, a pinned OCIRepository, a values ConfigMap, a suspended HelmRelease and two Cilium policy objects. It does not contain monitoring CRs, so it can be staged before the new chart supplies its ten CRDs. `targets/` contains the CNPG/Flux PodMonitors and platform rules; apply it only after the exact CRDs and Operator are qualified. Reconcile these in separate ordered stages. Existing monitoring installations/CRDs require an ownership review; takeover is disabled, initial CRD installation uses Create, and upgrades skip CRDs until an explicit schema upgrade is reviewed.

The active platform path and its pinned source are unchanged. The independent [stage bootstrap](bootstrap/flux-sync-stage.example.yaml) pins a separate GitRepository/Kustomization and depends on the existing platform. It never repoints that platform source. The core keeps `defaultRules.create: false`; the complete upstream [Rule bundle](rules/README.md) is owned by a separate Flux Kustomization, with every expression and selector preserved. No rule scope is dropped.

The historical held [platform-target example](bootstrap/flux-sync-targets.example.yaml)
uses the shared telemetry source. The corrected
[target-only example](bootstrap/flux-sync-targets-correction.example.yaml) pins
its independent source, preserving core/default Rules at their reviewed source.
Both depend on core/default Rules readiness and own only the two existing
Flux/CNPG PodMonitors and two platform Rules. An existing writer requires a
guarded reference handoff preserving its UID/inventory, not blind template apply.
Explicitly verify protected source revisions and specs; cross-source readiness
dependencies alone do not establish those pins. Operator/Prometheus health is
an apply prerequisite; actual scrapes, series and rule evaluation must still be
observed. Preserve chart settings, all default Rules, network policy and storage.

Use the held [core qualification example](bootstrap/flux-sync-qualification.example.yaml) for an explicitly reviewed activation. Its named health checks wait for the current Helm release, Operator Deployment, generated Prometheus/Alertmanager StatefulSets, both Certificates/Issuers and both injected webhook configurations. Positive Certificate/Issuer conditions must match the resource generation. Webhooks require the expected service, port, namespace, nonempty CA and failure policy. Do not set `wait: true`, which would replace the explicit check list. The held [Rules example](bootstrap/flux-sync-rules.example.yaml) uses the same source and depends on that core Kustomization. [Flux health and dependency checks](https://fluxcd.io/flux/components/kustomize/kustomizations/#health-checks) provide the ordering; actual Rule admission still verifies the serving TLS path.

The existing failed release requires a reviewed meaningful configuration change and ownership/history inventory before an upgrade. Do not replay the consumed install observer or reset its counters. A warm upgrade cannot prove a fresh cold bootstrap. The Helm timeout stays eight minutes with zero automatic remediation retries. Core resources use no pruning; only the separate stateless Rule inventory may be pruned. A failed check follows PLAN.md stop limits and holds the writer before its release; it does not erase created Pods/PVCs.

## Bounded lab footprint

Five steady Pods request 235m CPU and 1024Mi memory in total; declared limits total 1550m CPU and 2048Mi memory, including two reloaders. Prometheus requests an 8Gi `pgcf-lvm` PVC and retains 24 hours or 4GB, whichever is reached first. Alertmanager requests 512Mi with 24-hour retention. Main namespace quota bounds resource requests/limits, nine GiB requested storage, two PVCs and twelve Pods. Generated init containers and actual Pods still need API/PSA and resource validation.

Fresh lab observations found sufficient request headroom and roughly 90GiB free VG extents. Existing declared memory/CPU limits already exceed node capacity and many containers have no limits. Request fit and one memory snapshot do not establish safe simultaneous bursts, sustained headroom or production capacity. No old platform limits are silently changed. StorageClass retention does not itself prove recovery.

## Security and network gates

`pgcf-monitoring` uses restricted PSA v1.36. Only the separate `pgcf-node-metrics` namespace permits the trusted exporter hostNetwork/hostPID and read-only host mounts; the exporter runs non-root, drops capabilities and mounts no API token. It binds the selected host interface on TCP9100. Verified provider firewall configuration denies external TCP9100; **The selected managed-Pod deny path is qualified**. The prepared boundary denies managed-Pod egress to host/remote-node TCP9100 except for the exact owned Prometheus namespace/service-account identity. Both default-deny directions stay off for that global deny. A separate main-namespace ingress policy admits its trusted namespace and the API-server admission port; other Pod sources are denied. The existing Cilium host firewall/routes/values are unchanged. Both selected endpoints realized revision6 with audit Disabled and explicit TCP9100 denies; one actual non-exempt connection produced matching denylist drops. Permitted Prometheus scraping, namespace API isolation and full telemetry remain gates. Provider denial does not substitute for Pod protection.

The actual Talos API-server admission configuration enforces baseline by default; the current CNPG operator identity and database namespace are not exempt. A server dry-run admitted the normal database security context and specifically denied hostNetwork under that same identity. No namespace patch was needed. Host/hostNetwork/unmanaged senders remain outside the managed-Pod deny; their identities and protected-namespace workload creation rights are trusted operator privileges. Platform API consumers receive no Kubernetes rights or caller-selected namespace/service-account fields. Independent adopters must preserve those boundaries.

ClusterIP and absence of Ingress do not prove tenant isolation. Qualify operator-only Prometheus/Alertmanager/exporter access and the exact allowed scrape paths. Kubelet certificate verification uses the cluster CA; diagnose TLS errors instead of disabling verification. The maintained Operator retains cluster-wide Secret/ConfigMap/workload privileges despite narrow process watch namespaces. Installation and monitoring CR creation remain trusted operator actions. Prometheus and reduced KSM roles have no Secret API access; KSM also has exact read-only Flux/CRD discovery permissions.

The [node-bound serving-TLS checkpoint](../../docs/evidence/m4-kubelet-serving-tls-2026-09-28.md)
now verifies initial automatic issuance and all three fresh HTTPS kubelet
scrapes in Dev, preserving Node boot identity, selected Pods, PVCs and SQL
markers. It does not establish a later renewal, fresh bootstrap, missing
filesystem statistics, or the remaining namespace/API isolation guarantees.

No SQL exporter, customer connection credentials, tenant workload or dynamic tenant policy is introduced. Prometheus is operational telemetry, not usage authority, an invoice source or budget enforcement. Alertmanager has only a null receiver. Grafana, Ingress, remote-write and OTLP ingestion are disabled. No third-party message is sent. OpenTelemetry tracing/log integration remains later work with its own data boundary.

## Evidence and remaining qualification

The pinned chart renders with Kubernetes 1.36.3, including ten CRDs and no hook Jobs. Promtool from the verified Prometheus v3.15.0 image passed all 32 rule files / 227 expressions, including reused upstream rules; these are configuration rules, not new tests. Their contents are unchanged after image pinning. No runtime tests or full workspace gate were added/run for this infrastructure delivery.

The root and target Kustomizations build separately. Five staging resources passed a server-side dry-run; the quota in the uncreated namespace and monitoring CRD/CEL/generated-Pod admission remain pending. That historical dry-run persisted no objects; the subsequent eight-object live stage is recorded in the boundary checkpoint.

Flux state uses maintained KSM customResourceState, four exact GVKs and scalar generation/readiness/suspension/deletion/reconciliation metrics. Current Ready requires both resource and Ready-condition observed generations to equal positive metadata generation. UID matching avoids mixing recreated objects. Suspended/deleting resources are excluded; missing expected-kind series alerts separately. Individual missing objects, malformed/duplicate conditions, stale exporter watches and source/image identities are not completely proven by these rules. Actual UID/generation/Ready series and active/current-Ready recording sets now match one API snapshot of nineteen resources/eighteen active objects. This is not an enduring watch-freshness guarantee.

Actual volume samples are present for all four bound PVCs, with intrinsic
namespaces in `exported_namespace` because global honor-label overriding is
enabled. The PVC warning now normalizes both operands to the resource namespace;
the [two-case correction](../../docs/evidence/m4-pvc-alert-namespace-2026-09-28.md)
clears all four false alerts in Dev while preserving global settings. Do not
infer useful input from healthy expression evaluation for other namespace-filtered
controller/upstream rules. The corrected API-server target retains 32,321
samples within its finite 40,000 allowance. Its fourteen-job identity set and
thirteen other 20,000 limits are unchanged; two distinct successful scrapes show
no additional sample-limit failures. Aggregate warning history can persist
until the existing five-minute window expires; do not erase counters to hide it.

Before activation, verify current capacity/limits, API/CEL/PSA admission and generated Pods, cert-manager admission readiness, exact images and resource bounds, the tenant/host network boundary, verified kubelet TLS, named targets/PVC statistics, actual Flux series and useful alert states, null-receiver behavior, sustained cardinality/memory and storage growth. Filesystem/PVC metrics do not measure LVM VG free extents. The platform still needs authoritative capacity observation, recovery/PITR, updates, quorum and node-loss acceptance.

See [the evidence checkpoint](../../docs/evidence/m4-telemetry-preparation-2026-09-28.md), [third-party provenance](THIRD_PARTY.md), [the canonical plan](../../PLAN.md), [Flux metrics](https://fluxcd.io/flux/monitoring/metrics/) and [pinned KSM custom metrics](https://github.com/kubernetes/kube-state-metrics/blob/v2.20.0/docs/metrics/extend/customresourcestate-metrics.md).

The [boundary qualification checkpoint](../../docs/evidence/m4-telemetry-boundary-2026-09-28.md) records current admission and KSM evidence, policy scope, staged ownership and the remaining effective-data-path proof.

The stage deliberately disables pruning and uses Orphan deletion policy; both namespace and protective network-policy objects additionally disable Flux pruning. Retiring or weakening protection requires an explicit reviewed operation after the listener/workloads are removed. Source removal cannot silently retire the protected resources while a retained HelmRelease remains.

The explicit [qualification overlay](../telemetry-qualification/README.md) changes only core release suspension; the root stage remains held by default. Its sibling layout avoids Kustomize ancestor cycles. The complete Rule bundle is deliberately separate and must use its core readiness dependency. Generated Pod/SA, all-Rule selection/evaluation and full telemetry checks still follow actual installation.
