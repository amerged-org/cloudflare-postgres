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

## Live Dev delivery

Before replacing the controller, the maintained SQLite backup command captured
the complete journal and its manifest. Its first invocation failed before artifact
creation because the selected target parent was not owner-private. One reviewed
harness correction selects the existing private journal parent and preserves the
original failed attempt. The corrected capture passes in 2.714 seconds; the
maintained offline verifier independently checks the 3,076,096-byte copy without
changing it. Checkpoints, retained-volume identity, coverage gaps and all 4,096
unaccepted facts are preserved. This supplies recovery custody, not permission to
acknowledge or invoice those facts.

One authenticated Talos import passes in 9.712 seconds with the exact Linux
manifest above. One UID/resource-version/full-spec-guarded Deployment patch
replaces only the controller image in 0.201 seconds. The existing Recreate
strategy and local `imagePullPolicy: Never` remain. One bounded rollout observation
passes, followed by a single 5.064-second runtime verification.

The new Ready Pod has zero restarts. All 72 compiled modules, Node 24.21.0,
UID 1000 and both enablement guards match the sealed artifact. Node identity,
boot/runtime, 28 other Running Pods and restart counters, four PVCs, five PVs,
the source CNPG Cluster, Pooler and both named SQL markers are preserved.
Configuration, service account and RBAC are unchanged. The original journal
identity and exact 4,096 queued facts remain, with zero acknowledgements. Four
compiled authenticated claim probes return null; no work is leased or dispatched.
Credential values are not printed and no Kubernetes Secret data is queried.

The controller image is now delivered in Dev. Its manual backup executor remains
disabled, the source Cluster has no plugin, and Backup, ScheduledBackup and
ObjectStore inventories remain empty. No runtime source changes, new tests or
full gate reruns accompany this delivery. The separately held source activation still needs its
one additional-attempt exception. This delivery does not resume that workflow
or establish R2 WAL, physical backup, restore, PITR or an API-managed pilot.
