-- SPDX-License-Identifier: Apache-2.0
CREATE TABLE node_installation_profiles (
  region_id TEXT PRIMARY KEY NOT NULL REFERENCES regions(id),
  profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256)=64),
  kid TEXT NOT NULL,
  iv TEXT NOT NULL CHECK(length(iv)=16),
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(region_id,profile_sha256)
);
CREATE TRIGGER node_installation_profile_immutable BEFORE UPDATE ON node_installation_profiles
BEGIN SELECT RAISE(ABORT,'node_installation_profile_immutable'); END;
CREATE TABLE node_installation_bindings (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES node_additions(operation_id),
  node_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  provider_instance_id TEXT NOT NULL,
  profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256)=64),
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64),
  firewall_id TEXT NOT NULL CHECK(length(firewall_id)=36),
  inspection_hash TEXT NOT NULL CHECK(length(inspection_hash)=64),
  kid TEXT NOT NULL,
  iv TEXT NOT NULL CHECK(length(iv)=16),
  ciphertext TEXT NOT NULL,
  inspection_json TEXT CHECK(inspection_json IS NULL OR json_valid(inspection_json)),
  inspection_generation INTEGER NOT NULL DEFAULT 0 CHECK(inspection_generation>=0),
  created_at TEXT NOT NULL,
  FOREIGN KEY(region_id,profile_sha256) REFERENCES node_installation_profiles(region_id,profile_sha256)
);
CREATE TRIGGER node_installation_binding_immutable BEFORE UPDATE ON node_installation_bindings
WHEN NEW.operation_id<>OLD.operation_id OR NEW.node_id<>OLD.node_id OR NEW.region_id<>OLD.region_id
  OR NEW.provider_instance_id<>OLD.provider_instance_id OR NEW.profile_sha256<>OLD.profile_sha256
  OR NEW.binding_sha256<>OLD.binding_sha256 OR NEW.firewall_id<>OLD.firewall_id
  OR NEW.inspection_hash<>OLD.inspection_hash OR NEW.kid<>OLD.kid OR NEW.iv<>OLD.iv
  OR NEW.ciphertext<>OLD.ciphertext OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'node_installation_binding_immutable'); END;
CREATE INDEX node_installation_provider ON node_installation_bindings(provider_instance_id);
