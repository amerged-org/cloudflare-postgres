# Automated private usage-journal custody v1

This lane takes consistent regional journal snapshots, preserves their accepted
receipt archive dependencies, and stores encrypted recovery custody in a private
Cloudflare R2 bucket. It does not acknowledge an outbox fact, repair attribution,
produce final usage, settle an allowance, release a hold, or activate a restored
collector. Those require their own authority and qualification.

## Complete source custody

Reuse the supervised SQLite snapshot operation and its original six-field
manifest. Bind the copied database's actual journal session, original source and
epoch, complete SQLite digest and length, and the exact manifest bytes. Do not
reopen the live journal for migration or copy its main file without committed
WAL state.

The SQLite archive checkpoint can refer to accepted receipt bundles outside the
database. Follow that digest-bound predecessor chain from the copied checkpoint,
validate every bundle and its identity, and include all dependencies. Missing,
changed, cyclic or over-limit dependencies defer custody; they do not authorize
pruning history. Remote recovery writes these files under generated local names and resolves
original predecessor references by digest. Original paths remain in the encrypted
database/bundles as evidence, never instructions to write arbitrary recovery
paths.

Persist the complete prepared local artifact before beginning transport. After
an uncertain upload or restart, finish that same artifact; do not replace it
with a new snapshot. The automatic lane has one serial writer and explicit
configuration. Disabled configuration preserves ordinary metering behavior.

## Private Cloudflare transport

The regional agent uses its existing source-bound meter credential. Cloudflare
provider tokens, R2 credentials and archive master keys never go to the regional
agent. The Worker uses an R2 binding named `USAGE_ARCHIVES` and a dedicated
`USAGE_ARCHIVE_KEYS` Secret containing active and historical AES-256 keys.

The archive descriptor contains source/epoch, session, capture time, bounded file
lengths and digests, and ordered chunk digests. It contains no arbitrary backend
URL or output path. Its canonical digest determines the artifact identity. R2
keys are derived by the Worker under an exact region/source/epoch prefix.

Upload and recovery use bounded chunks rather than buffering an entire SQLite
file in a Worker. Each artifact has a random data encryption key protected by
the dedicated master keyring. Independently authenticated encrypted chunks bind
their artifact and ordinal. Conditional R2 writes retain the original object;
uncertain responses cause observation and verification, not replacement.

Completion reads and verifies the actual stored bytes in order, checks complete
file digests and lengths, and publishes an immutable receipt. A prepared header
or some uploaded chunks are not a completed archive. Source-scoped, paginated
receipt discovery exposes completed custody only. No mutable latest pointer is
the authority for completion.

Version one accepts at most 66 files, 256 one-MiB chunks and 256 MiB in total.
The journal retains its 64-MiB bound; the manifest is at most 16 KiB and each
accepted bundle at most 8 MiB. These are explicit operating limits, not a fleet
capacity claim. A complete dependency chain must fit them; oversized custody is
deferred as a whole. The descriptor identity is SHA-256 of
`cloudflare-postgres/usage-archive/descriptor/v1`, a NUL byte and canonical JSON
with recursively sorted object keys and preserved array order.

The Worker verifies the exact original meter token, region, source and current
epoch using fresh primary reads before accepting work and before reporting
success after asynchronous storage or cryptographic work. Revocation cannot
turn a substituted actor into the original upload's authority.

## Inactive recovery and key retention

Recovery requires installation authority, the original source/epoch and an
independently retained receipt digest. Old epochs remain recoverable without
giving them permission to upload new custody. Meter credentials cannot download
raw journal content. Private R2 objects are never exposed through public URLs.

Download into an exclusively created private inactive directory. Verify every
downloaded chunk/file, the original manifest and complete dependency closure,
then run the independent existing SQLite custody verifier. A local manifest
digest alone does not establish provenance. No collector is activated and no
usage is replayed by this recovery lane.

Encrypted control recovery bundles accept the optional `USAGE_ARCHIVE_KEYS`
keyring and preserve every retained version in the private restored key file.
Old two-keyring bundles remain readable. Before enabling remote custody, retain
the archive ring off-node inside an encrypted bundle protected by an independent
recovery key. Preserve the installation/account/bucket selection and receipt
digests independently too. Losing all retained archive keys makes the encrypted
R2 bytes unusable.

## Regional configuration and operator recovery

Set `PGCF_USAGE_ARCHIVE_CONFIG_FILE` to an owner-only JSON configuration file
only after the private Worker binding, master ring and independent key custody
are ready. Omission leaves this lane disabled. The archive directory and each
allowed accepted-bundle root must already exist privately. Source archive paths
must remain within those explicitly configured roots.

```json
{
  "version": 1,
  "directory": "/absolute/private/usage-custody",
  "acceptedArchiveRoots": ["/absolute/private/accepted-custody"],
  "intervalMilliseconds": 900000,
  "costAttribution": "installation"
}
```

The interval is 60,000 through 86,400,000 milliseconds. Serial cycles have a
540-second deadline including snapshot copying and transport; ordinary HTTP
operations have a 20-second bound, while finalization may use up to 240 seconds
for ordered full-file verification. Deferred transport keeps its pending artifact
for the next scheduled cycle. Archive storage/traffic is an installation cost;
this lane does not silently add a tenant meter or debit resource-time funding.

Run the trusted regional package with `recover-usage-archive --config` and an
owner-only configuration containing `version: 1`, `origin`, `regionId`,
`sourceId`, `sourceEpoch`, `descriptorId`, `expectedReceiptSha256`,
`installerTokenFile`, and `targetDirectory`. The HTTPS origin is an installation
choice; it cannot contain credentials, a path, a query or a fragment. The token
file belongs to the recovery operator and is not installed on the resident
metering agent. The expected receipt digest comes from independently retained
custody, rather than solely from the remote listing. Preserve the original
receipt outside the source node before relying on node-loss recovery.

An existing recovery output is never overwritten or adopted. Successful recovery
retains the original database and manifest bytes, generates safe names for
accepted dependencies, and remains explicitly inactive.

## Qualification boundary

Source tests prove the implemented transport and custody behavior against local
R2 simulation and private filesystem fixtures. Live regional scheduling,
Cloudflare binding/Secret custody, actual R2 round-trip and independent restore
need separate installation evidence. Complete journal custody does not establish
fenced node-loss activation or PostgreSQL backup/PITR. Existing held qualifiers
are not resumed by delivery of this lane.
