// SPDX-License-Identifier: Apache-2.0
import { parseAllDocuments, stringify } from "yaml";
import { NodeHostConfigurationPrivate } from "@pgcf/contracts/node-host-configuration";
import { BootstrapError, canonical, digest, jsonRecords } from "./bootstrap.ts";
import { patchObject as object } from "./fleet-patch-observations.ts";
type Json = Record<string, unknown>;
export interface HostConfigurationCommands {
  talos(args: string[], stdin?: string): Promise<string>;
}
export function machineConfigurationDocuments(raw: string, id: string) {
  const rows = jsonRecords(raw);
  if (rows.length !== 1)
    throw new BootstrapError("patch_host_configuration_resource_invalid");
  const resource = rows[0]!;
  if (
    object(resource.metadata).type !== "MachineConfigs.config.talos.dev" ||
    object(resource.metadata).id !== id ||
    typeof resource.spec !== "string"
  )
    throw new BootstrapError("patch_host_configuration_resource_invalid");
  const docs = parseAllDocuments(resource.spec);
  if (!docs.length || docs.some((doc) => doc.errors.length))
    throw new BootstrapError("patch_host_configuration_resource_invalid");
  const values = docs.map((doc) => object(doc.toJSON()));
  const roots = values.filter(
    (value) => value.version === "v1alpha1" && value.machine,
  );
  if (roots.length !== 1)
    throw new BootstrapError("patch_host_configuration_resource_invalid");
  return { values, machine: object(roots[0]!.machine) };
}
function files(machine: Json): Json[] {
  if (machine.files !== undefined && !Array.isArray(machine.files))
    throw new BootstrapError("patch_host_configuration_resource_invalid");
  const values = (machine.files ?? []) as unknown[];
  const rows = values.map(object);
  if (
    rows.some((value) => typeof value.path !== "string") ||
    new Set(rows.map((value) => value.path)).size !== rows.length
  )
    throw new BootstrapError("patch_host_configuration_duplicate_path");
  return rows;
}
export function hostConfigurationMatches(
  raw: string,
  id: string,
  input: NodeHostConfigurationPrivate,
) {
  const actual = files(machineConfigurationDocuments(raw, id).machine);
  return input.files.every((expected) => {
    const found = actual.find((value) => value.path === expected.path);
    return (
      found?.content === expected.content &&
      found.permissions === expected.permissions &&
      found.op === "create"
    );
  });
}
export function mergeHostConfiguration(
  raw: string,
  input: NodeHostConfigurationPrivate,
  requireThinPool = false,
) {
  const parsed = machineConfigurationDocuments(raw, "v1alpha1"),
    current = files(parsed.machine),
    paths = new Set(input.files.map((file) => file.path));
  parsed.machine.files = [
    ...current.filter(
      (file) =>
        !paths.has(String(file.path) as (typeof input.files)[number]["path"]),
    ),
    // Talos WriteUserFiles permits create for new or existing /var files.
    // overwrite requires an existing file and blocks boot before system services otherwise.
    ...input.files.map((file) => ({ ...file, op: "create" })),
  ];
  if (requireThinPool) {
    const modules = parsed.values.filter(
      (value) =>
        value.kind === "KernelModuleConfig" && value.name === "dm_thin_pool",
    );
    if (
      modules.length > 1 ||
      (modules.length === 1 && modules[0]!.apiVersion !== "v1alpha1")
    )
      throw new BootstrapError("patch_host_configuration_resource_invalid");
    if (!modules.length)
      parsed.values.push({
        apiVersion: "v1alpha1",
        kind: "KernelModuleConfig",
        name: "dm_thin_pool",
      });
  }
  return parsed.values.map((value) => stringify(value)).join("---\n");
}
export async function readMachineConfiguration(
  commands: HostConfigurationCommands,
  boot?: {
    boot_id: string;
    configuration_boot_id: string;
    configuration_sha256?: string;
  },
) {
  const resources = jsonRecords(
    await commands.talos(["get", "machineconfig", "--output=json"]),
  );
  const selected = (id: string) =>
    resources.filter((value) => object(value.metadata).id === id);
  const activeRows = selected("v1alpha1"),
    persistentRows = selected("persistent");
  if (activeRows.length !== 1 || persistentRows.length > 1)
    throw new BootstrapError("patch_host_configuration_resource_invalid");
  const active = JSON.stringify(activeRows[0]),
    persistent = persistentRows[0]
      ? JSON.stringify(persistentRows[0])
      : undefined,
    a = machineConfigurationDocuments(active, "v1alpha1"),
    sha256 = digest(canonical(a.values));
  if (
    persistent &&
    canonical(a.values) !==
      canonical(machineConfigurationDocuments(persistent, "persistent").values)
  )
    throw new BootstrapError(
      "patch_host_configuration_active_persistent_diverged",
    );
  // Talos omits PersistentID when a boot loads its already persisted STATE configuration.
  // The caller must bind that absence to the previous proved configuration and changed boot.
  if (
    !persistent &&
    (!boot ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(boot.boot_id) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
        boot.configuration_boot_id,
      ) ||
      boot.boot_id === boot.configuration_boot_id ||
      (boot.configuration_sha256 !== undefined &&
        boot.configuration_sha256 !== sha256))
  )
    throw new BootstrapError("patch_host_configuration_persistence_unproved");
  return {
    active,
    persistent,
    sha256,
    ...(!persistent && boot
      ? {
          state_loaded: {
            boot_id: boot.boot_id,
            configuration_boot_id: boot.configuration_boot_id,
            configuration_sha256: sha256,
          },
        }
      : {}),
  };
}
export async function readHostConfiguration(
  commands: HostConfigurationCommands,
  input: NodeHostConfigurationPrivate,
  configuration?: Awaited<ReturnType<typeof readMachineConfiguration>>,
  requireThinPool = false,
  boot?: Parameters<typeof readMachineConfiguration>[1],
) {
  const value =
    configuration ?? (await readMachineConfiguration(commands, boot));
  const moduleConfigured = (raw: string, id: string) => {
    const modules = machineConfigurationDocuments(raw, id).values.filter(
      (value) =>
        value.kind === "KernelModuleConfig" && value.name === "dm_thin_pool",
    );
    return modules.length === 1 && modules[0]!.apiVersion === "v1alpha1";
  };
  const moduleLoaded =
    !requireThinPool ||
    /^dm_thin_pool\s/m.test(await commands.talos(["read", "/proc/modules"]));
  const configured =
    (!requireThinPool ||
      (moduleConfigured(value.active, "v1alpha1") &&
        (value.persistent
          ? moduleConfigured(value.persistent, "persistent")
          : !!value.state_loaded))) &&
    hostConfigurationMatches(value.active, "v1alpha1", input) &&
    (value.persistent
      ? hostConfigurationMatches(value.persistent, "persistent", input)
      : !!value.state_loaded);
  return {
    ...value,
    thin_pool_required: requireThinPool,
    configured,
    matches: moduleLoaded && configured,
  };
}
/** Supported ApplyConfiguration has no revision CAS. The serialized assignment plus fresh full-config equality precedes its single attempt. */
export async function applyHostConfiguration(
  commands: HostConfigurationCommands,
  input: NodeHostConfigurationPrivate,
  expected: Awaited<ReturnType<typeof readHostConfiguration>>,
) {
  const latest = await readHostConfiguration(
    commands,
    input,
    undefined,
    expected.thin_pool_required,
    expected.state_loaded,
  );
  if (latest.sha256 !== expected.sha256)
    throw new BootstrapError("patch_host_configuration_changed_before_write");
  if (latest.configured) return;
  await commands
    .talos(
      ["apply-config", "--mode=no-reboot", "--file=-"],
      mergeHostConfiguration(latest.active, input, expected.thin_pool_required),
    )
    .catch(() => undefined);
}
