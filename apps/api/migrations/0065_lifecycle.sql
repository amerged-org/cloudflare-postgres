-- SPDX-License-Identifier: Apache-2.0
-- Contract (ULTRA plan 7.3, 7.7, 7.11, 9.4, 9.5): moves, node loss and fencing, the orders that
-- deliver them to a node, the last recovery point each node reported, the temporary R2
-- credentials a node reads, and backup retention. A fence and a superseded storage generation
-- only ever grow: nothing here lifts one, and the triggers below refuse to.
-- Timestamps are ISO-8601 UTC TEXT as Date#toISOString renders them (see 0001).

-- Orders to one node. `fence` stops everything on it, `superseded` retires one storage generation
-- of one database, `move` makes the source of a move prove its sleep and hold its wakes. A fence
-- stays on the node's page for good; the other two leave it when they end.
CREATE TABLE lifecycle_orders (
  operation TEXT PRIMARY KEY NOT NULL
    CHECK (length(operation) = 23 AND substr(operation, 1, 3) = 'op_' AND NOT substr(operation, 4) GLOB '*[^a-z0-9]*'),
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('move', 'superseded', 'fence')),
  database_id TEXT REFERENCES databases(id) ON DELETE CASCADE,
  storage_generation INTEGER CHECK (storage_generation IS NULL OR storage_generation >= 1),
  remove_volume INTEGER NOT NULL DEFAULT 0 CHECK (remove_volume IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
  closed_at TEXT CHECK (closed_at IS NULL OR (length(closed_at) = 24 AND closed_at GLOB '????-??-??T??:??:??.???Z')),
  result_status TEXT CHECK (result_status IS NULL OR result_status IN ('done', 'failed')),
  result_reason TEXT CHECK (result_reason IS NULL OR (length(result_reason) BETWEEN 1 AND 64 AND NOT result_reason GLOB '*[^a-z0-9_]*')),
  CHECK ((type = 'fence') = (database_id IS NULL)),
  CHECK ((type = 'fence') = (storage_generation IS NULL)),
  CHECK (type = 'superseded' OR remove_volume = 0),
  CHECK (type <> 'fence' OR closed_at IS NULL),
  CHECK ((result_status = 'failed') = (result_reason IS NOT NULL) OR result_status IS NULL),
  CHECK (result_status IS NOT NULL OR result_reason IS NULL)
);
CREATE INDEX lifecycle_orders_open_idx ON lifecycle_orders(node_id, created_at, operation) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX lifecycle_orders_fence_idx ON lifecycle_orders(node_id) WHERE type = 'fence';
CREATE INDEX lifecycle_orders_superseded_idx ON lifecycle_orders(database_id, node_id) WHERE type = 'superseded';
-- An order never reopens, never changes what it orders and never takes back a volume removal.
CREATE TRIGGER lifecycle_orders_monotonic BEFORE UPDATE ON lifecycle_orders
WHEN NEW.operation <> OLD.operation OR NEW.node_id <> OLD.node_id OR NEW.type <> OLD.type
  OR NEW.database_id IS NOT OLD.database_id OR NEW.storage_generation IS NOT OLD.storage_generation
  OR NEW.created_at <> OLD.created_at OR NEW.remove_volume < OLD.remove_volume
  OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS NOT OLD.closed_at)
BEGIN SELECT RAISE(ABORT, 'lifecycle_order_immutable'); END;

-- One move of a database to another node (or to another volume of the same node) under the same
-- ID. `proving`: the source proves its sleep. `restoring`: D1 staged the next storage generation
-- here and the target restores; the database row still says the source. `done`: the target is ready
-- with a DONE base backup and the row says the target. `failed`: see `failure`; the row is unchanged.
CREATE TABLE database_moves (
  operation TEXT PRIMARY KEY NOT NULL
    CHECK (length(operation) = 23 AND substr(operation, 1, 3) = 'op_' AND NOT substr(operation, 4) GLOB '*[^a-z0-9]*'),
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  region_id TEXT NOT NULL REFERENCES regions(id),
  source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source_storage_generation INTEGER NOT NULL CHECK (source_storage_generation >= 1),
  source_archive_path TEXT NOT NULL CHECK (length(source_archive_path) <= 512),
  status TEXT NOT NULL CHECK (status IN ('proving', 'restoring', 'done', 'failed')),
  -- The source reported its `move` order done: the sleep is proven and wakes are held.
  source_acknowledged_at TEXT,
  -- Set when the generation is bumped.
  target_generation INTEGER CHECK (target_generation IS NULL OR target_generation >= 2),
  target_storage_generation INTEGER CHECK (target_storage_generation IS NULL OR target_storage_generation >= 2),
  target_archive_path TEXT CHECK (target_archive_path IS NULL OR length(target_archive_path) <= 512),
  backup_id TEXT CHECK (backup_id IS NULL OR length(backup_id) = 15),
  proven_sleep_json TEXT CHECK (proven_sleep_json IS NULL OR json_valid(proven_sleep_json)),
  failure TEXT CHECK (failure IS NULL OR (length(failure) BETWEEN 1 AND 64 AND NOT failure GLOB '*[^a-z0-9_]*')),
  -- The superseded source archive of a done move, and the archive a failed move's target staged,
  -- are deleted by the Worker once the recovery window has passed.
  source_archive_deleted_at TEXT,
  target_archive_deleted_at TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'),
  completed_at TEXT CHECK (completed_at IS NULL OR (length(completed_at) = 24 AND completed_at GLOB '????-??-??T??:??:??.???Z')),
  CHECK ((target_generation IS NULL) = (target_storage_generation IS NULL)),
  CHECK ((target_generation IS NULL) = (target_archive_path IS NULL)),
  CHECK ((target_generation IS NULL) = (backup_id IS NULL)),
  CHECK ((target_generation IS NULL) = (proven_sleep_json IS NULL)),
  CHECK (target_storage_generation IS NULL OR target_storage_generation > source_storage_generation),
  CHECK (status <> 'proving' OR target_generation IS NULL),
  CHECK (status NOT IN ('restoring', 'done') OR target_generation IS NOT NULL),
  CHECK ((status = 'failed') = (failure IS NOT NULL)),
  CHECK ((status IN ('proving', 'restoring')) = (completed_at IS NULL)),
  CHECK (source_archive_deleted_at IS NULL OR status = 'done'),
  CHECK (target_archive_deleted_at IS NULL OR (status = 'failed' AND target_archive_path IS NOT NULL))
);
CREATE UNIQUE INDEX database_moves_active_idx ON database_moves(database_id) WHERE status IN ('proving', 'restoring');
CREATE INDEX database_moves_database_idx ON database_moves(database_id, created_at DESC, operation DESC);
CREATE INDEX database_moves_source_node_idx ON database_moves(source_node_id) WHERE status IN ('proving', 'restoring');
CREATE INDEX database_moves_target_node_idx ON database_moves(target_node_id) WHERE status IN ('proving', 'restoring');
CREATE INDEX database_moves_archive_expiry_idx ON database_moves(completed_at) WHERE status = 'done' AND source_archive_deleted_at IS NULL;
CREATE INDEX database_moves_staged_expiry_idx ON database_moves(completed_at) WHERE status = 'failed' AND target_archive_path IS NOT NULL AND target_archive_deleted_at IS NULL;
-- A move ends once; it never goes back to an earlier phase.
CREATE TRIGGER database_moves_monotonic BEFORE UPDATE ON database_moves
WHEN NEW.operation <> OLD.operation OR NEW.database_id <> OLD.database_id OR NEW.source_node_id <> OLD.source_node_id
  OR NEW.target_node_id <> OLD.target_node_id OR NEW.source_storage_generation <> OLD.source_storage_generation
  OR NEW.source_archive_path <> OLD.source_archive_path OR NEW.created_at <> OLD.created_at
  OR (OLD.status IN ('done', 'failed') AND (NEW.status <> OLD.status OR NEW.completed_at IS NOT OLD.completed_at))
  OR (OLD.status = 'restoring' AND NEW.status = 'proving')
  OR (OLD.target_generation IS NOT NULL AND (NEW.target_generation IS NOT OLD.target_generation
    OR NEW.target_storage_generation IS NOT OLD.target_storage_generation OR NEW.target_archive_path IS NOT OLD.target_archive_path
    OR NEW.backup_id IS NOT OLD.backup_id OR NEW.proven_sleep_json IS NOT OLD.proven_sleep_json))
BEGIN SELECT RAISE(ABORT, 'database_move_immutable'); END;

-- The newest recovery state each database's node reported for its current storage generation:
-- the proven-sleep record while asleep and the newest DONE base backup. `generation` is the D1
-- generation the report answered: a proof says nothing about a generation after it, because every
-- change and every wake claim advances D1's generation.
CREATE TABLE database_recovery_points (
  database_id TEXT PRIMARY KEY NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  storage_generation INTEGER NOT NULL CHECK (storage_generation >= 1),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'asleep', 'unproven', 'error', 'deleted')),
  proven_sleep_json TEXT CHECK (proven_sleep_json IS NULL OR json_valid(proven_sleep_json)),
  backup_json TEXT CHECK (backup_json IS NULL OR json_valid(backup_json)),
  observed_at TEXT NOT NULL CHECK (length(observed_at) = 24 AND observed_at GLOB '????-??-??T??:??:??.???Z'),
  received_at TEXT NOT NULL CHECK (length(received_at) = 24 AND received_at GLOB '????-??-??T??:??:??.???Z'),
  CHECK ((state = 'asleep') = (proven_sleep_json IS NOT NULL))
);

-- A node declared lost (plan 9.4). The row restricts the node's key to the fenced scope at once.
-- Fencing then runs in this order, and the table refuses any other: the Tunnel is deleted, the
-- instance is told to stop, and its status confirms it is stopped. Only then is the node fenced.
CREATE TABLE node_losses (
  node_id TEXT PRIMARY KEY NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  region_id TEXT NOT NULL REFERENCES regions(id),
  declared_at TEXT NOT NULL CHECK (length(declared_at) = 24 AND declared_at GLOB '????-??-??T??:??:??.???Z'),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  tunnel_deleted_at TEXT,
  power_off_requested_at TEXT,
  powered_off_at TEXT,
  -- The class of the last failed step, cleared by the next success.
  fencing_error TEXT CHECK (fencing_error IS NULL OR (length(fencing_error) BETWEEN 1 AND 64 AND NOT fencing_error GLOB '*[^a-z0-9_]*')),
  CHECK (power_off_requested_at IS NULL OR tunnel_deleted_at IS NOT NULL),
  CHECK (powered_off_at IS NULL OR power_off_requested_at IS NOT NULL)
);
CREATE TRIGGER node_losses_monotonic BEFORE UPDATE ON node_losses
WHEN NEW.node_id <> OLD.node_id OR NEW.region_id <> OLD.region_id OR NEW.declared_at <> OLD.declared_at
  OR NEW.reason <> OLD.reason
  OR (OLD.tunnel_deleted_at IS NOT NULL AND NEW.tunnel_deleted_at IS NOT OLD.tunnel_deleted_at)
  OR (OLD.power_off_requested_at IS NOT NULL AND NEW.power_off_requested_at IS NOT OLD.power_off_requested_at)
  OR (OLD.powered_off_at IS NOT NULL AND NEW.powered_off_at IS NOT OLD.powered_off_at)
BEGIN SELECT RAISE(ABORT, 'node_loss_immutable'); END;
CREATE INDEX node_losses_open_idx ON node_losses(declared_at, node_id) WHERE powered_off_at IS NULL;
-- Nothing is placed on a fenced node, whoever writes the row.
CREATE TRIGGER database_not_placed_on_fenced_node_insert BEFORE INSERT ON databases
WHEN NEW.node_id IS NOT NULL AND EXISTS(SELECT 1 FROM node_losses WHERE node_id = NEW.node_id)
BEGIN SELECT RAISE(ABORT, 'node_fenced'); END;
CREATE TRIGGER database_not_placed_on_fenced_node BEFORE UPDATE OF node_id ON databases
WHEN NEW.node_id IS NOT NULL AND NEW.node_id IS NOT OLD.node_id
  AND EXISTS(SELECT 1 FROM node_losses WHERE node_id = NEW.node_id)
BEGIN SELECT RAISE(ABORT, 'node_fenced'); END;
-- A storage generation only grows, and a node never serves one that an order has retired on it.
CREATE TRIGGER database_storage_generation_monotonic BEFORE UPDATE OF storage_generation ON databases
WHEN NEW.storage_generation < OLD.storage_generation
BEGIN SELECT RAISE(ABORT, 'storage_generation_monotonic'); END;
CREATE TRIGGER database_not_served_superseded BEFORE UPDATE OF node_id, storage_generation ON databases
WHEN NEW.node_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM lifecycle_orders o WHERE o.type = 'superseded' AND o.node_id = NEW.node_id
    AND o.database_id = NEW.id AND o.storage_generation >= NEW.storage_generation)
BEGIN SELECT RAISE(ABORT, 'storage_generation_superseded'); END;

-- The owner's acknowledgement that a lost node's instance may be reinstalled although a database
-- on it has no proven-sleep record, so WAL that never reached R2 is overwritten (plan 7.11).
CREATE TABLE node_reinstall_overrides (
  node_id TEXT PRIMARY KEY NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL CHECK (length(key_id) = 24 AND substr(key_id, 1, 4) = 'key_'),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  acknowledged_at TEXT NOT NULL CHECK (length(acknowledged_at) = 24 AND acknowledged_at GLOB '????-??-??T??:??:??.???Z')
);

-- The temporary R2 credentials (plan 7.3). A row says which node may read which scope until when;
-- the secret is signed from the Worker's parent key when the node reads it and is never stored.
CREATE TABLE archive_credentials (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 24 AND substr(id, 1, 4) = 'crd_' AND NOT substr(id, 5) GLOB '*[^a-z0-9]*'),
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  archive_path TEXT NOT NULL CHECK (length(archive_path) <= 512),
  access TEXT NOT NULL CHECK (access IN ('read_write', 'read_only')),
  issued_at TEXT NOT NULL CHECK (length(issued_at) = 24 AND issued_at GLOB '????-??-??T??:??:??.???Z'),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 24 AND expires_at GLOB '????-??-??T??:??:??.???Z' AND expires_at > issued_at)
);
CREATE INDEX archive_credentials_scope_idx ON archive_credentials(node_id, archive_path, access, issued_at DESC);
CREATE INDEX archive_credentials_expiry_idx ON archive_credentials(expires_at, id);

-- When the Worker last applied the recovery window to a database's current archive.
CREATE TABLE backup_retention_runs (
  database_id TEXT PRIMARY KEY NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  archive_path TEXT NOT NULL,
  checked_at TEXT NOT NULL CHECK (length(checked_at) = 24 AND checked_at GLOB '????-??-??T??:??:??.???Z'),
  backups_deleted INTEGER NOT NULL DEFAULT 0 CHECK (backups_deleted >= 0),
  objects_deleted INTEGER NOT NULL DEFAULT 0 CHECK (objects_deleted >= 0)
);
CREATE INDEX backup_retention_runs_checked_idx ON backup_retention_runs(checked_at, database_id);
