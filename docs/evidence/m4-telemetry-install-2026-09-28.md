# M4 controlled telemetry installation — 2026-09-28

Status: **first qualification install failed at post-render; independent reconciliation held**. No successful runtime installation, permitted Prometheus scrape or operational telemetry is claimed. The original platform source/path and held SDK/Barman/R2 work are separate.

## Approved qualification boundary

The [qualification overlay](../../infra/telemetry-qualification/README.md) keeps the same eight resources, image/chart pins, namespace policies and quota; only HelmRelease suspension changes. Its first nested layout hit a Kustomize ancestor cycle; one correction moved it to a sibling directory. The resulting build and existing-release server-side dry-run passed with all other rendered objects identical. No new runtime tests or full workspace gate were run for these declarations.

Fresh capacity admitted a controlled lab qualification: Node Ready/schedulable/no pressure, current effective requests 1310m/1.932GiB, proposed235m/1GiB leaving2405m/4.209GiB. Kubelet available4.556GiB/working-set3.182GiB. Thick LVM had23039free4MiB extents; proposed8.5GiB leaves81.496GiB. Existing limits were already oversubscribed and remain unchanged; simultaneous production bursts are unqualified.

The exact stage values/pins/namespace labels and three dependencies were verified; ten monitoring CRDs/five chart SAs were absent. Exact generated Pod admission could not be proved before their chart-created SAs and Operator, so no default-SA substitution or fake admission pass was used.

Root published commit949b8860b433f83592ba67282b4a053ba5dd605e and read it back. Under UID/resourceVersion/exact-spec guards it suspended the independent Kustomization, pinned that GitRepository, verified current-generation artifact readiness and selected ./infra/telemetry-qualification while resuming it. The independent Kustomization uses a nine-minute timeout/HelmRelease health check; the Helm action remains eight minutes with zero remediation retries. The old pgcf-platform pointer was not repointed.

## Actual first failure and hold

The actual Helm post-render rejected one duplicate mapping key: release appeared twice on the node-exporter ServiceMonitor. The observed status showed failures6 from controller pre-render reconciliation, despite remediation retries0; this is not presented as one clean single invocation or six manual corrections. Root stopped the independent Kustomization first and HelmRelease second with fresh guards. Suspension stops future reconciliation, not an active action, runtime workloads or storage cleanup. Nothing was blindly uninstalled/deleted and no security policy was weakened.

Earlier native rendering had been parsed permissively: reading YAML documents without checking their parser errors silently collapsed the duplicate equal-valued key. That had not been a strict YAML success. The actual install supplied the concrete failure.

## Small complete correction

A strict check of the exact frozen render demonstrated one meaningful RED DUPLICATE_KEY on ServiceMonitor/pgcf-telemetry-prometheus-node-exporter. Remove only the redundant prometheus-node-exporter.prometheus.monitor.additionalLabels.release: the pinned child chart already supplies the same label. One correction re-rendered the same pinned chart; strict parsing is GREEN, all79semantic resource objects are identical to the old permissively decoded objects, all resource identities are unique, and the required release selector remains unchanged.

No image, privilege, TLS, receiver, resource limit, data/storage or networking change accompanies this repair. No speculative suite/matrix or test-count reset was introduced. One repair has been used for this observed failure; the source remains held until review/partial-state inventory and a guarded next attempt. SDK/Barman stopped counters are untouched.

Runtime admission, image IDs, cert-manager/Operator TLS, PVC bindings, actual generated resources, permitted scraping, namespace API denial, targets/PVC stats, alert behavior and sustained capacity remain open. PLAN.md stop limits apply to the same failure throughout; do not restart a handle after an observation timeout or treat source rollback as universal data/runtime recovery.
