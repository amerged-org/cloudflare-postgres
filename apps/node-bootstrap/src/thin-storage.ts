// SPDX-License-Identifier: Apache-2.0
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalStorageAuthorityKeys } from "@pgcf/contracts/storage-write-authority";
import {
  NodeThinStorageInput,
  NodeThinStorageReport,
  type NodeThinPoolAction,
} from "@pgcf/contracts/node-thin-storage";
import {
  NodeThinStorageAuthority,
  thinStorageClassObject,
  thinVolumeAttributesClassObject,
  thinStorageClass,
  STORAGE_PROTECTION_LEDGER_KEY,
  DatabaseId,
} from "@pgcf/contracts";
import { readHostConfiguration } from "./fleet-host-configuration.ts";
import {
  readFleetTalosExtensions,
  readFleetTalosServices,
} from "./fleet-patch-observations.ts";
import { openEbsCgroupReadback } from "../../../infra/platform/openebs-image.ts";
import sources from "../../../infra/storage/sources.lock.json" with { type: "json" };
import {
  BootstrapError,
  nativeKubeconfig,
  nativeTalosConfig,
  runCommand,
  canonical,
  type CommandResult,
} from "./bootstrap.ts";
import {
  startCapabilityProxy,
  connectRelayTransport,
} from "./proxy-command.ts";
import { NodeBootstrapTransport } from "@pgcf/contracts/node-bootstrap";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BootstrapError("thin_storage_readback_invalid");
  return value as ObjectValue;
};
const items = (value: unknown) => {
  if (!Array.isArray(value))
    throw new BootstrapError("thin_storage_inventory_invalid");
  return value.map(object);
};
const uid = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
  )
    throw new BootstrapError("thin_storage_uid_invalid");
  return value;
};
const lvmUid = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9]{6}-(?:[A-Za-z0-9]{4}-){5}[A-Za-z0-9]{6}$/.test(value)
  )
    throw new BootstrapError("thin_storage_lvm_uuid_invalid");
  return value;
};
const bytes = (value: unknown) => {
  const n =
    typeof value === "string" && /^\s*\d+(?:\.0+)?\s*$/.test(value)
      ? Number(value)
      : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    throw new BootstrapError("thin_storage_bytes_invalid");
  return n;
};
const text = (value: unknown) => {
  if (typeof value !== "string")
    throw new BootstrapError("thin_storage_text_invalid");
  return value.trim();
};
const metadata = (value: ObjectValue) => object(value.metadata);
function lvmRows(raw: string, key: string) {
  const value = object(JSON.parse(raw));
  const reports = items(value.report);
  return reports.flatMap((report) => items(report[key]));
}
function ready(value: ObjectValue) {
  return items(object(value.status).conditions).some(
    (c) => c.type === "Ready" && c.status === "True",
  );
}
/** A byte-equal settings file cannot qualify thin writes unless its actual guard trust is present. */
export function assertThinStorageHostSettings(
  input: NodeThinStorageInput,
): void {
  try {
    const settings = object(
        JSON.parse(input.host_configuration.files[0].content),
      ),
      cf = object(settings.cloudflare),
      trust = object(cf.storage_authority),
      keys = object(trust.keys);
    const legacy = DatabaseId.array()
      .max(2000)
      .parse(trust.legacy_database_ids);
    const canonicalKeys = canonicalStorageAuthorityKeys(
      keys as Record<string, string>,
    );
    if (
      input.host_configuration.status.node_uid !== input.lease.node_uid ||
      input.host_configuration.status.cluster_uid !== input.lease.cluster_uid ||
      input.host_configuration.status.release_id !== input.lease.release_id ||
      input.host_configuration.status.material_revision !==
        input.lease.material_revision ||
      createHash("sha256").update(canonicalKeys).digest("hex") !==
        trust.sha256 ||
      cf.node_id !== input.lease.node_id ||
      cf.node_uid !== input.lease.node_uid ||
      cf.region_id !== input.lease.region_id ||
      cf.material_revision !== input.lease.material_revision ||
      cf.agent_key_file !== input.host_configuration.files[1].path ||
      cf.api_url !== new URL(input.callback.url).origin ||
      new Set(legacy).size !== legacy.length ||
      input.lease.databases.some(
        (db) => db.storage !== null && legacy.includes(db.id),
      )
    )
      throw Error("changed");
  } catch {
    throw new BootstrapError("thin_storage_host_guard_unqualified");
  }
}

/** Readiness and deletion intent never prove a writer has stopped. */
export function thinWriterPods(pods: ObjectValue[]) {
  return pods.filter(
    (pod) =>
      object(metadata(pod).labels)["cnpg.io/podRole"] === "instance" &&
      !["Succeeded", "Failed"].includes(String(object(pod.status).phase)),
  );
}

export interface ThinLvmFacts {
  vg_uuid: string;
  total: number;
  free: number;
  extent: number;
  pool_uuid: string | null;
  pool_tags: string[];
  physical: NodeThinStorageAuthority["physical"];
  volumes: NodeThinStorageAuthority["physical_lvs"];
  active: string[];
  rows: ObjectValue[];
}
/** Complete native lvs -a + kernel DM inventory. Unknown segments remain visible and close writes. */
export function thinLvmFacts(
  vgs: string,
  lvs: string,
  dm: string,
): ThinLvmFacts {
  const groups = lvmRows(vgs, "vg");
  if (groups.length !== 1)
    throw new BootstrapError("thin_storage_vg_ambiguous");
  const group = groups[0]!;
  if (
    group.vg_name !== "pgcf" ||
    text(group.vg_permissions) !== "writeable" ||
    bytes(group.vg_missing_pv_count) !== 0 ||
    bytes(group.pv_count) !== 1
  )
    throw new BootstrapError("thin_storage_vg_changed");
  const vg_uuid = lvmUid(group.vg_uuid),
    total = bytes(group.vg_size),
    free = bytes(group.vg_free),
    extent = bytes(group.vg_extent_size);
  const rows = lvmRows(lvs, "lv");
  const seen = new Set<string>();
  let thick = 0;
  let pool: NodeThinStorageAuthority["physical"]["thin_pool"] = null;
  let pool_uuid: string | null = null,
    pool_tags: string[] = [];
  const volumes = rows.map((row) => {
    const name = text(row.lv_name);
    const uuid = lvmUid(row.lv_uuid);
    if (seen.has(uuid) || row.vg_uuid !== vg_uuid)
      throw new BootstrapError("thin_storage_lvs_changed");
    seen.add(uuid);
    const size = bytes(row.lv_size),
      segtype = text(row.segtype);
    if (
      segtype === "linear" &&
      text(row.pool_lv) === "" &&
      !name.startsWith("[")
    )
      thick += size;
    if (segtype === "thin-pool") {
      if (
        name !== "pgcf_thinpool" ||
        pool ||
        text(row.lv_when_full) !== "error" ||
        text(row.lv_attr)[4] !== "a"
      )
        throw new BootstrapError("thin_storage_pool_unqualified");
      pool_uuid = uuid;
      pool_tags = text(row.lv_tags).split(",").filter(Boolean);
      const dataPercent = Number(text(row.data_percent)),
        metaPercent = Number(text(row.metadata_percent)),
        meta = bytes(row.lv_metadata_size);
      if (
        !Number.isFinite(dataPercent) ||
        !Number.isFinite(metaPercent) ||
        dataPercent < 0 ||
        dataPercent > 100 ||
        metaPercent < 0 ||
        metaPercent > 100
      )
        throw new BootstrapError("thin_storage_pool_percent_invalid");
      pool = {
        name: "pgcf_thinpool",
        data_total_bytes: size,
        data_used_bytes_upper_bound: Math.min(
          size,
          Math.ceil((size * (dataPercent + 0.01)) / 100),
        ),
        metadata_total_bytes: meta,
        metadata_used_bytes_upper_bound: Math.min(
          meta,
          Math.ceil((meta * (metaPercent + 0.01)) / 100),
        ),
      };
    }
    return { name, lv_uuid: uuid, size_bytes: size, segtype };
  });
  const prefix = `LVM-${vg_uuid.replaceAll("-", "")}`;
  const active = new Set<string>();
  for (const raw of dm
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean)) {
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length);
    const lv = volumes.find((v) =>
      rest.startsWith(v.lv_uuid.replaceAll("-", "")),
    );
    if (!lv) throw new BootstrapError("thin_storage_kernel_lv_unexplained");
    active.add(lv.lv_uuid);
  }
  return {
    vg_uuid,
    total,
    free,
    extent,
    pool_uuid,
    pool_tags,
    physical: {
      volume_group_uuid: vg_uuid,
      total_bytes: total,
      free_bytes: free,
      thick_allocated_bytes: thick,
      thin_pool: pool,
    },
    volumes,
    active: [...active].sort(),
    rows,
  };
}

/** Owned deletion may outlive its Namespace/PVC. Keep the exact sealed physical LV visible;
 * resource absence is expected only for this current CF delete intent, never for a running DB. */
export function thinDeletingVolume(
  lease: NodeThinStorageInput["lease"],
  db: NodeThinStorageInput["lease"]["databases"][number],
  facts: ThinLvmFacts,
  resources: {
    namespace?: ObjectValue;
    cluster?: ObjectValue;
    storage?: ObjectValue;
    pv?: ObjectValue;
    pvc?: ObjectValue;
    lvm?: ObjectValue;
  },
): NodeThinStorageAuthority["volumes"][number] | null {
  const v = db.volume,
    policy = db.storage,
    stop = db.stop_operation;
  if (
    db.desired_state !== "deleted" ||
    !v ||
    !policy ||
    !stop ||
    stop.kind !== "database.delete" ||
    stop.generation !== db.generation
  )
    return null;
  const lv = facts.rows.find((row) => row.lv_name === v.volume_handle);
  if (!lv) return null;
  const fail = () => {
    throw new BootstrapError("thin_storage_retained_delete_identity_changed");
  };
  if (
    v.storage_generation !== db.storage_generation ||
    v.node_uid !== lease.node_uid ||
    v.volume_group_uuid !== lease.volume_group_uuid ||
    v.pool_uuid !== facts.pool_uuid ||
    policy.node_uid !== v.node_uid ||
    policy.volume_group_uuid !== v.volume_group_uuid ||
    policy.pool_uuid !== v.pool_uuid ||
    lv.lv_uuid !== v.lv_uuid ||
    lv.segtype !== "thin" ||
    lv.pool_lv !== "pgcf_thinpool"
  )
    return fail();
  for (const [resource, expected] of [
    [resources.namespace, v.namespace_uid],
    [resources.cluster, v.cluster_uid],
    [resources.storage, v.storage_uid],
  ] as const)
    if (resource && metadata(resource).uid !== expected) return fail();
  if (resources.pv) {
    const p = object(resources.pv.spec),
      claim = object(p.claimRef),
      csi = object(p.csi);
    if (
      metadata(resources.pv).uid !== v.pv_uid ||
      p.storageClassName !== policy.storage_class ||
      p.volumeAttributesClassName !== policy.volume_attributes_class ||
      claim.uid !== v.pvc_uid ||
      claim.namespace !== `pgcf-db-${db.id}` ||
      csi.driver !== "local.csi.openebs.io" ||
      csi.volumeHandle !== v.volume_handle
    )
      return fail();
  }
  if (resources.pvc) {
    const p = object(resources.pvc.spec);
    if (
      metadata(resources.pvc).uid !== v.pvc_uid ||
      p.storageClassName !== policy.storage_class ||
      p.volumeAttributesClassName !== policy.volume_attributes_class ||
      p.volumeName !== v.volume_handle
    )
      return fail();
  }
  if (resources.lvm) {
    const p = object(resources.lvm.spec);
    if (p.ownerNodeID !== lease.name || p.volGroup !== "pgcf") return fail();
  }
  return {
    database_id: db.id,
    generation: db.generation,
    storage_generation: v.storage_generation,
    storage_uid: v.storage_uid,
    namespace_uid: v.namespace_uid,
    cluster_uid: v.cluster_uid,
    volume_handle: v.volume_handle,
    lv_uuid: v.lv_uuid,
    pvc_uid: v.pvc_uid,
    pv_uid: v.pv_uid,
    storage_class: policy.storage_class,
    volume_attributes_class: policy.volume_attributes_class,
    quiesced: text(lv.lv_attr)[4] === "s",
    io: [],
  };
}

/** Only absolute bounded pool sizing; never creates a PV/VG, shrinks, repairs or retries a write. */
export function thinPoolCommand(
  input: NodeThinStorageInput,
  facts: ThinLvmFacts,
  action: NodeThinPoolAction,
): string[] | null {
  const lease = input.lease,
    profile = lease.profile;
  if (
    facts.vg_uuid !== lease.volume_group_uuid ||
    action.target_data_bytes > profile.maximum_data_bytes ||
    action.target_metadata_bytes !== profile.metadata_bytes ||
    action.target_data_bytes % facts.extent ||
    action.target_metadata_bytes % facts.extent
  )
    throw new BootstrapError("thin_storage_action_scope_changed");
  const pool = facts.physical.thin_pool;
  if (action.kind === "initialize") {
    if (pool) {
      if (
        facts.pool_tags.includes(`pgcf.action.${action.nonce}`) &&
        facts.pool_tags.includes(`pgcf.node.${lease.node_uid}`) &&
        pool.data_total_bytes >= action.target_data_bytes &&
        pool.metadata_total_bytes >= action.target_metadata_bytes
      )
        return null;
      throw new BootstrapError("thin_storage_pool_owner_changed");
    }
    if (
      facts.volumes.some(
        (lv) =>
          lv.segtype === "thin" ||
          lv.segtype === "thin-pool" ||
          lv.name.includes("pgcf_thinpool"),
      )
    )
      throw new BootstrapError("thin_storage_existing_thin_data_unresolved");
    if (action.state === "dispatched")
      throw new BootstrapError("thin_storage_initialize_outcome_unknown");
    if (
      action.target_data_bytes +
        2 * action.target_metadata_bytes +
        profile.vg_reserve_bytes >
      facts.free
    )
      throw new BootstrapError("thin_storage_vg_headroom_insufficient");
    return [
      "lvcreate",
      "--type",
      "thin-pool",
      "--name",
      "pgcf_thinpool",
      "--size",
      `${action.target_data_bytes}B`,
      "--poolmetadatasize",
      `${action.target_metadata_bytes}B`,
      "--chunksize",
      "64K",
      "--errorwhenfull",
      "y",
      "--addtag",
      `pgcf.node.${lease.node_uid}`,
      "--addtag",
      `pgcf.action.${action.nonce}`,
      "pgcf",
    ];
  }
  if (!pool || facts.pool_uuid !== action.expected_pool_uuid)
    throw new BootstrapError("thin_storage_pool_identity_changed");
  if (
    pool.data_total_bytes >= action.target_data_bytes &&
    pool.metadata_total_bytes >= action.target_metadata_bytes
  )
    return null;
  if (action.state === "dispatched")
    throw new BootstrapError("thin_storage_grow_outcome_unknown");
  const dataGrowth = action.target_data_bytes - pool.data_total_bytes;
  const metadataGrowth =
    action.target_metadata_bytes - pool.metadata_total_bytes;
  if (
    dataGrowth < 0 ||
    metadataGrowth < 0 ||
    dataGrowth + 2 * metadataGrowth + profile.vg_reserve_bytes > facts.free
  )
    throw new BootstrapError("thin_storage_growth_unqualified");
  return [
    "lvextend",
    ...(dataGrowth > 0 ? ["--size", `${action.target_data_bytes}B`] : []),
    ...(metadataGrowth > 0
      ? ["--poolmetadatasize", `${action.target_metadata_bytes}B`]
      : []),
    "pgcf/pgcf_thinpool",
  ];
}

export function thinPodCgroupPaths(podUid: string) {
  uid(podUid);
  const u = podUid.replaceAll("-", "_");
  return ["burstable", "besteffort", "guaranteed"]
    .map(
      (q) =>
        `/sys/fs/cgroup/kubepods.slice/kubepods-${q}.slice/kubepods-${q}-pod${u}.slice/io.max`,
    )
    .concat([
      `/sys/fs/cgroup/kubepods.slice/kubepods-pod${u}.slice/io.max`,
      `/sys/fs/cgroup/kubepods/burstable/pod${podUid}/io.max`,
      `/sys/fs/cgroup/kubepods/besteffort/pod${podUid}/io.max`,
      `/sys/fs/cgroup/kubepods/pod${podUid}/io.max`,
    ]);
}
export function thinIoLimit(raw: string, major: number, minor: number) {
  const rows = raw
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v) => v.split(/\s+/)[0] === `${major}:${minor}`);
  if (rows.length !== 1)
    throw new BootstrapError("thin_storage_io_limit_missing");
  const fields = Object.fromEntries(
    rows[0]!
      .split(/\s+/)
      .slice(1)
      .map((v) => v.split("=")),
  );
  const bps = bytes(fields.wbps),
    iops = bytes(fields.wiops);
  if (!bps || !iops)
    throw new BootstrapError("thin_storage_io_limit_unbounded");
  return { write_bytes_per_second: bps, write_iops_per_second: iops };
}

export async function runThinStorage(
  raw: unknown,
  options: {
    run?: typeof runCommand;
    request?: typeof fetch;
    proxy?: typeof startCapabilityProxy;
    signal?: AbortSignal;
  } = {},
) {
  const input = NodeThinStorageInput.parse(raw),
    lease = input.lease,
    request = options.request ?? fetch,
    run = options.run ?? runCommand;
  if (
    new URL(input.callback.url).protocol !== "https:" ||
    new URL(input.callback.url).pathname !==
      `/internal/v1/node-thin-storage/${lease.node_id}` ||
    Date.parse(lease.expires_at) <= Date.now()
  )
    throw new BootstrapError("thin_storage_input_invalid");
  const signal = AbortSignal.any([
    AbortSignal.timeout(
      Math.min(90000, Date.parse(lease.expires_at) - Date.now()),
    ),
    ...(options.signal ? [options.signal] : []),
  ]);
  const directory = await mkdtemp(join(tmpdir(), "pgcf-thin-storage-"));
  await chmod(directory, 0o700);
  const call = async (body: unknown) => {
    const response = await request(input.callback.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.callback.bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      redirect: "error",
    });
    if (!response.ok) {
      void response.body?.cancel();
      throw new BootstrapError("thin_storage_authority_refused");
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024)
      throw new BootstrapError("thin_storage_callback_limit");
    return JSON.parse(raw) as unknown;
  };
  const clusterAddress = new URL(input.cluster_endpoint).hostname;
  let proxy: Awaited<ReturnType<typeof startCapabilityProxy>> | undefined;
  try {
    proxy = await (options.proxy ?? startCapabilityProxy)(
      (authority) =>
        authority === `${lease.address}:50000`
          ? "talos_api"
          : authority === `${clusterAddress}:6443`
            ? "kubernetes_api"
            : undefined,
      async (capability) => {
        const transport = NodeBootstrapTransport.parse(
          await call({ kind: "transport", capability }),
        );
        if (
          transport.expectedTarget.ip !==
            (capability === "talos_api" ? lease.address : clusterAddress) ||
          transport.expectedTarget.port !==
            (capability === "talos_api" ? 50000 : 6443) ||
          transport.websocket_url !==
            input.callback.url.replace(/^https:/, "wss:") + "/relay"
        )
          throw new BootstrapError("thin_storage_transport_changed");
        return connectRelayTransport(transport, input.callback.bearer, signal);
      },
      signal,
    );
    await writeFile(
      join(directory, "talosconfig"),
      nativeTalosConfig(input.talos_admin_config, lease.address, proxy.url),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "kubeconfig"),
      nativeKubeconfig(input.kubeconfig, input.cluster_endpoint, proxy.url),
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      HTTPS_PROXY: proxy.url,
      HTTP_PROXY: proxy.url,
      NO_PROXY: "",
    };
    const command = async (
      executable: string,
      args: string[],
      stdin?: string,
      permit = false,
    ): Promise<CommandResult> => {
      const result = await run({
        executable,
        args,
        timeout_ms: 10000,
        signal,
        env,
        ...(stdin === undefined ? {} : { stdin }),
      });
      if (Buffer.byteLength(result.stdout) > 2 * 1024 * 1024)
        throw new BootstrapError("thin_storage_output_limit");
      if (!permit && result.exit_code !== 0)
        throw new BootstrapError("thin_storage_command_failed");
      return result;
    };
    const kube = async (args: string[], stdin?: string, permit = false) =>
      await command(
        "kubectl",
        [
          "--kubeconfig",
          join(directory, "kubeconfig"),
          "--request-timeout=8s",
          ...args,
        ],
        stdin,
        permit,
      );
    const get = async (args: string[]) =>
      object(
        JSON.parse((await kube(["get", ...args, "--output=json"])).stdout),
      );
    const talos = async (args: string[]) =>
      (
        await command("talosctl", [
          "--talosconfig",
          join(directory, "talosconfig"),
          "--nodes",
          lease.address,
          "--endpoints",
          lease.address,
          ...args,
        ])
      ).stdout;
    const authorize = async () => {
      const [node, cluster] = await Promise.all([
        get(["node", lease.name]),
        get(["namespace", "kube-system"]),
      ]);
      const labels = object(metadata(node).labels);
      if (
        uid(metadata(node).uid) !== lease.node_uid ||
        uid(metadata(cluster).uid) !== lease.cluster_uid ||
        !ready(node) ||
        metadata(node).deletionTimestamp ||
        labels["pgcf.io/node-id"] !== lease.node_id ||
        labels["pgcf.io/provider-instance-id"] !== lease.provider_instance_id ||
        labels["pgcf.io/region"] !== lease.region_id
      )
        throw new BootstrapError("thin_storage_physical_identity_changed");
      const current = object(await call({ kind: "status" }));
      if (
        current.operation_id !== lease.operation_id ||
        current.revision !== lease.revision ||
        current.node_uid !== lease.node_uid ||
        current.release_id !== lease.release_id ||
        current.spec_sha256 !== lease.spec_sha256 ||
        current.assignment_revision !== lease.assignment_revision ||
        current.region_revision !== lease.region_revision
      )
        throw new BootstrapError("thin_storage_lease_changed");
    };
    await authorize();
    const [pods, bootRaw, systemRaw, modules] = await Promise.all([
      get(["pods", "--namespace", "openebs"]),
      talos(["read", "/proc/sys/kernel/random/boot_id"]),
      talos(["read", "/sys/class/dmi/id/product_uuid"]),
      talos(["read", "/proc/modules"]),
    ]);
    const driverPods = items(pods.items).filter(
      (p) =>
        object(p.spec).nodeName === lease.name &&
        items(object(p.spec).containers).some(
          (c) =>
            c.name === "openebs-lvm-plugin" &&
            c.image === lease.profile.driver_image,
        ) &&
        ready(p),
    );
    if (driverPods.length !== 1)
      throw new BootstrapError("thin_storage_driver_ambiguous");
    const driver = driverPods[0]!,
      podName = text(metadata(driver).name),
      driverUid = uid(metadata(driver).uid);
    const owners = items(metadata(driver).ownerReferences).filter(
      (v) => v.kind === "DaemonSet" && v.controller === true,
    );
    if (owners.length !== 1)
      throw new BootstrapError("thin_storage_driver_owner_changed");
    const owner = owners[0]!,
      ds = await get(["daemonset", text(owner.name), "--namespace", "openebs"]);
    if (
      uid(owner.uid) !== uid(metadata(ds).uid) ||
      metadata(ds).deletionTimestamp ||
      !openEbsCgroupReadback(ds)
    )
      throw new BootstrapError("thin_storage_driver_owner_changed");
    const boot = uid(bootRaw.trim()),
      systemUuid = uid(systemRaw.trim().toLowerCase());
    const targetNode = await get(["node", lease.name]);
    const nodeInfo = object(object(targetNode.status).nodeInfo);
    if (
      text(nodeInfo.systemUUID).toLowerCase() !== systemUuid ||
      nodeInfo.bootID !== boot ||
      boot !== lease.boot_id ||
      (lease.kernel_version !== null &&
        text(nodeInfo.kernelVersion) !== lease.kernel_version)
    )
      throw new BootstrapError("thin_storage_talos_identity_changed");
    assertThinStorageHostSettings(input);
    const [hostReadback, extensionRaw, serviceRaw] = await Promise.all([
      readHostConfiguration(
        { talos: (args) => talos(args) },
        input.host_configuration,
      ),
      talos(["get", "extensionstatuses", "--output=json"]),
      talos(["get", "services", "--output=json"]),
    ]);
    const service = readFleetTalosServices(serviceRaw).get(
      "ext-pgcf-sandbox-controller",
    );
    if (
      !hostReadback.matches ||
      readFleetTalosExtensions(extensionRaw).get("pgcf-sandbox-controller") !==
        input.host_extension.version ||
      !service?.running ||
      (!service.healthy && !service.unknown)
    )
      throw new BootstrapError("thin_storage_host_guard_unqualified");
    const driverExec = async (args: string[], permit = false) =>
      await kube(
        [
          "exec",
          "--namespace",
          "openebs",
          podName,
          "--container",
          "openebs-lvm-plugin",
          "--",
          ...args,
        ],
        undefined,
        permit,
      );
    const freshDriver = async () => {
      await authorize();
      const next = await get(["pod", podName, "--namespace", "openebs"]);
      if (
        metadata(next).uid !== driverUid ||
        !ready(next) ||
        metadata(next).deletionTimestamp ||
        object(next.spec).nodeName !== lease.name ||
        !items(object(next.spec).containers).some(
          (c) =>
            c.name === "openebs-lvm-plugin" &&
            c.image === lease.profile.driver_image,
        ) ||
        (await talos(["read", "/proc/sys/kernel/random/boot_id"])).trim() !==
          boot
      )
        throw new BootstrapError("thin_storage_driver_identity_changed");
    };
    const hashes = (
      await driverExec([
        "sha256sum",
        "/usr/local/bin/lvm-driver",
        "/sbin/lvm",
        "/usr/sbin/pdata_tools",
      ])
    ).stdout
      .trim()
      .split("\n")
      .map((v) => v.split(/\s+/)[0]);
    const tools = (await driverExec(["thin_check", "--version"])).stdout.trim();
    const cgroup = (
      await driverExec(["cat", "/sys/fs/cgroup/cgroup.controllers"])
    ).stdout
      .split(/\s+/)
      .includes("io");
    const moduleLive = /^dm_thin_pool\s/m.test(modules);
    if (
      hashes[0] !== sources.driver.binary_sha256 ||
      hashes[1] !== sources.driver.lvm_binary_sha256 ||
      hashes[2] !== sources.thin_tools.binary_sha256 ||
      tools !== sources.thin_tools.version ||
      !moduleLive ||
      !cgroup
    )
      throw new BootstrapError("thin_storage_driver_unqualified");
    const readLvm = async () => {
      const [vg, lv, dm] = await Promise.all([
        driverExec([
          "vgs",
          "--reportformat",
          "json",
          "--units",
          "b",
          "--nosuffix",
          "-o",
          "vg_name,vg_uuid,vg_size,vg_free,vg_extent_size,vg_permissions,vg_missing_pv_count,pv_count",
          "pgcf",
        ]),
        driverExec([
          "lvs",
          "--all",
          "--reportformat",
          "json",
          "--units",
          "b",
          "--nosuffix",
          "-o",
          "vg_uuid,lv_name,lv_uuid,lv_size,segtype,pool_lv,lv_attr,data_percent,metadata_percent,lv_metadata_size,lv_when_full,lv_tags,lv_kernel_major,lv_kernel_minor",
          "pgcf",
        ]),
        driverExec([
          "dmsetup",
          "info",
          "--columns",
          "--noheadings",
          "--options",
          "uuid",
        ]),
      ]);
      return thinLvmFacts(vg.stdout, lv.stdout, dm.stdout);
    };
    let facts = await readLvm();
    if (facts.vg_uuid !== lease.volume_group_uuid)
      throw new BootstrapError("thin_storage_vg_identity_changed");
    let actionApplied = false;
    if (lease.action) {
      const args = thinPoolCommand(input, facts, lease.action);
      if (args) {
        await freshDriver();
        const before = await readLvm();
        // Live thin allocation may change used percentages between reads. Recompute the same
        // fixed command from fresh UUID/geometry/headroom facts instead of comparing usage bytes.
        if (
          canonical(thinPoolCommand(input, before, lease.action)) !==
          canonical(args)
        )
          throw new BootstrapError("thin_storage_action_preflight_changed");
        await call({
          kind: "dispatch",
          nonce: lease.action.nonce,
          driver_pod_uid: driverUid,
          boot_id: boot,
        });
        await driverExec(args);
        actionApplied = true;
        facts = await readLvm();
        if (
          thinPoolCommand(input, facts, {
            ...lease.action,
            state: "dispatched",
            driver_pod_uid: driverUid,
            boot_id: boot,
            dispatched_at: new Date().toISOString(),
            deadline_at: lease.expires_at,
          }) !== null
        )
          throw new BootstrapError("thin_storage_action_unconfirmed");
      }
    }
    const className = thinStorageClass(lease.profile_sha256);
    for (const expected of [
      thinStorageClassObject(lease.profile, lease.profile_sha256),
      thinVolumeAttributesClassObject(lease.profile, lease.profile_sha256),
    ]) {
      const existing = await kube([
        "get",
        expected.kind,
        expected.metadata.name,
        "--ignore-not-found",
        "--output=json",
      ]);
      if (!existing.stdout.trim()) {
        if (!input.class_creation_allowed)
          throw new BootstrapError("thin_storage_class_identity_missing");
        await freshDriver();
        await kube(["create", "--filename=-"], JSON.stringify(expected));
      }
      const actual = await get([expected.kind, expected.metadata.name]);
      const normalized = { ...actual };
      delete normalized.metadata;
      const body = { ...expected };
      delete (body as { metadata?: unknown }).metadata;
      for (const [key, value] of Object.entries(body))
        if (canonical(normalized[key]) !== canonical(value))
          throw new BootstrapError("thin_storage_class_changed");
      if (
        object(metadata(actual).annotations)[
          "pgcf.io/storage-profile-sha256"
        ] !== lease.profile_sha256
      )
        throw new BootstrapError("thin_storage_class_owner_changed");
    }
    const [pvRaw, pvcRaw, lvmRaw, podRaw, namespaceRaw, clusterRaw, mapsRaw] =
      await Promise.all([
        get(["pv"]),
        get(["pvc", "--all-namespaces"]),
        get(["lvmvolumes.local.openebs.io", "--all-namespaces"]),
        get(["pods", "--all-namespaces"]),
        get(["namespaces"]),
        get(["clusters.postgresql.cnpg.io", "--all-namespaces"]),
        get(["configmaps", "--namespace", "pgcf-system"]),
      ]);
    const pvs = items(pvRaw.items),
      pvcs = items(pvcRaw.items),
      lvms = items(lvmRaw.items),
      allPods = items(podRaw.items),
      namespaces = items(namespaceRaw.items),
      clusters = items(clusterRaw.items),
      maps = items(mapsRaw.items);
    const volumes: NodeThinStorageAuthority["volumes"] = [],
      protections: NodeThinStorageAuthority["protections"] = [];
    const accounted = new Set<string>();
    for (const db of lease.databases) {
      const namespace = `pgcf-db-${db.id}`,
        ns = namespaces.find((v) => metadata(v).name === namespace),
        cluster = clusters.find(
          (v) =>
            metadata(v).name === "database" &&
            metadata(v).namespace === namespace,
        ),
        storage = maps.find((v) => metadata(v).name === `storage-${db.id}`);
      const claims = pvcs.filter(
        (v) =>
          metadata(v).namespace === namespace &&
          (db.desired_state === "deleted" || !metadata(v).deletionTimestamp),
      );
      if (
        (db.desired_state === "deleted" &&
          db.volume &&
          db.stop_operation?.kind === "database.delete" &&
          db.stop_operation.generation === db.generation) ||
        !ns ||
        !cluster ||
        !storage ||
        claims.length !== 1
      ) {
        const retained = thinDeletingVolume(lease, db, facts, {
          namespace: ns,
          cluster,
          storage,
          pv: db.volume
            ? pvs.find((p) => metadata(p).name === db.volume!.volume_handle)
            : undefined,
          pvc: db.volume
            ? pvcs.find((p) => metadata(p).uid === db.volume!.pvc_uid)
            : undefined,
          lvm: db.volume
            ? lvms.find((p) => metadata(p).name === db.volume!.volume_handle)
            : undefined,
        });
        if (retained) {
          accounted.add(retained.lv_uuid);
          volumes.push(retained);
        }
        continue;
      }
      const state = object(JSON.parse(text(object(storage.data).state)));
      if (
        state.namespaceUid !== metadata(ns).uid ||
        state.clusterUid !== metadata(cluster).uid ||
        state.node !== lease.name ||
        state.archivePath !== db.archive_path ||
        canonical(state.storage ?? null) !== canonical(db.storage)
      )
        throw new BootstrapError("thin_storage_database_owner_changed");
      const pods = allPods.filter(
        (v) =>
          metadata(v).namespace === namespace &&
          object(v.spec).nodeName === lease.name,
      );
      const protection = object(storage.data)[STORAGE_PROTECTION_LEDGER_KEY];
      if (
        typeof protection === "string" &&
        pods.length === 0 &&
        object(metadata(cluster).annotations)["cnpg.io/hibernation"] === "on"
      ) {
        const p = object(JSON.parse(protection));
        if (
          p.database_id === db.id &&
          p.generation === db.generation &&
          p.storage_uid === metadata(storage).uid &&
          p.namespace_uid === metadata(ns).uid &&
          p.cluster_uid === metadata(cluster).uid &&
          p.node_uid === lease.node_uid &&
          p.profile_sha256 === lease.profile_sha256 &&
          p.operation_id === (db.power_operation ?? db.archive_path.slice(-23))
        )
          protections.push({
            database_id: p.database_id,
            generation: p.generation,
            operation_id: p.operation_id,
            storage_uid: p.storage_uid,
            namespace_uid: p.namespace_uid,
            cluster_uid: p.cluster_uid,
            node_uid: p.node_uid,
            profile_sha256: p.profile_sha256,
            requested_at: p.requested_at,
            hibernation_on: true,
            pods_absent: true,
          } as NodeThinStorageAuthority["protections"][number]);
      }
      if (claims.length !== 1) continue;
      const pvc = claims[0]!,
        spec = object(pvc.spec),
        handle = text(spec.volumeName),
        pv = pvs.find((v) => metadata(v).name === handle),
        lvm = lvms.find((v) => metadata(v).name === handle),
        lv = facts.rows.find((v) => v.lv_name === handle);
      if (!pv || !lvm || !lv) continue;
      const pvSpec = object(pv.spec),
        ref = object(pvSpec.claimRef),
        csi = object(pvSpec.csi),
        lvmSpec = object(lvm.spec);
      const storageClass = db.storage?.storage_class ?? "pgcf-lvm";
      if (
        ref.uid !== metadata(pvc).uid ||
        ref.namespace !== namespace ||
        csi.driver !== "local.csi.openebs.io" ||
        csi.volumeHandle !== handle ||
        pvSpec.storageClassName !== storageClass ||
        spec.storageClassName !== storageClass ||
        lvmSpec.ownerNodeID !== lease.name ||
        lvmSpec.volGroup !== "pgcf" ||
        (db.storage &&
          (spec.volumeAttributesClassName !== className ||
            pvSpec.volumeAttributesClassName !== className ||
            lv.pool_lv !== "pgcf_thinpool" ||
            lv.segtype !== "thin"))
      )
        throw new BootstrapError("thin_storage_volume_identity_changed");
      const io: NodeThinStorageAuthority["volumes"][number]["io"] = [];
      for (const pod of db.storage && text(lv.lv_attr)[4] === "a"
        ? thinWriterPods(pods)
        : []) {
        const podUid = uid(metadata(pod).uid);
        let limits: ReturnType<typeof thinIoLimit>;
        try {
          const limitsRaw = await driverExec([
            "sh",
            "-ec",
            'for p do if [ -r "$p" ]; then cat "$p"; fi; done',
            "--",
            ...thinPodCgroupPaths(podUid),
          ]);
          limits = thinIoLimit(
            limitsRaw.stdout,
            bytes(lv.lv_kernel_major),
            bytes(lv.lv_kernel_minor),
          );
        } catch (error) {
          // An unstarted cgroup is bounded by its current full logical startup hold.
          // Established writers have no such substitute for an actual IO readback.
          if (
            db.startup &&
            db.startup.generation === db.generation &&
            db.startup.node_uid === lease.node_uid &&
            db.startup.budget_bytes >= bytes(lv.lv_size) &&
            Date.parse(db.startup.expires_at) > Date.now()
          )
            continue;
          throw error;
        }
        if (
          !db.storage ||
          limits.write_bytes_per_second > db.storage.write_bytes_per_second ||
          limits.write_iops_per_second > db.storage.write_iops_per_second
        )
          throw new BootstrapError("thin_storage_io_limit_unqualified");
        io.push({ pod_uid: podUid, ...limits });
      }
      accounted.add(lvmUid(lv.lv_uuid));
      volumes.push({
        database_id: db.id,
        generation: db.generation,
        storage_generation: db.storage_generation,
        storage_uid: uid(metadata(storage).uid),
        namespace_uid: uid(metadata(ns).uid),
        cluster_uid: uid(metadata(cluster).uid),
        volume_handle: handle,
        lv_uuid: lvmUid(lv.lv_uuid),
        pvc_uid: uid(metadata(pvc).uid),
        pv_uid: uid(metadata(pv).uid),
        storage_class: storageClass,
        quiesced: text(lv.lv_attr)[4] === "s",
        volume_attributes_class: db.storage ? className : null,
        io,
      });
    }
    const dataComplete =
      facts.volumes
        .filter((v) => v.segtype === "thin")
        .every((v) => accounted.has(v.lv_uuid)) &&
      facts.volumes.every((v) =>
        ["thin", "thin-pool", "linear"].includes(v.segtype),
      );
    await freshDriver();
    const final = await readLvm();
    if (
      final.vg_uuid !== facts.vg_uuid ||
      final.pool_uuid !== facts.pool_uuid ||
      canonical(final.volumes) !== canonical(facts.volumes)
    )
      throw new BootstrapError("thin_storage_inventory_changed");
    facts = final;
    const pool = facts.physical.thin_pool;
    const writeAllowed = Boolean(
      pool &&
      pool.metadata_total_bytes === lease.profile.metadata_bytes &&
      pool.data_total_bytes <= lease.profile.maximum_data_bytes &&
      dataComplete &&
      pool.data_total_bytes - pool.data_used_bytes_upper_bound >=
        lease.required_data_free_bytes &&
      pool.metadata_total_bytes - pool.metadata_used_bytes_upper_bound >=
        lease.required_metadata_free_bytes,
    );
    const authority = NodeThinStorageAuthority.parse({
      node_id: lease.node_id,
      name: lease.name,
      node_uid: lease.node_uid,
      cluster_uid: lease.cluster_uid,
      revision: lease.authority_revision + 1,
      profile_revision: lease.profile_revision,
      profile_sha256: lease.profile_sha256,
      storage_class: className,
      volume_group_uuid: lease.volume_group_uuid,
      pool_uuid: facts.pool_uuid,
      driver_pod_uid: driverUid,
      driver_image: lease.profile.driver_image,
      observed_at: lease.issued_at,
      captured_at: new Date().toISOString(),
      expires_at: lease.expires_at,
      write_allowed: writeAllowed,
      physical: facts.physical,
      physical_lvs: facts.volumes,
      active_lv_uuids: facts.active,
      data_accounting_complete: dataComplete,
      protections,
      volumes,
    });
    const imageStatus = items(object(driver.status).containerStatuses).find(
      (v) => v.name === "openebs-lvm-plugin",
    );
    const report = NodeThinStorageReport.parse({
      expected_revision: lease.revision,
      authority,
      boot_id: boot,
      system_uuid: systemUuid,
      software: {
        kernel_version: text(nodeInfo.kernelVersion),
        host_extension_image: input.host_extension.image,
        host_configuration_sha256: input.host_configuration.status.sha256,
        driver_image_id: text(imageStatus?.imageID),
        driver_sha256: hashes[0],
        lvm_sha256: hashes[1],
        tools_sha256: hashes[2],
        thin_tools_version: tools,
        thin_module_live: moduleLive,
        cgroup_host_view: cgroup,
      },
      pool_tag: facts.pool_tags.find((v) => v.startsWith("pgcf.node.")) ?? null,
      action_applied: actionApplied,
    });
    return await call({ kind: "report", report });
  } finally {
    await proxy?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
