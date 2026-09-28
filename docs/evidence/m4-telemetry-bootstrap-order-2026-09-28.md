# M4 ordered telemetry bootstrap — 2026-09-28

Status: **configuration prepared; new upgrade and Rule stage not executed**. The prior install observer is retired with its activation ledger consumed. Its null-list observation correction remains green at the conservative two-repair count. SDK/Barman/R2 held work is unchanged.

## Observed ordering exposure

The [previous install](m4-telemetry-install-2026-09-28.md) failed while applying Rules through the Operator webhook. An authoritative read at 12:26:26 UTC confirms source commit 868e6c20ab322a48c4e6279cfc624433f15bc9a7 Ready, the core Kustomization and HelmRelease held, and one failed revision-one history entry. The original four base releases and database are healthy.

The failed action began at 12:09:25 UTC. Its Operator Pod was created at 12:09:26 and became Ready at 12:09:31; both Certificates were Ready at 12:09:26. The action reported failure at 12:09:37. The Operator therefore had an initial unready interval but was Ready before failure completion. These times do not establish the timeout's exclusive cause. A later single server-side dry-run of the exact failing Rule passed the selected admission/TLS path without persisting it.

The pinned chart places webhooks, their own Operator and default Rules in the same ordinary action. [Helm 4.2.4 applies the manifest before waiting](https://github.com/helm/helm/blob/v4.2.4/pkg/action/install.go#L506-L559). The existing external cert-manager dependency cannot order the new Operator against Rules inside that action. Extending a timeout or weakening failure policy does not establish that readiness barrier.

## Complete configuration and explicit ownership

The existing core release keeps its name, namespaces, chart/image pins, protection policies and storage templates. Its values explicitly retain `failurePolicy: Fail` and use the supported `defaultRules.create: false`. All 30 upstream Rules move to a [separate bundle](../../infra/telemetry/rules/README.md); no Rule expression or release/selector label is removed or changed. Only the management label identifies kustomize-controller as their actual owner. Upstream license, notices, source comments and frozen provenance are included.

The held [core example](../../infra/telemetry/bootstrap/flux-sync-qualification.example.yaml) names ten health resources: the current release, Operator Deployment, generated Prometheus/Alertmanager StatefulSets, two Certificates, two Issuers and both webhook configurations. Certificate/Issuer Ready conditions must match generation. Webhook checks require the expected Service/namespace/port, Fail policy and a nonempty CA. Exact paths and other declared fields remain part of the frozen manifest/operation comparison; nonempty CA alone is not a TLS handshake.

The held [Rules example](../../infra/telemetry/bootstrap/flux-sync-rules.example.yaml) uses the same commit-pinned source and depends on the core Kustomization. It has no custom dependency expression or `wait: true` override. [Flux health/dependency checks](https://fluxcd.io/flux/components/kustomize/kustomizations/#health-checks) supply the ordering. Only this stateless Rule inventory may be pruned; the core and protected namespaces/PVCs remain outside its inventory. Actual Rule admission still verifies the serving TLS path.

## Required operation and evidence

Before a new operation, refresh the held release's failed revision-one history and metadata-only ownership inventory. Review the upgrade render: expected ordinary core resources are unchanged and only 30 still-absent Rules are omitted; ten installed CRDs remain separately preserved. Keep release target/storage identities, existing Pod/PVC identities, source boundaries and protected policies. Do not adopt, uninstall, force/reset or delete resources to obtain a pass.

A meaningful new configuration is expected to produce an ordinary upgrade to revision two under the pinned controller/Helm versions. Bind a new one-use operation to its published commit and exact calibrated configuration digest. Preserve the old consumed ledger and repeated-failure counters. Retain the bounded hold-on-failure procedure; verify the same release UID, current generation, exact config/chart digest, upgrade action and deployed history rather than any Ready flag.

After core readiness, separately enable and qualify all 30 Rules under Kustomize ownership and verify Prometheus selects/evaluates them. Then qualify permitted scraping, kubelet TLS, target/volume metrics and null-only alert behavior. Existing warm Pods make the immediate continuation a warm upgrade; it cannot establish a fresh cold bootstrap or production recovery. Those gates remain open until their own actual evidence exists.

The Rule extraction has strict YAML, unique identities and aggregate equality with its frozen upstream input. The source render used native Helm 3.22.0; production uses Helm SDK 4.2.4, so extraction equality does not substitute for upgrade rendering/runtime evidence. No new runtime tests, Promtool rerun or full workspace gate were introduced for unchanged expressions and configuration wiring.
