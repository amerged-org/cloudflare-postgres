// SPDX-License-Identifier: Apache-2.0
// The host files of a release (ULTRA plan 9.3): the files of the image's tree that matter at run
// time and that a release changes on a running node, without a new image. There is one definition:
// the tree `mkosi.extra`, which mkosi copies into the image. The registration derives the list a
// release carries from it, and the build summary states its digest, so the files a fresh image
// holds and the files a release gives an updated node are the same bytes by construction. Two
// tables decide what every file of the tree is, and the registration stops at a file they do not
// name, so that adding a file forces the decision of how it takes effect.
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  HOST_FILE_DIRECTORIES,
  HOST_FILE_MAX_BYTES,
  HostFiles,
  type HostFile,
} from "../../packages/contracts/src/releases.ts";

/** The tree mkosi copies into the image (`mkosi.extra`); its paths are the image's. */
export const imageTree = join(import.meta.dirname, "mkosi.extra");

/**
 * How each host file takes effect (`HOST_FILE_APPLIES`). The agent reads systemd's units again
 * once after it wrote anything, so a row says what more a file needs: a unit that runs is
 * restarted (the agent's own last, by exiting), the template of the per-database unit gives a
 * running database its stop settings (`KillSignal=`, `TimeoutStopSec=`, `ExecStop=`) at its next
 * stop and everything else (the process, `ExecStart=`, `MountImages=`, `PrivateMounts=` and the
 * limits of its cgroup, which systemd does not re-apply at a reload) at its next start, a mask or a
 * slice needs nothing beyond the reload, and a sysusers or tmpfiles file is run through its tool
 * (systemd makes users at a boot only when /usr is newer than /etc/.updated, which a changed file
 * in /usr/lib/sysusers.d does not make it, so a reboot would not apply it).
 */
export const HOST_FILE_APPLY: Record<string, HostFile["apply"]> = {
  "/etc/ssh/sshd_config.d/10-pgcf.conf": "restart_unit:ssh.service",
  "/etc/systemd/system/modprobe@dm_mod.service": "daemon_reload",
  "/etc/systemd/system/modprobe@dm_verity.service": "daemon_reload",
  "/etc/systemd/system/modprobe@loop.service": "daemon_reload",
  "/usr/lib/sysctl.d/90-pgcf.conf": "restart_unit:systemd-sysctl.service",
  "/usr/lib/sysusers.d/pgcf.conf": "sysusers",
  "/usr/lib/systemd/journald.conf.d/pgcf.conf": "restart_unit:systemd-journald.service",
  "/usr/lib/systemd/system/pgcf-agent.service": "restart_unit:pgcf-agent.service",
  "/usr/lib/systemd/system/pgcf-cloudflared.service": "restart_unit:pgcf-cloudflared.service",
  "/usr/lib/systemd/system/pgcf-gateway.service": "restart_unit:pgcf-gateway.service",
  "/usr/lib/systemd/system/pgcf-pg@.service": "next_start",
  "/usr/lib/systemd/system/pgcf.slice": "daemon_reload",
  "/usr/lib/systemd/system/pgcfbackup.slice": "daemon_reload",
  "/usr/lib/tmpfiles.d/pgcf.conf": "tmpfiles",
};

/**
 * What the image carries and no release changes, with the reason: these still need a new image.
 * A file here is never in an allow-listed directory.
 */
export const IMAGE_ONLY: Record<string, string> = {
  "/efi/grub/grub.cfg": "The bootloader and the kernel command line are read before any agent runs.",
  "/etc/fstab": "Mounts are made at boot, before the agent runs.",
  "/etc/hosts": "Name resolution of the node itself, read at boot.",
  "/etc/nftables.conf":
    "The firewall: a mistake locks the node out for good, so it changes only with an image (a package update keeps it as it is).",
  "/etc/ssh/pgcf_revoked.krl": "A data file of sshd, which the allow-list of directories does not reach.",
  "/etc/ssh/principals/root": "A data file of sshd, which the allow-list of directories does not reach.",
  "/etc/systemd/system-generators/systemd-ssh-generator":
    "A mask of a generator, outside the unit directories: the generator would bind sshd to a socket every local user reaches.",
  "/usr/lib/repart.d/20-root.conf": "Partitioning at the first boot.",
  "/usr/lib/repart.d/30-lvm.conf": "Partitioning at the first boot.",
  "/usr/lib/systemd/system-preset/10-pgcf.preset":
    "Which units are enabled is decided at the first boot (presets), and a release changes no enablement.",
  "/usr/libexec/pgcf/pgcf-archive": "A link to the binary of the running release; it never changes.",
  "/usr/libexec/pgcf/pgcf-wal-fetch": "A link to the binary of the running release; it never changes.",
};

export interface HostFileTables {
  apply: Record<string, string>;
  imageOnly: Record<string, string>;
}
export interface HostFileTree {
  /** The list a release carries, ascending by path. */
  files: HostFile[];
  /** Where the bytes of each file with content are, by their sha256. */
  sources: Map<string, string>;
}

async function walk(directory: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await walk(join(directory, entry.name), path)));
    else found.push(path);
  }
  return found;
}

/**
 * The host files of a tree: every file in an allow-listed directory, directly in it, as the agent
 * would hold it. A file that is neither one of those nor stated to be the image's alone, a row
 * that names no file of the tree, a link that is not a mask of /dev/null and a file over the
 * bound are errors. The mode is the owner's execute bit (0755, else 0644), because a checkout's
 * umask is no fact of the file.
 */
export async function readHostFiles(
  tree: string = imageTree,
  tables: HostFileTables = { apply: HOST_FILE_APPLY, imageOnly: IMAGE_ONLY },
): Promise<HostFileTree> {
  const present = (await walk(tree)).sort();
  const known = new Set(present);
  for (const path of [...Object.keys(tables.apply), ...Object.keys(tables.imageOnly)])
    if (!known.has(path)) throw new Error(`${path} is named by a table and is not in the tree`);
  const files: HostFile[] = [];
  const sources = new Map<string, string>();
  for (const path of present) {
    const managed = (HOST_FILE_DIRECTORIES as readonly string[]).includes(dirname(path));
    const apply = tables.apply[path];
    const imageOnly = tables.imageOnly[path];
    if (apply !== undefined && imageOnly !== undefined)
      throw new Error(`${path} is both a host file and the image's alone`);
    if (!managed) {
      if (imageOnly === undefined)
        throw new Error(`${path} is neither a host file nor listed as image-only: list it in IMAGE_ONLY with the reason`);
      continue;
    }
    if (apply === undefined)
      throw new Error(`${path} is a host file and has no row in HOST_FILE_APPLY: decide how it takes effect`);
    const source = join(tree, path);
    const stat = await lstat(source);
    if (stat.isSymbolicLink()) {
      if ((await readlink(source)) !== "/dev/null")
        throw new Error(`${path} is a link, and a host file that is a link is a mask of /dev/null`);
      files.push({ path, kind: "symlink-to-dev-null", apply } as HostFile);
      continue;
    }
    if (!stat.isFile()) throw new Error(`${path} is neither a file nor a link`);
    if (stat.size > HOST_FILE_MAX_BYTES)
      throw new Error(`${path} has ${stat.size} bytes, over the bound of ${HOST_FILE_MAX_BYTES}`);
    const bytes = await readFile(source);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!sources.has(sha256)) sources.set(sha256, source);
    files.push({
      path,
      kind: "file",
      mode: stat.mode & 0o100 ? "0755" : "0644",
      sha256,
      size_bytes: bytes.byteLength,
      apply,
    } as HostFile);
  }
  if (files.length === 0) throw new Error("the tree holds no host file");
  return { files: HostFiles.parse(files), sources };
}
