// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { randomUUID } from "node:crypto";
import {
  thinQualificationCleanupVerified,
  type ThinQualificationCleanup,
  type ThinQualificationJournalEntry,
} from "@pgcf/contracts/thin-qualification";
import {
  QualificationJournal,
  parseAcknowledged,
  parseBlockStat,
  parseDmInfo,
  parseDumpe2fsGroups,
  parseKernelPoolModes,
  parseMemoryStatDirty,
  parseQualificationLvm,
  parseThinPoolStatus,
  parseThinTable,
  parseWriteOutcome,
  resumeTargetMatches,
  thinDriverDeviceView,
} from "../src/thin-qualification.ts";
import { storageDeleteRequest } from "../src/storage-capacity.ts";
import {
  lvm,
  profile,
  thinQualificationRun,
} from "./thin-qualification.fixture.ts";

const GIB = 1024 ** 3,
  MIB = 1024 ** 2;
const vg = "Rq3Vb8-xYzA-1bCd-2eFg-3hIj-4kLm-5nOpQr",
  pool = "Tp7Kq2-AbCd-EfGh-IjKl-MnOp-QrSt-UvWxYz",
  volume = "Lv9Zx1-QwEr-TyUi-OpAs-DfGh-JkLz-XcVbNm";

test("dm-thin pool status keeps full, read-only and failed modes distinct and never guesses", () => {
  assert.deepEqual(
    parseThinPoolStatus(
      "0 2097152 thin-pool 3 1180/32768 16384/16384 - out_of_data_space discard_passdown error_if_no_space - 1024\n",
    ),
    {
      mode: "out_of_data_space",
      used_data_blocks: 16384,
      total_data_blocks: 16384,
      used_metadata_blocks: 1180,
      total_metadata_blocks: 32768,
      error_if_no_space: true,
      needs_check: false,
    },
  );
  assert.equal(
    parseThinPoolStatus(
      "0 25165824 thin-pool 5 1024/1024 80896/196608 - ro discard_passdown error_if_no_space needs_check 1024",
    ).mode,
    "ro",
  );
  assert.deepEqual(parseThinPoolStatus("0 25165824 thin-pool Fail"), {
    mode: "fail",
    used_data_blocks: null,
    total_data_blocks: null,
    used_metadata_blocks: null,
    total_metadata_blocks: null,
    error_if_no_space: null,
    needs_check: null,
  });
  // A status the kernel could not produce, or an unknown mode, is not a measurement.
  assert.throws(
    () => parseThinPoolStatus("0 2097152 thin-pool Error"),
    /thin_qualification_pool_status_invalid/,
  );
  assert.throws(
    () =>
      parseThinPoolStatus(
        "0 2097152 thin-pool 3 1180/32768 16384/16384 - degraded discard_passdown error_if_no_space - 1024",
      ),
    /thin_qualification_pool_status_invalid/,
  );
  assert.throws(
    () =>
      parseThinPoolStatus(
        "0 2097152 thin 1048576 2097151\n0 2097152 thin-pool 3 1/2 1/2 - rw discard_passdown error_if_no_space - 1",
      ),
    /thin_qualification_pool_status_invalid/,
  );
});

test("device identity, suspension and the exact thin table decide every resume", () => {
  const info =
    parseDmInfo(`Name:              pgcf-pvc--3c5e8a1f--2d4b--4c6e--8f0a--1b2c3d4e5f60
State:             SUSPENDED
Read Ahead:        8192
Tables present:    LIVE
Open count:        1
Event number:      0
Major, minor:      253, 9
Number of targets: 1
UUID: LVM-${vg.replaceAll("-", "")}${volume.replaceAll("-", "")}
`);
  assert.deepEqual(
    { state: info.state, device: info.device, minor: info.minor },
    { state: "SUSPENDED", device: "253:9", minor: 9 },
  );
  const table = parseThinTable("0 14680064 thin 253:4 3\n");
  assert.deepEqual(table, { pool_device: "253:4", device_id: 3 });
  const expected = {
    volume_group_uuid: vg,
    lv_uuid: volume,
    pool_device: "253:4",
  };
  assert.equal(resumeTargetMatches(info, table, expected), true);
  assert.equal(
    resumeTargetMatches(info, table, { ...expected, lv_uuid: pool }),
    false,
  );
  assert.equal(
    resumeTargetMatches(info, table, { ...expected, pool_device: "253:7" }),
    false,
  );
  assert.throws(
    () => parseThinTable("0 14680064 linear 259:2 2048"),
    /thin_qualification_device_table_invalid/,
  );
  assert.throws(
    () => parseDmInfo("Name: x\nState: ACTIVE\n"),
    /thin_qualification_device_info_invalid/,
  );
});

test("block, cgroup and kernel readbacks parse their pinned kernel formats", () => {
  assert.deepEqual(
    parseBlockStat(
      "    3264        0   190058     1186   812031        0 26128384  1883262        0   154416  1884448        0        0        0        0        0        0\n",
    ),
    { write_ios: 812031, write_sectors: 26128384, in_flight: 0 },
  );
  assert.equal(
    parseMemoryStatDirty(
      "anon 1052672\nfile 734003200\nfile_mapped 0\nfile_dirty 41943040\nfile_writeback 8388608\nshmem 0\n",
    ),
    50331648,
  );
  assert.throws(
    () => parseMemoryStatDirty("anon 1052672\nfile 734003200\n"),
    /thin_qualification_memory_stat_invalid/,
  );
  assert.deepEqual(
    parseKernelPoolModes(
      `172.16.0.2: kern:    info: [2026-10-11T08:30:59.012345Z]: device-mapper: thin: 253:7: switching pool to write mode
172.16.0.2: kern: warning: [2026-10-11T08:31:12.345678Z]: device-mapper: thin: 253:4: switching pool to out-of-data-space (error IO) mode
172.16.0.2: kern:    info: [2026-10-11T08:31:44.901234Z]: device-mapper: thin: 253:4: switching pool to write mode
`,
      "253:4",
    ),
    ["out-of-data-space (error IO)", "write"],
  );
  assert.deepEqual(
    parseDumpe2fsGroups(`dumpe2fs 1.47.2 (1-Jan-2025)
Group 0: (Blocks 0-32767) csum 0x2cb2 [ITABLE_ZEROED]
  Primary superblock at 0, Group descriptors at 1-1
Group 1: (Blocks 32768-65535) csum 0x6b5f [INODE_UNINIT, BLOCK_UNINIT, ITABLE_ZEROED]
Group 2: (Blocks 65536-98303) csum 0x1d02 [INODE_UNINIT, BLOCK_UNINIT]
`),
    { groups: 3, zeroed: 2 },
  );
});

test("write outcomes classify the actual GNU and BusyBox dd failure without inventing one", () => {
  assert.deepEqual(
    parseWriteOutcome(`dd: error writing '/data/fill': No space left on device
1015+0 records in
1014+0 records out
1063256064 bytes (1.1 GB, 1014 MiB) copied, 2.81236 s, 378 MB/s
pgcf-rc=1
pgcf-start=1234.56
pgcf-end=1237.40
`),
    {
      exit_code: 1,
      error: "enospc",
      written_bytes: 1063256064,
      milliseconds: 2840,
    },
  );
  assert.deepEqual(
    parseWriteOutcome(`dd: error writing '/dev/dm-12': Input/output error
5056+0 records in
5055+0 records out
5300551680 bytes (4.9GB) copied, 9.814320 seconds, 515.1MB/s
pgcf-rc=1
pgcf-start=88.10
pgcf-end=97.95
`).error,
    "eio",
  );
  assert.equal(
    parseWriteOutcome(`dd: error writing '/data/probe': Read-only file system
pgcf-rc=1
pgcf-start=5.00
pgcf-end=5.01
`).error,
    "other",
  );
  assert.equal(
    parseWriteOutcome(`pgcf-written=8589934592
pgcf-rc=0
pgcf-start=10.00
pgcf-end=180.25
`).written_bytes,
    8589934592,
  );
  // A missing exit marker means the command did not finish under observation.
  assert.throws(
    () => parseWriteOutcome("1048576 bytes (1.0 MB) copied\n"),
    /thin_qualification_write_outcome_invalid/,
  );
});

test("acknowledged commits are the contiguous ids printed before PostgreSQL stopped", () => {
  assert.deepEqual(
    parseAcknowledged(`66
67
68
psql:<stdin>:4: PANIC:  could not write to file "pg_wal/xlogtemp.88": No space left on device
psql:<stdin>:4: server closed the connection unexpectedly
pgcf-rc=2
`),
    { first: 66, last: 68, count: 3 },
  );
  assert.deepEqual(parseAcknowledged("psql: error: connection refused\n"), {
    first: null,
    last: null,
    count: 0,
  });
  assert.throws(
    () => parseAcknowledged("66\n68\n"),
    /thin_qualification_acknowledged_ids_invalid/,
  );
});

test("qualification inventory keeps error-mode pool percentages unknown instead of zero", () => {
  const vgs = JSON.stringify({
    report: [
      {
        vg: [
          {
            vg_name: "pgcf",
            vg_uuid: vg,
            vg_size: "103075020800",
            vg_free: "85895151616",
            vg_extent_size: "4194304",
            vg_permissions: "writeable",
            vg_missing_pv_count: "0",
            pv_count: "1",
          },
        ],
      },
    ],
  });
  const row = {
    vg_uuid: vg,
    lv_name: "pgcf_thinpool",
    lv_uuid: pool,
    lv_size: "1073741824",
    segtype: "thin-pool",
    pool_lv: "",
    lv_attr: "twi-aotzF-",
    data_percent: "",
    metadata_percent: "",
    lv_metadata_size: "134217728",
    lv_when_full: "error",
    lv_tags:
      "pgcf.node.11111111-1111-4111-8111-111111111111,pgcf.action.op_abcdefghijklmnopqrst",
    lv_kernel_major: "253",
    lv_kernel_minor: "4",
    chunk_size: "65536",
    lv_health_status: "failed",
  };
  const inventory = parseQualificationLvm(
    vgs,
    JSON.stringify({
      report: [
        {
          lv: [
            row,
            {
              ...row,
              lv_name: "pvc-3c5e8a1f-2d4b-4c6e-8f0a-1b2c3d4e5f60",
              lv_uuid: volume,
              segtype: "thin",
              pool_lv: "pgcf_thinpool",
              lv_attr: "Vwi-a-tz--",
              data_percent: "12.50",
              metadata_percent: "",
              lv_metadata_size: "",
              lv_when_full: "",
              lv_tags: "",
              lv_kernel_minor: "-1",
              lv_kernel_major: "-1",
              chunk_size: "0",
              lv_health_status: "",
            },
          ],
        },
      ],
    }),
    `LVM-${vg.replaceAll("-", "")}${pool.replaceAll("-", "")}-tpool\n`,
  );
  const [poolRow, thinRow] = inventory.volumes;
  assert.equal(poolRow!.data_percent, null);
  assert.equal(poolRow!.health, "failed");
  assert.equal(poolRow!.chunk_bytes, 65536);
  assert.equal(thinRow!.data_percent, 12.5);
  assert.equal(thinRow!.minor, null);
  assert.deepEqual(inventory.active, [pool]);
  assert.throws(
    () =>
      parseQualificationLvm(
        vgs,
        JSON.stringify({ report: [{ lv: [row] }] }),
        `LVM-${vg.replaceAll("-", "")}${"0".repeat(32)}`,
      ),
    /thin_qualification_kernel_volume_unexplained/,
  );
});

test("noflush suspension runs only in a privileged driver container that sees the host device tree", () => {
  const daemonSet = {
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
  assert.equal(thinDriverDeviceView(daemonSet), true);
  const readOnly = structuredClone(daemonSet);
  readOnly.spec.template.spec.containers[0]!.volumeMounts[0] = {
    name: "device-dir",
    mountPath: "/dev",
    readOnly: true,
  } as { name: string; mountPath: string };
  assert.equal(thinDriverDeviceView(readOnly), false);
  const unprivileged = structuredClone(daemonSet);
  unprivileged.spec.template.spec.containers[0]!.securityContext.privileged = false;
  assert.equal(thinDriverDeviceView(unprivileged), false);
});

test("an uncertain dispatched write is resolved by readback and never dispatched again", async () => {
  const saved: ThinQualificationJournalEntry[] = [];
  const journal = (entries: ThinQualificationJournalEntry[]) =>
    new QualificationJournal(
      { revision: entries.length, entries },
      async (expected, entry) => {
        saved.push(entry);
        return expected + 1;
      },
    );
  const dispatched: ThinQualificationJournalEntry = {
    key: "setup:pool",
    state: "dispatched",
    nonce: "op_abcdefghijklmnopqrst",
    at: "2026-10-11T08:00:00.000Z",
    facts: null,
  };
  let writes = 0;
  await assert.rejects(
    journal([dispatched]).act(
      "setup:pool",
      async () => {
        writes++;
      },
      async () => null,
    ),
    /thin_qualification_write_outcome_unknown/,
  );
  assert.equal(writes, 0);
  const resolved = await journal([dispatched]).act(
    "setup:pool",
    async () => {
      writes++;
    },
    async (nonce) => (nonce === dispatched.nonce ? { pool_uuid: pool } : null),
  );
  assert.deepEqual(resolved, { pool_uuid: pool });
  assert.equal(writes, 0);
  assert.equal(saved.at(-1)!.state, "confirmed");
  // A measurement interrupted after dispatch has no readback and stays unknown.
  await assert.rejects(
    journal([{ ...dispatched, key: "data_full:fill" }]).measure(
      "data_full:fill",
      async () => {
        writes++;
        return {};
      },
    ),
    /thin_qualification_measurement_outcome_unknown/,
  );
  assert.equal(writes, 0);
  // A fresh write is durably dispatched before it runs and confirmed only from its readback.
  saved.length = 0;
  let created = false;
  const order: string[] = [];
  const fresh = new QualificationJournal(
    { revision: 0, entries: [] },
    async (expected, entry) => {
      order.push(`${entry.state}:${created}`);
      return expected + 1;
    },
  );
  assert.deepEqual(
    await fresh
      .act(
        "setup:namespace",
        async () => {
          created = true;
        },
        async () => (created ? { uid: randomUUID() } : null),
      )
      .then((value) => Object.keys(value)),
    ["uid"],
  );
  assert.deepEqual(order, ["dispatched:false", "confirmed:true"]);
  await assert.rejects(
    new QualificationJournal({ revision: 0, entries: [] }, async () => 1).act(
      "setup:namespace",
      async () => {},
      async () => ({ uid: randomUUID() }),
    ),
    /thin_qualification_resource_preexisting/,
  );
});

test("scratch class removal is allowed only for qualification classes and may force a Pod stop", () => {
  const metadata = { uid: randomUUID(), resourceVersion: "91" };
  const scratch = storageDeleteRequest(
    "/apis/storage.k8s.io/v1/storageclasses/pgcf-thin-q-abcdefghijklmnopqrst",
    metadata,
  );
  assert.equal(
    scratch.args[1],
    "--raw=/apis/storage.k8s.io/v1/storageclasses/pgcf-thin-q-abcdefghijklmnopqrst",
  );
  assert.throws(() =>
    storageDeleteRequest(
      "/apis/storage.k8s.io/v1/storageclasses/pgcf-lvm-thin-v1-0123456789abcdef",
      metadata,
    ),
  );
  assert.throws(() =>
    storageDeleteRequest(
      "/apis/storage.k8s.io/v1/storageclasses/pgcf-lvm",
      metadata,
    ),
  );
  const pod = storageDeleteRequest(
    "/api/v1/namespaces/pgcf-thin-q-abcdefghijklmnopqrst/pods/pg-r",
    metadata,
    0,
  );
  assert.equal(JSON.parse(pod.stdin).gracePeriodSeconds, 0);
});

/** The journaled scratch-pool half of metadata_full, measured in earlier turns. */
function scratchMeasured(run: ReturnType<typeof thinQualificationRun>) {
  run.confirm("metadata_full:scratch-pool", {
    pool_uuid: lvm("Sp"),
    data_bytes: 12 * GIB,
    metadata_bytes: 4 * MIB,
    volume_uuid: lvm("Sv"),
    minor: 40,
  });
  run.confirm("metadata_full:marker", { sha256: "4".repeat(64) });
  run.confirm("metadata_full:exhaust", {
    exit_code: 1,
    error: "eio",
    written_bytes: 5_301_600_256,
    milliseconds: 9_800,
  });
  run.confirm("metadata_full:exhausted", {
    status: {
      mode: "ro",
      used_data_blocks: 80_896,
      total_data_blocks: 196_608,
      used_metadata_blocks: 1024,
      total_metadata_blocks: 1024,
      error_if_no_space: true,
      needs_check: false,
    },
  });
  run.confirm("metadata_full:probe", {
    exit_code: 1,
    error: "eio",
    written_bytes: 0,
    milliseconds: 10,
    before: 80_896,
    after: 80_896,
  });
  run.confirm("metadata_full:deactivate", { inactive: true });
  run.confirm("metadata_full:check", { exit_code: 0 });
  run.confirm("metadata_full:repair", { exit_code: 0 });
  run.confirm("metadata_full:activate", { exit_code: 0 });
  run.confirm("metadata_full:verify", { sha256: "4".repeat(64) });
  run.confirm("metadata_full:scratch-remove", { removed: true });
}

// Each turn owns its world and journal; scratch releases poll every 2 s, so turns run concurrently.
describe(
  "executor turns resume from the Cloudflare journal",
  { concurrency: true },
  () => {
    test("metadata_full grows and fills the profile pool without rebooting the node outside a fleet patch", async () => {
      const run = thinQualificationRun("metadata_full");
      scratchMeasured(run);
      const kept = run.workload("data_full", "pg-a", "Pa");
      run.world.lv("pgcf_thinpool")!.size = 2 * GIB;
      assert.deepEqual(await run.turn(), { kind: "report" });
      // pg-a stops, but its CSI volume keeps the pool from being removed by the driver.
      assert.ok(!run.world.pods.has("pg-a"));
      assert.ok(run.world.lv(kept.pv_name));
      assert.deepEqual(
        run.world.log.filter((line) => line.startsWith("talosctl")),
        [],
      );
      assert.equal(run.entry("metadata_full:reboot"), undefined);
      const report = run.calls[0]!.report as {
        evidence: Record<string, { pool_uuid: string; data_bytes: number }>;
      };
      assert.deepEqual(Object.keys(report.evidence).sort(), [
        "maximum",
        "scratch",
      ]);
      assert.equal(
        report.evidence.maximum!.pool_uuid,
        run.setup.pool.pool_uuid,
      );
      assert.equal(
        report.evidence.maximum!.data_bytes,
        profile.maximum_data_bytes,
      );
    });

    test("trim releases data_full's kept volume first, so only the sentinel is the pool's last thin LV", async () => {
      const run = thinQualificationRun("trim_delete_recreate");
      run.world.lv("pgcf_thinpool")!.size = profile.maximum_data_bytes;
      const kept = run.workload("data_full", "pg-a", "Pa", { pod: false });
      const sentinel = run.workload("trim_delete_recreate", "sentinel", "Sn", {
        size: 64 * MIB,
      });
      run.workload("trim_delete_recreate", "trim", "Tr", { size: 256 * MIB });
      run.confirm("trim_delete_recreate:baseline", { used: 16 });
      run.confirm("trim_delete_recreate:write", {
        bytes: 256 * MIB,
        used: 16 + 4096,
      });
      assert.deepEqual(await run.turn(), { kind: "report" });
      assert.deepEqual(
        run.world.log
          .filter((line) => line.includes("/persistentvolumeclaims/"))
          .map((line) => line.split("/").at(-1)),
        ["trim", "pg-a", "sentinel", "trim-again"],
      );
      assert.ok(!run.world.lvs.some((lv) => lv.name === kept.pv_name));
      const evidence = (
        run.calls[0]!.report as {
          evidence: {
            last_lv_uuid: string;
            pool_present_after_last: boolean;
            reinitialized_pool_uuid: string | null;
          };
        }
      ).evidence;
      assert.equal(evidence.last_lv_uuid, sentinel.lv_uuid);
      assert.equal(evidence.pool_present_after_last, false);
      assert.equal(evidence.reinitialized_pool_uuid, lvm("Np"));
    });

    test("a resumed noflush turn continues from its journal after the run stopped the writer Pod", async () => {
      const run = thinQualificationRun("noflush_quiescence");
      run.workload("data_full", "pg-a", "Pa", { pod: false });
      run.released("noflush_quiescence", "writer", "Wr");
      for (const [key, facts] of Object.entries({
        "writer-pod": { uid: randomUUID() },
        "writer-start": { started: true },
        dirty: { bytes: 41_943_040 },
        suspend: { exit_code: 0, milliseconds: 30 },
        frozen: {
          state: "SUSPENDED",
          lv_state: "s",
          write_sectors_first: 1_204_224,
          write_sectors_second: 1_204_224,
          used_first: 2_100,
          used_second: 2_100,
          observed_milliseconds: 3_000,
        },
        resume: {
          resume_exit_code: 0,
          resume_milliseconds: 20,
          sync_ok: true,
          drain_milliseconds: 9_000,
          used_after: 2_740,
        },
        "writer-stop": { stopped: true },
        fsck: { exit_code: 0 },
      }))
        run.confirm(`noflush_quiescence:${key}`, facts);
      const fill = run.workload("noflush_quiescence", "fill-full", "Ff", {
        size: 2 * profile.maximum_data_bytes,
      });
      assert.deepEqual(await run.turn(), { kind: "report" });
      const lv = run.world.lvs.find((value) => value.uuid === fill.lv_uuid);
      assert.equal(lv, undefined);
      assert.ok(run.world.log.includes("exec fill-full /bin/bash"));
      const evidence = (
        run.calls[0]!.report as {
          evidence: { writer: { lv_uuid: string }; full: { state: string } };
        }
      ).evidence;
      assert.equal(
        evidence.writer.lv_uuid,
        run.entry("noflush_quiescence:writer:volume")!.facts!.lv_uuid,
      );
      assert.equal(evidence.full.state, "SUSPENDED");
    });

    test("a resumed data_full turn accepts PostgreSQL crashed on the full pool and replaces its Pod", async () => {
      const run = thinQualificationRun("data_full");
      const pool = run.world.lv("pgcf_thinpool")!;
      run.confirm("data_full:pool", {
        data_bytes: profile.initial_data_bytes,
        device: `253:${pool.minor}`,
      });
      const pg = run.workload("data_full", "pg-a", "Pa");
      run.world.pods.get("pg-a")!.phase = "Failed";
      run.confirm("data_full:marker", { rows: ["1"] });
      run.confirm("data_full:pre", { first: 2, last: 65, count: 64 });
      const fill = run.workload("data_full", "fill", "Fl", {
        size: 2 * profile.maximum_data_bytes,
      });
      const probe = run.world.addLv({
        name: `pgcf_thin_q_${run.ids.id.slice(3)}_p`,
        uuid: lvm("Pr"),
        segtype: "thin",
        pool: "pgcf_thinpool",
        size: 64 * MIB,
        tags: [run.world.tag],
      });
      run.confirm("data_full:probe-volume", {
        lv_uuid: probe.uuid,
        minor: probe.minor,
      });
      run.confirm("data_full:fill", {
        exit_code: 1,
        error: "enospc",
        written_bytes: profile.initial_data_bytes - 64 * MIB,
        milliseconds: 21_400,
      });
      run.confirm("data_full:full", {
        status: {
          mode: "out_of_data_space",
          used_data_blocks: 16_384,
          total_data_blocks: 16_384,
          used_metadata_blocks: 1180,
          total_metadata_blocks: 32_768,
          error_if_no_space: true,
          needs_check: false,
        },
      });
      run.confirm("data_full:probe", {
        exit_code: 1,
        error: "enospc",
        written_bytes: 0,
        milliseconds: 20,
      });
      run.world.poolMode = "out_of_data_space";
      assert.deepEqual(await run.turn(), { kind: "report" });
      // The crashed Pod acknowledges nothing more; crash recovery keeps every earlier commit.
      assert.deepEqual(run.entry("data_full:post")!.facts, {
        first: null,
        last: null,
        count: 0,
      });
      assert.notEqual(
        run.world.pods.get("pg-a")!.uid,
        run.entry("data_full:pg-a:pod")!.facts!.uid,
      );
      const evidence = (
        run.calls[0]!.report as {
          evidence: {
            volumes_after: string[];
            acknowledged_commits: number;
            acknowledged_present: number;
            marker_present: boolean;
          };
        }
      ).evidence;
      assert.deepEqual(
        [...evidence.volumes_after].sort(),
        [pg.lv_uuid, fill.lv_uuid, probe.uuid].sort(),
      );
      assert.equal(evidence.acknowledged_commits, 64);
      assert.equal(evidence.acknowledged_present, 64);
      assert.equal(evidence.marker_present, true);
    });

    test("a resumed resume_marker turn resumes the exact LV after the run killed its Pod", async () => {
      const run = thinQualificationRun("resume_marker");
      run.workload("data_full", "pg-a", "Pa", { pod: false });
      const volume = run.workload("resume_marker", "pg-r", "Rm", {
        pod: false,
      });
      const lv = run.world.lvs.find((value) => value.uuid === volume.lv_uuid)!;
      lv.state = "s";
      const pool = run.world.lv("pgcf_thinpool")!;
      run.confirm("resume_marker:marker", { rows: ["1"] });
      run.confirm("resume_marker:pool", {
        pool_uuid: pool.uuid,
        device: `253:${pool.minor}`,
      });
      run.confirm("resume_marker:long", { active: true });
      run.confirm("resume_marker:suspend", {
        exit_code: 0,
        state: "SUSPENDED",
      });
      run.confirm("resume_marker:kill", { killed: true });
      assert.deepEqual(await run.turn(), { kind: "report" });
      assert.ok(run.world.log.includes(`dmsetup resume ${run.world.dm(lv)}`));
      const evidence = (
        run.calls[0]!.report as {
          evidence: {
            lv_uuid_before: string;
            lv_uuid_after: string;
            resume_target_verified: boolean;
            marker_present: boolean;
            uncommitted_rows: number;
          };
        }
      ).evidence;
      assert.equal(evidence.lv_uuid_after, evidence.lv_uuid_before);
      assert.equal(evidence.resume_target_verified, true);
      assert.equal(evidence.marker_present, true);
      assert.equal(evidence.uncommitted_rows, 0);
    });

    test("cleanup resumes a suspended scratch LV with a mixed-case LVM UUID and removes every scratch object", async () => {
      const run = thinQualificationRun("cleanup");
      run.workload("data_full", "pg-a", "Pa", { pod: false });
      // A noflush gate failed between dmsetup suspend and resume.
      const writer = run.workload("noflush_quiescence", "writer", "Wr");
      const lv = run.world.lvs.find((value) => value.uuid === writer.lv_uuid)!;
      lv.state = "s";
      assert.match(lv.uuid, /[A-Z]/);
      assert.deepEqual(await run.turn(), { kind: "report" });
      assert.equal(run.world.log[0], `dmsetup resume ${run.world.dm(lv)}`);
      assert.equal(
        run.entry(`cleanup:resume:${writer.pv_name}`)?.state,
        "confirmed",
      );
      const cleanup = (
        run.calls[0]!.report as { cleanup: ThinQualificationCleanup }
      ).cleanup;
      assert.ok(thinQualificationCleanupVerified(cleanup));
      assert.deepEqual(
        run.world.lvs.map((value) => value.name),
        [run.setup.logical_volumes[0]!.name],
      );
    });

    test("cleanup still converges after a reboot or a kernel, driver or host extension change", async () => {
      const changed = (step: "cleanup" | "startup_bound") => {
        const run = thinQualificationRun(step);
        run.workload("data_full", "pg-a", "Pa", { pod: false });
        run.world.boot = randomUUID();
        run.world.kernel = "6.18.60-talos";
        run.world.driverImage = `ghcr.io/amerged-org/pgcf-regional:lvm-thin-sha-${"9".repeat(40)}@sha256:${"9".repeat(64)}`;
        run.world.extension = "0.2.0";
        return run;
      };
      // Measurements stay fenced to the setup boot, kernel, driver and extension.
      await assert.rejects(
        changed("startup_bound").turn(),
        /thin_storage_driver_ambiguous/,
      );
      const run = changed("cleanup");
      assert.deepEqual(await run.turn(), { kind: "report" });
      assert.ok(
        thinQualificationCleanupVerified(
          (run.calls[0]!.report as { cleanup: ThinQualificationCleanup })
            .cleanup,
        ),
      );
      assert.equal(run.world.lv("pgcf_thinpool"), undefined);
      assert.equal(run.world.namespaceUid, null);
    });
  },
);

test("metadata_full removes its raw volumes across turns instead of outrunning the relay session", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const run = thinQualificationRun("metadata_full");
  scratchMeasured(run);
  run.workload("data_full", "pg-a", "Pa", { pod: false });
  run.confirm("metadata_full:pg-a:stop", { stopped: true });
  const pool = run.world.lv("pgcf_thinpool")!;
  pool.size = profile.maximum_data_bytes;
  run.confirm("metadata_full:grow", {
    pool_uuid: pool.uuid,
    data_bytes: pool.size,
  });
  const prefix = `pgcf_thin_q_${run.ids.id.slice(3)}_v`;
  const raw = Array.from({ length: profile.maximum_volumes }, (_, index) =>
    run.world.addLv({
      name: `${prefix}${index}`,
      uuid: lvm(`Rv${index}`),
      segtype: "thin",
      pool: "pgcf_thinpool",
      size: profile.maximum_data_bytes / profile.maximum_volumes,
      tags: [run.world.tag],
    }),
  );
  run.confirm("metadata_full:volumes", {
    minors: raw.map((lv) => lv.minor),
  });
  run.confirm("metadata_full:maximum-fill", {
    exit_code: 1,
    error: "enospc",
    written_bytes: profile.maximum_data_bytes,
    milliseconds: 60_000,
  });
  run.confirm("metadata_full:maximum", {
    data_bytes: profile.maximum_data_bytes,
    metadata_bytes: profile.metadata_bytes,
    status: {
      mode: "out_of_data_space",
      used_data_blocks: profile.maximum_data_bytes / 65536,
      total_data_blocks: profile.maximum_data_bytes / 65536,
      used_metadata_blocks: 3_000,
      total_metadata_blocks: profile.metadata_bytes / 4096,
      error_if_no_space: true,
      needs_check: false,
    },
  });
  // Each relayed lvremove takes about 5 s; all of them do not fit one session.
  run.world.cost = (args) => (args[0] === "lvremove" ? 5_000 : 0);
  run.world.elapse = (milliseconds) => t.mock.timers.tick(milliseconds);
  const left = () =>
    run.world.lvs.filter((lv) => lv.name.startsWith(prefix)).length;
  assert.deepEqual(await run.turn(), { kind: "release" });
  assert.ok(left() > 0 && left() < raw.length);
  assert.equal(run.entry("metadata_full:volumes-remove")?.state, "dispatched");
  assert.deepEqual(await run.turn(), { kind: "report" });
  assert.equal(left(), 0);
});
