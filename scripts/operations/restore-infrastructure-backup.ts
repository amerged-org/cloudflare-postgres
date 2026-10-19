// SPDX-License-Identifier: Apache-2.0
// Opens a daily infrastructure backup (ULTRA plan 9.10, gate G6): decrypts a PGCFINF1 artifact of
// the control database with the offline key, verifies it, and imports it into a scratch D1
// database. The layout it reads is the one in docs/operations/infrastructure-backups.md, written by
// apps/api/src/domain/infrastructure-backup-envelope.ts; this tool does not share that code, so a
// restore needs nothing of the Worker.
//
//   node scripts/operations/restore-infrastructure-backup.ts decrypt --input FILE --output FILE
//        --keys-env NAME [--receipt FILE]
//   node scripts/operations/restore-infrastructure-backup.ts import --input FILE --database NAME
//        --keys-env NAME [--receipt FILE] [--wrangler COMMAND]
//
//   --input      the R2 object, downloaded: `wrangler r2 object get BUCKET/KEY --file FILE --remote`.
//   --keys-env   the NAME of an environment variable that holds the keyring, the same JSON as the
//                Worker secret CREDENTIAL_KEYS: {"active":"v1","keys":{"v1":"<base64url, 32 bytes>"}}.
//                Only the version the artifact names is used, whichever is active. The value is read
//                in memory; it is never an argument, never printed, and never passed on to wrangler.
//   --receipt    the answer of `GET /v1/infrastructure-backups`, saved. The artifact is also held
//                to the receipt the API stored (run, key version, hashes, sizes, object key). It is
//                optional because a lost control database takes the receipt with it; the artifact
//                authenticates its own identity and plaintext hash either way.
//   decrypt      writes the verified SQL to --output (mode 0600; an existing file is never replaced).
//   import       decrypts into a private temporary file, imports it into the scratch D1 database
//                named by --database with `wrangler d1 execute --remote --file`, and removes the file.
//                It refuses the database the artifact was exported from, a database that has tables,
//                and a name that is not exactly one database. Wrangler's own login or
//                CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID authenticate it (D1 edit).
//   --wrangler   the wrangler executable (default: wrangler on PATH).
//
// Nothing of the SQL is printed, and neither is wrangler's text about the import, which can quote
// it: a failed import reports wrangler's exit code; decrypt to a file and run wrangler by hand to
// read its message. The output holds no database ID except the scratch database's own.
// SIGINT, SIGTERM and SIGHUP stop wrangler, remove the decrypted SQL and end the run with exit
// code 128 plus the signal's number; a run killed with SIGKILL leaves its files behind.
import { execFile, type ChildProcess } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  hkdfSync,
  type DecipherGCM,
} from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import {
  link,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { base64urlToBytes } from "../../packages/contracts/src/encoding.ts";
import { InfrastructureBackupRunStatus } from "../../packages/contracts/src/infrastructure-backups.ts";

const MAGIC = Buffer.from("PGCFINF1"),
  MAX_AAD = 16 * 1024,
  NONCE_BYTES = 12,
  TAG_BYTES = 16,
  MAX_PLAINTEXT = 1024 * 1024 * 1024,
  HKDF_SALT = "pgcf-infrastructure-backup-v1",
  KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/,
  VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/,
  UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  SHA256 = /^[0-9a-f]{64}$/;
const USAGE =
  "usage: restore-infrastructure-backup.ts decrypt --input FILE --output FILE --keys-env NAME [--receipt FILE]\n" +
  "       restore-infrastructure-backup.ts import --input FILE --database NAME --keys-env NAME [--receipt FILE] [--wrangler COMMAND]";

/**
 * What holds decrypted SQL while the tool runs: a signal must remove it before the process ends,
 * and a `finally` block does not run when it does. Only a path this run created is registered.
 */
const plaintextPaths = new Set<string>();
/** The wrangler processes of this run, which a signal stops too. */
const children = new Set<ChildProcess>();

/**
 * Ends the run on SIGINT, SIGTERM or SIGHUP (Ctrl-C, a kill, a closed terminal): stops wrangler,
 * removes the decrypted SQL and exits with the signal's conventional code. SIGKILL cannot be caught;
 * a run killed that way leaves its files for the operator to delete (see the runbook).
 */
function removePlaintextOnSignal(): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      for (const child of children) child.kill();
      for (const path of plaintextPaths)
        rmSync(path, { recursive: true, force: true });
      console.error(`${signal}: stopped; the temporary SQL is removed`);
      process.exit(128 + constants.signals[signal]);
    });
}

export type RestoreErrorCode =
  | "usage"
  | "keyring_invalid"
  | "key_unavailable"
  | "not_an_envelope"
  | "authentication_failed"
  | "output_exists"
  | "receipt_invalid"
  | "receipt_mismatch"
  | "database_not_found"
  | "live_database"
  | "database_not_empty"
  | "reorder_failed"
  | "wrangler_failed";

export class RestoreError extends Error {
  readonly code: RestoreErrorCode;
  constructor(code: RestoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type Options =
  | {
      mode: "decrypt";
      input: string;
      output: string;
      keysEnvironment: string;
      receipt?: string;
    }
  | {
      mode: "import";
      input: string;
      database: string;
      keysEnvironment: string;
      receipt?: string;
      wrangler: string;
    };

export function parseOptions(argv: string[]): Options {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        input: { type: "string" },
        output: { type: "string" },
        database: { type: "string" },
        "keys-env": { type: "string" },
        receipt: { type: "string" },
        wrangler: { type: "string" },
      },
    });
  } catch (error) {
    throw new RestoreError(
      "usage",
      `${error instanceof Error ? error.message.split("\n")[0] : "bad arguments"}\n${USAGE}`,
    );
  }
  const { values, positionals } = parsed,
    mode = positionals[0],
    fail: (message: string) => never = (message) => {
      throw new RestoreError("usage", `${message}\n${USAGE}`);
    };
  if (positionals.length !== 1 || (mode !== "decrypt" && mode !== "import"))
    fail("name one command: decrypt or import");
  if (!values.input) fail("--input is required");
  if (!values["keys-env"]) fail("--keys-env is required");
  if (!VARIABLE_NAME.test(values["keys-env"]!))
    fail("--keys-env takes the name of an environment variable, not its value");
  const common = {
    input: values.input!,
    keysEnvironment: values["keys-env"]!,
    ...(values.receipt === undefined ? {} : { receipt: values.receipt }),
  };
  if (mode === "decrypt") {
    if (!values.output) fail("--output is required for decrypt");
    if (values.database !== undefined || values.wrangler !== undefined)
      fail("--database and --wrangler belong to import");
    return { mode, ...common, output: values.output! };
  }
  if (values.output !== undefined) fail("--output belongs to decrypt");
  if (!values.database || !DATABASE_NAME.test(values.database))
    fail("--database must be the name of the scratch D1 database");
  return {
    mode,
    ...common,
    database: values.database!,
    wrangler: values.wrangler ?? "wrangler",
  };
}

// ---------- Keys ----------

/** The keyring of the named variable. An error names the variable, never what it holds. */
export function keyringFromEnvironment(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const value = environment[name];
  if (!value) throw new RestoreError("usage", `set ${name}`);
  const invalid = () =>
    new RestoreError(
      "keyring_invalid",
      `${name} does not hold a keyring: {"active":"<id>","keys":{"<id>":"<base64url, 32 bytes>"}}`,
    );
  const keyring = parseKeyring(value);
  if (!keyring) throw invalid();
  const active = Object.hasOwn(keyring.keys, keyring.active)
    ? base64urlToBytes(keyring.keys[keyring.active]!)
    : null;
  if (active?.length !== 32) throw invalid();
  return value;
}

function parseKeyring(
  text: string,
): { active: string; keys: Record<string, string> } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const { active, keys, ...rest } = value as Record<string, unknown>;
  if (
    Object.keys(rest).length > 0 ||
    typeof active !== "string" ||
    !KEY_ID.test(active) ||
    typeof keys !== "object" ||
    keys === null ||
    Array.isArray(keys) ||
    !Object.values(keys).every((key) => typeof key === "string")
  )
    return null;
  return { active, keys: keys as Record<string, string> };
}

/** The envelope key of one key version: HKDF-SHA256 over that version's 32-byte master key. */
export function envelopeKey(keyring: string, kid: string): Buffer {
  const parsed = parseKeyring(keyring);
  if (!parsed)
    throw new RestoreError(
      "keyring_invalid",
      "the keyring is not valid JSON of the expected form",
    );
  const master = Object.hasOwn(parsed.keys, kid)
    ? base64urlToBytes(parsed.keys[kid]!)
    : null;
  if (master?.length !== 32)
    throw new RestoreError(
      "key_unavailable",
      `the keyring has no usable key version "${kid}"`,
    );
  return Buffer.from(hkdfSync("sha256", master, HKDF_SALT, kid, 32));
}

// ---------- The envelope ----------

export interface Identity {
  run_id: string;
  artifact_id: string;
  day: string;
  region_id: string;
  source_id: string;
  kid: string;
  plaintext_sha256: string;
  plaintext_bytes: number;
}
export interface DecryptResult extends Identity {
  encrypted_sha256: string;
  encrypted_bytes: number;
}

const notAnEnvelope = () =>
  new RestoreError(
    "not_an_envelope",
    "the file is not a complete PGCFINF1 envelope",
  );

/** The authenticated identity as the AAD states it; it is trusted only once the tag has verified. */
function parseIdentity(aad: Buffer): Identity {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(aad.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw notAnEnvelope();
  }
  const text = (name: string) => {
    const field = value?.[name];
    if (typeof field !== "string" || field === "") throw notAnEnvelope();
    return field;
  };
  const bytes = value.plaintext_bytes;
  if (
    value.version !== 1 ||
    value.kind !== "d1" ||
    !UUID.test(text("run_id")) ||
    !KEY_ID.test(text("kid")) ||
    !SHA256.test(text("plaintext_sha256")) ||
    typeof bytes !== "number" ||
    !Number.isInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_PLAINTEXT
  )
    throw notAnEnvelope();
  return {
    run_id: text("run_id"),
    artifact_id: text("artifact_id"),
    day: text("day"),
    region_id: text("region_id"),
    source_id: text("source_id"),
    kid: text("kid"),
    plaintext_sha256: text("plaintext_sha256"),
    plaintext_bytes: bytes,
  };
}

interface Header {
  identity: Identity;
  /** The bytes before the ciphertext: magic, length, AAD and nonce. */
  prefix: Buffer;
  aad: Buffer;
  nonce: Buffer;
  size: number;
}

async function readAt(handle: FileHandle, position: number, length: number) {
  const buffer = Buffer.alloc(length),
    { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw notAnEnvelope();
  return buffer;
}

async function readHeader(handle: FileHandle): Promise<Header> {
  const { size } = await handle.stat(),
    start = await readAt(handle, 0, 12);
  if (!start.subarray(0, 8).equals(MAGIC)) throw notAnEnvelope();
  const aadLength = start.readUInt32BE(8);
  if (aadLength < 2 || aadLength > MAX_AAD) throw notAnEnvelope();
  const rest = await readAt(handle, 12, aadLength + NONCE_BYTES),
    prefix = Buffer.concat([start, rest]);
  // At least one byte of ciphertext and the tag must follow.
  if (size < prefix.length + 1 + TAG_BYTES) throw notAnEnvelope();
  const aad = rest.subarray(0, aadLength);
  return {
    identity: parseIdentity(aad),
    prefix,
    aad,
    nonce: rest.subarray(aadLength),
    size,
  };
}

/** Compares what the API stored with what the artifact says; the differing field names, or none. */
function receiptDifferences(
  receipt: unknown,
  identity: Identity,
  encrypted: { sha256: string; bytes: number },
): string[] {
  if (typeof receipt !== "object" || receipt === null || !("latest" in receipt))
    throw new RestoreError(
      "receipt_invalid",
      "the receipt is not an answer of GET /v1/infrastructure-backups",
    );
  const latest = (receipt as { latest: unknown }).latest;
  if (latest === null)
    throw new RestoreError(
      "receipt_mismatch",
      "the receipt holds no run (latest is null)",
    );
  const run = InfrastructureBackupRunStatus.safeParse(latest);
  if (!run.success)
    throw new RestoreError(
      "receipt_invalid",
      "the receipt is not an answer of GET /v1/infrastructure-backups",
    );
  if (run.data.id !== identity.run_id)
    throw new RestoreError(
      "receipt_mismatch",
      "the receipt is of another run than the artifact's; save the answer while that run is the latest",
    );
  const stored = run.data.artifacts.find(
    (artifact) => artifact.id === identity.artifact_id,
  );
  if (!stored)
    throw new RestoreError(
      "receipt_mismatch",
      `the receipt has no artifact "${identity.artifact_id}" for the run`,
    );
  const expected: Record<string, unknown> = {
    status: "complete",
    day: identity.day,
    region_id: identity.region_id,
    source_id: identity.source_id,
    kid: identity.kid,
    plaintext_sha256: identity.plaintext_sha256,
    plaintext_bytes: identity.plaintext_bytes,
    encrypted_sha256: encrypted.sha256,
    encrypted_bytes: encrypted.bytes,
    object_key: `infrastructure/v1/${identity.day}/${identity.run_id}/${identity.artifact_id}.pgcfenc`,
  };
  const actual = stored as Record<string, unknown>;
  return Object.keys(expected).filter(
    (name) => actual[name] !== expected[name],
  );
}

/**
 * Decrypts and verifies an artifact. The plaintext goes to `<output>.partial` and becomes `output`
 * only once the tag, the AAD's plaintext hash and length, and the receipt (when given) all hold; a
 * failure leaves nothing behind. `output` is never replaced.
 */
export async function decryptArtifact(options: {
  input: string;
  output: string;
  keyring: string;
  receipt?: unknown;
}): Promise<DecryptResult> {
  const input = await open(options.input, "r"),
    partial = `${options.output}.partial`;
  let out: FileHandle | undefined,
    partialCreated = false;
  try {
    const header = await readHeader(input),
      { identity } = header,
      key = envelopeKey(options.keyring, identity.kid),
      tag = await readAt(input, header.size - TAG_BYTES, TAG_BYTES),
      decipher: DecipherGCM = createDecipheriv(
        "aes-256-gcm",
        key,
        header.nonce,
      );
    key.fill(0);
    decipher.setAAD(header.aad);
    decipher.setAuthTag(tag);
    const taken = () =>
      new RestoreError(
        "output_exists",
        `${options.output} exists (or ${partial} does); it is never replaced`,
      );
    if (await exists(options.output)) throw taken();
    // `wx` creates the file with its mode and fails if it exists.
    out = await open(partial, "wx", 0o600).catch(
      (error: NodeJS.ErrnoException) => {
        throw error.code === "EEXIST" ? taken() : error;
      },
    );
    partialCreated = true;
    plaintextPaths.add(partial);
    const encrypted = createHash("sha256").update(header.prefix),
      plaintext = createHash("sha256");
    let plaintextBytes = 0;
    const write = async (bytes: Buffer) => {
      if (!bytes.length) return;
      plaintextBytes += bytes.length;
      if (plaintextBytes > identity.plaintext_bytes)
        throw new RestoreError("authentication_failed", AUTHENTICATION_FAILED);
      plaintext.update(bytes);
      await out!.write(bytes);
    };
    try {
      for await (const chunk of createReadStream(options.input, {
        start: header.prefix.length,
        end: header.size - TAG_BYTES - 1,
      }) as AsyncIterable<Buffer>) {
        encrypted.update(chunk);
        await write(decipher.update(chunk));
      }
      encrypted.update(tag);
      await write(decipher.final());
    } catch (error) {
      if (error instanceof RestoreError) throw error;
      throw new RestoreError("authentication_failed", AUTHENTICATION_FAILED);
    }
    // The tag covers the AAD, which states the plaintext's hash and length; both are checked
    // against what was decrypted, so the SQL is also the one the Worker measured.
    if (
      plaintextBytes !== identity.plaintext_bytes ||
      plaintext.digest("hex") !== identity.plaintext_sha256
    )
      throw new RestoreError("authentication_failed", AUTHENTICATION_FAILED);
    const result: DecryptResult = {
      ...identity,
      encrypted_sha256: encrypted.digest("hex"),
      encrypted_bytes: header.size,
    };
    if (options.receipt !== undefined) {
      const differences = receiptDifferences(options.receipt, identity, {
        sha256: result.encrypted_sha256,
        bytes: result.encrypted_bytes,
      });
      if (differences.length)
        throw new RestoreError(
          "receipt_mismatch",
          `the artifact differs from the API's receipt in: ${differences.join(", ")}`,
        );
    }
    await out.sync();
    await out.close();
    out = undefined;
    // A hard link fails if `output` appeared meanwhile; a rename would replace it.
    await link(partial, options.output).catch(
      (error: NodeJS.ErrnoException) => {
        throw error.code === "EEXIST" ? taken() : error;
      },
    );
    return result;
  } finally {
    await out?.close().catch(() => {});
    await input.close().catch(() => {});
    // Only a partial file this call created is removed.
    if (partialCreated) {
      await rm(partial, { force: true });
      plaintextPaths.delete(partial);
    }
  }
}
const AUTHENTICATION_FAILED =
  "authentication failed: the file was changed or cut, or the key is not the one that wrote it";

async function exists(path: string) {
  return open(path, "r").then(
    (handle) => handle.close().then(() => true),
    () => false,
  );
}

// ---------- Schema first ----------

// The bytes the scanner reacts to.
const SEMICOLON = 0x3b,
  SINGLE = 0x27,
  DOUBLE = 0x22,
  BACKTICK = 0x60,
  LEFT_BRACKET = 0x5b,
  RIGHT_BRACKET = 0x5d,
  DASH = 0x2d,
  SLASH = 0x2f,
  STAR = 0x2a,
  NEWLINE = 0x0a;
const Scan = {
  Normal: 0,
  Quoted: 1,
  QuoteSeen: 2,
  Bracket: 3,
  DashSeen: 4,
  SlashSeen: 5,
  LineComment: 6,
  BlockComment: 7,
  StarSeen: 8,
} as const;

/**
 * The statements of an SQL file as byte ranges, each ending at a `;` that is outside quotes,
 * identifiers and comments, and each starting right after the previous one (so it holds the line
 * break that followed it). A trigger's body is split at its inner semicolons: every piece stays in
 * its place, which is all the caller needs. Bytes are enough: a multi-byte character never holds
 * an ASCII byte.
 */
async function* statements(
  path: string,
  chunkBytes: number,
): AsyncGenerator<Buffer> {
  let mode: number = Scan.Normal,
    quote = 0,
    parts: Buffer[] = [];
  for await (const chunk of createReadStream(path, {
    highWaterMark: chunkBytes,
  }) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let at = 0; at < chunk.length; at++) {
      let ended = false;
      // A byte that closes a lookahead (a quote, a dash, a slash) is also read as the first byte
      // of normal text.
      for (let again = true; again;) {
        again = false;
        const byte = chunk[at]!;
        switch (mode) {
          case Scan.Normal:
            if (byte === SEMICOLON) ended = true;
            else if (byte === SINGLE || byte === DOUBLE || byte === BACKTICK) {
              mode = Scan.Quoted;
              quote = byte;
            } else if (byte === LEFT_BRACKET) mode = Scan.Bracket;
            else if (byte === DASH) mode = Scan.DashSeen;
            else if (byte === SLASH) mode = Scan.SlashSeen;
            break;
          case Scan.Quoted:
            if (byte === quote) mode = Scan.QuoteSeen;
            break;
          case Scan.QuoteSeen:
            // A doubled quote is part of the text; anything else ended it.
            if (byte === quote) mode = Scan.Quoted;
            else {
              mode = Scan.Normal;
              again = true;
            }
            break;
          case Scan.Bracket:
            if (byte === RIGHT_BRACKET) mode = Scan.Normal;
            break;
          case Scan.DashSeen:
            if (byte === DASH) mode = Scan.LineComment;
            else {
              mode = Scan.Normal;
              again = true;
            }
            break;
          case Scan.SlashSeen:
            if (byte === STAR) mode = Scan.BlockComment;
            else {
              mode = Scan.Normal;
              again = true;
            }
            break;
          case Scan.LineComment:
            if (byte === NEWLINE) mode = Scan.Normal;
            break;
          case Scan.BlockComment:
            if (byte === STAR) mode = Scan.StarSeen;
            break;
          case Scan.StarSeen:
            if (byte === SLASH) mode = Scan.Normal;
            else if (byte !== STAR) mode = Scan.BlockComment;
            break;
        }
      }
      if (ended) {
        parts.push(chunk.subarray(from, at + 1));
        yield Buffer.concat(parts);
        parts = [];
        from = at + 1;
      }
    }
    if (from < chunk.length) parts.push(chunk.subarray(from));
  }
  if (parts.length) yield Buffer.concat(parts);
}

const LEADING = String.raw`(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*`,
  CREATE_TABLE = new RegExp(`^${LEADING}CREATE\\s+TABLE\\b`, "i"),
  INSERT = new RegExp(`^${LEADING}INSERT\\b`, "i");
const head = (piece: Buffer) => piece.toString("latin1", 0, 512);

/**
 * Writes `output` with every CREATE TABLE statement of `input` ahead of all other statements, each
 * statement byte for byte as it was. D1's export lists a table's rows right after its CREATE
 * TABLE and the tables in the order they were created; a migration that rebuilt a table puts it
 * after the tables that reference it, and SQLite refuses the first row of a table whose
 * referenced table does not exist yet (`no such table: main.regions`), whatever
 * `defer_foreign_keys` says. The rest keeps its order: rows, then indexes, triggers and views.
 * `moved` counts the tables that came after a row.
 */
export async function schemaFirst(
  input: string,
  output: string,
  options: { chunkBytes?: number } = {},
): Promise<{ tables: number; moved: number }> {
  const chunkBytes = options.chunkBytes ?? 1024 * 1024,
    out = await open(output, "wx", 0o600);
  let tables = 0,
    moved = 0,
    rows = false,
    pending: Buffer[] = [],
    pendingBytes = 0;
  const write = async (piece: Buffer) => {
      pending.push(piece);
      pendingBytes += piece.length;
      if (pendingBytes < 1024 * 1024) return;
      await out.write(Buffer.concat(pending));
      pending = [];
      pendingBytes = 0;
    },
    flush = async () => {
      if (pendingBytes) await out.write(Buffer.concat(pending));
      pending = [];
      pendingBytes = 0;
    };
  try {
    for await (const piece of statements(input, chunkBytes)) {
      if (CREATE_TABLE.test(head(piece))) {
        tables++;
        if (rows) moved++;
        await write(piece);
      } else if (INSERT.test(head(piece))) rows = true;
    }
    for await (const piece of statements(input, chunkBytes))
      if (!CREATE_TABLE.test(head(piece))) await write(piece);
    await flush();
    await out.sync();
  } finally {
    await out.close();
  }
  if ((await stat(output)).size !== (await stat(input)).size)
    throw new RestoreError(
      "reorder_failed",
      "the reordered SQL differs in size from the artifact's; nothing was imported",
    );
  return { tables, moved };
}

// ---------- The scratch D1 database ----------

export interface ImportResult {
  database_id: string;
  tables: number;
  queries: number | undefined;
  rows_written: number | undefined;
  artifact: DecryptResult;
}

export interface ImportDependencies {
  environment: Record<string, string | undefined>;
  log: (line: string) => void;
}

// What D1 keeps for itself (`sqlite_*`, `_cf_*`) is not the database's. A scratch database must hold
// no object of any kind before an import; what an import made is counted as tables.
const SCHEMA_OBJECTS = String.raw`SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE '\_cf\_%' ESCAPE '\'`,
  TABLES = `${SCHEMA_OBJECTS} AND type = 'table'`;

async function wranglerRun(
  command: string,
  args: string[],
  context: {
    cwd: string;
    environment: Record<string, string | undefined>;
    timeoutMs: number;
    stderrIsSafe: boolean;
  },
): Promise<unknown> {
  const { stdout } = await new Promise<{ stdout: string }>((done, fail) => {
    const child = execFile(
      command,
      args,
      {
        cwd: context.cwd,
        env: context.environment as NodeJS.ProcessEnv,
        timeout: context.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, out, err) => {
        children.delete(child);
        if (!error) return done({ stdout: out });
        const status =
          typeof (error as { code?: unknown }).code === "number"
            ? `exit code ${(error as { code: number }).code}`
            : error.killed
              ? "timeout"
              : "it did not start";
        // The text of a failed import can quote the SQL; the other calls carry none.
        const detail = context.stderrIsSafe
          ? `: ${err.trim().split("\n").slice(0, 3).join(" ").slice(0, 300)}`
          : "";
        fail(
          new RestoreError(
            "wrangler_failed",
            `wrangler ${args.slice(0, 2).join(" ")} failed (${status})${detail}`,
          ),
        );
      },
    );
    children.add(child);
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new RestoreError(
      "wrangler_failed",
      `wrangler ${args.slice(0, 2).join(" ")} did not answer with JSON`,
    );
  }
}

const first = (value: unknown): Record<string, unknown> | undefined =>
  Array.isArray(value) && typeof value[0] === "object" && value[0] !== null
    ? (value[0] as Record<string, unknown>)
    : undefined;

/** The count a query (`SCHEMA_OBJECTS` or `TABLES`) gives for a D1 database, asked by its ID. */
async function count(
  wrangler: string,
  id: string,
  query: string,
  context: Parameters<typeof wranglerRun>[2],
) {
  const answer = first(
      await wranglerRun(
        wrangler,
        ["d1", "execute", id, "--remote", "--json", "--command", query],
        context,
      ),
    ),
    rows = answer?.results,
    n = Array.isArray(rows)
      ? (rows[0] as { n?: unknown } | undefined)?.n
      : undefined;
  if (answer?.success !== true || typeof n !== "number")
    throw new RestoreError(
      "wrangler_failed",
      "wrangler d1 execute did not answer a count",
    );
  return n;
}

export async function importArtifact(
  options: {
    input: string;
    keyring: string;
    keysEnvironment: string;
    database: string;
    wrangler: string;
    receipt?: unknown;
  },
  dependencies: ImportDependencies,
): Promise<ImportResult> {
  const { log } = dependencies,
    // Wrangler gets the environment without the keyring.
    environment = { ...dependencies.environment },
    wrangler = options.wrangler.includes("/")
      ? resolve(options.wrangler)
      : options.wrangler;
  delete environment[options.keysEnvironment];
  const handle = await open(options.input, "r"),
    header = await readHeader(handle).finally(() => handle.close());
  // A private directory with no wrangler configuration in it: wrangler resolves a name or binding
  // from a configuration first, so every call runs here and names the database by its ID.
  const directory = await mkdtemp(join(tmpdir(), "pgcf-restore-")),
    context = {
      cwd: directory,
      environment,
      timeoutMs: 2 * 60 * 1000,
      stderrIsSafe: true,
    };
  plaintextPaths.add(directory);
  try {
    const databases = await wranglerRun(
        wrangler,
        ["d1", "list", "--json"],
        context,
      ),
      matches = (Array.isArray(databases) ? databases : []).filter(
        (database): database is { uuid: string; name: string } =>
          typeof database === "object" &&
          database !== null &&
          (database as { name?: unknown }).name === options.database &&
          typeof (database as { uuid?: unknown }).uuid === "string",
      );
    if (matches.length !== 1)
      throw new RestoreError(
        "database_not_found",
        `${matches.length} D1 databases of the account are named "${options.database}"; the name must match exactly one`,
      );
    const id = matches[0]!.uuid;
    if (id === header.identity.source_id)
      throw new RestoreError(
        "live_database",
        `"${options.database}" is the database this artifact was exported from; a restore drill needs a new, empty scratch database`,
      );
    const before = await count(wrangler, id, SCHEMA_OBJECTS, context);
    if (before !== 0)
      throw new RestoreError(
        "database_not_empty",
        `"${options.database}" already has ${before} schema objects; import only into a new, empty scratch database`,
      );
    const sql = join(directory, "restore.sql"),
      artifact = await decryptArtifact({
        input: options.input,
        output: sql,
        keyring: options.keyring,
        receipt: options.receipt,
      });
    for (const line of artifactLines(artifact)) log(line);
    log(`receipt: ${options.receipt === undefined ? "not given" : "matched"}`);
    const ordered = join(directory, "ordered.sql"),
      order = await schemaFirst(sql, ordered);
    await rm(sql);
    log(
      `${order.tables} tables${order.moved ? `, ${order.moved} of them created after rows in the dump and moved ahead of the rows` : ""}`,
    );
    log(
      `importing into "${options.database}" (${id}); this locks that database until it ends`,
    );
    const imported = first(
        await wranglerRun(
          wrangler,
          [
            "d1",
            "execute",
            id,
            "--remote",
            "--yes",
            "--json",
            "--file",
            ordered,
          ],
          { ...context, timeoutMs: 60 * 60 * 1000, stderrIsSafe: false },
        ),
      ),
      summary = Array.isArray(imported?.results)
        ? (imported.results[0] as Record<string, unknown> | undefined)
        : undefined;
    if (imported?.success !== true)
      throw new RestoreError(
        "wrangler_failed",
        "wrangler d1 execute did not report a successful import",
      );
    const number = (value: unknown) =>
        typeof value === "number" ? value : undefined,
      tables = await count(wrangler, id, TABLES, context);
    if (tables === 0)
      throw new RestoreError(
        "wrangler_failed",
        "the import reported success but the database has no tables",
      );
    const result: ImportResult = {
      database_id: id,
      tables,
      queries: number(summary?.["Total queries executed"]),
      rows_written: number(summary?.["Rows written"]),
      artifact,
    };
    log(
      `imported: ${tables} tables, ${result.queries ?? "?"} queries, ${result.rows_written ?? "?"} rows written`,
    );
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
    plaintextPaths.delete(directory);
  }
}

// ---------- The command ----------

/** What the tool says about a verified artifact: no database ID, and nothing of the content. */
function artifactLines(result: DecryptResult): string[] {
  return [
    `verified artifact ${result.artifact_id} of run ${result.run_id} (day ${result.day}, region ${result.region_id}, key version ${result.kid})`,
    `plaintext: ${result.plaintext_bytes} bytes, sha256 ${result.plaintext_sha256}`,
    `encrypted: ${result.encrypted_bytes} bytes, sha256 ${result.encrypted_sha256}`,
  ];
}

async function readReceipt(path: string | undefined): Promise<unknown> {
  if (path === undefined) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new RestoreError(
      "receipt_invalid",
      "the receipt file is not readable JSON",
    );
  }
}

async function main(
  argv: string[],
  environment: Record<string, string | undefined>,
) {
  const options = parseOptions(argv),
    keyring = keyringFromEnvironment(environment, options.keysEnvironment),
    receipt = await readReceipt(options.receipt),
    log = (line: string) => console.log(line);
  if (options.mode === "import") {
    await importArtifact(
      { ...options, keyring, receipt },
      { environment, log },
    );
    return;
  }
  const result = await decryptArtifact({
    input: options.input,
    output: options.output,
    keyring,
    receipt,
  });
  for (const line of artifactLines(result)) log(line);
  log(`receipt: ${receipt === undefined ? "not given" : "matched"}`);
  log(`wrote ${options.output} (mode 0600)`);
}

if (import.meta.main) {
  removePlaintextOnSignal();
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  });
}
