-- PostgreSQL pool Pods are single-use inventory; D1, not labels, owns the singleton volume holder.
CREATE TABLE node_postgres_pool_policies (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  release_id TEXT NOT NULL REFERENCES fleet_releases(id),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE pool_pods (
  pod_uid TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL, boot_id TEXT NOT NULL, policy_revision INTEGER NOT NULL CHECK(policy_revision>0),
  qualification_run_id TEXT, qualification_scope_sha256 TEXT CHECK(qualification_scope_sha256 IS NULL OR length(qualification_scope_sha256)=64),
  idle_cpu_millicores INTEGER NOT NULL DEFAULT 0 CHECK(idle_cpu_millicores>=0),
  idle_memory_mib INTEGER NOT NULL DEFAULT 0 CHECK(idle_memory_mib>=0),
  attestation_json TEXT NOT NULL CHECK(json_valid(attestation_json)),
  state TEXT NOT NULL CHECK(state IN('ready','claimed','retired','lost')), binding_id TEXT UNIQUE,
  first_observed_at INTEGER NOT NULL CHECK(first_observed_at>=0), last_observed_at INTEGER NOT NULL CHECK(last_observed_at>=first_observed_at)
) STRICT;
CREATE INDEX pool_pods_ready_idx ON pool_pods(node_id,state,policy_revision,last_observed_at);
CREATE TABLE pool_preparation_contexts (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  node_uid TEXT NOT NULL,boot_id TEXT NOT NULL,context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  observed_at INTEGER NOT NULL CHECK(observed_at>=0),expires_at INTEGER NOT NULL CHECK(expires_at>observed_at)
) STRICT;
CREATE TABLE pool_bindings (
  id TEXT PRIMARY KEY, database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, node_uid TEXT NOT NULL, boot_id TEXT NOT NULL,
  pool_pod_uid TEXT NOT NULL UNIQUE REFERENCES pool_pods(pod_uid),
  generation INTEGER NOT NULL CHECK(generation>0), route_revision INTEGER NOT NULL CHECK(route_revision>0),
  admission_epoch INTEGER NOT NULL CHECK(admission_epoch>0), holder_revision INTEGER NOT NULL CHECK(holder_revision>0),
  scope_sha256 TEXT NOT NULL CHECK(length(scope_sha256)=64), scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  state TEXT NOT NULL CHECK(state IN('claimed','mounted','serving','detaching','failed','released','refused','lost')),
  node_report_json TEXT CHECK(node_report_json IS NULL OR json_valid(node_report_json)),
  controller_report_json TEXT CHECK(controller_report_json IS NULL OR json_valid(controller_report_json)),
  supervisor_report_json TEXT CHECK(supervisor_report_json IS NULL OR json_valid(supervisor_report_json)),
  mounted_at INTEGER CHECK(mounted_at IS NULL OR mounted_at>=0),
  served_at INTEGER CHECK(served_at IS NULL OR served_at>=0),
  detaching_at INTEGER CHECK(detaching_at IS NULL OR detaching_at>=0),
  created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
) STRICT;
CREATE UNIQUE INDEX pool_bindings_single_holder_idx ON pool_bindings(database_id) WHERE state NOT IN('released','refused');
CREATE TABLE database_runtime_holders (
  database_id TEXT PRIMARY KEY REFERENCES databases(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('cnpg','pool')), revision INTEGER NOT NULL CHECK(revision>0),
  binding_id TEXT REFERENCES pool_bindings(id),
  state TEXT NOT NULL CHECK(state IN('active','claimed','mounted','serving','detaching','failed','released','refused','lost')),
  clean_stop INTEGER CHECK(clean_stop IN(0,1)), sleep_json TEXT CHECK(sleep_json IS NULL OR json_valid(sleep_json)),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0), CHECK(kind='pool' OR binding_id IS NULL)
) STRICT;
CREATE TABLE pool_storage_observations (
  database_id TEXT PRIMARY KEY REFERENCES databases(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  observation_json TEXT NOT NULL CHECK(json_valid(observation_json)), observed_at INTEGER NOT NULL CHECK(observed_at>=0)
) STRICT;
CREATE TABLE pool_io_attestations (
  binding_id TEXT PRIMARY KEY REFERENCES pool_bindings(id) ON DELETE CASCADE,
  attestation_json TEXT NOT NULL CHECK(json_valid(attestation_json)), observed_at INTEGER NOT NULL CHECK(observed_at>=0)
) STRICT;
CREATE TABLE pool_cleanup_grants (
  binding_id TEXT NOT NULL REFERENCES pool_bindings(id) ON DELETE CASCADE,
  -- Deferred role operations live in pool_role_mutations; issuer atomically checks that exact union.
  operation_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL CHECK(authority_revision>0),
  claims_json TEXT NOT NULL CHECK(json_valid(claims_json)),
  authority_token TEXT CHECK(authority_token IS NULL OR substr(authority_token,1,4)='pc1.'),
  issued_at INTEGER NOT NULL CHECK(issued_at>=0), expires_at INTEGER NOT NULL CHECK(expires_at>issued_at),
  maximum_write_bytes INTEGER NOT NULL CHECK(maximum_write_bytes>0),
  headroom_authority_revision INTEGER NOT NULL CHECK(headroom_authority_revision>0),
  headroom_snapshot_sha256 TEXT NOT NULL CHECK(length(headroom_snapshot_sha256)=64),
  state TEXT NOT NULL CHECK(state IN('reserved','issued','failed','completed')),
  created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  PRIMARY KEY(binding_id,operation_id), UNIQUE(binding_id,authority_revision),
  CHECK(json_extract(claims_json,'$.binding_id')=binding_id AND json_extract(claims_json,'$.operation_id')=operation_id
    AND json_extract(claims_json,'$.authority_revision')=authority_revision AND json_extract(claims_json,'$.iat')=issued_at
    AND json_extract(claims_json,'$.exp')=expires_at AND json_extract(claims_json,'$.maximum_write_bytes')=maximum_write_bytes),
  CHECK(state<>'issued' OR authority_token IS NOT NULL)
) STRICT;
CREATE TABLE pool_cleanup_io_attestations (
  binding_id TEXT NOT NULL REFERENCES pool_bindings(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  attestation_json TEXT NOT NULL CHECK(json_valid(attestation_json)),
  observed_at INTEGER NOT NULL CHECK(observed_at>=0),
  PRIMARY KEY(binding_id,operation_id)
) STRICT;
CREATE UNIQUE INDEX pool_cleanup_active_binding ON pool_cleanup_grants(binding_id) WHERE state<>'completed';
CREATE TRIGGER pool_cleanup_grants_immutable BEFORE UPDATE ON pool_cleanup_grants WHEN
  NEW.binding_id IS NOT OLD.binding_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.authority_revision IS NOT OLD.authority_revision
  OR NEW.claims_json IS NOT OLD.claims_json OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.maximum_write_bytes IS NOT OLD.maximum_write_bytes OR NEW.headroom_authority_revision IS NOT OLD.headroom_authority_revision
  OR NEW.headroom_snapshot_sha256 IS NOT OLD.headroom_snapshot_sha256 OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.authority_token IS NOT NULL AND NEW.authority_token IS NOT OLD.authority_token)
  OR (OLD.state='completed' AND NEW.state<>'completed')
BEGIN SELECT RAISE(ABORT,'Pool cleanup grant cannot renew or erase its budget'); END;
CREATE TABLE pool_claim_attempts (
  id TEXT PRIMARY KEY, database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation>0), mutation_id TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK(outcome IN('hit','miss','blocked')), reason TEXT,
  binding_id TEXT REFERENCES pool_bindings(id), created_at INTEGER NOT NULL CHECK(created_at>=0)
) STRICT;
CREATE TABLE postgres_pool_qualification_receipts (
  receipt_sha256 TEXT PRIMARY KEY CHECK(length(receipt_sha256)=64), run_id TEXT NOT NULL UNIQUE, scope_sha256 TEXT NOT NULL CHECK(length(scope_sha256)=64), evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  candidate_release_id TEXT NOT NULL REFERENCES fleet_releases(id), candidate_spec_sha256 TEXT NOT NULL CHECK(length(candidate_spec_sha256)=64),
  driver_image TEXT NOT NULL, driver_sha256 TEXT NOT NULL CHECK(length(driver_sha256)=64),
  supervisor_sha256 TEXT NOT NULL CHECK(length(supervisor_sha256)=64), postgres_image_sha256 TEXT NOT NULL CHECK(length(postgres_image_sha256)=64),
  host_controller_sha256 TEXT NOT NULL CHECK(length(host_controller_sha256)=64),
  archiver_image_sha256 TEXT NOT NULL CHECK(length(archiver_image_sha256)=64), qualified_at TEXT NOT NULL,
  qualification_json TEXT NOT NULL CHECK(json_valid(qualification_json)), evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json))
) STRICT;
CREATE TRIGGER pool_bindings_scope_immutable BEFORE UPDATE ON pool_bindings WHEN
  NEW.id IS NOT OLD.id OR NEW.database_id IS NOT OLD.database_id OR NEW.node_id IS NOT OLD.node_id OR NEW.node_uid IS NOT OLD.node_uid
  OR NEW.boot_id IS NOT OLD.boot_id OR NEW.pool_pod_uid IS NOT OLD.pool_pod_uid OR NEW.generation IS NOT OLD.generation
  OR NEW.route_revision IS NOT OLD.route_revision OR NEW.admission_epoch IS NOT OLD.admission_epoch OR NEW.holder_revision IS NOT OLD.holder_revision
  OR NEW.scope_sha256 IS NOT OLD.scope_sha256 OR NEW.scope_json IS NOT OLD.scope_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'Pool binding scope is immutable'); END;
CREATE TRIGGER pool_bindings_history_immutable BEFORE UPDATE ON pool_bindings WHEN
  (OLD.mounted_at IS NOT NULL AND NEW.mounted_at IS NOT OLD.mounted_at)
  OR (OLD.served_at IS NOT NULL AND NEW.served_at IS NOT OLD.served_at)
  OR (OLD.detaching_at IS NOT NULL AND NEW.detaching_at IS NOT OLD.detaching_at)
BEGIN SELECT RAISE(ABORT,'Pool holder history is immutable'); END;
CREATE TRIGGER pool_bindings_forward_state BEFORE UPDATE OF state ON pool_bindings WHEN NEW.state<>OLD.state AND NOT(
  (OLD.state='claimed' AND NEW.state IN('mounted','detaching','failed','refused','lost'))
  OR (OLD.state='mounted' AND NEW.state IN('serving','detaching','failed','released','lost'))
  OR (OLD.state='serving' AND NEW.state IN('detaching','failed','lost'))
  OR (OLD.state='detaching' AND NEW.state IN('released','refused','failed','lost'))
  OR (OLD.state='failed' AND NEW.state IN('released','lost')) OR (OLD.state='lost' AND NEW.state IN('released','refused')))
BEGIN SELECT RAISE(ABORT,'Pool binding state cannot move backwards'); END;
CREATE TRIGGER pool_pods_single_use BEFORE UPDATE ON pool_pods WHEN
  NEW.pod_uid IS NOT OLD.pod_uid OR NEW.node_id IS NOT OLD.node_id OR NEW.node_uid IS NOT OLD.node_uid OR NEW.boot_id IS NOT OLD.boot_id
  OR NEW.first_observed_at IS NOT OLD.first_observed_at OR NEW.policy_revision IS NOT OLD.policy_revision
  OR NEW.qualification_run_id IS NOT OLD.qualification_run_id OR NEW.qualification_scope_sha256 IS NOT OLD.qualification_scope_sha256
  OR NEW.idle_cpu_millicores IS NOT OLD.idle_cpu_millicores OR NEW.idle_memory_mib IS NOT OLD.idle_memory_mib
  OR (OLD.binding_id IS NOT NULL AND NEW.binding_id IS NOT OLD.binding_id)
  OR (OLD.state<>'ready' AND NEW.state='ready')
BEGIN SELECT RAISE(ABORT,'Pool Pod cannot be reused'); END;
CREATE TRIGGER pool_qualification_receipts_immutable BEFORE UPDATE ON postgres_pool_qualification_receipts
BEGIN SELECT RAISE(ABORT,'Pool qualification receipt is immutable'); END;
