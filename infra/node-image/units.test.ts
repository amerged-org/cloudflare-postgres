// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { readHostFiles } from "./host-files.ts";

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

// A database unit and a pooled slot unit have one sandbox (D13): each test about it runs against both.
const databaseUnits = ["pgcf-pg@.service", "pgcf-slot@.service"];
function eachDatabaseUnit(title: string, check: (unit: string, name: string) => void): void {
  for (const name of databaseUnits) test(`${name}: ${title}`, () => check(readFileSync(new URL(name, units), "utf8"), name));
}

interface Directive {
  section: string;
  key: string;
  value: string;
}
// Every `Key=value` line of a unit with its section, in file order.
function directives(text: string): Directive[] {
  let section = "";
  const found: Directive[] = [];
  for (const line of text.split("\n").map((raw) => raw.trim())) {
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      section = header[1] ?? "";
      continue;
    }
    const at = line.indexOf("=");
    assert.ok(at > 0, `a directive: ${line}`);
    found.push({ section, key: `${section}.${line.slice(0, at)}`, value: line.slice(at + 1) });
  }
  return found;
}
// The values of each directive, by `Section.Key`, in file order.
function valuesByKey(list: Directive[]): Record<string, string[]> {
  const byKey: Record<string, string[]> = {};
  for (const { key, value } of list) (byKey[key] ??= []).push(value);
  return byKey;
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

eachDatabaseUnit("a database starts with its postgres process alone: the agent creates the socket directory", (unit) => {
  assert.doesNotMatch(unit, /^ExecStart(Pre|Post)=/m, "every extra process adds to the wake");
});

eachDatabaseUnit("the system-call filter denies the kernel's second-stage primitives and keeps SysV shared memory", (unit) => {
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

test("a database unit mounts its own volume from the agent's link and refuses to start without it", () => {
  const unit = readFileSync(new URL("pgcf-pg@.service", units), "utf8");
  // The volume is in the agent's mount namespace only: PID 1's namespace is what every executor
  // copies and re-reads, so a start would grow with the number of volumes mounted there.
  assert.deepEqual(assignments(unit, "MountImages"), [
    "/run/pgcf/dev/%i:/var/lib/pgcf/db/%i:root:nosuid,nodev,noexec,noatime",
  ]);
  // The link exists only while the agent has the volume attached: a dangling or missing link
  // fails the start (an assertion, where a condition would skip it), and nothing runs on an empty
  // directory.
  assert.deepEqual(assignments(unit, "AssertPathExists"), ["/run/pgcf/dev/%i"]);
  assert.doesNotMatch(unit, /^AssertPathIsMountPoint=/m, "there is no mount in PID 1's namespace to assert");
  assert.doesNotMatch(unit, /^After=.*\.mount/m, "no mount unit exists for the volume");
  // The volume is writable as the unit's own mount; listing it fails with ENOENT on the host.
  assert.deepEqual(assignments(unit, "ReadWritePaths"), ["/run/pgcf/%i"]);
  // A `ro` option makes the second mount of the superblock fail (226/NAMESPACE).
  const [, , partition, options] = (assignments(unit, "MountImages")[0] ?? "").split(":");
  assert.equal(partition, "root");
  assert.ok(!(options ?? "").split(",").includes("ro"));
  for (const option of ["nosuid", "nodev", "noexec", "noatime"]) {
    assert.ok((options ?? "").split(",").includes(option), option);
  }
});

test("MountImages= opens the device policy to block devices: a private /dev and no capability keep them out of a database's reach", () => {
  const unit = readFileSync(new URL("pgcf-pg@.service", units), "utf8");
  // systemd adds block-device-mapper, block-blkext and block-loop (rwm) and /dev/mapper/control and
  // /dev/loop-control (rw) to the policy of a unit with MountImages=. The nodes of the devices are
  // not in the unit's /dev, and without CAP_MKNOD (the bounding set is empty) the user cannot
  // make one: these two directives are what the widening rests on.
  assert.deepEqual(assignments(unit, "PrivateDevices"), ["yes"]);
  assert.deepEqual(assignments(unit, "CapabilityBoundingSet"), [""]);
  assert.deepEqual(assignments(unit, "NoNewPrivileges"), ["yes"]);
  assert.deepEqual(assignments(unit, "ProtectSystem"), ["strict"]);
  assert.deepEqual(assignments(unit, "DeviceAllow"), [], "the image adds no device of its own");
});

// D13 (plan 11.2, package P): the slot unit is the database unit directive by directive. These three
// tables are the whole difference, each row with its reason; a directive of pgcf-pg@.service that
// is in none of them has to be in the slot unit with the same value, and the slot unit has no
// directive that pgcf-pg@.service lacks and the tables do not name.
const NOT_CARRIED: [key: string, value: string, reason: string][] = [
  ["Unit.AssertPathExists", "/run/pgcf/dev/%i", "a slot is for no database and has no device link: the agent moves the volume it binds into the slot's mount namespace"],
  ["Service.MountImages", "/run/pgcf/dev/%i:/var/lib/pgcf/db/%i:root:nosuid,nodev,noexec,noatime", "the volume is bound after the start, as a clone with nosuid, nodev, noexec and noatime"],
  ["Service.ReadWritePaths", "/run/pgcf/%i", "the socket directory of a database is bound after the start; the slot's own writable directory is its RuntimeDirectory"],
];
const CHANGED: [key: string, value: string, reason: string][] = [
  ["Unit.Description", "PGCF slot %i", "a slot holds no database until the agent binds one"],
  ["Service.User", "pgcf-slot-%i", "a pooled user per slot, uid 300000 + n; the files of a database keep its own uid on disk"],
  ["Service.Group", "pgcf-slot-%i", "the slot user's group, with the same number as its uid"],
  ["Service.ExecStart", "/usr/libexec/pgcf/pgcf-archive slot %i", "the supervisor waits for the agent's order and then executes the postgres command line of pgcf-pg@.service"],
  ["Service.MemoryMax", "32M", "the idle ceiling of a supervisor; the agent sets the database's own at the bind (P-e's lab measures the idle slots)"],
  ["Service.MemoryHigh", "28M", "90 % of the idle ceiling, as pgcf-pg@.service holds 230M of 256M"],
  ["Service.CPUWeight", "10", "an idle slot yields to every awake database, and the refill runs at this weight"],
];
const ADDED: [key: string, value: string, reason: string][] = [
  ["Unit.StartLimitIntervalSec", "0", "a slot number restarts often, and systemd's limit of 5 starts in 10 s would refuse them"],
  ["Service.RuntimeDirectory", "pgcf/slot/%i", "the supervisor's control socket; systemd removes the leaf at the stop"],
  ["Service.RuntimeDirectoryMode", "0700", "only the slot's user and root reach the control socket"],
];

test("the slot unit carries every directive of the database unit that is not about one database, and differs in no other", () => {
  const database = directives(readFileSync(new URL("pgcf-pg@.service", units), "utf8"));
  const slot = directives(readFileSync(new URL("pgcf-slot@.service", units), "utf8"));
  for (const [key, value] of NOT_CARRIED)
    assert.ok(database.some((directive) => directive.key === key && directive.value === value), `${key} is in pgcf-pg@.service`);
  for (const [key] of CHANGED) assert.equal(database.filter((directive) => directive.key === key).length, 1, key);
  const expected = [
    ...database
      .filter((directive) => !NOT_CARRIED.some(([key, value]) => key === directive.key && value === directive.value))
      .map((directive) => ({ ...directive, value: CHANGED.find(([key]) => key === directive.key)?.[1] ?? directive.value })),
    ...ADDED.map(([key, value]) => ({ section: key.split(".")[0] ?? "", key, value })),
  ];
  assert.deepEqual(valuesByKey(slot), valuesByKey(expected));
  for (const [key, , reason] of [...NOT_CARRIED, ...CHANGED, ...ADDED]) assert.ok(reason.length > 20, key);
});

test("a slot has no device of its own: with no MountImages= the policy is closed and holds only the clock", () => {
  const unit = readFileSync(new URL("pgcf-slot@.service", units), "utf8");
  assert.deepEqual(assignments(unit, "DeviceAllow"), []);
  assert.deepEqual(assignments(unit, "MountImages"), []);
  for (const [key, value] of [
    ["PrivateDevices", "yes"],
    ["CapabilityBoundingSet", ""],
    ["NoNewPrivileges", "yes"],
    ["ProtectSystem", "strict"],
    ["ProtectClock", "yes"],
  ] as const)
    assert.deepEqual(assignments(unit, key), [value], key);
});

test("journald writes no per-uid journal: a slot's uid is used again and again, and the files would be read by the next tenant", () => {
  // SplitMode=uid (the default) keeps user-<uid>.journal with a POSIX ACL that grants the uid read
  // access, for every uid outside systemd's system, dynamic and container ranges, which includes the
  // slot uids (300000 + n). The unit cannot see the journal directories (InaccessiblePaths=), and
  // this removes the files at the source. Files of earlier uids stay until journald vacuums them.
  const directory = new URL("usr/lib/systemd/journald.conf.d/", image);
  const modes = readdirSync(directory).flatMap((name) =>
    assignments(readFileSync(new URL(name, directory), "utf8"), "SplitMode"),
  );
  assert.deepEqual(modes, ["none"]);
});

test("the agent runs in a mount namespace of its own: its volumes never reach PID 1 or the executors", () => {
  const unit = readFileSync(new URL("pgcf-agent.service", units), "utf8");
  assert.deepEqual(assignments(unit, "PrivateMounts"), ["yes"]);
  // The agent alone mounts and unmounts volumes, trims and grows them; no other filesystem sandbox
  // is set: the agent needs to see the node.
  for (const key of ["ProtectSystem", "ProtectHome", "PrivateTmp", "ReadWritePaths", "ReadOnlyPaths", "InaccessiblePaths"]) {
    assert.deepEqual(assignments(unit, key), [], key);
  }
});

test("the three oneshots that MountImages= pulls into every start are masked: a start forks none of them", () => {
  // modprobe@.service has no RemainAfterExit, so loop, dm_mod and dm_verity would run again for every
  // database that starts (about 7 ms, three forks). dm_mod loads on its own when the device-mapper
  // control node is opened.
  for (const module of ["loop", "dm_mod", "dm_verity"]) {
    const mask = new URL(`etc/systemd/system/modprobe@${module}.service`, image);
    assert.equal(lstatSync(mask).isSymbolicLink(), true, module);
    assert.equal(readlinkSync(mask), "/dev/null", module);
  }
});

eachDatabaseUnit("a database's private /dev/shm cannot run code, hold setuid files or hold device nodes", (unit) => {
  const shm = assignments(unit, "TemporaryFileSystem").find((value) => value.startsWith("/dev/shm:"));
  assert.ok(shm, "the unit mounts /dev/shm");
  const options = shm.slice("/dev/shm:".length).split(",");
  for (const option of ["noexec", "nosuid", "nodev", "mode=1777"]) {
    assert.ok(options.includes(option), `${option} in ${shm}`);
  }
});

eachDatabaseUnit("a database shares no IPC namespace and no writable directory with another unit: /run/lock, /dev/mqueue and /dev/pts are out of reach", (unit) => {
  // /run/lock (a 5 MiB tmpfs) and /dev/mqueue (the host's queues) are mode 1777 and mounted
  // read-write in every unit: a place where one tenant leaves what another reads, and files that
  // outlive the unit in a node-wide tmpfs (LVM keeps its lock directory there). /dev/pts is the
  // host's devpts, bound into the private /dev: its ptmx gave one user 3072 of the node's 4096
  // ptys, and its listing showed every unit's.
  // PrivateIPC= gives the unit its SysV namespace and a mqueue instance of its own (measured on
  // systemd 257.13). The inaccessible /dev/mqueue keeps the queues out of reach for open(2) as well:
  // the filter denies mq_open, and a file created in the directory is the same queue.
  assert.deepEqual(assignments(unit, "PrivateIPC"), ["yes"]);
  const inaccessible = assignments(unit, "InaccessiblePaths").flatMap((line) => line.split(/\s+/));
  for (const path of ["-/run/lock", "-/dev/mqueue", "-/dev/pts"]) {
    assert.ok(inaccessible.includes(path), path);
  }
  // PostgreSQL's pid interlock stays: a second unit on a data directory finds the first postmaster
  // with kill(pid, 0) only while the units share the PID namespace. The segment half of the interlock
  // is blind across IPC namespaces, so this half is what refuses the second postmaster.
  assert.deepEqual(assignments(unit, "PrivatePIDs"), []);
});

eachDatabaseUnit("a database's user cannot read a journal file: journald's per-uid files outlive the uid's database", (unit) => {
  // journald (SplitMode=uid, the default) keeps /var/log/journal/<machine>/user-<uid>.journal with a
  // POSIX ACL that grants the uid read access. The agent frees a uid when its database leaves the
  // node and hands it to a later database; the file stays, and the new tenant would read the former
  // one's log lines (DETAIL lines carry data). The unit logs through /run/systemd/journal/stdout,
  // which these paths do not touch.
  const inaccessible = assignments(unit, "InaccessiblePaths").flatMap((line) => line.split(/\s+/));
  for (const path of ["-/var/log/journal", "-/run/log/journal"]) {
    assert.ok(inaccessible.includes(path), path);
  }
  assert.deepEqual(
    inaccessible.sort(),
    ["-/dev/mqueue", "-/dev/pts", "-/run/lock", "-/run/log/journal", "-/var/log/journal"],
    "no other path is made inaccessible",
  );
});

eachDatabaseUnit("a database's /tmp and /var/tmp are small tmpfs of its own: no tenant fills the node's root filesystem", (unit) => {
  // PrivateTmp=yes puts both directories on the host's root filesystem (8 GiB, no quota), and disk
  // blocks are no memory that MemoryMax counts: one awake tenant filled it, which stops the journal
  // and the agent's state writes for the whole node. PostgreSQL uses neither directory.
  assert.deepEqual(assignments(unit, "PrivateTmp"), []);
  const mounts = assignments(unit, "TemporaryFileSystem");
  for (const path of ["/tmp", "/var/tmp"]) {
    const mount = mounts.find((value) => value.startsWith(`${path}:`));
    assert.ok(mount, `the unit mounts ${path}`);
    const options = mount.slice(path.length + 1).split(",");
    for (const option of ["noexec", "nosuid", "nodev", "mode=1777", "size=16M", "nr_inodes=1024"]) {
      assert.ok(options.includes(option), `${option} in ${mount}`);
    }
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
  // The agent creates it 0711 (store.rs); a tenant reaches its own directory but nobody lists this one.
  assert.deepEqual(directory?.slice(0, 5), ["d", "/var/lib/pgcf/db", "0711", "root", "root"]);
});

test("systemd's ssh generator is masked and off on the kernel command line: no sshd socket for a database's user", () => {
  // With sshd installed, systemd 257 binds it to /run/ssh-unix-local/socket (mode 0666) and to vsock.
  const mask = new URL("etc/systemd/system-generators/systemd-ssh-generator", image);
  assert.equal(lstatSync(mask).isSymbolicLink(), true);
  assert.equal(readlinkSync(mask), "/dev/null");
  const kernels = readFileSync(new URL("efi/grub/grub.cfg", image), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("linux "));
  assert.equal(kernels.length, 2, "the current and the previous kernel");
  for (const line of kernels) assert.ok(line.split(/\s+/).includes("systemd.ssh_auto=no"), line);
});

test("sshd takes user certificates only and the image ships no CA key: nothing logs in until a CA key is written", () => {
  const directives = records(readFileSync(new URL("etc/ssh/sshd_config.d/10-pgcf.conf", image), "utf8")).map(
    (fields) => [(fields[0] ?? "").toLowerCase(), fields.slice(1).join(" ")] as const,
  );
  const values = (keyword: string) => directives.filter(([name]) => name === keyword).map(([, value]) => value);
  assert.deepEqual(values("listenaddress"), ["127.0.0.1", "::1"]);
  const fixed = {
    passwordauthentication: "no",
    kbdinteractiveauthentication: "no",
    authenticationmethods: "publickey",
    authorizedkeysfile: "none",
    allowusers: "root",
  };
  for (const [keyword, value] of Object.entries(fixed)) assert.deepEqual(values(keyword), [value], keyword);
  const ca = values("trustedusercakeys")[0];
  assert.ok(ca !== undefined && ca.startsWith("/"), "a CA file is named");
  assert.equal(existsSync(new URL(ca.slice(1), image)), false, "the public image carries no CA key");
  // sshd skips '#' lines in a principals file, so the file carries the licence header of its neighbours.
  const principals = readFileSync(new URL("etc/ssh/principals/root", image), "utf8");
  assert.match(principals, /^# SPDX-License-Identifier: Apache-2\.0\n/);
  assert.deepEqual(records(principals), [["pgcf-break-glass"]]);
  assert.deepEqual(values("authorizedprincipalsfile"), ["/etc/ssh/principals/%u"]);
  // A missing RevokedKeys file makes sshd refuse every public key, so the image ships an empty KRL:
  // the header of PROTOCOL.krl (magic, format 1, version, date, flags, reserved, comment), no section.
  const revoked = values("revokedkeys")[0];
  assert.ok(revoked !== undefined && revoked.startsWith("/"), "a revocation list is named");
  const krl = readFileSync(new URL(revoked.slice(1), image));
  assert.equal(krl.length, 44);
  assert.equal(krl.subarray(0, 8).toString("latin1"), "SSHKRL\n\0");
  assert.equal(krl.readUInt32BE(8), 1);
});

test("the break-glass sshd grants a root shell to one certificate principal and nothing else: no forwarding, two tries, certificate and key id logged", () => {
  const ssh = new URL("etc/ssh/", image);
  const dropIns = readdirSync(new URL("sshd_config.d/", ssh));
  assert.deepEqual(dropIns, ["10-pgcf.conf"], "no other drop-in can undo it");
  assert.deepEqual(
    readdirSync(ssh).sort(),
    ["pgcf_revoked.krl", "principals", "sshd_config.d"],
    "no CA key, no authorized key and no host key in the image",
  );
  assert.deepEqual(readdirSync(new URL("principals/", ssh)), ["root"], "no other user has a principals file");
  assert.equal(existsSync(new URL("root/.ssh", image)), false, "no authorized_keys for root");
  const conf = readFileSync(new URL("sshd_config.d/10-pgcf.conf", ssh), "utf8");
  const directives = records(conf).map((fields) => [(fields[0] ?? "").toLowerCase(), fields.slice(1).join(" ")] as const);
  const values = (keyword: string) => directives.filter(([name]) => name === keyword).map(([, value]) => value);
  // A Match block would apply other values to some connections.
  assert.deepEqual(values("match"), []);
  // sshd takes the first value of a keyword: each is given once, so none is overridden below it.
  for (const [keyword] of directives)
    if (keyword !== "listenaddress") assert.equal(values(keyword).length, 1, `${keyword} is given once`);
  const fixed = {
    pubkeyauthentication: "yes",
    permitrootlogin: "prohibit-password",
    maxauthtries: "2",
    maxsessions: "2",
    x11forwarding: "no",
    allowtcpforwarding: "no",
    allowagentforwarding: "no",
    permittunnel: "no",
    disableforwarding: "yes",
    gssapiauthentication: "no",
    trustedusercakeys: "/etc/ssh/pgcf_user_ca.pub",
    authorizedprincipalsfile: "/etc/ssh/principals/%u",
    // The certificate's key id and the CA's fingerprint, which node-shell.ts fills, are in the journal.
    loglevel: "VERBOSE",
  };
  for (const [keyword, value] of Object.entries(fixed)) assert.deepEqual(values(keyword), [value], keyword);
  // Loopback only: the Tunnel's connector reaches it there, and nothing else does.
  assert.deepEqual(values("listenaddress"), ["127.0.0.1", "::1"]);
  assert.deepEqual(values("port"), []);
  assert.deepEqual(values("gatewayports"), []);
  // The one principal is the one the operator's helper signs for.
  assert.deepEqual(records(readFileSync(new URL("principals/root", ssh), "utf8")), [["pgcf-break-glass"]]);
});

test("the journal is synced every 15 s: the minutes before a freeze reach the disk", () => {
  const journald = readFileSync(new URL("usr/lib/systemd/journald.conf.d/pgcf.conf", image), "utf8");
  assert.deepEqual(assignments(journald, "SyncIntervalSec"), ["15s"]);
  assert.deepEqual(assignments(journald, "Storage"), ["persistent"]);
});

test("every host file takes effect the way it needs: a running service is restarted, the per-database template at its next start, a slice or a mask by the reload, users and directories through their tools", async () => {
  const { files } = await readHostFiles();
  const apply = new Map(files.map((file) => [file.path, file.apply]));
  // A unit of the node's own services restarts itself: the new file is what the running process
  // lacks. The agent's restart is last and is the agent leaving, which systemd answers with the
  // new definition once it has been read again.
  for (const service of ["pgcf-agent", "pgcf-gateway", "pgcf-cloudflared"])
    assert.equal(apply.get(`/usr/lib/systemd/system/${service}.service`), `restart_unit:${service}.service`, service);
  // A database's unit is never restarted for a file: it takes the new definition when it next
  // starts, and a restart would stop a tenant's database.
  assert.equal(apply.get("/usr/lib/systemd/system/pgcf-pg@.service"), "next_start");
  // The same for a slot: the agent stops the idle ones after the reload and builds them again from
  // the new file; a slot that serves a database keeps its definition until the database sleeps.
  assert.equal(apply.get("/usr/lib/systemd/system/pgcf-slot@.service"), "next_start");
  for (const slice of ["pgcf.slice", "pgcfbackup.slice"])
    assert.equal(apply.get(`/usr/lib/systemd/system/${slice}`), "daemon_reload", slice);
  for (const module of ["loop", "dm_mod", "dm_verity"])
    assert.equal(apply.get(`/etc/systemd/system/modprobe@${module}.service`), "daemon_reload", module);
  // sshd reads its configuration at start; the others read theirs through the unit that applies it.
  assert.equal(apply.get("/etc/ssh/sshd_config.d/10-pgcf.conf"), "restart_unit:ssh.service");
  assert.equal(apply.get("/usr/lib/sysctl.d/90-pgcf.conf"), "restart_unit:systemd-sysctl.service");
  assert.equal(apply.get("/usr/lib/systemd/journald.conf.d/pgcf.conf"), "restart_unit:systemd-journald.service");
  assert.equal(apply.get("/usr/lib/systemd/journald.conf.d/pgcf-split.conf"), "restart_unit:systemd-journald.service");
  // Users and directories are made by the tool that reads the file, at once. A reboot would not
  // make a user: systemd-sysusers.service runs at a boot only when /usr is newer than
  // /etc/.updated, and a changed file in /usr/lib/sysusers.d does not change /usr.
  for (const [path, how] of apply) {
    if (dirname(path).endsWith("/sysusers.d")) assert.equal(how, "sysusers", path);
    if (dirname(path).endsWith("/tmpfiles.d")) assert.equal(how, "tmpfiles", path);
  }
  assert.equal(apply.get("/usr/lib/sysusers.d/pgcf.conf"), "sysusers");
  assert.equal(apply.get("/usr/lib/tmpfiles.d/pgcf.conf"), "tmpfiles");
});

test("mkosi adds no tree of its own over mkosi.extra: what the registration lists is what the image holds", () => {
  const conf = readFileSync(new URL("mkosi.conf", import.meta.url), "utf8");
  assert.doesNotMatch(conf, /^(ExtraTrees|SkeletonTrees|BuildSources)=/m);
});
