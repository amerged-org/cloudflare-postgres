-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE node_network_preparations (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES node_additions(operation_id),
  intent_hash TEXT NOT NULL CHECK(length(intent_hash)=64),
  plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND length(plan_json)<=65536),
  status TEXT NOT NULL DEFAULT 'preparing' CHECK(status IN('preparing','awaiting_proof','verified','blocked')),
  readback_at TEXT,
  proof_sha256 TEXT,
  proof_expires_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER node_network_plan_immutable BEFORE UPDATE ON node_network_preparations
WHEN NEW.operation_id<>OLD.operation_id OR NEW.intent_hash<>OLD.intent_hash OR NEW.plan_sha256<>OLD.plan_sha256 OR NEW.plan_json<>OLD.plan_json OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'node_network_plan_immutable'); END;
CREATE TABLE node_network_firewalls (
  firewall_id TEXT PRIMARY KEY NOT NULL CHECK(length(firewall_id)=36),
  operation_id TEXT NOT NULL REFERENCES node_network_preparations(operation_id),
  plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1)
);
CREATE TABLE node_network_mutations (
  operation_id TEXT NOT NULL REFERENCES node_network_preparations(operation_id),
  firewall_id TEXT NOT NULL REFERENCES node_network_firewalls(firewall_id),
  action TEXT NOT NULL CHECK(action IN('rules','assign')),
  request_id TEXT UNIQUE NOT NULL CHECK(length(request_id)=36),
  plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
  state TEXT NOT NULL CHECK(state IN('claimed','accepted','unknown','rejected','confirmed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  PRIMARY KEY(operation_id,firewall_id,action)
);
CREATE TRIGGER node_network_claim_immutable BEFORE UPDATE ON node_network_mutations
WHEN NEW.operation_id<>OLD.operation_id OR NEW.firewall_id<>OLD.firewall_id OR NEW.action<>OLD.action OR NEW.request_id<>OLD.request_id OR NEW.plan_sha256<>OLD.plan_sha256
BEGIN SELECT RAISE(ABORT,'node_network_claim_immutable'); END;
