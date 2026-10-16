// SPDX-License-Identifier: Apache-2.0
// One identity turn's controlled node: cluster objects, Talos reads and LVM state behind the same
// command boundary the executor uses. The driver's shell scripts run in a real shell against fixed
// program outputs, so a script that names another program or another argument fails. Counts what
// crosses the relay; never a live observation.
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  STORAGE_PROTECTION_LEDGER_KEY,
  thinStorageClass,
  thinStorageClassObject,
  thinVolumeAttributesClassObject,
} from "@pgcf/contracts";
import { canonicalStorageAuthorityKeys } from "@pgcf/contracts/storage-write-authority";
import type {
  NodeThinStorageInput,
  NodeThinStorageReport,
} from "@pgcf/contracts/node-thin-storage";
import { NODE_HOST_PATHS } from "@pgcf/contracts/node-host-configuration";
import {
  BootstrapError,
  runCommand,
  type Command,
  type CommandResult,
} from "../src/bootstrap.ts";
import { runThinStorage, thinPodCgroupPaths } from "../src/thin-storage.ts";
import {
  ThinWorld,
  lvm,
  profile,
  type QualificationIds,
} from "./thin-qualification.fixture.ts";

const GIB = 1024 ** 3;
const ok = (stdout: string): CommandResult => ({ exit_code: 0, stdout });
/** A deterministic UUID, so one turn's report is a fixed document. */
export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

interface K8sObject {
  metadata: { name: string; namespace?: string; [key: string]: unknown };
  [key: string]: unknown;
}
interface Kind {
  key: string;
  kind: string;
  apiVersion: string;
  namespaced: boolean;
  names: string[];
}
const KINDS: Kind[] = [
  {
    key: "node",
    kind: "Node",
    apiVersion: "v1",
    namespaced: false,
    names: ["node", "nodes", "no"],
  },
  {
    key: "namespace",
    kind: "Namespace",
    apiVersion: "v1",
    namespaced: false,
    names: ["namespace", "namespaces", "ns"],
  },
  {
    key: "pod",
    kind: "Pod",
    apiVersion: "v1",
    namespaced: true,
    names: ["pod", "pods", "po"],
  },
  {
    key: "daemonset",
    kind: "DaemonSet",
    apiVersion: "apps/v1",
    namespaced: true,
    names: ["daemonset", "daemonsets", "ds"],
  },
  {
    key: "pv",
    kind: "PersistentVolume",
    apiVersion: "v1",
    namespaced: false,
    names: ["persistentvolume", "persistentvolumes", "pv"],
  },
  {
    key: "pvc",
    kind: "PersistentVolumeClaim",
    apiVersion: "v1",
    namespaced: true,
    names: ["persistentvolumeclaim", "persistentvolumeclaims", "pvc"],
  },
  {
    key: "lvmvolume",
    kind: "LVMVolume",
    apiVersion: "local.openebs.io/v1alpha1",
    namespaced: true,
    names: ["lvmvolume", "lvmvolumes", "lvmvolumes.local.openebs.io"],
  },
  {
    key: "cluster",
    kind: "Cluster",
    apiVersion: "postgresql.cnpg.io/v1",
    namespaced: true,
    names: ["cluster", "clusters", "clusters.postgresql.cnpg.io"],
  },
  {
    key: "configmap",
    kind: "ConfigMap",
    apiVersion: "v1",
    namespaced: true,
    names: ["configmap", "configmaps", "cm"],
  },
  {
    key: "storageclass",
    kind: "StorageClass",
    apiVersion: "storage.k8s.io/v1",
    namespaced: false,
    names: ["storageclass", "storageclasses", "sc"],
  },
  {
    key: "volumeattributesclass",
    kind: "VolumeAttributesClass",
    apiVersion: "storage.k8s.io/v1",
    namespaced: false,
    names: ["volumeattributesclass", "volumeattributesclasses", "vac"],
  },
];

export interface RelayCommand {
  executable: string;
  /** What the command asks, after the client's own connection flags. */
  args: string[];
  /** Relay connections the command opens one after another: `kubectl exec` gets the Pod, then upgrades. */
  weight: number;
  /** Sequential relay connections up to and including this command. */
  level: number;
  /** Order of its start and end among all commands. */
  started: number;
  ended: number;
  /** The programs a driver shell script ran, with their arguments, in order. */
  programs: string[];
}

export interface DatabaseOptions {
  /** `writer` runs one instance Pod with io.max, `sleeper` is hibernated with its protection marker,
   * `held` started a Pod whose cgroup has no io.max yet, `deleting` keeps only its sealed LV. */
  kind: "writer" | "sleeper" | "held" | "deleting";
  /** Instance Pods of a writer, each with its own cgroup. */
  pods?: number;
}

export class IdentityWorld extends ThinWorld {
  readonly relay: RelayCommand[] = [];
  /** Relay connections of the longest completed chain: what a turn costs in sequential round trips. */
  private settled = 0;
  readonly hostFiles = new Map<string, string>();
  readonly store = new Map<string, K8sObject[]>();
  /** Pod UID to the content of its cgroup's io.max; a Pod without an entry has no readable cgroup. */
  readonly cgroups = new Map<string, string>();
  private clock = 0;
  private scripts = 0;
  /** Programs of the driver's shell scripts that exit non-zero. */
  readonly failing = new Set<string>();
  /** A program's output where the world must differ from its own state. */
  readonly outputs = new Map<string, string>();
  /** Runs after each driver script ended, with the number that have ended: the cluster moves on. */
  afterScript?: (count: number) => void;
  readonly profileSha256 = "d".repeat(64);
  readonly databases: NodeThinStorageInput["lease"]["databases"] = [];
  private nextSeed = 1;
  readonly leaseOperation = "op_abcdefghijklmnopqrst";
  readonly host: NodeThinStorageInput["host_configuration"];
  poolUuid: string;

  constructor(ids: QualificationIds) {
    super(ids);
    // The base world draws random identities; a turn's report must be one fixed document.
    Object.assign(this, {
      boot: uuid(0xb0),
      system: uuid(0x5e),
      driverUid: uuid(0xd1),
      daemonSetUid: uuid(0xd5),
    });
    const keys = { cf: "A".repeat(43) },
      settings = {
        cloudflare: {
          node_id: ids.node_id,
          node_uid: ids.node_uid,
          region_id: ids.region_id,
          material_revision: 1,
          api_url: "https://api.invalid",
          agent_key_file: NODE_HOST_PATHS.agent_key,
          storage_authority: {
            keys,
            sha256: createHash("sha256")
              .update(canonicalStorageAuthorityKeys(keys))
              .digest("hex"),
            legacy_database_ids: [],
          },
        },
      };
    this.host = {
      status: {
        version: 1,
        node_id: ids.node_id,
        node_uid: ids.node_uid,
        region_id: ids.region_id,
        cluster_uid: ids.cluster_uid,
        material_revision: 1,
        revision: 1,
        sha256: "a".repeat(64),
        release_id: "turn-fixture",
        pool_policy_revision: 1,
        profile_sha256: "b".repeat(64),
        created_at: "2026-10-16T00:00:00.000Z",
      },
      files: [
        {
          path: NODE_HOST_PATHS.settings,
          permissions: 384,
          content: JSON.stringify(settings),
        },
        {
          path: NODE_HOST_PATHS.agent_key,
          permissions: 384,
          content: "test-only\n",
        },
      ],
    };
    for (const file of this.host.files)
      this.hostFiles.set(file.path, file.content);
    // The untouched baseline (one retained thick LV) and the initialized pool.
    this.addLv({
      name: "pvc-11111111-1111-4111-8111-111111111111",
      uuid: lvm("Tk"),
      segtype: "linear",
      pool: "",
      size: 5 * GIB,
      tags: [],
    });
    const pool = this.addLv({
      name: "pgcf_thinpool",
      uuid: lvm("Pl"),
      segtype: "thin-pool",
      pool: "",
      size: 6 * GIB,
      metadata: profile.metadata_bytes,
      tags: [`pgcf.node.${ids.node_uid}`, `pgcf.action.${this.leaseOperation}`],
    });
    this.poolUuid = pool.uuid;
    const classes = this.classObjects();
    this.store.set("storageclass", [classes[0]!]);
    this.store.set("volumeattributesclass", [classes[1]!]);
  }

  /** The driver container's programs, as one direct `kubectl exec` or a shell script's shim sees them. */
  protected override driverCommand(args: string[]): CommandResult {
    if (this.failing.has(args[0]!)) return { exit_code: 1, stdout: "" };
    const forced = this.outputs.get(args[0]!);
    return forced === undefined ? super.driverCommand(args) : ok(forced);
  }

  get className() {
    return thinStorageClass(this.profileSha256);
  }
  private classObjects() {
    return [
      thinStorageClassObject(profile, this.profileSha256),
      thinVolumeAttributesClassObject(profile, this.profileSha256),
    ].map((object, index) => ({
      ...object,
      metadata: { ...object.metadata, uid: uuid(0xc0 + index) },
    }));
  }
  private collection(key: string): K8sObject[] {
    return this.store.get(key) ?? [];
  }
  private add(key: string, object: K8sObject) {
    this.store.set(key, [...this.collection(key), object]);
  }

  /** One database with its Kubernetes objects, thin LV and the lease's view of it. */
  addDatabase(id: string, options: DatabaseOptions) {
    const seed = this.nextSeed++,
      n = seed * 16,
      namespace = `pgcf-db-${id}`,
      handle = `pvc-${uuid(n + 4)}`,
      archive = `s3://backups/${id}/g1-${this.leaseOperation}`;
    const storage = {
      backend: "lvm-thin-v1" as const,
      storage_class: this.className,
      volume_attributes_class: this.className,
      profile_revision: 1,
      profile_sha256: this.profileSha256,
      node_uid: this.ids.node_uid,
      volume_group_uuid: this.vg,
      pool_uuid: this.poolUuid,
      startup_reserve_bytes: profile.startup_reserve_bytes,
      write_bytes_per_second: profile.write_bytes_per_second,
      write_iops_per_second: profile.write_iops_per_second,
      guard_seconds: profile.guard_seconds,
      drain_seconds: profile.drain_seconds,
    };
    const lv = this.addLv({
      name: handle,
      uuid: lvm(`V${seed}`),
      segtype: "thin",
      pool: "pgcf_thinpool",
      size: 5 * GIB,
      tags: [],
    });
    const receipt = {
      storage_generation: 1,
      storage_uid: uuid(n + 1),
      namespace_uid: uuid(n + 2),
      cluster_uid: uuid(n + 3),
      node_uid: this.ids.node_uid,
      volume_group_uuid: this.vg,
      pool_uuid: this.poolUuid,
      volume_handle: handle,
      lv_uuid: lv.uuid,
      pvc_uid: uuid(n + 5),
      pv_uid: uuid(n + 4),
    };
    const entry: NodeThinStorageInput["lease"]["databases"][number] = {
      id,
      generation: 2,
      storage_generation: 1,
      desired_state:
        options.kind === "deleting"
          ? "deleted"
          : options.kind === "sleeper"
            ? "suspended"
            : "running",
      archive_path: archive,
      power_operation: null,
      stop_operation:
        options.kind === "deleting"
          ? {
              operation_id: this.leaseOperation,
              kind: "database.delete",
              generation: 2,
            }
          : null,
      storage,
      volume: receipt,
      startup:
        options.kind === "held"
          ? {
              operation_id: `op_${"hold".padEnd(20, "0")}`,
              generation: 2,
              node_uid: this.ids.node_uid,
              budget_bytes: 8 * GIB,
              expires_at: new Date(Date.now() + 95_000).toISOString(),
            }
          : null,
    };
    this.databases.push(entry);
    if (options.kind === "deleting") return entry;
    this.add("namespace", {
      metadata: { name: namespace, uid: receipt.namespace_uid },
    });
    this.add("cluster", {
      metadata: {
        name: "database",
        namespace,
        uid: receipt.cluster_uid,
        annotations:
          options.kind === "sleeper" ? { "cnpg.io/hibernation": "on" } : {},
      },
    });
    const data: Record<string, string> = {
      state: JSON.stringify({
        namespaceUid: receipt.namespace_uid,
        clusterUid: receipt.cluster_uid,
        node: this.ids.name,
        archivePath: archive,
        storage,
      }),
    };
    if (options.kind === "sleeper") {
      entry.power_operation = `op_${"sleep".padEnd(20, "0")}`;
      data[STORAGE_PROTECTION_LEDGER_KEY] = JSON.stringify({
        database_id: id,
        generation: entry.generation,
        operation_id: entry.power_operation,
        storage_uid: receipt.storage_uid,
        namespace_uid: receipt.namespace_uid,
        cluster_uid: receipt.cluster_uid,
        node_uid: this.ids.node_uid,
        profile_sha256: this.profileSha256,
        requested_at: 1_700_000_000_000,
      });
    }
    this.add("configmap", {
      metadata: {
        name: `storage-${id}`,
        namespace: "pgcf-system",
        uid: receipt.storage_uid,
      },
      data,
    });
    this.add("pvc", {
      metadata: { name: "database-1", namespace, uid: receipt.pvc_uid },
      spec: {
        volumeName: handle,
        storageClassName: this.className,
        volumeAttributesClassName: this.className,
      },
    });
    this.add("pv", {
      metadata: { name: handle, uid: receipt.pv_uid },
      spec: {
        claimRef: { uid: receipt.pvc_uid, namespace },
        csi: { driver: "local.csi.openebs.io", volumeHandle: handle },
        storageClassName: this.className,
        volumeAttributesClassName: this.className,
      },
    });
    this.add("lvmvolume", {
      metadata: { name: handle, namespace: "openebs" },
      spec: { ownerNodeID: this.ids.name, volGroup: "pgcf" },
    });
    const pods = options.kind === "sleeper" ? 0 : (options.pods ?? 1);
    for (let index = 0; index < pods; index++) {
      const uid = uuid(n + 8 + index);
      this.add("pod", {
        metadata: {
          name: `database-${index + 1}`,
          namespace,
          uid,
          labels: { "cnpg.io/podRole": "instance" },
        },
        spec: { nodeName: this.ids.name },
        status: { phase: "Running" },
      });
      if (options.kind !== "held")
        this.cgroups.set(
          uid,
          `${253}:${lv.minor} rbps=max wbps=${profile.write_bytes_per_second} riops=max wiops=${profile.write_iops_per_second}\n`,
        );
    }
    return entry;
  }

  /** The executor's input for the current world, a minute and a half of lease ahead. */
  input(overrides: { class_creation_allowed?: boolean } = {}) {
    const now = Date.now(),
      ids = this.ids;
    return {
      class_creation_allowed: overrides.class_creation_allowed ?? false,
      lease: {
        operation_id: this.leaseOperation,
        release_id: "turn-fixture",
        spec_sha256: "c".repeat(64),
        assignment_revision: 3,
        region_revision: 4,
        revision: 7,
        authority_revision: 5,
        node_id: ids.node_id,
        region_id: ids.region_id,
        node_uid: ids.node_uid,
        cluster_uid: ids.cluster_uid,
        name: ids.name,
        provider_instance_id: ids.provider_instance_id,
        address: ids.address,
        volume_group_uuid: this.vg,
        pool_uuid: this.poolUuid,
        profile_revision: 1,
        profile_sha256: this.profileSha256,
        profile,
        material_revision: 1,
        kernel_version: this.kernel,
        boot_id: this.boot,
        configuration_boot_id: null,
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + 95_000).toISOString(),
        required_data_free_bytes: 256 * 1024 ** 2,
        required_metadata_free_bytes: 32 * 1024 ** 2,
        action: null,
        databases: this.databases,
      },
      host_extension: {
        image: `ghcr.io/amerged-org/pgcf-regional:sandbox-extension-sha-${"c".repeat(40)}@sha256:${"c".repeat(64)}`,
        version: this.extension,
        sha256: "f".repeat(64),
      },
      host_configuration: this.host,
      cluster_endpoint: `https://${ids.address}:6443/`,
      talos_admin_config: JSON.stringify({
        context: "test",
        contexts: {
          test: { ca: "test-only", crt: "test-only", key: "test-only" },
        },
      }),
      kubeconfig: JSON.stringify({
        clusters: [
          {
            cluster: {
              server: `https://${ids.address}:6443/`,
              "certificate-authority-data": "test-only",
            },
          },
        ],
        users: [
          {
            user: {
              "client-certificate-data": "test-only",
              "client-key-data": "test-only",
            },
          },
        ],
      }),
      callback: {
        url: `https://api.invalid/internal/v1/node-thin-storage/${ids.node_id}`,
        bearer: "t".repeat(43),
      },
    } as NodeThinStorageInput;
  }

  get commands() {
    return this.relay.length;
  }
  /** Sequential relay connections of the longest chain of commands the turn issued. */
  get rounds() {
    return this.relay.reduce(
      (most, command) => Math.max(most, command.level),
      0,
    );
  }

  override async command(command: Command): Promise<CommandResult> {
    const args =
      command.executable === "talosctl"
        ? command.args.slice(6)
        : command.args.slice(3);
    const weight =
      command.executable === "kubectl" && args[0] === "exec" ? 2 : 1;
    const record: RelayCommand = {
      executable: command.executable,
      args,
      weight,
      level: this.settled + weight,
      started: ++this.clock,
      ended: 0,
      programs: [],
    };
    this.relay.push(record);
    try {
      // Commands issued together all start before any of them completes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await this.dispatch(command, args, record);
    } finally {
      record.ended = ++this.clock;
      this.settled = Math.max(this.settled, record.level);
    }
  }

  private async dispatch(
    command: Command,
    args: string[],
    record: RelayCommand,
  ): Promise<CommandResult> {
    if (command.executable === "talosctl") {
      if (args[0] === "get" && args[1] === "machineconfig")
        return ok(this.machineConfiguration());
      if (args[0] === "read" && this.hostFiles.has(args[1]!))
        return ok(this.hostFiles.get(args[1]!)!);
      return await super.command(command);
    }
    if (command.executable !== "kubectl")
      throw new Error(`unexpected_executable_${command.executable}`);
    if (args[0] === "get") return this.kubeGet(args.slice(1));
    if (args[0] === "exec") {
      const inner = args.slice(args.indexOf("--") + 1);
      if (
        args[1] === "--namespace" &&
        args[2] === "openebs" &&
        inner[0] === "sh"
      )
        return await this.driverScript(inner.slice(1), command.signal, record);
    }
    return await super.command(command);
  }

  private machineConfiguration() {
    return ["v1alpha1", "persistent"]
      .map((id) =>
        JSON.stringify({
          metadata: { type: "MachineConfigs.config.talos.dev", id },
          spec: stringify({
            version: "v1alpha1",
            machine: {
              files: this.host.files.map((file) => ({ ...file, op: "create" })),
            },
          }),
        }),
      )
      .join("\n");
  }

  /** `kubectl get`: the argument forms and output shapes of kubectl 1.36 that the executor uses. */
  private kubeGet(args: string[]): CommandResult {
    let namespace: string | undefined,
      all = false,
      ignore = false,
      json = false;
    const words: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const word = args[index]!;
      if (word === "--namespace" || word === "-n") namespace = args[++index];
      else if (word === "--all-namespaces" || word === "-A") all = true;
      else if (word === "--ignore-not-found") ignore = true;
      else if (word === "--output=json") json = true;
      else if (word.startsWith("-"))
        throw new Error(`unexpected_kubectl_flag_${word}`);
      else words.push(word);
    }
    if (!json || words.length === 0) throw new Error("unexpected_kubectl_get");
    const slashed = words.filter((word) => word.includes("/"));
    // kubectl refuses a resource type next to arguments in resource/name form.
    if (slashed.length && slashed.length !== words.length)
      return { exit_code: 1, stdout: "" };
    let wanted: { type: string; name?: string }[];
    if (slashed.length)
      wanted = words.map((word) => ({
        type: word.slice(0, word.indexOf("/")),
        name: word.slice(word.indexOf("/") + 1),
      }));
    else {
      const types = words[0]!.split(","),
        names = words.slice(1);
      if (names.length && types.length !== 1)
        return { exit_code: 1, stdout: "" };
      wanted = names.length
        ? names.map((name) => ({ type: types[0]!, name }))
        : types.map((type) => ({ type }));
    }
    const items: K8sObject[] = [];
    let missing = false;
    for (const { type, name } of wanted) {
      const kind = KINDS.find((candidate) =>
        candidate.names.includes(type.toLowerCase()),
      );
      if (!kind) return { exit_code: 1, stdout: "" };
      const scoped = this.objects(kind.key).filter(
        (object) =>
          !kind.namespaced ||
          all ||
          object.metadata.namespace === (namespace ?? "default"),
      );
      const tag = (object: K8sObject) => ({
        apiVersion: kind.apiVersion,
        kind: kind.kind,
        ...object,
      });
      if (name === undefined) items.push(...scoped.map(tag));
      else {
        const found = scoped.find((object) => object.metadata.name === name);
        if (found) items.push(tag(found));
        else missing = true;
      }
    }
    if (missing && !ignore) return { exit_code: 1, stdout: "" };
    if (wanted.length === 1 && wanted[0]!.name !== undefined)
      return ok(items.length ? JSON.stringify(items[0]) : "");
    // With every named object absent and --ignore-not-found, kubectl prints nothing at all.
    if (!items.length && wanted.every((w) => w.name !== undefined))
      return ok("");
    return ok(
      JSON.stringify({
        apiVersion: "v1",
        items,
        kind: "List",
        metadata: { resourceVersion: "" },
      }),
    );
  }
  private objects(key: string): K8sObject[] {
    switch (key) {
      case "node":
        return [this.node()];
      case "namespace":
        return [
          { metadata: { name: "kube-system", uid: this.ids.cluster_uid } },
          ...this.collection("namespace"),
        ];
      case "pod":
        return [
          ...this.driverPods(this.driver()).map((pod) => ({
            ...pod,
            metadata: { ...pod.metadata, namespace: "openebs" },
          })),
          ...this.collection("pod"),
        ];
      case "daemonset":
        return [
          {
            ...this.daemonSet(),
            metadata: { ...this.daemonSet().metadata, namespace: "openebs" },
          },
        ];
      default:
        return this.collection(key);
    }
  }

  /** The driver container's `sh -ec` script, run by the real shell with the world's program outputs. */
  private async driverScript(
    args: string[],
    signal: AbortSignal,
    record: RelayCommand,
  ): Promise<CommandResult> {
    const [flags, script, ...rest] = args;
    if (flags !== "-ec" || script === undefined)
      throw new Error("unexpected_driver_shell_flags");
    const directory = await mkdtemp(join(tmpdir(), "pgcf-identity-shell-"));
    await chmod(directory, 0o700);
    try {
      const bin = join(directory, "bin"),
        root = join(directory, "cgroup"),
        outputs = join(directory, "out");
      await Promise.all([mkdir(bin), mkdir(root), mkdir(outputs)]);
      const driver = (argv: string[]) =>
        this.failing.has(argv[0]!) ? "" : this.driverCommand(argv).stdout;
      await writeFile(
        join(root, "cgroup.controllers"),
        driver(["cat", "/sys/fs/cgroup/cgroup.controllers"]),
      );
      const files: [string, string][] = [
        ["vgs", driver(["vgs"])],
        ["lvs", driver(["lvs"])],
        ["dmsetup", driver(["dmsetup", "info", "--columns"])],
        ["sha256sum", driver(["sha256sum"])],
        ["thin_check", driver(["thin_check", "--version"])],
      ];
      for (const [name, content] of files)
        await writeFile(join(outputs, name), content);
      const log = join(directory, "programs.log"),
        seen = (name: string) => `printf '%s\\n' "${name} $*" >> '${log}'\n`;
      // Only the read-only programs the product runs exist; any other name is "not found".
      const programs: Record<string, string> = {
        vgs: `${seen("vgs")}exec /bin/cat '${join(outputs, "vgs")}'\n`,
        lvs: `${seen("lvs")}exec /bin/cat '${join(outputs, "lvs")}'\n`,
        sha256sum: `${seen("sha256sum")}exec /bin/cat '${join(outputs, "sha256sum")}'\n`,
        thin_check: `${seen("thin_check")}test "$1" = --version || exit 98\nexec /bin/cat '${join(outputs, "thin_check")}'\n`,
        dmsetup: `${seen("dmsetup")}test "$1 $2" = "info --columns" || exit 99\nexec /bin/cat '${join(outputs, "dmsetup")}'\n`,
        cat: `${seen("cat")}exec /bin/cat "$@"\n`,
      };
      for (const [name, body] of Object.entries(programs)) {
        const path = join(bin, name);
        await writeFile(
          path,
          `#!/bin/sh\n${this.failing.has(name) ? `${seen(name)}exit 1\n` : body}`,
        );
        await chmod(path, 0o700);
      }
      // The container's host cgroup mount lives under the sandbox root.
      const mapped = (value: string) =>
        value.replaceAll("/sys/fs/cgroup", root);
      for (const [pod, content] of this.cgroups)
        for (const path of thinPodCgroupPaths(pod).slice(0, 1)) {
          const target = mapped(path);
          await mkdir(join(target, ".."), { recursive: true });
          await writeFile(target, content);
        }
      const result = await runCommand({
        executable: "/bin/sh",
        args: ["-ec", mapped(script), ...rest.map(mapped)],
        timeout_ms: 20_000,
        signal,
        env: { PATH: bin, LC_ALL: "C" },
      });
      try {
        record.programs.push(
          ...(await readFile(log, "utf8")).split("\n").filter(Boolean),
        );
      } catch {
        // No program ran.
      }
      if (result.exit_code === 127)
        throw new BootstrapError("fixture_driver_program_not_found");
      this.afterScript?.(++this.scripts);
      return result;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/** One whole executor turn against the world; resolves with the report it posted to Cloudflare. */
export async function identityTurn(
  world: IdentityWorld,
  input: NodeThinStorageInput = world.input(),
) {
  const reports: NodeThinStorageReport[] = [];
  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.kind === "status")
      return Response.json({
        operation_id: input.lease.operation_id,
        revision: input.lease.revision,
        node_uid: input.lease.node_uid,
        release_id: input.lease.release_id,
        spec_sha256: input.lease.spec_sha256,
        assignment_revision: input.lease.assignment_revision,
        region_revision: input.lease.region_revision,
      });
    if (body.kind === "report") reports.push(body.report);
    return Response.json({ accepted: true });
  };
  await runThinStorage(input, {
    run: (command) => world.command(command),
    request,
    proxy: async () => ({ url: "http://127.0.0.1:1", close: async () => {} }),
  });
  return { report: reports[0]!, input };
}

/** The databases of one node: a writer with two instance Pods, a sleeper under protection, a start
 * whose Pod has no io.max yet and a delete that retains its LV, plus `extra` single-Pod writers. */
export function identityWorld(extra = 0) {
  const world = new IdentityWorld(identityIds());
  world.addDatabase("w".padEnd(20, "a"), { kind: "writer", pods: 2 });
  world.addDatabase("s".padEnd(20, "a"), { kind: "sleeper" });
  world.addDatabase("h".padEnd(20, "a"), { kind: "held" });
  world.addDatabase("d".padEnd(20, "a"), { kind: "deleting" });
  for (let index = 0; index < extra; index++)
    world.addDatabase(`x${index}`.padEnd(20, "a"), { kind: "writer" });
  return world;
}

export function identityIds(): QualificationIds {
  return {
    id: "op_abcdefghijklmnopqrst",
    node_id: "nod_abcdefghij0123456789",
    region_id: "eu-dev",
    node_uid: uuid(0xa1),
    cluster_uid: uuid(0xa2),
    name: "eu1",
    provider_instance_id: "202610110001",
    address: "192.0.2.21",
  };
}
