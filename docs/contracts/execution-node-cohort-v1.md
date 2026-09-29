# Execution node cohort v1

This contract records the original eligible server set before a new tracked environment can create database compute. It is a prerequisite for future node-backed stop evidence. It does not authenticate runtime observations, finalize usage, implement independent expiry or establish production readiness.

## Policy and management reference

An immutable operator profile may select `nodeTracking: {"version": 1}` only together with `executionFencing: {"version": 1}`. The initial run epoch remains server-assigned `"1"`. Legacy profiles and environments receive no reconstructed cohort.

Tracked ready observations require `nodeCohort: {"uid": "<ConfigMap UID>", "hash": "<canonical SHA-256>"}`. The management API stores the normalized reference alongside provisioning observation. Equivalent UID/hash key order produces the same result identity. Public profile/recovery resources expose the policy and opaque reference, never the full server roster.

Explicit suspend captures that exact reference in its immutable D1 snapshot and carries it into the regional claim. Lease validation compares the current ready reference with the stored snapshot; substitution invalidates authority. A missing pointer does not select a replacement. Migration `0014` is additive; legacy snapshots remain null and the existing no-update/no-delete protection covers the new field.

## Durable initialization before Kubernetes effects

A tracked profile requires a private `nodeTrackingJournalPath` in regional operator configuration. Before any Namespace effect, the bounded regional SQLite journal persists the immutable operation/environment/spec/run scope, original Node records and a unique birth identity. An initial reservation is permitted only for the initial claim epoch with an absent namespace; a reclaimed operation with missing local history remains unproven. Legacy profiles create no new journal.

The Namespace carries that birth identity. Its first observed UID is bound once; a recreated Namespace cannot replace it. The ConfigMap UID/hash is similarly bound once before Cluster or Pooler effects. An uncertain create resolves against the original reservation and exact owned readback. Original records survive retry/restart and are never replaced with a fresh server roster. Loss of this journal requires separately qualified recovery; empty current Kubernetes lists do not reconstruct history.

This regional journal is private operational provenance, not a replacement for canonical Cloudflare control state. Local persistence does not qualify node-loss recovery or physical termination.

## Regional record before compute

The immutable ConfigMap `execution-nodes` belongs to the exact managed environment namespace and its Namespace UID. Its single data entry `cohort.json` contains canonical bytes for:

```json
{
  "version": 1,
  "environmentId": "<environment UUID>",
  "regionId": "<region UUID>",
  "specHash": "<immutable spec SHA-256>",
  "runEpoch": "1",
  "namespaceUid": "<Namespace UUID>",
  "nodes": [
    {
      "name": "<Node name>",
      "uid": "<Node UUID>",
      "bootId": "<reported boot UUID>"
    }
  ]
}
```

Nodes are unique and canonically ordered, with a one-to-32-member bound. Capture uses complete bounded Kubernetes Node observations. Node metadata is recorded provenance; API readiness/boot metadata alone proves neither fresh reachability nor process termination.

Before the first ConfigMap is created, the controller requires its durable original reservation and a complete empty namespace compute preflight covering every Pod, CNPG Cluster and Pooler. A previously sealed missing ConfigMap is refused even if current compute lists are empty. Existing compute without recorded history is refused. Unknown, partial or failed lists cannot establish absence. An uncertain ConfigMap create resolves by exact owned readback before any Cluster/Pooler creation.

Cluster and Pooler annotations bind the ConfigMap UID and canonical hash, not merely its name. Deleting and recreating an immutable ConfigMap does not preserve that identity. Original Node UID/boot identity is revalidated before compute/ready work; every Running compute Pod used for readiness, including Pooler Pods, must identify an original member. No implicit identity refresh occurs.

## Placement and stop boundary

Required node affinity confines CNPG instances, initialization/recovery Jobs and Pooler Pods to original node names. CNPG 1.30.1 exposes Cluster `spec.affinity.nodeAffinity` and Pooler `spec.template.spec.affinity.nodeAffinity`. [Instance affinity](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/pods.go), [Job generation](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/jobs.go).

Name affinity is a scheduling boundary, not a Node UID/boot fence or eviction rule. Same-name replacement, reboot, missing original membership or contradictory binding must not become stop completion. Rebinding, expanding eligible membership and advancing a run epoch require a separate qualified lifecycle; they are not implemented by this record. [Kubernetes node affinity semantics](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/#node-affinity).

The regional stop path fetches and validates the exact claimed record, seals its full scope before effects and preserves it through restart. Current stop results remain `physical_verification_pending`: this contract supplies which original servers must be covered, not the physical coverage itself. Qualified completion still requires independently bound fresh observations of every original eligible node, durable scoped proof, lease/epoch/ownership rechecks and retained-volume preservation. Final allocation/lifetime accounting remains separate.
