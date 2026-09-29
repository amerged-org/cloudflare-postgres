# Execution identity checkpoint — 2026-09-29

Source [`24027d68ce5deefd849a1c64e862b45a0259869c`](https://github.com/amerged-org/cloudflare-postgres/commit/24027d68ce5deefd849a1c64e862b45a0259869c) implements the [execution-identity contract](../contracts/execution-fencing-v1.md). Updated writers can reject a run identity that differs from their immutable authority. This is a prerequisite for future resume/resize, not funded wake, epoch advancement or server admission enforcement.

## Initial producer and protected writers

A new immutable operator profile may opt in with exactly `executionFencing:{version:1}`. The Worker assigns initial epoch `"1"` to newly created environments only. Migration `0013` adds nullable immutable epoch columns and enforces profile/initial-value/suspend-snapshot ownership; existing rows are not backfilled. Public metadata, provisioning claims, required ready observations and role/suspend flows carry the authoritative value conditionally. Legacy absent-policy specifications and response shapes stay unchanged.

The regional producer stamps only owned Namespace, quota, Cluster and optional Pooler metadata. A legacy stop binding rejects any annotation key presence; an explicit binding requires the same valid epoch on every required resource. Mixed observed states defer. Allowance and suspend journals seal the claimed epoch and never adopt a refreshed annotation value. Generated CNPG children and retained storage are not stamped.

Each updated adapter mutation freshly reads the required owned resource set, validates epoch/identity and target UID/resourceVersion, checks operation authority and sends the target epoch JSON test. These observations are not a Kubernetes transaction across objects. Future handoff must exclude old actors before stamping; older privileged binaries can ignore client-side annotations. No advancement/resume writer, new patch permission or hard-enforcement flag is introduced.

## Bounded verification

Exactly three new top-level cases failed meaningfully first: one Worker profile/creation/readiness/suspend propagation case and two Node cases covering stale/legacy/mixed identities, immutable journal reopen, actual producer annotation sites and SDK refusal despite fresh target identity/version. The mock SDK GET routes were made resource-correct before candidate checking so refusal does not rely on a wrong Namespace/Cluster response.

Candidate one passes all 16 Worker cases in five named files in 3.770 seconds and all nine Node cases in five named files in 0.714 seconds. Regional build succeeds. Independent source reviews pass complete owner/epoch checks, legacy preservation, exact four-resource stamping, immutable journals and per-dispatch lease checks. OpenAPI parses and all 503 local references resolve. Dependencies and the 25-line guidance are unchanged.

The one canonical gate passes formatting, then stops at lint after 4.800 seconds on one unused variable in the new fixture. Removing that variable changes no implementation. Focused lint and the same two Node cases pass; the previously unrun typecheck, Worker and Node stages pass. All 25 Worker plus 24 Node cases have passing evidence, totaling 49 versus 46 initially. This is not an uninterrupted clean full gate. No second broad gate, implementation repair, generated matrix or extra top-level case follows.

## Control-state and Dev delivery

Before migration, one consistent private snapshot captures 40 application tables, 116 schema objects and 45 rows. Exact local reconstruction passes integrity/foreign-key checks, and the additive migration applies offline without altering that snapshot. This is local control-state restore evidence, not scheduled backup or fresh-account/key recovery.

Migration `0013` applies once in 2.302 seconds; the existing Dev Worker deploys once in 11.563 seconds. Readback confirms the migration, preserved empty managed/runtime/suspend/usage/allowance counts, no foreign-key violations and closed admission. All eight existing Worker Secret names remain; no values are retrieved or changed. Six HTTP checks preserve customer/executor boundaries, missing runtime/suspend parent refusals and existing project discovery.

No fenced catalog/environment is enabled in Dev and no later epoch is issued. These checks prove deployed routing/state preservation, not real epoch handoff or stale-writer exclusion under customer load.

## Regional artifact and preservation

One Linux amd64 image build from 51 sealed public Git inputs completes in 23.731 seconds. Fingerprint `5524d17c2c5b270f4855adb4b895968235c7bb79d895e52e7a324cfcddaa632a` names local image `docker.io/library/pgcf-regional-dev:fencing-5524d17c2c5b`. Verified OCI index is `sha256:b85467520f289baac43987390a0327bdbd412268e025250b4ec107bbbce245c8`, amd64 manifest `sha256:7018362c25202b84307b0cc2f3b09902ed816ba221ee64dd01f2cb36a68d8df1` and configuration `sha256:0aaea893d9b23c5b89ea5a4a62f901f6cfedb135de37ae1a40076a669aa9827f`. The 88,493,568-byte archive SHA-256 is `9cbed1fd84dd85d83dbf8ffccb4c0cc48f8d503b4dc17cc5e2c3d006f86426e5`. No private environment/configuration enters the context or registry push occurs.

Network-disabled/read-only/nonroot inspection verifies Node `24.21.0`, UID `1000` and ten compiled module hashes against the candidate. One authenticated Talos import/exact-reference readback completes in 11.700 seconds. One fresh UID/resource-version/old-image conditional image-only patch rolls out in 1.488 seconds. Configuration and permission rules remain unchanged; fencing is not enabled for the manual lab database and no lifecycle executor is started automatically.

The actual new zero-restart Pod matches all ten selected hashes and authenticates the SuspendClient with an empty claim. Its private WAL journal has an empty outbox, explicit process-restart gap and advancing checkpoint in the same new session. Node UID/boot, source database UID/spec/primary, manual Pooler UID/spec, 27 non-controller active Pod identities/restart counts and all four Bound PV/PVC identities/specifications are preserved. Both SQL marker counts remain one.

## Open acceptance

Before enabling the profile, deploy/verify every supported writer and exclude old privileged writers. Qualify actual fenced creation, protected stop, partial handoff and replacement behavior in the ordinary API-managed environment. Admission/actor revocation, complete final accounting and fresh funding are still required before epoch advancement or resume. Automatic idle/wake, independent expiry, public connection ownership, resizing/autoscaling and backup/PITR/recovery remain part of the full objective. Enforcement flags stay false.

Held SDK, standalone SQL, Barman and effective-parameter workflows are unchanged; pending R2 approval is not inferred. The local environment is byte-identical/owner-readable/ignored, the archived SDK's 22 hashes are preserved, and all 288 candidate public files scan without matching private token/password/key values.
