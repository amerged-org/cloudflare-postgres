# Durable initial PostgreSQL execution broker

Status: post-birth source integration. No pre-birth admission proof, protected
input publication, nonce discovery, real node/CNPG rollout or provider-state
change is established here. The default regional execution prerequisite remains
absent and managed admission stays closed.

## Integration

The broker connects the existing capacity custody, manifest preparation,
provisioning funding barrier, ControlClient permit issuer and node-delivery
transport. It derives the private initialization internally from the original
admitted consumer and fresh Namespace/Cluster/Pod/Node identities. The supplied
nonce/container attempt is only a locator: actual status and retained node
challenge validation must agree before issuance/publication.

Before dispatch and around asynchronous issuer/transport boundaries, it refreshes
funding and rechecks the original target specification, nonroot credentials,
approved image, protected input/IPC mounts and guard arguments. Only effective
arguments before the child-command separator count; duplicate standalone or
equals-form flags are refused. Alternate hostPath access and privileged/private
volume access by sibling/init/ephemeral containers are refused. Predecessor
consumers must already have their retained retirement proof.

The private SQLite operation journal reuses existing path/file/directory custody
checks, exact schema and immutable hashes. Exclusive creation, FULL WAL
synchronization and transaction/CAS transitions establish custody before dispatch
and before the sole issuer request. Existing empty/corrupt files are not repaired
or adopted on reclaim. Lease tokens and regional credentials are never stored.

Phases are prepared, dispatching, issuing, issued, publishing, published, blocked
or uncertain. Publishing intent is durable before the exact permit bytes return
to transport. Restarted in-progress/uncertain attempts never mint again or adopt
a fresh boot anchor. New nonce/container identity cannot erase existing history.
A new consumer needs the prior physical retirement evidence.

Published replay returns an explicitly historical `already_recorded` outcome
without another dispatch or issuer. It is not proof of current compute or a
quota-opening prerequisite. Stored receipts are fully checked again on load:
closed shape, original request/challenge/permit hashes, configured delivery
identity and bounded decimal deadline. Exact original permit JSON is retained
alongside its semantic object because canonical journal serialization changes
property order; the publication hash continues to bind actual bytes.

## Evidence and retained failures

Exactly three new stories fail first for missing broker behavior, then pass:
initial publication/historical replay, uncertain acknowledgement retained across
reopening, and concurrent dispatch/late authority refusal. They use actual
CapacityJournal, expected-manifest preparation, private broker SQLite and the
ControlClient issuer request; provider/runtime/delivery dependencies are fixtures.
The latest four named cases, including the unchanged capacity-journal story,
pass in 1.021 seconds. Targeted lint and package typecheck pass.

Retained setup failures include a fixture delimiter, the capacity namespace
pattern and cleanup ordering. The meaningful red proof follows those setup
corrections. A real permit-order/hash mismatch is corrected by preserving exact
JSON bytes. An unsupported TypeScript parameter property is replaced by an
ordinary field assignment. Empty setup directories are removed only after exact
task-prefix/owner/age/two-empty-child checks; fixture cleanup closes custody first.

Independent review identifies effective-argument parsing, alternate sibling host
access and receipt-on-load validation gaps. The focused corrections preserve
scope and existing assertions. These review findings are not claimed as a native
attack suite. The task remains at three new stories with no matrices.

The one frozen final gate passes format, lint, typecheck, 52 Worker and 68 Node
cases across five stages totaling 58.594 seconds. Eleven unchanged Go cases
retain their preceding evidence. No gate repeats. Subsequent changes only record
results in this checkpoint and PLAN.md; runtime bytes remain frozen.

Before and after verification, both local credential files retain original bytes,
mode `0600`, ignored/untracked status and zero private-value matches across all
563 candidate files. Credentials and private evidence remain outside delivery.

## Remaining production gates

Quota opening requires separate pre-birth admission/image/delivery readiness
proof while there are zero Pods. This broker requires an existing admitted Pod
UID; making it the quota prerequisite would deadlock bootstrap. Actual protected
expected/key inputs and bounded discovery of the guard-generated nonce remain
required before this post-birth path can run.

Wire the broker into the resident regional/admission lifecycle and verify the
actual installation key/image/guard capabilities, data layout, full container
coverage, continuous finite-window renewal and uncertain-outcome recovery. The
current server contract permits initial PostgreSQL only. No true runtime
enforcement, complete accounting or production milestone is claimed by these
source fixtures.
