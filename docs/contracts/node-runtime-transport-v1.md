# Node runtime transport v1

This transport binds the existing CRI observation to an explicit operator-owned Kubernetes execution. It exposes no new agent network listener and does not implement physical stop completion, finalized usage or budget enforcement.

## Identities and channel

Private operator configuration pins installation/region, protected Namespace UID, DaemonSet name/UID, reviewed image index/amd64/configuration digests, and up to 32 unique Node/boot and observer Pod identities. Image references use the approved repository index; runtime container image ID is checked separately against its configuration digest. Namespace/node/pod naming alone is insufficient.

Each call selects one exact peer. Fresh API reads verify protected Namespace, current DaemonSet identity/template, Pod UID/owner/scheduling/recipe/runtime image and selected Node UID/boot before and after execution. The approved spec includes exactly one CRI-socket mount, the fixed resident binary/arguments and server-owned Downward API fields. No provider credential, ServiceAccount token, host network/PID/IPC, injected sidecar or arbitrary environment is permitted. Socket access and `pods/exec` to this Pod remain trusted node-administration authority, even with a read-only mount.

The transport negotiates only the qualified `v4.channel.k8s.io` protocol. The maintained Kubernetes Exec/WebSocket client preserves explicit-context TLS, CA, client certificate/key, SNI, authentication and agent options. HTTPS verification remains enabled. Authorization/cancellation is checked after asynchronous authentication and immediately before socket creation. Handshake, payloads and the whole call are bounded; nonzero status, premature close, missing status, malformed/overflowing output, stale identity and timeout produce a generic unknown result. Closing a socket is not evidence that the remote process ended.

Exec addresses a Pod name without a UID precondition. A fixed `observe` command launches the approved binary with a fresh request UUID and expected scope. Go independently reads its own Pod UID/namespace/node name from Downward API values and installation/region from protected configuration; caller arguments cannot override those actual identities. The envelope binds that self identity and request UUID to the existing bounded CRI snapshot. All received output is discarded if any post-execution identity or specification differs.

## Output and limits

The internal receipt contains the validated envelope and its canonical SHA-256. The operator CLI exposes only sanitized counts, state and probe hash; full cross-tenant runtime inventory is private. Exact runtime nanosecond values remain strings, unknown/orphan/partial observations are refused, and current runtime states retain their original meanings.

The resident `agent` has a maximum 24-hour lifetime and clean signal shutdown. It performs no CRI reads while idle. The per-command observer is limited to 10 seconds; operator execution is limited to 20 seconds, stdout to 8 MiB and stderr to 4 KiB. Long-lived identity changes require separately validated operator configuration; the transport never silently selects a replacement peer.

## Product integration boundary

An optional explicit operator configuration supplies the observer to regional runtime adapters. Existing suspend/allowance paths still report `physical_verification_pending`. Completing a stop additionally requires exact original cohort coverage, stable stop barriers, durable scoped evidence, fresh lease/epoch/ownership/volume checks and conservative recovery from uncertain publication. Separate Node/Pod observations remain non-atomic; this transport is not a transaction over Kubernetes or runtime state.

The pre-existing one-shot lab qualifier remains held. New resident/transport qualification has its own implementation evidence, not a relabeling or automatic retry of that stopped workflow. Production distribution, actual tracked database operation and independent expiry/final accounting remain release gates.
