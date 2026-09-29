# Optional managed session pooling v1

An installation operator can enable an internal CNPG Pooler in a new immutable catalog profile. Customers choose that profile through the existing environment API. The platform derives resource names, certificate hostnames and supported configuration; callers cannot select a backend URL, Kubernetes object, Secret, arbitrary PgBouncer parameter or SQL authentication query.

## Versioned policy and compatibility

`profile.pooling` is optional. Omission preserves the existing unpooled profile serialization, resolved-spec hash, resource layout and three-field readiness observation. Existing catalogs/specifications are never rewritten. Enabling pooling requires a new catalog version and a new environment; no implicit retrofit or alter-pooling route is introduced. This additive profile contract retains environment `specRevision: 1`.

The block has exactly this shape:

```json
{
  "version": 1,
  "image": "ghcr.io/cloudnative-pg/pgbouncer@sha256:<verified digest>",
  "mode": "session",
  "compute": {
    "requests": { "cpuMilli": 50, "memoryMiB": 64 },
    "limits": { "cpuMilli": 200, "memoryMiB": 256 }
  },
  "connections": {
    "maxClients": 50,
    "poolSize": 5,
    "maxDatabaseConnections": 10,
    "maxUserConnections": 10
  },
  "timeouts": {
    "queryWaitSeconds": 15,
    "connectSeconds": 10,
    "cancelWaitSeconds": 10
  }
}
```

These numbers illustrate the qualified lab policy, not universal product defaults. Every field is explicit. Reject unknown/null fields, unpinned images, unsupported versions/modes, noninteger values and limits below requests. Compute uses the existing profile bounds (CPU 1–1,000,000 millicores; RAM 1–1,048,576 MiB). Client slots are 1–10,000; backend caps/pool size are 1–1,000; pool size cannot exceed any applicable connection cap. Timeouts are 1–300 seconds. Resource-fit admission and PostgreSQL connection headroom still require installation evidence; syntactic acceptance is not a capacity guarantee.

The public catalog/environment includes the nonsecret policy. The complete normalized profile becomes part of the immutable resolved-spec hash. Fixed behavior is one RW session Pooler, Recreate deployment and no reserve pool. Transaction mode, arbitrary replicas and peering are outside this first version.

## Resource, PKI and readiness ownership

The regional controller reserves the existing PostgreSQL `instances + 1` initialization/maintenance slots, then adds one Pooler Pod and its CPU/RAM requests/limits. It grants no extra persistent volume for pooling. Main and bootstrap-init containers use explicit resources; their effective Pod reservation is the maximum, not their sum. One controller owns the composite quota.

On first Cluster creation, add only the internally derived `database-pool-rw`, `database-pool-rw.{namespace}` and `database-pool-rw.{namespace}.svc` server SANs. CNPG owns certificate issuance and renewal. The Pooler uses that Cluster certificate and CNPG automatic password-query/backend-client integration; no customer-selected TLS Secret or alternate PKI service is introduced. Require client TLS and backend `verify-full`. Clients must independently verify the matching certificate and hostname when a connection path is eventually offered.

The fixed Pooler name is `database-pool-rw`; its platform identity/spec labels and controller owner reference bind the exact Cluster UID. Resolve uncertain creation by owned readback. Reject foreign owner references or divergent specification, rather than adopting or replacing resources. CNPG owns the Pooler's Deployment/ReplicaSets/Pods.

A pooled environment-ready result includes the ordinary Cluster observation plus `pooler:{uid,generation,deploymentUid,readyInstances:1}`. Require that extra exact metadata for a pooled profile and forbid it for an unpooled profile. Ordinary role creation accepts the matching extension without weakening environment/spec fences. Current Deployment generation/replica readiness, pinned image, Pod readiness and the complete Pooler→Deployment→ReplicaSet→Pod chain must agree; phase/TCP readiness alone is insufficient.

This reports provisioned internal resources. It does not publish an external hostname, attest SQL reachability, verify certificate contents on the wire or complete connection qualification. The earlier [manual pooling evidence](../evidence/m2-native-pooling-2026-09-29.md) uses an independent frontend CA; automatic first-Cluster SAN issuance and API-managed SQL remain separate live gates.

## Metering and normal stopping

Collect Poolers, Deployments, ReplicaSets and cluster-labelled Pods within the bounded managed namespace inventory. Attribute actual CPU/RAM requests to `platform` only after proving namespace/Cluster ownership and the complete Pooler/Deployment/ReplicaSet/Pod UID chain. Include that lineage in continuity evidence. Labels alone cannot establish billing ownership. Uncertain ownership/startup/allocation semantics report gaps; no guessed free compute or positive charge is emitted. Retained database storage and ordinary instance continuity retain their existing behavior.

For pooled allowance supervision, the private immutable runtime binding additionally requires `pooler:{uid,deploymentUid}` from independent identity readback. Preserve it across journal restart. Poolers found without the expected binding are not adopted or patched. First prevent new Pods with quota zero. Scale the exact owned Pooler `spec.instances` to zero using UID/resource-version conditional patches, request Cluster hibernation and resolve uncertain mutations through matching readback.

CNPG hibernation does not stop a Pooler. Record stopped only after its owned Deployment acknowledges the current zero replicas, the entire namespace has no nonterminal or terminating Pods, quota remains zero, Cluster remains hibernated and retained volume identity is unchanged. Unknown or foreign compute keeps the result `stopping`; it is never deleted or relabeled. This mode does not restore replicas, resume a database, release/settle a reservation or invent final usage. Storage remains allocated while compute stops.

The default controller does not automatically start allowance supervision. Independent expiry enforcement, ingress draining, final accounting, controller/node-loss behavior and stop overshoot remain open; `runtimeEnforced` stays false. Network paths and trusted controller/admission boundaries require installation qualification before customer admission.

## Bounded verification

Exactly three new top-level cases cover catalog/observation/role compatibility, uncertain Pooler provisioning with TLS names and separate quota headroom, and owned Pooler accounting plus restart-safe stop/convergence. Run named affected files during iteration, compile affected artifacts before the one frozen canonical gate, preserve failures and stop limits, and never restart earlier held SDK/SQL/Barman workflows as part of this change.

Sources: [CNPG hibernation reconciler](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/reconciler/hibernation/reconciler.go), [Pooler updates](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/pooler_update.go), [automatic authentication](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/api/v1/pooler_funcs.go), [generated deployment](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/pgbouncer/deployments.go).
