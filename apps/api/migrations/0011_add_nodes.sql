-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE node_region_policies (
  region_id TEXT PRIMARY KEY NOT NULL REFERENCES regions(id),
  max_nodes INTEGER NOT NULL CHECK (max_nodes BETWEEN 1 AND 10000),
  purchases_enabled INTEGER NOT NULL DEFAULT 0 CHECK (purchases_enabled IN(0,1)),
  order_config TEXT CHECK (order_config IS NULL OR (json_valid(order_config) AND length(order_config)<=2048))
);
CREATE TABLE node_additions (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id)=23 AND substr(operation_id,1,3)='op_'),
  node_id TEXT UNIQUE NOT NULL CHECK (length(node_id)=24 AND substr(node_id,1,4)='nod_'),
  region_id TEXT NOT NULL REFERENCES regions(id),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash)=64),
  intent_hash TEXT NOT NULL UNIQUE CHECK (length(intent_hash)=64),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json) AND length(intent_json)<=4096),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>=1),
  status TEXT NOT NULL CHECK (status IN('reserved','dispatching','unknown','provider_bound','audited','bootstrapping','ready','failed','cancelled')),
  slot_held INTEGER NOT NULL DEFAULT 1 CHECK (slot_held IN(0,1)),
  requested_instance_id TEXT,
  dispatch_request_id TEXT UNIQUE,
  provider_instance_id TEXT UNIQUE,
  approval_json TEXT CHECK (approval_json IS NULL OR json_valid(approval_json)),
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  audit_json TEXT CHECK (audit_json IS NULL OR json_valid(audit_json)),
  checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  network_json TEXT CHECK (network_json IS NULL OR json_valid(network_json)),
  capacity_json TEXT CHECK (capacity_json IS NULL OR json_valid(capacity_json)),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN('provider_rejected','provider_unknown','bootstrap_failed','verification_failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(region_id,request_key),
  CHECK ((slot_held=0)=(status='cancelled'))
);
CREATE INDEX node_additions_region_slots_idx ON node_additions(region_id,slot_held);
CREATE UNIQUE INDEX node_additions_requested_instance_idx ON node_additions(requested_instance_id) WHERE requested_instance_id IS NOT NULL AND slot_held=1;
CREATE TRIGGER node_addition_intent_immutable BEFORE UPDATE ON node_additions
WHEN NEW.operation_id<>OLD.operation_id OR NEW.node_id<>OLD.node_id OR NEW.region_id<>OLD.region_id OR NEW.request_key<>OLD.request_key OR NEW.request_hash<>OLD.request_hash OR NEW.intent_hash<>OLD.intent_hash OR NEW.intent_json<>OLD.intent_json OR NEW.requested_instance_id IS NOT OLD.requested_instance_id OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'node_addition_intent_immutable'); END;
