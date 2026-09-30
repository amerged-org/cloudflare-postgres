// SPDX-License-Identifier: Apache-2.0
// Run the actual initializer with real private files and only the observed
// kubelet mount paths/ownership translated for an unprivileged test host.
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const root = process.env.PGCF_FIXTURE_ROOT;
if (!root) throw new Error("bootstrap_fixture_root_missing");
const hostUid = process.getuid();
const hostGid = process.getgid();
const originals = {
  openSync: filesystem.openSync,
  lstatSync: filesystem.lstatSync,
  fstatSync: filesystem.fstatSync,
  mkdirSync: filesystem.mkdirSync,
  readdirSync: filesystem.readdirSync,
};
const mounts = [
  ["/bootstrap", join(root, "bootstrap")],
  ["/private", join(root, "private")],
  ["/var/lib/pgcf", join(root, "journal-volume")],
];
function mappedPath(path) {
  if (typeof path !== "string") return path;
  for (const [mount, local] of mounts)
    if (path === mount || path.startsWith(`${mount}/`))
      return `${local}${path.slice(mount.length)}`;
  return path;
}
function mappedOwner(info) {
  if (info.uid === hostUid) info.uid = 1000;
  if (info.gid === hostGid) info.gid = 1000;
  return info;
}
filesystem.openSync = (path, ...arguments_) =>
  originals.openSync(mappedPath(path), ...arguments_);
filesystem.lstatSync = (path, ...arguments_) => {
  const info = mappedOwner(
    originals.lstatSync(mappedPath(path), ...arguments_),
  );
  if (path === "/private" || path === "/var/lib/pgcf") {
    info.uid = 0;
    info.gid = 1000;
    info.mode = (info.mode & ~0o7777) | (path === "/private" ? 0o3777 : 0o2775);
  }
  return info;
};
filesystem.fstatSync = (...arguments_) =>
  mappedOwner(originals.fstatSync(...arguments_));
filesystem.mkdirSync = (path, ...arguments_) =>
  originals.mkdirSync(mappedPath(path), ...arguments_);
filesystem.readdirSync = (path, ...arguments_) =>
  originals.readdirSync(mappedPath(path), ...arguments_);
process.getuid = () => 1000;
process.getgid = () => 1000;
syncBuiltinESMExports();
