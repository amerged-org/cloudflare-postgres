# Managed pooling, usage and normal stop checkpoint — 2026-09-29

Source [`e0b82604bba029a7922fc75e3130d62c991ba4b7`](https://github.com/amerged-org/cloudflare-postgres/commit/e0b82604bba029a7922fc75e3130d62c991ba4b7) integrates the [optional managed-pooling contract](../contracts/managed-pooling-v1.md) into immutable catalog profiles, regional provisioning, provisional accounting and separately configured allowance stopping. This advances M3/M5/M6; it does not complete native customer access, production isolation or hard budget enforcement.

## Implemented behavior

Operators may publish an explicit version-one session policy in a new catalog. Old unpooled profiles, serialization/hashes, resource layout and observations stay unchanged. Pooler image, CPU/RAM requests/limits, connection caps and timeouts are validated without arbitrary configuration/backend/TLS inputs. Pooled environment results require the exact additional Pooler/Deployment readiness metadata; ordinary role creation remains compatible.

Regional provisioning derives first-create Cluster certificate SANs and creates one owned RW/Recreate Pooler with strict TLS, automatic CNPG authentication and explicit main/init resources. The composite quota retains database initialization/maintenance headroom and adds one Pooler slot/compute envelope without another PVC. Uncertain creation resolves through the same owned resource. Readiness proves current generation/image/counts and the complete Pooler/Deployment/ReplicaSet/Pod UID chain with fresh readbacks, not only a TCP probe or phase.

The collector inventories all managed namespace Pods and the complete Pooler owner chain. Verified actual requests receive `platform` attribution and lineage-bound continuity; unknown ownership/init semantics report gaps. Existing instance/volume continuity and the durable usage outbox remain unchanged.

CNPG hibernation does not remove Poolers. The optional immutable allowance binding therefore includes the observed Pooler and Deployment UIDs. Normal stop prevents new Pods, conditionally scales that exact Pooler to zero, requests Cluster hibernation and resolves uncertain writes through readback. It records stopped only when the owned current-generation Deployment converges to zero and all namespace compute is terminal/absent, with retained volumes unchanged. Unknown or foreign compute stays stopping; no adoption, deletion, automatic resume or implicit patch permission is introduced. This operator mode remains separate from the default controller and retains `runtimeEnforced: false`.

## Bounded TDD and review

Exactly three new top-level cases failed meaningfully first: one Worker case for immutable policy/observation/ordinary-role compatibility and two Node cases for provisioning/replay/quota and metering/restart-safe stopping. Candidate one passes 18 Worker cases in five named files and nine Node cases in five named files. No generated matrix or additional test case was introduced.

Before freezing, the regional build caught a nullable owner-name access. A one-guard correction passed only its six relevant Node cases and rebuilt the artifact. Independent review also found that two missing ReplicaSet UIDs could compare equal. That observation was reproduced RED inside the existing provisioning case, then one narrow pair of required UID guards passed the same two-case file and the build. Both findings and their first correction outcomes are preserved; no assertions were weakened.

After those corrections and artifact preparation, the one canonical format/lint/typecheck/Vitest/Node gate passed uninterrupted in 13.497 seconds. All 23 Worker and 20 Node cases pass, totaling 43 versus the 40-case baseline. There was no second full gate. Independent source reviews pass API compatibility, real CNPG generated-child ownership, attribution/continuity and normal-stop fences. OpenAPI parses and all 465 local references resolve. No dependency or D1 migration changes are included.

## Dev control-plane state

Before deployment, one consistent private application snapshot captured 37 tables, 102 schema objects and 44 rows. Exact local reconstruction passed integrity and foreign-key checks; this is a local application-state restore sample, not scheduled production backup or fresh-account recovery.

The existing Dev Worker deployed the public source once in 11.837 seconds. Seven bounded HTTP checks verify original project/task recovery, empty owned inventory, customer/executor separation and missing-parent refusals. D1 readback verifies unchanged managed environment/role/database/usage/allowance counts, eleven existing migrations, no foreign-key violations and closed admission. All eight Worker Secret names remain present; no values were retrieved or new credentials created.

No pooled catalog/environment was admitted in Dev. Local protocol cases establish behavior, while live readback establishes preserved routing/state and empty queues. Positive API-managed Pooler SQL and budget stopping remain unqualified.

## Regional artifact and activation

One Linux amd64 image build from 44 sealed public Git inputs completed in 24.405 seconds. Fingerprint `84ecb74101556959e2fc566a72dad17e0d017e552efa9516fa38ddbba76086fe` names local image `docker.io/library/pgcf-regional-dev:pooling-84ecb7410155`. Its verified OCI archive has index `sha256:2450f85f5105f0a7d74d39bb828529b62704b7b86938d6af5bfa8ed91758d5a5`, amd64 manifest `sha256:4d96f385bfd53a84e7a9d89a9a8676c8ce42bee42a2a5fcf8c55816de88f8b91` and configuration `sha256:368527e0aebd904214992cd054f47ac5b5b5dc4e40d5f89f9833630a49c31206`. The 88,485,376-byte archive SHA-256 is `44362b7929a1bb207b1f0ffacecf3a84301ec1abefdd3ce35eb1a0aef6962af0`. No private environment/configuration entered the context, and no registry push occurred.

Network-disabled/read-only/nonroot inspection verifies Node `24.21.0`, UID `1000` and eight compiled module hashes matching the candidate. One authenticated Talos import and exact-reference readback completed in 17.132 seconds without maintenance/insecure access.

The initial rollout observer used an incorrect Deployment name; the first correction then compared its specification against a pre-image-patch receipt. Fresh identity readback matches the later qualified receipt exactly. Both failed observations and two corrections are retained; they preceded mutations. No create, import or image patch was repeated to recover an observation.

Two fresh UID/resource-version conditional patches append only Pooler get/create/list and Apps Deployment/ReplicaSet get/list authority, preserving twelve prior rules, and replace only the controller image. The rollout/current-generation readback completes in 1.950 seconds. The default service account gains no Pooler patch right; allowance supervision still requires a separately authorized operator identity.

## Actual runtime and source preservation

The new zero-restart Pod verifies all eight selected compiled hashes, Node/UID, and authenticated empty claims for environment, role and database lanes. The compiled official Apps SDK mappings successfully read the actual manual Pooler Deployment and ReplicaSet chain. Managed namespace/Pooler/Deployment/ReplicaSet inventory remains empty, so this is not positive customer accounting evidence.

One UID/resource-version-guarded server dry-run against the installed Pooler API accepts `instances: 0`; fresh readback verifies that the manual Pooler remains at one instance with unchanged identity/specification. This proves schema/admission compatibility only, not an executed normal stop.

The persistent journal remains private (`0700` directory, `0600` file), WAL-backed, in the same new session with an advancing checkpoint and empty outbox. Its explicit `process_restart` gap remains visible. Source Cluster UID/spec/primary, the manual native Pooler UID/spec, Node UID/boot, 27 non-controller active Pod identities/restart counts and all four Bound PV/PVC identities/specifications are preserved. Both existing SQL marker counts remain one.

## Remaining evidence and preserved holds

Qualify automatic SAN issuance and fresh verified native/direct/pooled SQL through the ordinary API-managed environment, Pooler exhaustion/cancellation/reconnect/rotation, tenant ingress paths, actual attributable usage/delivery and real normal stop. Public endpoint/gateway ownership, independent expiry enforcement, draining/final accounting, autoscaling, backups/PITR and independent recovery remain open.

The earlier [manual session Pooler](m2-native-pooling-2026-09-29.md) provides separate positive SQL evidence with an independent frontend CA; it does not certify this automatic first-create PKI path. Closed admission and non-enforcement flags remain explicit. The original held SDK candidate, standalone SQL qualifier, effective-parameter observer and Barman handoff are unchanged; pending R2 approval was not inferred from continuation. The local environment is byte-identical/owner-readable/ignored, and all 268 candidate public files were scanned with zero private token/password/key matches.
