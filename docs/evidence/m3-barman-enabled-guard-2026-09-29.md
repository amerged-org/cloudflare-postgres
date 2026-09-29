# Explicit Barman enablement guard — 2026-09-29

The owned provisioning and manual-backup paths now require the selected
Barman WAL plugin to have `enabled: true`. Previously both desired plugin
objects omitted the field. Their deliberately partial object comparison then
accepted an extra `enabled: false` on the otherwise matching owned Cluster.
Provisioning could publish resource readiness, and the backup lane could pass
its source check before dispatch or terminal observation. This did not establish
that a fresh backup had succeeded; remote/restore verification remained false.

The fix adds one explicit field to each expected plugin object. It keeps the
generic comparison unchanged and refuses conflicting owned configuration
instead of silently reenabling it. [CNPG 1.30.1](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/api/v1/cluster_types.go)
defaults an omitted plugin `enabled` field to true, so ordinary actual admission
readback still matches. A present false value cannot satisfy the immutable
owned specification or authorize backup work.

Exactly two existing top-level Node lifecycle cases were expanded; no new case
was added. Both failed first on the previously accepted disabled plugin, then
passed after the two-line correction. Provisioning rejects with `spec_conflict`
without creating another Cluster. Manual backup rejects with
`backup_identity_changed` before dispatch/create, and refuses completed
observation after disabling the plugin. Both positive lifecycles are retained.
Independent read-only review found no material defect.

The frozen source passed format, lint, typecheck, Vitest and `test:node` exactly
once in **19.731 seconds**, retaining **33 Worker and 55 Node cases**. Unchanged
Go source retains its earlier evidence. There is no matrix growth, provider
operation or runtime qualification in this source regression.

A sealed Linux amd64 artifact was subsequently built from public source
`64c6fa8b4135e3de85153c5e7d4cc2909783bb87` in 29.758 seconds using only 81
committed Docker inputs. Its read-only, network-disabled static execution
verifies Node 24.21.0, UID 1000, both compiled guards, 72 compiled modules and
the first-party/dependency license files. OCI index
`sha256:22d19f4125724d3d9da4d03c70ce21caf80f4eb621bfb28f1f9d66859d203a2b`
and Linux manifest
`sha256:683467ae946e557c62f395f2cf525301b3a3641cf94e3959d845006785c4e43a`
are recorded. The private 88,552,960-byte archive is mode 0600. This establishes
artifact compilation and static identity, not live reconciliation or backup.

The regional image is not replaced by this checkpoint, and its manual backup
executor remains disabled. Image/runtime delivery is required before the first
API-managed pilot. The separately held manual source activation still needs its
one additional-attempt exception; this source fix does not resume that workflow
or prove R2 WAL, physical backup, restore or PITR.
