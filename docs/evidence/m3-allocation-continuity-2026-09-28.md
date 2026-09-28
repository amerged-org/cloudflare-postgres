# M3 provisional allocation continuity — 2026-09-28

The collector now distinguishes stable resource ownership/allocation from changing Kubernetes observation evidence. Normal status/resourceVersion updates can preserve provisional allocated-time estimates. A proven retained PV shares the direct-volume continuity proof while missing compute remains unknown.

Source is published in [131c717](https://github.com/amerged-org/cloudflare-postgres/commit/131c7172d435beb5860272453df11a39afac0d10) and integrated with maintenance preparation in [c3fd741](https://github.com/amerged-org/cloudflare-postgres/commit/c3fd741038ace55ca3a24220c42adbef4081295b). The [contract](../contracts/usage-allocation-continuity-v1.md) describes the additive checkpoint proof and unchanged fact wire format. The previous [collector checkpoint](m3-regional-usage-collector-2026-09-28.md) remains the baseline.

## Behavior and qualification

Explicit stable fields plus a versioned ownership hash bind environment/spec, region, namespace/Cluster identity, resource, attribution and normalized rate. Compute also binds Pod/container/node; direct and retained storage share the same full PVC/PV binding. Volatile evidence remains auditable in fact evidence. Present objects contradicting a retained binding are rejected.

Legacy checkpoints without supported proof produce one conservative transition gap and then store a fresh proven checkpoint. Existing outbox IDs, payload bytes and hashes are not rewritten. Restarts, incomplete observations, issues, missing/changed resources, sampling gaps and buffer pressure remain unknown coverage.

Exactly three new top-level cases failed first in 0.359 seconds: ordinary observation churn, direct-to-retained storage with absent compute, and a serialized legacy checkpoint preserving queued facts. The first behavior implementation passed these and the existing journal/observer cases, 5/5 in 0.460 seconds. The old manual journal fixture gained only the required proof field; its assertions were unchanged.

The one-time canonical gate stopped at TypeScript's optional `pod.spec` narrowing after format/lint passed, in 6.222 seconds. That failed record remains unchanged. After reporting the stop, an explicit `!pod.spec` guard received focused format/lint/typecheck and the named continuity regression. Previously unrun build, Vitest and Node stages then passed once: 15 Worker cases and 10 Node cases. Completion took 14.206 seconds. This is an interrupted qualification, not an uninterrupted clean full gate or a second broad gate.

The combined checkout built in 1.987 seconds and passed seven cases from the four named changed regional test files in 0.456 seconds. No new cases, matrices or unrelated cleanup accompanied integration. Public exact-ref readback verified all 21 changed source/document files; stopped SDK inputs remained unchanged.

## Dev artifact and runtime

One Linux AMD64 image build used the committed pinned Node 24.21.0 Dockerfile and 25 allowlisted public inputs. Its fingerprint is SHA-256 of the sorted compact JSON file inventory containing each path, content hash and byte count:

```text
72e7636a247f88d404c20543ed7330359f203cf727f55a48967f6388423809b4
```

Private environment values, configuration, tests and Git data were excluded. The local Dev reference is `docker.io/library/pgcf-regional-dev:continuity-72e7636a247f`. Build took 30.092 seconds. The archive hash is `b631a8b6df3a93f4a0e9b6c95c5f65f52e7bb8b5863814378d19d12b995db062`; runtime config digest is `sha256:647762a8498160a45fa2ca09cb8c149a0b33ba09e121f8165fd700c6d78b807a`.

A single authenticated Talos import verified the exact reference in 10.157 seconds. One conditional image-only patch preserved Deployment identity, one-replica `Recreate`, mounted credentials and the journal volume. Rollout completed in 1.035 seconds. Private preflight/readback setup errors were corrected without repeating either mutation.

Fresh readback verified:

- Current-generation Ready Deployment, one new Ready Pod, zero restarts, Node 24.21.0 and UID 1000.
- Exact runtime image config and SHA-256 equality of all 17 compiled JavaScript files against the integrated public build.
- Same sealed journal identity and existing empty outbox; new session, advancing checkpoint and durable `process_restart` gap.
- `0600` journal and `0700` directory modes.
- Same Node UID/boot ID, non-collector Pod identities/restarts and PVC/PV bindings.
- Both existing SQL marker counts remain `1`; the application database name came from actual CNPG bootstrap configuration.

Private receipts, identities, endpoints and credentials remain Git-ignored. Local import with `imagePullPolicy: Never` is Dev evidence; anonymous release-image distribution remains unqualified.

## Remaining scope

Live managed inventory is still empty. This checkpoint does not prove positive API-managed customer measurement/delivery, exact transitions, complete/final accounting, corrections, WAL/backup/job/transfer accounting or node-loss journal recovery. Budget supervision, independent expiry enforcement and overshoot qualification remain pending; `runtimeEnforced` stays false. Recovery and regional admission remain unqualified, and no customer environment was created.
