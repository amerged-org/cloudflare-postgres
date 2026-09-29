# Stop completion correction — 2026-09-29

Status: **published and deployed in development; node-backed physical completion remains unimplemented**. Source [`6b138548b48a66684b40209fd056beac2038508a`](https://github.com/amerged-org/cloudflare-postgres/commit/6b138548b48a66684b40209fd056beac2038508a) corrects the current [explicit suspend executor](../contracts/environment-suspend-v1.md) and [allowance supervisor](../contracts/runtime-allowance-authority-v1.md). Kubernetes convergence no longer creates a physical-completion claim.

## Behavior

The existing owned stop helper retains its Kubernetes-only behavior: seal ownership/spec/run epoch and retained-volume identities, close Pod admission, scale the bound Pooler, request CNPG hibernation and verify API convergence. These observations cannot prove node process termination.

After convergence, explicit suspend returns `suspended: false` with `physical_verification_pending`, and its CLI exits deferred/nonzero promptly without publishing a result or spending five minutes polling a missing verifier. Allowance supervision remains `stopping`, denies growth and emits the same pending reason. It does not create a completed stop or physical stop timestamp. The unqualified journal completion writers are removed.

Legacy journal `suspended`/`stopped` state, timestamps and saved `computeAbsent` observations remain byte-retained as predecessor evidence. They cannot produce current success or authorize growth/resumption; clock rollback and repeated stop reconciliation preserve their existing completion rows. New stop identity/volume seals remain durable and retries do not blindly replay committed patches. No final usage, correction, settlement, released reservation, wake or physical stop guarantee is introduced.

## Bounded verification

Baseline: 55 cases. Exactly three existing cases were materially expanded: two suspend cases and one allowance case. Meaningful RED executes their two affected files in 0.680 seconds: those three fail the actual wrong success result while one unchanged case passes. Implementation attempt one supplies passing targeted evidence for all four cases in 0.638 seconds. Independent source review finds no remaining blocker. No new top-level cases or speculative suites are added.

The frozen full gate runs once. Format, lint, typecheck and 25 Worker cases pass. Node verification passes 26 of 27 and stops on the existing managed-pooling case expecting the predecessor `stopped` result where corrected behavior returns `stopping`. The complete gate takes 16.280 seconds; the previously unrun Go stage does not run after that stop.

After reporting the stop, narrow continuation changes only that existing result literal from `stopped` to `stopping`, adding no case, assertion or coverage. The original three expansions remain the entire test expansion budget; this fourth touched case is an expectation alignment, not a new or expanded suite. Only the named managed-pooling file runs (two cases pass in 0.238 seconds), followed by the previously unrun Go formatting/vet/three-case check (2.445 seconds). Runtime source remains frozen. All 55 cases have passing evidence, but **the original full gate failed and is preserved**; no second broad gate or uninterrupted-green-gate claim is made.

Privacy checks cover 309 public files with zero matching credentials. The actual `.env.local` remains byte-identical, owner-readable and ignored; the held SDK's 22 candidate hashes are unchanged. No private environment file enters the image context.

## Development delivery

One Linux amd64 image build uses 54 sealed public Git inputs and completes in 38.173 seconds. Fingerprint `df57d8a7a4728aa2a882cbe63d24964c41802cfb2ebed76b1e6befb24dbcfb12` selects local reference `docker.io/library/pgcf-regional-dev:stoptruth-df57d8a7a472`. Verified index is `sha256:788ed7c32a0e1e0da121cecbfeb1fd6a6427f7474db1570c9e1c6e7c1f766d28`, amd64 manifest `sha256:57fb123e8d25b38207c6165961a1bf98997875b3cafde6c9e6693eacd750d7e6` and configuration `sha256:6039dfbf4f25b078d3fbf572d0784e7377a979b15c26ba68344290903614e98c`. The 88,494,080-byte archive SHA-256 is `3230ed27aa932173aca6f1feeb0bc4d5db71392ace1a6a06e1ecb9641f899091`. No registry push occurs.

A consistent read-only pre-update journal observation verifies integrity and the existing empty accepted ledger. One authenticated Talos import/readback completes in 22.923 seconds and matches the approved index. One UID/resourceVersion/previous-image-guarded patch replaces only the regional Deployment image; rollout completes in 1.166 seconds. Existing configuration, permissions and default operation lanes remain unchanged; optional suspend/allowance CLI modes are not activated.

The first post-rollout observer incorrectly assumes a short Pod name label and is retained as a failed readback. One read-only correction uses the actual immutable Deployment selector and verifies the Pod → ReplicaSet → Deployment ownership chain. No import, image patch or rollout is repeated. The running Pod is Ready with zero restarts, verified image identity, Node 24.21.0 and all 46 compiled module hashes equal to the frozen output.

Readback preserves journal schema two, source/legacy metadata, owner-readable mode, integrity and empty accepted/outbox counts. Original Node UID/boot, all 27 non-controller active Pod identities/restart counts, four PV/PVC identities/specifications, manual database/Pooler identity/specifications, cluster-role rules and both SQL markers are preserved. Worker, D1 and Worker Secrets are not mutated. No customer environment or physical stop operation is created; positive customer execution remains a separate acceptance gate.

## Remaining release requirements

Integrate durable pre-execution workload/node cohorts and independently authenticated fresh per-node runtime evidence, with boot/epoch/ownership checks and node-loss behavior, before enabling completion. The [direct runtime reader](m6-node-runtime-observer-2026-09-29.md) remains held and is not resumed by this correction. Its independently verified [Talos digest alias](../operations/talos-image-references.md) repairs local catalog metadata only.

Final allocation/lifetime/rate evidence, off-node recovery, bounded independent expiry, actual customer creation/connectivity, funded resume, automatic sleep/wake/scaling, backup/PITR and fleet maintenance remain required by v1. Anonymous GHCR pulling remains pending package access and unauthenticated retrieval; no token scope or package visibility is changed. R2 approval and prior SDK/Barman/SQL qualifier holds remain intact. Admission stays closed and runtime enforcement flags remain false.
