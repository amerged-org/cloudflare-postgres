# Node runtime transport implementation checkpoint

This checkpoint implements a challenged Kubernetes Exec channel to the maintained CRI reader. It is not physical-stop completion or finalized usage evidence.

The resident Go agent exposes no network listener, performs no idle CRI reads, exits cleanly on signals and has a maximum 24-hour lifetime. Each observe command validates its Downward API Pod/namespace/node identity and protected installation/region before connecting to CRI. A fresh request UUID binds the exact self identity to the bounded snapshot.

The regional adapter uses pinned Kubernetes SDK 2.0.0 and MIT-licensed ws 8.21.0, with verified TLS and qualified v4 channel negotiation. Namespace, DaemonSet, Pod/container and Node/boot identities and the fixed execution recipe are checked before and after Exec. Runtime state/timestamp validation matches the Go schema. Whole-call/handshake/output limits, successful exit and drained output are required; errors remain generic unknown results. The optional private operator CLI exposes only counts/status/hash. Existing stop paths remain physical_verification_pending.

Exactly three new top-level cases (two Node, one Go) failed meaningfully first. A bounded review found global TLS disabling, container-level seccomp override and unqualified v5 negotiation; each concrete example failed within those same cases and passed the first narrow correction. No matrices or further cases were added. A single frozen full gate passed format, lint, typecheck, 26 Worker cases, 31 Node cases and four Go cases in 19.786 seconds. No invocation exceeded ten minutes; no broad gate was repeated.

Read-only Cloudflare confirmation found all five Contabo Secret names among eight Dev Worker Secrets. Secret values were not retrieved or written to public files. The ignored local environment remains unchanged and mode 0600; 22 held SDK files are unchanged. No Cloudflare schema/binding change accompanies this transport implementation.

Live resident-agent execution, image distribution and actual tracked database stop remain unqualified at this source checkpoint. The older one-shot qualifier remains held. Original cohort coverage, durable completion evidence, independent expiry and final accounting still require their own implementation and qualification.
