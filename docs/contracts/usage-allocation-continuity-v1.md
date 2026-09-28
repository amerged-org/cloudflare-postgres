# Provisional allocation continuity v1

This contract describes local observer checkpoints, not a new management API or a completeness certificate. The collector still sends the revision-one provisional/gap facts defined in [usage and budget authority v1](usage-budget-authority-v1.md). Positive allocated-time estimates do not enable budget enforcement or final accounting.

## Two different proofs

`evidenceHash` identifies a particular observation, including changing Kubernetes resource versions and observed resource details. The fact evidence preserves the prior allocation and the current observation evidence. A new status or resource version must therefore remain auditable without breaking an unchanged allocation's continuity.

`continuity: { version: 1, hash: <sha256> }` identifies the stable allocation and ownership chain. New allocation snapshots require a supported proof. The journal compares the explicit allocation key, environment, spec hash, resource UID, metric, attribution and normalized integer rate as well as this proof; equality of a hash alone cannot override those fields.

The observer's canonical proof binds the region, namespace name/UID, CNPG Cluster UID, environment and spec. Compute additionally binds Pod name/UID, container and assigned node. Each metric binds its own normalized rate. Resource versions, phase and unrelated request details do not establish allocation identity.

Storage uses the same canonical volume proof for direct PVC-to-PV and retained-PV observations. It binds the persisted namespace/Cluster/PVC/PV identities, names, storage class, region, spec and attribution, together with the PV's normalized capacity. Observation path, Pod presence and quantity spelling are not identity changes.

## Retained storage and conservative transitions

An existing retained binding and the fresh PV must still agree on UID, claim identity and storage class. Present namespace, Cluster or PVC objects must not contradict that binding. Missing logical objects may follow the existing retained-volume policy; their absence does not mean the disk was deallocated. Missing compute produces unknown CPU/RAM coverage, not an assumption of zero.

Changed ownership, identity, rate or spec cannot bridge a positive interval. Incomplete observations, issues, sampling deadlines, clock anomalies, process restarts and buffer pressure keep their existing conservative behavior. Polling cannot establish an exact transition time or prove complete coverage between samples.

Serialized legacy checkpoints may lack `continuity`. Such checkpoints produce `allocation_continuity_unproven` for the transition interval, then store the fresh supported checkpoint. A following unchanged proven sample can resume provisional resource-time accounting. The journal does not rewrite, reidentify or rehash previously queued facts, migrate the SQLite schema, or alter the `UsageFact` wire format. Normal process-restart coverage remains unknown independently of this transition rule.

## Evidence scope

The bounded regression cases cover real file-backed checkpoints/outbox recovery, ordinary status/resourceVersion churn, direct-to-retained storage, absent compute and a serialized legacy checkpoint transition. Live target evidence, when recorded, has its own stated scope. Complete/final usage, correction production, WAL/backup/job accounting, node-loss journal recovery and runtime allowance enforcement remain separate delivery requirements in [PLAN.md](../../PLAN.md).
