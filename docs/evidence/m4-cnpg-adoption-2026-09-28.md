# M4 checkpoint: guarded CloudNativePG adoption

Status: verified in the existing single-node Dev lab on 2026-09-28. CloudNativePG is now owned by Flux/Helm at the same operator version. This is an ownership and operator-reconciliation checkpoint, not completion of M4 or a production availability claim.

## Reviewed source and scope

The activated source is public commit [7abd879](https://github.com/amerged-org/cloudflare-postgres/commit/7abd8798a21d606c0ed8733e816e14a73fafae30), using [the opt-in official-manifest compatibility overlay](../../infra/platform/overlays/existing-manual-cnpg/kustomization.yaml). The fresh-installation baseline keeps its normal chart layout. The source commit and all six changed files were read back from the public repository; no private configuration or stopped SDK candidate was included.

| Component | Verified identity |
| --- | --- |
| CloudNativePG chart | `0.29.1+3245fa051bb2`, including Flux's OCI build metadata |
| Operator application | `1.30.1` |
| Locked OCI manifest | `sha256:3245fa051bb21d0dd9246272f57a2760b4234817a164a3167d2a1e7fb9f63fd9` |
| Release / target / storage | `cloudnative-pg` / `cnpg-system` / `cnpg-system` |
| Installed Helm revision | `1` |
| Actual release actions | Install SSA `true`, upgrade SSA `enabled`; implicit ownership taking disabled for both |

The locked chart was retained unchanged. Compatibility values and six targeted post-renderer entries preserve the existing Deployment and Service selectors, numeric webhook ports, principal RBAC identities and role reference, service account, operator image and configuration/TLS references. Literal principal permissions are equal: zero additions or removals. Two new generic chart view/edit roles are removed from the render; six existing specialized database/publication/subscription roles remain outside Helm ownership.

Monitoring queries match the pinned official Apache-2.0 manifest byte-for-byte. The candidate retains both ConfigMap and Secret lookup flags and their ConfigMap-then-Secret precedence. Metadata-only checks found both legacy configuration objects absent; the chart does not create an empty replacement ConfigMap. No Secret payload was read for this adoption.

## Executed checks and handoff

The inventory contained **19 existing non-Secret objects**, including 11 CRDs, and no new identities. A single server-side dry-run using the actual `helm-controller` field manager admitted all 19 objects without immutable selector or role-reference failure. All nine webhook CA hashes, exact CA leaf managers and service references matched by webhook identity. Metadata-only Helm release-store checks found no conflicting release.

Current dependency readiness, node health and approximately **4.64 GiB available memory** passed the preflight. Both existing SQL markers were readable. The 19 object versions and declared-specification comparisons were refreshed; each ownership patch used explicit current UID and resourceVersion guards. Only the managed-by label and two Helm release annotations were transferred while the HelmRelease remained suspended. The initial local patch-wrapper check expected a short patch-type label instead of the prepared MIME type; it stopped before any mutation. The corrected invocation used the same reviewed merge-patch payloads, without widening their scope.

The Git source was then promoted once to the reviewed commit and observed current-generation Ready. The platform Kustomization selected the compatibility overlay and four release health checks. CNPG was activated once, with zero automatic remediation retries. The changed operator PodTemplate reconciled successfully; the current-generation HelmRelease and Deployment are Ready, with one updated and ready operator replica.

Post-adoption evidence verifies:

- All nine CA contents, precise operator CA ownership and webhook service references remain unchanged. Helm did not take the CA leaves.
- The webhook Service has one Ready endpoint, and a real Kubernetes admission dry-run for a disposable CNPG Cluster succeeds.
- Existing PostgreSQL Pod identities and restart counts are unchanged; both SQL markers remain readable.
- The node remains Ready without memory, disk or PID pressure.
- Cilium, OpenEBS and cert-manager remain Ready. Barman remains suspended and manually installed.
- The source and platform Kustomization are current-generation Ready at the activated commit.

CA verification required two observation corrections: compare webhook entries by their unique names rather than list position, and explicitly request Kubernetes managed fields. The initial JSON output hid managed fields and could not establish ownership. The initial failed observation is retained privately; explicit field-owner reads established equality without another dry-run, activation retry or runtime repair. Certificate bytes, object identities, provider details and private configuration remain outside public evidence.

## Remaining boundaries

This checkpoint does not qualify Barman adoption, its database plugin handshake, R2 credentials, WAL archiving, physical backup, PITR, retention or independent restore. The existing database remains the manual lab database; no catalog or API-managed environment was admitted. Positive managed usage, final accounting, runtime budget enforcement and customer provisioning remain open.

Host upgrades/replacement, multi-node failure domains, image signature/digest policy, tenant isolation and production recovery remain separate M4/M8 gates. Do not uninstall the imported release as a rollback: it owns operator resources and templated CRDs. Follow the [ownership and recovery boundaries](../../infra/platform/README.md#existing-official-cnpg-installation) before any recovery action.
