# Pre-compute provisioning funding — 2026-09-30

Status: **source qualified; Dev delivery pending**. The maintained create path
now obtains durable server-derived funding before Kubernetes effects and ready
publication. This is a ledger-backed provisioning barrier, not independent hard
runtime enforcement, final accounting or M2/M6/production completion.

The [contract](../contracts/provisioning-funding-v1.md) reuses existing allowance
tables with one deterministic operation/request identity and a separate hash
domain. Winning actor/lease/spec/run, D1-clock expiry, parent/runtime/deletion,
account/fence and unsupported-dimension checks guard issue/replay. The original
receipt, hold and expiry survive recovery; no migration or new secret is added.

One pure first-party workspace package supplies unchanged quota/Barman policy,
three exact resource-time rates and BigInt funding units to both applications.
Its production dependency and explicitly allowed public Docker inputs are pinned
in the lockfile; no external dependency version changes. Package formatting,
lint and type checks pass, with no separate test suite or case matrix.

Exactly one new Worker story fails first on the missing real API route. It then
passes using a replicated/pooled profile, exact independently expected units,
winning-actor refusal, retained replay/reclaim identity, changed-horizon conflict
and real 30-second expiry. One combined second correction pins expiry to the
same issued-time sample and rechecks authority after internal response parsing;
the same story passes in 31.94 seconds. Its private evidence honestly records
retained tool-output copies rather than original process-redirection provenance.

Exactly one new Node story fails first because the unchanged real controller
dispatches a Namespace with unavailable funding. The corrected story verifies
zero unfunded effects, durable deterministic request before HTTP, a lost
committed response across close/reopen and legal reclaim using the same hold,
receipt custody before creates, and expiry blocking further effects/readiness.
The initial correction exposes non-erasable TypeScript constructor syntax;
one narrow syntax correction preserves behavior. Subsequent final dispatch/custody
checks pass the same story in 238.911 ms. Existing named compatibility files pass.
No third top-level case is added.

Independent read-only review closes concrete async/custody defects: mandatory
pinned journal file/directory identity, post-authentication SDK dispatch checks,
request deadline including the live lease margin, exact funding timestamp
arithmetic and final ledger/actor checks after response parsing. The former
runtime journal/supervisor and enforcement flags remain unchanged.

The frozen canonical workspace gate passes exactly once in 56.307 seconds:
format, lint, typecheck, **40 Worker and 59 Node cases**. Six unchanged Go cases
retain previous evidence. No source hash changes during that gate; no existing
assertion/deadline is weakened and no broad test loop occurs.

Installation rollout must prepare only the new private persistent journal
sibling, preserve complete existing usage custody and qualify the newly packaged
image before use. Empty queues do not establish positive funded provisioning.
Admission and held backup/native/Pod-birth/physical-stop workflows remain closed.
Expired holds, runtime renewal, independent expiry, physical termination,
settlement, representative actual resource ceilings and customer recovery remain
required work. Source/API/image delivery and bounded empty Dev evidence follow.
