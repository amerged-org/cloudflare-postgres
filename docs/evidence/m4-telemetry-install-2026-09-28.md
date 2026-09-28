# M4 controlled telemetry installation — 2026-09-28

Status: **corrected qualification reached installation but failed on PrometheusRule admission; independent reconciliation held**. Five monitoring Pods are running, but the release and rule set are incomplete. No permitted Prometheus scrape or operational telemetry is claimed. The original platform source/path and held SDK/Barman/R2 work are separate.

## Approved qualification boundary

The [qualification overlay](../../infra/telemetry-qualification/README.md) keeps the same eight resources, image/chart pins, namespace policies and quota; only HelmRelease suspension changes. Its first nested layout hit a Kustomize ancestor cycle; one correction moved it to a sibling directory. The resulting build and existing-release server-side dry-run passed with all other rendered objects identical. No new runtime tests or full workspace gate were run for these declarations.

Fresh capacity admitted a controlled lab qualification: Node Ready/schedulable/no pressure, current effective requests 1310m/1.932GiB, proposed235m/1GiB leaving2405m/4.209GiB. Kubelet available4.556GiB/working-set3.182GiB. Thick LVM had23039free4MiB extents; proposed8.5GiB leaves81.496GiB. Existing limits were already oversubscribed and remain unchanged; simultaneous production bursts are unqualified.

The exact stage values/pins/namespace labels and three dependencies were verified; ten monitoring CRDs/five chart SAs were absent. Exact generated Pod admission could not be proved before their chart-created SAs and Operator, so no default-SA substitution or fake admission pass was used.

Root published commit949b8860b433f83592ba67282b4a053ba5dd605e and read it back. Under UID/resourceVersion/exact-spec guards it suspended the independent Kustomization, pinned that GitRepository, verified current-generation artifact readiness and selected ./infra/telemetry-qualification while resuming it. The independent Kustomization uses a nine-minute timeout/HelmRelease health check; the Helm action remains eight minutes with zero remediation retries. The old pgcf-platform pointer was not repointed.

## Actual first failure and hold

The actual Helm post-render rejected one duplicate mapping key: release appeared twice on the node-exporter ServiceMonitor. The first observation showed six controller pre-render failures and the final held observation showed seven, despite zero remediation retries. These are controller failures, not seven manual corrections or one clean single invocation. Root stopped the independent Kustomization first and HelmRelease second with fresh guards. Suspension stops future reconciliation, not an active action, runtime workloads or storage cleanup. Nothing was blindly uninstalled/deleted and no security policy was weakened.

A metadata-only audit accounted for all 79 exact chart resource identities, including the chart's Service in kube-system: ten monitoring CRDs had been created under this release's Flux ownership; the other 69 identities were absent. There were no chart Pods, PVCs, service accounts, certificates, issuers or stored Helm release records. The monitoring namespaces contained only their default service accounts and automatic root-CA ConfigMaps. Secret payloads were not read. The original four platform releases, Node and PostgreSQL primary remained healthy, and both existing SQL markers were still present. This is a real partial installation: the CRDs must be checked under their existing identities before retrying, rather than deleted or adopted blindly.

Earlier native rendering had been parsed permissively: reading YAML documents without checking their parser errors silently collapsed the duplicate equal-valued key. That had not been a strict YAML success. The actual install supplied the concrete failure.

## Small complete correction

A strict check of the exact frozen render demonstrated one meaningful RED DUPLICATE_KEY on ServiceMonitor/pgcf-telemetry-prometheus-node-exporter. Remove only the redundant prometheus-node-exporter.prometheus.monitor.additionalLabels.release: the pinned child chart already supplies the same label. One correction re-rendered the same pinned chart; strict parsing is GREEN, all79semantic resource objects are identical to the old permissively decoded objects, all resource identities are unique, and the required release selector remains unchanged.

No image, privilege, TLS, receiver, resource limit, data/storage or networking change accompanies this repair. No speculative suite/matrix or test-count reset was introduced. One repair has been used for this duplicate-label failure; the corrected attempt below passed rendering and reached a different admission failure. SDK/Barman stopped counters are untouched.

## Corrected-attempt prerequisites

A fresh read-only capacity and database observation at 11:51:57 UTC completed in 1.268 seconds. The controlled lab still had 2,405m CPU and 4.209 GiB memory request headroom after the proposal, 81.496 GiB remaining volume-group capacity after allocating 8.5 GiB, zero monitoring Pods/PVCs and both SQL markers. Existing limits remain oversubscribed; this is not production burst qualification.

The configuration digest was derived with the pinned Helm controller's actual sorted-YAML implementation, rather than an assumed JSON hash. One local derivation completed in 68.521 seconds and reproduced the recorded failed digest before calculating the corrected digest. Success checks require that exact digest, the pinned chart/source, and both top-level and condition observed generations. The operation has a nine-minute total budget including suspension, with 45 seconds reserved for stopping the Kustomization before its HelmRelease.

The first execution of that observer stopped in its read-only preflight after 3.679 seconds, before any mutation, activation or activation-ledger creation. A single bounded metadata-only read proved a valid empty Certificate list with `items: null`, not an administrative payload. The decoder had incorrectly rejected it. The narrow correction normalizes null only for a negotiated metadata list and retains identity, pagination and payload checks. The original executable/run evidence is preserved and the same global activation ledger still limits the operation to one activation. Conservatively, this is the second repair of the null-list observation defect across inventory helpers; a further failure of that check must stop without a third repair. No runtime suite or full workspace gate was added.

## Actual corrected installation and hold

The corrected preflight completed both 21-request metadata inventories without fallback, unchecked pagination or payload reads. Each accounted for the same 79 identities and about 290 KB of metadata. Root pinned the independent source to the published correction commit 868e6c20ab322a48c4e6279cfc624433f15bc9a7, verified its current artifact and resumed the same qualification Kustomization. The release used the exact calibrated corrected digest and unchanged chart pin; the duplicate-label failure did not recur.

One actual Helm install failed while applying PrometheusRule resources: the Operator mutation webhook call exceeded its ten-second request deadline. The current action reports `installFailures: 1`, `RetriesExceeded`, and one failed history entry. This is a different observed failure; endpoint readiness, startup ordering and ingress identity must be measured before choosing a correction. No failure policy or TLS check was relaxed.

The observer stopped after 29.059 seconds, suspended the independent Kustomization before the same HelmRelease and confirmed both holds. The one-use activation ledger is consumed; this observer must not be replayed. Nothing was uninstalled and no retained storage was deleted. Suspension holds reconciliation, not the created workloads.

One bounded read-only runtime snapshot completed in 1.655 seconds using four reads: five chart Pods Running/Ready, five controllers current and ready, two bound PVCs, and four ready certificates/issuers. All 30 chart PrometheusRules are absent and the release is not Ready. Configured image pins match, but the runtime reports index digests; the actual AMD64 manifest is not independently established by those IDs. A launcher permission error happened before the snapshot started; the same unchanged helper was then run through Python once. That setup error is not a behavioral test or runtime correction.

A separate 1.160-second health observation at 12:13:44 UTC verifies the original source/path and four current-generation Ready releases, suspended Barman, healthy Node/primary and both SQL markers. The attempted telemetry installation did not repoint the original platform source or create an API-managed customer database.

## Current admission path

One server-side dry-run of the exact previously failing chart Rule succeeded with the now-Ready Operator, ordinary field ownership and no force or persisted object. The actual namespace selector was checked against the live reserved namespace-name label; a non-matching selector was not substituted for a webhook pass. The observation completed in 13.245 seconds, plus a retained 0.949-second setup stop for selector verification. There was no second dry-run. The bounded concurrent Cilium capture found no matching Node-to-Operator port 10250 drops; absence of a captured drop is inconclusive.

This establishes the current selected admission/TLS path for that Rule. It does not prove the original timeout's cause, a successful initial installation, or the complete rule set. Before a new controlled installation, establish the Operator/certificate readiness order and account for the failed release's existing resources/history. Do not replay the consumed observer, remove its ledger, weaken failure policy/TLS, or infer that another unchanged attempt will succeed.

Certificate readiness, PVC binding and one current admission path are observed. Actual platform image manifests, permitted scraping, namespace API denial, target/PVC metrics, alert behavior, persistence/recovery, sustained capacity and repeatable bootstrap remain open. PLAN.md stop limits apply to the same failure throughout; do not restart a handle after an observation timeout or treat source rollback as universal data/runtime recovery.
