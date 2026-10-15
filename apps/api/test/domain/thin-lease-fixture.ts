// SPDX-License-Identifier: Apache-2.0
// A thin node with many databases in each state the host lease tells apart, as controlled D1
// metadata: the rows and the node's identity proof are written directly. No live evidence.
import { env } from "cloudflare:workers";
import {
  DatabaseStorageVolumeReceipt,
  DatabaseWithOperation,
  newDatabaseId,
  newOperationId,
  thinStorageClass,
} from "@pgcf/contracts";
import { HostStorageLease } from "@pgcf/contracts/node-thin-storage";
import { request } from "./fixtures.ts";
import {
  type Fixture,
  gib,
  identityProof,
  iso,
  lvs,
  mib,
} from "./thin-renewal-fixture.ts";

export type LeaseDatabase =
  /** Running and ready; the node's identity proof evidences its Pod's io.max. */
  | { kind: "live" }
  /** Running and ready, but no Pod is evidenced and none is attested. */
  | { kind: "blocked" }
  /** An idle sleep that keeps its own Pod; the controller's report is fresh. */
  | { kind: "parked" }
  /** An idle sleep whose stop operation is still running. */
  | { kind: "stopping" }
  /**
   * Deleted. A confirmed deletion carries the absence read that confirmed it `confirmedAgo`
   * milliseconds ago; `receipt: false` is one that never bound a volume.
   */
  | {
      kind: "deleted";
      confirmed: boolean;
      confirmedAgo?: number;
      receipt?: boolean;
    };

interface Member {
  id: string;
  spec: LeaseDatabase;
  receipt: DatabaseStorageVolumeReceipt | null;
  pod: string;
  generation: number;
}

/**
 * One thin node: the held start of a database created through the API (a startup hold, no volume
 * yet) and any number of rows added by `add`. `commit` writes the identity proof that names every
 * present volume and the Pod evidenced on it, read now.
 */
export async function thinLeaseNode(f: Fixture) {
  const physical = {
    ...f.authority.physical,
    free_bytes: 80 * gib,
    thin_pool: {
      ...f.authority.physical.thin_pool!,
      data_total_bytes: 16 * gib,
    },
  };
  await identityProof(f, { physical });
  const held = DatabaseWithOperation.parse(
    await (await f.create("held")).json(),
  );
  const columns = (
    await env.DB.prepare("PRAGMA table_info(databases)").all<{ name: string }>()
  ).results.map((column) => column.name);
  const limits = {
    write_bytes_per_second: f.profile.write_bytes_per_second,
    write_iops_per_second: f.profile.write_iops_per_second,
  };
  const members: Member[] = [];
  let serial = 0;

  async function add(spec: LeaseDatabase, now = Date.now()) {
    const id = newDatabaseId(),
      index = ++serial,
      pod = crypto.randomUUID();
    const hasReceipt = spec.kind !== "deleted" || spec.receipt !== false;
    const receipt = hasReceipt
      ? DatabaseStorageVolumeReceipt.parse({
          storage_generation: 1,
          storage_uid: crypto.randomUUID(),
          namespace_uid: crypto.randomUUID(),
          cluster_uid: crypto.randomUUID(),
          node_uid: f.uid,
          volume_group_uuid: f.authority.volume_group_uuid,
          pool_uuid: f.authority.pool_uuid,
          volume_handle: `pvc-${crypto.randomUUID()}`,
          lv_uuid: `LV${String(index).padStart(4, "0")}-1234-1234-1234-1234-1234-ABCDEF`,
          pvc_uid: crypto.randomUUID(),
          pv_uid: crypto.randomUUID(),
        })
      : null;
    const sleeping = spec.kind === "parked" || spec.kind === "stopping";
    const deleted = spec.kind === "deleted";
    const generation = deleted ? 3 : sleeping ? 2 : 1;
    const power = sleeping ? newOperationId() : null;
    const confirmedAt = new Date(
      now - (deleted && spec.confirmed ? (spec.confirmedAgo ?? 0) : 0),
    ).toISOString();
    const overrides: Record<string, unknown> = {
      id,
      name: `member-${index}`,
      archive_path: `s3://fixture/${id}/g1-${newOperationId()}`,
      generation,
      observed_generation: deleted
        ? spec.confirmed
          ? generation
          : generation - 1
        : spec.kind === "stopping"
          ? generation - 1
          : generation,
      desired_state: deleted ? "deleted" : sleeping ? "suspended" : "running",
      observed_state: deleted
        ? spec.confirmed
          ? "deleted"
          : "deleting"
        : sleeping && spec.kind === "parked"
          ? "provisioning"
          : "ready",
      observed_power: spec.kind === "parked" ? "hibernated" : "awake",
      suspension_reason: sleeping ? "idle" : null,
      power_operation: power,
      storage_volume_json: receipt ? JSON.stringify(receipt) : null,
      runtime_attestation_json: null,
      parked_json:
        spec.kind === "parked"
          ? JSON.stringify({
              v: 1,
              pod_uid: pod,
              generation,
              cpu_millicores: 15,
              memory_mib: 160,
              parked_at: iso(now),
              observed_at: iso(now),
            })
          : null,
      deleted_at: deleted
        ? new Date(now - 60 * 60_000 * 24).toISOString()
        : null,
      updated_at: deleted && spec.confirmed ? confirmedAt : iso(now),
    };
    const names = Object.keys(overrides);
    await env.DB.prepare(
      `INSERT INTO databases(${columns.join(",")}) SELECT ${columns
        .map((column) => (names.includes(column) ? "?" : column))
        .join(",")} FROM databases WHERE id=?`,
    )
      .bind(
        ...columns.filter((c) => names.includes(c)).map((c) => overrides[c]),
        held.database.id,
      )
      .run();
    if (spec.kind === "stopping")
      await env.DB.prepare(
        "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) VALUES(?,'database.hibernate','running',?,?,?,?,?)",
      )
        .bind(power, f.project, id, generation, iso(now), iso(now))
        .run();
    members.push({ id, spec, receipt, pod, generation });
    return { id, receipt, pod, generation };
  }

  /** The node proof's reading now: every present volume, and the Pod evidenced on it. */
  async function commit() {
    const present = members.filter(
      (member) => member.receipt && member.spec.kind !== "deleted",
    );
    const volume = (member: Member) => ({
      database_id: member.id,
      // A stopping database's Pod was read at the generation it was started for.
      generation:
        member.spec.kind === "stopping"
          ? member.generation - 1
          : member.generation,
      storage_generation: 1,
      storage_uid: member.receipt!.storage_uid,
      namespace_uid: member.receipt!.namespace_uid,
      cluster_uid: member.receipt!.cluster_uid,
      volume_handle: member.receipt!.volume_handle,
      lv_uuid: member.receipt!.lv_uuid,
      pvc_uid: member.receipt!.pvc_uid,
      pv_uid: member.receipt!.pv_uid,
      storage_class: thinStorageClass(f.authority.profile_sha256),
      volume_attributes_class: thinStorageClass(f.authority.profile_sha256),
      io:
        member.spec.kind === "blocked"
          ? []
          : [{ pod_uid: member.pod, ...limits }],
    });
    return identityProof(f, {
      physical,
      physical_lvs: [
        lvs.pool,
        lvs.data,
        lvs.meta,
        ...present.map((member) => ({
          name: member.receipt!.volume_handle,
          lv_uuid: member.receipt!.lv_uuid,
          size_bytes: 64 * mib,
          segtype: "thin",
        })),
      ],
      active_lv_uuids: present.map((member) => member.receipt!.lv_uuid),
      volumes: present.map(volume),
    });
  }

  async function lease() {
    const response = await request(
      `/agent/v1/nodes/${f.node}/storage-guard`,
      f.agent,
    );
    if (response.status !== 200)
      throw new Error(`storage-guard answered ${response.status}`);
    return HostStorageLease.parse(await response.json());
  }
  async function leaseEntries() {
    const value = await lease();
    return new Map(value.databases.map((entry) => [entry.database_id, entry]));
  }

  return { f, held: held.database, add, commit, lease, leaseEntries, members };
}
