# Same-node namespace network policy qualification

One bounded native case qualifies the unchanged generated base database network
policies on the authorized single-node Dev installation. A client reaches its
same-namespace TCP 5432 listener before and after the foreign-namespace attempt;
Cilium explicitly drops the foreign connection with matching policy-denied
metadata. This is one direction on one Node, not complete production isolation.

## Exact policy and safe fixture scope

The production `reconcileEnvironment` function renders its `default-deny`
NetworkPolicy and `database-boundaries` CiliumNetworkPolicy through an in-memory
adapter. An authorization sentinel stops before any Secret read or Cluster
creation. The captured policy specifications and canonical hashes are reused
unchanged in two fresh namespaces and checked against actual Kubernetes readback.
Neither provider credentials nor invented backup secrets are supplied.

Fixture namespaces enforce Restricted Pod Security and omit the platform's
managed/environment/region billing labels. Three nonroot, read-only-rootfs Node
Pods have no service-account token, host access or mounted volume. They reuse the
existing verified cached image with `imagePullPolicy: Never`; no new image/import,
PV/PVC, customer environment, API operation or admission change is introduced.
The fixture requests 150 millicores and 192 MiB; fresh observed requests are
1,705 millicores / 3,315,597,312 bytes against 3,950 millicores / 7,667,183,616
allocatable bytes. Request headroom is not a production reservation.

All overlapping policy inventory is inspected first. The existing clusterwide
telemetry policy has two rules denying host/remote-node TCP 9100 only, without
changing default enforcement for other traffic. It remains unchanged. Existing
namespaced rules do not select the fresh fixture namespaces.

## Preserved history and convergence correction

The original cached-image preflight error is retained. One correction binds the
actual current image configuration digest. A subsequent false zero-global-policy
assumption and single-spec reader are corrected by inspecting the existing
multi-spec telemetry policy. No live fixture effect precedes those completed
preparation checks, and their counters are not reset.

The first actual case stops at the 65-second realization wait, before any TCP
probe or monitor. All three endpoints are Ready and healthy with both directions
enforced; two report realized revision 19 and desired revision 17. An exact
revision-equality expectation incorrectly refuses those already advanced states.
The failed case completes exact owned cleanup in 83.438 seconds; original
infrastructure/SQL preservation passes. Its original reports/commands remain
archived without being relabeled green.

[Cilium 1.20.2 policy wait](https://github.com/cilium/cilium/blob/v1.20.2/cilium-dbg/cmd/policy_wait.go#L43-L54)
requires Ready and realized revision **at least** the requested revision. An
unselecting repository change may advance realized revision without a new desired
calculation. One private observer correction adopts that verified rule while
adding exact normalized realized/desired L4 comparison and TCP 5432 CNP
name/namespace/UID derivation checks. No production policy is relaxed or changed.
The same single case passes on actual attempt two in 33.707 seconds.

## Actual traffic and identity evidence

Namespace, Pod and policy creation UIDs are sealed and checked again. Current
Pod IPs, Cilium endpoint IDs, security identities and CEP Pod-owner UIDs match.
All selected endpoints are Ready, policy health is OK, ingress/egress enforcement
is enabled, realized revision is sufficient and realized L4 rules match the
desired rules independently of presentation order. TCP 5432 rule provenance
binds the exact owned `database-boundaries` policy UID.

A same-namespace HTTP-over-TCP nonce response proves the allowed peer path.
The other namespace's listener independently returns its own nonce locally.
A source-endpoint-filtered Cilium monitor starts before the sole foreign TCP
request and captures four `Policy denied` events. Each matches current source
endpoint/security identity, destination security identity, exact source/destination
Pod IPs, TCP and destination port 5432. No other client uses that foreign tuple.
The request fails, then both the same-namespace peer and foreign listener nonce
controls succeed again. A timeout alone is never acceptance evidence.

The monitor capture is bounded during streaming at 1 MiB; raw packets, endpoints
and nonce values stay private. Cleanup checks Cilium Pod UID and the exact monitor
command before terminating that owned process and observing its exit. Namespace
cleanup uses the recorded UID preconditions and qualification nonce. Both fresh
namespaces, their Pods/policies and Cilium endpoints are confirmed absent afterward.

The original Node UID/boot remains Ready, all 29 original Running Pod UIDs/restart
counts stay intact, all four PVC and five PV specifications remain unchanged,
both original SQL markers remain one and the telemetry policy is untouched.
All 4,096 existing usage-outbox facts retain their exact sequence/payload/evidence
hashes. No qualification workload is attributed to a customer or added to that
queue. The environment files remain private, unchanged and outside Git.

## Verification limits and remaining work

This is one native qualification of existing code/upstream behavior, with no new
runtime source, unit test, generated suite, canonical gate repetition or held-flow
resumption. The runtime library still has its prior 72-case qualification; that
suite is not rerun for this fixture/evidence work.

This exercise proves selected IPv4 Pod-to-Pod TCP 5432 separation in one direction
under the exact base namespace rules. It does not prove reverse-direction traffic,
all ports/protocols, SQL privileges/TLS, the verifier/gateway exception paths,
multi-node behavior, host/NodePort isolation, noisy-neighbor or kernel escape
resistance. Untrusted production still requires the approved threat model and
remaining M4/M5/M8 evidence. Backups/PITR, budget enforcement, sleep/wake and
scaling remain their own required gates in [PLAN.md](../../PLAN.md).

Sources: [Cilium namespace policy](https://docs.cilium.io/en/stable/security/policy/kubernetes/),
[monitor flags](https://docs.cilium.io/en/stable/cmdref/cilium-dbg_monitor/),
[drop event representation](https://github.com/cilium/cilium/blob/v1.20.2/pkg/monitor/datapath_drop.go).
