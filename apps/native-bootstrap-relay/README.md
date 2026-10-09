# Native bootstrap byte relay

Rust replacement for the existing bootstrap relay. It serves the same identity,
signed TCP-source probe and binary WebSocket endpoints. Cloudflare must authorize
the current operation, node, revision, checkpoint and actual target before issuing
a short-lived grant. The relay verifies the existing Ed25519 signature, canonical
claims, issuer/target region, process epoch, fixed capability/port and single-use
nonce. It never issues grants or calls Contabo.

The relay forwards opaque bytes once. The caller retains end-to-end SSH host-key
or TLS certificate verification and current Talos/Kubernetes identity checks.
TCP failure, cancellation, expiry and memory/byte limits close the connection;
management writes are never redialed or replayed. Configuration permits only an
explicit set of target regions. There is no default region or wildcard.

Required environment names are unchanged:

- `PGCF_BOOTSTRAP_RELAY_REGION`
- `PGCF_BOOTSTRAP_RELAY_ISSUER_REGION`
- `PGCF_BOOTSTRAP_RELAY_HOST`
- `PGCF_BOOTSTRAP_RELAY_PORT`
- `PGCF_BOOTSTRAP_RELAY_PUBLIC_KEYS`
- `PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS`

Only public Ed25519 keys belong in this process. CF keeps the private signer.
Shared TypeScript contracts and limits generate `bootstrap.generated.json`;
behavior vectors execute the existing signer/verifier. The gateway's bounded
raw-frame reader accounts masked payload and fragment metadata before assembly.
The relay applies backpressure instead of buffering a second request queue.

The scratch image uses the immutable Rust builder from `versions.lock.json`,
ships a static executable and license/provenance files, and runs as UID 65532.
`--version` reports the exact source, compiler, lock and generated-contract hashes.
Local socket/conformance tests are separate from qualified-image and actual Dev
transport acceptance. Do not activate an installation template before those gates
pass.
