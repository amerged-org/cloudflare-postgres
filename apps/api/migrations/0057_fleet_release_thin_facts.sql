-- SPDX-License-Identifier: Apache-2.0
-- Two facts of a release that thin write authority compares, computed once when the release is
-- inserted instead of read out of its spec on every sample, lease and desired page.
--
-- thin_continuity is what a node's patch of that release cannot change without moving the guard,
-- the kernel, the boot, the driver, the volumes or a database outside Cloudflare's start admission:
-- the thin receipt's facts, the authority keys, the configuration schema, the OS block of both
-- roles, and the openebs-lvm, sandbox-controller, postgres, barman, cloudnative-pg and Talos
-- extension pins. Two releases with the same text pin the same thin facts. The release id, the spec
-- hash and the controller, gateway, API and platform pins are not part of it.
-- thin_sampling_version is the sampling protocol the release declares.
--
-- Releases stay immutable: the trigger now guards the columns the release is, and the new columns
-- are set by the insert trigger below and by the backfill of the releases that exist. To change
-- what thin_continuity holds, change the view and backfill with a later migration.
ALTER TABLE fleet_releases ADD COLUMN thin_continuity TEXT;
ALTER TABLE fleet_releases ADD COLUMN thin_sampling_version INTEGER;
CREATE VIEW fleet_release_thin_facts AS
SELECT r.id,
  json_extract(r.spec_json,'$.thin_storage_sampling_version') sampling_version,
  json_object(
    'receipt',json_object(
      'profile_sha256',json_extract(r.spec_json,'$.thin_storage_qualification.profile_sha256'),
      'driver_image',json_extract(r.spec_json,'$.thin_storage_qualification.driver_image'),
      'host_extension_image',json_extract(r.spec_json,'$.thin_storage_qualification.host_extension_image'),
      'kernel_version',json_extract(r.spec_json,'$.thin_storage_qualification.kernel_version')),
    'keys',json_extract(r.spec_json,'$.storage_authority_keys_sha256'),
    'schema',json_extract(r.spec_json,'$.configuration_schema_revision'),
    'os',json_object(
      'customer',json_object(
        'talos_version',json_extract(r.spec_json,'$.roles.customer.talos_version'),
        'talos_installer',json_extract(r.spec_json,'$.roles.customer.talos_installer'),
        'talos_schematic_sha256',json_extract(r.spec_json,'$.roles.customer.talos_schematic_sha256'),
        'talos_extensions',json_extract(r.spec_json,'$.roles.customer.talos_extensions'),
        'kubernetes_version',json_extract(r.spec_json,'$.roles.customer.kubernetes_version'),
        'kubernetes_images',json_extract(r.spec_json,'$.roles.customer.kubernetes_images'),
        'host_configuration_required',json_extract(r.spec_json,'$.roles.customer.host_configuration_required')),
      'control_relay',json_object(
        'talos_version',json_extract(r.spec_json,'$.roles.control_relay.talos_version'),
        'talos_installer',json_extract(r.spec_json,'$.roles.control_relay.talos_installer'),
        'talos_schematic_sha256',json_extract(r.spec_json,'$.roles.control_relay.talos_schematic_sha256'),
        'talos_extensions',json_extract(r.spec_json,'$.roles.control_relay.talos_extensions'),
        'kubernetes_version',json_extract(r.spec_json,'$.roles.control_relay.kubernetes_version'),
        'kubernetes_images',json_extract(r.spec_json,'$.roles.control_relay.kubernetes_images'),
        'host_configuration_required',json_extract(r.spec_json,'$.roles.control_relay.host_configuration_required'))),
    'pins',(SELECT json_group_array(json_object('n',json_extract(c.value,'$.name'),'v',json_extract(c.value,'$.version'),'r',json_extract(c.value,'$.reference'),'s',json_extract(c.value,'$.sha256')))
      FROM (SELECT value FROM json_each(r.spec_json,'$.components') ORDER BY json_extract(value,'$.name')) c
      WHERE json_extract(c.value,'$.name') IN('openebs-lvm','sandbox-controller','postgres','barman','cloudnative-pg')
        OR json_extract(c.value,'$.name') IN(SELECT value FROM json_each(r.spec_json,'$.roles.customer.talos_extensions'))
        OR json_extract(c.value,'$.name') IN(SELECT value FROM json_each(r.spec_json,'$.roles.control_relay.talos_extensions')))) continuity
FROM fleet_releases r;
DROP TRIGGER fleet_releases_immutable_update;
CREATE TRIGGER fleet_releases_immutable_update BEFORE UPDATE OF id,spec_json,spec_sha256,approved_at ON fleet_releases
BEGIN SELECT RAISE(ABORT,'Fleet releases are immutable'); END;
CREATE TRIGGER fleet_releases_thin_facts AFTER INSERT ON fleet_releases
BEGIN
  UPDATE fleet_releases SET
    thin_continuity=(SELECT v.continuity FROM fleet_release_thin_facts v WHERE v.id=NEW.id),
    thin_sampling_version=(SELECT v.sampling_version FROM fleet_release_thin_facts v WHERE v.id=NEW.id)
  WHERE id=NEW.id;
END;
UPDATE fleet_releases SET
  thin_continuity=(SELECT v.continuity FROM fleet_release_thin_facts v WHERE v.id=fleet_releases.id),
  thin_sampling_version=(SELECT v.sampling_version FROM fleet_release_thin_facts v WHERE v.id=fleet_releases.id);
