// SPDX-License-Identifier: Apache-2.0
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, link, mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ControlCell, ControlSnapshot } from "./control-snapshot.ts";
import { restoreControlSnapshot } from "./control-snapshot.ts";

export interface RecoveryKeyrings {
  ROLE_CREDENTIAL_KEYS: string;
  ALLOWANCE_FENCE_KEYS: string;
  USAGE_ARCHIVE_KEYS?: string;
}
interface Ring {
  active: string;
  keys: Record<string, string>;
}
const maximum = 16 * 1024 * 1024;
const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const fail = () => new Error("control_recovery_failed");
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const codecs = {
  role: "database-role-credential/v1",
  fence: "allowance-fence/v1",
};
function binary(value: unknown, bytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw fail();
  const result = Buffer.from(value, "base64url");
  if (
    result.toString("base64url") !== value ||
    (bytes !== undefined && result.length !== bytes)
  )
    throw fail();
  return result;
}
function keyring(value: string): Ring {
  const v: unknown = JSON.parse(value);
  if (
    !object(v) ||
    Object.keys(v).length !== 2 ||
    typeof v.active !== "string" ||
    !object(v.keys) ||
    !Object.hasOwn(v.keys, v.active) ||
    Object.keys(v.keys).length < 1 ||
    Object.keys(v.keys).length > 8
  )
    throw fail();
  for (const [name, key] of Object.entries(v.keys)) {
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name)) throw fail();
    binary(key, 32);
  }
  return v as unknown as Ring;
}
async function privateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw fail();
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw fail();
}
export async function readRecoveryPrivate(
  path: string,
  bound = maximum,
): Promise<Buffer> {
  if (!isAbsolute(path)) throw fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size < 1 ||
      stat.size > bound
    )
      throw fail();
    const buffer = Buffer.alloc(stat.size);
    let at = 0;
    while (at < buffer.length) {
      const read = await file.read(buffer, at, buffer.length - at, at);
      if (!read.bytesRead) throw fail();
      at += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await file.read(extra, 0, 1, at)).bytesRead) throw fail();
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw fail();
    return buffer;
  } finally {
    await file.close();
  }
}
async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw fail();
  }
  throw fail();
}
async function write(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function publishControlSnapshot(
  snapshot: ControlSnapshot,
  path: string,
): Promise<void> {
  let working: string | null = null;
  try {
    await privateDirectory(dirname(path));
    await absent(path);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    if (bytes.length > 8 * 1024 * 1024) throw fail();
    working = await mkdtemp(join(dirname(path), ".pgcf-recovery-"));
    const temporary = join(working, "snapshot");
    await write(temporary, bytes);
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } catch {
    throw fail();
  } finally {
    if (working) await rm(working, { recursive: true, force: true });
  }
}
async function recoveryKey(
  path: string,
  keyrings?: RecoveryKeyrings,
): Promise<Buffer> {
  const result = binary(
    (await readRecoveryPrivate(path, 128)).toString("utf8").trim(),
    32,
  );
  if (keyrings)
    for (const value of Object.values(keyrings))
      for (const key of Object.values(keyring(value).keys))
        if (result.equals(binary(key, 32))) throw fail();
  return result;
}
function rows(
  snapshot: ControlSnapshot,
  name: string,
): Record<string, string | number | null>[] {
  const table = snapshot.tables.find((t) => t.name === name);
  if (!table) throw fail();
  return table.rows.map((cells) =>
    Object.fromEntries(
      table.columns.map((column, i) => {
        const cell: ControlCell | undefined = cells[i];
        if (!cell) throw fail();
        return [
          column,
          cell.type === "integer" ? Number(cell.value) : cell.value,
        ];
      }),
    ),
  );
}
function clear(
  ring: Ring,
  keyId: unknown,
  iv: unknown,
  ciphertext: unknown,
  context: unknown,
): string {
  if (typeof keyId !== "string" || !Object.hasOwn(ring.keys, keyId))
    throw fail();
  const encrypted = binary(ciphertext);
  if (encrypted.length < 16 || encrypted.length > 512) throw fail();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    binary(ring.keys[keyId], 32),
    binary(iv, 12),
  );
  decipher.setAAD(Buffer.from(JSON.stringify(context)));
  decipher.setAuthTag(encrypted.subarray(-16));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat([
      decipher.update(encrypted.subarray(0, -16)),
      decipher.final(),
    ]),
  );
}
function verifyCustody(snapshot: ControlSnapshot, keyrings: RecoveryKeyrings) {
  if (
    !object(keyrings) ||
    ![2, 3].includes(Object.keys(keyrings).length) ||
    !Object.keys(keyrings).every((name) =>
      [
        "ROLE_CREDENTIAL_KEYS",
        "ALLOWANCE_FENCE_KEYS",
        "USAGE_ARCHIVE_KEYS",
      ].includes(name),
    ) ||
    typeof keyrings.ROLE_CREDENTIAL_KEYS !== "string" ||
    typeof keyrings.ALLOWANCE_FENCE_KEYS !== "string"
  )
    throw fail();
  if (Object.hasOwn(keyrings, "USAGE_ARCHIVE_KEYS")) {
    if (typeof keyrings.USAGE_ARCHIVE_KEYS !== "string") throw fail();
    keyring(keyrings.USAGE_ARCHIVE_KEYS);
  }
  const roles = keyring(keyrings.ROLE_CREDENTIAL_KEYS),
    fences = keyring(keyrings.ALLOWANCE_FENCE_KEYS),
    roleRows = rows(snapshot, "database_roles"),
    credentials = rows(snapshot, "role_credentials"),
    receipts = rows(snapshot, "allowance_reservations");
  for (const credential of credentials) {
    const role = roleRows.find((r) => r.id === credential.role_id);
    if (!role || typeof credential.encrypted_json !== "string") throw fail();
    const encrypted: unknown = JSON.parse(credential.encrypted_json);
    if (
      !object(encrypted) ||
      encrypted.schemaVersion !== 1 ||
      Object.keys(encrypted).length !== 4
    )
      throw fail();
    const value = clear(
      roles,
      encrypted.keyId,
      encrypted.iv,
      encrypted.ciphertext,
      {
        version: codecs.role,
        organizationId: role.organization_id,
        projectId: role.project_id,
        environmentId: role.environment_id,
        regionId: role.region_id,
        specRevision: role.spec_revision,
        specHash: role.spec_hash,
        clusterUid: role.cluster_uid,
        roleId: role.id,
        roleName: role.name,
        credentialRevision: credential.credential_revision,
      },
    );
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw fail();
  }
  for (const receipt of receipts) {
    const value = clear(
      fences,
      receipt.fence_key_version,
      receipt.fence_iv,
      receipt.fence_ciphertext,
      {
        version: codecs.fence,
        reservationId: receipt.id,
        environmentId: receipt.environment_id,
        regionId: receipt.region_id,
        specHash: receipt.spec_hash,
      },
    );
    if (
      !/^cprsv_[A-Za-z0-9_-]{43}$/.test(value) ||
      digest(value) !== receipt.fence_token_hash
    )
      throw fail();
  }
  return {
    roleCredentials: credentials.length,
    allowanceFences: receipts.length,
  };
}
function associated(header: unknown): Buffer {
  return Buffer.from(JSON.stringify(header));
}
export async function createRecoveryBundle(input: {
  snapshot: ControlSnapshot;
  keyrings: RecoveryKeyrings;
  recoveryKeyFile: string;
  archivePath: string;
  migrationDirectory: string;
}): Promise<{ status: "sealed"; sha256: string; bytes: number }> {
  let work: string | null = null;
  try {
    await privateDirectory(dirname(input.archivePath));
    await absent(input.archivePath);
    const custody = verifyCustody(input.snapshot, input.keyrings),
      key = await recoveryKey(input.recoveryKeyFile, input.keyrings);
    work = await mkdtemp(join(dirname(input.archivePath), ".pgcf-recovery-"));
    await restoreControlSnapshot(
      input.snapshot,
      join(work, "validation.sqlite"),
      input.migrationDirectory,
    );
    const plaintext = Buffer.from(
      JSON.stringify({
        snapshot: input.snapshot,
        keyrings: input.keyrings,
        codecs,
      }),
    );
    if (plaintext.length > 8 * 1024 * 1024) throw fail();
    const header = {
      domain: "pgcf-control-recovery",
      version: 1,
      bundleId: randomUUID(),
      source: input.snapshot.source,
    };
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(associated(header));
    const content = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const bytes = Buffer.from(
      JSON.stringify({
        ...header,
        iv: iv.toString("base64url"),
        ciphertext: content.toString("base64url"),
      }),
    );
    if (bytes.length > maximum) throw fail();
    const temporary = join(work, "bundle");
    await write(temporary, bytes);
    await link(temporary, input.archivePath);
    await syncDirectory(dirname(input.archivePath));
    void custody;
    return { status: "sealed", sha256: digest(bytes), bytes: bytes.length };
  } catch {
    throw fail();
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}
export async function restoreRecoveryBundle(input: {
  archivePath: string;
  recoveryKeyFile: string;
  targetDirectory: string;
  migrationDirectory: string;
  expectedSource: ControlSnapshot["source"];
}): Promise<{
  status: "verified_offline";
  tables: number;
  rows: number;
  roleCredentials: number;
  allowanceFences: number;
  activationSupported: false;
}> {
  let work: string | null = null;
  try {
    await privateDirectory(dirname(input.targetDirectory));
    await absent(input.targetDirectory);
    const bytes = await readRecoveryPrivate(input.archivePath),
      envelope: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !object(envelope) ||
      Object.keys(envelope).length !== 6 ||
      envelope.domain !== "pgcf-control-recovery" ||
      envelope.version !== 1 ||
      typeof envelope.bundleId !== "string" ||
      !uuid.test(envelope.bundleId) ||
      !object(envelope.source) ||
      envelope.source.installationId !== input.expectedSource.installationId ||
      envelope.source.databaseId !== input.expectedSource.databaseId
    )
      throw fail();
    const header = {
      domain: envelope.domain,
      version: envelope.version,
      bundleId: envelope.bundleId,
      source: envelope.source,
    };
    const key = await recoveryKey(input.recoveryKeyFile),
      encrypted = binary(envelope.ciphertext);
    if (encrypted.length < 16 || encrypted.length > maximum) throw fail();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      binary(envelope.iv, 12),
    );
    decipher.setAAD(associated(header));
    decipher.setAuthTag(encrypted.subarray(-16));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(0, -16)),
      decipher.final(),
    ]);
    if (plaintext.length > 8 * 1024 * 1024) throw fail();
    const payload: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
    if (
      !object(payload) ||
      Object.keys(payload).length !== 3 ||
      JSON.stringify(payload.codecs) !== JSON.stringify(codecs) ||
      !object(payload.snapshot) ||
      JSON.stringify(payload.snapshot.source) !==
        JSON.stringify(envelope.source)
    )
      throw fail();
    const snapshot = payload.snapshot as unknown as ControlSnapshot,
      keyrings = payload.keyrings as RecoveryKeyrings;
    const custody = verifyCustody(snapshot, keyrings);
    await recoveryKey(input.recoveryKeyFile, keyrings);
    work = await mkdtemp(
      join(dirname(input.targetDirectory), ".pgcf-recovery-"),
    );
    const result = await restoreControlSnapshot(
      snapshot,
      join(work, "control.sqlite"),
      input.migrationDirectory,
    );
    await write(join(work, "keyrings.json"), JSON.stringify(keyrings));
    await write(
      join(work, "manifest.json"),
      JSON.stringify({
        version: 1,
        bundleId: envelope.bundleId,
        source: envelope.source,
        snapshotSha256: snapshot.sha256,
        codecs,
        ...result,
        ...custody,
        activationSupported: false,
        recoveryFencesImplemented: false,
      }),
    );
    await syncDirectory(work);
    // Exclusive directory reservation closes the check/rename overwrite race.
    // A crash can leave an incomplete private directory; only its last-written
    // manifest is a completion marker. An existing directory is never adopted.
    await mkdir(input.targetDirectory, { mode: 0o700 });
    await link(
      join(work, "control.sqlite"),
      join(input.targetDirectory, "control.sqlite"),
    );
    await link(
      join(work, "keyrings.json"),
      join(input.targetDirectory, "keyrings.json"),
    );
    await syncDirectory(input.targetDirectory);
    await link(
      join(work, "manifest.json"),
      join(input.targetDirectory, "manifest.json"),
    );
    await syncDirectory(input.targetDirectory);
    await syncDirectory(dirname(input.targetDirectory));
    return {
      status: "verified_offline",
      tables: result.tables,
      rows: result.rows,
      ...custody,
      activationSupported: false,
    };
  } catch {
    throw fail();
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}
