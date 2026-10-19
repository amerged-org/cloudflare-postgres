// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { HOST_FILE_DIRECTORIES, HostFiles, hostFilesSha256 } from "../../packages/contracts/src/releases.ts";
import { HOST_FILE_APPLY, IMAGE_ONLY, imageTree, readHostFiles } from "./host-files.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
/** A tree of files, as the image's mkosi.extra: `files` maps an absolute image path to its bytes, a `-> target` for a link. */
function treeOf(files: Record<string, string>, modes: Record<string, number> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pgcf-tree-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    if (content.startsWith("-> ")) symlinkSync(content.slice(3), target);
    else {
      writeFileSync(target, content);
      chmodSync(target, modes[path] ?? 0o664);
    }
  }
  return root;
}
const unit = "/usr/lib/systemd/system/pgcf-x.service";
const tables = (apply: Record<string, string>, imageOnly: Record<string, string> = {}) =>
  ({ apply, imageOnly }) as Parameters<typeof readHostFiles>[1];

test("the image tree is read as one list: every file of it is a host file or stated to be the image's alone, and no row of either table is stale", async () => {
  const { files, sources } = await readHostFiles(imageTree);
  assert.ok(files.length > 0);
  assert.equal(HostFiles.safeParse(files).success, true);
  // Each file is in an allow-listed directory, directly in it.
  for (const file of files) assert.ok(HOST_FILE_DIRECTORIES.includes(dirname(file.path) as never), file.path);
  // The units and the masks the V4h change is made of are among them.
  const paths = files.map((file) => file.path);
  for (const path of [
    "/usr/lib/systemd/system/pgcf-pg@.service",
    "/usr/lib/systemd/system/pgcf-agent.service",
    "/etc/systemd/system/modprobe@loop.service",
    "/etc/systemd/system/modprobe@dm_mod.service",
    "/etc/systemd/system/modprobe@dm_verity.service",
  ])
    assert.ok(paths.includes(path), path);
  // The bytes of every file with content are found by their digest.
  for (const file of files) if (file.kind === "file") assert.ok(sources.has(file.sha256), file.path);
  assert.deepEqual(Object.keys(HOST_FILE_APPLY).sort(), paths);
  // What a release cannot carry is the image's alone, with a reason.
  for (const [path, reason] of Object.entries(IMAGE_ONLY)) {
    assert.ok(!paths.includes(path), path);
    assert.ok(reason.length > 20, path);
  }
});

test("a tree change changes the list: a byte, a mode, a mask's presence and a new file each do", async () => {
  const base: Record<string, string> = { [unit]: "[Service]\n", "/etc/systemd/system/m.service": "-> /dev/null" };
  const apply: Record<string, string> = { [unit]: "next_start", "/etc/systemd/system/m.service": "daemon_reload" };
  const digest = async (files: Record<string, string>, modes?: Record<string, number>, table = apply) => {
    const { files: list } = await readHostFiles(treeOf(files, modes), tables(table));
    return hostFilesSha256(list);
  };
  const first = await digest(base);
  assert.equal(await digest(base), first, "the same tree has the same digest");
  assert.notEqual(await digest({ ...base, [unit]: "[Service]\nUser=x\n" }), first);
  assert.notEqual(await digest(base, { [unit]: 0o775 }), first);
  const { "/etc/systemd/system/m.service": _mask, ...without } = base;
  void _mask;
  assert.notEqual(await digest(without, undefined, { [unit]: "next_start" }), first);
  assert.notEqual(
    await digest({ ...base, "/etc/sysctl.d/90-x.conf": "a = 1\n" }, undefined, { ...apply, "/etc/sysctl.d/90-x.conf": "reboot" }),
    first,
  );
});

test("a mode is the execute bit and nothing else: 0644 or 0755, whatever the checkout's umask made of it", async () => {
  const { files } = await readHostFiles(
    treeOf({ [unit]: "a", "/etc/sysctl.d/90-x.conf": "b", "/etc/sysctl.d/91-y.conf": "c" }, { [unit]: 0o700, "/etc/sysctl.d/91-y.conf": 0o775 }),
    tables({ [unit]: "next_start", "/etc/sysctl.d/90-x.conf": "reboot", "/etc/sysctl.d/91-y.conf": "reboot" }),
  );
  assert.deepEqual(
    files.map((file) => [file.path, file.kind === "file" ? file.mode : undefined]),
    [
      ["/etc/sysctl.d/90-x.conf", "0644"],
      ["/etc/sysctl.d/91-y.conf", "0755"],
      // The owner's execute bit is the one that counts: 0700 is an executable file.
      [unit, "0755"],
    ],
  );
});

test("the list is ascending by path, whatever order the directory is read in", async () => {
  const names = ["/usr/lib/systemd/system/b.service", "/etc/systemd/system/z.service", "/usr/lib/systemd/system/a.service", "/etc/sysctl.d/90-x.conf"];
  const { files } = await readHostFiles(
    treeOf(Object.fromEntries(names.map((name) => [name, name]))),
    tables(Object.fromEntries(names.map((name) => [name, "daemon_reload"]))),
  );
  assert.deepEqual(files.map((file) => file.path), [...names].sort());
});

test("a file the tables do not decide on stops the registration: a new unit is a decision about how it takes effect", async () => {
  await assert.rejects(readHostFiles(treeOf({ [unit]: "x" }), tables({})), /pgcf-x\.service.*how it takes effect/s);
  await assert.rejects(
    readHostFiles(treeOf({ "/etc/other.conf": "x" }), tables({})),
    /\/etc\/other\.conf.*neither a host file nor listed as image-only/s,
  );
  // A file in an allow-listed directory is a host file: it cannot be declared the image's alone.
  await assert.rejects(readHostFiles(treeOf({ [unit]: "x" }), tables({ [unit]: "next_start" }, { [unit]: "no" })), /both/);
  // A row for a file the tree does not hold is a row nobody reads.
  await assert.rejects(readHostFiles(treeOf({ [unit]: "x" }), tables({ [unit]: "next_start", "/etc/sysctl.d/gone.conf": "reboot" })), /gone\.conf.*not in the tree/s);
  await assert.rejects(readHostFiles(treeOf({ [unit]: "x" }), tables({ [unit]: "next_start" }, { "/etc/gone": "is not there at all" })), /\/etc\/gone.*not in the tree/s);
});

test("a link is a host file only as a mask of /dev/null, and a file is read whole or refused", async () => {
  await assert.rejects(
    readHostFiles(treeOf({ [unit]: "-> /etc/passwd" }), tables({ [unit]: "daemon_reload" })),
    /\/dev\/null/,
  );
  await assert.rejects(
    readHostFiles(treeOf({ [unit]: "-> ../elsewhere" }), tables({ [unit]: "daemon_reload" })),
    /\/dev\/null/,
  );
  await assert.rejects(
    readHostFiles(treeOf({ [unit]: "x".repeat(1_048_577) }), tables({ [unit]: "next_start" })),
    /1048576/,
  );
  await assert.rejects(readHostFiles(treeOf({}), tables({})), /no host file/);
});
