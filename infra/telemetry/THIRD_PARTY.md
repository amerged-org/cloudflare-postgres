# Telemetry reuse provenance

The selected components have a **partial Dev installation, not operational acceptance**; the release is held after failed Rule admission. First-party integration files use the repository Apache-2.0 license. Upstream components retain their own licenses/notices. The [Rules directory](rules/README.md) includes generated upstream Rule configuration, with its Apache-2.0 license, NOTICE and exact provenance preserved. No upstream application binary is vendored. Exact chart and image identities are recorded in `versions.lock.json`.

| Upstream | Pinned selection | License | Reuse decision |
| --- | --- | --- | --- |
| [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/kube-prometheus-stack-91.8.0/charts/kube-prometheus-stack) | chart 91.8.0 | Apache-2.0 | Reuse maintained deployment, monitors and rules; configure bounded resources/security. |
| [Prometheus Operator](https://github.com/prometheus-operator/prometheus-operator/tree/v0.94.1) | v0.94.1 including reloader | Apache-2.0 | Reuse CRDs, reconciliation and config reloads; existing cert-manager supplies TLS. |
| [Prometheus](https://github.com/prometheus/prometheus/tree/v3.15.0) | v3.15.0-distroless image | Apache-2.0 | Reuse scrape/storage/PromQL and promtool. |
| [Alertmanager](https://github.com/prometheus/alertmanager/tree/v0.34.1) | v0.34.1 | Apache-2.0 | Reuse alert grouping/inhibition; only null receiver configured. |
| [kube-state-metrics](https://github.com/kubernetes/kube-state-metrics/tree/v2.20.0) | v2.20.0 / child chart 8.6.0 | Apache-2.0 | Reuse selected core collectors and exact Flux custom-resource state gauges. |
| [node-exporter](https://github.com/prometheus/node_exporter/tree/v1.12.1) | v1.12.1-distroless image | Apache-2.0 | Reuse trusted host metrics; network qualification remains required. |

Licenses were checked at pinned upstream revisions. Digest/platform verification is not a signature, vulnerability or runtime acceptance assertion. Grafana and other disabled optional components are not selected runtime dependencies.

The boundary also configures the existing [Cilium 1.20.2](https://github.com/cilium/cilium/tree/v1.20.2) operator/agent under their Apache-2.0 license. It introduces no Cilium fork/image/version/host-firewall change; the existing platform lock remains authoritative.
