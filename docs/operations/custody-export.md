# Sealed operator custody export

The source builders in `scripts/operations/custody-export.ts` create a temporary private
exporter and a signed operator bridge. They do not execute an export, generate or rotate a
credential, or authorize a deployment on their own. Qualify the exact pushed source through
the normal Linux CI before using them. An owning Worker can read its own secret bindings;
another Worker cannot inherit those secrets across scripts.

## Scope and custody

Keep every correct underlying credential already held in either operator environment file.
Resolve aliases, encodings and individual keyring members before selecting a rotation. Freeze
the local material baseline and recheck the current complete material union before issuance
or consumer activation. Independent correct additions stop and reclassify the operation;
explicit old-key recovery copies do not silently cancel an initially unknown rotation target.

Generate and save the RSA recipient private key and Ed25519 operator signing private key in
owner-only local custody before any remote activation. Use separate keys for these purposes.
Only their public keys enter `CustodyExportPolicy`. The policy pins account, Worker,
environment, operation UUID, original serving version UUID, binding allowlist and validity
window. A requester cannot choose another recipient or binding set.

Never put private keys, exported plaintext, transfer packets or raw API responses in command
arguments, Git, logs, CI or ordinary evidence. Capture sealed packets directly into protected
transfer custody; open them only in trusted memory. Append absent environment/version-qualified
assignments under locks and atomic writes; never reserialize an existing environment file.
Reports contain identity, scope, deployment and boolean verification receipts only.

## Provider sequence

1. Resolve the exact existing immutable Worker ID through the Workers API. Pin one serving
   version at 100%, its modules and bindings, and the latest uploaded version. Reconcile any
   concurrent deployment before proceeding.
2. Add only the generated exporter module and wrapper to the original modules. The wrapper
   re-exports the original default and named exports, including Durable Objects and Workflows.
   Do not substitute an exporter-only script.
3. Upload through the newer `/accounts/{account}/workers/workers/{id}/versions` JSON API.
   Inherit each binding explicitly from the pinned serving UUID. Legacy scripts uploads accept
   only `latest`, which is not a safe substitute for an explicitly selected version.
4. Deploy the original version at 100% and exporter at 0%. The newer version API applies a
   Durable Object migration only when its version deploys: first upload/deploy the generated
   bridge class and migration **without** its self-binding, keeping its public route disabled.
   Then identify its exact provisioned namespace by script/class, verify SQLite storage, and
   deploy the same reviewed code with `CUSTODY_COORDINATOR` bound to that namespace ID and
   `CUSTODY_TARGET` bound privately to `CustodyExportService`. Do not create and reference a
   new namespace in the same version; the provider refuses that sequence.
5. Sign the exact bytes returned by `custodyRequestBody(policy)`. POST them to
   `/custody/export` with `Content-Type: application/json` and the unpadded Base64URL
   Ed25519 signature in `x-pgcf-custody-signature`. The bridge's fetch call pins the exporter
   through `Cloudflare-Workers-Version-Overrides`; arbitrary RPC methods are not a substitute.
6. First qualify this wiring with a noncritical hosted canary. Verify the private entrypoint,
   0% override, inherited binding and decryption before selecting Production-critical material.
7. Save the sealed response privately, validate its exact policy/AAD and locally decrypt it.
   Confirm the source identity, full allowlist and complete keyrings before any rotation.
8. Restore clean ordinary traffic and eliminate the exporter as the latest uploaded version:
   delete the inactive version where supported, or upload and deploy a verified clean copy of
   the original modules/bindings. Verify latest equals serving before any secret PUT. Removing
   only the 0% deployment is insufficient because secret updates can derive from latest.
9. Remove only the owned bridge/export capability after confirmed capture and cleanup. Retain
   protected recovery material. Do not disable unrelated ingress, schedules or bindings.

## Authentication, uncertainty and recovery

The exporter verifies the signature over fixed canonical bytes before reading a request body.
Request and upstream payloads have size bounds and explicit expiry-capped deadlines. It returns
only an RSA-OAEP-SHA256/AES-256-GCM sealed packet whose AAD binds operation, account, Worker,
environment, source version, allowlist and recipient. Errors are fixed generic responses.

The coordinator persists `requested` before the upstream call and stores only the sealed
packet. Confirmed retries return the same packet. A lost response, target timeout or failed
packet save stays uncertain; it does not silently recapture. Reconcile that operation before
choosing a new transaction. Expiry prevents further use but does not replace cleanup.

Recovery is not rotation. Save a genuinely new replacement before consumer activation,
verify all selected consumers and retire only an eligible old authority. Preserve every old
reader still required by Production data or backups. Shared infrastructure may be rotated;
its Production recovery dependencies must remain readable. Short client interruption does
not justify losing protected backup keys, bytes, WAL or recovery metadata.

The source tests exercise real WebCrypto and generated core bytes. They do not replace the
hosted entrypoint/DO/version-override canary or actual consumer and restore acceptance.

## Temporary writer maintenance wrapper

`buildCustodyMaintenanceWrapperSource` is a separate, explicitly selected entrypoint fence.
It replaces default HTTP handling with a fixed 503 and rejects scheduled/queue handling.
For named RPC writers, require a complete verified list: selected exports become empty
`WorkerEntrypoint` subclasses, overriding the original star exports without inheriting their
writer methods. Unselected Durable Object and Workflow exports are preserved.

Fencing only a default export is insufficient when a service binding names a writer class.
For example, a domain-management default HTTP handler may be inert while the actual cipher
producers live in a named service. Inspect the actual bindings and all producer paths first.
Importing retained exports still evaluates the original module; verify that initialization
has no write side effects.

This wrapper does not stop requests already admitted, queued storage calls or external provider
effects. Do not infer quiescence from a finite wait or a zero-count snapshot. Deploy dual readers
first where late old-generation ciphertext can arrive, or use an independently qualified
storage-side protocol preserving late provider results. Restore exact original code and
configuration after the scoped maintenance step; an ingress fence alone is not migration proof.
