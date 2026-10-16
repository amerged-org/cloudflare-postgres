// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { BootstrapError, runCommand, shellQuote } from "../src/bootstrap.ts";
import {
  THIN_LV_FIELDS,
  THIN_SOFTWARE_STEPS,
  parseThinDriverSoftware,
  readDriverFrames,
  readThinDriverSoftware,
  readThinLvm,
  thinLvmFacts,
  thinLvmSteps,
  thinNodeLvmReadback,
} from "../src/thin-storage.ts";
import sources from "../../../infra/storage/sources.lock.json" with { type: "json" };

test("reads actual LVM and kernel DM inventory in one bounded remote command", async () => {
  const container = `pgcf-thin-read-${randomUUID()}`;
  // The image built from this revision's infra/storage/Dockerfile provides the exact locked
  // driver, LVM and thin tools; a changed driver is published only after this test passes. No
  // driver daemon is started, and the fixture owns only its filtered temporary loop/PV/VG.
  const image = process.env.PGCF_TEST_STORAGE_IMAGE;
  assert.ok(
    image,
    "PGCF_TEST_STORAGE_IMAGE must name the image built from infra/storage/Dockerfile",
  );
  const invoke = async (args: string[], timeout = 30000) =>
    await runCommand({
      executable: "docker",
      args,
      timeout_ms: timeout,
      signal: new AbortController().signal,
      env: process.env,
    });
  const docker = async (args: string[], timeout = 30000) => {
    const result = await invoke(args, timeout);
    assert.equal(
      result.exit_code,
      0,
      "actual Docker/LVM command failed; output withheld",
    );
    return result;
  };
  await docker([
    "run",
    "--detach",
    "--name",
    container,
    "--platform",
    "linux/amd64",
    "--network",
    "none",
    "--privileged",
    "--env",
    "LVM_SYSTEM_DIR=/tmp/pgcf-lvm-test",
    "--entrypoint",
    "/bin/sh",
    image,
    "-ec",
    "sleep 600",
  ]);
  let loopCreated = false;
  try {
    await docker([
      "exec",
      container,
      "/bin/sh",
      "-ec",
      `
      umask 077
      mkdir /tmp/pgcf-lvm-test
      truncate -s 128M /tmp/pgcf-lvm-test/disk
      losetup --find --show /tmp/pgcf-lvm-test/disk > /tmp/pgcf-lvm-test/loop
      loop=$(cat /tmp/pgcf-lvm-test/loop)
      printf 'devices { use_devicesfile=0 filter=["a|^%s$|","r|.*|"] }\n' "$loop" > /tmp/pgcf-lvm-test/lvm.conf
      test -z "$(dmsetup info --columns --noheadings --options name | sed -n '/^[[:space:]]*pgcf-/p')"
      pvcreate --yes "$loop" >/dev/null
      vgcreate pgcf "$loop" >/dev/null
      vgs --noheadings --options vg_uuid pgcf | tr -d '[:space:]' > /tmp/pgcf-lvm-test/uuid
      lvcreate --yes --size 8M --name retained pgcf >/dev/null
    `,
    ]);
    loopCreated = true;
    let commands = 0;
    const facts = await thinNodeLvmReadback(
      { lvm_read_mode: "product" },
      async (args) => {
        commands++;
        // The real shell trace records executed commands, not a simulated product inventory.
        assert.deepEqual(args.slice(0, 2), ["sh", "-ec"]);
        return await docker([
          "exec",
          container,
          "sh",
          "-ec",
          "umask 077; exec 2>/tmp/pgcf-lvm-test/read.trace; set -x\n" + args[2],
        ]);
      },
    );
    assert.equal(facts.volumes.length, 1);
    assert.equal(facts.volumes[0]!.name, "retained");
    assert.equal(facts.physical.thick_allocated_bytes, 8 * 1024 ** 2);
    assert.equal(
      commands,
      1,
      "a complete read must use one real remote CLI invocation",
    );
    const trace = (
      await docker(["exec", container, "cat", "/tmp/pgcf-lvm-test/read.trace"])
    ).stdout;
    assert.deepEqual(
      trace.split("\n").flatMap((line) => {
        const match = /^\+ (dmsetup|vgs|lvs)\b/.exec(line);
        return match ? [match[1]] : [];
      }),
      ["dmsetup", "vgs", "lvs", "dmsetup"],
      "actual command execution must bracket both unchanged LVM reports",
    );
    let qualificationCommands = 0;
    const qualified = await readThinLvm(
      (args) => {
        qualificationCommands++;
        return docker(["exec", container, ...args]);
      },
      `${THIN_LV_FIELDS},chunk_size,lv_health_status`,
      "qualification",
    );
    assert.equal(
      qualificationCommands,
      4,
      "the accepted scratch qualification protocol is unchanged",
    );
    const lv = JSON.parse(qualified.lvs).report[0].lv[0];
    assert.equal(Object.hasOwn(lv, "chunk_size"), true);
    assert.equal(Object.hasOwn(lv, "lv_health_status"), true);
    let sharedQualificationCommands = 0;
    const qualificationFacts = await thinNodeLvmReadback(
      { lvm_read_mode: "qualification" },
      (args) => {
        sharedQualificationCommands++;
        return docker(["exec", container, ...args]);
      },
    );
    assert.equal(
      sharedQualificationCommands,
      4,
      "verifyThinNode's qualification reader retains the original protocol",
    );
    assert.equal(qualificationFacts.vg_uuid, facts.vg_uuid);
    assert.deepEqual(qualificationFacts.volumes, facts.volumes);
    await assert.rejects(
      () =>
        readThinLvm(
          (args) => invoke(["exec", container, ...args]),
          "pgcf_unknown_field",
          "product",
        ),
      (error) =>
        error instanceof BootstrapError &&
        error.code === "thin_storage_command_failed",
      "an actual LVM CLI failure cannot return a partial inventory",
    );
    await assert.rejects(
      () =>
        readThinLvm(
          async (args) => {
            const actual = await docker(["exec", container, ...args]);
            // A real child truncates the actual LVM stream's final byte at the transport boundary.
            return await runCommand({
              executable: process.execPath,
              args: [
                "-e",
                "let b=[]; process.stdin.on('data',x=>b.push(x)); process.stdin.on('end',()=>{const v=Buffer.concat(b); process.stdout.write(v.subarray(0,v.length-1));});",
              ],
              stdin: actual.stdout,
              signal: new AbortController().signal,
              env: process.env,
              timeout_ms: 5000,
            });
          },
          THIN_LV_FIELDS,
          "product",
        ),
      (error) =>
        error instanceof BootstrapError &&
        error.code === "thin_storage_readback_invalid",
      "a truncated actual frame cannot authorize a readback",
    );
    await docker(["exec", container, "mkdir", "/tmp/pgcf-lvm-test/software"]);
    // Actual software reads meet at a filesystem barrier. Serial reads cannot reach it; no
    // product output, completion clock or read callback is mocked.
    const software = await readThinDriverSoftware(async (args) => {
      const marker = args[0]!;
      return await docker(
        [
          "exec",
          container,
          "sh",
          "-ec",
          `
        touch /tmp/pgcf-lvm-test/software/${marker}
        for attempt in $(seq 1 100); do
          if test -f /tmp/pgcf-lvm-test/software/sha256sum &&
             test -f /tmp/pgcf-lvm-test/software/thin_check &&
             test -f /tmp/pgcf-lvm-test/software/cat; then
            exec ${args.map(shellQuote).join(" ")}
          fi
          sleep .05
        done
        exit 23
      `,
        ],
        10000,
      );
    });
    assert.equal(
      software.hashes.length,
      3,
      "all actual software reads must complete together",
    );
    assert.deepEqual(software.hashes, [
      sources.driver.binary_sha256,
      sources.driver.lvm_binary_sha256,
      sources.thin_tools.binary_sha256,
    ]);
    assert.equal(software.tools, sources.thin_tools.version);
    assert.equal(software.cgroup, true);
    // The identity turn's first driver read: the software, the LVM reports and two soft steps in
    // one real exec. Each step's complete stdout is framed; a soft step reports its status.
    let reads = 0;
    const read = (args: string[]) => {
      reads++;
      return docker(["exec", container, ...args]);
    };
    const frames = await readDriverFrames(read, [
      ...THIN_SOFTWARE_STEPS,
      ...thinLvmSteps(),
      { argv: ["sh", "-c", "exit 7"], soft: true },
      {
        argv: [
          "sh",
          "-ec",
          'for p do if [ -r "$p" ]; then cat "$p"; fi; done',
          "--",
          "/nonexistent/io.max",
        ],
        soft: true,
      },
    ]);
    assert.equal(reads, 1, "software, LVM and soft steps share one exec");
    const combined = parseThinDriverSoftware(
      frames[0]!.stdout,
      frames[1]!.stdout,
      frames[2]!.stdout,
    );
    assert.deepEqual(combined, software);
    assert.deepEqual(
      thinLvmFacts(
        frames[4]!.stdout,
        frames[5]!.stdout,
        frames[6]!.stdout,
        frames[3]!.stdout,
      ).volumes,
      facts.volumes,
    );
    assert.deepEqual(
      frames.slice(7).map((frame) => [frame.stdout, frame.exit_code]),
      [
        ["", 7],
        ["", 0],
      ],
    );
    await assert.rejects(
      readDriverFrames(
        (args) => invoke(["exec", container, ...args]),
        [{ argv: ["true"] }, { argv: ["false"] }, { argv: ["true"] }],
      ),
      (error) =>
        error instanceof BootstrapError &&
        error.code === "thin_storage_command_failed",
      "a failing hard step ends the real script",
    );
  } finally {
    if (loopCreated) {
      await docker([
        "exec",
        container,
        "/bin/sh",
        "-ec",
        `
        actual=$(vgs --noheadings --options vg_uuid pgcf | tr -d '[:space:]')
        test "$actual" = "$(cat /tmp/pgcf-lvm-test/uuid)"
        vgremove --yes --force pgcf >/dev/null
        losetup --detach "$(cat /tmp/pgcf-lvm-test/loop)"
      `,
      ]);
    } else {
      await docker([
        "exec",
        container,
        "/bin/sh",
        "-ec",
        `
        if test -f /tmp/pgcf-lvm-test/loop; then
          loop=$(cat /tmp/pgcf-lvm-test/loop)
          if test -f /tmp/pgcf-lvm-test/uuid; then
            actual=$(vgs --noheadings --options vg_uuid pgcf | tr -d '[:space:]')
            test "$actual" = "$(cat /tmp/pgcf-lvm-test/uuid)"
            vgremove --yes --force pgcf >/dev/null
          fi
          losetup --detach "$loop"
        fi
      `,
      ]);
    }
    await docker(["stop", "--time", "1", container]);
    await docker(["rm", container]);
  }
});
