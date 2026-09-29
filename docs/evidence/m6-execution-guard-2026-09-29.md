# Local execution deadline guard checkpoint

This implements the workload-local finite deadline component, keeping the original PostgreSQL/CNPG manager command intact. It does not activate runtime budget enforcement, complete Suspend or finalize usage.

## Reused lifecycle and local enforcement

CloudNativePG's OperatorLifecycle plugin interface can inject a wrapper before Pod creation. Its PostgreSQL plugin interface only enriches configuration. PostgreSQL starts in a separate process group; online manager upgrades deliberately preserve it. Killing or observing only the manager is therefore insufficient. The [guard component](../../apps/execution-guard/README.md) uses the maintained Linux timer and process APIs around the original command, without an operator or PostgreSQL fork.

An operator-protected immutable boot/run/window is parsed once. Its at-most-300-second deadline uses absolute CLOCK_BOOTTIME nanoseconds, including suspend time. Wrong boot/run, expired/future windows and malformed configuration cannot start execution. PID1/private-namespace authority is mandatory before launch or namespace signalling. Shutdown asks the manager first, then requests fast shutdown across the namespace, escalating to SIGKILL at expiry. Reaping plus complete process enumeration are required for local quiescence; unknown cleanup returns failure. An expired configuration stays expired across container restart.

The configuration is not a signed funded permit. Authority issuance, secure scope-bound renewal, fail-closed admission, CNPG injection, retained kubelet termination receipts, sidecar/Pooler handling, scheduler release, actual PostgreSQL/WAL recovery and final accounting remain implementation/qualification gates. Online manager upgrade is unsupported until this namespace lifetime is qualified. Kernel scheduling and uninterruptible I/O prevent an exact-time guarantee. Successful local cleanup is not an acknowledgement that CRI cannot restart a container with a still-valid configuration.

## Bounded verification

The baseline is 61 automated cases. Exactly three new independently reported cases cover this fix: one Go permit/absolute-clock case, one Go namespace-supervision case and one real Linux namespace qualification. Each has meaningful behavioral RED. No matrix, permutation or speculative suite was generated.

The two Go cases pass their first implementation candidates. The real Linux fixture remains running beyond its assigned window without the guard (RED). With the guard, a manager and a detached/adopted child that ignores ordinary shutdown both end, and reusing the expired configuration launches no child (GREEN). Its elapsed time is 15.478 seconds; the subsequent boot-clock observation is 0.245 seconds after the configured deadline. That includes observation overhead and is not a universal latency bound. This is a new guard workflow; the held SQL, one-shot reader, SDK and backup workflows remain held.

The frozen candidate's canonical gate runs exactly once in 24.404 seconds: format, lint, typecheck, 26 Worker cases, 31 Node cases and the two guard Go cases pass. Four unchanged CRI-reader cases retain their prior evidence instead of being rerun. Total automated coverage is 63 cases plus the single Linux qualification. Linux behavioral evidence precedes final formatting; no behavior changes follow it. Source review found no material defect in the scoped supervisor.

The local environment is unchanged, mode 0600 and ignored/untracked. Public-file scanning finds zero actual environment-secret matches; all 22 held SDK files remain unchanged. Builds use explicit public inputs and retain the Go/x-sys BSD notices. No Contabo order, server reimage, Cloudflare schema/secret change, customer compute creation or default guard activation accompanies this source delivery.

## Published artifact and Linux CI

Runtime source `3c9981f2c6db10e20e1a4c125da875cc6b3b953c` is pushed and matching source/plan bytes were read back from GitHub. The [Linux guard workflow](https://github.com/amerged-org/cloudflare-postgres/actions/runs/36527654520) succeeds at that exact source, running only this changed Go package's formatting, vet and two cases on Ubuntu. It exercises the kernel-clock branch rather than repeating the full workspace gate.

The standalone linux/amd64 image builds once in 38.285 seconds from exactly 12 public inputs. Its fixed entrypoint, non-root user, kernel clock read and both upstream BSD notices are verified. The local image index is `sha256:11a2f9363a993db9fbd20f218aa4db6f4b226c0a3825904a185c59ad541628d3`. No registry push or Contabo activation is claimed; public artifact distribution and the actual CNPG/allowance integration remain open.
