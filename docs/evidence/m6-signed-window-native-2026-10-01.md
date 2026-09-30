# Signed finite window — native Linux lifecycle continuation

Status: **the existing standalone signed Linux lifecycle case passes**.
The production candidate binary is unchanged. Its issuer/source integration,
installation keys, CNPG injection, capacity reservation, funded renewal and
managed customer admission remain unqualified. This is not runtime budget
activation or completion of M2/M6.

## Exact diagnosis, without weakening custody

The earlier candidate exits before creating a challenge. The user subsequently
removes the fixed retry cap. Root uses a private diagnostic copy, after a narrowly
scoped Astra Ultra review; it adds only constant stage markers and nonsecret
predicate observations, keeping original syscalls and checks unchanged.

Two fresh clock containers report the same boot ID, so that suspected difference
is not supported by the observation. The actual signed process reaches its first
directory pin and rejects owner identity. Under the tested Docker Desktop host
bind arrangement, Go's legacy `unix.Lstat` reports UID/GID zero while the process
UID is 501; independent Node filesystem metadata reports UID501/GID20 and mode700.
Linux-native tmpfs reports the expected UID/GID to the same Go syscall, and all
three directory pins pass. These are measured fixture differences; this record
does not claim a general kernel, Go or Rosetta cause.

The production owner-match, private-mode, no-symlink and metadata/hash checks
remain intact. No user/root ownership exception, unsigned fallback or wider
permission is introduced.

## Corrected fixture and retained transport stop

The continuation places synthetic manifests/public-key pins and private IPC on
Linux-native named volumes. A separate local setup container uses only CHOWN
for its own fixture-volume ownership; it consumes public RFC test inputs via
stdin. The guard itself remains unprivileged with all capabilities dropped,
network disabled, read-only root and read-only input mount, isolated PID namespace
and bounded CPU/memory/PIDs. No installation signing key or bearer token enters it.

The original static AMD64 candidate remains exactly SHA-256
`9415ff7a8fe1f4bc4524d0f98307a069be8a90f9fcc8338fe3ba22f9d955db88`.
There is no production source correction or binary rebuild for the final case.

The first native-volume continuation starts and expires correctly but fails its
replay transport: the response writer runs inside the guarded PID namespace and
can be terminated when PID1 rejects the old response. The failed 15.663-second
result remains retained, with successful cleanup. The next precise fixture
correction moves only that writer into a separate isolated transport container
using the same private IPC volume. It does not slide the guard's clock or change
its signature, binding, nonce or process checks.

## Complete existing lifecycle case

The corrected continuation passes in **16.093 seconds**, including local cleanup:

- Native signed startup receives its protected challenge and verifies a valid
  synthetic Ed25519 response after a two-second transport delay.
- Manager and detached child start; both receive shutdown signals and become
  quiescent under the original BOOTTIME-anchored hard deadline. Observed time
  from challenge capture to quiescence is **11.199 seconds**; transport does not
  create a later expiry.
- A new container attempt emits a fresh nonce. The old signed response is
  refused before either manager or child starts.
- Both guard containers and all named fixture volumes are removed. Inspection
  confirms zero remaining volumes under the operation label.

This resumes the same existing real Linux story, not a new matrix or renamed
budget. No new automated stories or workspace gate are run for this fixture-only
correction. The earlier Worker/Go/canonical gate evidence remains historical;
promotion into the current mainline still requires current integration checks.

Local environment files remain byte-identical, ignored, untracked and mode0600.
All other held source files remain byte-identical. No Contabo workload, Cloudflare
Worker/Secret/schema, customer environment, provider server or production
configuration changes. Public RFC fixture material cannot fund a real workload.

## Next required integration

Integrate the candidate with the current management/regional source, using fresh
primary authority throughout signing/rechecks. Then implement protected manifest/
public-key delivery, actual Pod/Node/image binding, reliable external transport,
CNPG/Pooler/backup-container coverage and durable funded run handoff. Physical
compute/storage exclusion and auditable resolution of the saturated noncanonical
usage queue remain required before the ordinary API pilot can admit workloads.
The standalone local pass supplies no scheduler reservation, usage settlement,
storage stop or installation-wide enforcement claim.
