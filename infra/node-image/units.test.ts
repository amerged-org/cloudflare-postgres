// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const image = new URL("mkosi.extra/", import.meta.url);
const units = new URL("usr/lib/systemd/system/", image);

// The values of every `Key=value` line of a unit or drop-in, in file order.
function assignments(text: string, key: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

// The whitespace-separated fields of every line that is not a comment.
function records(text: string): string[][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
}

test("every slice is top-level: a dash in a slice name nests it inside the slice before the dash", () => {
  const slices = readdirSync(units).filter((name) => name.endsWith(".slice"));
  assert.ok(slices.length > 0, "the image carries slices");
  assert.deepEqual(
    slices.filter((name) => name.slice(0, -".slice".length).includes("-")),
    [],
    "barman-cloud jobs would run under the databases' memory ceiling",
  );
});

test("a database starts with its postgres process alone: the agent creates the socket directory", () => {
  const unit = readFileSync(new URL("pgcf-pg@.service", units), "utf8");
  assert.doesNotMatch(unit, /^ExecStart(Pre|Post)=/m, "every extra process adds to the wake");
});

test("a database unit's system-call filter denies the kernel's second-stage primitives and keeps SysV shared memory", () => {
  const unit = readFileSync(new URL("pgcf-pg@.service", units), "utf8");
  const filters = assignments(unit, "SystemCallFilter");
  // systemd merges the lines in file order: a `~` line removes from what the lines above it allowed.
  const allowedAt = filters.indexOf("@system-service");
  assert.notEqual(allowedAt, -1, "the filter starts from @system-service");
  const denied = new Set(
    filters
      .slice(allowedAt + 1)
      .filter((line) => line.startsWith("~"))
      .flatMap((line) => line.slice(1).split(/\s+/)),
  );
  for (const name of [
    "@privileged",
    "@resources",
    "@keyring",
    "io_uring_setup",
    "io_uring_enter",
    "io_uring_register",
    "userfaultfd",
    "msgget",
    "semget",
  ]) {
    assert.ok(denied.has(name), `${name} is denied below @system-service`);
  }
  for (const name of ["shmget", "shmat", "shmdt", "shmctl"]) {
    assert.ok(!denied.has(name), `PostgreSQL needs ${name}`);
  }
});

test("a database's private /dev/shm cannot run code, hold setuid files or hold device nodes", () => {
  const unit = readFileSync(new URL("pgcf-pg@.service", units), "utf8");
  const shm = assignments(unit, "TemporaryFileSystem").find((value) => value.startsWith("/dev/shm:"));
  assert.ok(shm, "the unit mounts /dev/shm");
  const options = shm.slice("/dev/shm:".length).split(",");
  for (const option of ["noexec", "nosuid", "nodev", "mode=1777"]) {
    assert.ok(options.includes(option), `${option} in ${shm}`);
  }
});

test("the kernel refuses io_uring and line-discipline autoload: a database's user gets no module surface", () => {
  const sysctl = new Map(
    readFileSync(new URL("usr/lib/sysctl.d/90-pgcf.conf", image), "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
      .map((line) => line.split("=").map((part) => part.trim()) as [string, string]),
  );
  assert.equal(sysctl.get("kernel.io_uring_disabled"), "2");
  assert.equal(sysctl.get("dev.tty.ldisc_autoload"), "0");
});

test("the database directory is traversable but not listable: tmpfiles resets its mode at every boot", () => {
  const tmpfiles = records(readFileSync(new URL("usr/lib/tmpfiles.d/pgcf.conf", image), "utf8"));
  const directory = tmpfiles.find((fields) => fields[1] === "/var/lib/pgcf/db");
  // The agent creates it 0711 (store.rs); a tenant must reach its own directory but not list the IDs.
  assert.deepEqual(directory?.slice(0, 5), ["d", "/var/lib/pgcf/db", "0711", "root", "root"]);
});
