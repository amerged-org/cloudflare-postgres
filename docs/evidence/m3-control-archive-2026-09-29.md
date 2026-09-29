# Remote encrypted control archive qualification

One native operator workflow qualifies a remotely stored encrypted control
recovery bundle in the existing private EU R2 bucket. This advances archive
custody beyond a local workstation copy; independently recoverable key custody
and safe production reactivation remain open.

The [prior control recovery checkpoint](m3-control-recovery-2026-09-29.md) produces
a verified 87,049-byte bundle from the actual Dev D1 snapshot. This workflow uses
that same immutable bundle and preserves all prior evidence. No new runtime
source, test case, full gate, D1 migration or Worker deployment is introduced.
The previously stopped Budget/SDK/Birth/Barman/portability flows remain unchanged.

## Actual remote and recovery evidence

Pinned Wrangler 4.142.0 uses the existing amerged Dev operator authentication,
explicit account configuration, an empty environment file and EU jurisdiction.
No new token or S3 credential is created. This does not satisfy or bypass the
separate pending confirmation for Barman's dedicated bucket-scoped credential.
No provider credential is read or installed into a customer Pod.

The existing bucket identity is verified in 1.884 seconds. Its public `r2.dev`
access is disabled and it has no custom domains. A fresh random object key under
`control-recovery/` includes the ciphertext SHA-256. The remote missing-object
read establishes absence before upload. It also creates an empty local output
file; an initial preflight incorrectly expects no file, and that failed assertion
is preserved. The empty private file remains unaccepted. No object is overwritten
and no operation is retried under a replacement key.

The single upload succeeds in 1.500 seconds. A fresh remote download succeeds in
1.447 seconds and is byte-identical to the original bundle, with exact length and
SHA-256. The object contains only the encrypted bundle; neither plaintext
snapshot/keyrings nor the recovery key are uploaded. Raw CLI output, object
identity and receipts remain private.

The downloaded artifact, not the local source archive, supplies the next restore.
Independently retained trusted migration files match all 14 recorded hashes.
Offline restoration succeeds in 0.881 seconds: 40 tables, 47 rows, exact keyrings,
valid integrity, zero foreign-key violations and private file modes are verified.
Dev contains zero encrypted credential/fence rows; the earlier local cases remain
the separate positive Worker-ciphertext evidence. The completed artifact retains
`activationSupported: false` and `recoveryFencesImplemented: false`.

The bucket's aggregate count/size readbacks still report zero after upload. An
initial count assertion is rejected and preserved; aggregate metrics are not used
as object-existence proof. The authenticated successful remote byte download is
the direct evidence. No additional upload, download or restore is made to force
an aggregate reading. Source/archive/key/negative-read artifacts remain retained.

## Limits and operating contract

Wrangler `put` does not provide an atomic write-once condition. A random owned
key and prior absence observation do not establish immutability against another
trusted writer. No bucket locks, lifecycle rules, retention or deletion settings
are changed. Retention safety and recovery-time targets remain unqualified.

The ciphertext has an off-node R2 copy. The key, receipt and trusted source copy
still depend on the operator workstation: independent key/source custody is not
qualified. No Cloudflare service is activated from recovered state; no historical
token, lease or operation is renewed or replayed. Fresh installation/bootstrap,
global fencing and external-resource reconciliation remain required.

The local environment files stay unchanged, ignored and untracked. Public docs
contain no credential values, object paths or private deployment identifiers.
There are no Kubernetes, Contabo, Worker-secret or D1 writes. PostgreSQL base
backups, WAL upload, PITR and retention remain separate M1 requirements.

Adopters can repeat the generic [archive workflow](../guides/control-archive-v1.md)
using their own existing access. Sources: [Wrangler R2 commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/),
[R2 jurisdictions](https://developers.cloudflare.com/r2/reference/data-location/).
