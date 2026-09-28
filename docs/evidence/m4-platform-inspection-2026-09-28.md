# M4 checkpoint: reusable read-only platform inspection

Status: implemented and live-observed on 2026-09-28. The regional package now provides [the generic `inspect-platform` command](../../apps/regional-controller/README.md#read-only-platform-inspection). This is component observation tooling, not maintenance approval, backup qualification or completion of M4/M8.

## Delivered behavior

The command uses an explicit operator kubeconfig/context, selected namespace/sync name, reviewed version lock and expected Git commit. It returns before controller configuration, regional/meter tokens, the usage journal or execution loops are initialized. It uses the existing maintained Kubernetes client and existing first-party bounded pagination; the shared pagination implementation changed only by exporting its function/type.

Only Nodes and Flux HelmRelease/OCIRepository/HelmRepository lists and the selected GitRepository/Kustomization are read. No Secret, customer database, Pod, Deployment or mutation request is part of inspection. The [optional observer RBAC example](../../apps/regional-controller/deploy/platform-observer.example.yaml) is separate from platform installation and was not applied.

The JSON report contains aggregate Node counts and trusted lock component names, normalized statuses and match booleans. Raw Node/provider identities, addresses, arbitrary URLs, API/condition messages and credentials are excluded. A failed/rejected observation produces a generic error and exit 2; a discrepancy or suspended component exits 1; matching observations exit 0.

Current Flux status requires both top-level and Ready-condition observed-generation equality and handles suspension/deletion/stalled/reconciling states. Installed chart/application observations come from deployed history. OCI linkage checks the configured manifest pin, fetched revision and HelmRelease attempted digest associated with current Ready/deployed history; the cached artifact digest is not the manifest. The HTTP Helm repository remains a URL/version observation rather than historical checksum enforcement. Git/Kustomization linkage uses the selected commit and applied revision.

Lists preserve complete bounded observations: stable per-list resourceVersion, unique identities and continuation checks, ten pages per list, 32 total requests, 4096 resources, 30-second observation budget and at most 20 seconds per request. The snapshot is not a transaction across lists, and Node readiness remains the API's reported condition rather than verified fresh reachability.

## Bounded TDD and verification

Exactly **three new top-level Node integration cases** exercised the real compiled entry and a local Kubernetes API through the official kubeconfig loader. Each failed meaningfully first: missing inspection output, legacy exit 1 instead of healthy exit 0, and legacy exit 1 instead of sanitized failure exit 2. No missing imports/setup failures were counted as red evidence. Baseline test count was 19; the candidate contains 22.

The first implementation passed all three named cases. Read-only review found contradictory top-level generation and missing full OCI attempt/source-digest linkage; the existing ready/stale case was expanded to fail first, then passed after the correction. No new top-level cases or permutations were added.

The first live run reported false source discrepancies because the fixture had tagged/branch revisions while the pinned lab returns bare `sha256:...` and `sha1:...` revisions. The existing fixtures were changed to that authoritative representation and failed meaningfully before the targeted format correction. Earlier cases were green before this observed-input regression; it was not a silent reset of a still-red two-attempt test. One revision-format correction passed the same named file and live readback. Initial live observation is retained privately.

After freezing the runtime candidate, the full gate ran **exactly once**:

| Stage | Result | Elapsed |
| --- | --- | --- |
| Format | Passed | 2.16 s |
| Lint | Passed | 3.22 s |
| Typecheck | Passed | 3.60 s |
| Vitest | 15 passed | 9.53 s |
| Node tests | 7 passed | 3.80 s |

The runtime candidate hashes remained unchanged throughout the gate. The isolated checkout excluded the separately stopped SDK candidate, which remains unpublished/unresumed; this feature did not override either SDK or Barman exception boundary. Iteration used only the explicitly named changed-package test file. No full gate was repeated or test matrix generated.

## Live observation and limits

The compiled CLI observed the existing lab in approximately **0.43 seconds**: one reported Ready Node with matching Talos/Kubernetes versions and no reported pressure, four current/pinned Ready releases, suspended Barman, and matching Ready Git/Kustomization commit linkage. Its overall result was correctly **not ready**, exit 1. The active source remained the prior CNPG checkpoint; inspection changed no infrastructure, database, provider state or credentials.

SQL, backup/restore, replication, etcd, spare capacity, tenant isolation, image signatures/runtime images, effective values, Flux binary identity and fresh Node heartbeat/reachability remain explicitly unverified by this command. Prometheus/Alertmanager/OpenTelemetry, lifecycle orchestration, backups/PITR and operational recovery still require their PLAN.md evidence. The existing regional deployment was not replaced; container distribution and pinned-runtime qualification of the new mode remain separate release work.
