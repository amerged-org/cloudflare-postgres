// SPDX-License-Identifier: Apache-2.0
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type DecipherGCM,
} from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  openSync,
  fstatSync,
  closeSync,
  constants,
} from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  InfrastructureBackupInput,
  InfrastructureBackupPreparedArtifact,
  type InfrastructureBackupArtifactIdentity,
} from "@pgcf/contracts/infrastructure-backups";
import { openTalosOperator } from "./talos-operator.ts";

const MAGIC = Buffer.from("PGCFINF1"),
  MAX_AAD = 16 * 1024,
  MAX_SPOOL = 1024 * 1024 * 1024;
export type PreparedArtifact = InfrastructureBackupPreparedArtifact & {
  private_file: string;
};
const preparedFiles = new WeakSet<PreparedArtifact>();
function fail(code: string): never {
  throw new Error(`infrastructure_backup_${code}`);
}
function selectedKey(value: string) {
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value)
    fail("key_invalid");
  return key;
}
function identity(
  artifact: InfrastructureBackupArtifactIdentity,
): InfrastructureBackupArtifactIdentity {
  return {
    id: artifact.id,
    kind: artifact.kind,
    day: artifact.day,
    region_id: artifact.region_id,
    source_id: artifact.source_id,
    node_id: artifact.node_id,
    node_uid: artifact.node_uid,
    cluster_uid: artifact.cluster_uid,
    material_revision: artifact.material_revision,
  };
}
function aad(
  metadata: Pick<
    PreparedArtifact,
    | keyof InfrastructureBackupArtifactIdentity
    | "run_id"
    | "kid"
    | "plaintext_sha256"
    | "plaintext_bytes"
  >,
) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      run_id: metadata.run_id,
      artifact_id: metadata.id,
      kind: metadata.kind,
      day: metadata.day,
      region_id: metadata.region_id,
      source_id: metadata.source_id,
      node_id: metadata.node_id,
      node_uid: metadata.node_uid,
      cluster_uid: metadata.cluster_uid,
      material_revision: metadata.material_revision,
      kid: metadata.kid,
      plaintext_sha256: metadata.plaintext_sha256,
      plaintext_bytes: metadata.plaintext_bytes,
    }),
  );
}
async function measureFile(path: string, limit: number, signal?: AbortSignal) {
  const checksum = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    signal?.throwIfAborted();
    bytes += chunk.length;
    if (bytes > limit) fail("source_limit");
    checksum.update(chunk);
  }
  if (bytes === 0) fail("source_empty");
  return { plaintext_sha256: checksum.digest("hex"), plaintext_bytes: bytes };
}

/** One bounded private workspace for the daily run; no plaintext survives successful preparation. */
export async function prepareDailyBackup(
  value: unknown,
  options: {
    request?: typeof fetch;
    signal?: AbortSignal;
    maxSpoolBytes?: number;
    kubectl?: string;
    talosctl?: string;
    openOperator?: typeof openTalosOperator;
  } = {},
) {
  const input = InfrastructureBackupInput.parse(value),
    key = selectedKey(input.encryption.key);
  const spool = options.maxSpoolBytes ?? MAX_SPOOL;
  if (
    !Number.isSafeInteger(spool) ||
    spool < MAX_AAD * 2 ||
    spool > MAX_SPOOL
  ) {
    key.fill(0);
    fail("spool_limit_invalid");
  }
  // AAD requires a plaintext hash before encryption. Bound both payload files, including envelope overhead.
  const perArtifactLimit = Math.floor((spool - MAX_AAD) / 2),
    artifacts: PreparedArtifact[] = [];
  let workspaceBytes = 0;
  const directory = await mkdtemp(join(tmpdir(), "pgcf-infra-backup-"));
  await chmod(directory, 0o700);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const artifact of artifacts) preparedFiles.delete(artifact);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    for (const artifact of input.artifacts) {
      options.signal?.throwIfAborted();
      const sourceLimit = Math.min(
        perArtifactLimit,
        Math.floor((spool - workspaceBytes - MAX_AAD) / 2),
      );
      if (sourceLimit < 1024) fail("workspace_limit");
      const limitCode =
        sourceLimit < perArtifactLimit ? "workspace_limit" : "source_limit";
      const artifactDirectory = join(directory, artifact.id);
      await mkdir(artifactDirectory, { mode: 0o700 });
      const plaintext = join(artifactDirectory, "source.private");
      let measured: { plaintext_sha256: string; plaintext_bytes: number };
      if (artifact.kind === "d1") {
        const signal = options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(300_000)])
          : AbortSignal.timeout(300_000);
        const response = await (options.request ?? fetch)(artifact.d1_url!, {
          redirect: "error",
          signal,
        });
        if (!response.ok || !response.body) fail("source_refused");
        const length = response.headers.get("content-length");
        if (length && /^\d+$/.test(length) && Number(length) > sourceLimit) {
          await response.body.cancel();
          fail(limitCode);
        }
        const checksum = createHash("sha256");
        let bytes = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > sourceLimit) {
              callback(new Error(`infrastructure_backup_${limitCode}`));
              return;
            }
            checksum.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(
            response.body as unknown as NodeReadableStream<Uint8Array>,
          ),
          meter,
          createWriteStream(plaintext, { flags: "wx", mode: 0o600 }),
          { signal },
        );
        if (bytes === 0) fail("source_empty");
        measured = {
          plaintext_sha256: checksum.digest("hex"),
          plaintext_bytes: bytes,
        };
      } else {
        const source = artifact.source!;
        const kubeconfig = join(artifactDirectory, "kubeconfig.private.yaml"),
          talosconfig = join(artifactDirectory, "talosconfig.private.yaml");
        await writeFile(kubeconfig, source.kubeconfig, {
          mode: 0o600,
          flag: "wx",
        });
        await writeFile(talosconfig, source.talosconfig, {
          mode: 0o600,
          flag: "wx",
        });
        const operatorURL = new URL(source.operator_url);
        operatorURL.protocol = "wss:";
        const outputDir = join(artifactDirectory, "operator");
        const session = await (options.openOperator ?? openTalosOperator)({
          nodeId: source.node_id,
          nodeUid: source.node_uid,
          nodeAddress: source.node_address,
          kubeconfig,
          talosconfig,
          ciliumImage: source.cilium_image,
          ciliumImageID: source.cilium_image_id,
          kubectl: options.kubectl ?? "/usr/local/bin/kubectl",
          talosctl: options.talosctl ?? "/usr/local/bin/talosctl",
          outputDir,
          timeoutSeconds: 1800,
          maxSnapshotBytes: sourceLimit,
          signal: options.signal,
          kubernetesRequest: {
            url: operatorURL.href,
            headers: { Authorization: `Bearer ${source.operator_token}` },
          },
          expectedBinding: source.binding,
        });
        try {
          await session.run(["etcd", "snapshot", "control.snapshot"]);
          await session.verify();
          const snapshot = join(outputDir, "control.snapshot"),
            snapshotStat = await stat(snapshot);
          if (!snapshotStat.isFile() || (snapshotStat.mode & 0o077) !== 0)
            fail("snapshot_file_invalid");
          measured = await measureFile(snapshot, sourceLimit, options.signal);
          await rename(snapshot, plaintext);
        } finally {
          await session.close();
        }
        await rm(outputDir, { recursive: true, force: true });
        await rm(kubeconfig);
        await rm(talosconfig);
      }
      const fields = {
        ...identity(artifact),
        run_id: input.run_id,
        kid: input.encryption.kid,
        ...measured,
      };
      const authenticated = aad(fields),
        nonce = randomBytes(12),
        prefix = Buffer.alloc(12);
      MAGIC.copy(prefix);
      prefix.writeUInt32BE(authenticated.length, 8);
      const header = Buffer.concat([prefix, authenticated, nonce]),
        encryptedPath = join(artifactDirectory, "encrypted.private");
      await writeFile(encryptedPath, header, { mode: 0o600, flag: "wx" });
      const checksum = createHash("sha256").update(header),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(authenticated);
      let encryptedBytes = header.length;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          encryptedBytes += chunk.length;
          checksum.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        createReadStream(plaintext),
        cipher,
        meter,
        createWriteStream(encryptedPath, { flags: "a", mode: 0o600 }),
        { signal: options.signal },
      );
      const tag = cipher.getAuthTag();
      await writeFile(encryptedPath, tag, { flag: "a" });
      encryptedBytes += tag.length;
      checksum.update(tag);
      await rm(plaintext);
      workspaceBytes += encryptedBytes;
      if (workspaceBytes > spool) fail("workspace_limit");
      const metadata: PreparedArtifact = Object.freeze({
        ...InfrastructureBackupPreparedArtifact.parse({
          ...fields,
          encrypted_sha256: checksum.digest("hex"),
          encrypted_bytes: encryptedBytes,
        }),
        private_file: encryptedPath,
      });
      artifacts.push(metadata);
      preparedFiles.add(metadata);
    }
    return { artifacts, close };
  } catch (error) {
    await close();
    if (
      error instanceof Error &&
      /^(?:infrastructure_backup|operator)_[a-z0-9_]+$/.test(error.message)
    )
      throw error;
    fail(options.signal?.aborted ? "aborted" : "source_failed");
  } finally {
    key.fill(0);
  }
}

/** Only preparation-owned file objects can be opened; API callers never supply a filesystem path. */
export function openPreparedArtifact(artifact: PreparedArtifact): Readable {
  if (!preparedFiles.has(artifact)) fail("not_prepared");
  const fd = openSync(
    artifact.private_file,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const info = fstatSync(fd);
  if (
    !info.isFile() ||
    (info.mode & 0o077) !== 0 ||
    info.size !== artifact.encrypted_bytes
  ) {
    closeSync(fd);
    fail("prepared_file_changed");
  }
  return createReadStream(artifact.private_file, { fd, autoClose: true });
}

/** Fully authenticates the R2 readback, hashes plaintext incrementally, and never emits or writes it. */
export async function verifyArtifactReadback(
  readable: Readable | ReadableStream<Uint8Array>,
  keyValue: string,
  metadata: InfrastructureBackupPreparedArtifact & { private_file?: string },
) {
  const expected = InfrastructureBackupPreparedArtifact.parse(
    Object.fromEntries(
      Object.entries(metadata).filter(([name]) => name !== "private_file"),
    ),
  );
  const key = selectedKey(keyValue),
    expectedAAD = aad(expected),
    encryptedHash = createHash("sha256"),
    plaintextHash = createHash("sha256");
  const stream =
    readable instanceof Readable
      ? readable
      : Readable.fromWeb(readable as unknown as NodeReadableStream<Uint8Array>);
  let encryptedBytes = 0,
    plaintextBytes = 0,
    header = Buffer.alloc(0),
    headerLength = 12,
    tail = Buffer.alloc(0);
  let decipher: DecipherGCM | undefined;
  const plain = (bytes: Buffer) => {
    plaintextBytes += bytes.length;
    if (plaintextBytes > expected.plaintext_bytes) fail("readback_failed");
    plaintextHash.update(bytes);
  };
  try {
    for await (const value of stream) {
      const incoming = value as Uint8Array;
      encryptedBytes += incoming.byteLength;
      encryptedHash.update(incoming);
      if (encryptedBytes > expected.encrypted_bytes) fail("readback_failed");
      for (let offset = 0; offset < incoming.byteLength; offset += 64 * 1024) {
        let chunk = Buffer.from(
          incoming.buffer,
          incoming.byteOffset + offset,
          Math.min(64 * 1024, incoming.byteLength - offset),
        );
        while (!decipher && chunk.length) {
          const take = Math.min(headerLength - header.length, chunk.length);
          header = Buffer.concat([header, chunk.subarray(0, take)]);
          chunk = chunk.subarray(take);
          if (header.length !== headerLength) continue;
          if (headerLength === 12) {
            if (!header.subarray(0, 8).equals(MAGIC)) fail("readback_failed");
            const length = header.readUInt32BE(8);
            if (length < 2 || length > MAX_AAD) fail("readback_failed");
            headerLength = 12 + length + 12;
          } else {
            const authenticated = header.subarray(12, -12);
            if (!authenticated.equals(expectedAAD)) fail("identity_mismatch");
            decipher = createDecipheriv(
              "aes-256-gcm",
              key,
              header.subarray(-12),
            );
            decipher.setAAD(authenticated);
          }
        }
        if (!decipher || chunk.length === 0) continue;
        if (chunk.length > 16) {
          if (tail.length) plain(decipher.update(tail));
          plain(decipher.update(chunk.subarray(0, -16)));
          tail = Buffer.from(chunk.subarray(-16));
        } else {
          const pending = Buffer.concat([tail, chunk]);
          if (pending.length > 16)
            plain(decipher.update(pending.subarray(0, -16)));
          tail = Buffer.from(pending.subarray(-16));
        }
      }
    }
    if (
      !decipher ||
      tail.length !== 16 ||
      encryptedBytes !== expected.encrypted_bytes
    )
      fail("readback_failed");
    const encryptedSHA = encryptedHash.digest("hex");
    if (encryptedSHA !== expected.encrypted_sha256) fail("readback_failed");
    decipher.setAuthTag(tail);
    plain(decipher.final());
    const plaintextSHA = plaintextHash.digest("hex");
    if (
      plaintextSHA !== expected.plaintext_sha256 ||
      plaintextBytes !== expected.plaintext_bytes
    )
      fail("readback_failed");
    return {
      plaintext_sha256: plaintextSHA,
      plaintext_bytes: plaintextBytes,
      encrypted_sha256: encryptedSHA,
      encrypted_bytes: encryptedBytes,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "infrastructure_backup_identity_mismatch"
    )
      throw error;
    fail("readback_failed");
  } finally {
    key.fill(0);
    stream.destroy();
  }
}
