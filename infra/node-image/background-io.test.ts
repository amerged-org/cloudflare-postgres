// SPDX-License-Identifier: Apache-2.0
// The disk side of "background jobs slow cold requests" (ULTRA plan 11.2): the data disk's I/O
// scheduler is `none`, so the `IOWeight=` of `pgcfbackup.slice` is not enforced, and the backup
// and archive jobs share the disk with the databases without a limit. The only controllers that
// bound them on Debian 13's kernel (6.12) without a scheduler are the byte and IOPS limits of
// `io.max` (blk-throttle): `IODeviceLatencyTargetSec=` needs CONFIG_BLK_CGROUP_IOLATENCY, which
// Debian leaves unset, and `io.cost` needs a cost model and QoS values per device that a virtual
// disk has none of.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const image = new URL("mkosi.extra/", import.meta.url);
const systemUnits = new URL("usr/lib/systemd/system/", image);
const read = (name: string) => readFileSync(new URL(name, systemUnits), "utf8");

// The values of every `Key=value` line of a unit, in file order.
function assignments(text: string, key: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

// systemd's byte sizes: K, M and G are powers of 1000 for the I/O limits (Debian 13, systemd 257.13:
// `IOReadBandwidthMax=64M` wrote `rbps=64000000` to io.max).
function bytesPerSecond(size: string): number {
  const match = /^(\d+)([KMG]?)$/.exec(size);
  assert.ok(match, `${size} is a byte size`);
  const factor = { "": 1, K: 1e3, M: 1e6, G: 1e9 }[match[2] as "" | "K" | "M" | "G"];
  return Number(match[1]) * factor;
}

// What the EU1 disk and the jobs measured (plan 11.2, 5.3): the base backup moved 557 MB in 65 s,
// and the disk does 106 MB/s of random 8 KiB reads at queue depth 32.
const BASE_BACKUP_BYTES_PER_SECOND = 8.5e6;
const DISK_RANDOM_BYTES_PER_SECOND = 106e6;

test("the backup slice is capped on the data disk, which the rule finds by the label of the LVM partition", () => {
  const label = /^Label=(.+)$/m.exec(readFileSync(new URL("usr/lib/repart.d/30-lvm.conf", image), "utf8"))?.[1];
  assert.ok(label, "the first boot makes the LVM partition with a label");
  const slice = read("pgcfbackup.slice");
  for (const key of ["IOReadBandwidthMax", "IOWriteBandwidthMax"]) {
    const lines = assignments(slice, key);
    assert.equal(lines.length, 1, `${key} is set once`);
    const [device, size, ...rest] = lines[0]!.split(" ");
    assert.deepEqual(rest, [], `${key} is one device and one size`);
    // systemd follows the link to the partition and takes the whole disk, which also holds the
    // root filesystem where barman spools: no device number is written into the image.
    assert.equal(device, `/dev/disk/by-partlabel/${label}`, `${key} names the disk of the LVM partition`);
    const cap = bytesPerSecond(size!);
    assert.ok(cap >= 2 * BASE_BACKUP_BYTES_PER_SECOND, `${key} leaves a base backup its rate`);
    assert.ok(cap <= 0.4 * DISK_RANDOM_BYTES_PER_SECOND, `${key} leaves the databases most of the disk`);
  }
});

test("only the backup jobs are capped: the databases' slice has no I/O limit", () => {
  assert.doesNotMatch(read("pgcf.slice"), /^IO(Read|Write)(Bandwidth|IOPS)Max=/m);
});

test("no unit asks for the latency controller, which Debian's kernel does not build", () => {
  const files = [
    ...readdirSync(systemUnits).map((name) => new URL(name, systemUnits)),
    ...readdirSync(new URL("etc/systemd/system/", image)).map((name) => new URL(`etc/systemd/system/${name}`, image)),
  ];
  for (const file of files) assert.doesNotMatch(readFileSync(file, "utf8"), /IODeviceLatencyTargetSec=/, file.pathname);
});
