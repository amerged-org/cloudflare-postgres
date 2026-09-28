# Ordered upstream telemetry Rules

Status: **all 30 Rules admitted under Flux ownership in Dev** at source
`59a6b3c0ef2481287963c54b81e0ef39751bbf0d`. This directory contains the 30 default
PrometheusRules selected by kube-prometheus-stack 91.8.0 and the reviewed
telemetry values. It is a separate Flux stage; it is not included in the
core telemetry Kustomization and does not activate a release. See the
[actual ordered-bootstrap checkpoint](../../../docs/evidence/m4-telemetry-bootstrap-order-2026-09-28.md)
for runtime evidence and remaining TLS/cold-bootstrap gates.

The core HelmRelease must use `defaultRules.create: false`. After its
explicit admission-readiness health checks pass, a separate Flux
Kustomization may select this path and depend on that core Kustomization.
Both must reference the same commit-pinned GitRepository. The pinned
kustomize-controller v1.9.5 checks the dependency's current generation,
Ready condition and applied revision against that shared source artifact.
Use the ordinary `dependsOn` check; a custom `readyExpr` replaces these
checks unless its additive feature gate is enabled.

The core readiness check must name the current HelmRelease and Operator
Deployment, both Certificates and both Issuers, and both admission webhook
configurations. Require current-generation positive readiness conditions
on resources that expose them. For the webhook configurations, require
the expected admission Service, namespace and port, nonempty injected CA
bundles and `failurePolicy: Fail`. Verify exact paths in the frozen manifest
comparison; the CEL readiness predicate does not assert their values.
Omit `wait: true` when using explicit
`healthChecks`: that setting ignores their named list. Certificate and
webhook object state is a readiness prerequisite; it does not prove the
API server can reach and validate the serving certificate. Phase-two
Rule admission remains the actual, fail-closed check. Generated
Prometheus/Alertmanager workload readiness must also be observed explicitly
when claimed; a successful Helm action alone does not establish it.

Flux's kustomize-controller owns these Rules and their drift reconciliation;
helm-controller continues to own the core chart resources. Only
`app.kubernetes.io/managed-by` changes from `Helm` to
`kustomize-controller`. Every Rule specification, identity, application,
release/selector and upstream provenance label is preserved, including
`release: pgcf-telemetry`. The rendered Rules contain no Helm release-owner
annotations. Keep the separate stage held until the existing failed Helm
release's resource/history inventory has been reviewed. Before a core
upgrade, verify the Rules are still absent from its desired manifest and
account for any previously created Rules; do not let two controllers own
the same Rule or re-enable chart Rule creation implicitly.

## Reproduction and provenance

The reviewed source manifest was rendered with native Helm 3.22.0,
Kubernetes render version 1.36.3, release name `pgcf-telemetry` and namespace
`pgcf-monitoring`. Use that renderer and the exact chart archive and OCI
manifest pins in [provenance.json](provenance.json) when reproducing the
reviewed input. Verify the archive SHA-256 before rendering. The original
input values are the reviewed public values at commit
`868e6c20ab322a48c4e6279cfc624433f15bc9a7`. Current core values have Rule
creation disabled, so explicitly override it when producing an upstream
Rule input from them:

```sh
helm template pgcf-telemetry ./kube-prometheus-stack-91.8.0.tgz \
  --namespace pgcf-monitoring --kube-version 1.36.3 --include-crds \
  --values infra/telemetry/values.yaml --set defaultRules.create=true \
  > chart-rendered.yaml
```

The production helm-controller v1.6.4 embeds Helm 4.2.4. No Helm 4 rendering
or production upgrade was validated by this extraction. Strict rendering,
contract comparison and the controlled upgrade under that production
controller remain required; extraction of a reviewed Helm 3 render does
not establish Helm 4 compatibility.

For this pin, select only the documents with
`apiVersion: monitoring.coreos.com/v1` and `kind: PrometheusRule` from that
render, in render order. Parse with duplicate-key rejection before
publishing; a permissive YAML decode is insufficient. Preserve each
document's complete content and source comment, replacing only its single
`app.kubernetes.io/managed-by: Helm` label. The following deterministic
extraction writes the same bundle; the strict parser and contract comparison
remain required after extraction:

```python
import re
from pathlib import Path

parts = Path("chart-rendered.yaml").read_text().split("\n---\n")
rules = [part.strip() for part in parts
         if re.search(r"^kind: PrometheusRule\s*$", part, re.M)]
assert len(rules) == 30
header = (
    "# Upstream kube-prometheus-stack 91.8.0 default PrometheusRules.\n"
    "# Derived from the pinned chart without rule-specification changes.\n"
    "# Integration modification: app.kubernetes.io/managed-by is kustomize-controller.\n"
    "# See README.md, provenance.json, NOTICE and LICENSE for generation and attribution.\n"
)
changed = []
for rule in rules:
    assert re.search(r"^apiVersion: monitoring.coreos.com/v1\s*$", rule, re.M)
    replacement, count = re.subn(
        r"^    app\.kubernetes\.io/managed-by: Helm$",
        "    app.kubernetes.io/managed-by: kustomize-controller",
        rule, flags=re.M,
    )
    assert count == 1
    changed.append(replacement)
Path("default-rules.yaml").write_text(
    header + "---\n" + "\n---\n".join(changed) + "\n"
)
```

[provenance.json](provenance.json) freezes the original chart, values,
reviewed render and expected identity inventory hashes, canonical aggregate
contracts and output hashes. The checked-in bundle has strict YAML and 30
unique identities, and aggregate comparison establishes equality of every
Rule `spec` and every label except the documented management label. These
checks establish the local extraction only. Expressions were unchanged, so
Promtool and runtime test suites were not rerun for this delivery. Actual
admission, all-Rule selection/evaluation, scraping, persistence and a fresh
cold bootstrap remain acceptance evidence.

Retain the same bounded operation/stop ledger when integrating this stage;
splitting configuration does not reset a failed check or authorize an
activation. The existing install failure's cause is unproved. No deletion,
uninstall, policy relaxation, storage change or original platform-source
change is part of this bundle.

See [the telemetry stage](../README.md),
[the stopped install evidence](../../../docs/evidence/m4-telemetry-install-2026-09-28.md),
[the upstream chart](https://github.com/prometheus-community/helm-charts/tree/kube-prometheus-stack-91.8.0/charts/kube-prometheus-stack),
[pinned dependency checks](https://github.com/fluxcd/kustomize-controller/blob/v1.9.5/internal/controller/kustomization_controller.go#L551-L629)
and [Flux health checks](https://fluxcd.io/flux/components/kustomize/kustomizations/#health-checks).
