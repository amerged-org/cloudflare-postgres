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
  for (const slice of ["pgcf.slice", "pgcfbackup.slice"])
    assert.equal(apply.get(`/usr/lib/systemd/system/${slice}`), "daemon_reload", slice);
  for (const module of ["loop", "dm_mod", "dm_verity"])
    assert.equal(apply.get(`/etc/systemd/system/modprobe@${module}.service`), "daemon_reload", module);
  // sshd reads its configuration at start; the others read theirs through the unit that applies it.
  assert.equal(apply.get("/etc/ssh/sshd_config.d/10-pgcf.conf"), "restart_unit:ssh.service");
  assert.equal(apply.get("/usr/lib/sysctl.d/90-pgcf.conf"), "restart_unit:systemd-sysctl.service");
  assert.equal(apply.get("/usr/lib/systemd/journald.conf.d/pgcf.conf"), "restart_unit:systemd-journald.service");
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
