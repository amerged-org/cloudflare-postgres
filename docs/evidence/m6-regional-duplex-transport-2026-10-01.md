# Regional authenticated node-delivery transport

Status: source candidate with local maintained-SDK mutual-TLS/WebSocket evidence.
No live node/broker/CNPG rollout or provider-state change occurs.

## Implemented behavior

The regional transport uses the pinned Kubernetes SDK and authenticated
HTTPS/WSS, with TLS verification enabled and v4 channel negotiation only. It
loads explicit installation-owned kubeconfig/context and a separate delivery
Namespace/DaemonSet/image/Node/Pod configuration. The common peer verifier
retains its existing observer defaults; only validated delivery differences are
normalized into the unchanged observation Pod-spec constraints.

The delivery profile requires the separate binary/container, exact added
CHOWN/DAC_OVERRIDE capabilities, protected kubelet mount and delivery-specific
Downward API environment. Namespace/Node/Pod/owner identity, image/container,
restart, generation/template and original boot are read before the exchange,
around the issuer request and after completion.

One live PassThrough is supplied as Exec stdin. Initialization is sent only
after connection and stdin-listener setup; stdin stays open through the receipt.
The bounded parser handles fragmented/coalesced frames and checks the exact
known Go producer bytes, self/request/challenge identity, cryptographic permit
signature/full binding and matching publication hash/deadline. An asynchronous
challenge reserves its state before awaiting any callback, preventing duplicate
issue work. Current target/lease/funding revalidation callbacks are mandatory.

The returned permit is snapshotted immediately. Its exact outbound frame is
prepared before the final awaited refresh, then current authority is checked
immediately before any permit byte enters stdin. A send is not delivery proof:
every subsequent failure is publication-uncertain. Success requires a matching
receipt, successful Kubernetes status, completed stdout/socket closure and
unchanged final peer plus current authority. The transport never retries the
issuer or dispatch automatically.

## Focused evidence and corrections

Exactly three new top-level stories fail first, then pass: complete authenticated
delivery with one issuer request, lost acknowledgement after permit send, and a
replaced challenged peer refused before issuance. The two unchanged observer
stories also pass. The latest named five-case invocation completes in 0.810
seconds using actual SDK mutual TLS and WebSocket stream handling against an
isolated local fixture. Node execution and Cloudflare issuance are simulated;
this is not live CRI, CNPG or production evidence.

Independent review exposes a mutable issuer-result race across final
revalidation. The existing positive story then fails with an uncertain outcome
when that shared result changes. Immediate snapshot and fixed frame construction
make the same story pass. A retained type-check correction only annotates the
decoded frame reconstruction object; it changes no behavior. All failed evidence
and the three-story budget remain preserved.

Changed-source lint and package typecheck pass. The one frozen final gate passes
format, lint, typecheck, 52 Worker and 65 Node cases in 58.517 seconds across its
five stages. Eleven unchanged Go cases retain their preceding evidence; they are
not rerun for TypeScript-only changes. No gate repeats. Only this checkpoint and
PLAN.md change afterward to record results; runtime bytes stay frozen.

Before and after verification, both local credential files remain byte-identical,
mode `0600`, ignored/untracked, with zero private-value matches across all 558
candidate files. Credentials and private evidence are excluded from delivery.

## Remaining work

Connect this transport to the durable execution broker, current capacity/funding
and original target-Pod/recipe verification, installation key provenance and
the existing ControlClient issuer. The required callbacks are integration
boundaries, not proof that the production entry point supplies them: its
execution preparation remains absent and admission stays closed.

Qualify the actual delivery mount/layout and immutable image/recipe in the real
region, all-container coverage, finite-window renewal, uncertain-outcome custody,
native CNPG lifecycle and final accounting. Local TLS/stream fixtures do not
close those v1 gates or set runtime enforcement true.
