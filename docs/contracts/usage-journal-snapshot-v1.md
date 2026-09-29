# Complete usage-journal custody v1

The explicit `snapshot-usage` operator command creates a consistent private
SQLite copy of an existing regional usage journal. It preserves the complete
journal, including unaccepted outbox facts, allocation checkpoints, retained
volume identities, coverage gaps, legacy acknowledgements, accepted receipts,
archive metadata and exact SQLite sequence state. The accepted-receipt archive
alone cannot preserve those unaccepted facts.

This is inactive recovery custody. It does not acknowledge, settle, retire,
reassign or repair usage, establish a customer's authority, restore Cloudflare
control state or activate the copied journal for a collector.

## Source identity and consistency

Select an explicit private existing journal and its expected
`{regionId, sourceId, sourceEpoch}`. Supported source schema is version two.
The command never constructs `UsageJournal`, whose initialization can migrate or
write. It checks private source/auxiliary files and uses a separate read-only
SQLite connection with extension loading disabled, query-only SQL and temporary
sorts in memory. A writable root filesystem or unrelated temporary directory is
not needed to read the live journal.

Reuse Node's SQLite online backup API so committed WAL state is included while
the ordinary collector remains open. Do not copy only the main database file,
open a live source as immutable, checkpoint/truncate its WAL or delete auxiliary
files to obtain a convenient copy. Read-only WAL access can update shared-memory
read marks or create required auxiliary files; source logical contents, rather
than every auxiliary byte, remain unchanged. External writes may restart copying; success
is a consistent completed snapshot, not a promised start-time freeze.

Expected identity is checked before copying and inside the completed copy. The
source path/inode identity must stay bound. Reconstruct no captured schema SQL:
the maintained SQLite backup preserves the entire database directly. Verify the
private copy's integrity, foreign keys and source metadata before publishing it.

## Bounds and private publication

The selected snapshot lane has a 64-MiB database bound and a 60-second execution
deadline. Node's backup API has no AbortSignal; a separate supervised process makes
native copying terminable. Cancellation or deadline exhaustion terminates and
waits for the same child; Promise timeout alone is not cancellation. A process
stuck in uninterruptible kernel I/O may not acknowledge termination promptly;
no publication follows until actual process closure is established. Failed or
uncertain copying publishes no verified artifact. Worker output is bounded and
never contains raw journal rows, credential values or arbitrary error bodies.

Source/configuration files are owner-only regular files, with private parents.
Temporary database files and finished outputs are mode 0600 in mode-0700
directories. Existing or aliased custody paths are refused. The target directory
is created exclusively; `usage.sqlite` is published without replacement and
`manifest.json` is flushed last as the completion marker. A crash after partial
publication can leave an incomplete private directory. Preserve and inspect it;
never treat it as completed or overwrite it to force a retry.

The manifest records the source identity, supported journal schema, byte length
and SHA-256. Both manifest/result state `activationSupported: false`. Keep the
snapshot and its independently retained receipt private and qualify off-node
custody before relying on node-loss recovery. This slice creates no Cloudflare,
S3, provider or customer credential and writes no management API state.

## Operator configuration

Run the trusted built package once with a private version-one configuration:

```sh
node apps/regional-controller/dist/main.js snapshot-usage --config /absolute/private/snapshot.json
```

```json
{
  "schemaVersion": 1,
  "sourcePath": "/absolute/private/usage.sqlite",
  "targetDirectory": "/absolute/private/new-snapshot",
  "expectedIdentity": {
    "regionId": "11111111-1111-4111-8111-111111111111",
    "sourceId": "22222222-2222-4222-8222-222222222222",
    "sourceEpoch": 1
  }
}
```

The result contains status, digest, byte length and pending count; identity and
paths stay in private operator custody. A failure reports only
`usage_snapshot_failed`. Credentials and environment files are not loaded.

A 404 delivery refusal can mean missing/mismatched environment authority or an
incorrect meter region. Establish the exact current token/source/environment
relationship and original resource provenance before deciding how to recover.
Never create a fake customer environment, rewrite a fact's identity, weakly
acknowledge, auto-delete or skip it merely because delivery failed. An intact
snapshot supplies custody evidence, not permission to resume or invoice.

## Offline custody verification

`verify-usage-snapshot` verifies a recovered completed snapshot against an
independently retained receipt. It does not create or activate a journal.
Select a private, quiescent directory containing the unmodified `usage.sqlite`
and `manifest.json`, the expected source identity and the database SHA-256
from independent custody. A digest obtained solely from the recovered manifest
does not establish provenance. The completed manifest keeps its existing exact
six-field schema version two; operator configuration uses version one.

```sh
node apps/regional-controller/dist/main.js verify-usage-snapshot --config /absolute/private/verify.json
```

```json
{
  "schemaVersion": 1,
  "snapshotDirectory": "/absolute/private/recovered-snapshot",
  "expectedIdentity": {
    "regionId": "11111111-1111-4111-8111-111111111111",
    "sourceId": "22222222-2222-4222-8222-222222222222",
    "sourceEpoch": 1
  },
  "expectedSha256": "<independently-retained-64-character-lowercase-sha256>"
}
```

The reader requires owner-only regular files with no symlink/hardlink aliases,
no `-wal`, `-shm` or `-journal` siblings and a finished SQLite DELETE-mode header.
It verifies the exact manifest, source identity, byte length, independent digest,
pending count, database integrity and foreign keys. The existing supervised
child preserves the 64-MiB/60-second bounds and redacts native failures. Results
contain only `status: "verified_snapshot_custody"`, digest, bytes, pending count
and `activationSupported: false`. Failure returns
`usage_snapshot_verification_failed`; paths and journal rows are not printed.

Only the closed artifact is opened using an encoded string URI with
`mode=ro&immutable=1`, a read-only connection, disabled extensions, untrusted
schema, query-only SQL and memory-only temporary storage. No journal-mode
change, checkpoint, auxiliary cleanup, permission change or `UsageJournal`
initialization occurs. Held file handles, directory/path identity, metadata and
before/after hashes detect observed replacement or modification.

SQLite immutable access deliberately disables locking and change detection.
The artifact must remain quiescent and owner-controlled throughout verification;
these checks do not protect against hostile transient mutation by the same
owner. This mode must never open a live journal. Passing verification does not
authorize replay, settlement, evidence deletion, source reassignment or customer
admission, and does not establish complete node-loss recovery.

The pinned [Node SQLite implementation](https://github.com/nodejs/node/blob/v24.6.0/src/node_sqlite.cc#L658)
enables SQLite URI filenames; pass the encoded URI as a string to retain its
parameters. See [SQLite URI immutable semantics](https://www.sqlite.org/uri.html).

Sources: [Node SQLite backup](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsource-db-path-options),
[SQLite online backup](https://www.sqlite.org/backup.html),
[read-only WAL](https://www.sqlite.org/wal.html#read_only_databases).
