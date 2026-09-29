# Explicit environment suspension v1

This protocol accepts a customer-requested compute stop and retains durable regional work. It uses CNPG hibernation and the existing owned Pooler/namespace convergence mechanism. The current executor defers physical completion; automatic idleness, connection-triggered wake, resizing and funded resume remain required later work.

## Customer intent and runtime state

`POST /v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/suspend` requires organization `projects:write`, `Idempotency-Key` and exactly `{expectedRevision:<safe integer>}`. A ready provisioned legacy environment starts at runtime revision zero. The first accepted request returns `202 {runtime,operation}` with revision one, `desiredState: suspended`, `phase: suspending` and `environment.suspend` task identity. Exact request replay preserves the initial response; changed content under the same scoped key conflicts.

`GET .../runtime` requires `projects:read` and reports current revision, desired state, observed phase, task identity and accepted nonsecret observation. A ready legacy environment without a runtime row reports revision zero/running as a compatibility assumption, not fresh physical proof. An environment still provisioning does not become runtime-ready merely because that row is absent. Foreign or missing owned parents return 404; invalid/revoked credentials are rejected. Responses are not cached.

Provisioning `environment.status` and its immutable specification remain unchanged. Runtime state lives separately in D1; clients must use it to distinguish a previously provisioned environment from currently stopped compute. The ordinary organization operation endpoint reads this task through the existing operation store. Metadata and historical tasks remain recoverable while stopped.

Suspend is an explicit immediate compute-stop request. It may disconnect sessions and roll back unfinished transactions; this slice does not promise gateway ingress draining or an idle-only decision. Committed data and retained backups/volumes must survive. Uncertain customer writes are never replayed.

## Atomic interlocks and accounting

Create the suspend intention, runtime revision and audit/request identity in one primary D1 batch. Recheck active actor authority, owned environment/spec/Cluster binding, expected runtime version and absence of queued/running environment-create, role and database work. Expired uncertain tasks still hold those locks. New database/role enqueue, claims, lease renewals, publication and credential disclosure symmetrically require running desired runtime state. Existing supported metadata and exact historical operation/result replay retain their identities.

New allowance issuance is refused while desired state is suspended. A current-authority read returns `stop` with `environment_suspended`, and its snapshot rechecks runtime version/state after hashing. This has the existing bounded validity/revocation semantics, not instantaneous workload fencing. Historical receipt replay still returns the original fence/expiry; suspension does not credit, release or settle any reserved amount.

No provisional usage becomes final because a stop was requested or observed. Storage stays allocated and may consume storage-time. Resume requires trustworthy final usage/settlement, fresh funding, a new current-run fence excluding old stoppers, and qualified startup behavior. Resetting a stopped journal or replaying an old receipt cannot implement resume. Enforcement flags remain false.

## Regional execution

The separate executor lane is `/v1/regions/{regionId}/suspend-operations/{claim|operationId/renew|operationId/result}` using existing regional claim/report scopes. Claims carry exact operation/organization/project/environment/region/spec identity, runtime revision, accepted Cluster UID and optional Pooler/Deployment identities, with ordinary 30–300-second fenced leases. No customer password or administrative Secret reference is returned by customer APIs.

The executor independently observes the owned namespace, quota, complete Pod/Pooler/Deployment inventory and retained PV/PVC chain. Before effects, it seals namespace/quota UIDs, Pooler identities and retained-volume fingerprint in a private durable operation journal. Reclaim changes lease authority, not the sealed resource identity. Replacement resources never reseal an existing operation.

Reuse one stop primitive: prevent new Pods with quota zero, conditionally scale the owned Pooler to zero, request Cluster hibernation, then verify no active/unknown/terminating namespace compute, current zero-replica Pooler Deployment and unchanged Retain volumes. Check the operation lease around inventory reads, immediately before every mutation, after uncertain readback and before result publication. Resolve lost write replies through matching owned readback; never blindly retry, create replacements, delete volumes or adopt foreign resources.

The separate supervised executor mode requires explicit private configuration, a selected kubeconfig context, private journal directory and an authorized patch identity. The default regional controller does not acquire those patch rights or start this executor implicitly.

## Completion and limits

Kubernetes convergence does not prove that node processes terminated: force deletion can remove a Pod from the API without waiting for the kubelet. The current executor returns `suspended: false` with `reason: physical_verification_pending`, emits no completion observation and leaves its sealed work reclaimable. The supervised CLI exits promptly with deferred status and a nonzero code. No physical verifier is integrated yet.

Historical journal `suspended`/`stopped` records and saved `computeAbsent` observations remain unchanged as predecessor evidence. They cannot produce a current success result or authorize resumption.

The existing completion wire below is not emitted by the current executor. Qualified completion requires the winning lease, `status: suspended`, `resultCode: compute_suspended` and exactly:

```json
{
  "namespaceUid": "<owned namespace UUID>",
  "clusterUid": "<accepted Cluster UUID>",
  "quotaUid": "<owned quota UUID>",
  "volumesHash": "<64 lowercase hexadecimal characters>",
  "pooler": null,
  "computeAbsent": true,
  "quotaPodsZero": true,
  "clusterHibernated": true,
  "poolerStopped": true
}
```

For a pooled environment, `pooler` contains exactly its bound `{uid,deploymentUid}` instead of null. Matching acknowledgement atomically marks the runtime suspended and audit task succeeded. Stale leases, revoked actors, changed runtime/spec/resource bindings or false completion flags cannot publish success. Exact terminal result replay is retained without reviving authority. Unknown runtime state stays applying/reclaimable; there is no false stopped shortcut.

The Worker trusts the authenticated regional executor's retained observation. The journal proves local durable recovery within its storage boundary; node-loss recovery, independent workload-local expiry, draining, complete accounting and public sleep/wake remain separate acceptance gates. No database is deleted by suspension.

## Bounded verification

Exactly three new top-level cases cover API intent/interlocks/authority/history/fenced acknowledgement, uncertain regional effects with durable restart recovery, and lost lease/replacement identity/Pooler or unknown-compute refusal. Establish behavioral RED first, run only affected files during iteration, build affected artifacts and run the canonical gate once on the frozen candidate. Preserve earlier held qualification workflows and mandatory stop limits.
