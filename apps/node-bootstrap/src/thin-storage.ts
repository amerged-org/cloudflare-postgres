// SPDX-License-Identifier: Apache-2.0
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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

export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BootstrapError("thin_storage_readback_invalid");
  return value as ObjectValue;
};
export const items = (value: unknown) => {
  if (!Array.isArray(value))
    throw new BootstrapError("thin_storage_inventory_invalid");
  return value.map(object);
};
export const uid = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
  )
    throw new BootstrapError("thin_storage_uid_invalid");
  return value;
};
export const lvmUid = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9]{6}-(?:[A-Za-z0-9]{4}-){5}[A-Za-z0-9]{6}$/.test(value)
  )
    throw new BootstrapError("thin_storage_lvm_uuid_invalid");
  return value;
};
export const bytes = (value: unknown) => {
  const n =
    typeof value === "string" && /^\s*\d+(?:\.0+)?\s*$/.test(value)
      ? Number(value)
      : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    throw new BootstrapError("thin_storage_bytes_invalid");
  return n;
};
export const text = (value: unknown) => {
  if (typeof value !== "string")
    throw new BootstrapError("thin_storage_text_invalid");
  return value.trim();
};
/** LVM leaves a percentage empty when it cannot report one; Number("") would read that as an unused pool. */
export const percent = (value: unknown) => {
  const raw = text(value),
    n = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 0 && n <= 100))
    throw new BootstrapError("thin_storage_pool_percent_invalid");
  return n;
};
export const metadata = (value: ObjectValue) => object(value.metadata);
export function lvmRows(raw: string, key: string) {
  const value = object(JSON.parse(raw));
  const reports = items(value.report);
  return reports.flatMap((report) => items(report[key]));
}
const devices = (dm: string) =>
  new Set(
    dm
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean),
  );
/** lvm-localpv creates and removes volumes while we read. LVM changes a device and its metadata under
 * the VG lock that `lvs` waits for, but `dmsetup` takes none: read the device list before and after
 * `vgs`/`lvs`, and require an LV only for a device both reads list. */
export async function readThinLvm(
  exec: (args: string[]) => Promise<CommandResult>,
  lvFields = THIN_LV_FIELDS,
) {
  const [vgsArgs, lvsArgs, dmArgs] = thinLvmReadCommands(lvFields);
  const before = await exec(dmArgs!);
  const [vg, lv] = await Promise.all([exec(vgsArgs!), exec(lvsArgs!)]);
  const after = await exec(dmArgs!);
  return {
    vgs: vg.stdout,
    lvs: lv.stdout,
    dm: after.stdout,
    before: before.stdout,
  };
}
/** A read-only command repeats a failed relay round trip or native command timeout at most twice.
 * Exhausted command timeouts are transient; turn cancellation and other errors pass through.
 * Mutating commands never use this helper. */
export async function readCommand(
  attempt: () => Promise<CommandResult>,
  signal: AbortSignal,
  pause = 1000,
): Promise<CommandResult> {
  for (let retry = 0; ; retry++) {
    try {
      const result = await attempt();
      if (result.exit_code === 0 || retry === 2) return result;
    } catch (error) {
      if (
        signal.aborted ||
        !(error instanceof BootstrapError) ||
        error.code !== "command_timeout"
      )
        throw error;
      if (retry === 2) throw new BootstrapError("thin_storage_command_failed");
    }
    await delay(pause, undefined, { signal });
  }
}
/** Every relay transport is single-use, so a failed issuance is requested again, at most twice. */
export async function issueAgain<T>(
  request: () => Promise<T>,
  signal: AbortSignal,
  pause = 1000,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await request();
    } catch (error) {
      if (retry === 2 || signal.aborted) throw error;
      await delay(pause, undefined, { signal });
    }
  }
}
/** `lvs` prints one row per segment once a segment field such as `segtype` is requested, so a grown
 * pool's hidden data LV or an extended linear LV appears once per segment; those rows must agree. */
export function lvmVolumes(raw: string, conflict: () => never) {
  const volumes = new Map<string, ObjectValue>();
  for (const row of lvmRows(raw, "lv")) {
    const seen = volumes.get(text(row.lv_uuid));
    if (!seen) volumes.set(text(row.lv_uuid), row);
    else if (JSON.stringify(seen) !== JSON.stringify(row)) conflict();
  }
  return [...volumes.values()];
}
export function ready(value: ObjectValue) {
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
  before = dm,
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
  const rows = lvmVolumes(lvs, () => {
    throw new BootstrapError("thin_storage_lvs_changed");
  });
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
      const dataPercent = percent(row.data_percent),
        metaPercent = percent(row.metadata_percent),
        meta = bytes(row.lv_metadata_size);
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
    if (lv) active.add(lv.lv_uuid);
    else if (devices(before).has(raw))
      throw new BootstrapError("thin_storage_kernel_lv_unexplained");
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
  input: {
    lease: Pick<
      NodeThinStorageInput["lease"],
      "volume_group_uuid" | "node_uid" | "profile"
    >;
  },
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
    // lvm2 2.03 refuses --errorwhenfull with --type thin-pool; the --thinpool form accepts it.
    return [
      "lvcreate",
      "--thinpool",
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

export const THIN_VG_FIELDS =
  "vg_name,vg_uuid,vg_size,vg_free,vg_extent_size,vg_permissions,vg_missing_pv_count,pv_count";
export const THIN_LV_FIELDS =
  "vg_uuid,lv_name,lv_uuid,lv_size,segtype,pool_lv,lv_attr,data_percent,metadata_percent,lv_metadata_size,lv_when_full,lv_tags,lv_kernel_major,lv_kernel_minor";
/** One complete VG, LV and kernel DM read; never a partial or cached inventory. */
export function thinLvmReadCommands(lvFields = THIN_LV_FIELDS): string[][] {
  return [
    [
      "vgs",
      "--reportformat",
      "json",
      "--units",
      "b",
      "--nosuffix",
      "-o",
      THIN_VG_FIELDS,
      "pgcf",
    ],
    [
      "lvs",
      "--all",
      "--reportformat",
      "json",
      "--units",
      "b",
      "--nosuffix",
      "-o",
      lvFields,
      "pgcf",
    ],
    ["dmsetup", "info", "--columns", "--noheadings", "--options", "uuid"],
  ];
}

export interface ThinSession {
  signal: AbortSignal;
  call(body: unknown): Promise<unknown>;
  command(
    executable: string,
    args: string[],
    stdin?: string,
    permit?: boolean,
    timeout?: number,
  ): Promise<CommandResult>;
  kube(
    args: string[],
    stdin?: string,
    permit?: boolean,
    timeout?: number,
  ): Promise<CommandResult>;
  get(args: string[]): Promise<ObjectValue>;
  talos(args: string[], timeout?: number): Promise<string>;
}
/** Relay-only Talos/Kubernetes access with private 0600 configs, removed after every execution. */
export async function openThinSession<T>(
  scope: {
    callback: { url: string; bearer: string };
    cluster_endpoint: string;
    talos_admin_config: string;
    kubeconfig: string;
    address: string;
    budget_ms: number;
    prefix: string;
  },
  options: {
    run?: typeof runCommand;
    request?: typeof fetch;
    proxy?: typeof startCapabilityProxy;
    signal?: AbortSignal;
  },
  use: (session: ThinSession) => Promise<T>,
): Promise<T> {
  const request = options.request ?? fetch,
    run = options.run ?? runCommand;
  const signal = AbortSignal.any([
    AbortSignal.timeout(scope.budget_ms),
    ...(options.signal ? [options.signal] : []),
  ]);
  const directory = await mkdtemp(join(tmpdir(), scope.prefix));
  await chmod(directory, 0o700);
  const call = async (body: unknown) => {
    const response = await request(scope.callback.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${scope.callback.bearer}`,
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
  const clusterAddress = new URL(scope.cluster_endpoint).hostname;
  let proxy: Awaited<ReturnType<typeof startCapabilityProxy>> | undefined;
  try {
    proxy = await (options.proxy ?? startCapabilityProxy)(
      (authority) =>
        authority === `${scope.address}:50000`
          ? "talos_api"
          : authority === `${clusterAddress}:6443`
            ? "kubernetes_api"
            : undefined,
      async (capability) => {
        const transport = NodeBootstrapTransport.parse(
          await issueAgain(
            () => call({ kind: "transport", capability }),
            signal,
          ),
        );
        if (
          transport.expectedTarget.ip !==
            (capability === "talos_api" ? scope.address : clusterAddress) ||
          transport.expectedTarget.port !==
            (capability === "talos_api" ? 50000 : 6443) ||
          transport.websocket_url !==
            scope.callback.url.replace(/^https:/, "wss:") + "/relay"
        )
          throw new BootstrapError("thin_storage_transport_changed");
        return connectRelayTransport(transport, scope.callback.bearer, signal);
      },
      signal,
    );
    await writeFile(
      join(directory, "talosconfig"),
      nativeTalosConfig(scope.talos_admin_config, scope.address, proxy.url),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "kubeconfig"),
      nativeKubeconfig(scope.kubeconfig, scope.cluster_endpoint, proxy.url),
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
      timeout = 10000,
    ): Promise<CommandResult> => {
      const result = await run({
        executable,
        args,
        timeout_ms: timeout,
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
    const kube = async (
      args: string[],
      stdin?: string,
      permit = false,
      timeout = 10000,
    ) =>
      await command(
        "kubectl",
        [
          "--kubeconfig",
          join(directory, "kubeconfig"),
          `--request-timeout=${timeout > 10000 ? 0 : 8}s`,
          ...args,
        ],
        stdin,
        permit,
        timeout,
      );
    const read = async (attempt: () => Promise<CommandResult>) => {
      const result = await readCommand(attempt, signal);
      if (result.exit_code !== 0)
        throw new BootstrapError("thin_storage_command_failed");
      return result.stdout;
    };
    const get = async (args: string[]) =>
      object(
        JSON.parse(
          await read(() =>
            kube(["get", ...args, "--output=json"], undefined, true),
          ),
        ),
      );
    // Every talosctl use here is a read: read, get and dmesg.
    const talos = async (args: string[], timeout = 10000) =>
      await read(() =>
        command(
          "talosctl",
          [
            "--talosconfig",
            join(directory, "talosconfig"),
            "--nodes",
            scope.address,
            "--endpoints",
            scope.address,
            ...args,
          ],
          undefined,
          true,
          timeout,
        ),
      );
    return await use({ signal, call, command, kube, get, talos });
  } finally {
    await proxy?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export interface ThinNodeScope {
  node_id: string;
  region_id: string;
  node_uid: string;
  cluster_uid: string;
  name: string;
  provider_instance_id: string;
  /** Expected driver image; null accepts the node's single Ready driver Pod. */
  driver_image: string | null;
  /** Expected host guard extension; null skips the host guard check. */
  host_extension_version: string | null;
  /** Expected current boot; null accepts and returns the observed boot. */
  boot_id: string | null;
  kernel_version: string | null;
}
export interface ThinNode {
  authorize(): Promise<void>;
  driver: ObjectValue;
  daemonSet: ObjectValue;
  podName: string;
  driverUid: string;
  boot: string;
  systemUuid: string;
  nodeInfo: ObjectValue;
  hashes: string[];
  tools: string;
  moduleLive: boolean;
  cgroup: boolean;
  driverExec(
    args: string[],
    permit?: boolean,
    timeout?: number,
  ): Promise<CommandResult>;
  /** A read-only driver command; a failed relay round trip is repeated, a failure still throws. */
  driverRead(args: string[], timeout?: number): Promise<CommandResult>;
  freshDriver(): Promise<void>;
  readLvm(): Promise<ThinLvmFacts>;
}
/** Node, cluster, boot, kernel, host guard, driver binaries and live module, before any write. */
export async function verifyThinNode(
  session: ThinSession,
  scope: ThinNodeScope,
  lease: () => Promise<void>,
  hostConfiguration?: () => Promise<boolean>,
): Promise<ThinNode> {
  const { get, talos, kube } = session;
  const authorize = async () => {
    const [node, cluster] = await Promise.all([
      get(["node", scope.name]),
      get(["namespace", "kube-system"]),
    ]);
    const labels = object(metadata(node).labels);
    if (
      uid(metadata(node).uid) !== scope.node_uid ||
      uid(metadata(cluster).uid) !== scope.cluster_uid ||
      !ready(node) ||
      metadata(node).deletionTimestamp ||
      labels["pgcf.io/node-id"] !== scope.node_id ||
      labels["pgcf.io/provider-instance-id"] !== scope.provider_instance_id ||
      labels["pgcf.io/region"] !== scope.region_id
    )
      throw new BootstrapError("thin_storage_physical_identity_changed");
    await lease();
  };
  await authorize();
  const [pods, bootRaw, systemRaw, modules] = await Promise.all([
    get(["pods", "--namespace", "openebs"]),
    talos(["read", "/proc/sys/kernel/random/boot_id"]),
    talos(["read", "/sys/class/dmi/id/product_uuid"]),
    talos(["read", "/proc/modules"]),
  ]);
  const plugin = (p: ObjectValue) =>
    items(object(p.spec).containers).find(
      (c) =>
        c.name === "openebs-lvm-plugin" &&
        (scope.driver_image === null || c.image === scope.driver_image),
    );
  const driverOwner = (p: ObjectValue) => {
    const owners = items(metadata(p).ownerReferences).filter(
      (owner) => owner.controller === true,
    );
    return owners.length === 1 && owners[0]!.kind === "DaemonSet"
      ? owners[0]
      : undefined;
  };
  const driverPods = items(pods.items).filter(
    (p) =>
      object(p.spec).nodeName === scope.name &&
      plugin(p) &&
      ready(p) &&
      !metadata(p).deletionTimestamp &&
      driverOwner(p),
  );
  if (driverPods.length !== 1)
    throw new BootstrapError("thin_storage_driver_ambiguous");
  const driver = driverPods[0]!,
    driverImage = text(plugin(driver)!.image),
    podName = text(metadata(driver).name),
    driverUid = uid(metadata(driver).uid);
  const owner = driverOwner(driver)!,
    ds = await get(["daemonset", text(owner.name), "--namespace", "openebs"]);
  if (
    uid(owner.uid) !== uid(metadata(ds).uid) ||
    metadata(ds).deletionTimestamp ||
    !openEbsCgroupReadback(ds)
  )
    throw new BootstrapError("thin_storage_driver_owner_changed");
  const boot = uid(bootRaw.trim()),
    systemUuid = uid(systemRaw.trim().toLowerCase());
  const targetNode = await get(["node", scope.name]);
  const nodeInfo = object(object(targetNode.status).nodeInfo);
  if (
    text(nodeInfo.systemUUID).toLowerCase() !== systemUuid ||
    nodeInfo.bootID !== boot ||
    (scope.boot_id !== null && boot !== scope.boot_id) ||
    (scope.kernel_version !== null &&
      text(nodeInfo.kernelVersion) !== scope.kernel_version)
  )
    throw new BootstrapError("thin_storage_talos_identity_changed");
  if (scope.host_extension_version !== null) {
    const [hostMatches, extensionRaw, serviceRaw] = await Promise.all([
      hostConfiguration ? hostConfiguration() : true,
      talos(["get", "extensionstatuses", "--output=json"]),
      talos(["get", "services", "--output=json"]),
    ]);
    const service = readFleetTalosServices(serviceRaw).get(
      "ext-pgcf-sandbox-controller",
    );
    if (
      !hostMatches ||
      readFleetTalosExtensions(extensionRaw).get("pgcf-sandbox-controller") !==
        scope.host_extension_version ||
      !service?.running ||
      (!service.healthy && !service.unknown)
    )
      throw new BootstrapError("thin_storage_host_guard_unqualified");
  }
  const driverExec = async (args: string[], permit = false, timeout = 10000) =>
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
      timeout,
    );
  const freshDriver = async () => {
    await authorize();
    const next = await get(["pod", podName, "--namespace", "openebs"]);
    if (
      metadata(next).uid !== driverUid ||
      !ready(next) ||
      metadata(next).deletionTimestamp ||
      object(next.spec).nodeName !== scope.name ||
      !items(object(next.spec).containers).some(
        (c) => c.name === "openebs-lvm-plugin" && c.image === driverImage,
      ) ||
      (await talos(["read", "/proc/sys/kernel/random/boot_id"])).trim() !== boot
    )
      throw new BootstrapError("thin_storage_driver_identity_changed");
  };
  const driverRead = async (args: string[], timeout = 10000) => {
    const result = await readCommand(
      () => driverExec(args, true, timeout),
      session.signal,
    );
    if (result.exit_code !== 0)
      throw new BootstrapError("thin_storage_command_failed");
    return result;
  };
  const hashes = (
    await driverRead([
      "sha256sum",
      "/usr/local/bin/lvm-driver",
      "/sbin/lvm",
      "/usr/sbin/pdata_tools",
    ])
  ).stdout
    .trim()
    .split("\n")
    .map((v) => v.split(/\s+/)[0]!);
  const tools = (await driverRead(["thin_check", "--version"])).stdout.trim();
  const cgroup = (
    await driverRead(["cat", "/sys/fs/cgroup/cgroup.controllers"])
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
    const read = await readThinLvm((args) => driverRead(args));
    return thinLvmFacts(read.vgs, read.lvs, read.dm, read.before);
  };
  return {
    authorize,
    driver,
    daemonSet: ds,
    podName,
    driverUid,
    boot,
    systemUuid,
    nodeInfo,
    hashes,
    tools,
    moduleLive,
    cgroup,
    driverExec,
    driverRead,
    freshDriver,
    readLvm,
  };
}

/** The lease pins the completed patch's boot. After a STATE-loaded boot Talos lists no persistent
 * configuration; that patch's proved configuration boot is then the only accepted witness. */
export async function thinStorageHostConfiguration(
  input: NodeThinStorageInput,
  talos: (args: string[]) => Promise<string>,
) {
  assertThinStorageHostSettings(input);
  const lease = input.lease;
  return (
    await readHostConfiguration(
      { talos },
      input.host_configuration,
      undefined,
      false,
      lease.configuration_boot_id
        ? {
            boot_id: lease.boot_id,
            configuration_boot_id: lease.configuration_boot_id,
          }
        : undefined,
      true,
    )
  ).matches;
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
    lease = input.lease;
  if (
    new URL(input.callback.url).protocol !== "https:" ||
    new URL(input.callback.url).pathname !==
      `/internal/v1/node-thin-storage/${lease.node_id}` ||
    Date.parse(lease.expires_at) <= Date.now()
  )
    throw new BootstrapError("thin_storage_input_invalid");
  const budget = Math.min(90000, Date.parse(lease.expires_at) - Date.now());
  return await openThinSession(
    {
      callback: input.callback,
      cluster_endpoint: input.cluster_endpoint,
      talos_admin_config: input.talos_admin_config,
      kubeconfig: input.kubeconfig,
      address: lease.address,
      budget_ms: budget,
      prefix: "pgcf-thin-storage-",
    },
    options,
    async (session) => {
      const { call, kube, get } = session;
      const {
        driver,
        driverUid,
        boot,
        systemUuid,
        nodeInfo,
        hashes,
        tools,
        moduleLive,
        cgroup,
        driverExec,
        freshDriver,
        readLvm,
      } = await verifyThinNode(
        session,
        {
          node_id: lease.node_id,
          region_id: lease.region_id,
          node_uid: lease.node_uid,
          cluster_uid: lease.cluster_uid,
          name: lease.name,
          provider_instance_id: lease.provider_instance_id,
          driver_image: lease.profile.driver_image,
          host_extension_version: input.host_extension.version,
          boot_id: lease.boot_id,
          kernel_version: lease.kernel_version,
        },
        async () => {
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
        },
        () =>
          thinStorageHostConfiguration(input, (args) => session.talos(args)),
      );
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
            p.operation_id ===
              (db.power_operation ?? db.archive_path.slice(-23))
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
        pool_tag:
          facts.pool_tags.find((v) => v.startsWith("pgcf.node.")) ?? null,
        action_applied: actionApplied,
      });
      return await call({ kind: "report", report });
    },
  );
}
