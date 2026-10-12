// SPDX-License-Identifier: Apache-2.0
// Controlled cluster, Talos and LVM state for executor turn tests; never a live observation.
import { randomUUID } from "node:crypto";
import { newOperationId } from "@pgcf/contracts";
import { ThinStorageProfile } from "@pgcf/contracts/database-storage";
import {
  ThinQualificationCheckpoint,
  ThinQualificationInput,
  type ThinQualificationJournalEntry,
  type ThinQualificationSetup,
} from "@pgcf/contracts/thin-qualification";
import sources from "../../../infra/storage/sources.lock.json" with { type: "json" };
import {
  BootstrapError,
  type Command,
  type CommandResult,
} from "../src/bootstrap.ts";
import { runThinQualification } from "../src/thin-qualification.ts";

const GIB = 1024 ** 3,
  MIB = 1024 ** 2;
const POOL = "pgcf_thinpool";
const OWNER = "pgcf.io/thin-qualification";
/** kube-scheduler retries an unschedulable Pod at least every 5 minutes. */
const SCHEDULER_RETRY_MS = 300_000;

export const profile = ThinStorageProfile.parse({
  version: 1,
  driver_image: `ghcr.io/amerged-org/pgcf-regional:lvm-thin-sha-${"a".repeat(40)}@sha256:${"b".repeat(64)}`,
  initial_data_bytes: GIB,
  growth_bytes: GIB,
  maximum_data_bytes: 8 * GIB,
  metadata_bytes: 128 * MIB,
  vg_reserve_bytes: 512 * MIB,
  data_reserve_bytes: 256 * MIB,
  metadata_reserve_bytes: 32 * MIB,
  startup_reserve_bytes: 128 * MIB,
  write_bytes_per_second: MIB,
  write_iops_per_second: 100,
  guard_seconds: 10,
  drain_seconds: 10,
  maximum_volumes: 128,
  maximum_quota_gib: 7,
});

/** A mixed-case LVM UUID repeated from a short seed. */
export function lvm(seed: string) {
  const v = seed.repeat(32).slice(0, 32);
  return `${v.slice(0, 6)}-${v.slice(6, 10)}-${v.slice(10, 14)}-${v.slice(14, 18)}-${v.slice(18, 22)}-${v.slice(22, 26)}-${v.slice(26)}`;
}
const hex = (value: string) => value.replaceAll("-", "");
const ok = (stdout: string): CommandResult => ({ exit_code: 0, stdout });

interface Lv {
  name: string;
  uuid: string;
  segtype: "linear" | "thin" | "thin-pool";
  pool: string;
  size: number;
  metadata: number;
  tags: string[];
  minor: number;
  state: "a" | "s";
  /** A pool's hidden data LV gains a segment with each lvextend behind its metadata LVs. */
  segments?: number;
}
interface Pod {
  name: string;
  uid: string;
  rv: number;
  created: string;
  phase: "Pending" | "Running" | "Failed";
  claim: string;
  /** The container script; a PostgreSQL Pod's start is checked against its data directory. */
  script: string;
  /** kubelet's default fsGroupChangePolicy re-applies the group to every file on each mount. */
  fsGroupAlways: boolean;
}
interface Claim {
  name: string;
  uid: string;
  rv: number;
  size: number;
  bound: boolean;
  /** PGDATA's mode once initdb created it on this volume. */
  pgdata?: number;
}
interface Persistent {
  name: string;
  uid: string;
  claim: { name: string; uid: string };
  policy: "Retain" | "Delete";
  rv: number;
}

/** Node identity, Kubernetes objects and the LVM/device-mapper state one executor turn reads and writes. */
export class ThinWorld {
  boot = randomUUID();
  readonly system = randomUUID();
  kernel = "6.18.51-talos";
  driverImage: string = profile.driver_image;
  extension = "0.1.0";
  readonly vg = lvm("Vg");
  readonly total: number;
  readonly driverUid = randomUUID();
  readonly daemonSetUid = randomUUID();
  lvs: Lv[] = [];
  pods = new Map<string, Pod>();
  claims = new Map<string, Claim>();
  volumes = new Map<string, Persistent>();
  namespaceUid: string | null = null;
  classes = new Map<string, string>();
  poolMode: "rw" | "out_of_data_space" = "rw";
  /** LVs whose next lvremove calls fail because the device is still open. */
  busy = new Map<string, number>();
  /** Writes, Pod execs and Talos calls other than identity reads, in order. */
  log: string[] = [];
  /** Simulated relay latency of one driver command, applied to the mocked clock. */
  cost: (args: string[]) => number = () => 0;
  /** Advances the mocked clock for relay latency and scheduler retries. */
  elapse: (milliseconds: number) => void = () => {};
  /** The session budget: later commands are cancelled like the real relay session. */
  cancelAt = Infinity;
  private minor = 10;
  private rv = 100;
  readonly ids: QualificationIds;
  constructor(ids: QualificationIds, total = 103_075_020_800) {
    this.ids = ids;
    this.total = total;
  }

  get namespace() {
    return `pgcf-thin-q-${this.ids.id.slice(3)}`;
  }
  get tag() {
    return `pgcf.thin-q.${this.ids.id}`;
  }
  annotations() {
    return {
      [OWNER]: this.ids.id,
      "pgcf.io/thin-qualification-node-uid": this.ids.node_uid,
    };
  }
  free() {
    return (
      this.total -
      this.lvs.reduce(
        (sum, lv) =>
          sum + (lv.segtype === "thin" ? 0 : lv.size + 2 * lv.metadata),
        0,
      )
    );
  }
  lv(name: string) {
    return this.lvs.find((value) => value.name === name);
  }
  /** `lvs --all` also lists each pool's hidden data and metadata LVs and the VG's metadata
   * spare, one row per segment; free() already charges their extents to the pool. */
  hiddenLvs(): Lv[] {
    const pools = this.lvs.filter((lv) => lv.segtype === "thin-pool");
    const hidden = (name: string, uuid: string, size: number): Lv => ({
      name,
      uuid,
      segtype: "linear",
      pool: "",
      size,
      metadata: 0,
      tags: [],
      minor: 0,
      state: "a",
    });
    return [
      ...pools.flatMap((pool) => [
        ...Array.from({ length: pool.segments ?? 1 }, () =>
          hidden(`[${pool.name}_tdata]`, lvm(`Td${hex(pool.uuid)}`), pool.size),
        ),
        hidden(
          `[${pool.name}_tmeta]`,
          lvm(`Tm${hex(pool.uuid)}`),
          pool.metadata,
        ),
      ]),
      ...(pools.length
        ? [
            hidden(
              "[lvol0_pmspare]",
              lvm("Ps"),
              Math.max(...pools.map((pool) => pool.metadata)),
            ),
          ]
        : []),
    ];
  }
  addLv(
    value: Omit<Lv, "minor" | "state" | "metadata"> & { metadata?: number },
  ) {
    const lv: Lv = {
      metadata: 0,
      ...value,
      minor: this.minor++,
      state: "a",
    };
    this.lvs.push(lv);
    return lv;
  }
  nextVersion() {
    return ++this.rv;
  }
  dm(lv: Lv) {
    return `LVM-${hex(this.vg)}${hex(lv.uuid)}`;
  }
  private usedBlocks(pool: Lv) {
    return this.poolMode === "out_of_data_space" ? pool.size / 65536 : 16;
  }
  private poolStatus(pool: Lv) {
    return `0 ${pool.size / 512} thin-pool 1 1180/${pool.metadata / 4096} ${this.usedBlocks(pool)}/${pool.size / 65536} - ${this.poolMode} discard_passdown error_if_no_space - 1024\n`;
  }
  /** OpenEBS LVM 1.10.1 GetCapacity of a thinProvision class: VG free plus free data of pgcf_thinpool. */
  private capacity() {
    const pool = this.lv(POOL);
    return this.free() + (pool ? pool.size - this.usedBlocks(pool) * 65536 : 0);
  }

  async command(command: Command): Promise<CommandResult> {
    if (Date.now() > this.cancelAt) throw new BootstrapError("job_cancelled");
    if (command.executable === "kubectl")
      return this.kubectl(command.args.slice(3), command.stdin);
    if (command.executable === "talosctl")
      return this.talosctl(command.args.slice(6));
    throw new Error(`unexpected_executable_${command.executable}`);
  }

  private talosctl(args: string[]): CommandResult {
    if (args[0] === "read") {
      if (args[1] === "/proc/sys/kernel/random/boot_id")
        return ok(`${this.boot}\n`);
      if (args[1] === "/sys/class/dmi/id/product_uuid")
        return ok(`${this.system.toUpperCase()}\n`);
      if (args[1] === "/proc/modules")
        return ok("dm_thin_pool 94208 1 - Live 0x0000000000000000\n");
    }
    if (args[0] === "get" && args[1] === "extensionstatuses")
      return ok(
        JSON.stringify({
          metadata: { type: "ExtensionStatuses.runtime.talos.dev" },
          spec: {
            metadata: {
              name: "pgcf-sandbox-controller",
              version: this.extension,
            },
          },
        }),
      );
    if (args[0] === "get" && args[1] === "services")
      return ok(
        JSON.stringify({
          metadata: {
            type: "Services.v1alpha1.talos.dev",
            id: "ext-pgcf-sandbox-controller",
          },
          spec: { running: true, healthy: true, unknown: false },
        }),
      );
    this.log.push(`talosctl ${args.join(" ")}`);
    if (args[0] === "dmesg") return ok("");
    throw new Error(`unexpected_talosctl_${args[0]}`);
  }

  private kubectl(args: string[], stdin?: string): CommandResult {
    const [verb, ...rest] = args;
    if (verb === "get") return this.get(rest);
    if (verb === "create") return this.create(JSON.parse(stdin!));
    if (verb === "delete")
      return this.delete(rest[0]!.slice("--raw=".length), JSON.parse(stdin!));
    if (verb === "patch") return this.patch(rest);
    if (verb === "exec") return this.exec(rest);
    throw new Error(`unexpected_kubectl_${verb}`);
  }

  private node() {
    return {
      metadata: {
        name: this.ids.name,
        uid: this.ids.node_uid,
        labels: {
          "pgcf.io/node-id": this.ids.node_id,
          "pgcf.io/provider-instance-id": this.ids.provider_instance_id,
          "pgcf.io/region": this.ids.region_id,
        },
      },
      status: {
        conditions: [{ type: "Ready", status: "True" }],
        nodeInfo: {
          systemUUID: this.system.toUpperCase(),
          bootID: this.boot,
          kernelVersion: this.kernel,
        },
      },
    };
  }
  private driver() {
    return {
      metadata: {
        name: "openebs-lvm-localpv-node-eu1",
        uid: this.driverUid,
        ownerReferences: [
          {
            kind: "DaemonSet",
            controller: true,
            name: "openebs-lvm-localpv-node",
            uid: this.daemonSetUid,
          },
        ],
      },
      spec: {
        nodeName: this.ids.name,
        containers: [{ name: "openebs-lvm-plugin", image: this.driverImage }],
      },
      status: {
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [
          { name: "openebs-lvm-plugin", imageID: this.driverImage },
        ],
      },
    };
  }
  private daemonSet() {
    return {
      metadata: { name: "openebs-lvm-localpv-node", uid: this.daemonSetUid },
      spec: {
        template: {
          spec: {
            volumes: [
              {
                name: "device-dir",
                hostPath: { path: "/dev", type: "Directory" },
              },
              {
                name: "pgcf-host-cgroup",
                hostPath: { path: "/sys/fs/cgroup", type: "Directory" },
              },
            ],
            containers: [
              {
                name: "openebs-lvm-plugin",
                securityContext: { privileged: true },
                volumeMounts: [
                  { name: "device-dir", mountPath: "/dev" },
                  { name: "pgcf-host-cgroup", mountPath: "/sys/fs/cgroup" },
                ],
              },
            ],
          },
        },
      },
    };
  }
  private podObject(pod: Pod) {
    return {
      metadata: {
        name: pod.name,
        namespace: this.namespace,
        uid: pod.uid,
        resourceVersion: String(pod.rv),
        creationTimestamp: pod.created,
        annotations: this.annotations(),
      },
      spec: pod.phase === "Pending" ? {} : { nodeName: this.ids.name },
      status: { phase: pod.phase },
    };
  }
  private claimObject(claim: Claim) {
    return {
      metadata: {
        name: claim.name,
        namespace: this.namespace,
        uid: claim.uid,
        resourceVersion: String(claim.rv),
        annotations: this.annotations(),
      },
      spec: {
        ...(claim.bound ? { volumeName: `pvc-${claim.uid}` } : {}),
        storageClassName: this.namespace,
      },
    };
  }
  private volumeObject(pv: Persistent) {
    return {
      metadata: { name: pv.name, uid: pv.uid, resourceVersion: String(pv.rv) },
      spec: {
        claimRef: {
          namespace: this.namespace,
          name: pv.claim.name,
          uid: pv.claim.uid,
        },
        storageClassName: this.namespace,
        csi: { driver: "local.csi.openebs.io", volumeHandle: pv.name },
        persistentVolumeReclaimPolicy: pv.policy,
      },
    };
  }
  private owned(uid: string) {
    return {
      metadata: { uid, resourceVersion: "7", annotations: this.annotations() },
    };
  }

  private get(args: string[]): CommandResult {
    const at = args.indexOf("--namespace"),
      namespace = at >= 0 ? args[at + 1] : undefined;
    const [kind, name] = args.filter(
      (value, index) =>
        !value.startsWith("--") && args[index - 1] !== "--namespace",
    );
    // --ignore-not-found prints nothing for an absent object.
    const one = (value: unknown) => ok(value ? JSON.stringify(value) : "");
    switch (kind) {
      case "node":
        return one(this.node());
      case "namespace":
        if (name === "kube-system")
          return one({ metadata: { uid: this.ids.cluster_uid } });
        return one(this.namespaceUid && this.owned(this.namespaceUid));
      case "pods":
        return one({
          items:
            namespace === "openebs"
              ? [this.driver()]
              : [...this.pods.values()].map((pod) => this.podObject(pod)),
        });
      case "daemonset":
        return one(this.daemonSet());
      case "pod": {
        if (namespace === "openebs") return one(this.driver());
        const pod = this.pods.get(name!);
        if (pod?.phase === "Pending") {
          this.elapse(SCHEDULER_RETRY_MS);
          this.schedule(pod);
        }
        return one(pod && this.podObject(pod));
      }
      case "persistentvolumeclaim":
        return one(
          this.claims.has(name!) && this.claimObject(this.claims.get(name!)!),
        );
      case "persistentvolumeclaims":
        return one({
          items: [...this.claims.values()].map((claim) =>
            this.claimObject(claim),
          ),
        });
      case "persistentvolume":
        return one(
          this.volumes.has(name!) &&
            this.volumeObject(this.volumes.get(name!)!),
        );
      case "persistentvolumes":
        return one({
          items: [...this.volumes.values()].map((pv) => this.volumeObject(pv)),
        });
      case "storageclass":
      case "volumeattributesclass":
        return one(
          this.classes.has(kind) && this.owned(this.classes.get(kind)!),
        );
    }
    return one({ items: [] });
  }

  private create(manifest: {
    kind: string;
    metadata: { name: string };
    spec: {
      resources?: { requests: { storage: string } };
      volumes?: { persistentVolumeClaim?: { claimName: string } }[];
      securityContext?: { fsGroup?: number; fsGroupChangePolicy?: string };
      containers?: { command?: string[] }[];
    };
  }): CommandResult {
    const name = manifest.metadata.name;
    if (manifest.kind === "PersistentVolumeClaim") {
      const claim = {
        name,
        uid: randomUUID(),
        rv: this.nextVersion(),
        size: Number(manifest.spec.resources!.requests.storage),
        bound: false,
      };
      this.log.push(`create ${manifest.kind} ${name} ${claim.size}`);
      this.claims.set(name, claim);
      return ok(JSON.stringify(this.claimObject(claim)));
    }
    this.log.push(`create ${manifest.kind} ${name}`);
    if (manifest.kind !== "Pod")
      throw new Error(`unexpected_create_${manifest.kind}`);
    const security = manifest.spec.securityContext ?? {};
    const pod: Pod = {
      name,
      uid: randomUUID(),
      rv: this.nextVersion(),
      created: new Date().toISOString(),
      phase: "Pending",
      claim: manifest.spec.volumes![0]!.persistentVolumeClaim!.claimName,
      script: manifest.spec.containers![0]!.command!.at(-1)!,
      fsGroupAlways:
        security.fsGroup !== undefined &&
        security.fsGroupChangePolicy !== "OnRootMismatch",
    };
    this.pods.set(name, pod);
    this.schedule(pod);
    return ok(JSON.stringify(this.podObject(pod)));
  }
  /**
   * WaitForFirstConsumer: the scheduler places a Pod whose claim is unbound only if the claim fits
   * the reported capacity, then the claim binds to a new thin LV in the pool. A refused Pod stays
   * Pending, as on EU1, where FailedScheduling reported "did not have enough free storage".
   */
  private schedule(pod: Pod) {
    const claim = this.claims.get(pod.claim);
    if (claim && !claim.bound) {
      if (claim.size > this.capacity()) {
        this.log.push(`unschedulable ${pod.name} ${claim.size}`);
        return;
      }
      claim.bound = true;
      const pv = `pvc-${claim.uid}`;
      this.volumes.set(pv, {
        name: pv,
        uid: randomUUID(),
        claim: { name: claim.name, uid: claim.uid },
        policy: "Retain",
        rv: this.nextVersion(),
      });
      this.addLv({
        name: pv,
        uuid: lvm(`N${this.minor}`),
        segtype: "thin",
        pool: POOL,
        size: claim.size,
        tags: [],
      });
    }
    if (claim && pod.script.includes("exec postgres")) {
      // The mount re-applies fsGroup (group rwx, setgid) to an existing PGDATA; initdb creates 0700.
      if (claim.pgdata === undefined) claim.pgdata = 0o700;
      else if (pod.fsGroupAlways) claim.pgdata = 0o2770;
      if (/chmod 0700 "\$PGDATA"[\s\S]*exec postgres/.test(pod.script))
        claim.pgdata = 0o700;
      // PostgreSQL refuses any data directory mode other than 0700 or 0750 and exits.
      if (claim.pgdata !== 0o700 && claim.pgdata !== 0o750) {
        pod.phase = "Failed";
        return;
      }
    }
    pod.phase = "Running";
  }

  private delete(
    path: string,
    options: { preconditions: { uid: string } },
  ): CommandResult {
    this.log.push(`delete ${path}`);
    const uid = options.preconditions.uid;
    let match = /^\/api\/v1\/namespaces\/[^/]+\/pods\/([^/]+)$/.exec(path);
    if (match) {
      if (this.pods.get(match[1]!)?.uid !== uid)
        throw new Error("pod_precondition");
      this.pods.delete(match[1]!);
      return ok("");
    }
    match =
      /^\/api\/v1\/namespaces\/[^/]+\/persistentvolumeclaims\/([^/]+)$/.exec(
        path,
      );
    if (match) {
      const claim = this.claims.get(match[1]!);
      if (claim?.uid !== uid) throw new Error("claim_precondition");
      this.release(claim);
      return ok("");
    }
    match = /^\/api\/v1\/namespaces\/([^/]+)$/.exec(path);
    if (match) {
      if (this.namespaceUid !== uid) throw new Error("namespace_precondition");
      this.namespaceUid = null;
      this.pods.clear();
      for (const claim of [...this.claims.values()]) this.release(claim);
      return ok("");
    }
    match =
      /^\/apis\/storage\.k8s\.io\/v1\/(storageclasses|volumeattributesclasses)\//.exec(
        path,
      );
    if (match) {
      const kind =
        match[1] === "storageclasses"
          ? "storageclass"
          : "volumeattributesclass";
      if (this.classes.get(kind) !== uid) throw new Error("class_precondition");
      this.classes.delete(kind);
      return ok("");
    }
    throw new Error(`unexpected_delete_${path}`);
  }
  /** The CSI provisioner deletes a released volume whose reclaim policy is Delete. */
  private release(claim: Claim) {
    this.claims.delete(claim.name);
    const pv = [...this.volumes.values()].find(
      (value) => value.claim.uid === claim.uid,
    );
    if (pv?.policy === "Delete") this.reclaim(pv);
  }
  private reclaim(pv: Persistent) {
    this.volumes.delete(pv.name);
    const lv = this.lv(pv.name)!;
    this.lvs = this.lvs.filter((value) => value !== lv);
    // The pinned OpenEBS LVM 1.10.1 driver removes the pool after deleting its last thin volume.
    if (!this.lvs.some((value) => value.pool === lv.pool))
      this.lvs = this.lvs.filter((value) => value.name !== lv.pool);
  }

  private patch(args: string[]): CommandResult {
    const [kind, name] = args;
    if (kind !== "persistentvolume")
      throw new Error(`unexpected_patch_${kind}`);
    const pv = this.volumes.get(name!)!;
    const ops = JSON.parse(args[args.indexOf("--patch") + 1]!) as {
      op: string;
      path: string;
      value: string;
    }[];
    const current: Record<string, string> = {
      "/metadata/uid": pv.uid,
      "/metadata/resourceVersion": String(pv.rv),
      "/spec/claimRef/uid": pv.claim.uid,
      "/spec/persistentVolumeReclaimPolicy": pv.policy,
    };
    if (ops.some((op) => op.op === "test" && current[op.path] !== op.value))
      return { exit_code: 1, stdout: "" };
    this.log.push(`patch persistentvolume ${name}`);
    pv.policy = "Delete";
    pv.rv = this.nextVersion();
    if (!this.claims.has(pv.claim.name)) this.reclaim(pv);
    return ok(JSON.stringify(this.volumeObject(pv)));
  }

  private exec(args: string[]): CommandResult {
    const namespace = args[1]!,
      pod = args[2]!,
      command = args.slice(args.indexOf("--") + 1);
    if (namespace === "openebs") return this.driverCommand(command);
    this.log.push(`exec ${pod} ${command[0]}`);
    // kubectl cannot exec into a missing or completed Pod.
    if (this.pods.get(pod)?.phase !== "Running")
      return { exit_code: 1, stdout: "" };
    if (command[0] === "pg_isready") return ok("");
    if (command[0] === "psql")
      return ok(
        command
          .filter((_, index) => command[index - 1] === "-c")
          .map((statement) => {
            const range = /id BETWEEN (\d+) AND (\d+)/.exec(statement);
            if (range) return Number(range[2]) - Number(range[1]) + 1;
            return statement.includes("pgcf-q-committed-marker") ? 1 : 0;
          })
          .join("\n") + "\n",
      );
    // On a full pool PostgreSQL PANICs at its next WAL write; restart_after_crash=off fails the Pod.
    if (
      command[0] === "/bin/bash" &&
      command[2]?.includes("INSERT INTO q(v)") &&
      this.poolMode === "out_of_data_space"
    ) {
      this.pods.get(pod)!.phase = "Failed";
      return ok(
        'psql:<stdin>:1: PANIC:  could not write to file "pg_wal/xlogtemp.88": No space left on device\npgcf-rc=2\n',
      );
    }
    if (command[0] === "/bin/bash" && command[2]?.includes('of="$1" bs="$2"')) {
      this.poolMode = "out_of_data_space";
      return ok(
        "dd: error writing '/data/fill': No space left on device\n1015+0 records in\n1014+0 records out\n1063256064 bytes (1.1 GB, 1014 MiB) copied, 2.8 s, 378 MB/s\npgcf-rc=1\npgcf-start=1234.56\npgcf-end=1237.40\n",
      );
    }
    throw new Error(`unexpected_exec_${command[0]}`);
  }

  private driverCommand(args: string[]): CommandResult {
    this.elapse(this.cost(args));
    const [program, ...rest] = args;
    switch (program) {
      case "sha256sum":
        return ok(
          `${sources.driver.binary_sha256}  /usr/local/bin/lvm-driver\n${sources.driver.lvm_binary_sha256}  /sbin/lvm\n${sources.thin_tools.binary_sha256}  /usr/sbin/pdata_tools\n`,
        );
      case "thin_check":
        return ok(`${sources.thin_tools.version}\n`);
      case "cat":
        return ok("cpuset cpu io memory hugetlb pids rdma misc\n");
      case "vgs":
        return ok(
          JSON.stringify({
            report: [
              {
                vg: [
                  {
                    vg_name: "pgcf",
                    vg_uuid: this.vg,
                    vg_size: String(this.total),
                    vg_free: String(this.free()),
                    vg_extent_size: String(4 * MIB),
                    vg_permissions: "writeable",
                    vg_missing_pv_count: "0",
                    pv_count: "1",
                  },
                ],
              },
            ],
          }),
        );
      case "lvs":
        return ok(
          JSON.stringify({
            report: [
              {
                lv: [...this.lvs, ...this.hiddenLvs()].map((lv) => ({
                  vg_uuid: this.vg,
                  lv_name: lv.name,
                  lv_uuid: lv.uuid,
                  lv_size: String(lv.size),
                  segtype: lv.segtype,
                  pool_lv: lv.pool,
                  lv_attr:
                    lv.segtype === "thin-pool"
                      ? `twi-${lv.state}otz--`
                      : lv.segtype === "thin"
                        ? `Vwi-${lv.state}otz--`
                        : `-wi-${lv.state}o----`,
                  data_percent: lv.segtype === "linear" ? "" : "1.00",
                  metadata_percent: lv.segtype === "thin-pool" ? "1.00" : "",
                  lv_metadata_size: lv.metadata ? String(lv.metadata) : "",
                  lv_when_full: lv.segtype === "thin-pool" ? "error" : "",
                  lv_tags: lv.tags.join(","),
                  lv_kernel_major: "253",
                  lv_kernel_minor: String(lv.minor),
                  chunk_size: lv.segtype === "thin-pool" ? "65536" : "0",
                  lv_health_status: "",
                })),
              },
            ],
          }),
        );
      case "dmsetup":
        return this.dmsetup(rest);
      case "lvremove": {
        const name = rest.at(-1)!.slice("pgcf/".length);
        this.log.push(`lvremove ${name}`);
        const busy = this.busy.get(name) ?? 0;
        if (busy > 0) {
          // A device still open, as right after the maximum fill on EU1, refuses removal.
          this.busy.set(name, busy - 1);
          return { exit_code: 5, stdout: "" };
        }
        this.lvs = this.lvs.filter((lv) => lv.name !== name);
        return ok("");
      }
      case "lvcreate": {
        const value = (flag: string) => rest[rest.indexOf(flag) + 1]!;
        // lvm2 2.03 in the pinned driver image refuses this option with --type thin-pool.
        if (rest.includes("--type") && rest.includes("--errorwhenfull"))
          return { exit_code: 3, stdout: "" };
        const name = rest.includes("--thinpool")
          ? value("--thinpool")
          : value("--name");
        this.log.push(`lvcreate ${name}`);
        this.addLv({
          name,
          uuid: lvm("Np"),
          segtype: "thin-pool",
          pool: "",
          size: Number(value("--size").slice(0, -1)),
          metadata: Number(value("--poolmetadatasize").slice(0, -1)),
          tags: rest.filter((_, index) => rest[index - 1] === "--addtag"),
        });
        this.poolMode = "rw";
        return ok("");
      }
      case "lvextend": {
        this.log.push(`lvextend ${rest.join(" ")}`);
        const grown = this.lv(POOL)!;
        grown.size = Number(rest[rest.indexOf("--size") + 1]!.slice(0, -1));
        grown.segments = (grown.segments ?? 1) + 1;
        this.poolMode = "rw";
        return ok("");
      }
      case "sh": {
        const [script, , ...values] = rest.slice(1);
        if (script!.includes('"$@" >/dev/null 2>&1')) {
          const result = this.driverCommand(values);
          return ok(
            `pgcf-rc=${result.exit_code}\npgcf-start=100.00\npgcf-end=100.02\n`,
          );
        }
        if (script!.includes("lvcreate --thin")) {
          const [, pool, size, tag, ...names] = values;
          for (const name of names)
            this.addLv({
              name,
              uuid: lvm(`Rv${name.slice(name.lastIndexOf("_v") + 2)}`),
              segtype: "thin",
              pool: pool!,
              size: Number(size!.slice(0, -1)),
              tags: [tag!],
            });
          this.log.push(`lvcreate ${names.length}`);
          return ok("");
        }
        if (script!.includes("pgcf-read=")) {
          const lv = this.lvs.find(
            (value) => values[0] === `/dev/dm-${value.minor}`,
          );
          return ok(
            `pgcf-read=${lv ? Number(values[1]) * MIB : 0}\npgcf-nonzero=0\n`,
          );
        }
        if (script!.includes("rounds=$2")) {
          this.poolMode = "out_of_data_space";
          return ok(
            `dd: error writing '/dev/dm-20': No space left on device\npgcf-written=${this.lv(POOL)!.size}\npgcf-rc=1\npgcf-start=200.00\npgcf-end=260.00\n`,
          );
        }
      }
    }
    throw new Error(`unexpected_driver_${program}`);
  }
  private dmsetup(args: string[]): CommandResult {
    if (args[0] === "info" && args[1] === "--columns")
      return ok(
        this.lvs
          .flatMap((lv) =>
            lv.segtype === "thin-pool"
              ? [`${this.dm(lv)}-tpool`, `${this.dm(lv)}-pool`]
              : [this.dm(lv)],
          )
          .join("\n") + "\n",
      );
    const uuid = args.at(-1)!,
      lv = this.lvs.find((value) => uuid.startsWith(this.dm(value)));
    if (!lv) return { exit_code: 1, stdout: "" };
    if (args[0] === "info")
      return ok(
        `Name:              pgcf-${lv.name}\nState:             ${lv.state === "s" ? "SUSPENDED" : "ACTIVE"}\nRead Ahead:        256\nTables present:    LIVE\nOpen count:        1\nEvent number:      0\nMajor, minor:      253, ${lv.minor}\nNumber of targets: 1\nUUID: ${uuid}\n`,
      );
    if (args[0] === "status") return ok(this.poolStatus(lv));
    if (args[0] === "table")
      return ok(`0 ${lv.size / 512} thin 253:${this.lv(POOL)!.minor} 1\n`);
    if (args[0] === "suspend" || args[0] === "resume") {
      this.log.push(`dmsetup ${args[0]} ${uuid}`);
      lv.state = args[0] === "suspend" ? "s" : "a";
      return ok("");
    }
    throw new Error(`unexpected_dmsetup_${args[0]}`);
  }
}

export interface QualificationIds {
  id: string;
  node_id: string;
  region_id: string;
  node_uid: string;
  cluster_uid: string;
  name: string;
  provider_instance_id: string;
  address: string;
}

/** One run whose journal and Cloudflare callbacks persist across executor turns. */
export function thinQualificationRun(
  step: ThinQualificationInput["run"]["step"],
  options: { volumeGroupBytes?: number } = {},
) {
  const ids: QualificationIds = {
    id: newOperationId(),
    node_id: "nod_abcdefghij0123456789",
    region_id: "eu-dev",
    node_uid: randomUUID(),
    cluster_uid: randomUUID(),
    name: "eu1",
    provider_instance_id: "202610110001",
    address: "192.0.2.21",
  };
  const world = new ThinWorld(ids, options.volumeGroupBytes);
  const entries: ThinQualificationJournalEntry[] = [];
  const calls: { kind: string; report?: unknown }[] = [];
  const lease = { operation_id: newOperationId(), revision: 1 };
  let revision = 0;
  const callback = `https://api.invalid/internal/v1/thin-qualifications/${ids.id}`;
  const confirm = (
    key: string,
    facts: Record<string, unknown>,
    nonce = newOperationId(),
  ) => {
    entries.push({
      key,
      state: "confirmed",
      nonce,
      at: new Date().toISOString(),
      facts,
    });
    revision++;
  };

  // The untouched baseline: one retained thick LV, then the scratch pool and its namespace.
  const thick = world.addLv({
    name: "pvc-11111111-1111-4111-8111-111111111111",
    uuid: lvm("Tk"),
    segtype: "linear",
    pool: "",
    size: 5 * GIB,
    tags: [],
  });
  const snapshot = {
    observed_at: new Date().toISOString(),
    thick_allocated_bytes: thick.size,
    volumes: [
      {
        name: thick.name,
        lv_uuid: thick.uuid,
        size_bytes: thick.size,
        segtype: "linear",
      },
    ],
    claims: [],
    lvm_volumes: [],
    clusters: [],
  };
  const identity = {
    node_uid: ids.node_uid,
    cluster_uid: ids.cluster_uid,
    boot_id: world.boot,
    system_uuid: world.system,
    kernel_version: world.kernel,
    volume_group_uuid: world.vg,
    volume_group_bytes: world.total,
    extent_bytes: 4 * MIB,
    driver_pod_uid: world.driverUid,
    driver_image: profile.driver_image,
    driver_image_id: profile.driver_image,
    driver_sha256: sources.driver.binary_sha256,
    lvm_sha256: sources.driver.lvm_binary_sha256,
    tools_sha256: sources.thin_tools.binary_sha256,
    thin_tools_version: sources.thin_tools.version,
    host_extension_image: `ghcr.io/amerged-org/pgcf-regional:sandbox-extension-sha-${"c".repeat(40)}@sha256:${"c".repeat(64)}`,
    host_extension_version: world.extension,
    observed_at: new Date().toISOString(),
  };
  confirm("setup:baseline", {
    identity,
    volume_group_free_bytes: world.free(),
    logical_volumes: snapshot.volumes,
    thick: snapshot,
  });
  world.namespaceUid = randomUUID();
  world.classes.set("storageclass", randomUUID());
  world.classes.set("volumeattributesclass", randomUUID());
  confirm("setup:namespace", { uid: world.namespaceUid });
  confirm("setup:network-policy", { uid: randomUUID() });
  confirm("setup:quota", { uid: randomUUID() });
  confirm("setup:storage-class", { uid: world.classes.get("storageclass")! });
  confirm("setup:attributes-class", {
    uid: world.classes.get("volumeattributesclass")!,
  });
  const action = newOperationId();
  const pool = world.addLv({
    name: POOL,
    uuid: lvm("Pl"),
    segtype: "thin-pool",
    pool: "",
    size: profile.initial_data_bytes,
    metadata: profile.metadata_bytes,
    tags: [`pgcf.node.${ids.node_uid}`, `pgcf.action.${action}`],
  });
  const poolFacts = {
    pool_uuid: pool.uuid,
    data_bytes: pool.size,
    metadata_bytes: pool.metadata,
    chunk_bytes: 65536,
    when_full: "error",
    zeroing: true,
    tags: pool.tags,
  };
  confirm("setup:pool", poolFacts, action);
  const setup: ThinQualificationSetup = {
    identity,
    volume_group_free_bytes: world.free() + pool.size + 2 * pool.metadata,
    logical_volumes: snapshot.volumes,
    thick: snapshot,
    pool: poolFacts,
    namespace_uid: world.namespaceUid,
    storage_class_uid: world.classes.get("storageclass")!,
    attributes_class_uid: world.classes.get("volumeattributesclass")!,
  };

  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.kind === "status")
      return Response.json({
        run_id: ids.id,
        step: run.step,
        lease_id: lease.operation_id,
        lease_revision: lease.revision,
        node_uid: ids.node_uid,
        release_id: "r2",
        spec_sha256: "c".repeat(64),
      });
    if (body.kind === "checkpoint") {
      const value = ThinQualificationCheckpoint.parse({
        expected_revision: body.expected_revision,
        entry: body.entry,
      });
      const at = entries.findIndex((entry) => entry.key === value.entry.key);
      const existing = entries[at];
      if (
        value.expected_revision !== revision ||
        (existing &&
          (existing.state === "confirmed" ||
            value.entry.state !== "confirmed" ||
            value.entry.nonce !== existing.nonce))
      )
        return new Response(null, { status: 409 });
      if (existing) entries[at] = value.entry;
      else entries.push(value.entry);
      revision++;
      return Response.json({ revision });
    }
    calls.push(body);
    return Response.json({ kind: body.kind });
  };

  const run = {
    step,
    world,
    ids,
    setup,
    entries,
    calls,
    confirm,
    entry: (key: string) => entries.find((value) => value.key === key),
    /** A scratch PVC, its retained PV and thin LV; `pod: false` when the run already stopped its Pod. */
    workload(
      step: string,
      name: string,
      seed: string,
      options: { pod?: boolean; size?: number } = {},
    ) {
      const claim = randomUUID(),
        pv = `pvc-${claim}`,
        podUid = randomUUID();
      const lv = world.addLv({
        name: pv,
        uuid: lvm(seed),
        segtype: "thin",
        pool: POOL,
        size: options.size ?? profile.maximum_quota_gib * GIB,
        tags: [],
      });
      world.claims.set(name, {
        name,
        uid: claim,
        rv: world.nextVersion(),
        size: lv.size,
        bound: true,
        // A seeded workload already ran: a PostgreSQL volume keeps initdb's 0700 PGDATA.
        pgdata: 0o700,
      });
      world.volumes.set(pv, {
        name: pv,
        uid: randomUUID(),
        claim: { name, uid: claim },
        policy: "Retain",
        rv: world.nextVersion(),
      });
      if (options.pod !== false)
        world.pods.set(name, {
          name,
          uid: podUid,
          rv: world.nextVersion(),
          created: new Date().toISOString(),
          phase: "Running",
          claim: name,
          script: "exec sleep infinity",
          fsGroupAlways: true,
        });
      const facts = {
        claim_uid: claim,
        pv_name: pv,
        pv_uid: world.volumes.get(pv)!.uid,
        lv_uuid: lv.uuid,
        minor: lv.minor,
      };
      confirm(`${step}:${name}:claim`, { uid: claim });
      confirm(`${step}:${name}:pod`, { uid: podUid });
      confirm(`${step}:${name}:volume`, facts);
      return facts;
    },
    /** A workload this run already removed: only its journal entries remain. */
    released(step: string, name: string, seed: string) {
      const claim = randomUUID();
      confirm(`${step}:${name}:claim`, { uid: claim });
      confirm(`${step}:${name}:pod`, { uid: randomUUID() });
      confirm(`${step}:${name}:volume`, {
        claim_uid: claim,
        pv_name: `pvc-${claim}`,
        pv_uid: randomUUID(),
        lv_uuid: lvm(seed),
        minor: 99,
      });
      confirm(`${step}:${name}:release`, { released: true });
    },
    /** One bounded executor turn under a fresh one-hour lease. */
    async turn() {
      const now = Date.now();
      // The relay session ends 20 s after the 570 s turn deadline.
      world.cancelAt = now + 590_000;
      const input = ThinQualificationInput.parse({
        run: {
          ...ids,
          step: run.step,
          release_id: "r2",
          spec_sha256: "c".repeat(64),
          profile,
          profile_sha256: "d".repeat(64),
          postgres_image: `registry.example/postgres@sha256:${"e".repeat(64)}`,
          setup: run.step === "setup" ? null : setup,
          lease: {
            ...lease,
            issued_at: new Date(now).toISOString(),
            expires_at: new Date(now + 3_600_000).toISOString(),
          },
          journal: { revision, entries: structuredClone(entries) },
        },
        host_extension: {
          image: identity.host_extension_image,
          version: "0.1.0",
          sha256: "f".repeat(64),
        },
        cluster_endpoint: `https://${ids.address}:6443/`,
        talos_admin_config: JSON.stringify({
          context: "test",
          contexts: {
            test: {
              ca: "test-only-ca",
              crt: "test-only-client-cert",
              key: "test-only-key",
            },
          },
        }),
        kubeconfig: JSON.stringify({
          clusters: [
            {
              name: "test",
              cluster: {
                server: `https://${ids.address}:6443/`,
                "certificate-authority-data": "test-only-ca",
              },
            },
          ],
          users: [
            {
              name: "test",
              user: {
                "client-certificate-data": "test-only-client-cert",
                "client-key-data": "test-only-key",
              },
            },
          ],
          contexts: [
            { name: "test", context: { cluster: "test", user: "test" } },
          ],
          "current-context": "test",
        }),
        callback: { url: callback, bearer: "t".repeat(43) },
      });
      return await runThinQualification(input, {
        proxy: async () => ({
          url: "http://127.0.0.1:1",
          close: async () => {},
        }),
        request,
        run: (command) => world.command(command),
      });
    },
  };
  return run;
}
