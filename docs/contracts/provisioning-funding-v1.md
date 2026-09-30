# Provisioning funding v1

The maintained regional create controller reserves a server-derived resource
ceiling before its first Kubernetes effect. This connects the existing allowance
ledger to provisioning. It does not supply a signed workload permit, independent
expiry, continuous funding renewal, physical stopping or final accounting.
`runtimeEnforced` remains false; installation admission stays closed until the
remaining pilot/runtime gates are qualified.

## Current winning lease and immutable funded work

`POST /v1/regions/{regionId}/operations/{operationId}/funding` accepts only:

```json
{
  "leaseToken": "<current private provisioning lease>",
  "leaseEpoch": 1,
  "fundingSeconds": 300
}
```

The horizon is a strict integer from 30 through 300 seconds. The maintained
executor seals 300 seconds before transport. Caller-supplied environment, actor,
specification, run epoch, rates or units are rejected. The server resolves them
from the current `environment.create` operation and immutable environment.

Issuance and replay require the exact recorded non-null actor, current token
hash/region/scope, non-disabled region, active parent, exact winning lease/epoch,
and an unexpired lease under the D1 clock. They also bind environment/spec/run,
runtime/deletion state, current budget accounts and the existing accounting
fence. Receipt decryption and response wrapping are followed by current checks;
an earlier successful authentication is insufficient.

The existing ledger uses `operationId` as `request_id`, giving one bootstrap
reservation per create operation. A domain-separated hash binds protocol,
operation/environment/region/spec/initial run, envelope version, horizon and
derived units. Lease token, lease epoch and actor are current authority, not
immutable funded-work identity. A legitimate reclaimed lease can recover the
same hold; a changed horizon/spec/run or ordinary allowance request in another
hash domain conflicts.

Replay never advances the original issued/expiry timestamps or creates a second
reservation. Expired or unavailable funding is refused while retaining the
original hold. No guessed settlement, automatic replacement or zero consumption
is emitted. Ordinary allowance routes retain their existing wire/hash behavior.

## One resource envelope

Both the Worker and regional resource builder import the first-party, pure ESM
`@cloudflare-postgres/resource-envelope` package. It preserves existing quota
strings and Barman defaults. With `S = instances + 1`:

| Dimension              | Namespace ceiling                                 |
| ---------------------- | ------------------------------------------------- |
| CPU requests           | `S × (database millicores + 25) + Pooler request` |
| CPU limits             | `S × (database millicores + 100) + Pooler limit`  |
| Memory requests        | `S × (database MiB + 64) + Pooler request`        |
| Memory limits          | `S × (database MiB + 128) + Pooler limit`         |
| Requested data storage | `S × volumeGiB`                                   |
| PVC count              | `S`                                               |
| Pod count              | `S + optional Pooler slot`                        |

The extra slot covers initialization/maintenance ceilings; it proves neither
fleet spare capacity nor an actual allocation. A Pooler's equal init/ordinary
requests count once. Funding derives exact decimal-string CPU-millicore-time,
memory-byte-time and data-storage-byte-time units with BigInt multiplication
by the horizon in milliseconds. It reserves this ceiling rather than billing
observed utilization or claiming consumed usage.

Any applicable budget limiting backup/WAL storage or transfer refuses this path
until those dimensions have proven envelopes. Missing units do not mean zero or
unlimited authority. Existing actual allocation/rate checks remain separate;
requested ceilings do not certify CSI/PV capacity or trustworthy metering.

## Bootstrap custody and effect dispatch

`PGCF_PROVISIONING_JOURNAL_DIRECTORY` selects an existing real, operator-owned
`0700` directory on persistent storage. Validate it before any controller/meter
task starts. There is no temporary fallback or repair of existing data. Missing
configuration permits empty-queue startup compatibility but refuses claimed
creation before Kubernetes effects.

The separate private SQLite journal seals operation/environment/region/spec,
initial run, fixed horizon and deterministic request before HTTP. It persists
the matching server-owned project/organization, rates, units and receipt before
effects. Existing runtime journals retain their live Namespace/Cluster/quota UID
requirements and cannot be substituted with bootstrap custody.

Reclaim requires retained history. Missing, foreign, corrupt or replaced custody
fails closed; file/directory identities, owner and modes are pinned. Ambiguous
responses reuse the same operation/request/horizon. Clock rollback remains
blocked. Journals, holds and uncertain infrastructure survive deferral.

The maintained `runController` refreshes the existing short-lived authority
before every Kubernetes create and before readiness publication. Reads recheck
lease/funding around asynchronous work. The pinned SDK's last pre-send middleware
checks again after authentication; its bounded abort signal uses the minimum of
funding, authority, resource-unit horizon and current lease safety deadline.
An interrupted request may already have committed: deterministic readback and
the same retained receipt resolve that uncertainty, without blind replay.

No further effect or readiness result is published after denied, stale, paused,
insufficient, expired or inconsistent authority. Resources already started can
outlive this controller. Existing privileged writers and the API's ordinary
ready-result route are not universal funding admission gates. Workload-bound
signed guard injection, continuous renewal, stop/accounting and failure evidence
remain required before an enforcing installation is admitted.
