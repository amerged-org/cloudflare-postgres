-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE node_bootstrap_jobs (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES node_additions(operation_id),
  node_id TEXT NOT NULL,
  region_id TEXT NOT NULL REFERENCES regions(id),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  inventory_revision INTEGER NOT NULL CHECK(inventory_revision>0),
  sealed_revision INTEGER NOT NULL CHECK(sealed_revision>0),
  input_ciphertext TEXT NOT NULL,
  input_iv TEXT NOT NULL CHECK(length(input_iv)=16),
  input_kid TEXT NOT NULL,
  callback_hash TEXT NOT NULL CHECK(length(callback_hash)=64),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json)),
  material_ref_json TEXT CHECK(material_ref_json IS NULL OR json_valid(material_ref_json)),
  authorized INTEGER NOT NULL DEFAULT 1 CHECK(authorized IN(0,1)),
  admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted IN(0,1)),
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN(0,1)),
  rescue_active INTEGER NOT NULL DEFAULT 0 CHECK(rescue_active IN(0,1)),
  admission_authorized INTEGER NOT NULL DEFAULT 0 CHECK(admission_authorized IN(0,1)),
  admission_binding_json TEXT CHECK(admission_binding_json IS NULL OR json_valid(admission_binding_json)),
  admission_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER node_bootstrap_input_immutable BEFORE UPDATE ON node_bootstrap_jobs
WHEN NEW.operation_id<>OLD.operation_id OR NEW.node_id<>OLD.node_id OR NEW.region_id<>OLD.region_id
  OR NEW.input_hash<>OLD.input_hash OR NEW.inventory_revision<>OLD.inventory_revision
  OR NEW.input_ciphertext<>OLD.input_ciphertext OR NEW.input_iv<>OLD.input_iv OR NEW.input_kid<>OLD.input_kid
  OR NEW.sealed_revision<>OLD.sealed_revision OR NEW.callback_hash<>OLD.callback_hash OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'node_bootstrap_input_immutable'); END;
CREATE TABLE node_provider_mutations (
  operation_id TEXT NOT NULL REFERENCES node_additions(operation_id),
  mutation TEXT NOT NULL CHECK(mutation IN('rescue','restart','firewall_rules','firewall_assign')),
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
  revision INTEGER NOT NULL CHECK(revision>0),
  state TEXT NOT NULL CHECK(state IN('dispatching','unknown','accepted','rejected')),
  code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,mutation)
);

ALTER TABLE nodes ADD COLUMN node_uid TEXT;
ALTER TABLE node_region_policies ADD COLUMN autoscale_enabled INTEGER NOT NULL DEFAULT 0 CHECK(autoscale_enabled IN(0,1));
ALTER TABLE node_region_policies ADD COLUMN adopt_instance_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(adopt_instance_ids));
