# Installation maintenance preparation v1

This protocol prepares a Kubernetes upgrade and records an assessment. It does not authorize execution. The installation owns host maintenance; customer organizations and projects do not own an artificial maintenance database or privileged tenant operation.

## Identity and access

The existing installation bootstrap credential may submit and read preparations and issue a dedicated regional preparer token. Preparers receive only `maintenance:prepare:claim` and `maintenance:prepare:report`. Their opaque `cpmtp_` tokens are stored as SHA-256 digests in a separate table. Region environment, meter, budget and customer tokens do not acquire maintenance privileges. Token reissue revokes the previous maintenance credential only.

Preparations use primary D1 sessions. Each immutable row binds an operation UUID, region, canonical plan/hash and creation time. Idempotency keys are scoped to the region; the same canonical request returns the same operation, while another plan under that key conflicts. No operation may be adopted by a foreign region.

| Route under `/v1/regions/{regionId}/maintenance` | Credential and purpose |
| --- | --- |
| `POST /preparers` with `{}` | Installation; issue/reissue a dedicated preparer token. |
| `POST /preparations` with `{ plan }` and `Idempotency-Key` | Installation; queue a preparation. |
| `GET /preparations/{operationId}` | Installation; recover its durable status and assessment. |
| `POST /preparations/claim` with `{ leaseSeconds }` | Regional preparer; claim queued or expired work. |
| `POST /preparations/{operationId}/lease` | Regional preparer; renew its matching lease. |
| `POST /preparations/{operationId}/result` | Regional preparer; store a matching assessment. |

Claims return a fresh opaque lease token, epoch and expiry. D1 stores the lease hash and owning preparer identity. Conditional writes repeat the active-token, enabled-region and lease predicates so credential rotation, stale epochs and expired leases cannot write results. An identical completed result can be replayed after an uncertain response; a changed result conflicts. Public reads never return lease or preparer tokens.

## Immutable plan and assessment

The plan contains `schemaVersion: 1`, `kind: kubernetes.upgrade`, the authenticated `kube-system` Namespace UID, a canonical bounded Node UID list, exact Kubernetes `fromVersion`/`toVersion`, exact `talosVersion`, a digest-pinned `toolImage` and `targetArtifactsHash`. The artifact hash binds the operator's reviewed target-artifact inventory. It does not prove Talos's tag-based command executed those digests. The plan is cluster-wide; selecting a Talos endpoint does not turn `upgrade-k8s` into a one-node OS operation.

The assessment records observation/expiry times, evidence hash, known blocker codes and the dry-run Job identity/outcome. Eligibility is derived from validated freshness, absence of blockers and a successful identified dry run. Every public representation retains `executionSupported: false` and `executionAuthorized: false`, including an eligible result. There is no approve, execute, drain, reboot, OS-install or provider-order route.

Unknown or stale evidence blocks preparation. Required checks cover complete target identity/version inventory, authenticated machine identity, actual etcd voters/health after removing each planned node in sequence, surviving PostgreSQL instances and primary movement, PDB policy, local volume bindings, an independent restore, qualified staging and reserved surviving capacity. The capacity certificate explicitly covers the sequential plan and binds its hash; a single arbitrarily selected node's assessment cannot establish cluster-plan eligibility. A Ready Node, green Flux release, nominal free RAM or an Ubuntu builder does not establish these facts.

An installation may supply separately obtained, plan-bound evidence to the preparer. Missing evidence stays missing; the Kubernetes inventory adapter must not manufacture quorum, backup recovery, staging or reservations. Evidence collection and independent provenance qualification remain explicit operating requirements.

## Regional preparation Job

The regional module creates only a deterministic, operation-owned Job after a current lease and prerequisite assessment pass. It resolves a lost committed-create response by reading the same name and verifying its operation/plan identity and selected execution fields. A later invocation observes the existing Job rather than creating another. Conflicting ownership/spec or uncertain status cannot produce eligibility.

The command is fixed to the pinned Talos tool with explicit configuration, endpoints and versions:

```text
talosctl ... upgrade-k8s --from <exact version> --to <exact version> --dry-run --pre-pull-images=false
```

Talos 1.14.1's dry-run flag alone still permits the default image-prepull path. Both flags are required for this preparation boundary, as shown in the [pinned upstream implementation](https://github.com/siderolabs/talos/blob/v1.14.1/pkg/cluster/kubernetes/talos_managed.go). The tool receives no Kubernetes service-account token, and the dedicated operator Talos configuration is mounted separately. Raw tool output, endpoint addresses and credentials must stay out of public assessments and logs. The adopter must independently qualify the supplied tool image and credential scope before enabling Jobs.

The official `ghcr.io/siderolabs/talosctl` v1.14.1 image has a `/talosctl` entrypoint and no configured user. Use the absolute binary path and a numeric nonroot Pod user. The independently observed upstream index digest is `sha256:30791b2ec3ab1dec4093c342306159ebfe876eb9f646d5a710b853844a65ba13`; the Linux AMD64 manifest is `sha256:55d27449abe4c22b8b66b3b77c81e869d5a508d62844a7fa54c8a0d03358f982`. A client-only version check passed as UID/GID 1000 with a read-only filesystem, no network and all capabilities dropped. This does not qualify mounted credentials, a cluster-connected dry run or an upgrade. See the [pinned image build source](https://github.com/siderolabs/talos/blob/v1.14.1/Dockerfile).

Even a successful dry run does not prove an upgrade, artifact-digest execution, SQL/restore behavior, continued service or rollback. Actual maintenance remains a separate plan milestone requiring fresh execution authorization, staged artifacts, capacity/recovery evidence and a restart-safe dispatch ledger.

## Verification scope

The bounded cases cover durable installer/preparer access, exact replay and stale-lease rejection; the observed standalone refusal with no Job effects; and one lost committed Job response reconciled after restart. They do not constitute live upgrade or recovery evidence. [PLAN.md](../../PLAN.md) remains the full roadmap.
