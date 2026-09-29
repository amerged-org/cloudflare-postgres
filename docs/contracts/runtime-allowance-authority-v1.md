# Current allowance authority and normal stop v1

This protocol connects the existing [allowance ledger](usage-budget-authority-v1.md) to regional execution decisions and normal CNPG stop reconciliation. It does not establish an independent hard cap. `runtimeEnforced` remains false until the full workload guard, ingress, accounting and failure qualification in [PLAN.md](../../PLAN.md) succeeds.

## Historical receipt versus current decision

Receipt issue replay and historical GET preserve immutable accounting identity and settlement credentials. They must remain recoverable after expiry or pause. Their existence is not permission to continue, grow or resume compute.

`GET /v1/regions/{regionId}/allowance-reservations/{reservationId}/authority` requires the existing region executor's `operations:claim` scope. It reads the receipt, environment specification, region, applicable project/environment policies, original account/epoch bindings and accounting state consistently through D1 primary reads. Conditional guards detect drift around that sampled transaction. A change after the transaction can coexist with the earlier snapshot until its bounded deadline; this is a documented revocation delay, not immediate revocation.

The response's `authority` binds schema version, reservation/environment/project/region identity, spec revision/hash, execution epoch, units, all applicable limited metrics, policy bindings, observation time, validity deadline and evidence hash. It contains an `allow` or `stop` decision and a reason, plus unchanged false enforcement flags. No settlement fence token is exposed through this endpoint. Policy targets must match the sealed project or environment, be unique and agree with the receipt's epoch.

An allow snapshot expires no later than 15 seconds after observation, the receipt expiry or any applicable policy-period end. It is a short-lived TLS-observed decision, not a signed offline permit. Paused or changed policy/epoch/account, disabled region, changed specification, settled/expired receipt, unreconciled usage or overdraw cause stop. A conflicting snapshot fails closed.

Already reserved units fund an existing receipt. A remaining balance of zero alone does not invalidate that receipt. Current grants must still cover the account's consumed/reserved obligations; new reservations use their own admission checks. Increasing a grant without changing execution epoch/account/period does not by itself revoke funded work.

## Durable regional state

Before reservation transport, persist a stable request UUID, exact units, lease duration and environment binding in an owner-private journal. An uncertain response is resolved with the same request, not another reservation. Preserve the returned receipt identity and original deadline; historical replay cannot extend authority.

Current authority must agree with the receipt and the sealed environment/spec/namespace/Cluster/resource identities. Cache it durably before authorizing work. Expired, missing, foreign, inconsistent or uncertain state cannot permit growth or automatic resume. Clock/restart uncertainty keeps the decision conservative. Resource-time dimensions also require a verified allocation ceiling and a bound on the funded horizon; a wall-clock expiry alone does not bound arbitrary allocated units.

All receipt and limited-policy dimensions participate in the verified resource-rate envelope. A CPU-only receipt cannot fund nonzero RAM under a limited RAM policy; omitted funded units are zero, not unlimited. No synthetic final usage, zero consumption or settlement is generated after an outage or stop. Reserved units remain held until actual accepted final usage references and valid stop evidence satisfy the existing settlement contract.

## Normal stop reconciliation

Loss of current authority closes owned namespace Pod growth before setting `cnpg.io/hibernation=on` on the owned CNPG Cluster. Conditional patches bind UID/resourceVersion and verified ownership/spec. They create no replacement namespace, Cluster, quota, Pod or volume. A lost patch response is resolved by matching readback before another mutation.

For pooled environments, conditionally scale the bound Pooler to zero and verify current-generation Deployment convergence. Record stopped only after all namespace compute is terminal/absent and the original PVC/PV UID bindings are preserved. The [managed pooling contract](managed-pooling-v1.md) specifies the additional immutable workload bindings. Retained data storage remains allocated and may continue consuming storage-time. This path does not prove gateway admission closure, transaction/session draining, a Kubernetes-independent expiry fence, stop during API/operator failure or zero infrastructure cost.

Automatic restart/resume is outside this normal-stop slice. It requires fresh validated authority and separately qualified resource/startup policy; a readable old receipt is insufficient. Self-hosted operators use the same generic API and ownership rules as every integrator.

## Bounded evidence

The three cases cover current funded authority through pause/epoch/expiry, durable uncertain reservation replay, and an unfunded limited RAM dimension causing owned normal stop that remains stopped through cache expiry and a control outage with retained volumes. Verification reports distinguish local cases from real deployment and operational evidence. The independent workload-local guard, full accounting/finalization, settlement, ingress and overshoot qualification remain required v1 work.

The [explicit suspend contract](environment-suspend-v1.md) adds a separate customer intention and regional acknowledgement. Suspended desired runtime state denies new allowance issuance and yields a current `environment_suspended` stop decision; historical receipt replay and settlement remain recoverable. This does not finalize usage, release holds or implement funded resume.
