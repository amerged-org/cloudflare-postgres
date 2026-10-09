// SPDX-License-Identifier: Apache-2.0
// Runs only in the bounded disposable inspection container; no credentials or Docker socket.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  lstat,
  readlink,
  writeFile,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
const fail = (code: string): never => {
  throw Error(code);
};
async function run(program: string, args: string[], timeout = 30000) {
  return new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (b) => {
      out += b;
      if (out.length > 2 * 1024 ** 2) child.kill("SIGKILL");
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(Error("boot_tool_process_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 137, stdout: out });
    });
  });
}
async function required(program: string, args: string[], timeout?: number) {
  const r = await run(program, args, timeout);
  if (r.code !== 0) fail("boot_tool_command_failed");
  return r.stdout;
}
interface FileFact {
  path: string;
  file: string;
  sha256: string;
  size: number;
}
async function publish(
  root: string,
  prefix: string,
  output: string,
  files: FileFact[],
  metadata: unknown[],
) {
  const walk = async (directory: string, relative: string) => {
    for (const name of (await readdir(directory)).sort()) {
      if (!name || /[\\\p{C}]/u.test(name) || name === "." || name === "..")
        fail("boot_filesystem_path_invalid");
      const path = join(directory, name),
        rel = relative ? relative + "/" + name : name,
        info = await lstat(path);
      if (files.length + metadata.length >= 200000)
        fail("boot_filesystem_entry_limit");
      if (info.isDirectory()) {
        metadata.push({
          path: prefix + "/" + rel,
          kind: "directory",
          mode: info.mode,
        });
        await walk(path, rel);
      } else if (info.isSymbolicLink())
        metadata.push({
          path: prefix + "/" + rel,
          kind: "symlink",
          mode: info.mode,
          target: await readlink(path),
        });
      else if (info.isFile()) {
        const file = `payload-${files.length}`,
          hash = createHash("sha256");
        let size = 0;
        async function* bytes() {
          for await (const chunk of createReadStream(path)) {
            hash.update(chunk);
            size += chunk.length;
            if (size > 2 * 1024 ** 3) fail("boot_filesystem_file_limit");
            yield chunk;
          }
        }
        await pipeline(
          bytes(),
          createWriteStream(join(output, file), { flags: "wx", mode: 0o600 }),
        );
        files.push({
          path: prefix + "/" + rel,
          file,
          sha256: hash.digest("hex"),
          size,
        });
      } else
        metadata.push({
          path: prefix + "/" + rel,
          kind: "special",
          mode: info.mode,
        });
    }
  };
  await walk(root, "");
}
async function filesystems(job: {
  raw: string;
  partitions: { name: string; offset: number; size: number }[];
}) {
  const files: FileFact[] = [],
    metadata: unknown[] = [],
    loops: string[] = [],
    mounts: string[] = [];
  await mkdir("/work", { recursive: true });
  try {
    for (const p of job.partitions) {
      if (!["EFI", "BOOT"].includes(p.name)) continue;
      if (
        !Number.isSafeInteger(p.offset) ||
        p.offset < 0 ||
        !Number.isSafeInteger(p.size) ||
        p.size <= 0
      )
        fail("boot_partition_scope_invalid");
      const mount = "/work/" + p.name;
      await mkdir(mount);
      await required("mount", [
        "-t",
        p.name === "EFI" ? "vfat" : "xfs",
        "-o",
        (p.name === "EFI"
          ? "ro,noexec,nosuid,nodev"
          : "ro,norecovery,noexec,nosuid,nodev") +
          `,loop,offset=${p.offset},sizelimit=${p.size}`,
        job.raw,
        mount,
      ]);
      mounts.push(mount);
      const device = (
        await required("findmnt", ["-n", "-o", "SOURCE", "--target", mount])
      ).trim();
      if (!/^\/dev\/loop[0-9]+$/.test(device))
        fail("boot_loop_identity_invalid");
      loops.push(device);
      const detail = JSON.parse(
        await required("losetup", [
          "--json",
          "--list",
          "--output",
          "NAME,AUTOCLEAR,RO,OFFSET,SIZELIMIT",
          device,
        ]),
      ).loopdevices;
      if (
        !Array.isArray(detail) ||
        detail.length !== 1 ||
        detail[0].autoclear !== true ||
        detail[0].ro !== true ||
        Number(detail[0].offset) !== p.offset ||
        Number(detail[0].sizelimit) !== p.size
      )
        fail("boot_loop_scope_invalid");
      await publish(mount, "raw/" + p.name, "/output", files, metadata);
    }
    if (mounts.length !== 2) fail("boot_filesystems_missing");
    await writeFile("/output/files.json", JSON.stringify({ files, metadata }), {
      mode: 0o600,
      flag: "wx",
    });
  } finally {
    let cleaned = true;
    for (const mount of mounts.reverse())
      if ((await run("umount", [mount])).code !== 0) cleaned = false;
    const current = await run("losetup", [
      "--json",
      "--list",
      "--output",
      "NAME",
    ]);
    if (
      current.code !== 0 ||
      JSON.parse(current.stdout).loopdevices.some((v: { name: string }) =>
        loops.includes(v.name),
      )
    )
      cleaned = false;
    if (!cleaned) fail("boot_loop_cleanup_failed");
  }
}
async function squashfs(job: { path: string; prefix: string }) {
  await mkdir("/work/root", { recursive: true });
  await required(
    "unsquashfs",
    ["-pf", "/output/filesystem.pseudo", job.path],
    120000,
  );
  await required(
    "unsquashfs",
    [
      "-no-xattrs",
      "-no-progress",
      "-processors",
      "2",
      "-d",
      "/work/root",
      job.path,
    ],
    120000,
  );
  const files: FileFact[] = [],
    metadata: unknown[] = [];
  await publish("/work/root", job.prefix, "/output", files, metadata);
  await writeFile("/output/files.json", JSON.stringify({ files, metadata }), {
    mode: 0o600,
    flag: "wx",
  });
}
async function boot(job: { raw: string; timeout_ms: number }) {
  if (
    !Number.isSafeInteger(job.timeout_ms) ||
    job.timeout_ms < 30000 ||
    job.timeout_ms > 600000
  )
    fail("boot_deadline_invalid");
  await mkdir("/work", { recursive: true });
  const serial = await open("/output/serial.private.log", "wx", 0o600),
    started = Date.now();
  const child = spawn(
    "qemu-system-x86_64",
    [
      "-machine",
      "q35",
      "-accel",
      "tcg,thread=multi",
      "-cpu",
      "max",
      "-smp",
      "2",
      "-m",
      "2048",
      "-display",
      "none",
      "-monitor",
      "none",
      "-no-reboot",
      "-serial",
      "stdio",
      "-snapshot",
      "-drive",
      `file=${job.raw},format=raw,if=virtio,snapshot=on`,
      "-netdev",
      "user,id=guest,restrict=on,hostfwd=tcp:127.0.0.1:50000-:50000",
      "-device",
      "virtio-net-pci,netdev=guest",
    ],
    {
      stdio: ["ignore", serial.fd, serial.fd],
      env: { PATH: process.env.PATH, TMPDIR: "/work" },
    },
  );
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), job.timeout_ms + 10000);
  try {
    let version: unknown;
    while (Date.now() < started + job.timeout_ms && !exited) {
      const r = await run(
        "talosctl",
        [
          "--talosconfig",
          "/dev/null",
          "--nodes",
          "127.0.0.1",
          "--endpoints",
          "127.0.0.1",
          "version",
          "--insecure",
          "--json",
        ],
        8000,
      );
      if (r.code === 0) {
        try {
          version = JSON.parse(r.stdout);
          break;
        } catch {
          fail("boot_version_json_invalid");
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!version) fail("boot_maintenance_timeout");
    const facts: Record<string, unknown> = { version };
    for (const [key, args] of Object.entries({
      machine: ["get", "machinestatus", "--namespace", "runtime", "-o", "json"],
      extensions: [
        "get",
        "extensionstatus",
        "--namespace",
        "runtime",
        "-o",
        "json",
      ],
      schematic: [
        "get",
        "imagefactoryschematic",
        "--namespace",
        "runtime",
        "-o",
        "json",
      ],
    })) {
      facts[key] = await run(
        "talosctl",
        [
          "--talosconfig",
          "/dev/null",
          "--nodes",
          "127.0.0.1",
          "--endpoints",
          "127.0.0.1",
          ...args,
          "--insecure",
        ],
        15000,
      );
    }
    await writeFile(
      "/output/boot.private.json",
      JSON.stringify({ elapsed_ms: Date.now() - started, facts }),
      { mode: 0o600, flag: "wx" },
    );
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((r) => child.once("close", () => r())),
      new Promise<void>((r) => setTimeout(r, 3000)),
    ]);
    if (!exited) child.kill("SIGKILL");
    await serial.close();
  }
}
async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1024 ** 2) fail("boot_job_size_invalid");
  }
  const job = JSON.parse(raw) as Record<string, unknown>;
  if (job.mode === "filesystems") await filesystems(job as never);
  else if (job.mode === "squashfs") await squashfs(job as never);
  else if (job.mode === "boot") await boot(job as never);
  else fail("boot_tool_mode_invalid");
}
main().catch(async (error: unknown) => {
  await writeFile(
    "/output/failure.private.json",
    JSON.stringify({
      failed: true,
      code:
        error instanceof Error && /^boot_[a-z_]+$/.test(error.message)
          ? error.message
          : "boot_tool_failed",
    }),
    { mode: 0o600 },
  ).catch(() => {});
  process.exitCode = 1;
});
