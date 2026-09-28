# M3 environment execution checkpoint — 2026-09-28

Status: **development control deployment with local controller verification; regional qualification pending**. This record distinguishes live Worker/D1 behavior from the regional controller's local verification. No catalog or API-managed environment has been created. The lab's admission remains closed, its manually created [M1 database](m1-2026-09-28.md) is not API-managed, and PostgreSQL backup/PITR recovery remains unproven. It contains no credentials, account or instance IDs, network addresses, generated machine configurations, or customer material.

## Implemented control contract

- Migration `0005_environments.sql` adds immutable regional catalogs, explicit admission policy, immutable environment execution specifications, environment-scoped idempotency identities, and regional lease/result fields. Ownership and immutability checks also exist as D1 constraints/triggers.
- Installation operators publish versioned profiles containing a digest-pinned PostgreSQL image, bounded compute/storage, and mandatory backup configuration with an explicit S3 signing region and an operator-held credential reference. Catalog publication does not open admission. Organization-facing catalog/environment representations omit Kubernetes mappings, archive locations, and credential references.
- Environment creation requires the caller's organization/project scope, explicit region/catalog/profile/volume selection, and an idempotency key. A conditional D1 batch checks admission and persists the normalized specification, environment, queued operation, and request identity together. Identical retries retain their identities and immutable specification.
- Region-scoped executors claim and renew time-bounded leases. Epochs, hashed lease tokens, expiry checks, and conditional results prevent stale, competing, or foreign-region observations from completing an operation. An identical terminal report can be retried after a lost response. The Worker trusts the authorized executor's observation; it does not independently inspect Kubernetes.

The [control API guide](../../apps/control-api/README.md) and [OpenAPI contract](../../apps/control-api/openapi.yaml) describe the implementation. The live readback below verifies deployment, closed admission, and authorization; it does not establish successful provisioning or recovery.

## Implemented regional execution

The [regional controller](../../apps/regional-controller/README.md) initiates outbound HTTPS requests and has no inbound listener. It validates the immutable specification hash, profile bounds, image digest, region identity, explicit backup signing region, and a separate local source-Secret allowlist. Deterministic resource names and ownership/spec labels resolve uncertain creates without adopting another environment's resources.

It creates a restricted namespace, resource quotas/defaults, default-deny networking with explicit required service paths, an environment-specific backup Secret/ObjectStore, and a CNPG Cluster. It observes the current Cluster UID/generation and actual Running/Ready owned instance Pods before reporting readiness. The API result contains the internal Cluster observation; it issues no usable customer endpoint or credentials. Namespace quotas are technical ceilings, not fleet reservations or customer budget enforcement.

The public [Talos recipe](../../infra/talos/README.md), [Flux platform assets](../../infra/platform/README.md), and [version lock](../../infra/platform/versions.lock.json) package the previously separate infrastructure configuration. Their sources, chart versions/digests, checksums, and offline rendering have been checked. The [M4 checkpoint](m4-platform-adoption-2026-09-28.md) now records partial live Flux adoption of Cilium/OpenEBS. Complete platform adoption, unattended Contabo provisioning, admission enforcement, and installation from fresh infrastructure remain distinct acceptance gates.

## Bounded local verification

- Baseline: 10 Worker tests and no regional Node test. This slice added two top-level Worker tests and one top-level Node lifecycle regression, each with a meaningful red-first failure. The changed files were exercised during iteration; no test matrix or speculative suite was generated.
- The Worker cases cover scoped immutable environment creation/observation and regional lease fencing. The Node case covers deterministic reconciliation after an uncertain create, current-Pod readiness rather than a stale Cluster condition, and refusal to adopt another owner. These are local/simulated checks, not evidence of real regional networking or PostgreSQL recovery.
- The first final-gate invocation stopped at formatting because generated controller `dist/` output was included. That stop was reported before further gate stages ran. The correction adds only `dist/` to the controller's `.prettierignore`; a targeted controller formatting check then passed in 0.43 seconds. The resumed work completed the previously unrun lint (1.79 seconds), typecheck (1.70 seconds), regional package build (1.30 seconds), Vitest (12 Worker tests, 2.15 seconds), and `test:node` (one Node test, 0.41 seconds) stages successfully. This history is not represented as an uninterrupted clean full-gate run or a repeated broad verification loop.
- An actual local Linux amd64 controller container build completed in 75.7 seconds. Its Dockerfile pins the official `node:24.21.0-bookworm-slim` multi-platform index at `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`. Runtime checks found the Node 24.21 entrypoint and first-party license, excluded ignored environment/Talos/kubeconfig files, and confirmed that missing configuration exits with status 1 and a generic message. Registry publication was subsequently completed as recorded below; deployed runtime qualification remains pending.

## Verified development rollout

- The initial read-only remote preflight failed with Cloudflare error `7403` before an explicit adopter account was selected; it made no migration or deployment change. The explicitly targeted Wrangler OAuth preflight then passed. A pre-migration D1 export was saved in an ignored file with owner-only permissions.
- Remote migration `0005` completed its 19 commands successfully. The updated Worker deployed in 5.92 seconds, its triggers completed in 2.17 seconds, and the current deployment version was read back. The remote migration list reported no outstanding migrations.
- Installation-authorized admission read returned `200` with `catalogVersion: null` and `acceptingNewEnvironments: false`. The registered region's token could call the claim route and received `200` with `{ claim: null }`; an organization token on the same private route received `401`.
- Readback of the existing logical project and operation preserved their identities and `active`/`succeeded` states. An environment-creation request against the closed region returned `409 region_admission_closed`. No catalog was published and no environment intent was accepted.

## Verified image publication

The manually dispatched [image workflow run 36361203902](https://github.com/amerged-org/cloudflare-postgres/actions/runs/36361203902) succeeded for exact source revision `8dc14f8e9e9b65e9a7853ce9cd33ebede6a10bb2`. The build job ran from 00:10:37 to 00:11:21 UTC on 2026-09-28. Its successful registry push reported the controller artifact:

```text
ghcr.io/amerged-org/cloudflare-postgres/regional-controller@sha256:593e2e930469712ca9ae830001b6d4451106d782e1ef261ed7586985eb391190
```

An anonymous registry token request returned `401`. Therefore publication does not yet establish anonymous pulling or availability to an independent adopter. No regional controller deployment or API-created PostgreSQL Cluster is claimed.

The locally built Linux amd64 production image also ran its compiled `ControlClient` against the live development Worker and received `{ claim: null }` with its regional identity. The container confirmed Node v24.21.0 and a non-root UID while running with a read-only filesystem and all capabilities dropped. Its token was supplied only through stdin, not environment variables, command arguments, or logs. This proves the compiled HTTPS/authentication wire to the deployed API; it is not a deployed Contabo controller or Kubernetes provisioning run.

## Live qualification still required

1. Prove anonymous access to the published controller image, then deploy its pinned digest with the dedicated regional identity and explicit Secret permissions. Qualify the controller against the actual installed Kubernetes/CNPG defaults and networking while lab admission stays closed.
2. Configure bucket-scoped backup credentials and prove base backup, WAL continuity, independent restore/PITR, and safe retention. PostgreSQL readiness must not be used as backup evidence.
3. Reconcile one qualified disposable environment through the actual control API and controller, verify CNPG/Pod ownership and defaults, and prove networking and isolation against the installed components. Open admission only after the region passes its declared qualification.
4. Supply native endpoint discovery and scoped credential issuance, then qualify ordinary PostgreSQL clients, migrations and transactions. Implement usage, budget reservations/enforcement, and the remaining lifecycle/recovery APIs before calling this an operational open-source service.

The full v1 scope remains in [PLAN.md](../../PLAN.md). This checkpoint does not complete M1, M2, M3, or production readiness.
