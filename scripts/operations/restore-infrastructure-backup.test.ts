// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import {
  encryptSource,
  measureSource,
} from "../../apps/api/src/domain/infrastructure-backup-envelope.ts";
import {
  RestoreError,
  decryptArtifact,
  envelopeKey,
  importArtifact,
  keyringFromEnvironment,
  parseOptions,
  schemaFirst,
} from "./restore-infrastructure-backup.ts";

const RUN = "7c0d1b5e-52a3-4a52-9a4e-1f2f6b0d6a11";
const LIVE_DATABASE = "5b9f6c4e-0c0e-4f7e-8d57-3d3a9a3a7e21";
const SCRATCH_DATABASE = "0e6e2d0c-6a1b-4a88-b3b1-4b0c3f9d5d42";
const KEYRING = JSON.stringify({
  active: "v2",
  keys: {
    v1: randomBytes(32).toString("base64url"),
    v2: randomBytes(32).toString("base64url"),
  },
});
const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** A D1 export in the form the provider writes: a pragma, then schema and rows. */
const DUMP = Buffer.from(
  [
    "PRAGMA defer_foreign_keys=TRUE;",
    "CREATE TABLE regions (id TEXT PRIMARY KEY, backup_bucket TEXT NOT NULL);",
    "INSERT INTO \"regions\" VALUES('eu1','bucket-secret-name');",
    "CREATE TABLE databases (id TEXT PRIMARY KEY, region_id TEXT REFERENCES regions(id));",
    ...Array.from(
      { length: 4000 },
      (_, i) => `INSERT INTO "databases" VALUES('d${i}','eu1');`,
    ),
    "CREATE INDEX databases_region ON databases (region_id);",
    "",
  ].join("\n"),
);

/** The real encryption the Worker uses, over a source that arrives in chunks of `chunk` bytes. */
async function artifact(
  plain = DUMP,
  options: { keyring?: string; chunk?: number } = {},
) {
  const { keyring = KEYRING, chunk = 1000 } = options,
    source = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < plain.length; at += chunk)
            controller.enqueue(plain.subarray(at, at + chunk));
          controller.close();
        },
      }),
    active = (JSON.parse(keyring) as { active: string }).active,
    encryption = {
      kid: active,
      key: envelopeKey(keyring, active).toString("base64url"),
    },
    identity = {
      run_id: RUN,
      id: "d1-control",
      kind: "d1",
      day: "2026-10-20",
      region_id: "eu1",
      source_id: LIVE_DATABASE,
      kid: encryption.kid,
      ...(await measureSource(source())),
    },
    encrypted = encryptSource(source(), encryption.key, identity),
    bytes = Buffer.from(await new Response(encrypted.stream).arrayBuffer());
  return { bytes, identity, receipt: await encrypted.receipt };
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "pgcf-restore-test-"));
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}
const refused = (code: string) => (error: unknown) =>
  error instanceof RestoreError && error.code === code;

test("derives the envelope key as the Worker does: known answers from its own function", () => {
  // The master key is the bytes 1 to 32. The answers are what `infrastructureBackupKey` of the API
  // returned for it, for two key ids (apps/api/src/domain/infrastructure-backups.ts); the API's
  // module needs Worker types, so a script's test cannot call it.
  const master = Buffer.from(
      Array.from({ length: 32 }, (_, i) => i + 1),
    ).toString("base64url"),
    keyring = JSON.stringify({
      active: "v1",
      keys: { v1: master, "k-2026.10": master },
    });
  assert.equal(master, "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA");
  assert.equal(
    envelopeKey(keyring, "v1").toString("base64url"),
    "EEp8sEfTBQB6gGCFovRxk8sV2_T6gYSiqSyY9K36gYU",
  );
  assert.equal(
    envelopeKey(keyring, "k-2026.10").toString("base64url"),
    "I22HHG5pMCfF5Bgs9UWwLYh1MMIqLXOyuw7hyHpcQEU",
  );
});

test("decrypts what the Worker's encryption wrote, across chunk boundaries, and reports the identity it verified", async () => {
  const { dir, done } = await workspace();
  try {
    const { bytes, identity, receipt } = await artifact(),
      input = join(dir, "d1-control.pgcfenc"),
      output = join(dir, "restore.sql");
    await writeFile(input, bytes);
    const result = await decryptArtifact({ input, output, keyring: KEYRING });
    assert.deepEqual(await readFile(output), DUMP);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(result, {
      run_id: RUN,
      artifact_id: "d1-control",
      day: "2026-10-20",
      region_id: "eu1",
      source_id: LIVE_DATABASE,
      kid: "v2",
      plaintext_sha256: identity.plaintext_sha256,
      plaintext_bytes: DUMP.length,
      encrypted_sha256: receipt.encrypted_sha256,
      encrypted_bytes: bytes.length,
    });
    assert.equal(result.encrypted_sha256, sha256(bytes));
    // The key is the one the artifact names, whichever version is active: a retired v1 artifact
    // opens with the keyring that has moved on to v2.
    const old = JSON.stringify({
        active: "v2",
        keys: JSON.parse(KEYRING).keys,
      }),
      retired = await artifact(DUMP, {
        keyring: JSON.stringify({ active: "v1", keys: JSON.parse(old).keys }),
      });
    await writeFile(input, retired.bytes);
    const second = await decryptArtifact({
      input,
      output: join(dir, "retired.sql"),
      keyring: old,
    });
    assert.equal(second.kid, "v1");
    assert.deepEqual(await readFile(join(dir, "retired.sql")), DUMP);
  } finally {
    await done();
  }
});

test("refuses a flipped byte, a truncated file, another key and a changed identity, and leaves no plaintext", async () => {
  const { dir, done } = await workspace();
  try {
    const { bytes } = await artifact(),
      input = join(dir, "d1-control.pgcfenc"),
      aadLength = bytes.readUInt32BE(8),
      flipped = (at: number) => {
        const copy = Buffer.from(bytes);
        copy[at] = copy[at]! ^ 1;
        return copy;
      },
      // The AAD is plain JSON that GCM authenticates: the day "2026-10-20" with its first digit
      // changed is still a well-formed identity, and must still be refused.
      dayAt = 12 + bytes.subarray(12, 12 + aadLength).indexOf("2026-10-20"),
      renamed = Buffer.from(bytes);
    renamed.write("2026-10-21", dayAt);
    const keys = JSON.parse(KEYRING) as { keys: Record<string, string> },
      cases: [string, Buffer, string, string?][] = [
        [
          "a flipped ciphertext byte",
          flipped(bytes.length - 40),
          "authentication_failed",
        ],
        [
          "a flipped tag byte",
          flipped(bytes.length - 1),
          "authentication_failed",
        ],
        [
          "a flipped nonce byte",
          flipped(12 + aadLength + 3),
          "authentication_failed",
        ],
        ["a changed identity", renamed, "authentication_failed"],
        [
          "a file cut before its tag",
          bytes.subarray(0, bytes.length - 20),
          "authentication_failed",
        ],
        [
          "a file cut in half",
          bytes.subarray(0, bytes.length / 2),
          "authentication_failed",
        ],
        [
          "a file with bytes appended",
          Buffer.concat([bytes, Buffer.alloc(16)]),
          "authentication_failed",
        ],
        [
          "a file cut inside its header",
          bytes.subarray(0, 30),
          "not_an_envelope",
        ],
        [
          "a file without ciphertext",
          bytes.subarray(0, 12 + aadLength + 12 + 16),
          "not_an_envelope",
        ],
        [
          "another magic",
          Buffer.concat([Buffer.from("PGCFINF2"), bytes.subarray(8)]),
          "not_an_envelope",
        ],
        ["an empty file", Buffer.alloc(0), "not_an_envelope"],
        [
          "another key under the same id",
          bytes,
          "authentication_failed",
          JSON.stringify({
            active: "v2",
            keys: { ...keys.keys, v2: randomBytes(32).toString("base64url") },
          }),
        ],
        [
          "a keyring without the artifact's key id",
          bytes,
          "key_unavailable",
          JSON.stringify({ active: "v1", keys: { v1: keys.keys.v1 } }),
        ],
      ];
    for (const [name, content, code, keyring] of cases) {
      await writeFile(input, content);
      const output = join(dir, "restore.sql");
      await assert.rejects(
        decryptArtifact({ input, output, keyring: keyring ?? KEYRING }),
        refused(code),
        name,
      );
      assert.deepEqual(
        (await readdir(dir)).sort(),
        ["d1-control.pgcfenc"],
        `${name} left a file`,
      );
    }
    // A file that exists is never replaced.
    await writeFile(input, bytes);
    await writeFile(join(dir, "restore.sql"), "keep");
    await assert.rejects(
      decryptArtifact({
        input,
        output: join(dir, "restore.sql"),
        keyring: KEYRING,
      }),
      refused("output_exists"),
    );
    assert.equal(await readFile(join(dir, "restore.sql"), "utf8"), "keep");
  } finally {
    await done();
  }
});

test("holds the artifact to the API's receipt when it is given one", async () => {
  const { dir, done } = await workspace();
  try {
    const { bytes, identity, receipt } = await artifact(),
      input = join(dir, "d1-control.pgcfenc"),
      objectKey = `infrastructure/v1/2026-10-20/${RUN}/d1-control.pgcfenc`,
      stored = {
        id: "d1-control",
        kind: "d1",
        day: "2026-10-20",
        region_id: "eu1",
        source_id: LIVE_DATABASE,
        status: "complete",
        completed_at: "2026-10-20T00:01:30.000Z",
        error_code: null,
        object_key: objectKey,
        kid: "v2",
        plaintext_sha256: identity.plaintext_sha256,
        plaintext_bytes: identity.plaintext_bytes,
        encrypted_sha256: receipt.encrypted_sha256,
        encrypted_bytes: receipt.encrypted_bytes,
      },
      answer = (run: string, artifactOverrides: object = {}) => ({
        latest: {
          id: run,
          day: "2026-10-20",
          attempt: 1,
          status: "complete",
          created_at: "2026-10-20T00:00:00.000Z",
          completed_at: "2026-10-20T00:01:31.000Z",
          error_code: null,
          artifacts: [{ ...stored, ...artifactOverrides }],
        },
        health: [],
      });
    await writeFile(input, bytes);
    const go = (receiptValue: unknown, name: string) =>
      decryptArtifact({
        input,
        output: join(dir, name),
        keyring: KEYRING,
        receipt: receiptValue,
      });
    await go(answer(RUN), "ok.sql");
    assert.deepEqual(await readFile(join(dir, "ok.sql")), DUMP);
    await assert.rejects(
      go(answer(RUN, { encrypted_sha256: sha256("other") }), "wrong-hash.sql"),
      (error) =>
        refused("receipt_mismatch")(error) &&
        (error as Error).message.includes("encrypted_sha256"),
    );
    await assert.rejects(
      go(answer(randomUUID()), "other-run.sql"),
      refused("receipt_mismatch"),
    );
    await assert.rejects(
      go(
        answer(RUN, {
          object_key: objectKey.replace("2026-10-20", "2026-10-19"),
        }),
        "key.sql",
      ),
      refused("receipt_mismatch"),
    );
    await assert.rejects(
      go({ latest: null }, "none.sql"),
      refused("receipt_mismatch"),
    );
    await assert.rejects(
      go({ nonsense: true }, "bad.sql"),
      refused("receipt_invalid"),
    );
    assert.deepEqual((await readdir(dir)).sort(), [
      "d1-control.pgcfenc",
      "ok.sql",
    ]);
  } finally {
    await done();
  }
});

// The dump of the control database puts `regions` after the tables that reference it (a migration
// rebuilt it), so the first row of such a table meets a missing parent table.
const OUT_OF_ORDER = [
  "PRAGMA defer_foreign_keys=TRUE;",
  "CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));",
  `INSERT INTO "child" VALUES('c1','p1');`,
  "CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL, note TEXT);",
  `INSERT INTO "parent" VALUES('p1','a; CREATE TABLE evil (x); -- not a comment');`,
  `INSERT INTO "parent" VALUES('p2','it''s "quoted"; /* nor this */ and`,
  `a second line; CREATE TABLE evil2 (x);');`,
  `CREATE TABLE IF NOT EXISTS "log" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, [odd;name] TEXT) ;`,
  "-- a comment; CREATE TABLE in_comment (x);",
  "/* and another; */ CREATE TABLE after_comment (x INTEGER);",
  "DELETE FROM sqlite_sequence;",
  `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('log',7);`,
  "CREATE INDEX child_parent ON child(parent_id);",
  `CREATE TRIGGER child_audit AFTER INSERT ON child BEGIN INSERT INTO log("odd;name") VALUES(NEW.id); SELECT 1; END;`,
  "",
].join("\n");

test("puts every CREATE TABLE ahead of the data, whatever the quoting and chunking, without changing a byte of any statement", async () => {
  const { dir, done } = await workspace();
  try {
    // The dump is loaded as one transaction, which is what `defer_foreign_keys` is for. That the
    // provider's import runs the file as one transaction is not verified: the restore drill is
    // where it is first tried (docs/operations/infrastructure-backups.md).
    const load = (db: DatabaseSync, sql: string) =>
      db.exec(`BEGIN;\n${sql}\nCOMMIT;`);
    const raw = new DatabaseSync(":memory:");
    assert.throws(() => load(raw, OUT_OF_ORDER), /no such table/);
    raw.close();
    const input = join(dir, "dump.sql");
    await writeFile(input, OUT_OF_ORDER);
    let first: string | undefined;
    // One byte at a time puts a chunk boundary inside every two-byte token and every quote.
    for (const chunkBytes of [1, 2, 3, 7, 64, 1 << 20]) {
      const output = join(dir, `ordered-${chunkBytes}.sql`),
        result = await schemaFirst(input, output, { chunkBytes }),
        text = await readFile(output, "utf8");
      assert.equal(result.tables, 4, `chunk ${chunkBytes}`);
      assert.equal(result.moved, 3, `chunk ${chunkBytes}`);
      assert.equal(Buffer.byteLength(text), OUT_OF_ORDER.length);
      first ??= text;
      assert.equal(text, first, `chunk ${chunkBytes} differs`);
      assert.equal((await stat(output)).mode & 0o777, 0o600);
    }
    const db = new DatabaseSync(":memory:");
    load(db, first!);
    const rows = (sql: string) =>
      db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    assert.deepEqual(rows("SELECT id, parent_id FROM child"), [
      { id: "c1", parent_id: "p1" },
    ]);
    assert.deepEqual(rows("SELECT id, note FROM parent ORDER BY id"), [
      { id: "p1", note: "a; CREATE TABLE evil (x); -- not a comment" },
      {
        id: "p2",
        note: `it's "quoted"; /* nor this */ and\na second line; CREATE TABLE evil2 (x);`,
      },
    ]);
    assert.deepEqual(
      rows("SELECT name, seq FROM sqlite_sequence WHERE name = 'log'"),
      [{ name: "log", seq: 7 }],
    );
    assert.deepEqual(
      rows(
        "SELECT name FROM sqlite_schema WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).map((row) => row.name),
      [
        "after_comment",
        "child",
        "child_audit",
        "child_parent",
        "log",
        "parent",
      ],
    );
    db.close();
    // A dump already in order is left as it is.
    const ordered = join(dir, "in-order.sql"),
      again = await schemaFirst(join(dir, "ordered-7.sql"), ordered);
    assert.equal(again.moved, 0);
    assert.equal(await readFile(ordered, "utf8"), first);
  } finally {
    await done();
  }
});

// A wrangler that speaks the forms the real one prints for `d1 list --json` and `d1 execute
// --json`, runs what it is given in a real SQLite database per D1 database (a file is loaded as
// one transaction, and a failure rolls it back), and records what it was asked and what the file it
// was given looked like at that time. With `hold` set it stops inside the import, as a slow one does.
const FAKE_WRANGLER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_WRANGLER_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const record = { args, cwd: fs.realpathSync(process.cwd()), keyring: process.env[state.keyringVariable] !== undefined };
const flag = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const save = () => { state.calls.push(record); fs.writeFileSync(statePath, JSON.stringify(state)); };
const out = (value) => { save(); process.stdout.write(JSON.stringify(value, null, 2) + "\\n"); };
if (args[0] === "d1" && args[1] === "list") {
  out(state.databases);
} else if (args[0] === "d1" && args[1] === "execute") {
  const database = state.databases.find((db) => db.uuid === args[2]);
  if (!database) { save(); process.stderr.write("Couldn't find a D1 DB with name or binding\\n"); process.exit(1); }
  const db = new DatabaseSync(path.join(path.dirname(statePath), database.uuid + ".sqlite"));
  if (flag("--file")) {
    const file = flag("--file");
    const text = fs.readFileSync(file);
    record.file = {
      mode: fs.statSync(file).mode & 0o777,
      directoryMode: fs.statSync(path.dirname(file)).mode & 0o777,
      directory: fs.realpathSync(path.dirname(file)),
      bytes: text.length,
      firstInsert: text.indexOf("INSERT INTO"),
      lastCreate: text.lastIndexOf("CREATE TABLE"),
    };
    if (state.hold) { save(); fs.writeFileSync(state.hold, String(process.pid)); setInterval(() => {}, 1000); return; }
    if (state.failImport) { save(); process.stderr.write("SQLITE_ERROR near " + text.toString("utf8", 0, 40) + "\\n"); process.exit(1); }
    db.exec("BEGIN;");
    try { db.exec(text.toString("utf8")); db.exec("COMMIT;"); }
    catch (error) { db.exec("ROLLBACK;"); save(); process.stderr.write(String(error.message) + "\\n"); process.exit(1); }
    out([{ results: [{ "Total queries executed": text.toString("utf8").split("\\n").length, "Rows read": 0, "Rows written": 4003, "Database size (MB)": "0.31" }], success: true, finalBookmark: "00000001-00000002-0000000a-abc", meta: { duration: 12.5 } }]);
  } else {
    out([{ results: db.prepare(flag("--command")).all().map((row) => ({ ...row })), success: true, meta: { duration: 0.2 } }]);
  }
} else {
  save(); process.stderr.write("unexpected command\\n"); process.exit(2);
}
`;

async function wranglerFixture(
  dir: string,
  overrides: {
    databases?: { uuid: string; name: string }[];
    /** SQL that a database already holds, by its ID. */
    existing?: Record<string, string>;
    failImport?: boolean;
    /** A file the fake writes its process ID to, and then never answers. */
    hold?: string;
  } = {},
) {
  const wrangler = join(dir, "wrangler"),
    statePath = join(dir, "wrangler-state.json");
  await writeFile(wrangler, FAKE_WRANGLER);
  await chmod(wrangler, 0o755);
  const state = {
    keyringVariable: "PGCF_TEST_KEYS",
    databases: overrides.databases ?? [
      { uuid: LIVE_DATABASE, name: "pgcf-control" },
      { uuid: SCRATCH_DATABASE, name: "pgcf-restore-drill" },
    ],
    failImport: overrides.failImport ?? false,
    hold: overrides.hold,
    calls: [] as {
      args: string[];
      cwd: string;
      keyring: boolean;
      file?: {
        mode: number;
        directoryMode: number;
        directory: string;
        bytes: number;
        firstInsert: number;
        lastCreate: number;
      };
    }[],
  };
  for (const { uuid } of state.databases) {
    // Every fixture starts from the databases it names, whatever an earlier one left in `dir`.
    await rm(join(dir, `${uuid}.sqlite`), { force: true });
    const sqlite = new DatabaseSync(join(dir, `${uuid}.sqlite`));
    sqlite.exec(overrides.existing?.[uuid] ?? "");
    sqlite.close();
  }
  await writeFile(statePath, JSON.stringify(state));
  return {
    wrangler,
    environment: {
      PATH: process.env.PATH,
      FAKE_WRANGLER_STATE: statePath,
      PGCF_TEST_KEYS: KEYRING,
      CLOUDFLARE_API_TOKEN: "kept-for-wrangler",
    } as Record<string, string | undefined>,
    calls: async () =>
      (JSON.parse(await readFile(statePath, "utf8")) as typeof state).calls,
  };
}

async function inputFile(dir: string) {
  const { bytes } = await artifact(),
    input = join(dir, "d1-control.pgcfenc");
  await writeFile(input, bytes);
  return input;
}

test("imports into an empty scratch database through a private file, by its ID, and removes the file", async () => {
  const { dir, done } = await workspace();
  try {
    const fixture = await wranglerFixture(dir),
      lines: string[] = [];
    const result = await importArtifact(
      {
        input: await inputFile(dir),
        keyring: KEYRING,
        keysEnvironment: "PGCF_TEST_KEYS",
        database: "pgcf-restore-drill",
        wrangler: fixture.wrangler,
      },
      { environment: fixture.environment, log: (line) => lines.push(line) },
    );
    assert.equal(result.database_id, SCRATCH_DATABASE);
    // The dump has two tables and an index; what is counted is the tables, as it is printed.
    assert.equal(result.tables, 2);
    const calls = await fixture.calls(),
      imported = calls.find((call) => call.file)!;
    // The import names the database by the ID that was checked, never by name or binding, so a
    // wrangler configuration cannot redirect it; it runs against the remote database from a
    // directory that holds no configuration.
    assert.equal(imported.args[2], SCRATCH_DATABASE);
    assert.ok(imported.args.includes("--remote"));
    assert.ok(imported.args.includes("--yes"));
    assert.ok(!imported.args.includes("--local"));
    assert.ok(
      !calls.some(
        (call) =>
          call.args.includes("pgcf-restore-drill") &&
          call.args[1] === "execute",
      ),
    );
    assert.equal(imported.file!.mode, 0o600);
    assert.equal(imported.file!.directoryMode, 0o700);
    // The file is the artifact's SQL with its CREATE TABLE statements ahead of the rows: the same
    // bytes, in another order.
    assert.equal(imported.file!.bytes, DUMP.length);
    assert.ok(imported.file!.lastCreate < imported.file!.firstInsert);
    assert.equal(imported.cwd, imported.file!.directory);
    assert.ok(
      !calls.some((call) => call.keyring),
      "the keyring reached wrangler",
    );
    assert.equal(
      await stat(imported.file!.directory).catch(() => null),
      null,
      "the decrypted file stays",
    );
    // Nothing the tool prints holds the SQL, a value from it or the key.
    const printed = lines.join("\n");
    assert.ok(!printed.includes("bucket-secret-name"));
    assert.ok(!printed.includes("INSERT INTO"));
    assert.ok(!printed.includes(JSON.parse(KEYRING).keys.v2));
    assert.match(printed, /imported: 2 tables/);
    // What the runbook has the operator write into the plan is printed (day, byte counts, hashes),
    // and the live control database's ID is not: the artifact names it, and nothing needs it shown.
    assert.ok(printed.includes("day 2026-10-20"));
    assert.ok(printed.includes(`${DUMP.length} bytes, sha256 ${sha256(DUMP)}`));
    assert.ok(printed.includes(`sha256 ${result.artifact.encrypted_sha256}`));
    assert.ok(printed.includes("receipt: not given"));
    assert.ok(!printed.includes(LIVE_DATABASE));
  } finally {
    await done();
  }
});

test("never imports into the database the artifact was exported from, into one with tables, or into one it cannot find", async () => {
  const { dir, done } = await workspace();
  try {
    const input = await inputFile(dir),
      go = async (
        database: string,
        overrides: Parameters<typeof wranglerFixture>[1] = {},
      ) => {
        const fixture = await wranglerFixture(dir, overrides);
        return {
          fixture,
          outcome: importArtifact(
            {
              input,
              keyring: KEYRING,
              keysEnvironment: "PGCF_TEST_KEYS",
              database,
              wrangler: fixture.wrangler,
            },
            { environment: fixture.environment, log: () => {} },
          ),
        };
      };
    // The live control database, under its own name.
    const live = await go("pgcf-control");
    await assert.rejects(live.outcome, refused("live_database"));
    assert.ok(!(await live.fixture.calls()).some((call) => call.file));
    // A database that is not empty, even when it is not the one exported: it counts what is there
    // (two tables and an index) and says so.
    const full = await go("pgcf-restore-drill", {
      existing: {
        [SCRATCH_DATABASE]:
          "CREATE TABLE a (x); CREATE TABLE b (x); CREATE INDEX a_x ON a (x);",
      },
    });
    await assert.rejects(
      full.outcome,
      (error) =>
        refused("database_not_empty")(error) &&
        /already has 3 schema objects/.test((error as Error).message),
    );
    assert.ok(!(await full.fixture.calls()).some((call) => call.file));
    // A name that resolves to nothing, and one that resolves to two.
    await assert.rejects(
      (await go("no-such-database")).outcome,
      refused("database_not_found"),
    );
    await assert.rejects(
      (
        await go("pgcf-restore-drill", {
          databases: [
            { uuid: SCRATCH_DATABASE, name: "pgcf-restore-drill" },
            { uuid: randomUUID(), name: "pgcf-restore-drill" },
          ],
        })
      ).outcome,
      refused("database_not_found"),
    );
    // A failed import prints wrangler's exit code and none of its text, which can quote the SQL.
    const lines: string[] = [];
    const failing = await wranglerFixture(dir, { failImport: true });
    await assert.rejects(
      importArtifact(
        {
          input,
          keyring: KEYRING,
          keysEnvironment: "PGCF_TEST_KEYS",
          database: "pgcf-restore-drill",
          wrangler: failing.wrangler,
        },
        { environment: failing.environment, log: (line) => lines.push(line) },
      ),
      (error) =>
        refused("wrangler_failed")(error) &&
        !(error as Error).message.includes("PRAGMA") &&
        !(error as Error).message.includes("SQLITE_ERROR"),
    );
    assert.ok(!lines.join("\n").includes("PRAGMA"));
    const failed = (await failing.calls()).find((call) => call.file)!;
    assert.equal(await stat(failed.file!.directory).catch(() => null), null);
  } finally {
    await done();
  }
});

test("takes the keyring from a named environment variable only, and never echoes a value", async () => {
  const argv = (...rest: string[]) => [
    "decrypt",
    "--input",
    "in.pgcfenc",
    "--output",
    "out.sql",
    ...rest,
  ];
  assert.equal(
    parseOptions(argv("--keys-env", "PGCF_KEYS")).keysEnvironment,
    "PGCF_KEYS",
  );
  assert.throws(() => parseOptions(argv()), /--keys-env/);
  // A keyring where the name belongs is refused by what it is, without quoting it.
  assert.throws(
    () => parseOptions(argv("--keys-env", KEYRING)),
    (error) =>
      error instanceof Error &&
      /name of an environment variable/.test(error.message) &&
      !error.message.includes(JSON.parse(KEYRING).keys.v1),
  );
  assert.throws(() => keyringFromEnvironment({}, "PGCF_KEYS"), /set PGCF_KEYS/);
  const malformed = [
    "not json, secret-looking text",
    JSON.stringify({ keys: {} }),
    JSON.stringify({ active: "v1", keys: { v1: "AAAA" } }),
  ];
  for (const value of malformed)
    assert.throws(
      () => keyringFromEnvironment({ PGCF_KEYS: value }, "PGCF_KEYS"),
      (error) =>
        error instanceof RestoreError &&
        error.code === "keyring_invalid" &&
        error.message.includes("PGCF_KEYS") &&
        !error.message.includes("secret-looking") &&
        !error.message.includes("AAAA"),
    );
  assert.equal(
    keyringFromEnvironment({ PGCF_KEYS: KEYRING }, "PGCF_KEYS"),
    KEYRING,
  );
  const database = (...rest: string[]) => [
    "import",
    "--input",
    "in.pgcfenc",
    "--keys-env",
    "PGCF_KEYS",
    ...rest,
  ];
  assert.throws(() => parseOptions(database()), /--database/);
  assert.throws(
    () => parseOptions(database("--database", "has space")),
    /--database/,
  );
  assert.throws(
    () => parseOptions(["decrypt", "--keys-env", "PGCF_KEYS", "--input", "a"]),
    /--output/,
  );
  assert.equal(
    parseOptions(database("--database", "pgcf-restore-drill")).mode,
    "import",
  );
});

test("the command line decrypts a file with a key from the environment and prints no secret", async () => {
  const { dir, done } = await workspace();
  try {
    const input = await inputFile(dir),
      output = join(dir, "restore.sql"),
      script = new URL("./restore-infrastructure-backup.ts", import.meta.url)
        .pathname,
      run = (environment: Record<string, string>, ...rest: string[]) =>
        promisify(execFile)(
          process.execPath,
          [script, "decrypt", "--input", input, "--output", output, ...rest],
          { env: { PATH: process.env.PATH, ...environment } },
        );
    const done1 = await run(
      { PGCF_TEST_KEYS: KEYRING },
      "--keys-env",
      "PGCF_TEST_KEYS",
    );
    assert.deepEqual(await readFile(output), DUMP);
    assert.ok(done1.stdout.includes(RUN));
    assert.ok(
      !(done1.stdout + done1.stderr).includes(JSON.parse(KEYRING).keys.v2),
    );
    await rm(output);
    const wrong = JSON.stringify({
      active: "v2",
      keys: { v2: randomBytes(32).toString("base64url") },
    });
    const failure = await run(
      { PGCF_TEST_KEYS: wrong },
      "--keys-env",
      "PGCF_TEST_KEYS",
    ).then(
      () => assert.fail("it must fail"),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /authentication failed/);
    assert.ok(
      !(failure.stdout + failure.stderr).includes(JSON.parse(wrong).keys.v2),
    );
    assert.deepEqual(await readdir(dir).then((names) => names.sort()), [
      "d1-control.pgcfenc",
    ]);
  } finally {
    await done();
  }
});

test("a signal removes the decrypted SQL and stops wrangler, and the run ends with the signal's exit code", async () => {
  const script = new URL("./restore-infrastructure-backup.ts", import.meta.url)
      .pathname,
    until = async (condition: () => boolean | Promise<boolean>) => {
      for (let tries = 0; tries < 500; tries++) {
        if (await condition()) return;
        await new Promise((done) => setTimeout(done, 20));
      }
      assert.fail("timed out");
    },
    alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const { dir, done } = await workspace(),
      holding = join(dir, "holding"),
      temporary = join(dir, "tmp");
    let pid: number | undefined;
    try {
      await mkdir(temporary);
      const fixture = await wranglerFixture(dir, { hold: holding }),
        child = spawn(
          process.execPath,
          [
            script,
            "import",
            "--input",
            await inputFile(dir),
            "--database",
            "pgcf-restore-drill",
            "--keys-env",
            "PGCF_TEST_KEYS",
            "--wrangler",
            fixture.wrangler,
          ],
          {
            env: { ...fixture.environment, TMPDIR: temporary } as Record<
              string,
              string
            >,
            stdio: ["ignore", "ignore", "ignore"],
          },
        ),
        exited = once(child, "exit");
      // Wrangler is inside the import: the decrypted SQL is on disk in the private directory.
      await until(() =>
        readFile(holding).then(
          () => true,
          () => false,
        ),
      );
      pid = Number(await readFile(holding, "utf8"));
      const names = await readdir(temporary);
      assert.equal(names.length, 1);
      const directory = names[0]!;
      assert.ok(directory.startsWith("pgcf-restore-"));
      assert.deepEqual(await readdir(join(temporary, directory)), [
        "ordered.sql",
      ]);
      child.kill(signal);
      const [code, killedBy] = await exited;
      assert.equal(killedBy, null, `${signal} ended the process by default`);
      assert.equal(code, 128 + constants.signals[signal]);
      assert.deepEqual(await readdir(temporary), [], "the SQL stays");
      await until(() => !alive(pid!));
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      await done();
    }
  }
});
