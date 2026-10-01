# Protected node-local IPC publication

Status: source candidate with isolated Linux filesystem evidence. No new node
agent, listener, signing key, CNPG recipe or provider resource is activated.

## Implementation

The Linux library binds an installation-projected challenge to current CRI
container identity, initial nonroot credentials and original boot. It walks the
locally derived emptyDir path through no-follow directory descriptors, retaining
original named edges, ownership/mode, device/inode and Linux mount IDs. Kubelet
ancestors and the volume root are operator-owned and not group/world writable;
guard-owned private IPC/attempt children are `0700`.

Challenge bytes must exactly match the canonical version-two request generated
from the installation projection and nonce. Bounded private regular single-link
files retain their original metadata and content hash. The library adds no
container-selected host paths or credential access.

The response is staged outside guard-owned IPC under a root-private directory,
so the nonroot guard cannot inspect the response or replace its source name
before authorization. Exact bytes, metadata and synchronization precede a final
current-authority check and descriptor-relative no-overwrite publication.
Matching replay retains the original inode and synchronizes both file and
destination directory before acknowledging success. Original challenge/runtime
custody is checked around publication.

Visibility precedes the final checks: the guard can accept a signed response
immediately. A later failure is explicitly `execution_publication_uncertain`.
That result, or a failed replay, never proves that compute did not start. Failed
private staging artifacts are preserved; no guard-owned file is unlinked.

## Focused evidence

Exactly three new top-level native stories cover private publication/replay and
changed request custody, peer loss before publication, and current authority
immediately before visibility. The first two fail on the missing implementation.
The third exposes an actual late-check error: revocation returned uncertain only
after the file became visible. Moving the last authority check before rename
makes the same story pass without visibility.

The final Linux/AMD64 invocation passes all three in 0.380 seconds, using an
isolated read-only, network-disabled container with CHOWN/DAC_OVERRIDE and a
distinct guard UID/GID. Its bounded writable filesystem is ephemeral. Exact
label checks confirm the owned container is absent afterward. One retained
initial preparation failure used the image's default nonroot user; it exercised
no product behavior and is not the red-first proof.

Actual Linux filesystem operations are qualified; runtime inventory is a
dependency fixture. Native CRI correlation, mount replacement under real node
operation, syscall interruption and whole CNPG execution are not inferred from
these tests. Ordinary nonroot Go runs skip the capability-dependent stories;
the explicit isolated root invocation supplies their evidence.

The one frozen gate passes format, lint, typecheck, 52 Worker cases, 62 Node
cases, six node-runtime Go cases and Linux source vet. Its seven stages take
58.452 seconds in aggregate. The three capability-dependent native cases have
the separate explicit Linux evidence above; they are not counted as executed
by the macOS gate. The unchanged execution guard retains its prior evidence.
No gate repeats. Subsequent changes only record results in PLAN.md and this
checkpoint, preserving frozen runtime bytes.

Before and after verification, both local credential files retain their exact
original bytes, mode `0600`, ignored/untracked status and zero private-value
matches across all 541 candidate files. Credentials and private evidence remain
excluded from public delivery.

## Remaining integration

The existing observer binary/deployment remains unchanged. A separate
write-capable, authorized node transport and regional broker must retain file
custody across challenge delivery and the issuer response. The protected image
and Pod recipe must independently prove no DAC-bypass capability or later
privilege escalation; CRI initial UID/GID cannot establish that. Node
administrators remain trusted. The guard, rather than this opaque publication
primitive, verifies the actual permit signature and finite boot window.

All-container issuer recipes, renewal, admission wiring and live CNPG
qualification remain v1 requirements. This work does not claim runtime budget
enforcement or reopen managed admission.
