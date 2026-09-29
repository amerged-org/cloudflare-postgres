# Private native access: stopped source candidate

Status: historical stopped preflight. The [subsequent delivery](m3-private-native-access-delivery-2026-09-29.md)
records its fixture-only repair, source publication and Dev installation while
retaining the original failed gate below. At this checkpoint, the isolated
candidate was not merged, published as product source, deployed or activated.
Existing Dev admission remains closed. The
candidate adds actual private application ingress and scoped endpoint discovery;
it does not complete the public PostgreSQL pilot or gateway.

## Candidate behavior and review

An optional installation-owned catalog policy selects a protected client profile.
The regional configuration binds its Namespace and ServiceAccount identities;
customers supply neither selectors nor backend hosts. The region observes the
real CNPG RW Service, Ready primary and owned EndpointSlice, verifies the public
CA and server leaf with X509, then creates or recovers one exact owned Cilium
TCP5432 policy. It checks authority and identities before effects and publication.

The scoped management endpoint exposes a private direct endpoint and public CA
only under current owned running authority. It reports provisioning observations;
clients still perform fresh certificate and hostname verification. Current CA
expiry prevents discovery. Leaf digest/expiry remain historical, since CNPG can
renew a leaf under the same CA. The Worker trusts the fenced regional X509 proof,
without adding a second certificate parser or changing Worker compatibility flags.

Namespace identity uses a protected UID label. Cilium's ServiceAccount selector
uses its logical name; later reuse requires trusted operator revocation. No claim
of continuous UID enforcement, wire SQL health or public Cloudflare reachability
is made. Independent bounded source and contract review passes.

Pinned upstream checks correct two important representation assumptions: CNPG
1.30.1 reports `status.writeService` and uses numeric Service targetPort 5432;
Kubernetes 1.36.3 EndpointSlice Pod references omit `apiVersion`. The candidate
preserves strict identities while accepting that documented omission.

## Tests and mandatory gate stop

Exactly three new top-level cases are added across both packages. One Worker case
fails meaningfully first in 8.813 seconds, then passes on implementation attempt
one in 3.679 seconds. Two Node cases fail first in 0.232 seconds and pass on
attempt one in 0.177 seconds. The existing named reconciliation case passes in
0.267 seconds without expansion. No matrix, permutation or additional case is
added. The task baseline remains 76; the candidate would add three cases.

The canonical gate runs exactly once and stops in 9.896 seconds. Format and lint
pass. Typecheck fails at two positions in the new Worker test:

- `TS2554`: the assertion's custom message is supplied to `toBe`, which accepts
  one argument, instead of `expect`.
- `TS2339`: the inferred profile spread does not declare the existing `id` field.

The broad Vitest and Node stages are not run. A passing targeted runtime test
does not erase a failed typecheck. The complete candidate is sealed unchanged;
there is no source merge, deployment, new test, repeated gate or weakened
assertion after this stop.

The smallest prepared repair changes only that test: move the unchanged assertion
message to `expect` and declare the known fixture profile ID type. The patch is
unapplied. It changes no application behavior, test count or assertion outcome.
The next step is that fixture correction and scoped verification, retaining the
original stopped gate and avoiding a second full gate.

## Live read-only preparation and remaining gates

A read-only capture verifies the existing controller is Ready on its previous
image. Its configuration has no native client profile. No Secret data is read.
The new reader needs Pod GET, Service GET, ServiceAccount GET and EndpointSlice
LIST. The actual existing ClusterRole has Pod LIST only; an initial assumption
that Pod GET already existed is corrected by its authoritative rules. Proposed
permissions add no writer or broader Secret access; no permission patch is applied.

Packet admission, a real ordinary-client TLS transaction, denied-client behavior,
API-managed endpoint qualification and deployment remain unproven. No customer
environment, allowance or credential is fabricated. Stopped SQL-verifier, Pooler,
Barman, SDK and other held cases remain untouched.

The separate [Cloudflare private-path assessment](../research/cloudflare-private-native-path-2026-09-29.md)
identifies Workers VPC/Hyperdrive as a documented later integration and preserves
its private-CA trust gap. No provider resource is created. Full milestone and
recovery requirements remain in [PLAN.md](../../PLAN.md).
