// SPDX-License-Identifier: Apache-2.0
import { setTimeout as delay } from "node:timers/promises";
import { newOperationId } from "@pgcf/contracts";
import {
  thinStorageClassObject,
  thinVolumeAttributesClassObject,
  type ThinStorageProfile,
} from "@pgcf/contracts/database-storage";
import {
  THIN_QUALIFICATION_LIMITS,
  ThinPoolStatus,
  ThinQualificationInput,
  ThinQualificationJournalEntry,
  ThinQualificationReport,
  ThinQualificationWrite,
  type ThinQualificationJournal,
  type ThinQualificationSetup,
  type ThinQualificationThickSnapshot,
} from "@pgcf/contracts/thin-qualification";
import { BootstrapError, runCommand, type CommandResult } from "./bootstrap.ts";
import { startCapabilityProxy } from "./proxy-command.ts";
import { storageDeleteRequest } from "./storage-capacity.ts";
import {
  THIN_LV_FIELDS,
  bytes,
  items,
  lvmRows,
  lvmUid,
  metadata,
  object,
  openThinSession,
  text,
  thinIoLimit,
  thinLvmReadCommands,
  thinPodCgroupPaths,
  thinPoolCommand,
  uid,
  verifyThinNode,
  type ObjectValue,
  type ThinNode,
  type ThinSession,
} from "./thin-storage.ts";

type Json = Record<string, unknown>;
const GIB = 1024 ** 3,
  MIB = 1024 ** 2;
const POOL = "pgcf_thinpool";
const OWNER = "pgcf.io/thin-qualification";
const MARKER = "pgcf-q-committed-marker";
const UNCOMMITTED = "pgcf-q-uncommitted";
const QUALIFICATION_LV_FIELDS = `${THIN_LV_FIELDS},chunk_size,lv_health_status`;
function fail(code: string): never {
  throw new BootstrapError(`thin_qualification_${code}`);
}
/** Ends this bounded turn; durable journal state continues in the next turn. */
class Yield extends Error {}

const hex = (value: string) => value.replaceAll("-", "");
const integer = (value: string | undefined, code: string) => {
  if (value === undefined || !/^\d+$/.test(value)) fail(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(code);
  return parsed;
};

/** One `dmsetup status` line of a thin-pool target; unknown fields close the measurement. */
export function parseThinPoolStatus(raw: string): ThinPoolStatus {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const fields = lines.length === 1 ? lines[0]!.split(/\s+/) : [];
  if (
    fields.length < 4 ||
    fields[2] !== "thin-pool" ||
    !/^\d+$/.test(fields[0]!) ||
    !/^\d+$/.test(fields[1]!)
  )
    fail("pool_status_invalid");
  const rest = fields.slice(3);
  if (rest.length === 1 && rest[0] === "Fail")
    return ThinPoolStatus.parse({
      mode: "fail",
      used_data_blocks: null,
      total_data_blocks: null,
      used_metadata_blocks: null,
      total_metadata_blocks: null,
      error_if_no_space: null,
      needs_check: null,
    });
  if (rest.length < 8 || rest.length > 9) fail("pool_status_invalid");
  const ratio = (value: string) => {
    const match = /^(\d+)\/(\d+)$/.exec(value);
    if (!match) fail("pool_status_invalid");
    const used = integer(match[1], "pool_status_invalid"),
      total = integer(match[2], "pool_status_invalid");
    if (used > total) fail("pool_status_invalid");
    return [used, total] as const;
  };
  integer(rest[0], "pool_status_invalid");
  const [metadataUsed, metadataTotal] = ratio(rest[1]!),
    [dataUsed, dataTotal] = ratio(rest[2]!);
  if (rest[3] !== "-" && !/^\d+$/.test(rest[3]!)) fail("pool_status_invalid");
  if (!["rw", "ro", "out_of_data_space"].includes(rest[4]!))
    fail("pool_status_invalid");
  if (
    !["discard_passdown", "no_discard_passdown", "ignore_discard"].includes(
      rest[5]!,
    ) ||
    !["error_if_no_space", "queue_if_no_space"].includes(rest[6]!) ||
    !["needs_check", "-"].includes(rest[7]!) ||
    (rest[8] !== undefined && !/^\d+$/.test(rest[8]))
  )
    fail("pool_status_invalid");
  return ThinPoolStatus.parse({
    mode: rest[4],
    used_data_blocks: dataUsed,
    total_data_blocks: dataTotal,
    used_metadata_blocks: metadataUsed,
    total_metadata_blocks: metadataTotal,
    error_if_no_space: rest[6] === "error_if_no_space",
    needs_check: rest[7] === "needs_check",
  });
}

export interface DeviceInfo {
  state: "ACTIVE" | "SUSPENDED";
  read_only: boolean;
  device: string;
  minor: number;
  uuid: string;
  open: number;
}
/** Non-columnar `dmsetup info` for exactly one device-mapper UUID. */
export function parseDmInfo(raw: string): DeviceInfo {
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z ,]+):\s*(.*)$/.exec(line.trim());
    if (match) {
      if (fields.has(match[1]!.trim())) fail("device_info_invalid");
      fields.set(match[1]!.trim(), match[2]!.trim());
    }
  }
  const state = /^(ACTIVE|SUSPENDED)( \(READ-ONLY\))?$/.exec(
      fields.get("State") ?? "",
    ),
    numbers = /^(\d+), (\d+)$/.exec(fields.get("Major, minor") ?? ""),
    deviceUuid = fields.get("UUID") ?? "",
    open = fields.get("Open count");
  if (
    !state ||
    !numbers ||
    !/^LVM-[A-Za-z0-9]{64}(?:-[a-z]+)?$/.test(deviceUuid) ||
    open === undefined ||
    !/^\d+$/.test(open)
  )
    fail("device_info_invalid");
  return {
    state: state[1] as "ACTIVE" | "SUSPENDED",
    read_only: state[2] !== undefined,
    device: `${numbers[1]}:${numbers[2]}`,
    minor: Number(numbers[2]),
    uuid: deviceUuid,
    open: Number(open),
  };
}
/** A thin volume's single live table: `<start> <length> thin <pool major:minor> <device id>`. */
export function parseThinTable(raw: string) {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const fields = lines.length === 1 ? lines[0]!.split(/\s+/) : [];
  if (
    fields.length !== 5 ||
    fields[2] !== "thin" ||
    !/^\d+:\d+$/.test(fields[3]!) ||
    !/^\d+$/.test(fields[4]!)
  )
    fail("device_table_invalid");
  return { pool_device: fields[3]!, device_id: Number(fields[4]) };
}
/** Resume only the exact retained LV on the qualified pool; any changed identity is refused. */
export function resumeTargetMatches(
  info: DeviceInfo,
  table: ReturnType<typeof parseThinTable>,
  expected: { volume_group_uuid: string; lv_uuid: string; pool_device: string },
): boolean {
  return (
    info.uuid ===
      `LVM-${hex(expected.volume_group_uuid)}${hex(expected.lv_uuid)}` &&
    table.pool_device === expected.pool_device
  );
}
/** /sys/block/dm-N/stat: completed write requests, written sectors and in-flight requests. */
export function parseBlockStat(raw: string) {
  const fields = raw.trim().split(/\s+/);
  if (fields.length < 11 || fields.some((value) => !/^\d+$/.test(value)))
    fail("block_stat_invalid");
  return {
    write_ios: integer(fields[4], "block_stat_invalid"),
    write_sectors: integer(fields[6], "block_stat_invalid"),
    in_flight: integer(fields[8], "block_stat_invalid"),
  };
}
/** Dirty plus writeback file pages of one Pod memory cgroup. */
export function parseMemoryStatDirty(raw: string): number {
  const values = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const match = /^([a-z_]+) (\d+)$/.exec(line.trim());
    if (match) values.set(match[1]!, integer(match[2], "memory_stat_invalid"));
  }
  const dirty = values.get("file_dirty"),
    writeback = values.get("file_writeback");
  if (dirty === undefined || writeback === undefined)
    fail("memory_stat_invalid");
  return dirty + writeback;
}
/** Shell-wrapped dd: exit code, classified error text, bytes and /proc/uptime interval. */
export function parseWriteOutcome(raw: string): ThinQualificationWrite {
  const marker = (name: string) =>
    new RegExp(`^pgcf-${name}=([0-9.]+)$`, "m").exec(raw)?.[1];
  const rc = marker("rc"),
    start = marker("start"),
    end = marker("end"),
    written = marker("written") ?? /^(\d+) bytes\b/m.exec(raw)?.[1];
  if (
    rc === undefined ||
    !/^\d{1,3}$/.test(rc) ||
    Number(rc) > 255 ||
    start === undefined ||
    end === undefined ||
    !/^\d+(?:\.\d+)?$/.test(start) ||
    !/^\d+(?:\.\d+)?$/.test(end) ||
    Number(end) < Number(start)
  )
    fail("write_outcome_invalid");
  const exit = Number(rc);
  return ThinQualificationWrite.parse({
    exit_code: exit,
    error:
      exit === 0
        ? null
        : /No space left on device/.test(raw)
          ? "enospc"
          : /Input\/output error/.test(raw)
            ? "eio"
            : "other",
    written_bytes:
      written === undefined ? 0 : integer(written, "write_outcome_invalid"),
    milliseconds: Math.round((Number(end) - Number(start)) * 1000),
  });
}
/** `dumpe2fs` group lines; eager ext4 initialization leaves every inode table zeroed. */
export function parseDumpe2fsGroups(raw: string) {
  const groups = raw
    .split("\n")
    .filter((line) => /^Group \d+: /.test(line.trim()));
  if (!groups.length) fail("filesystem_groups_invalid");
  return {
    groups: groups.length,
    zeroed: groups.filter((line) => /\bITABLE_ZEROED\b/.test(line)).length,
  };
}
/** Kernel dm-thin pool mode transitions for one pool device, in log order. */
export function parseKernelPoolModes(raw: string, device: string): string[] {
  if (!/^\d+:\d+$/.test(device)) fail("pool_device_invalid");
  const pattern = new RegExp(
    `device-mapper: thin: ${device}: switching pool to (.+?) mode`,
  );
  return raw
    .split("\n")
    .map((line) => pattern.exec(line)?.[1])
    .filter((mode): mode is string => mode !== undefined)
    .slice(-64);
}
/** psql returns one committed id per acknowledged autocommit INSERT, in order. */
export function parseAcknowledged(raw: string) {
  const ids = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map((line) => integer(line, "acknowledged_ids_invalid"));
  for (let index = 1; index < ids.length; index++)
    if (ids[index] !== ids[index - 1]! + 1) fail("acknowledged_ids_invalid");
  return {
    first: ids[0] ?? null,
    last: ids.at(-1) ?? null,
    count: ids.length,
  };
}
/** The privileged driver container must see the host device tree to suspend DM devices. */
export function thinDriverDeviceView(daemonSet: unknown): boolean {
  const spec = object(object(object(object(daemonSet).spec).template).spec),
    volumes = Array.isArray(spec.volumes) ? spec.volumes.map(object) : [],
    containers = Array.isArray(spec.containers)
      ? spec.containers.map(object)
      : [];
  const names = volumes
    .filter((volume) => object(volume.hostPath ?? {}).path === "/dev")
    .map((volume) => volume.name);
  const driver = containers.find(
    (container) => container.name === "openebs-lvm-plugin",
  );
  return Boolean(
    driver &&
    object(driver.securityContext ?? {}).privileged === true &&
    Array.isArray(driver.volumeMounts) &&
    driver.volumeMounts
      .map(object)
      .some(
        (mount) =>
          names.includes(mount.name) &&
          mount.mountPath === "/dev" &&
          mount.readOnly !== true,
      ),
  );
}

export interface QualificationLv {
  name: string;
  lv_uuid: string;
  size_bytes: number;
  segtype: string;
  pool_lv: string;
  attr: string;
  data_percent: number | null;
  metadata_percent: number | null;
  metadata_bytes: number | null;
  chunk_bytes: number | null;
  when_full: string;
  tags: string[];
  major: number | null;
  minor: number | null;
  health: string;
}
export interface QualificationLvm {
  volume_group_uuid: string;
  total_bytes: number;
  free_bytes: number;
  extent_bytes: number;
  volumes: QualificationLv[];
  active: string[];
}
/** Complete `lvs -a` + kernel inventory; empty LVM percentages stay unknown, never zero. */
export function parseQualificationLvm(
  vgs: string,
  lvs: string,
  dm: string,
): QualificationLvm {
  const groups = lvmRows(vgs, "vg");
  if (groups.length !== 1) fail("volume_group_ambiguous");
  const group = groups[0]!;
  if (
    group.vg_name !== "pgcf" ||
    text(group.vg_permissions) !== "writeable" ||
    bytes(group.vg_missing_pv_count) !== 0 ||
    bytes(group.pv_count) !== 1
  )
    fail("volume_group_changed");
  const vg = lvmUid(group.vg_uuid);
  const percent = (value: unknown) => {
    const raw = text(value);
    if (raw === "") return null;
    if (!/^\d+(?:\.\d+)?$/.test(raw) || Number(raw) > 100)
      fail("lvm_percent_invalid");
    return Number(raw);
  };
  const optional = (value: unknown) =>
    text(value) === "" ? null : bytes(value);
  const kernel = (value: unknown) => {
    const raw = text(value);
    return raw === "" || raw === "-1" ? null : bytes(raw);
  };
  const seen = new Set<string>();
  const volumes = lvmRows(lvs, "lv").map((row) => {
    const lv_uuid = lvmUid(row.lv_uuid);
    if (seen.has(lv_uuid) || row.vg_uuid !== vg)
      fail("logical_volumes_changed");
    seen.add(lv_uuid);
    return {
      name: text(row.lv_name),
      lv_uuid,
      size_bytes: bytes(row.lv_size),
      segtype: text(row.segtype),
      pool_lv: text(row.pool_lv),
      attr: text(row.lv_attr),
      data_percent: percent(row.data_percent),
      metadata_percent: percent(row.metadata_percent),
      metadata_bytes: optional(row.lv_metadata_size),
      chunk_bytes: optional(row.chunk_size),
      when_full: text(row.lv_when_full),
      tags: text(row.lv_tags).split(",").filter(Boolean),
      major: kernel(row.lv_kernel_major),
      minor: kernel(row.lv_kernel_minor),
      health: text(row.lv_health_status),
    };
  });
  const prefix = `LVM-${hex(vg)}`,
    active = new Set<string>();
  for (const raw of dm
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length),
      lv = volumes.find((value) => rest.startsWith(hex(value.lv_uuid)));
    if (!lv) fail("kernel_volume_unexplained");
    active.add(lv.lv_uuid);
  }
  return {
    volume_group_uuid: vg,
    total_bytes: bytes(group.vg_size),
    free_bytes: bytes(group.vg_free),
    extent_bytes: bytes(group.vg_extent_size),
    volumes,
    active: [...active].sort(),
  };
}

type Facts = Record<string, unknown>;
interface ExecutorOptions {
  run?: typeof runCommand;
  request?: typeof fetch;
  proxy?: typeof startCapabilityProxy;
  signal?: AbortSignal;
}
/** Every mutating step is checkpointed in Cloudflare before dispatch; an unresolved one never repeats. */
export class QualificationJournal {
  private readonly entries: Map<string, ThinQualificationJournalEntry>;
  private revision: number;
  private readonly save: (
    expected: number,
    entry: ThinQualificationJournalEntry,
  ) => Promise<number>;
  constructor(
    journal: ThinQualificationJournal,
    save: (
      expected: number,
      entry: ThinQualificationJournalEntry,
    ) => Promise<number>,
  ) {
    this.entries = new Map(journal.entries.map((entry) => [entry.key, entry]));
    this.revision = journal.revision;
    this.save = save;
  }
  entry(key: string) {
    return this.entries.get(key);
  }
  keys(prefix: string) {
    return [...this.entries.keys()].filter((key) => key.startsWith(prefix));
  }
  async put(
    key: string,
    state: "dispatched" | "confirmed",
    nonce: string,
    facts: Facts | null,
  ) {
    const entry = ThinQualificationJournalEntry.parse({
      key,
      state,
      nonce,
      at: new Date().toISOString(),
      facts,
    });
    this.revision = await this.save(this.revision, entry);
    this.entries.set(key, entry);
  }
  /** Read-only measurement, recorded once. */
  async observe<T extends Facts>(key: string, read: () => Promise<T>) {
    const entry = this.entries.get(key);
    if (entry?.state === "confirmed") return entry.facts as T;
    if (entry) fail("journal_invalid");
    const facts = await read();
    await this.put(key, "confirmed", newOperationId(), facts);
    return facts;
  }
  /** One bounded write whose result exists only in its own output; an interrupted one is unknown. */
  async measure<T extends Facts>(key: string, run: () => Promise<T>) {
    const entry = this.entries.get(key);
    if (entry?.state === "confirmed") return entry.facts as T;
    if (entry) fail("measurement_outcome_unknown");
    const nonce = newOperationId();
    await this.put(key, "dispatched", nonce, null);
    const facts = await run();
    await this.put(key, "confirmed", nonce, facts);
    return facts;
  }
  /** A write whose outcome is resolved only by a fresh read of the owned object. */
  async act<T extends Facts>(
    key: string,
    mutate: (nonce: string) => Promise<unknown>,
    resolve: (nonce: string) => Promise<T | null>,
    options: {
      /** Fresh identity and preflight reads, before the durable dispatch checkpoint. */
      prepare?: (nonce: string) => Promise<void>;
      /** An already satisfied target is confirmed without any write. */
      satisfied?: boolean;
    } = {},
  ) {
    const entry = this.entries.get(key);
    if (entry?.state === "confirmed") return entry.facts as T;
    if (entry) {
      const resolved = await resolve(entry.nonce);
      if (resolved === null) fail("write_outcome_unknown");
      await this.put(key, "confirmed", entry.nonce, resolved);
      return resolved;
    }
    const nonce = newOperationId(),
      existing = await resolve(nonce);
    if (existing !== null) {
      if (!options.satisfied) fail("resource_preexisting");
      await this.put(key, "confirmed", nonce, existing);
      return existing;
    }
    await options.prepare?.(nonce);
    await this.put(key, "dispatched", nonce, null);
    try {
      await mutate(nonce);
    } catch (error) {
      if (error instanceof Yield) throw error;
      /* Resolve an uncertain command from the owned object, never by repeating it. */
    }
    const resolved = await resolve(nonce);
    if (resolved === null) fail("write_unconfirmed");
    await this.put(key, "confirmed", nonce, resolved);
    return resolved;
  }
  /** Removal of owned scratch objects converges from fresh reads; each pass is preconditioned. */
  async converge<T extends Facts>(key: string, run: () => Promise<T>) {
    const entry = this.entries.get(key);
    if (entry?.state === "confirmed") return entry.facts as T;
    const nonce = entry?.nonce ?? newOperationId();
    if (!entry) await this.put(key, "dispatched", nonce, null);
    const facts = await run();
    await this.put(key, "confirmed", nonce, facts);
    return facts;
  }
}

interface PoolFacts extends Facts {
  pool_uuid: string;
  data_bytes: number;
  metadata_bytes: number;
  chunk_bytes: number;
  when_full: string;
  zeroing: boolean;
  tags: string[];
}
interface VolumeFacts extends Facts {
  claim_uid: string;
  pv_name: string;
  pv_uid: string;
  lv_uuid: string;
  minor: number;
}
type PodKind = "postgres" | "sleep" | "block";

class Qualifier {
  readonly input: ThinQualificationInput;
  readonly run: ThinQualificationInput["run"];
  readonly profile: ThinStorageProfile;
  readonly session: ThinSession;
  readonly journal: QualificationJournal;
  readonly deadline: number;
  readonly namespace: string;
  readonly scratchClass: string;
  readonly tinyPool: string;
  readonly tinyVolume: string;
  readonly rawPrefix: string;
  readonly probeVolume: string;
  readonly tag: string;
  readonly options: ExecutorOptions;
  node!: ThinNode;
  vg: string | null;
  constructor(
    input: ThinQualificationInput,
    session: ThinSession,
    journal: QualificationJournal,
    deadline: number,
    options: ExecutorOptions,
  ) {
    const suffix = input.run.id.slice(3);
    this.input = input;
    this.run = input.run;
    this.profile = input.run.profile;
    this.session = session;
    this.journal = journal;
    this.deadline = deadline;
    this.options = options;
    this.namespace = `pgcf-thin-q-${suffix}`;
    this.scratchClass = `pgcf-thin-q-${suffix}`;
    this.tinyPool = `pgcf_thin_q_${suffix}`;
    this.tinyVolume = `pgcf_thin_q_${suffix}_m`;
    this.rawPrefix = `pgcf_thin_q_${suffix}_v`;
    this.probeVolume = `pgcf_thin_q_${suffix}_p`;
    this.tag = `pgcf.thin-q.${input.run.id}`;
    this.vg =
      input.run.setup?.identity.volume_group_uuid ??
      (this.baselineFacts()?.identity.volume_group_uuid as
        string | undefined) ??
      null;
  }
  private get setup(): ThinQualificationSetup {
    if (!this.run.setup) fail("setup_missing");
    return this.run.setup;
  }
  /** The untouched VG inventory, also after an interrupted setup turn. */
  private baselineFacts() {
    const facts = this.journal.entry("setup:baseline")?.facts;
    return facts
      ? {
          identity: object(facts.identity),
          logical_volumes: facts.logical_volumes as {
            name: string;
            lv_uuid: string;
          }[],
          volume_group_free_bytes: Number(facts.volume_group_free_bytes),
        }
      : null;
  }
  private remaining() {
    return this.deadline - Date.now();
  }
  /** A bounded command starts only with enough turn budget left to finish it. */
  private room(milliseconds: number) {
    if (this.remaining() < milliseconds + 15_000) throw new Yield();
  }
  private async wait(milliseconds = 2000) {
    this.session.signal.throwIfAborted();
    if (this.remaining() < milliseconds + 20_000) throw new Yield();
    await delay(milliseconds, undefined, { signal: this.session.signal });
  }
  private async lease() {
    const current = object(await this.session.call({ kind: "status" }));
    if (
      current.run_id !== this.run.id ||
      current.step !== this.run.step ||
      current.lease_id !== this.run.lease.operation_id ||
      current.lease_revision !== this.run.lease.revision ||
      current.node_uid !== this.run.node_uid ||
      current.release_id !== this.run.release_id ||
      current.spec_sha256 !== this.run.spec_sha256
    )
      fail("lease_changed");
  }
  async connect() {
    // Cleanup only removes owned objects and resumes owned LVs by DM UUID. A later boot,
    // kernel, driver or host extension must not strand them; identity fences still apply.
    const cleanup = this.run.step === "cleanup",
      setup = cleanup ? null : this.run.setup;
    this.node = await verifyThinNode(
      this.session,
      {
        node_id: this.run.node_id,
        region_id: this.run.region_id,
        node_uid: this.run.node_uid,
        cluster_uid: this.run.cluster_uid,
        name: this.run.name,
        provider_instance_id: this.run.provider_instance_id,
        driver_image: cleanup ? null : this.profile.driver_image,
        host_extension_version: cleanup
          ? null
          : this.input.host_extension.version,
        boot_id: setup?.identity.boot_id ?? null,
        kernel_version: setup?.identity.kernel_version ?? null,
      },
      () => this.lease(),
    );
    if (!thinDriverDeviceView(this.node.daemonSet))
      fail("driver_device_view_missing");
  }

  // Physical LVM and device-mapper reads through the driver container.
  private async lvm(): Promise<QualificationLvm> {
    const [vg, lv, dm] = await Promise.all(
      thinLvmReadCommands(QUALIFICATION_LV_FIELDS).map((args) =>
        this.node.driverExec(args),
      ),
    );
    const value = parseQualificationLvm(vg!.stdout, lv!.stdout, dm!.stdout);
    if (this.vg !== null && value.volume_group_uuid !== this.vg)
      fail("volume_group_identity_changed");
    return value;
  }
  private dmUuid(lvUuid: string, suffix = "") {
    if (!this.vg) fail("volume_group_unknown");
    return `LVM-${hex(this.vg)}${hex(lvUuid)}${suffix}`;
  }
  private async deviceInfo(lvUuid: string, suffix = "") {
    return parseDmInfo(
      (
        await this.node.driverExec([
          "dmsetup",
          "info",
          "--uuid",
          this.dmUuid(lvUuid, suffix),
        ])
      ).stdout,
    );
  }
  private async poolStatus(poolUuid: string) {
    return parseThinPoolStatus(
      (
        await this.node.driverExec([
          "dmsetup",
          "status",
          "--uuid",
          this.dmUuid(poolUuid, "-tpool"),
        ])
      ).stdout,
    );
  }
  private async pool(name = POOL) {
    const lvm = await this.lvm(),
      volume = lvm.volumes.find(
        (value) => value.name === name && value.segtype === "thin-pool",
      );
    if (!volume) return null;
    const [status, info] = await Promise.all([
      this.poolStatus(volume.lv_uuid),
      this.deviceInfo(volume.lv_uuid, "-tpool"),
    ]);
    return { volume, status, device: info.device, lvm };
  }
  private async requirePool(expected?: string) {
    const pool = await this.pool();
    if (!pool || (expected && pool.volume.lv_uuid !== expected))
      fail("pool_identity_changed");
    return pool;
  }
  private async driverScript(
    script: string,
    args: string[],
    timeout = 10000,
  ): Promise<CommandResult> {
    return await this.node.driverExec(
      ["sh", "-c", script, "pgcf", ...args],
      true,
      timeout,
    );
  }
  /** The exact product pool command and checks, for one owned action nonce. */
  private async poolCommand(action: {
    kind: "initialize" | "grow";
    nonce: string;
    target: number;
    pool: string | null;
  }) {
    await this.node.freshDriver();
    return thinPoolCommand(
      {
        lease: {
          volume_group_uuid: this.vg!,
          node_uid: this.run.node_uid,
          profile: this.profile,
        },
      },
      await this.node.readLvm(),
      {
        kind: action.kind,
        state: "pending",
        nonce: action.nonce,
        target_data_bytes: action.target,
        target_metadata_bytes: this.profile.metadata_bytes,
        expected_pool_uuid: action.pool,
        driver_pod_uid: null,
        boot_id: null,
        dispatched_at: null,
        deadline_at: null,
      },
    );
  }
  private async createPool(key: string, dataBytes: number) {
    let args: string[] | null = null;
    return await this.journal.act<PoolFacts>(
      key,
      async () => {
        if (!args) fail("pool_unexpected");
        await this.node.driverExec(args, false, 60_000);
      },
      async (nonce) => {
        const pool = await this.pool();
        if (!pool) return null;
        if (
          !pool.volume.tags.includes(`pgcf.action.${nonce}`) ||
          !pool.volume.tags.includes(`pgcf.node.${this.run.node_uid}`)
        )
          fail("pool_not_owned");
        return {
          pool_uuid: pool.volume.lv_uuid,
          data_bytes: pool.volume.size_bytes,
          metadata_bytes: pool.volume.metadata_bytes ?? 0,
          chunk_bytes: pool.volume.chunk_bytes ?? 0,
          when_full: pool.volume.when_full,
          zeroing: pool.volume.attr[7] === "z",
          tags: pool.volume.tags,
        };
      },
      {
        prepare: async (nonce) => {
          args = await this.poolCommand({
            kind: "initialize",
            nonce,
            target: dataBytes,
            pool: null,
          });
        },
      },
    );
  }
  /** The product grow command against the exact current pool UUID and VG headroom. */
  private async growPool(key: string, poolUuid: string, target: number) {
    let args: string[] | null = null;
    return await this.journal.act(
      key,
      async () => {
        if (args) await this.node.driverExec(args, false, 60_000);
      },
      async () => {
        const pool = await this.requirePool(poolUuid);
        return pool.volume.size_bytes >= target
          ? {
              pool_uuid: pool.volume.lv_uuid,
              data_bytes: pool.volume.size_bytes,
            }
          : null;
      },
      {
        satisfied: true,
        prepare: async (nonce) => {
          args = await this.poolCommand({
            kind: "grow",
            nonce,
            target,
            pool: poolUuid,
          });
        },
      },
    );
  }

  // Kubernetes objects owned by this run only.
  private annotations() {
    return {
      [OWNER]: this.run.id,
      "pgcf.io/thin-qualification-node-uid": this.run.node_uid,
    };
  }
  private async read(
    kind: string,
    name: string,
    namespaced = true,
  ): Promise<ObjectValue | null> {
    const result = await this.session.kube([
      "get",
      kind,
      name,
      ...(namespaced ? ["--namespace", this.namespace] : []),
      "--ignore-not-found",
      "--output=json",
    ]);
    if (!result.stdout.trim()) return null;
    const value = object(JSON.parse(result.stdout));
    if (object(metadata(value).annotations ?? {})[OWNER] !== this.run.id)
      fail("resource_not_owned");
    return value;
  }
  private async create(
    key: string,
    kind: string,
    manifest: Json,
    namespaced = true,
  ) {
    const name = String(object(manifest.metadata).name);
    return await this.journal.act(
      key,
      async () => {
        await this.node.authorize();
        await this.session.kube(
          ["create", "--filename=-", "--output=json"],
          JSON.stringify(manifest),
          true,
        );
      },
      async () => {
        const value = await this.read(kind, name, namespaced);
        return value ? { uid: uid(metadata(value).uid) } : null;
      },
    );
  }
  private async remove(
    kind:
      | "pod"
      | "persistentvolumeclaim"
      | "namespace"
      | "storageclass"
      | "volumeattributesclass",
    name: string,
    grace?: 0,
  ) {
    const namespaced = kind === "pod" || kind === "persistentvolumeclaim";
    const value = await this.read(kind, name, namespaced);
    if (!value || metadata(value).deletionTimestamp) return Boolean(value);
    const path =
      kind === "namespace"
        ? `/api/v1/namespaces/${name}`
        : kind === "pod"
          ? `/api/v1/namespaces/${this.namespace}/pods/${name}`
          : kind === "persistentvolumeclaim"
            ? `/api/v1/namespaces/${this.namespace}/persistentvolumeclaims/${name}`
            : `/apis/storage.k8s.io/v1/${kind === "storageclass" ? "storageclasses" : "volumeattributesclasses"}/${name}`;
    const request = storageDeleteRequest(
      path,
      {
        uid: uid(metadata(value).uid),
        resourceVersion: text(metadata(value).resourceVersion),
      },
      grace,
    );
    await this.node.authorize();
    await this.session.kube(request.args, request.stdin, true);
    return true;
  }
  private async absent(
    kind: Parameters<Qualifier["remove"]>[0],
    name: string,
    grace?: 0,
  ) {
    while (await this.remove(kind, name, grace)) await this.wait();
  }
  private claimManifest(
    name: string,
    size: number,
    block: boolean,
    attributes: boolean,
  ) {
    return {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name,
        namespace: this.namespace,
        annotations: this.annotations(),
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        volumeMode: block ? "Block" : "Filesystem",
        storageClassName: this.scratchClass,
        ...(attributes ? { volumeAttributesClassName: this.scratchClass } : {}),
        resources: { requests: { storage: String(size) } },
      },
    };
  }
  private podManifest(name: string, kind: PodKind) {
    const script =
      kind === "postgres"
        ? `set -eu
export PGDATA=/data/pgdata
if [ ! -s "$PGDATA/PG_VERSION" ]; then initdb -D "$PGDATA" --username=postgres --no-locale --encoding=UTF8 --auth=trust >/work/initdb.log 2>&1; fi
exec postgres -D "$PGDATA" -k /run/q -c listen_addresses= -c shared_buffers=32MB -c max_connections=10 -c fsync=on -c synchronous_commit=on -c full_page_writes=on -c restart_after_crash=off`
        : "exec sleep infinity";
    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name,
        namespace: this.namespace,
        annotations: this.annotations(),
      },
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        terminationGracePeriodSeconds: 5,
        nodeSelector: {
          "pgcf.io/node-id": this.run.node_id,
          "pgcf.io/region": this.run.region_id,
          "pgcf.io/provider-instance-id": this.run.provider_instance_id,
        },
        affinity: {
          nodeAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: {
              nodeSelectorTerms: [
                {
                  matchFields: [
                    {
                      key: "metadata.name",
                      operator: "In",
                      values: [this.run.name],
                    },
                  ],
                },
              ],
            },
          },
        },
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 26,
          runAsGroup: 26,
          fsGroup: 26,
          seccompProfile: { type: "RuntimeDefault" },
        },
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: name } },
          { name: "work", emptyDir: { sizeLimit: "64Mi" } },
          { name: "socket", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
        ],
        containers: [
          {
            name: "q",
            image: this.run.postgres_image,
            imagePullPolicy: "IfNotPresent",
            command: ["/bin/bash", "-c", script],
            env: [{ name: "HOME", value: "/work" }],
            resources: {
              requests: { cpu: "250m", memory: "256Mi" },
              limits: { cpu: "1", memory: "1Gi" },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            ...(kind === "block"
              ? { volumeDevices: [{ name: "data", devicePath: "/dev/pgcf-q" }] }
              : {}),
            volumeMounts: [
              ...(kind === "block"
                ? []
                : [{ name: "data", mountPath: "/data" }]),
              { name: "work", mountPath: "/work" },
              { name: "socket", mountPath: "/run/q" },
            ],
          },
        ],
      },
    };
  }
  /**
   * One scratch PVC on the identical profile class and one bound Pod on this node. Once the
   * `stopping` key is journaled the run itself may have stopped, crashed or replaced the Pod,
   * so a resumed turn keeps the journaled volume and never re-checks that Pod.
   */
  private async workload(
    step: string,
    name: string,
    kind: PodKind,
    size: number,
    attributes: boolean,
    stopping = `${step}:${name}:release`,
  ) {
    const volume = this.journal.entry(`${step}:${name}:volume`);
    if (volume?.state === "confirmed" && this.journal.entry(stopping))
      return volume.facts as VolumeFacts;
    await this.create(
      `${step}:${name}:claim`,
      "persistentvolumeclaim",
      this.claimManifest(name, size, kind === "block", attributes),
    );
    const pod = await this.create(
      `${step}:${name}:pod`,
      "pod",
      this.podManifest(name, kind),
    );
    await this.running(name, String(pod.uid));
    return await this.journal.observe<VolumeFacts>(
      `${step}:${name}:volume`,
      async () => {
        for (;;) {
          const volume = await this.volume(name);
          if (volume) return volume;
          await this.wait();
        }
      },
    );
  }
  private async running(name: string, podUid?: string) {
    for (;;) {
      const pod = await this.read("pod", name);
      if (!pod || (podUid && metadata(pod).uid !== podUid))
        fail("pod_replaced");
      const phase = object(pod.status).phase;
      if (phase === "Failed" || phase === "Succeeded") fail("pod_terminated");
      if (phase === "Running" && object(pod.spec).nodeName === this.run.name)
        return pod;
      if (
        object(pod.spec).nodeName !== undefined &&
        object(pod.spec).nodeName !== this.run.name
      )
        fail("pod_node_changed");
      await this.wait();
    }
  }
  private async volume(claim: string): Promise<VolumeFacts | null> {
    const pvc = await this.read("persistentvolumeclaim", claim);
    if (!pvc) fail("claim_missing");
    const spec = object(pvc.spec),
      claimUid = uid(metadata(pvc).uid);
    if (typeof spec.volumeName !== "string" || !spec.volumeName) return null;
    if (
      spec.volumeName !== `pvc-${claimUid}` ||
      spec.storageClassName !== this.scratchClass
    )
      fail("claim_changed");
    const pv = await this.persistentVolume(spec.volumeName);
    if (!pv) return null;
    const lv = (await this.lvm()).volumes.find(
      (value) => value.name === spec.volumeName,
    );
    if (!lv || lv.minor === null) return null;
    if (lv.segtype !== "thin" || lv.pool_lv !== POOL)
      fail("claim_volume_changed");
    return {
      claim_uid: claimUid,
      pv_name: spec.volumeName,
      pv_uid: uid(metadata(pv).uid),
      lv_uuid: lv.lv_uuid,
      minor: lv.minor,
    };
  }
  private async persistentVolume(name: string) {
    const result = await this.session.kube([
      "get",
      "persistentvolume",
      name,
      "--ignore-not-found",
      "--output=json",
    ]);
    if (!result.stdout.trim()) return null;
    const pv = object(JSON.parse(result.stdout)),
      spec = object(pv.spec),
      claim = object(spec.claimRef ?? {}),
      csi = object(spec.csi ?? {});
    if (
      claim.namespace !== this.namespace ||
      spec.storageClassName !== this.scratchClass ||
      csi.driver !== "local.csi.openebs.io" ||
      csi.volumeHandle !== name
    )
      fail("volume_not_owned");
    return pv;
  }
  /** Pod, PVC, retained PV and its LV are removed and the LV is absent from LVM and DM. */
  private async releaseWorkload(step: string, name: string) {
    const volume = this.journal.entry(`${step}:${name}:volume`)?.facts as
      VolumeFacts | undefined;
    return await this.journal.converge(`${step}:${name}:release`, async () => {
      await this.absent("pod", name, 0);
      if (volume) {
        const pv = await this.persistentVolume(volume.pv_name);
        if (pv && object(pv.spec).persistentVolumeReclaimPolicy === "Retain") {
          const m = metadata(pv);
          const patch = [
            { op: "test", path: "/metadata/uid", value: volume.pv_uid },
            {
              op: "test",
              path: "/metadata/resourceVersion",
              value: text(m.resourceVersion),
            },
            {
              op: "test",
              path: "/spec/claimRef/uid",
              value: volume.claim_uid,
            },
            {
              op: "test",
              path: "/spec/persistentVolumeReclaimPolicy",
              value: "Retain",
            },
            {
              op: "add",
              path: "/spec/persistentVolumeReclaimPolicy",
              value: "Delete",
            },
          ];
          await this.node.authorize();
          await this.session.kube(
            [
              "patch",
              "persistentvolume",
              volume.pv_name,
              "--type=json",
              "--patch",
              JSON.stringify(patch),
              "--output=json",
            ],
            undefined,
            true,
          );
        }
      }
      await this.absent("persistentvolumeclaim", name);
      if (volume) {
        for (;;) {
          const pv = await this.persistentVolume(volume.pv_name);
          const lvm = await this.lvm();
          if (
            !pv &&
            !lvm.volumes.some((lv) => lv.lv_uuid === volume.lv_uuid) &&
            !lvm.active.includes(volume.lv_uuid)
          )
            break;
          await this.wait();
        }
      }
      return { released: true };
    });
  }
  private async exec(
    pod: string,
    args: string[],
    timeout = 10000,
  ): Promise<CommandResult> {
    return await this.session.kube(
      [
        "exec",
        "--namespace",
        this.namespace,
        pod,
        "--container",
        "q",
        "--",
        ...args,
      ],
      undefined,
      true,
      timeout,
    );
  }
  private async postgresReady(pod: string) {
    for (;;) {
      const status = await this.read("pod", pod);
      if (!status) fail("pod_missing");
      const phase = object(status.status).phase;
      if (phase === "Failed" || phase === "Succeeded") fail("postgres_failed");
      if (phase === "Running") {
        const probe = await this.exec(pod, [
          "pg_isready",
          "-h",
          "/run/q",
          "-U",
          "postgres",
          "-q",
        ]);
        if (probe.exit_code === 0) return status;
      }
      await this.wait();
    }
  }
  private async sql(pod: string, statements: string[], timeout = 30000) {
    const result = await this.exec(
      pod,
      [
        "psql",
        "-X",
        "-q",
        "-h",
        "/run/q",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        ...statements.flatMap((statement) => ["-c", statement]),
      ],
      timeout,
    );
    if (result.exit_code !== 0) fail("sql_failed");
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  /** Bounded autocommit INSERTs; each printed id is an acknowledged commit. */
  private async acknowledge(pod: string, count: number) {
    const result = await this.exec(
      pod,
      [
        "/bin/bash",
        "-c",
        `n=$1; i=0
{ while [ "$i" -lt "$n" ]; do i=$((i+1)); printf "INSERT INTO q(v) VALUES (repeat('a', 2048)) RETURNING id;\\n"; done; } | psql -X -q -h /run/q -U postgres -d postgres -At -v ON_ERROR_STOP=1 -f - 2>&1
printf 'pgcf-rc=%s\\n' "$?"`,
        "pgcf",
        String(count),
      ],
      240_000,
    );
    return parseAcknowledged(result.stdout);
  }
  /** Direct writes from the pinned PostgreSQL image; dd output is parsed, never assumed. */
  private async podWrite(
    pod: string,
    path: string,
    block: string,
    count: number | null,
    timeout: number,
  ) {
    const result = await this.exec(
      pod,
      [
        "/bin/bash",
        "-c",
        `start=$(cut -d' ' -f1 /proc/uptime)
if [ -n "$3" ]; then out=$(dd if=/dev/zero of="$1" bs="$2" count="$3" oflag=direct conv=notrunc 2>&1); else out=$(dd if=/dev/zero of="$1" bs="$2" oflag=direct conv=notrunc 2>&1); fi
rc=$?
end=$(cut -d' ' -f1 /proc/uptime)
printf '%s\\npgcf-rc=%s\\npgcf-start=%s\\npgcf-end=%s\\n' "$out" "$rc" "$start" "$end"`,
        "pgcf",
        path,
        block,
        count === null ? "" : String(count),
      ],
      timeout,
    );
    return parseWriteOutcome(result.stdout);
  }
  /** Direct raw device writes from the privileged driver container. */
  private async deviceWrite(
    device: string,
    source: "zero" | "urandom",
    block: string,
    seek: number,
    count: number | null,
    timeout: number,
  ) {
    const result = await this.driverScript(
      `start=$(cut -d' ' -f1 /proc/uptime)
if [ -n "$5" ]; then out=$(dd if="/dev/$2" of="$1" bs="$3" seek="$4" count="$5" oflag=direct conv=notrunc 2>&1); else out=$(dd if="/dev/$2" of="$1" bs="$3" seek="$4" oflag=direct conv=notrunc 2>&1); fi
rc=$?
end=$(cut -d' ' -f1 /proc/uptime)
printf '%s\\npgcf-rc=%s\\npgcf-start=%s\\npgcf-end=%s\\n' "$out" "$rc" "$start" "$end"`,
      [
        device,
        source,
        block,
        String(seek),
        count === null ? "" : String(count),
      ],
      timeout,
    );
    return parseWriteOutcome(result.stdout);
  }
  private async deviceSha(device: string, megabytes: number) {
    const result = await this.driverScript(
      'dd if="$1" bs=1048576 count="$2" 2>/dev/null | sha256sum',
      [device, String(megabytes)],
      60_000,
    );
    const sha = /^([0-9a-f]{64})\s/.exec(result.stdout)?.[1];
    if (result.exit_code !== 0 || !sha) fail("device_read_failed");
    return sha;
  }
  /** One driver command timed inside the container with /proc/uptime. */
  private async timed(command: string[], timeout = 60_000) {
    const result = await this.driverScript(
      `start=$(cut -d' ' -f1 /proc/uptime)
"$@" >/dev/null 2>&1
rc=$?
end=$(cut -d' ' -f1 /proc/uptime)
printf 'pgcf-rc=%s\\npgcf-start=%s\\npgcf-end=%s\\n' "$rc" "$start" "$end"`,
      command,
      timeout,
    );
    const outcome = parseWriteOutcome(result.stdout);
    return { exit_code: outcome.exit_code, milliseconds: outcome.milliseconds };
  }
  private async kernelModes(device: string) {
    return parseKernelPoolModes(
      await this.session.talos(["dmesg"], 30_000),
      device,
    );
  }
  private async memoryDirty(podUid: string) {
    const result = await this.node.driverExec([
      "sh",
      "-ec",
      'for p do if [ -r "$p" ]; then cat "$p"; exit 0; fi; done; exit 1',
      "--",
      ...thinPodCgroupPaths(podUid).map((path) =>
        path.replace(/\/io\.max$/, "/memory.stat"),
      ),
    ]);
    return parseMemoryStatDirty(result.stdout);
  }
  private async blockStat(minor: number) {
    return parseBlockStat(
      (await this.node.driverExec(["cat", `/sys/block/dm-${minor}/stat`]))
        .stdout,
    );
  }

  // Retained thick identities: LVM, PV/PVC, OpenEBS LVMVolume and CNPG health.
  private async thick(
    lvm?: QualificationLvm,
  ): Promise<ThinQualificationThickSnapshot> {
    const inventory = lvm ?? (await this.lvm());
    const volumes = inventory.volumes
      .filter(
        (lv) =>
          lv.segtype === "linear" &&
          lv.pool_lv === "" &&
          !lv.name.startsWith("["),
      )
      .map((lv) => ({
        name: lv.name,
        lv_uuid: lv.lv_uuid,
        size_bytes: lv.size_bytes,
        segtype: lv.segtype,
      }))
      .sort((a, b) => (a.lv_uuid < b.lv_uuid ? -1 : 1));
    const names = new Set(volumes.map((volume) => volume.name));
    const [pvs, lvms, clusters] = await Promise.all([
      this.session.get(["persistentvolumes"]),
      this.session.get([
        "lvmvolumes.local.openebs.io",
        "--namespace",
        "openebs",
      ]),
      this.session.get(["clusters.postgresql.cnpg.io", "--all-namespaces"]),
    ]);
    const claims = items(pvs.items)
      .filter(
        (pv) =>
          names.has(String(metadata(pv).name)) &&
          object(pv.spec).storageClassName === "pgcf-lvm",
      )
      .map((pv) => {
        const claim = object(object(pv.spec).claimRef ?? {});
        return {
          pv_name: text(metadata(pv).name),
          pv_uid: uid(metadata(pv).uid),
          pvc_uid: uid(claim.uid),
          namespace: text(claim.namespace),
        };
      })
      .sort((a, b) => (a.pv_uid < b.pv_uid ? -1 : 1));
    const namespaces = new Set(claims.map((claim) => claim.namespace));
    return {
      observed_at: new Date().toISOString(),
      thick_allocated_bytes: volumes.reduce(
        (sum, volume) => sum + volume.size_bytes,
        0,
      ),
      volumes,
      claims,
      lvm_volumes: items(lvms.items)
        .filter(
          (value) =>
            object(value.spec).ownerNodeID === this.run.name &&
            names.has(String(metadata(value).name)),
        )
        .map((value) => ({
          name: text(metadata(value).name),
          uid: uid(metadata(value).uid),
        }))
        .sort((a, b) => (a.uid < b.uid ? -1 : 1)),
      clusters: items(clusters.items)
        .filter((value) => namespaces.has(String(metadata(value).namespace)))
        .map((value) => {
          const conditions = Array.isArray(
            object(value.status ?? {}).conditions,
          )
            ? items(object(value.status).conditions)
            : [];
          const condition = (type: string) =>
            conditions.some((c) => c.type === type && c.status === "True");
          return {
            namespace: text(metadata(value).namespace),
            uid: uid(metadata(value).uid),
            ready: condition("Ready"),
            continuous_archiving: condition("ContinuousArchiving"),
          };
        })
        .sort((a, b) => (a.uid < b.uid ? -1 : 1)),
    };
  }

  async step(): Promise<ThinQualificationReport> {
    switch (this.run.step) {
      case "setup":
        return await this.setupStep();
      case "data_full":
        return await this.dataFull();
      case "metadata_full":
        return await this.metadataFull();
      case "noflush_quiescence":
        return await this.noflush();
      case "resume_marker":
        return await this.resumeMarker();
      case "startup_bound":
        return await this.startupBound();
      case "trim_delete_recreate":
        return await this.trim();
      case "retained_thick_preservation":
        return await this.retained();
      case "cleanup":
        return await this.cleanup();
    }
  }

  private async setupStep(): Promise<ThinQualificationReport> {
    const first = await this.journal.observe("setup:baseline", async () => {
      const lvm = await this.lvm();
      if (
        lvm.volumes.some(
          (lv) =>
            lv.segtype !== "linear" ||
            lv.name.startsWith("[") ||
            lv.name.startsWith("pgcf_thin"),
        )
      )
        fail("volume_group_not_clean");
      const driverStatus = items(
        object(this.node.driver.status).containerStatuses,
      ).find((value) => value.name === "openebs-lvm-plugin");
      return {
        identity: {
          node_uid: this.run.node_uid,
          cluster_uid: this.run.cluster_uid,
          boot_id: this.node.boot,
          system_uuid: this.node.systemUuid,
          kernel_version: text(this.node.nodeInfo.kernelVersion),
          volume_group_uuid: lvm.volume_group_uuid,
          volume_group_bytes: lvm.total_bytes,
          extent_bytes: lvm.extent_bytes,
          driver_pod_uid: this.node.driverUid,
          driver_image: this.profile.driver_image,
          driver_image_id: text(driverStatus?.imageID),
          driver_sha256: this.node.hashes[0],
          lvm_sha256: this.node.hashes[1],
          tools_sha256: this.node.hashes[2],
          thin_tools_version: this.node.tools,
          host_extension_image: this.input.host_extension.image,
          host_extension_version: this.input.host_extension.version,
          observed_at: new Date().toISOString(),
        },
        volume_group_free_bytes: lvm.free_bytes,
        logical_volumes: lvm.volumes.map((lv) => ({
          name: lv.name,
          lv_uuid: lv.lv_uuid,
          size_bytes: lv.size_bytes,
          segtype: lv.segtype,
        })),
        thick: await this.thick(lvm),
      };
    });
    const identity = object(first.identity);
    this.vg = String(identity.volume_group_uuid);
    const namespace = await this.create(
      "setup:namespace",
      "namespace",
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: this.namespace,
          annotations: this.annotations(),
          labels: {
            "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/enforce-version": "v1.36",
          },
        },
      },
      false,
    );
    await this.create("setup:network-policy", "networkpolicy", {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: "deny-all",
        namespace: this.namespace,
        annotations: this.annotations(),
      },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        ingress: [],
        egress: [],
      },
    });
    const quota = this.profile.maximum_quota_gib * GIB;
    await this.create("setup:quota", "resourcequota", {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: {
        name: "bounded",
        namespace: this.namespace,
        annotations: this.annotations(),
      },
      spec: {
        hard: {
          "count/pods": "4",
          "count/persistentvolumeclaims": "4",
          "requests.storage": String(
            2 * this.profile.maximum_data_bytes + 3 * quota,
          ),
          "requests.cpu": "2",
          "limits.cpu": "4",
          "requests.memory": "2Gi",
          "limits.memory": "4Gi",
        },
      },
    });
    const productClass = thinStorageClassObject(
        this.profile,
        this.run.profile_sha256,
      ),
      productAttributes = thinVolumeAttributesClassObject(
        this.profile,
        this.run.profile_sha256,
      );
    // Scratch class names never become customer storage; parameters equal the product class.
    const storageClass = await this.create(
      "setup:storage-class",
      "storageclass",
      {
        ...productClass,
        metadata: { name: this.scratchClass, annotations: this.annotations() },
      },
      false,
    );
    const attributesClass = await this.create(
      "setup:attributes-class",
      "volumeattributesclass",
      {
        ...productAttributes,
        metadata: { name: this.scratchClass, annotations: this.annotations() },
      },
      false,
    );
    const pool = await this.createPool(
      "setup:pool",
      this.profile.initial_data_bytes,
    );
    return {
      step: "setup",
      setup: {
        identity: identity as ThinQualificationSetup["identity"],
        volume_group_free_bytes: Number(first.volume_group_free_bytes),
        logical_volumes:
          first.logical_volumes as ThinQualificationSetup["logical_volumes"],
        thick: first.thick as ThinQualificationThickSnapshot,
        pool: {
          pool_uuid: pool.pool_uuid,
          data_bytes: pool.data_bytes,
          metadata_bytes: pool.metadata_bytes,
          chunk_bytes: pool.chunk_bytes,
          when_full: pool.when_full,
          zeroing: pool.zeroing,
          tags: pool.tags,
        },
        namespace_uid: String(namespace.uid),
        storage_class_uid: String(storageClass.uid),
        attributes_class_uid: String(attributesClass.uid),
      },
    };
  }

  private async dataFull(): Promise<ThinQualificationReport> {
    const poolUuid = this.setup.pool.pool_uuid,
      quota = this.profile.maximum_quota_gib * GIB,
      target = Math.min(
        this.profile.maximum_data_bytes,
        this.profile.initial_data_bytes + this.profile.growth_bytes,
      );
    const before = await this.journal.observe("data_full:pool", async () => {
      const pool = await this.requirePool(poolUuid);
      return { data_bytes: pool.volume.size_bytes, device: pool.device };
    });
    // PostgreSQL may crash once the fill exhausts the pool; it is replaced on the same PVC.
    const pg = await this.workload(
      "data_full",
      "pg-a",
      "postgres",
      quota,
      true,
      "data_full:fill",
    );
    if (!this.journal.entry("data_full:marker"))
      await this.postgresReady("pg-a");
    const marker = await this.journal.measure("data_full:marker", async () => ({
      rows: await this.sql("pg-a", [
        "CREATE TABLE IF NOT EXISTS q(id bigserial PRIMARY KEY, v text NOT NULL)",
        `INSERT INTO q(v) VALUES ('${MARKER}') RETURNING id`,
      ]),
    }));
    this.room(240_000);
    const pre = await this.journal.measure("data_full:pre", () =>
      this.acknowledge("pg-a", 64),
    );
    // Twice the maximum pool: the pool, never the filesystem, runs out of space first.
    const fillVolume = await this.workload(
      "data_full",
      "fill",
      "sleep",
      2 * this.profile.maximum_data_bytes,
      false,
    );
    // An unmapped raw thin LV in the same pool measures the pool's own error latency.
    const probeVolume = await this.journal.act(
      "data_full:probe-volume",
      async () => {
        await this.node.driverExec(
          [
            "lvcreate",
            "--thin",
            "--virtualsize",
            `${64 * MIB}B`,
            "--name",
            this.probeVolume,
            "--addtag",
            this.tag,
            `pgcf/${POOL}`,
          ],
          false,
          60_000,
        );
      },
      async () => {
        const lv = (await this.lvm()).volumes.find(
          (value) => value.name === this.probeVolume,
        );
        if (!lv) return null;
        if (!lv.tags.includes(this.tag) || lv.pool_lv !== POOL)
          fail("scratch_volume_not_owned");
        return lv.minor === null
          ? null
          : { lv_uuid: lv.lv_uuid, minor: lv.minor };
      },
      { prepare: () => this.node.freshDriver() },
    );
    this.room(480_000);
    const fill = await this.journal.measure("data_full:fill", () =>
      this.podWrite("fill", "/data/fill", "1M", null, 480_000),
    );
    const full = await this.journal.observe("data_full:full", async () => ({
      status: (await this.requirePool(poolUuid)).status,
    }));
    const probe = await this.journal.measure("data_full:probe", () =>
      this.deviceWrite(
        `/dev/dm-${Number(probeVolume.minor)}`,
        "zero",
        "65536",
        0,
        1,
        60_000,
      ),
    );
    this.room(240_000);
    const post = await this.journal.measure("data_full:post", () =>
      this.acknowledge("pg-a", 4096),
    );
    const grow = await this.growPool("data_full:grow", poolUuid, target);
    const grown = await this.journal.observe("data_full:grown", async () => {
      const pool = await this.requirePool(poolUuid),
        lvm = pool.lvm;
      return {
        status: pool.status,
        data_bytes: pool.volume.size_bytes,
        volumes: lvm.volumes
          .filter((lv) => lv.segtype === "thin" && lv.pool_lv === POOL)
          .map((lv) => lv.lv_uuid),
      };
    });
    await this.removeTagged("data_full:probe-remove", [this.probeVolume]);
    const restart = await this.restartPostgres("data_full", "pg-a");
    const ranges = [pre, post].filter((range) => range.count > 0) as {
      first: number;
      last: number;
      count: number;
    }[];
    const verify = await this.journal.observe("data_full:verify", async () => {
      const [markers, ...present] = await this.sql("pg-a", [
        `SELECT count(*) FROM q WHERE v='${MARKER}'`,
        ...ranges.map(
          (range) =>
            `SELECT count(*) FROM q WHERE id BETWEEN ${range.first} AND ${range.last}`,
        ),
      ]);
      return {
        marker_present: markers === "1",
        acknowledged_present: present.reduce(
          (sum, value) => sum + integer(value, "sql_count_invalid"),
          0,
        ),
      };
    });
    const kernel = await this.journal.observe("data_full:kernel", async () => ({
      modes: await this.kernelModes(String(before.device)),
    }));
    await this.releaseWorkload("data_full", "fill");
    return {
      step: "data_full",
      evidence: {
        pool_uuid_before: poolUuid,
        pool_uuid_after: String(object(grow).pool_uuid),
        pool_data_bytes_before: Number(before.data_bytes),
        pool_data_bytes_after: Number(grown.data_bytes),
        grow_target_bytes: target,
        chunk_bytes: this.setup.pool.chunk_bytes,
        volumes_before: [
          pg.lv_uuid,
          fillVolume.lv_uuid,
          String(probeVolume.lv_uuid),
        ],
        volumes_after: grown.volumes as string[],
        marker_committed: (marker.rows as string[]).length === 1,
        fill: ThinQualificationWrite.parse(fill),
        full: ThinPoolStatus.parse(full.status),
        probe: ThinQualificationWrite.parse(probe),
        acknowledged_commits: pre.count + post.count,
        grown: ThinPoolStatus.parse(grown.status),
        restart_ready_milliseconds: restart.ready_milliseconds,
        marker_present: verify.marker_present,
        acknowledged_present: verify.acknowledged_present,
        kernel_modes: kernel.modes as string[],
      },
    };
  }
  /** Replace a stopped or crashed PostgreSQL Pod on the same PVC and wait for recovery. */
  private async restartPostgres(step: string, name: string) {
    const old = await this.journal.observe(`${step}:${name}:old`, async () => {
      const pod = await this.read("pod", name);
      return { uid: pod ? uid(metadata(pod).uid) : null };
    });
    await this.journal.converge(`${step}:${name}:stop`, async () => {
      await this.absent("pod", name, 0);
      return { stopped: true };
    });
    const created = await this.create(
      `${step}:${name}:restart`,
      "pod",
      this.podManifest(name, "postgres"),
    );
    if (created.uid === old.uid) fail("pod_not_replaced");
    return await this.journal.observe(`${step}:${name}:ready`, async () => {
      const pod = await this.postgresReady(name);
      return {
        ready_milliseconds: Math.max(
          0,
          Date.now() - Date.parse(String(metadata(pod).creationTimestamp)),
        ),
      };
    });
  }

  private async metadataFull(): Promise<ThinQualificationReport> {
    const limits = THIN_QUALIFICATION_LIMITS;
    // (b) A separate scratch pool deliberately below the profile metadata floor.
    const scratch = await this.journal.act(
      "metadata_full:scratch-pool",
      async (nonce) => {
        await this.node.driverExec(
          [
            "lvcreate",
            "--thinpool",
            this.tinyPool,
            "--size",
            `${limits.metadata_pool_data_bytes}B`,
            "--poolmetadatasize",
            `${limits.metadata_pool_metadata_bytes}B`,
            "--chunksize",
            "64K",
            "--errorwhenfull",
            "y",
            "--addtag",
            this.tag,
            "--addtag",
            `pgcf.action.${nonce}`,
            "pgcf",
          ],
          false,
          60_000,
        );
        await this.node.driverExec(
          [
            "lvcreate",
            "--thin",
            "--virtualsize",
            `${limits.metadata_pool_data_bytes}B`,
            "--name",
            this.tinyVolume,
            "--addtag",
            this.tag,
            `pgcf/${this.tinyPool}`,
          ],
          false,
          60_000,
        );
      },
      async (nonce) => {
        const lvm = await this.lvm(),
          pool = lvm.volumes.find((lv) => lv.name === this.tinyPool),
          volume = lvm.volumes.find((lv) => lv.name === this.tinyVolume);
        if (!pool || !volume || volume.minor === null) {
          if (pool && !pool.tags.includes(`pgcf.action.${nonce}`))
            fail("scratch_pool_not_owned");
          return null;
        }
        if (
          !pool.tags.includes(`pgcf.action.${nonce}`) ||
          !volume.tags.includes(this.tag) ||
          volume.pool_lv !== this.tinyPool
        )
          fail("scratch_pool_not_owned");
        return {
          pool_uuid: pool.lv_uuid,
          data_bytes: pool.size_bytes,
          metadata_bytes: pool.metadata_bytes ?? 0,
          volume_uuid: volume.lv_uuid,
          minor: volume.minor,
        };
      },
      {
        prepare: async () => {
          await this.node.freshDriver();
          const lvm = await this.lvm();
          if (
            lvm.free_bytes <
            limits.metadata_pool_data_bytes +
              2 * lvm.extent_bytes +
              this.profile.vg_reserve_bytes
          )
            fail("volume_group_headroom_insufficient");
        },
      },
    );
    const device = `/dev/dm-${Number(scratch.minor)}`;
    const marker = await this.journal.measure(
      "metadata_full:marker",
      async () => {
        const write = await this.deviceWrite(
          device,
          "urandom",
          "1048576",
          0,
          1,
          60_000,
        );
        if (write.exit_code !== 0) fail("scratch_marker_failed");
        return { sha256: await this.deviceSha(device, 1) };
      },
    );
    this.room(480_000);
    const exhaust = await this.journal.measure("metadata_full:exhaust", () =>
      this.deviceWrite(device, "zero", "1048576", 1, null, 480_000),
    );
    const exhausted = await this.journal.observe(
      "metadata_full:exhausted",
      async () => ({
        status: await this.poolStatus(String(scratch.pool_uuid)),
      }),
    );
    const probe = await this.journal.measure(
      "metadata_full:probe",
      async () => {
        const status = async () => {
          const value = await this.poolStatus(String(scratch.pool_uuid));
          return value.used_data_blocks;
        };
        const before = await status();
        const write = await this.deviceWrite(
          device,
          "zero",
          "65536",
          limits.metadata_pool_data_bytes / 65536 - 1,
          1,
          60_000,
        );
        return { ...write, before, after: await status() };
      },
    );
    await this.journal.act(
      "metadata_full:deactivate",
      async () => {
        await this.node.driverExec(
          ["lvchange", "--activate", "n", `pgcf/${this.tinyVolume}`],
          true,
          60_000,
        );
        await this.node.driverExec(
          ["lvchange", "--activate", "n", `pgcf/${this.tinyPool}`],
          true,
          60_000,
        );
      },
      async () => {
        const lvm = await this.lvm();
        const owned = lvm.volumes.filter(
          (lv) =>
            lv.name === this.tinyPool ||
            lv.name === this.tinyVolume ||
            lv.name.startsWith(`[${this.tinyPool}_`),
        );
        return owned.length >= 2 &&
          owned.every((lv) => lv.attr[4] !== "a" && lv.attr[4] !== "s")
          ? { inactive: true }
          : null;
      },
    );
    const check = await this.journal.measure(
      "metadata_full:check",
      async () => {
        // Read-only component activation of the deactivated pool's metadata for thin_check.
        const activated = await this.node.driverExec(
          [
            "lvchange",
            "--activate",
            "y",
            "--yes",
            `pgcf/${this.tinyPool}_tmeta`,
          ],
          true,
          60_000,
        );
        if (activated.exit_code !== 0) return { exit_code: null };
        const lvm = await this.lvm(),
          meta = lvm.volumes.find(
            (lv) => lv.name === `[${this.tinyPool}_tmeta]`,
          );
        const result =
          meta?.minor === null || meta === undefined
            ? null
            : await this.node.driverExec(
                ["thin_check", `/dev/dm-${meta.minor}`],
                true,
                120_000,
              );
        await this.node.driverExec(
          ["lvchange", "--activate", "n", `pgcf/${this.tinyPool}_tmeta`],
          true,
          60_000,
        );
        return { exit_code: result?.exit_code ?? null };
      },
    );
    const repair = await this.journal.measure(
      "metadata_full:repair",
      async () => ({
        exit_code: (
          await this.node.driverExec(
            ["lvconvert", "--repair", "--yes", `pgcf/${this.tinyPool}`],
            true,
            180_000,
          )
        ).exit_code,
      }),
    );
    const activation = await this.journal.measure(
      "metadata_full:activate",
      async () => {
        const pool = await this.node.driverExec(
          ["lvchange", "--activate", "y", `pgcf/${this.tinyPool}`],
          true,
          120_000,
        );
        const volume =
          pool.exit_code === 0
            ? await this.node.driverExec(
                ["lvchange", "--activate", "y", `pgcf/${this.tinyVolume}`],
                true,
                120_000,
              )
            : pool;
        return { exit_code: volume.exit_code };
      },
    );
    const verify = await this.journal.observe(
      "metadata_full:verify",
      async () => {
        if (activation.exit_code !== 0) return { sha256: null };
        const lv = (await this.lvm()).volumes.find(
          (value) => value.name === this.tinyVolume,
        );
        if (!lv || lv.minor === null) return { sha256: null };
        return { sha256: await this.deviceSha(`/dev/dm-${lv.minor}`, 1) };
      },
    );
    await this.removeScratchPool("metadata_full:scratch-remove");
    // The driver removes the pool after its last CSI volume: pg-a's volume stays until trim.
    await this.journal.converge("metadata_full:pg-a:stop", async () => {
      await this.absent("pod", "pg-a", 0);
      return { stopped: true };
    });
    // (a) Grow to the profile maximum and fill it across maximum_volumes raw thin LVs.
    const poolUuid = this.setup.pool.pool_uuid;
    await this.growPool(
      "metadata_full:grow",
      poolUuid,
      this.profile.maximum_data_bytes,
    );
    const block =
      4 *
      MIB *
      Math.max(
        1,
        Math.ceil(this.profile.maximum_data_bytes / (8192 * 4 * MIB)),
      );
    const volumeBytes =
      block *
      Math.ceil(
        this.profile.maximum_data_bytes / this.profile.maximum_volumes / block,
      );
    this.room(480_000);
    const raw = await this.journal.act(
      "metadata_full:volumes",
      async () => {
        await this.driverScript(
          `vg=$1; pool=$2; size=$3; tag=$4; shift 4
for name do lvcreate --thin --virtualsize "$size" --name "$name" --addtag "$tag" "$vg/$pool" >/dev/null 2>&1 || exit 1; done`,
          [
            "pgcf",
            POOL,
            `${volumeBytes}B`,
            this.tag,
            ...Array.from(
              { length: this.profile.maximum_volumes },
              (_, index) => `${this.rawPrefix}${index}`,
            ),
          ],
          480_000,
        );
      },
      async () => {
        const lvm = await this.lvm(),
          owned = lvm.volumes.filter((lv) =>
            lv.name.startsWith(this.rawPrefix),
          );
        if (
          owned.some((lv) => !lv.tags.includes(this.tag) || lv.pool_lv !== POOL)
        )
          fail("scratch_volume_not_owned");
        if (
          owned.length !== this.profile.maximum_volumes ||
          owned.some((lv) => lv.minor === null)
        )
          return null;
        return {
          minors: owned
            .sort((a, b) =>
              Number(a.name.slice(this.rawPrefix.length)) <
              Number(b.name.slice(this.rawPrefix.length))
                ? -1
                : 1,
            )
            .map((lv) => lv.minor!),
        };
      },
      { prepare: () => this.node.freshDriver() },
    );
    this.room(480_000);
    const fill = await this.journal.measure(
      "metadata_full:maximum-fill",
      async () => {
        const result = await this.driverScript(
          `bs=$1; rounds=$2; shift 2
start=$(cut -d' ' -f1 /proc/uptime); r=0; written=0; rc=0; err=""
while [ "$r" -lt "$rounds" ]; do
  for dev do
    out=$(dd if=/dev/zero of="$dev" bs="$bs" count=1 seek="$r" oflag=direct conv=notrunc 2>&1) || { rc=$?; err=$out; break 2; }
    written=$((written + bs))
  done
  r=$((r + 1))
done
end=$(cut -d' ' -f1 /proc/uptime)
printf '%s\\npgcf-written=%s\\npgcf-rc=%s\\npgcf-start=%s\\npgcf-end=%s\\n' "$err" "$written" "$rc" "$start" "$end"`,
          [
            String(block),
            String(volumeBytes / block),
            ...(raw.minors as number[]).map((minor) => `/dev/dm-${minor}`),
          ],
          480_000,
        );
        return parseWriteOutcome(result.stdout);
      },
    );
    const maximum = await this.journal.observe(
      "metadata_full:maximum",
      async () => {
        const pool = await this.requirePool(poolUuid);
        return {
          data_bytes: pool.volume.size_bytes,
          metadata_bytes: pool.volume.metadata_bytes ?? 0,
          status: pool.status,
        };
      },
    );
    await this.removeTagged(
      "metadata_full:volumes-remove",
      Array.from(
        { length: this.profile.maximum_volumes },
        (_, index) => `${this.rawPrefix}${index}`,
      ),
    );
    return {
      step: "metadata_full",
      evidence: {
        scratch: {
          pool_uuid: String(scratch.pool_uuid),
          data_bytes: Number(scratch.data_bytes),
          metadata_bytes: Number(scratch.metadata_bytes),
          marker_sha256: String(marker.sha256),
          exhaust: ThinQualificationWrite.parse(exhaust),
          exhausted: ThinPoolStatus.parse(exhausted.status),
          probe: ThinQualificationWrite.parse({
            exit_code: probe.exit_code,
            error: probe.error,
            written_bytes: probe.written_bytes,
            milliseconds: probe.milliseconds,
          }),
          probe_used_data_blocks_before: probe.before as number | null,
          probe_used_data_blocks_after: probe.after as number | null,
          check_exit_code: check.exit_code as number | null,
          repair_exit_code: Number(repair.exit_code),
          activation_exit_code: Number(activation.exit_code),
          marker_sha256_after: verify.sha256 as string | null,
        },
        maximum: {
          pool_uuid: poolUuid,
          data_bytes: Number(maximum.data_bytes),
          metadata_bytes: Number(maximum.metadata_bytes),
          volumes: (raw.minors as number[]).length,
          written_bytes: Number(fill.written_bytes),
          status: ThinPoolStatus.parse(maximum.status),
        },
      },
    };
  }
  /**
   * Remove owned raw thin LVs by exact name; each must carry this run's tag. One relayed
   * lvremove per LV can outlast the turn, so the removal continues from fresh reads next turn.
   */
  private async removeTagged(key: string, names: string[]) {
    return await this.journal.converge(key, async () => {
      const wanted = new Set(names);
      for (const lv of (await this.lvm()).volumes) {
        if (!wanted.has(lv.name)) continue;
        if (!lv.tags.includes(this.tag)) fail("scratch_volume_not_owned");
        this.room(60_000);
        await this.node.driverExec(
          ["lvremove", "--yes", `pgcf/${lv.name}`],
          true,
          60_000,
        );
      }
      if ((await this.lvm()).volumes.some((lv) => wanted.has(lv.name)))
        fail("scratch_volume_remove_failed");
      return { removed: true };
    });
  }
  /** Remove the scratch metadata pool, its thin LV and any repair backup by exact owned name. */
  private async removeScratchPool(key: string) {
    return await this.journal.converge(key, async () => {
      const lvm = await this.lvm();
      for (const name of [
        this.tinyVolume,
        `${this.tinyPool}_meta0`,
        this.tinyPool,
      ]) {
        const lv = lvm.volumes.find((value) => value.name === name);
        if (!lv) continue;
        if (name !== `${this.tinyPool}_meta0` && !lv.tags.includes(this.tag))
          fail("scratch_pool_not_owned");
        await this.node.driverExec(
          ["lvremove", "--yes", `pgcf/${name}`],
          true,
          120_000,
        );
      }
      const after = await this.lvm();
      if (
        after.volumes.some(
          (lv) =>
            lv.name === this.tinyPool ||
            lv.name === this.tinyVolume ||
            lv.name === `${this.tinyPool}_meta0`,
        )
      )
        fail("scratch_pool_remove_failed");
      return { removed: true };
    });
  }
  private async noflush(): Promise<ThinQualificationReport> {
    const poolUuid = this.setup.pool.pool_uuid,
      quota = this.profile.maximum_quota_gib * GIB;
    const writer = await this.workload(
      "noflush_quiescence",
      "writer",
      "sleep",
      quota,
      true,
      "noflush_quiescence:writer-stop",
    );
    const writerPod = await this.journal.observe(
      "noflush_quiescence:writer-pod",
      async () => ({
        uid: uid(metadata(await this.running("writer")).uid),
      }),
    );
    // Buffered writes without sync keep dirty page cache in flight at suspension.
    await this.journal.measure("noflush_quiescence:writer-start", async () => {
      const result = await this.exec("writer", [
        "/bin/bash",
        "-c",
        'nohup dd if=/dev/zero of=/data/burst bs=1M count="$1" >/work/dd.log 2>&1 & echo $! >/work/dd.pid',
        "pgcf",
        String(Math.max(64, Math.min(4096, quota / MIB))),
      ]);
      if (result.exit_code !== 0) fail("writer_start_failed");
      return { started: true };
    });
    const dirty = await this.journal.observe(
      "noflush_quiescence:dirty",
      async () => {
        await this.wait(2000);
        return { bytes: await this.memoryDirty(String(writerPod.uid)) };
      },
    );
    const writerDm = this.dmUuid(writer.lv_uuid);
    const suspend = await this.journal.measure(
      "noflush_quiescence:suspend",
      () =>
        this.timed([
          "dmsetup",
          "suspend",
          "--noflush",
          "--nolockfs",
          "--uuid",
          writerDm,
        ]),
    );
    if (suspend.exit_code !== 0) fail("suspend_failed");
    const frozen = await this.journal.observe(
      "noflush_quiescence:frozen",
      async () => {
        const info = await this.deviceInfo(writer.lv_uuid),
          lv = (await this.lvm()).volumes.find(
            (value) => value.lv_uuid === writer.lv_uuid,
          );
        const started = Date.now();
        const first = await this.blockStat(writer.minor),
          usedFirst = (await this.poolStatus(poolUuid)).used_data_blocks;
        await delay(3000, undefined, { signal: this.session.signal });
        const second = await this.blockStat(writer.minor),
          usedSecond = (await this.poolStatus(poolUuid)).used_data_blocks;
        return {
          state: info.state,
          lv_state: lv?.attr[4] ?? "-",
          write_sectors_first: first.write_sectors,
          write_sectors_second: second.write_sectors,
          used_first: usedFirst,
          used_second: usedSecond,
          observed_milliseconds: Date.now() - started,
        };
      },
    );
    const drain = await this.journal.measure(
      "noflush_quiescence:resume",
      async () => {
        const started = Date.now();
        const resumed = await this.timed([
          "dmsetup",
          "resume",
          "--noflush",
          "--nolockfs",
          "--uuid",
          writerDm,
        ]);
        // The writer stops and every dirty page it left is written back.
        const synced = await this.exec(
          "writer",
          [
            "/bin/bash",
            "-c",
            'kill "$(cat /work/dd.pid)" 2>/dev/null; sync -f /data/burst; echo "pgcf-rc=$?"',
          ],
          120_000,
        );
        const finished = Date.now();
        return {
          resume_exit_code: resumed.exit_code,
          resume_milliseconds: resumed.milliseconds,
          sync_ok: /pgcf-rc=0/.test(synced.stdout),
          drain_milliseconds: finished - started,
          used_after: (await this.poolStatus(poolUuid)).used_data_blocks,
        };
      },
    );
    if (drain.resume_exit_code !== 0 || !drain.sync_ok) fail("resume_failed");
    await this.journal.converge("noflush_quiescence:writer-stop", async () => {
      await this.absent("pod", "writer", 0);
      return { stopped: true };
    });
    const fsck = await this.journal.measure(
      "noflush_quiescence:fsck",
      async () => ({
        exit_code: (
          await this.node.driverExec(
            ["e2fsck", "-f", "-n", `/dev/dm-${writer.minor}`],
            true,
            300_000,
          )
        ).exit_code,
      }),
    );
    await this.releaseWorkload("noflush_quiescence", "writer");
    // The same noflush suspension while the pool is out of data space.
    const fill = await this.workload(
      "noflush_quiescence",
      "fill-full",
      "sleep",
      2 * this.profile.maximum_data_bytes,
      false,
    );
    this.room(480_000);
    await this.journal.measure("noflush_quiescence:fill", () =>
      this.podWrite("fill-full", "/data/fill", "1M", null, 480_000),
    );
    const fullPool = await this.journal.observe(
      "noflush_quiescence:full-pool",
      async () => ({ status: await this.poolStatus(poolUuid) }),
    );
    const fillDm = this.dmUuid(fill.lv_uuid);
    const fullSuspend = await this.journal.measure(
      "noflush_quiescence:full-suspend",
      async () => {
        const suspended = await this.timed([
          "dmsetup",
          "suspend",
          "--noflush",
          "--nolockfs",
          "--uuid",
          fillDm,
        ]);
        const info = await this.deviceInfo(fill.lv_uuid);
        const resumed = await this.timed([
          "dmsetup",
          "resume",
          "--noflush",
          "--nolockfs",
          "--uuid",
          fillDm,
        ]);
        if (suspended.exit_code !== 0 || resumed.exit_code !== 0)
          fail("full_suspend_failed");
        return {
          suspend_milliseconds: suspended.milliseconds,
          state: info.state,
          resume_milliseconds: resumed.milliseconds,
        };
      },
    );
    await this.releaseWorkload("noflush_quiescence", "fill-full");
    return {
      step: "noflush_quiescence",
      evidence: {
        writer: {
          lv_uuid: writer.lv_uuid,
          dirty_bytes: Number(dirty.bytes),
          suspend_milliseconds: suspend.milliseconds,
          state: frozen.state as "ACTIVE" | "SUSPENDED",
          lv_state: String(frozen.lv_state),
          write_sectors_first: Number(frozen.write_sectors_first),
          write_sectors_second: Number(frozen.write_sectors_second),
          used_data_blocks_first: Number(frozen.used_first),
          used_data_blocks_second: Number(frozen.used_second),
          observed_milliseconds: Number(frozen.observed_milliseconds),
          resume_milliseconds: Number(drain.resume_milliseconds),
          drain_bytes:
            Math.max(0, Number(drain.used_after) - Number(frozen.used_second)) *
            this.setup.pool.chunk_bytes,
          drain_milliseconds: Number(drain.drain_milliseconds),
          fsck_exit_code: Number(fsck.exit_code),
        },
        full: {
          lv_uuid: fill.lv_uuid,
          pool: ThinPoolStatus.parse(fullPool.status),
          suspend_milliseconds: Number(fullSuspend.suspend_milliseconds),
          state: fullSuspend.state as "ACTIVE" | "SUSPENDED",
          resume_milliseconds: Number(fullSuspend.resume_milliseconds),
        },
      },
    };
  }

  private async resumeMarker(): Promise<ThinQualificationReport> {
    const quota = this.profile.maximum_quota_gib * GIB;
    const volume = await this.workload(
      "resume_marker",
      "pg-r",
      "postgres",
      quota,
      true,
      "resume_marker:kill",
    );
    if (!this.journal.entry("resume_marker:marker"))
      await this.postgresReady("pg-r");
    const marker = await this.journal.measure(
      "resume_marker:marker",
      async () => ({
        rows: await this.sql("pg-r", [
          "CREATE TABLE IF NOT EXISTS q(id bigserial PRIMARY KEY, v text NOT NULL)",
          `INSERT INTO q(v) VALUES ('${MARKER}') RETURNING id`,
        ]),
      }),
    );
    const pool = await this.journal.observe("resume_marker:pool", async () => {
      const value = await this.requirePool();
      return { pool_uuid: value.volume.lv_uuid, device: value.device };
    });
    // A long uncommitted statement is still writing when the exact LV is suspended.
    const long = await this.journal.measure("resume_marker:long", async () => {
      await this.exec("pg-r", [
        "/bin/bash",
        "-c",
        `nohup psql -X -q -h /run/q -U postgres -d postgres -v ON_ERROR_STOP=1 -c "BEGIN; INSERT INTO q(v) SELECT '${UNCOMMITTED}' FROM generate_series(1, 20000000); COMMIT;" >/work/long.log 2>&1 &`,
      ]);
      for (let attempt = 0; attempt < 20; attempt++) {
        await delay(500, undefined, { signal: this.session.signal });
        const [active] = await this.sql("pg-r", [
          `SELECT count(*) FROM pg_stat_activity WHERE state='active' AND query LIKE '%${UNCOMMITTED}%' AND pid<>pg_backend_pid()`,
        ]);
        if (active === "1") return { active: true };
      }
      return { active: false };
    });
    const lvDm = this.dmUuid(volume.lv_uuid);
    const suspended = await this.journal.measure(
      "resume_marker:suspend",
      async () => {
        const result = await this.timed([
          "dmsetup",
          "suspend",
          "--noflush",
          "--nolockfs",
          "--uuid",
          lvDm,
        ]);
        return {
          exit_code: result.exit_code,
          state: (await this.deviceInfo(volume.lv_uuid)).state,
        };
      },
    );
    if (suspended.exit_code !== 0) fail("suspend_failed");
    // The killed writer cannot finish while suspended; its processes end after resume.
    await this.journal.converge("resume_marker:kill", async () => {
      await this.remove("pod", "pg-r", 0);
      return { killed: true };
    });
    const resumed = await this.journal.measure(
      "resume_marker:resume",
      async () => {
        const info = await this.deviceInfo(volume.lv_uuid),
          table = parseThinTable(
            (await this.node.driverExec(["dmsetup", "table", "--uuid", lvDm]))
              .stdout,
          );
        const expected = {
          volume_group_uuid: this.vg!,
          lv_uuid: volume.lv_uuid,
          pool_device: String(pool.device),
        };
        const verified = resumeTargetMatches(info, table, expected);
        if (!verified) return { verified, exit_code: 255 };
        const result = await this.timed([
          "dmsetup",
          "resume",
          "--noflush",
          "--nolockfs",
          "--uuid",
          lvDm,
        ]);
        return { verified, exit_code: result.exit_code };
      },
    );
    if (resumed.exit_code !== 0) fail("resume_failed");
    await this.journal.converge("resume_marker:gone", async () => {
      await this.absent("pod", "pg-r", 0);
      return { gone: true };
    });
    const created = await this.create(
      "resume_marker:pg-r:restart",
      "pod",
      this.podManifest("pg-r", "postgres"),
    );
    const restart = await this.journal.observe(
      "resume_marker:ready",
      async () => {
        const pod = await this.postgresReady("pg-r");
        if (metadata(pod).uid !== created.uid) fail("pod_replaced");
        return {
          ready_milliseconds: Math.max(
            0,
            Date.now() - Date.parse(String(metadata(pod).creationTimestamp)),
          ),
        };
      },
    );
    const verify = await this.journal.observe(
      "resume_marker:verify",
      async () => {
        const [markers, uncommitted] = await this.sql("pg-r", [
          `SELECT count(*) FROM q WHERE v='${MARKER}'`,
          `SELECT count(*) FROM q WHERE v='${UNCOMMITTED}'`,
        ]);
        const after = await this.volume("pg-r"),
          current = await this.requirePool();
        return {
          marker_present: markers === "1",
          uncommitted: integer(uncommitted, "sql_count_invalid"),
          lv_uuid: after?.lv_uuid ?? null,
          pool_uuid: current.volume.lv_uuid,
        };
      },
    );
    await this.releaseWorkload("resume_marker", "pg-r");
    return {
      step: "resume_marker",
      evidence: {
        lv_uuid_before: volume.lv_uuid,
        lv_uuid_after: String(verify.lv_uuid),
        pool_uuid_before: String(pool.pool_uuid),
        pool_uuid_after: String(verify.pool_uuid),
        marker_committed: (marker.rows as string[]).length === 1,
        long_statement_active: Boolean(long.active),
        suspended: suspended.state === "SUSPENDED",
        resume_target_verified: Boolean(resumed.verified),
        restart_ready_milliseconds: Number(restart.ready_milliseconds),
        marker_present: Boolean(verify.marker_present),
        uncommitted_rows: Number(verify.uncommitted),
      },
    };
  }

  /** One full product-equivalent Native readback turn, timed from a fresh relay session. */
  private async productCycle() {
    const started = Date.now();
    await openThinSession(
      {
        callback: this.input.callback,
        cluster_endpoint: this.input.cluster_endpoint,
        talos_admin_config: this.input.talos_admin_config,
        kubeconfig: this.input.kubeconfig,
        address: this.run.address,
        budget_ms: Math.min(90_000, this.remaining()),
        prefix: "pgcf-thin-qualification-cycle-",
      },
      this.options,
      async (session) => {
        const node = await verifyThinNode(
          session,
          {
            node_id: this.run.node_id,
            region_id: this.run.region_id,
            node_uid: this.run.node_uid,
            cluster_uid: this.run.cluster_uid,
            name: this.run.name,
            provider_instance_id: this.run.provider_instance_id,
            driver_image: this.profile.driver_image,
            host_extension_version: this.input.host_extension.version,
            boot_id: this.setup.identity.boot_id,
            kernel_version: this.setup.identity.kernel_version,
          },
          () => this.lease(),
        );
        await node.readLvm();
        await Promise.all([
          session.get(["pv"]),
          session.get(["pvc", "--all-namespaces"]),
          session.get(["lvmvolumes.local.openebs.io", "--all-namespaces"]),
          session.get(["pods", "--all-namespaces"]),
          session.get(["namespaces"]),
          session.get(["clusters.postgresql.cnpg.io", "--all-namespaces"]),
          session.get(["configmaps", "--namespace", "pgcf-system"]),
        ]);
        await node.freshDriver();
        await node.readLvm();
      },
    );
    return Date.now() - started;
  }

  private async startupBound(): Promise<ThinQualificationReport> {
    const poolUuid = this.setup.pool.pool_uuid,
      quota = this.profile.maximum_quota_gib * GIB;
    const before = await this.journal.observe(
      "startup_bound:before",
      async () => ({
        used: (await this.poolStatus(poolUuid)).used_data_blocks,
      }),
    );
    const volume = await this.workload(
      "startup_bound",
      "pg-b",
      "postgres",
      quota,
      true,
    );
    const ready = await this.journal.observe(
      "startup_bound:ready",
      async () => {
        const pod = await this.postgresReady("pg-b");
        return {
          pod_uid: uid(metadata(pod).uid),
          ready_milliseconds: Math.max(
            0,
            Date.now() - Date.parse(String(metadata(pod).creationTimestamp)),
          ),
        };
      },
    );
    this.room(240_000);
    await this.journal.measure("startup_bound:load", async () => ({
      rows: await this.sql(
        "pg-b",
        [
          "CREATE TABLE b AS SELECT g, repeat('x', 100) AS v FROM generate_series(1, 500000) g",
          "CHECKPOINT",
        ],
        240_000,
      ),
    }));
    const loaded = await this.journal.observe(
      "startup_bound:loaded",
      async () => ({
        used: (await this.poolStatus(poolUuid)).used_data_blocks,
      }),
    );
    const idle = await this.journal.observe("startup_bound:idle", async () => {
      const started = Date.now();
      await this.wait(30_000);
      return {
        used: (await this.poolStatus(poolUuid)).used_data_blocks,
        milliseconds: Date.now() - started,
      };
    });
    const groups = await this.journal.observe(
      "startup_bound:filesystem",
      async () =>
        parseDumpe2fsGroups(
          (
            await this.node.driverExec(
              ["dumpe2fs", `/dev/dm-${volume.minor}`],
              true,
              60_000,
            )
          ).stdout,
        ),
    );
    const limit = await this.journal.observe(
      "startup_bound:io-limit",
      async () => {
        const lv = (await this.lvm()).volumes.find(
          (value) => value.lv_uuid === volume.lv_uuid,
        );
        if (!lv || lv.major === null || lv.minor === null)
          fail("volume_inactive");
        return thinIoLimit(
          (
            await this.node.driverExec([
              "sh",
              "-ec",
              'for p do if [ -r "$p" ]; then cat "$p"; fi; done',
              "--",
              ...thinPodCgroupPaths(String(ready.pod_uid)),
            ])
          ).stdout,
          lv.major,
          lv.minor,
        );
      },
    );
    this.room(480_000);
    const rates = await this.journal.measure(
      "startup_bound:rates",
      async () => {
        const megabytes = Math.max(
          8,
          Math.min(
            4096,
            Math.ceil((this.profile.write_bytes_per_second * 5) / MIB),
          ),
        );
        const operations = Math.max(
          64,
          Math.min(200_000, this.profile.write_iops_per_second * 5),
        );
        const sequential = await this.podWrite(
          "pg-b",
          "/data/rate",
          "1M",
          megabytes,
          240_000,
        );
        const random = await this.podWrite(
          "pg-b",
          "/data/iops",
          "4k",
          operations,
          240_000,
        );
        if (sequential.exit_code !== 0 || random.exit_code !== 0)
          fail("rate_write_failed");
        return {
          bytes_per_second: Math.ceil(
            (megabytes * MIB * 1000) / Math.max(1, sequential.milliseconds),
          ),
          iops: Math.ceil(
            (operations * 1000) / Math.max(1, random.milliseconds),
          ),
        };
      },
    );
    const cycle = await this.journal.observe(
      "startup_bound:executor-cycle",
      async () => ({ milliseconds: await this.productCycle() }),
    );
    await this.releaseWorkload("startup_bound", "pg-b");
    return {
      step: "startup_bound",
      evidence: {
        lv_uuid: volume.lv_uuid,
        chunk_bytes: this.setup.pool.chunk_bytes,
        used_data_blocks_before: Number(before.used),
        used_data_blocks_ready: Number(loaded.used),
        used_data_blocks_idle: Number(idle.used),
        ready_milliseconds: Number(ready.ready_milliseconds),
        idle_milliseconds: Number(idle.milliseconds),
        ext4_groups: Number(groups.groups),
        ext4_groups_zeroed: Number(groups.zeroed),
        io_limit: {
          write_bytes_per_second: Number(limit.write_bytes_per_second),
          write_iops_per_second: Number(limit.write_iops_per_second),
        },
        measured_write_bytes_per_second: Number(rates.bytes_per_second),
        measured_write_iops_per_second: Number(rates.iops),
        executor_cycle_milliseconds: Number(cycle.milliseconds),
      },
    };
  }

  private async trim(): Promise<ThinQualificationReport> {
    const limits = THIN_QUALIFICATION_LIMITS,
      poolUuid = this.setup.pool.pool_uuid;
    const sentinel = await this.workload(
      "trim_delete_recreate",
      "sentinel",
      "block",
      64 * MIB,
      false,
    );
    const target = await this.workload(
      "trim_delete_recreate",
      "trim",
      "block",
      limits.trim_bytes,
      false,
    );
    const baseline = await this.journal.observe(
      "trim_delete_recreate:baseline",
      async () => ({
        used: (await this.poolStatus(poolUuid)).used_data_blocks,
      }),
    );
    const written = await this.journal.measure(
      "trim_delete_recreate:write",
      async () => {
        const write = await this.deviceWrite(
          `/dev/dm-${target.minor}`,
          "urandom",
          "1048576",
          0,
          limits.trim_bytes / MIB,
          300_000,
        );
        if (write.exit_code !== 0) fail("trim_write_failed");
        return {
          bytes: write.written_bytes,
          used: (await this.poolStatus(poolUuid)).used_data_blocks,
        };
      },
    );
    await this.releaseWorkload("trim_delete_recreate", "trim");
    const deleted = await this.journal.observe(
      "trim_delete_recreate:deleted",
      async () => {
        const lvm = await this.lvm(),
          kernel = await this.node.driverExec([
            "dmsetup",
            "info",
            "--columns",
            "--noheadings",
            "--options",
            "uuid",
          ]);
        return {
          used: (await this.poolStatus(poolUuid)).used_data_blocks,
          absent_lvs: !lvm.volumes.some((lv) => lv.lv_uuid === target.lv_uuid),
          absent_kernel: !kernel.stdout.includes(hex(target.lv_uuid)),
        };
      },
    );
    // Deleting the last thin LV lets the driver remove the pool; the product re-initializes it.
    await this.releaseWorkload("data_full", "pg-a");
    await this.releaseWorkload("trim_delete_recreate", "sentinel");
    const last = await this.journal.observe(
      "trim_delete_recreate:last",
      async () => ({ pool_present: (await this.pool()) !== null }),
    );
    const reinitialized = last.pool_present
      ? null
      : await this.createPool(
          "trim_delete_recreate:reinitialize",
          this.profile.initial_data_bytes,
        );
    const recreated = await this.workload(
      "trim_delete_recreate",
      "trim-again",
      "block",
      limits.trim_bytes,
      false,
    );
    const readback = await this.journal.observe(
      "trim_delete_recreate:readback",
      async () => {
        const result = await this.driverScript(
          `n=$(dd if="$1" bs=1048576 count="$2" 2>/dev/null | wc -c); z=$(dd if="$1" bs=1048576 count="$2" 2>/dev/null | tr -d '\\000' | wc -c); printf 'pgcf-read=%s\\npgcf-nonzero=%s\\n' "$n" "$z"`,
          [`/dev/dm-${recreated.minor}`, String(limits.trim_bytes / MIB)],
          300_000,
        );
        const read = /^pgcf-read=\s*(\d+)$/m.exec(result.stdout)?.[1],
          nonzero = /^pgcf-nonzero=\s*(\d+)$/m.exec(result.stdout)?.[1];
        return {
          read: integer(read, "readback_invalid"),
          nonzero: integer(nonzero, "readback_invalid"),
        };
      },
    );
    await this.releaseWorkload("trim_delete_recreate", "trim-again");
    return {
      step: "trim_delete_recreate",
      evidence: {
        chunk_bytes: this.setup.pool.chunk_bytes,
        written_bytes: Number(written.bytes),
        deleted_lv_uuid: target.lv_uuid,
        used_data_blocks_baseline: Number(baseline.used),
        used_data_blocks_written: Number(written.used),
        used_data_blocks_deleted: Number(deleted.used),
        deleted_absent_lvs: Boolean(deleted.absent_lvs),
        deleted_absent_kernel: Boolean(deleted.absent_kernel),
        last_lv_uuid: sentinel.lv_uuid,
        pool_uuid_before: poolUuid,
        pool_present_after_last: Boolean(last.pool_present),
        reinitialized_pool_uuid: reinitialized?.pool_uuid ?? null,
        recreated_lv_uuid: recreated.lv_uuid,
        recreated_read_bytes: Number(readback.read),
        recreated_nonzero_bytes: Number(readback.nonzero),
      },
    };
  }

  private async retained(): Promise<ThinQualificationReport> {
    const baseline = this.setup.thick;
    // A retained database that is waking up or falling asleep differs only briefly.
    const attempt = this.journal.keys(
      "retained_thick_preservation:after-",
    ).length;
    const after = await this.journal.observe(
      `retained_thick_preservation:after-${attempt}`,
      async () => await this.thick(),
    );
    const equal =
      JSON.stringify(after.volumes) === JSON.stringify(baseline.volumes) &&
      JSON.stringify(after.claims) === JSON.stringify(baseline.claims) &&
      JSON.stringify(after.lvm_volumes) ===
        JSON.stringify(baseline.lvm_volumes) &&
      JSON.stringify(after.clusters) === JSON.stringify(baseline.clusters);
    if (!equal && attempt < 9) throw new Yield();
    return {
      step: "retained_thick_preservation",
      evidence: { baseline, after: after as ThinQualificationThickSnapshot },
    };
  }

  /** Remove every scratch object, LV, the scratch pool and a spare that did not exist before. */
  private async cleanup(): Promise<ThinQualificationReport> {
    const baseline = this.baselineFacts();
    if (this.vg === null) this.vg = (await this.lvm()).volume_group_uuid;
    // Only volumes this run created: its scratch PVC LVs and its tagged raw LVs.
    const workloads = this.journal
      .keys("")
      .filter((key) => key.endsWith(":volume"))
      .map((key) => ({
        step: key.split(":")[0]!,
        name: key.split(":")[1]!,
        facts: this.journal.entry(key)!.facts as VolumeFacts | null,
      }));
    const owned = new Set(
      workloads.flatMap((value) => (value.facts ? [value.facts.lv_uuid] : [])),
    );
    // A failed gate can leave an owned LV suspended; resume it before anything waits on it.
    for (const lv of (await this.lvm()).volumes) {
      if (
        lv.attr[4] !== "s" ||
        (!owned.has(lv.lv_uuid) && !lv.tags.includes(this.tag))
      )
        continue;
      // Owned LV names are lowercase (pvc-<uid>, pgcf_thin_q_<run>_*); LVM UUIDs are mixed-case.
      await this.journal.converge(`cleanup:resume:${lv.name}`, async () => {
        await this.node.driverExec(
          [
            "dmsetup",
            "resume",
            "--noflush",
            "--nolockfs",
            "--uuid",
            this.dmUuid(lv.lv_uuid),
          ],
          true,
          60_000,
        );
        return { resumed: true };
      });
    }
    if (await this.read("namespace", this.namespace, false)) {
      const pods = await this.session.get([
        "pods",
        "--namespace",
        this.namespace,
      ]);
      for (const pod of items(pods.items))
        await this.absent("pod", text(metadata(pod).name), 0);
      const claims = await this.session.get([
        "persistentvolumeclaims",
        "--namespace",
        this.namespace,
      ]);
      for (const claim of items(claims.items)) {
        const name = text(metadata(claim).name),
          latest = workloads.filter((value) => value.name === name).at(-1);
        if (latest) await this.releaseWorkload(latest.step, name);
        else await this.absent("persistentvolumeclaim", name);
      }
    }
    // Retained PVs of this run whose claims are already gone: the provisioner deletes their LVs.
    const pvs = await this.session.get(["persistentvolumes"]);
    for (const pv of items(pvs.items)) {
      if (object(object(pv.spec).claimRef ?? {}).namespace !== this.namespace)
        continue;
      const name = text(metadata(pv).name);
      await this.journal.converge(`cleanup:pv:${name}`, async () => {
        const current = await this.persistentVolume(name);
        if (
          current &&
          object(current.spec).persistentVolumeReclaimPolicy === "Retain"
        ) {
          await this.node.authorize();
          await this.session.kube(
            [
              "patch",
              "persistentvolume",
              name,
              "--type=json",
              "--patch",
              JSON.stringify([
                {
                  op: "test",
                  path: "/metadata/uid",
                  value: text(metadata(current).uid),
                },
                {
                  op: "test",
                  path: "/spec/persistentVolumeReclaimPolicy",
                  value: "Retain",
                },
                {
                  op: "add",
                  path: "/spec/persistentVolumeReclaimPolicy",
                  value: "Delete",
                },
              ]),
            ],
            undefined,
            true,
          );
        }
        for (;;) {
          if (
            !(await this.persistentVolume(name)) &&
            !(await this.lvm()).volumes.some((lv) => lv.name === name)
          )
            return { removed: true };
          await this.wait();
        }
      });
    }
    await this.journal.converge("cleanup:namespace", async () => {
      await this.absent("namespace", this.namespace);
      return { removed: true };
    });
    for (const kind of ["storageclass", "volumeattributesclass"] as const)
      await this.journal.converge(`cleanup:${kind}`, async () => {
        await this.absent(kind, this.scratchClass);
        return { removed: true };
      });
    await this.removeTagged(
      "cleanup:raw-volumes",
      (await this.lvm()).volumes
        .filter(
          (lv) =>
            lv.tags.includes(this.tag) &&
            lv.segtype === "thin" &&
            lv.pool_lv === POOL,
        )
        .map((lv) => lv.name),
    );
    await this.removeScratchPool("cleanup:scratch-pool");
    const actions = new Set(
      ["setup:pool", "trim_delete_recreate:reinitialize"]
        .map((key) => this.journal.entry(key)?.nonce)
        .filter((nonce): nonce is string => nonce !== undefined)
        .map((nonce) => `pgcf.action.${nonce}`),
    );
    await this.journal.converge("cleanup:pool", async () => {
      const lvm = await this.lvm(),
        pool = lvm.volumes.find((lv) => lv.name === POOL);
      if (!pool) return { removed: false };
      if (!pool.tags.some((tag) => actions.has(tag))) fail("pool_not_owned");
      if (lvm.volumes.some((lv) => lv.pool_lv === POOL))
        fail("pool_still_referenced");
      await this.node.driverExec(
        ["lvremove", "--yes", `pgcf/${POOL}`],
        true,
        120_000,
      );
      return { removed: true };
    });
    const spareBefore =
      baseline?.logical_volumes.some((lv) => lv.name === "[lvol0_pmspare]") ??
      false;
    if (!spareBefore)
      await this.journal.converge("cleanup:spare", async () => {
        const lvm = await this.lvm();
        if (
          lvm.volumes.some((lv) => lv.name === "[lvol0_pmspare]") &&
          !lvm.volumes.some((lv) => lv.segtype === "thin-pool")
        )
          await this.node.driverExec(
            ["lvremove", "--yes", "pgcf/lvol0_pmspare"],
            true,
            60_000,
          );
        return { removed: true };
      });
    const lvm = await this.lvm();
    const inventory = (values: { name: string; lv_uuid: string }[]) =>
      values
        .map((value) => `${value.name}/${value.lv_uuid}`)
        .sort()
        .join(",");
    return {
      step: "cleanup",
      cleanup: {
        namespace_absent:
          (await this.read("namespace", this.namespace, false)) === null,
        storage_class_absent:
          (await this.read("storageclass", this.scratchClass, false)) === null,
        attributes_class_absent:
          (await this.read(
            "volumeattributesclass",
            this.scratchClass,
            false,
          )) === null,
        scratch_volumes_absent: !lvm.volumes.some(
          (lv) =>
            lv.tags.includes(this.tag) ||
            lv.name.startsWith(this.tinyPool) ||
            owned.has(lv.lv_uuid),
        ),
        pool_absent: !lvm.volumes.some((lv) => lv.name === POOL),
        spare_absent:
          spareBefore ||
          !lvm.volumes.some((lv) => lv.name === "[lvol0_pmspare]"),
        logical_volumes_match_baseline:
          baseline !== null &&
          inventory(lvm.volumes) === inventory(baseline.logical_volumes),
        volume_group_free_bytes: lvm.free_bytes,
        baseline_free_bytes: baseline?.volume_group_free_bytes ?? 0,
      },
    };
  }
}

/** One bounded executor turn for the current run step under a Cloudflare lease. */
export async function runThinQualification(
  raw: unknown,
  options: ExecutorOptions = {},
) {
  const input = ThinQualificationInput.parse(raw),
    run = input.run,
    callback = new URL(input.callback.url);
  if (
    callback.protocol !== "https:" ||
    callback.pathname !== `/internal/v1/thin-qualifications/${run.id}` ||
    Date.parse(run.lease.expires_at) <= Date.now() + 60_000 ||
    (run.step !== "setup" && run.step !== "cleanup" && !run.setup)
  )
    throw new BootstrapError("thin_qualification_input_invalid");
  const deadline = Math.min(
    Date.now() + 570_000,
    Date.parse(run.lease.expires_at) - 30_000,
  );
  return await openThinSession(
    {
      callback: input.callback,
      cluster_endpoint: input.cluster_endpoint,
      talos_admin_config: input.talos_admin_config,
      kubeconfig: input.kubeconfig,
      address: run.address,
      budget_ms: deadline - Date.now() + 20_000,
      prefix: "pgcf-thin-qualification-",
    },
    options,
    async (session) => {
      const journal = new QualificationJournal(
        run.journal,
        async (expected, entry) =>
          bytes(
            object(
              await session.call({
                kind: "checkpoint",
                expected_revision: expected,
                entry,
              }),
            ).revision,
          ),
      );
      const qualifier = new Qualifier(
        input,
        session,
        journal,
        deadline,
        options,
      );
      try {
        await qualifier.connect();
        const report = ThinQualificationReport.parse(await qualifier.step());
        return await session.call({ kind: "report", report });
      } catch (error) {
        if (!(error instanceof Yield)) throw error;
      }
      return await session.call({ kind: "release" });
    },
  );
}
