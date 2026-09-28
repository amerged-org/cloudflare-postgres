# Regional environment controller

Apache-2.0 first-party code. This package implements the regional half of the versioned `environment.create` protocol. It initiates HTTPS requests to the adopter's control API; it opens no inbound listener. It currently creates internal CloudNativePG resources and reports observed readiness. External PostgreSQL endpoint discovery, credential issuance, usage, gateway routing, sleep, resizing, deletion, and restore operations are not implemented here.

## Operator configuration

Build with Node.js 24 or newer and `pnpm --filter @cloudflare-postgres/regional-controller build`. Supply:

| Variable                      | Meaning                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PGCF_CONTROL_ORIGIN`         | HTTPS origin of the adopter's control API, without path or credentials.                                                                           |
| `PGCF_REGION_ID`              | Region ID registered by the installation operator.                                                                                                |
| `PGCF_REGION_TOKEN_FILE`      | Preferred: a mounted owner-readable file containing only the region-scoped API token.                                                             |
| `PGCF_REGION_TOKEN`           | Alternative token source for a supervised process; file takes precedence.                                                                         |
| `PGCF_REGIONAL_CONFIG_FILE`   | File containing the nonsecret JSON configuration below.                                                                                           |
| `PGCF_KUBECONFIG_FILE`        | Explicit kubeconfig for local execution. Otherwise require in-cluster authentication; the user's default kubeconfig is never selected implicitly. |
| `PGCF_LEASE_SECONDS`          | 30–300, default 90.                                                                                                                               |
| `PGCF_POLL_MILLISECONDS`      | 1,000–60,000, default 5,000.                                                                                                                      |
| `PGCF_READINESS_MILLISECONDS` | 30,000–600,000, default 300,000; expiry defers the operation for reclaim.                                                                         |

Example configuration, with deployment-specific operator Pod labels and an explicit allowed source Secret reference:

```json
{
  "operatorNamespace": "cnpg-system",
  "operatorPodLabels": { "app.kubernetes.io/name": "cloudnative-pg" },
  "allowedBackupSecrets": [
    {
      "namespace": "platform-secrets",
      "name": "private-backup-credentials",
      "accessKeyIdKey": "ACCESS_KEY_ID",
      "secretAccessKeyKey": "SECRET_ACCESS_KEY"
    }
  ]
}
```

Use the actual labels of the installed operator; chart and manifest labels can differ. Do not copy database credentials or `.env.local` into this configuration, a container image, logs, or the repository. The dedicated API token is not a Cloudflare administrative token. Region credentials must be mounted separately from provider credentials.

Run `pnpm --filter @cloudflare-postgres/regional-controller start` under an operator-owned supervisor; the compiled entry point is `apps/regional-controller/dist/main.js`. The [deployment example](deploy/example.yaml) supplies a restricted Pod, a dedicated service account, nonsecret configuration, a mounted `pgcf-region-access` token Secret reference, and a separate source-Secret read Role. Replace its origin, region ID, image, and operator labels; create the private Secrets separately. It exposes no Service or ingress.

The optional [Dockerfile](Dockerfile) builds from the repository root with `docker build -f apps/regional-controller/Dockerfile .`. The root `.dockerignore` allows only named public package/configuration/source inputs into the build context; local environment files and generated credentials are excluded. The official Node 24.21.0 LTS multi-platform index is pinned by digest, read back from Docker's registry on 2026-09-28 with Linux amd64 present. [Node release](https://nodejs.org/en/blog/release/v24.21.0), [official image source](https://github.com/nodejs/docker-node). Image build and runtime acceptance remain distinct from production promotion.

The controller's Kubernetes identity is trusted infrastructure: the example ClusterRole can create namespaces and customer resources across the cluster. Kubernetes RBAC cannot restrict `create` by resource name; the broad creation grants require admission policy or an equally strong approved operational boundary before untrusted production use. The separate Role limits source-Secret reads to the explicitly named Secret, and the runtime independently checks the configured source-key allowlist. Do not share the controller's kubeconfig or service account with customers. A production installation must still qualify admission controls, token recovery/rotation, operator selectors, Cilium enforcement, and the regional release process.

## Reconciliation and authority

The controller claims one operation at a time, renews its versioned lease, and uses the persisted immutable profile snapshot. It verifies `sha256(JSON.stringify(spec))`, region identity, the digest-pinned PostgreSQL image, supported integer resource quantities, volume bounds, backup HTTPS origin and explicit S3 region, and the local source Secret allowlist before creating resources.

Every environment uses `pgcf-<environment UUID without hyphens>` and a `database` Cluster. Owned resource labels identify both the environment and the region; an annotation records the execution-spec hash. A name collision or changed owned configuration fails without adopting or overwriting it. Stable names and readback resolve a create whose response was lost. Unknown infrastructure/control outcomes and readiness timeouts remain retryable through lease expiry and a fresh claim; they do not assert that no database exists. SIGINT/SIGTERM stops new work.

The controller first creates a restricted namespace, CPU/RAM/storage/PVC/Pod quota, bounded default container resources, and default-deny network policy. An explicit Cilium policy permits only cluster replication/status traffic, operator health probes, kube-dns, kube-apiserver, and HTTPS to the selected backup hostname. It grants no customer/public ingress in this slice. Quotas reserve one extra instance slot for initialization or maintenance; they do not prove available fleet capacity or implement customer budgets.

Only the two explicitly selected source credential keys are copied into the environment's `archive-credentials` Secret. The catalog's nonsecret `backup.region` is added as a generated `region` key and referenced through Barman's S3 Secret selector; R2 catalogs use the explicit value `auto`. No region is inferred from the endpoint or local defaults. The `archive` ObjectStore uses the catalog's backup destination root followed by `/<environment UUID>/`, keeping the fixed `database` server name distinct across environments. A Barman WAL plugin and bounded sidecar resources are attached. No base backup, successful WAL upload, retention behavior, or recovery is inferred from PostgreSQL readiness.

Ready requires a matching current Cluster UID/generation and CNPG Ready condition, enough currently Running/Ready instance Pods controlled by that UID, and the current primary among those Pods. The Cluster is read again after listing Pods to reject replacement or revision during observation. If a condition includes `observedGeneration`, it must match the resource's current generation. The result reports only UID, generation, and ready-instance count. Exceptions are never logged because Kubernetes responses can contain Secret data; logs contain only generic event codes.

## Verification and upstream provenance

The single bounded Node lifecycle regression is `test/reconcile.node.test.mjs`. It first failed on trusting a completed Pod with a stale Cluster Ready condition, then passed after the current-Pod check. It also exercises a lost committed-create response, restart reconciliation without duplicate resources, real API-added Namespace finalizers and canonical quantities, explicit S3 region and backup key selection, boundaries, and refusal to adopt another owner. It is simulated evidence; actual Cilium admission/enforcement, CNPG defaults, resource capacity, and end-to-end control-plane deployment must still be qualified on the target installation.

The maintained official [Kubernetes JavaScript client](https://github.com/kubernetes-client/javascript) is pinned as `@kubernetes/client-node@2.0.0`. npm records upstream commit [`f72cc23ed378cb8e7f09129ee6e55aa531a2b9ba`](https://github.com/kubernetes-client/javascript/tree/f72cc23ed378cb8e7f09129ee6e55aa531a2b9ba); its [license](https://github.com/kubernetes-client/javascript/blob/f72cc23ed378cb8e7f09129ee6e55aa531a2b9ba/LICENSE) and package metadata declare Apache-2.0. The workspace lock records the exact distribution integrity and transitive dependency graph. No upstream source is vendored or modified.

Resource construction follows the primary [CNPG security](https://cloudnative-pg.io/docs/1.28/security/), [Barman plugin 0.15 usage](https://cloudnative-pg.io/plugin-barman-cloud/docs/usage/), and [Cilium 1.20 policy](https://docs.cilium.io/en/stable/security/policy/index.html) contracts. CNPG owns instance security defaults, application role credentials, replication, and lifecycle; the controller disables superuser access and does not expose those private credentials. Passing this package's test does not establish production tenant isolation.
