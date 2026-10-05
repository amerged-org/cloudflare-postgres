# Operator recovery

The operator deployment uses local PostgreSQL volumes and R2 archives. Loss of a VPS is recovered
from R2; the last recoverable commit depends on the WAL that actually reached R2. There is no
synchronous replica or zero-loss promise. Record both recovery duration and the last restored
commit in `PLAN.md` after each real drill.

## Restore or PITR

1. Check `/v1/operational-health?scope=databases` and the source's archive summary. Missing
   observations are unknown. A completed base backup and continuous archived WAL are required.
2. Submit `POST /v1/databases/{source-id}/restore` with a persistent `Idempotency-Key` and either
   `{"mode":"full","name":"recovered"}` or
   `{"mode":"pitr","name":"recovered","target_time":"<UTC timestamp>"}`.
3. Save the returned target ID and operation ID. Repeating the same request and key returns the
   same target; a transport failure does not justify issuing a new key or replaying SQL writes.
4. Poll the operation. The source stays unchanged. The target uses new storage and its own
   archive path; its configuration revision is independent of its storage generation.
5. Ready requires recovery promotion, SQL database-name mapping, actual role/settings and volume
   checks, and removal of the temporary restore administrator. Authenticate to the target over
   the normal endpoint and compare the required tables, roles, sequences and committed markers.
6. Switch the adopter's connection only after these checks. Once writes reach the target, do not
   switch back to an older source without reconciling those writes.

A deleted source can be restored within its configured retention window. Keep its encrypted
credentials and the corresponding `CREDENTIAL_KEYS` key IDs until that window ends. Expired
archive cleanup is bounded and uses only the exact owned prefix; do not modify archive timestamps
to simulate expiration.

The v1 catalog is limited to 16 pages, 16,000 objects, 64 backup metadata files and 64 KiB per
metadata file. A newer WAL timeline needs a completed base backup on that timeline. Unsupported,
missing or ambiguous coverage is refused rather than creating an empty database.

## Lost node

1. Read `/v1/operational-health?scope=nodes` and verify the actual node UID. A stale heartbeat
   excludes placement after 180 seconds; it does not automatically authorize a replacement order.
2. Submit `POST /v1/nodes/{id}/mark-lost` with
   `{"expected_node_uid":"<verified UID>","reason":"<short incident description>"}`.
   Loss is terminal and repeated calls preserve the original record. Metadata, archives and
   historical provider receipts remain available. Heartbeats cannot make the node healthy again.
3. Restore affected databases onto available healthy capacity using the restore procedure.
   A missing namespace for an established database must report recovery required.
4. Keep the lost server isolated until recovery and data comparison finish. Ordinary adoption
   of the same historical provider instance remains refused; in-place reinstall requires an
   explicitly verified recovery procedure. Do not erase historical identity to bypass that guard.

## Control plane and regional infrastructure

Keep a D1 export, the deployment source and immutable image digests, private Worker binding
configuration, Worker secret values, regional agent credentials, routing keyrings and encrypted
Talos/join custody together in an encrypted operator backup. Cloudflare cannot return previously
issued secret values. Keep the decryption key outside the repository and an independent copy
outside the machine that created it.

After control loss, restore the export into a separate D1 database, check SQLite integrity and
foreign keys, and verify region/node/credential identity before switching Worker bindings.
Restore secret values without replacing the retained agent identity. Reapply the reviewed
Cloudflare and regional configuration using immutable images. Rebuild platform resources only
on verified replacement infrastructure; recover PostgreSQL through R2 into separate targets.
An etcd snapshot helps recover Kubernetes configuration, but it does not recreate lost local
PostgreSQL volumes. Validate SQL and routing before opening traffic.

The initial D1 export/local restore rehearsal is recorded in `PLAN.md`. A complete fresh regional
loss drill and live API recovery acceptance remain required before operator product acceptance.
