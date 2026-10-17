// SPDX-License-Identifier: Apache-2.0
// Node image driver. Usage (from the repository root):
//   node infra/node-image/node-image.ts resolve [--work DIR]
//   node infra/node-image/node-image.ts fetch   [--work DIR]
//   node infra/node-image/node-image.ts build   [--work DIR] [--binaries DIR] [--release NAME]
// The work directory defaults to .local/node-image; with Docker in a VM it must be a path the VM
// shares (Colima and Docker Desktop share the home directory).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  aptListName,
  compareInstalled,
  debFileName,
  debianRepositories,
  installedFromManifest,
  lockPackages,
  parsePackagesIndex,
  snapshotEpoch,
  validateLock,
  type LockedPackage,
  type PackageLock,
} from "./lock.ts";

const here = resolve(import.meta.dirname);
const lockPath = join(here, "packages.lock.json");
const releasePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`--${name} needs a value`);
  return value;
}

function run(command: string, args: string[], options: { quiet?: boolean } = {}): void {
  const result = spawnSync(command, args, { stdio: options.quiet ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} exited with ${result.status ?? result.signal}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function readLock(): Promise<PackageLock> {
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as PackageLock;
  validateLock(lock);
  const keySha = await sha256File(join(here, lock.pgdg.key.path));
  if (keySha !== lock.pgdg.key.sha256) throw new Error("the PGDG key does not match its locked sha256");
  return lock;
}

// Download one locked file and keep it only if its size and sha256 match.
async function download(entry: LockedPackage, directory: string): Promise<void> {
  const target = join(directory, debFileName(entry));
  if (existsSync(target)) {
    const present = await stat(target);
    if (present.size === entry.size && (await sha256File(target)) === entry.sha256) return;
    await rm(target);
  }
  const partial = `${target}.partial`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(entry.url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      if (!new URL(response.url).protocol.startsWith("https")) throw new Error("redirected off HTTPS");
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial, { mode: 0o644 }));
      const size = (await stat(partial)).size;
      if (size !== entry.size) throw new Error(`size ${size} instead of ${entry.size}`);
      if ((await sha256File(partial)) !== entry.sha256) throw new Error("sha256 mismatch");
      await rename(partial, target);
      return;
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true });
      if (attempt < 3) await new Promise((done) => setTimeout(done, attempt * 5_000));
    }
  }
  throw new Error(`${entry.name} ${entry.version}: ${String(lastError)}`);
}

async function downloadAll(entries: LockedPackage[], directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const wanted = new Set(entries.map(debFileName));
  for (const name of await readdir(directory)) {
    if (!wanted.has(name)) await rm(join(directory, name), { recursive: true, force: true });
  }
  const queue = [...entries];
  const workers = Array.from({ length: 6 }, async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) await download(entry, directory);
  });
  await Promise.all(workers);
}

function builderTag(lock: PackageLock): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(lock.builder));
  hash.update(lock.debian.snapshot);
  return `pgcf-node-image-builder:${hash.digest("hex").slice(0, 16)}`;
}

function buildBuilder(lock: PackageLock): string {
  const tag = builderTag(lock);
  run("docker", [
    "build",
    "--build-arg", `PGCF_BUILDER_BASE=${lock.builder.base}`,
    "--build-arg", `PGCF_DEBIAN_SNAPSHOT=${lock.debian.snapshot}`,
    "--build-arg", `PGCF_MKOSI_REPOSITORY=${lock.builder.mkosi.repository}`,
    "--build-arg", `PGCF_MKOSI_COMMIT=${lock.builder.mkosi.commit}`,
    "--tag", tag,
    join(here, "builder"),
  ]);
  return tag;
}

function runBuilder(
  tag: string,
  lock: PackageLock,
  mode: "resolve" | "build",
  mounts: { debs: string; out: string; binaries?: string },
  release: string,
): void {
  run("docker", [
    "run", "--rm", "--privileged",
    "--volume", `${here}:/src:ro`,
    "--volume", `${mounts.debs}:/debs:ro`,
    ...(mounts.binaries ? ["--volume", `${mounts.binaries}:/binaries:ro`] : []),
    "--volume", `${mounts.out}:/out`,
    "--env", `PGCF_DEBIAN_SNAPSHOT=${lock.debian.snapshot}`,
    "--env", `PGCF_SOURCE_DATE_EPOCH=${snapshotEpoch(lock.debian.snapshot)}`,
    "--env", `PGCF_RELEASE=${release}`,
    "--env", `PGCF_PGDG_URL=${lock.pgdg.url}`,
    "--env", `PGCF_PGDG_SUITE=${lock.pgdg.suite}`,
    tag, mode,
  ]);
}

async function resolveLock(work: string): Promise<void> {
  const lock = await readLock();
  const extraDebs = join(work, "extra-debs");
  const out = join(work, "resolve");
  await downloadAll(lock.extra, extraDebs);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const tag = buildBuilder(lock);
  runBuilder(tag, lock, "resolve", { debs: extraDebs, out }, "resolve");

  const installed = installedFromManifest(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")));
  const listNames = new Set(await readdir(join(out, "lists")));
  const indexes = [];
  for (const repository of debianRepositories(lock)) {
    const name = aptListName(repository);
    if (!listNames.has(name)) throw new Error(`missing signed index ${name}`);
    indexes.push({ repository, records: parsePackagesIndex(await readFile(join(out, "lists", name), "utf8")) });
  }
  const packages = lockPackages(installed, indexes, lock.extra);

  // apt verified every download against the signed indexes; check that the lock says the same.
  const downloaded = new Map<string, string>();
  for (const line of (await readFile(join(out, "downloaded.sha256"), "utf8")).split("\n")) {
    const [sha, path] = line.trim().split(/\s+/);
    if (sha && path) downloaded.set(path.split("/").pop()!, sha);
  }
  for (const entry of packages) {
    const sha = downloaded.get(entry.url.split("/").pop()!) ?? downloaded.get(debFileName(entry));
    if (sha && sha !== entry.sha256) throw new Error(`${entry.name}: downloaded file differs from its index`);
  }

  const updated: PackageLock = { ...lock, packages };
  validateLock(updated);
  await writeFile(lockPath, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`locked ${packages.length} packages at snapshot ${lock.debian.snapshot}`);
}

async function fetchLocked(work: string): Promise<PackageLock> {
  const lock = await readLock();
  if (lock.packages.length === 0) throw new Error("the lock lists no packages; run resolve first");
  await downloadAll(lock.packages, join(work, "debs"));
  console.log(`verified ${lock.packages.length} locked packages`);
  return lock;
}

async function buildImage(work: string, binaries: string | undefined, release: string): Promise<void> {
  if (!releasePattern.test(release)) throw new Error("invalid release name");
  const lock = await fetchLocked(work);
  const out = join(work, "out");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const tag = buildBuilder(lock);
  runBuilder(tag, lock, "build", { debs: join(work, "debs"), out, binaries }, release);

  const installed = installedFromManifest(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")));
  const problems = compareInstalled(lock, installed);
  if (problems.length > 0) throw new Error(`image differs from the lock:\n${problems.join("\n")}`);

  // zstd, because the Contabo rescue system that installs the image has no xz (Stage 1). Its
  // output does not depend on the number of threads, so every builder writes the same bytes.
  const raw = join(out, "pgcf-node.raw");
  const zst = `${raw}.zst`;
  run("docker", [
    "run", "--rm", "--entrypoint", "zstd",
    "--volume", `${out}:/out`, tag, "--quiet", "-19", "-T0", "--keep", "--force", "/out/pgcf-node.raw",
  ]);
  const summary = {
    release,
    debian_snapshot: lock.debian.snapshot,
    lock_sha256: await sha256File(lockPath),
    raw: { sha256: await sha256File(raw), size: (await stat(raw)).size },
    zst: { sha256: await sha256File(zst), size: (await stat(zst)).size },
  };
  await writeFile(join(out, "pgcf-node.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(
    join(out, "SHA256SUMS"),
    `${summary.raw.sha256}  pgcf-node.raw\n${summary.zst.sha256}  pgcf-node.raw.zst\n`,
  );
  console.log(JSON.stringify(summary));
}

const command = process.argv[2];
const work = resolve(option("work", join(here, "..", "..", ".local", "node-image"))!);
await mkdir(work, { recursive: true });
switch (command) {
  case "resolve":
    await resolveLock(work);
    break;
  case "fetch":
    await fetchLocked(work);
    break;
  case "build": {
    const binaries = option("binaries");
    await buildImage(work, binaries ? resolve(binaries) : undefined, option("release", "local")!);
    break;
  }
  default:
    console.error("usage: node-image.ts resolve|fetch|build [--work DIR] [--binaries DIR] [--release NAME]");
    process.exit(2);
}
