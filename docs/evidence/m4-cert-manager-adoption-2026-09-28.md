# M4 cert-manager ownership and release checkpoint — 2026-09-28

Cert-manager is now managed by the Dev Flux platform installation at the same application version, `v1.21.2`. The first Helm release is current-generation Ready, all three Deployments completed their label-triggered rollouts, and the startup API-check Job completed. Webhook CA content and its independent injector ownership were preserved; both PostgreSQL SQL markers remained readable.

This extends the [initial Cilium/OpenEBS adoption checkpoint](m4-platform-adoption-2026-09-28.md). CloudNativePG and Barman remain suspended and manually installed. Host maintenance, failure recovery, backup/PITR, independent installation, HA and production release qualification remain open.

## Exact ownership boundary

The locked chart, unchanged values and live objects were compared before promotion. Exactly 46 existing non-Secret objects matched their declared specifications, except the two chart-added labels on each of three Deployment PodTemplates. The inventory covers ServiceAccounts, namespaced/cluster RBAC, Services, Deployments, six CRDs and both webhook configurations.

Each object received only the three standard Helm ownership metadata keys under its current resource-version guard:

- `app.kubernetes.io/managed-by: Helm`
- `meta.helm.sh/release-name: cert-manager`
- `meta.helm.sh/release-namespace: cert-manager`

The metadata stage changed no specs, certificates, Secrets, CRD schemas or PodTemplates. Its readback verified all 46 owners and healthy Deployments before activating the release. Secret and ConfigMap release-record checks used metadata-only Kubernetes negotiation and found no matching release records; no full Secret-object fallback was used.

The following Helm stage added PodTemplate labels and introduced four startup-check hook resources: ServiceAccount, Role, RoleBinding and Job. This was a same-version rollout, rather than a metadata-only reconciliation.

## CA-field proof and actual controller version

The installed controller is `helm-controller:v1.6.4`, whose [dependency file pins Helm SDK v4.2.4](https://github.com/fluxcd/helm-controller/blob/v1.6.4/go.mod#L41-L46). Its current settings use SSA. The release now declares installation SSA explicitly and uses the supported upgrade value `enabled`; both install and upgrade set `disableTakeOwnership: true`. Existing objects therefore need the reviewed ownership metadata instead of blanket adoption. Replacement and automatic remediation retries are disabled.

The initial private preview incorrectly assumed that a live CA bundle becomes Helm's rendered old baseline and could be deleted. Pinned-source inspection disproved that assumption and the preview was corrected before activation. Helm's [adoption validation copies rendered Infos](https://github.com/helm/helm/blob/v4.2.4/pkg/action/validate.go#L37-L96). Its [SSA update path](https://github.com/helm/helm/blob/v4.2.4/pkg/kube/client.go#L793-L828) uses the `helm-controller` manager; its CSA-manager migration selects that manager's fields. The chart omits `caBundle`, which was owned solely by `cert-manager-cainjector`. Omitted, independently owned fields are retained under [Kubernetes field-management semantics](https://kubernetes.io/docs/reference/using-api/server-side-apply/#field-management).

Server-side dry runs against both actual webhook configurations, with the actual controller manager and conflict settings, preserved their CA hashes. Live post-install readback then verified the same hashes and continued exclusive CA ownership by `cert-manager-cainjector`. No certificate bytes were copied into Git or fixed into chart values.

## Promotion and observed state

Public source commit [`814bba19c47407355db1dbd35508a4750d2f18f4`](https://github.com/amerged-org/cloudflare-postgres/commit/814bba19c47407355db1dbd35508a4750d2f18f4) contains the explicit release flags, cert-manager activation in the existing-installation overlay, three active release health checks, and the operator procedure. Only these infrastructure/documentation files were committed; the stopped SDK candidate was excluded.

The private GitRepository was pinned to that reviewed commit, and the platform Kustomization health checks were updated to Cilium, OpenEBS and cert-manager. Both source and Kustomization became Ready for their current generation and revision. The remaining CloudNativePG/Barman releases stayed suspended.

| Observed item              | Result                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| OCI chart source           | Ready at locked digest `sha256:634dce9c13b56677a2c05e2ab76c312d0be2664022d5dd05815da67e1fd5f610`    |
| Cert-manager Helm release  | Revision 1, deployed, current generation 2 Ready, `InstallSucceeded`                                |
| Chart/application identity | `1.21.2+634dce9c13b5` / `v1.21.2`                                                                   |
| Deployment rollout         | All three at current generation 3, one updated Ready replica each, chart PodTemplate labels present |
| Startup API-check Job      | `Completed` event observed                                                                          |
| Webhook CA fields          | Content hashes unchanged; leaf ownership remains only with the CA injector                          |
| PostgreSQL                 | Both pre-existing SQL markers readable before and after                                             |
| Node and adopted releases  | Node Ready without pressure; Cilium and OpenEBS remain Ready                                        |

Flux appends the OCI digest prefix to its chart-version build metadata. An initial post-check expected an unmodified chart version and was corrected after inspecting the release history and exact OCI source digest; this was not a deployment failure. A separate 30-second observation timeout was followed by reading the same live resources, without restarting or reinstalling them.

Before transfer, a Kubelet sample showed about 5.10 GB available memory and 195 MB aggregate current Cert-manager Pod working set. The operational preflight required the node to be Ready without pressure and more than 2 GiB currently available before allowing these rollouts. These samples establish current headroom for this lab action, not a sustained peak-capacity or production availability guarantee.

## Verification scope and remaining work

Verification used scoped formatting, YAML/Kustomize rendering, current CRD field validation, exact desired/live comparison, metadata-only storage checks, guarded mutation readback and the actual release/CA/SQL/node evidence above. No new formal tests, matrices or speculative suites were created, and no runtime-wide gate was run for these infrastructure/documentation changes.

The generic [platform operator guide](../../infra/platform/README.md) and [existing-installation sync example](../../infra/platform/bootstrap/flux-sync-existing-helm.example.yaml) describe the handoff and all three active health checks. The procedure requires exact version/value/ownership checks; it is not a universal instruction to relabel arbitrary Cert-manager installations.

CloudNativePG and Barman have different live/chart names, selectors or issuer references and require their own migrations. This checkpoint does not prove host upgrade/replacement, rollback, credential/key recovery, tenant isolation, database restore or a fresh full installation. Regional admission remains closed and no API-managed database environment was created.
