# M3 regional provisional usage collector — 2026-09-28

The Dev regional controller now runs the file-backed usage collector on the existing single-node lab. Its pinned Node image, scoped execution/meter credentials, empty managed inventory, journal permissions, and journal persistence across one controller Pod replacement were verified. This is an empty-inventory runtime checkpoint, not positive customer usage, complete coverage, final accounting, or runtime budget enforcement.

The [controller implementation and deployment instructions](../../apps/regional-controller/README.md) build on the [environment execution checkpoint](m3-environment-execution-2026-09-28.md) and [usage/budget authority](m3-usage-budget-authority-2026-09-28.md). The control API and its migrations were unchanged by this slice.

## Implemented behavior

- Bounded, paginated inventory of region-owned namespaces, CNPG Clusters, instance Pods, PVCs, and PVs. Partial discovery becomes unknown coverage; manual lab resources are not adopted.
- Exact fixed-point observation of supported regular-container CPU/RAM requests and proven data-PV capacity, with primary/replica/platform attribution and retained-volume UID provenance.
- A source-identity-sealed SQLite journal with transactional checkpoints/outbox, FULL/WAL durability settings, owner-private files, session fencing, and bounded pending evidence and acknowledgement history.
- Provisional minute-bounded facts, explicit gaps and bounded full-span local summaries after restarts, missing/changed resources, uncertain inventory, timing anomalies, or buffer pressure. No unbounded minute backfill or invented zero usage.
- Durable fact identity across delivery failures, separate projected meter credentials reloaded per request, and pruning only after a matching API receipt and local acknowledgement.
- Startup validation before journal/task creation; storage-state failures escape the recoverable discovery path and trigger supervised shutdown.

No final facts, corrections, allowance reservations/settlement, PostgreSQL supervisor, or hard budget guard are produced by this collector.

## Bounded verification history

The baseline was 15 Worker cases plus one regional Node case. Exactly three top-level Node cases were added; no matrices, parameter permutations, or speculative suites were generated.

| Case             | Meaningful red proof                                                                                                               | Result                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Journal          | Abrupt-exit recovery yielded zero pending facts instead of the two durable minute pieces.                                          | The first implementation correction passed; subsequent targeted journal verification passed.             |
| Observer         | An owned actual CPU request was unobserved instead of the required exact 250-millicore rate.                                       | The first implementation correction passed the targeted observer case.                                   |
| Delivery/startup | A matching API acknowledgement was not accepted; a corrupt journal read was swallowed; invalid startup settings created a journal. | Each concrete defect failed first and passed its first correction within the same bounded delivery case. |

One full gate was run after the runtime candidate was frozen: format 1.160 s, lint 1.657 s, typecheck 1.512 s, Vitest 3.004 s, and Node 0.638 s. All stages passed: 15 Worker cases and four Node cases, for 19 total.

The repository-root run then exposed a portability weakness in the startup test's child-process path: it could exit on a missing module instead of the application failure. The test was changed to resolve its entry point relative to `import.meta.url` and require the application failure marker. Only `apps/regional-controller/test/usage-delivery.node.test.mjs` was rerun, passing in 0.428 s. Runtime source was unchanged; the broad gate was not repeated. The final test file therefore has this targeted result after the recorded broad gate, rather than a second full-gate result. No stop threshold was reached.

## Runtime artifact and installation

The Linux amd64 image used the Dockerfile's pinned Node 24.21.0 image. It was built in 30.83 s from 19 allowlisted public inputs in an isolated build directory. Local environment values were checked against those inputs and excluded. The source-input fingerprint, computed from each sorted relative path, a zero byte, its contents, and another zero byte, was:

```text
22c58e33c58505e24a03951ab5c41033f24149f9b8d2306ffeefa7f471832c96
```

The local Dev reference is `docker.io/library/pgcf-regional-dev:usage-22c58e33c585`. The 84.23-MiB export was imported through the already-qualified Talos `ImageService.Import` path after verifying the target against the selected kubeconfig and machine configuration. Import took 33.52 s; exact-reference/digest readback passed. The running Pod's image ID matched the archive's config digest:

```text
sha256:5f59f571c8f3d64d138c094bc743e681cd6c405c9279c859f58161c9e2f88232
```

The export SHA-256 was `a0b394ff47f0eb164dc794b02196649e190b8b6847e9654c8d397e0e86276f35`. Image metadata, private deployment receipts and target information remain in ignored local evidence. This local import and `imagePullPolicy: Never` are lab qualification; anonymous GHCR access and public release distribution remain open.

The deployment uses one replica, `Recreate`, a separate 1-GiB `pgcf-lvm` PVC and the private child journal path. Existing operation credentials and the dedicated meter Secret are mounted separately. Inventory permissions add no Secret listing or additional Secret API reads. The existing database and provider firewall were unchanged.

## Observed acceptance

Before replacement, the new Pod ran Node `v24.21.0` as UID 1000 with zero container restarts and a Bound 1-GiB journal PVC. Journal identity matched the configured region/source/epoch; SQLite `quick_check` returned `ok`. The child directory was `0700`, and the journal was `0600`.

The compiled execution client authenticated from the Pod and received `{ claim: null }`. The compiled meter client read its separate projected credential and received the expected `404` for a fresh, nonexistent environment identity. This verifies the credential/wire path without inserting a usage fact. No API-managed environment was created or admitted.

The SDK inventory completed with zero managed namespaces, zero owned allocations and zero observer issues. It saw two PVs but assigned no customer usage. The manual M1 database and the collector's own journal volume were excluded from managed-environment accounting. The outbox was empty; this does not qualify positive measurement or delivery.

One requested controller rollout replaced the Pod in 0.84 s. Readback verified:

- The same PVC/PV and sealed journal identity, a new observer session, and an advancing checkpoint.
- A durable `process_restart` gap, zero invented facts, and SQLite integrity after reopening.
- `0700` directory and `0600` journal/WAL/shared-memory modes, all owned by UID 1000, after the selected CSI driver's remount.
- The expected image config ID, one current Ready Pod, and zero container restarts.
- Both PostgreSQL SQL markers remained readable; the node stayed Ready without memory, disk, or PID pressure.

This proves this deployment's Pod-replacement behavior. It does not prove node-loss recovery, power-loss fsync durability, HA, or the behavior of another CSI driver.

## Remaining gates

Positive API-managed allocation measurement/delivery, complete transition evidence, finalization/corrections, job/init/WAL/backup/transfer accounting, regional journal backup and node-loss recovery remain pending. Long-span local gap summaries are not a complete uploaded coverage certificate.

API budgets still report `runtimeEnforced: false` and `enforcementStatus: pending_runtime`. The collector cannot settle final allowances or stop PostgreSQL. M6 still needs the allowance supervisor, independent restart-safe expiry guard, qualified stop/overshoot bounds, and disconnected-region enforcement.

R2 backup/PITR and regional admission qualification remain open. There are still no catalogs or API-managed environments, and lab admission remains closed. Public image distribution, production admission controls, host maintenance, and independently reproducible installation remain separate release gates.
