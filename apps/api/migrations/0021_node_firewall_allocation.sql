-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE node_firewall_allocations (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES node_additions(operation_id),
  node_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  provider_region TEXT NOT NULL,
  product_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  intent_hash TEXT NOT NULL CHECK(length(intent_hash)=64),
  inventory_revision INTEGER NOT NULL CHECK(inventory_revision>=1),
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  request_id TEXT UNIQUE NOT NULL CHECK(length(request_id)=36),
  name TEXT UNIQUE NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
  description TEXT NOT NULL CHECK(length(description)<=255),
  state TEXT NOT NULL CHECK(state IN('claimed','dispatching','accepted','unknown','rejected','confirmed','blocked')),
  firewall_id TEXT UNIQUE CHECK(firewall_id IS NULL OR length(firewall_id)=36),
  result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(result_json)<=2048)),
  failure_code TEXT CHECK(failure_code IS NULL OR length(failure_code)<=64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER node_firewall_allocation_immutable BEFORE UPDATE ON node_firewall_allocations
WHEN NEW.operation_id<>OLD.operation_id OR NEW.node_id<>OLD.node_id OR NEW.region_id<>OLD.region_id
  OR NEW.provider_instance_id<>OLD.provider_instance_id OR NEW.provider_region<>OLD.provider_region
  OR NEW.product_id<>OLD.product_id OR NEW.image_id<>OLD.image_id OR NEW.intent_hash<>OLD.intent_hash
  OR NEW.inventory_revision<>OLD.inventory_revision OR NEW.tenant_id<>OLD.tenant_id OR NEW.customer_id<>OLD.customer_id
  OR NEW.request_id<>OLD.request_id OR NEW.name<>OLD.name OR NEW.description<>OLD.description OR NEW.created_at<>OLD.created_at
  OR (OLD.firewall_id IS NOT NULL AND NEW.firewall_id IS NOT OLD.firewall_id)
  OR (OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json)
BEGIN SELECT RAISE(ABORT,'node_firewall_allocation_immutable'); END;
