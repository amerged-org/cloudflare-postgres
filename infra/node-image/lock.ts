// SPDX-License-Identifier: Apache-2.0
// The package lock: every .deb in the node image with its version, URL, size and sha256.

export interface LockedPackage {
  name: string;
  version: string;
  architecture: string;
  url: string;
  sha256: string;
  size: number;
}

export interface PackageLock {
  builder: {
    base: string;
    mkosi: { repository: string; tag: string; commit: string };
  };
  debian: { snapshot: string };
  pgdg: {
    url: string;
    suite: string;
    key: { path: string; sha256: string; fingerprint: string };
  };
  extra: LockedPackage[];
  packages: LockedPackage[];
}

export interface IndexRecord {
  name: string;
  version: string;
  architecture: string;
  filename: string;
  sha256: string;
  size: number;
}

export interface Repository {
  // Base URL that the index's Filename fields are relative to, without a trailing slash.
  base: string;
  suite: string;
}

export interface InstalledPackage {
  name: string;
  version: string;
  architecture: string;
}

const snapshotPattern = /^[0-9]{8}T[0-9]{6}Z$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const packageNamePattern = /^[a-z0-9][a-z0-9+.-]+$/;
const versionPattern = /^[A-Za-z0-9.+~:-]+$/;
const architecturePattern = /^(?:amd64|all)$/;

export function debianRepositories(lock: PackageLock): Repository[] {
  const snapshot = lock.debian.snapshot;
  const main = `https://snapshot.debian.org/archive/debian/${snapshot}`;
  return [
    {
      base: `https://snapshot.debian.org/archive/debian-security/${snapshot}`,
      suite: "trixie-security",
    },
    { base: main, suite: "trixie-updates" },
    { base: main, suite: "trixie" },
    { base: lock.pgdg.url.replace(/\/+$/, ""), suite: lock.pgdg.suite },
  ];
}

// apt's URItoFileName: drop the scheme, quote reserved characters, turn "/" into "_".
export function aptListName(repository: Repository): string {
  const uri = `${repository.base}/dists/${repository.suite}/main/binary-amd64/Packages`;
  const withoutScheme = uri.replace(/^[a-z]+:\/\//, "");
  let quoted = "";
  for (const character of withoutScheme) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code >= 0x7f || '\\|{}[]<>"^~_=!@#$%^&*'.includes(character)) {
      quoted += `%${code.toString(16).padStart(2, "0")}`;
    } else {
      quoted += character;
    }
  }
  return quoted.replaceAll("/", "_");
}

export function parsePackagesIndex(text: string): IndexRecord[] {
  const records: IndexRecord[] = [];
  for (const stanza of text.split(/\n\s*\n/)) {
    if (stanza.trim() === "") continue;
    const fields = new Map<string, string>();
    for (const line of stanza.split("\n")) {
      if (line === "" || line.startsWith(" ") || line.startsWith("\t")) continue;
      const colon = line.indexOf(":");
      if (colon <= 0) throw new Error(`malformed index line: ${line.slice(0, 80)}`);
      fields.set(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    const name = fields.get("Package");
    const version = fields.get("Version");
    const architecture = fields.get("Architecture");
    const filename = fields.get("Filename");
    const sha256 = fields.get("SHA256");
    const size = fields.get("Size");
    if (!name || !version || !architecture || !filename || !sha256 || !size) {
      throw new Error(`incomplete index stanza for ${name ?? "unknown package"}`);
    }
    records.push({
      name,
      version,
      architecture,
      filename,
      sha256,
      size: Number(size),
    });
  }
  return records;
}

export function key(item: InstalledPackage): string {
  return `${item.name} ${item.version} ${item.architecture}`;
}

// Map every installed package to exactly one downloadable, checksummed file.
export function lockPackages(
  installed: InstalledPackage[],
  indexes: { repository: Repository; records: IndexRecord[] }[],
  extra: LockedPackage[],
): LockedPackage[] {
  const available = new Map<string, LockedPackage>();
  for (const { repository, records } of indexes) {
    for (const record of records) {
      const entry: LockedPackage = {
        name: record.name,
        version: record.version,
        architecture: record.architecture,
        url: `${repository.base}/${record.filename}`,
        sha256: record.sha256,
        size: record.size,
      };
      const existing = available.get(key(entry));
      if (existing && (existing.sha256 !== entry.sha256 || existing.size !== entry.size)) {
        throw new Error(`${key(entry)} differs between ${existing.url} and ${entry.url}`);
      }
      if (!existing) available.set(key(entry), entry);
    }
  }
  for (const entry of extra) available.set(key(entry), entry);

  const locked: LockedPackage[] = [];
  const missing: string[] = [];
  for (const item of installed) {
    const entry = available.get(key(item));
    if (entry) locked.push(entry);
    else missing.push(key(item));
  }
  if (missing.length > 0) {
    throw new Error(`no signed index lists: ${missing.join(", ")}`);
  }
  return locked.sort((a, b) => key(a).localeCompare(key(b)));
}

// The built image must hold exactly the locked set: nothing missing, nothing added, no other version.
export function compareInstalled(
  lock: PackageLock,
  installed: InstalledPackage[],
): string[] {
  const expected = new Set(lock.packages.map(key));
  const actual = new Set(installed.map(key));
  const problems: string[] = [];
  for (const item of expected) if (!actual.has(item)) problems.push(`missing ${item}`);
  for (const item of actual) if (!expected.has(item)) problems.push(`unlocked ${item}`);
  return problems.sort();
}

export function installedFromManifest(manifest: unknown): InstalledPackage[] {
  const packages = (manifest as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) throw new Error("manifest has no package list");
  return packages.map((item: unknown) => {
    const { type, name, version, architecture } = item as Record<string, unknown>;
    if (type !== "deb" || typeof name !== "string" || typeof version !== "string" || typeof architecture !== "string") {
      throw new Error("manifest package entry is not a deb with name, version and architecture");
    }
    return { name, version, architecture };
  });
}

export function snapshotEpoch(snapshot: string): number {
  const match = /^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$/.exec(snapshot);
  if (!match) throw new Error(`invalid snapshot ${snapshot}`);
  const [, year, month, day, hour, minute, second] = match.map(Number) as number[];
  return Date.UTC(year!, month! - 1, day!, hour!, minute!, second!) / 1000;
}

function checkPackage(entry: LockedPackage, where: string): void {
  if (!packageNamePattern.test(entry.name)) throw new Error(`${where}: invalid name ${entry.name}`);
  if (!versionPattern.test(entry.version)) throw new Error(`${where}: invalid version of ${entry.name}`);
  if (!architecturePattern.test(entry.architecture)) {
    throw new Error(`${where}: invalid architecture of ${entry.name}`);
  }
  if (!entry.url.startsWith("https://")) throw new Error(`${where}: ${entry.name} is not fetched over HTTPS`);
  if (!sha256Pattern.test(entry.sha256)) throw new Error(`${where}: invalid sha256 of ${entry.name}`);
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
    throw new Error(`${where}: invalid size of ${entry.name}`);
  }
}

export function validateLock(lock: PackageLock): void {
  if (!/@sha256:[0-9a-f]{64}$/.test(lock.builder.base)) throw new Error("builder base must be pinned by digest");
  if (!/^[0-9a-f]{40}$/.test(lock.builder.mkosi.commit)) throw new Error("mkosi must be pinned to a commit");
  if (!snapshotPattern.test(lock.debian.snapshot)) throw new Error("invalid Debian snapshot");
  if (!lock.pgdg.url.startsWith("https://")) throw new Error("PGDG must be fetched over HTTPS");
  if (!sha256Pattern.test(lock.pgdg.key.sha256)) throw new Error("invalid PGDG key sha256");
  for (const entry of lock.extra) checkPackage(entry, "extra");
  const seen = new Set<string>();
  for (const entry of lock.packages) {
    checkPackage(entry, "packages");
    if (seen.has(entry.name)) throw new Error(`package ${entry.name} is locked twice`);
    seen.add(entry.name);
  }
}

export function debFileName(entry: LockedPackage): string {
  return `${entry.name}_${entry.version.replaceAll(":", "%3a")}_${entry.architecture}.deb`;
}
