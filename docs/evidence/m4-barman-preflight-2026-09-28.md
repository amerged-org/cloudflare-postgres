# M4 checkpoint: Barman adoption preflight stopped

Status: prepared and inspected, **not activated**, on 2026-09-28. Four platform releases remain active at CNPG source `7abd879`. Barman remains suspended and manually installed. This checkpoint records a failed handoff gate, not backup availability or completion of M4.

## Source and completed checks

Public commit [c621a2a](https://github.com/amerged-org/cloudflare-postgres/commit/c621a2a7cc98a46d9f11604c62ed16df202f575a) supplies the suspended [compatibility stage](../../infra/platform/overlays/existing-manual-barman/kustomization.yaml), separately opt-in [active overlay](../../infra/platform/overlays/existing-manual-barman-active/kustomization.yaml), unchanged chart **0.8.0** / plugin **v0.15.0**, explicit SSA and disabled implicit takeover. All eight changed files and the public tree were read back; no private configuration or stopped SDK work was published. The source was not promoted to the lab.

Four offline profiles build. Parsed values and post-renderer match the frozen candidate; the suspended HelmRelease/values payload passes API schema validation. An initial nested activation overlay failed Kustomize's ancestor-cycle check; moving activation to its separate sibling path repaired that layout once, without changing the chart or runtime candidate.

The live inventory contains **11 existing non-Secret chart identities plus one absent new image ConfigMap**. Deployment selector/name, principal and leader RBAC permissions, binding subjects/Role references, Service plugin/TLS identity, main image/args and ObjectStore CRD schema match the reviewed layout. Five helper RBAC objects, two generated TLS Secrets and the legacy image Secret remain outside Helm ownership.

Current source, CNPG and cert-manager dependencies are Ready. Certificates are Ready at their recorded revisions; the chart's explicit `rotationPolicy: Always` matches the verified cert-manager 1.21.2 effective default. No active backup, restore or CNPG initialization/recovery Job was found. SQL markers and node health passed; approximately 4.6 GiB memory was available at preflight.

## Observation corrections and actual rejected gate

The first metadata reader lost HTTP rejection context. One bounded diagnostic established **HTTP 406**: Kubernetes 1.36.3 rejects a collection requested as `PartialObjectMetadata`. The first private collector correction used `PartialObjectMetadataList` for collections, retained named-object negotiation and captured HTTP errors before generic transport errors. The request then succeeded, but an empty list serialized `items: null`; the second correction normalized that observed representation to an empty list while retaining type validation.

The final corrected run completed the four strict metadata requests, including the release-store list and named TLS/config references, without reading Secret payloads or using a full-object fallback. Only selected ownership/certificate metadata was retained. Eleven UID/resourceVersion-guarded ownership patches were prepared, **not applied**.

The **single twelve-object server-side dry-run** then failed on the Deployment:

```text
spec.template.spec.containers[0].env[0].valueFrom:
may not have more than one field specified at a time
```

The existing `SIDECAR_IMAGE` uses `secretKeyRef`, while the maintained chart declares `configMapKeyRef`. Initial SSA retains the omitted old member under its existing `kubectl` field owner and adds the new member, producing an invalid union. Root confirmed the old field owner through an explicit managed-field read, without another dry-run or mutation.

The bounded workflow remains failed after two observation-tool corrections, so the project's stop rule is enforced. There was **no ownership transfer, runtime ConfigMap creation, operator rollout, source promotion or activation**. Initial failure/diagnostic/corrected evidence is retained privately. The final corrected invocation took approximately 3.5 seconds, within its bounds; no runtime package suite or new test cases were run.

## Prepared next action and limits

A private, unapplied proposal preserves the target chart's ConfigMap source: prepare its exact public-image ConfigMap with proper Helm identity, then use one UID/resourceVersion-guarded JSON Patch to replace the complete `valueFrom` object and apply the already-reviewed labels/probes in one operator rollout. It does not replace the Deployment, whole PodTemplate or container/environment arrays, and introduces no second ongoing resource owner. Fresh guards, default-aware template matching, bounded readiness/SQL checks and no-second-template-change verification remain mandatory before Helm adoption.

This proposal requires explicit approval for one additional repair attempt before any further validation or execution. The active overlay is not an approved workaround for the failed gate. Do not remove the stop by renaming the workflow, forcing replacement, retaining an unknown legacy image source or disabling ownership checks.

Separately, one first-attempt Contabo authentication and inventory read confirmed exactly the two authorized existing VPS in provider running state. This proves current inventory access, not guest readiness, automated maintenance or deployment to the second server. Credential/provider identities remain private; no provider mutation or retry occurred.

CNPG-I identity/mTLS, actual database sidecars, WAL continuity, R2 credentials, physical backups, PITR, retention/deletion and independent restore remain open. No database plugin or API-managed environment was enabled. M4/M8 host maintenance, failure recovery, tenant isolation and production qualification remain incomplete.
