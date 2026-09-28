# Prepared operational telemetry

Status: **not installed or connected to the active Flux source**. The standalone HelmRelease is suspended. This is a one-node feasibility configuration, not an operational or production acceptance result. No external alert receiver is configured.

Reuse kube-prometheus-stack 91.8.0 / Prometheus Operator v0.94.1, with Prometheus, Alertmanager, kube-state-metrics and node-exporter. The chart archive and OCI manifest are verified; six selected runtime images use verified manifest digests with Linux/amd64 support. `versions.lock.json` records identities. Publisher signatures and runtime image compatibility are not yet qualified.

## Ownership and installation order

Flux owns this release and its values. Existing Flux-owned Cilium, OpenEBS and cert-manager are dependencies. Barman adoption and R2 access are independent, held tasks. Do not add this directory to the current platform source or unsuspend the release before the qualification gates below.

The root Kustomization contains two namespaces, the main namespace quota, a pinned OCIRepository, a values ConfigMap, a suspended HelmRelease and two Cilium policy objects. It does not contain monitoring CRs, so it can be staged before the new chart supplies its ten CRDs. `targets/` contains the CNPG/Flux PodMonitors and platform rules; apply it only after the exact CRDs and Operator are qualified. Reconcile these in separate ordered stages. Existing monitoring installations/CRDs require an ownership review; takeover is disabled, initial CRD installation uses Create, and upgrades skip CRDs until an explicit schema upgrade is reviewed.

The active platform path and its pinned source are unchanged. The independent [stage bootstrap](bootstrap/flux-sync-stage.example.yaml) pins a separate GitRepository/Kustomization and depends on the existing platform. It never repoints that platform source. No active-release manifest or implicit retry loop is provided. The Helm timeout is eight minutes and automatic remediation retries are zero. A failed check follows PLAN.md stop limits.

## Bounded lab footprint

Five steady Pods request 235m CPU and 1024Mi memory in total; declared limits total 1550m CPU and 2048Mi memory, including two reloaders. Prometheus requests an 8Gi `pgcf-lvm` PVC and retains 24 hours or 4GB, whichever is reached first. Alertmanager requests 512Mi with 24-hour retention. Main namespace quota bounds resource requests/limits, nine GiB requested storage, two PVCs and twelve Pods. Generated init containers and actual Pods still need API/PSA and resource validation.

Fresh lab observations found sufficient request headroom and roughly 90GiB free VG extents. Existing declared memory/CPU limits already exceed node capacity and many containers have no limits. Request fit and one memory snapshot do not establish safe simultaneous bursts, sustained headroom or production capacity. No old platform limits are silently changed. StorageClass retention does not itself prove recovery.

## Security and network gates

`pgcf-monitoring` uses restricted PSA v1.36. Only the separate `pgcf-node-metrics` namespace permits the trusted exporter hostNetwork/hostPID and read-only host mounts; the exporter runs non-root, drops capabilities and mounts no API token. It binds the selected host interface on TCP9100. Verified provider firewall configuration denies external TCP9100; **Pod-to-host access is not yet qualified**. The prepared boundary denies managed-Pod egress to host/remote-node TCP9100 except for the exact owned Prometheus namespace/service-account identity. Both default-deny directions stay off for that global deny. A separate main-namespace ingress policy admits its trusted namespace and the API-server admission port; other Pod sources are denied. The existing Cilium host firewall/routes/values are unchanged. Actual policy realization and packets remain gates; provider denial cannot substitute for them.

The actual Talos API-server admission configuration enforces baseline by default; the current CNPG operator identity and database namespace are not exempt. A server dry-run admitted the normal database security context and specifically denied hostNetwork under that same identity. No namespace patch was needed. Host/hostNetwork/unmanaged senders remain outside the managed-Pod deny; their identities and protected-namespace workload creation rights are trusted operator privileges. Platform API consumers receive no Kubernetes rights or caller-selected namespace/service-account fields. Independent adopters must preserve those boundaries.

ClusterIP and absence of Ingress do not prove tenant isolation. Qualify operator-only Prometheus/Alertmanager/exporter access and the exact allowed scrape paths. Kubelet certificate verification uses the cluster CA; diagnose TLS errors instead of disabling verification. The maintained Operator retains cluster-wide Secret/ConfigMap/workload privileges despite narrow process watch namespaces. Installation and monitoring CR creation remain trusted operator actions. Prometheus and reduced KSM roles have no Secret API access; KSM also has exact read-only Flux/CRD discovery permissions.

No SQL exporter, customer connection credentials, tenant workload or dynamic tenant policy is introduced. Prometheus is operational telemetry, not usage authority, an invoice source or budget enforcement. Alertmanager has only a null receiver. Grafana, Ingress, remote-write and OTLP ingestion are disabled. No third-party message is sent. OpenTelemetry tracing/log integration remains later work with its own data boundary.

## Evidence and remaining qualification

The pinned chart renders with Kubernetes 1.36.3, including ten CRDs and no hook Jobs. Promtool from the verified Prometheus v3.15.0 image passed all 32 rule files / 227 expressions, including reused upstream rules; these are configuration rules, not new tests. Their contents are unchanged after image pinning. No runtime tests or full workspace gate were added/run for this infrastructure delivery.

The root and target Kustomizations build separately. Five staging resources passed a server-side dry-run; the quota in the uncreated namespace and monitoring CRD/CEL/generated-Pod admission remain pending. No staging object was persisted.

Flux state uses maintained KSM customResourceState, four exact GVKs and scalar generation/readiness/suspension/deletion/reconciliation metrics. Current Ready requires both resource and Ready-condition observed generations to equal positive metadata generation. UID matching avoids mixing recreated objects. Suspended/deleting resources are excluded; missing expected-kind series alerts separately. Individual missing objects, malformed/duplicate conditions, stale exporter watches and source/image identities are not completely proven by these rules. Actual emitted series and alert evaluation remain unqualified.

Before activation, verify current capacity/limits, API/CEL/PSA admission and generated Pods, cert-manager admission readiness, exact images and resource bounds, the tenant/host network boundary, verified kubelet TLS, named targets/PVC statistics, actual Flux series and useful alert states, null-receiver behavior, sustained cardinality/memory and storage growth. Filesystem/PVC metrics do not measure LVM VG free extents. The platform still needs authoritative capacity observation, recovery/PITR, updates, quorum and node-loss acceptance.

See [the evidence checkpoint](../../docs/evidence/m4-telemetry-preparation-2026-09-28.md), [third-party provenance](THIRD_PARTY.md), [the canonical plan](../../PLAN.md), [Flux metrics](https://fluxcd.io/flux/monitoring/metrics/) and [pinned KSM custom metrics](https://github.com/kubernetes/kube-state-metrics/blob/v2.20.0/docs/metrics/extend/customresourcestate-metrics.md).

The [boundary qualification checkpoint](../../docs/evidence/m4-telemetry-boundary-2026-09-28.md) records current admission and KSM evidence, policy scope, staged ownership and the remaining effective-data-path proof.

The stage deliberately disables pruning and uses Orphan deletion policy; both namespace and protective network-policy objects additionally disable Flux pruning. Retiring or weakening protection requires an explicit reviewed operation after the listener/workloads are removed. Source removal cannot silently retire the protected resources while a retained HelmRelease remains.
