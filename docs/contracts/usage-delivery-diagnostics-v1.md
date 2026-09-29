# Durable usage delivery diagnostics v1

The regional sender retains one bounded latest delivery failure in its existing
private source-bound SQLite journal. Operators can distinguish a known HTTP
refusal from transport, acknowledgement or local accepted-ledger capacity issues
without inspecting raw credentials, resource records or arbitrary server errors.
This is diagnostic evidence, not authority to skip, acknowledge or reassign a fact.

## Transport boundary

`UsageDeliveryError` retains the received HTTP status and a nullable safe code.
Only the exact JSON envelope `{error: {code}}`, within 8192 UTF-8 bytes and with
the known status/code pairing, may supply that code. The accepted pairs are
400/invalid_request, 401/unauthorized, 403/region_disabled, 404/not_found,
409/source_identity_conflict or usage_revision_conflict,
500/state_inconsistent and 503/correction_planner_unavailable.

Unknown, extra-field, malformed, oversized, non-JSON or stalled bodies retain the
already received status with `code: null`. The existing 20-second total request
bound includes credential loading, transport and body handling; reading an error
never starts a second deadline. No arbitrary error text, URL, response headers or
credential value enters diagnostic state or public logs. Successful acceptance
still requires the existing exact normalized receipt.

## One durable record

`UsageJournal.status()` includes `lastDeliveryFailure`, either null or the latest
validated source-bound record. It contains fixed kind, nullable HTTP status/code,
an exact UTC millisecond timestamp, the original fact ID/revision/evidence hash,
source identity and `activationSupported: false`. It reports the latest observed
failure, not a continuous health guarantee. Record size is bounded at
2048 UTF-8 bytes, with exact allowed fields and value validation. These private
fact/source identifiers are not public customer status or log contents.

Metadata is stored under one existing journal-meta key, without a new table,
journal schema version or D1 migration. Recording a failure validates the current
pending fact and any existing record first. Corrupt or wrong-source stored state
is fatal and cannot be silently overwritten with a plausible new diagnosis.
The outbox, payload/evidence hashes, checkpoints, gaps, accepted records and
source epochs keep their existing authority and retention semantics.

Exact strict receipt acceptance clears matching failure metadata in the same
transaction that retains the receipt and retires its pending fact. Unrelated
receipt acceptance, weak legacy acknowledgement, archive retirement or mere retry
does not clear the record. Local accepted-ledger capacity failures remain deferred
with their pending fact intact; other local acknowledgement corruption/conflicts
retain the existing fatal behavior.

## Operational meaning

A 404 can identify an absent/wrong-region environment or a meter-region mismatch.
A 409 may be a source/revision conflict or an uncertain conditional-state race.
Neither is automatically classified as permanent or a deletion permit. Inspect
canonical authority and original resource provenance. Never fabricate a customer
record, change old fact identities, remove unaccepted data or invent zero usage.

The previously diagnosed Dev queue belongs to a retired qualification fixture,
not a canonical customer environment. Its complete inactive
[journal custody copy](usage-journal-snapshot-v1.md) remains available. New failure
visibility does not recover that authority or resolve its explicit evidence
handling. Head-of-line replay, existing delivery cadence, customer admission and
runtime budget enforcement are unchanged by this slice.
