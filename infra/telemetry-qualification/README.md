# Controlled telemetry qualification

This explicit opt-in overlay changes only the existing telemetry HelmRelease suspension from true to false. The root stage stays suspended by default. Both protective network policies, namespaces, quota, source pins and values remain identical; the existing platform source is independent and unchanged.

Before selecting this path, verify current Node/request/storage headroom, effective non-audit managed-Pod denial, protected namespace/service-account controls, exact upstream pins, cert-manager dependencies and absence/ownership of the new chart's cluster-scoped resources. Existing aggregate limits are oversubscribed; a fit observation permits a controlled lab qualification, not production burst guarantees.

Use a reviewed public commit and guarded updates of the independent pgcf-telemetry source only. Suspend that Kustomization under fresh UID/resourceVersion/spec guards, update its GitRepository commit and wait for current-generation source readiness, then atomically select ./infra/telemetry-qualification and resume it. Keep prune false, deletionPolicy Orphan and the existing platform dependency. Do not repoint pgcf-platform or alter Barman/SDK/R2 held work.

The release keeps an eight-minute timeout and zero automatic remediation retries. Monitor the same release/operation while it is active; an observation timeout is not permission to reinstall/recreate it. On a terminal install failure, unexpected ownership/security change, a ten-minute check limit or PLAN.md repeated-failure bound, suspend the independent Kustomization and release with fresh guards. Preserve network protections, provider denial, existing data and protected namespaces/PVCs. Do not remove a deny while its host listener remains active; no blind Helm uninstall or broad namespace deletion is a rollback.

After a controlled install, qualify generated Pod PSA/security/resources and exact runtime images, admission certificates, PVC binding/retention, verified kubelet TLS, the owned Prometheus scrape, actual deny/namespace API boundaries, selected target statistics/Flux rules and null-only alert delivery. Cardinality, sustained memory/storage, alert usefulness and HA/recovery remain separate acceptance evidence. Do not call this operational before those actual runtime checks pass. No notification receiver or remote-write/OTLP ingress is enabled.

See [the telemetry stage](../telemetry/README.md), [current boundary evidence](../../docs/evidence/m4-telemetry-boundary-2026-09-28.md) and [PLAN.md](../../PLAN.md).
