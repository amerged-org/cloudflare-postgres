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
  chunkSql,
  keyringFromEnvironment,
  loadOrder,
  parseOptions,
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
  // The body's second statement begins with INSERT, as a row of the dump does.
  `CREATE TRIGGER child_audit AFTER INSERT ON child BEGIN SELECT 1; INSERT INTO log("odd;name") VALUES(NEW.id); END;`,
  "",
].join("\n");

/** The provider's way: every file its own transaction, foreign keys enforced. */
async function loadChunks(chunks: { path: string }[]) {
  const db = new DatabaseSync(":memory:");
  for (const { path } of chunks) {
    db.exec("BEGIN;");
    try {
      db.exec(await readFile(path, "utf8"));
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
  return db;
}
/** The dump as a shell would take it: one file, foreign keys not enforced. */
function loadWhole(sql: string) {
  const db = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: false,
  });
  db.exec(sql);
  return db;
}
// The dump's pragma, which opens every chunk, and the line break the chunk adds after it.
const PRAGMA_STATEMENT = "PRAGMA defer_foreign_keys=TRUE;",
  PREAMBLE = `${PRAGMA_STATEMENT}\n`;

const OUT_OF_ORDER_BYTES = Buffer.from(OUT_OF_ORDER);

test("orders tables parents first, keeps the creation order otherwise and groups the tables that cannot be ordered", () => {
  const table = (name: string, ...parents: string[]) => ({ name, parents }),
    one = (name: string) => ({ tables: [name], together: false });
  // A migration that rebuilt `regions` leaves it after the tables that reference it.
  assert.deepEqual(
    loadOrder([
      table("nodes", "regions"),
      table("databases", "regions", "nodes"),
      table("regions"),
      table("audit"),
    ]),
    [one("regions"), one("nodes"), one("databases"), one("audit")],
  );
  // Tables that reference each other, a table that references itself, a parent the dump does not
  // hold, and a parent named in another case are told apart.
  assert.deepEqual(
    loadOrder([
      table("x", "y"),
      table("y", "x"),
      table("z", "X"),
      table("tree", "tree"),
      table("ghost", "missing"),
    ]),
    [
      { tables: ["x", "y"], together: true },
      one("z"),
      { tables: ["tree"], together: true },
      one("ghost"),
    ],
  );
});

test("splits the dump at statement boundaries into chunks that load one by one and equal the dump, whatever the quoting and reading", async () => {
  const { dir, done } = await workspace();
  try {
    // The dump as one transaction is what `defer_foreign_keys` is for; as separate transactions its
    // first chunk of rows meets a parent that is not there yet.
    const raw = new DatabaseSync(":memory:");
    assert.throws(
      () => raw.exec("BEGIN;\n" + OUT_OF_ORDER + "\nCOMMIT;"),
      /no such table/,
    );
    raw.close();
    const input = join(dir, "dump.sql");
    await writeFile(input, OUT_OF_ORDER);
    let first: string[] | undefined,
      firstPlan: Awaited<ReturnType<typeof chunkSql>> | undefined;
    // One byte at a time puts a read boundary inside every two-byte token and every quote.
    for (const readBytes of [1, 2, 3, 7, 64, 1 << 20]) {
      const directory = join(dir, `read-${readBytes}`);
      await mkdir(directory, { mode: 0o700 });
      const plan = await chunkSql(input, directory, {
          chunkBytes: 150,
          chunkStatements: 3,
          readBytes,
        }),
        texts = await Promise.all(
          plan.chunks.map(({ path }) => readFile(path, "utf8")),
        );
      assert.equal(plan.tables, 4, `read ${readBytes}`);
      assert.equal(plan.moved, 3, `read ${readBytes}`);
      first ??= texts;
      firstPlan ??= plan;
      assert.deepEqual(texts, first, `read ${readBytes} differs`);
      for (const chunk of plan.chunks)
        assert.equal((await stat(chunk.path)).mode & 0o777, 0o600);
      // The bounds hold for everything but the schema's last chunk of indexes and triggers, which
      // is never cut; every chunk opens with the dump's own pragma.
      for (const chunk of plan.chunks.slice(0, -1))
        assert.ok(
          chunk.statements <= 3 && chunk.bytes <= 150 + PREAMBLE.length,
        );
      assert.ok(plan.chunks.length >= 6);
    }
    const texts = first!;
    for (const text of texts) assert.ok(text.startsWith(PREAMBLE));
    // Not a byte lost or doubled: the statements are the dump's, the pragma is repeated.
    assert.equal(
      texts.reduce(
        (sum, text) => sum + Buffer.byteLength(text) - PREAMBLE.length,
        0,
      ) +
        PREAMBLE.length -
        1,
      OUT_OF_ORDER.length,
    );
    // The first chunks hold the tables, the last the objects the dump put after its rows.
    assert.ok(!texts[0]!.includes("INSERT"));
    assert.ok(texts.at(-1)!.includes("CREATE TRIGGER child_audit"));
    assert.ok(texts.at(-1)!.includes("CREATE INDEX child_parent"));
    const loaded = await loadChunks(firstPlan!.chunks),
      whole = loadWhole(OUT_OF_ORDER);
    assert.deepEqual(snapshot(loaded), snapshot(whole));
    assert.deepEqual(
      loaded
        .prepare("SELECT id, note FROM parent ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        { id: "p1", note: "a; CREATE TABLE evil (x); -- not a comment" },
        {
          id: "p2",
          note: `it's "quoted"; /* nor this */ and\na second line; CREATE TABLE evil2 (x);`,
        },
      ],
    );
    assert.deepEqual(
      loaded
        .prepare("SELECT name, seq FROM sqlite_sequence WHERE name = 'log'")
        .all()
        .map((row) => ({ ...row })),
      [{ name: "log", seq: 7 }],
    );
    loaded.close();
    whole.close();
  } finally {
    await done();
  }
});

test("cuts a chunk at the statement bound when the byte bound is far away", async () => {
  const { dir, done } = await workspace();
  try {
    const input = join(dir, "dump.sql");
    await writeFile(input, OUT_OF_ORDER);
    // The whole dump is far below a megabyte, so only the three statements can cut a chunk.
    const plan = await chunkSql(input, dir, {
      chunkBytes: 1 << 20,
      chunkStatements: 3,
    });
    // The last chunk is the rest (sequences, indexes, triggers), which is never cut.
    const bounded = plan.chunks.slice(0, -1).map((chunk) => chunk.statements);
    assert.ok(bounded.length >= 3, `${bounded}`);
    assert.ok(
      bounded.every((n) => n <= 3),
      `${bounded}`,
    );
    assert.equal(Math.max(...bounded), 3);
    assert.ok(plan.chunks.every((chunk) => chunk.bytes < 1 << 20));
    const loaded = await loadChunks(plan.chunks),
      whole = loadWhole(OUT_OF_ORDER);
    assert.deepEqual(snapshot(loaded), snapshot(whole));
    loaded.close();
    whole.close();
  } finally {
    await done();
  }
});

test("keeps the tables that reference each other, or themselves, in one chunk whatever the bound, and reads every way a table is named", async () => {
  const { dir, done } = await workspace();
  try {
    const dump = [
        "PRAGMA defer_foreign_keys=TRUE;",
        "CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b(id));",
        "CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));",
        "CREATE TABLE tree (id INTEGER PRIMARY KEY, up INTEGER REFERENCES tree(id));",
        `CREATE TABLE "odd ""name""" (x INTEGER);`,
        "CREATE TABLE `tick` (x INTEGER);",
        "CREATE TABLE [br] (x INTEGER);",
        `INSERT INTO "a" VALUES(1,1);`,
        "INSERT INTO B VALUES(1,1);",
        "INSERT INTO a VALUES(2,1);",
        `INSERT INTO "tree" VALUES(1,2);`,
        `INSERT INTO "tree" VALUES(2,NULL);`,
        `INSERT INTO "odd ""name""" VALUES(1);`,
        "INSERT INTO `tick` VALUES(1);",
        "INSERT INTO [br] VALUES(1);",
        "",
      ].join("\n"),
      input = join(dir, "dump.sql");
    await writeFile(input, dump);
    // Chunks of one statement, so that only the rule keeps these rows together.
    const plan = await chunkSql(input, dir, {
      chunkBytes: 1,
      chunkStatements: 1,
    });
    assert.deepEqual(plan.together, [["a", "b"], ["tree"]]);
    const rows = await Promise.all(
      plan.chunks.map(async ({ path }) => {
        const text = await readFile(path, "utf8");
        return {
          a: (text.match(/INSERT INTO "?[aAbB]"? VALUES/g) ?? []).length,
          tree: (text.match(/INSERT INTO "tree"/g) ?? []).length,
        };
      }),
    );
    assert.deepEqual(
      rows.filter((chunk) => chunk.a + chunk.tree > 0),
      [
        { a: 3, tree: 0 },
        { a: 0, tree: 2 },
      ],
    );
    const loaded = await loadChunks(plan.chunks),
      whole = loadWhole(dump);
    assert.deepEqual(snapshot(loaded), snapshot(whole));
    loaded.close();
    whole.close();
  } finally {
    await done();
  }
});

// A wrangler that speaks the forms the real one prints for `d1 list --json` and `d1 execute
// --json`, runs what it is given in a real SQLite database per D1 database (a file is loaded as
// one transaction, and a failure rolls it back), and records what it was asked and what the file it
// was given looked like at that time. With `hold` set it stops inside the import, as a slow one does.
// Like the provider, it resets the database when one file is too large (`maxFileBytes`): exit code 1
// with the body {"D1_RESET_DO":true} and nothing written (the live drill of 2026-10-20 on a 31 MB
// file); `failImportCall` fails the import call of that number; `looseForeignKeys` is a database
// that does not enforce foreign keys while it loads, which the provider is not.
const FAKE_WRANGLER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
// wrangler's bin/wrangler.js answers SIGTERM by killing the real CLI and then calling
// process.exit(code ?? 0): a stopped wrangler exits with code 0 (measured against wrangler 4.145 on
// a remote import), and with 143 on a local one, not by the signal.
if (process.env.FAKE_WRANGLER_TERM_EXIT_CODE) process.on("SIGTERM", () => process.exit(Number(process.env.FAKE_WRANGLER_TERM_EXIT_CODE)));
const args = process.argv.slice(2);
const statePath = process.env.FAKE_WRANGLER_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const record = { args, cwd: fs.realpathSync(process.cwd()), keyring: process.env[state.keyringVariable] !== undefined };
const flag = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const save = () => { state.calls.push(record); fs.writeFileSync(statePath, JSON.stringify(state)); };
// wrangler 4.145 prints a progress block before the JSON array of a remote file execution, even with
// --json (measured live, 2026-10-20): the double does the same, so the tool must find the JSON itself.
const progress = () => (args.includes("--remote") && args.includes("--file")
  ? ["\\u251c Checking if file needs uploading", "\\u2502", "\\u251c Uploading 822e9fbd.sql", "\\u2502 Uploading complete.", "\\u2502", ""].join("\\n") : "");
const out = (value) => { save(); process.stdout.write(progress() + JSON.stringify(value, null, 2) + "\\n"); };
if (args[0] === "d1" && args[1] === "list") {
  out(state.databases);
} else if (args[0] === "d1" && args[1] === "execute") {
  const database = state.databases.find((db) => db.uuid === args[2]);
  if (!database) { save(); process.stderr.write("Couldn't find a D1 DB with name or binding\\n"); process.exit(1); }
  const db = new DatabaseSync(path.join(path.dirname(statePath), database.uuid + ".sqlite"), { enableForeignKeyConstraints: !state.looseForeignKeys });
  if (flag("--file")) {
    const file = flag("--file");
    const text = fs.readFileSync(file);
    const number = state.calls.filter((call) => call.file).length + 1;
    record.file = {
      mode: fs.statSync(file).mode & 0o777,
      directoryMode: fs.statSync(path.dirname(file)).mode & 0o777,
      directory: fs.realpathSync(path.dirname(file)),
      bytes: text.length,
      firstInsert: text.indexOf("INSERT INTO"),
      lastCreate: text.lastIndexOf("CREATE TABLE"),
      inserts: (text.toString("utf8").match(/^INSERT INTO /gm) || []).length,
    };
    if (state.hold) { save(); fs.writeFileSync(state.hold + ".tmp", String(process.pid)); fs.renameSync(state.hold + ".tmp", state.hold); setInterval(() => {}, 1000); return; }
    if (state.failImport || state.failImportCall === number) { save(); process.stderr.write("SQLITE_ERROR near " + text.toString("utf8", 0, 40) + "\\n"); process.exit(1); }
    if (state.maxFileBytes && text.length > state.maxFileBytes) { save(); (state.resetOnStderr ? process.stderr : process.stdout).write(JSON.stringify(state.resetBody ?? { D1_RESET_DO: true }) + "\\n"); process.exit(1); }
    db.exec("BEGIN;");
    try { db.exec(text.toString("utf8")); db.exec("COMMIT;"); }
    catch (error) { db.exec("ROLLBACK;"); save(); process.stderr.write(String(error.message) + "\\n"); process.exit(1); }
    const written = db.prepare("SELECT total_changes() AS n").get().n;
    out([{ results: [{ "Total queries executed": text.toString("utf8").split("\\n").length, "Rows read": 0, "Rows written": written, "Database size (MB)": "0.31" }], success: true, finalBookmark: "00000001-00000002-0000000a-abc", meta: { duration: 12.5 } }]);
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
    /** The number (from 1) of the import call that fails. */
    failImportCall?: number;
    /** Imports of a file larger than this reset the database, as the provider does. */
    maxFileBytes?: number;
    /** The reset body goes to stderr instead of stdout. */
    resetOnStderr?: boolean;
    /** What the double prints on a reset; the default is the body of the live drill. */
    resetBody?: unknown;
    looseForeignKeys?: boolean;
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
    failImportCall: overrides.failImportCall,
    maxFileBytes: overrides.maxFileBytes,
    resetOnStderr: overrides.resetOnStderr ?? false,
    resetBody: overrides.resetBody,
    looseForeignKeys: overrides.looseForeignKeys ?? false,
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
        inserts: number;
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

// A dump the provider cannot take as one file. Its tables are in the order a migration that rebuilt
// them leaves: `samples` (24,000 rows, the bulk) is created before `databases`, which is created
// before `regions`, so each child's rows come before its parent's. The literals hold semicolons,
// quotes, comment markers and line breaks, and the trigger's body holds an INSERT of its own.
const BIG = Buffer.from(
  [
    "PRAGMA defer_foreign_keys=TRUE;",
    "CREATE TABLE samples (id INTEGER PRIMARY KEY, database_id TEXT NOT NULL REFERENCES databases(id), note TEXT NOT NULL);",
    ...Array.from(
      { length: 24000 },
      (_, i) =>
        `INSERT INTO "samples" VALUES(${i},'d${i % 400}','row ${i}; it''s "second"\nline with '';'' and -- not a comment ${"x".repeat(120)}');`,
    ),
    "CREATE TABLE databases (id TEXT PRIMARY KEY, region_id TEXT NOT NULL REFERENCES regions(id));",
    ...Array.from(
      { length: 400 },
      (_, i) => `INSERT INTO "databases" VALUES('d${i}','r${i % 3}');`,
    ),
    "CREATE TABLE regions (id TEXT PRIMARY KEY);",
    ...["r0", "r1", "r2"].map((id) => `INSERT INTO "regions" VALUES('${id}');`),
    "CREATE TABLE audit (n INTEGER);",
    `INSERT INTO "audit" VALUES(0);`,
    "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL);",
    ...Array.from(
      { length: 100 },
      (_, i) => `INSERT INTO "events" VALUES(${i + 1},'k');`,
    ),
    "DELETE FROM sqlite_sequence;",
    `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('events',250);`,
    "CREATE INDEX samples_database ON samples (database_id);",
    "CREATE TRIGGER samples_audit AFTER INSERT ON samples BEGIN INSERT INTO audit(n) VALUES(NEW.id); END;",
    "",
  ].join("\n"),
);

/** Everything a database holds that the dump defines: its objects, its rows by table, its sequences. */
function snapshot(db: DatabaseSync) {
  const plain = (rows: unknown[]) =>
      rows.map((row) => ({ ...(row as object) })),
    objects = plain(
      db
        .prepare(
          String.raw`SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\' ORDER BY name`,
        )
        .all(),
    ) as { type: string; name: string }[];
  return {
    objects,
    tables: Object.fromEntries(
      objects
        .filter((object) => object.type === "table")
        .map(({ name }) => [
          name,
          plain(
            db
              .prepare(
                `SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`,
              )
              .all(),
          ),
        ]),
    ),
    // The table exists once a table with AUTOINCREMENT does.
    sequence: db
      .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'")
      .get()
      ? plain(
          db
            .prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name")
            .all(),
        )
      : [],
  };
}

test("imports a dump the provider resets as one file in bounded chunks, parents first, and the result equals the dump", async () => {
  const { dir, done } = await workspace();
  try {
    // The live drill of 2026-10-20 failed at 31 MB with D1_RESET_DO; the double resets at 3 MiB.
    const reset = 3 * 1024 * 1024,
      { bytes } = await artifact(BIG, { chunk: 64 * 1024 }),
      input = join(dir, "d1-control.pgcfenc"),
      lines: string[] = [];
    assert.ok(BIG.length > 1.5 * reset, "the dump must not fit one file");
    await writeFile(input, bytes);
    const fixture = await wranglerFixture(dir, { maxFileBytes: reset }),
      result = await importArtifact(
        {
          input,
          keyring: KEYRING,
          keysEnvironment: "PGCF_TEST_KEYS",
          database: "pgcf-restore-drill",
          wrangler: fixture.wrangler,
        },
        { environment: fixture.environment, log: (line) => lines.push(line) },
      ),
      calls = await fixture.calls(),
      imports = calls.filter((call) => call.file);
    assert.equal(result.tables, 5);
    // The schema, at least three chunks of rows and the indexes and triggers.
    assert.ok(imports.length >= 5, `${imports.length} imports`);
    for (const call of imports) {
      assert.ok(call.file!.bytes <= 2 * 1024 * 1024 + 1024);
      assert.equal(call.file!.mode, 0o600);
      assert.equal(call.file!.directoryMode, 0o700);
      assert.equal(await stat(call.file!.directory).catch(() => null), null);
    }
    assert.equal(
      imports[0]!.file!.firstInsert,
      -1,
      "the first chunk is schema",
    );
    // The statement bound applies where the byte bound is far away: this dump's rows are about
    // 230 bytes, so 5,000 of them are 1.1 MB, and without the bound a chunk would take 9,000.
    const rowStatements = imports.map((call) => call.file!.inserts);
    assert.ok(
      rowStatements.every((n) => n <= 5000),
      `${rowStatements}`,
    );
    assert.equal(Math.max(...rowStatements), 5000);
    // The foreign key check is asked of the scratch database, by its ID, after the last chunk.
    const check = calls.findIndex((call) =>
      call.args.includes("PRAGMA foreign_key_check"),
    );
    assert.equal(calls[check]!.args[2], SCRATCH_DATABASE);
    assert.ok(check > calls.lastIndexOf(imports.at(-1)!));
    const scratch = new DatabaseSync(join(dir, `${SCRATCH_DATABASE}.sqlite`)),
      reference = new DatabaseSync(":memory:", {
        enableForeignKeyConstraints: false,
      });
    reference.exec(BIG.toString("utf8"));
    assert.deepEqual(snapshot(scratch), snapshot(reference));
    assert.deepEqual(scratch.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      (
        scratch.prepare("SELECT count(*) AS n FROM audit").get() as {
          n: number;
        }
      ).n,
      1,
      "the trigger fired during the import",
    );
    scratch.close();
    reference.close();
    const printed = lines.join("\n");
    assert.ok(!printed.includes("INSERT INTO"));
    assert.ok(!printed.includes("not a comment"));
  } finally {
    await done();
  }
});

// D1 takes a statement of at most 100,000 bytes. The first complete backup (2026-10-20) held an
// INSERT of 127,397 bytes (the answer to a journal probe) and one boot report of 212,685 bytes in
// the table of the diagnostics, and chunk 16 of 18 failed with SQLITE_TOOBIG after 15 had been
// imported. A row of `bytes` bytes as the dump writes it, with a marker in it that must never be
// printed.
const D1_STATEMENT_MAX = 100_000;
function row(table: string, id: string, bytes: number) {
  const head = `INSERT INTO "${table}" VALUES('${id}','SECRET-BODY-CONTENT`,
    tail = `');`;
  return head + "x".repeat(bytes - head.length - tail.length) + tail;
}
const overlong = (...rows: string[]) =>
  Buffer.from(
    [
      "PRAGMA defer_foreign_keys=TRUE;",
      "CREATE TABLE node_diagnostic_requests (id TEXT PRIMARY KEY, body TEXT);",
      "CREATE TABLE node_diagnostics (id TEXT PRIMARY KEY, body TEXT);",
      `INSERT INTO "node_diagnostic_requests" VALUES('small','a small answer');`,
      ...rows,
      "",
    ].join("\n"),
  );

test("measures a statement without the line break before it, and takes one of exactly 100,000 bytes", async () => {
  const { dir, done } = await workspace();
  try {
    const input = join(dir, "dump.sql");
    await writeFile(
      input,
      overlong(row("node_diagnostics", "edge", D1_STATEMENT_MAX)),
    );
    const plan = await chunkSql(input, dir);
    assert.equal(plan.largest, D1_STATEMENT_MAX);
  } finally {
    await done();
  }
});

test("stops before importing anything when a statement is above what D1 takes, names the table and the size and never the content, and says what to do", async () => {
  const { dir, done } = await workspace();
  try {
    const { bytes } = await artifact(
        overlong(
          row("node_diagnostic_requests", "request", 127_397),
          row("node_diagnostics", "just-fits", D1_STATEMENT_MAX),
          row("node_diagnostics", "crash", 212_685),
          row("node_diagnostics", "one-over", D1_STATEMENT_MAX + 1),
        ),
      ),
      input = join(dir, "d1-control.pgcfenc"),
      lines: string[] = [];
    await writeFile(input, bytes);
    const fixture = await wranglerFixture(dir);
    await assert.rejects(
      importArtifact(
        {
          input,
          keyring: KEYRING,
          keysEnvironment: "PGCF_TEST_KEYS",
          database: "pgcf-restore-drill",
          wrangler: fixture.wrangler,
        },
        { environment: fixture.environment, log: (line) => lines.push(line) },
      ),
      (error) => {
        assert.ok(refused("statement_too_large")(error), String(error));
        const message = (error as Error).message;
        // The table and the size of each statement above the bound: the largest of a table, and how
        // many there are; the statement that just fits is not one of them.
        assert.match(
          message,
          /node_diagnostic_requests: 1 statement, the largest 127397 bytes/,
        );
        assert.match(
          message,
          /node_diagnostics: 2 statements, the largest 212685 bytes/,
        );
        assert.match(message, /nothing was imported/);
        // What to do: delete the row if the table holds diagnostics, else ask for support, and never
        // cut the dump.
        assert.match(message, /delete the row from the live database/);
        assert.match(message, /node_diagnostics or node_diagnostic_requests/);
        assert.match(message, /support/);
        assert.match(message, /not .*cut the dump/i);
        // Never a byte of the statement.
        assert.ok(
          !/SECRET-BODY-CONTENT|INSERT|VALUES|xxxx/.test(message),
          message,
        );
        return true;
      },
    );
    assert.ok(
      !(await fixture.calls()).some((call) => call.file),
      "a chunk was imported",
    );
    assert.ok(!lines.join("\n").includes("SECRET-BODY-CONTENT"));
    // The database is as it was: the next run, with a dump that is fine, imports into it.
    const scratch = new DatabaseSync(join(dir, `${SCRATCH_DATABASE}.sqlite`));
    assert.equal(
      (
        scratch.prepare("SELECT count(*) AS n FROM sqlite_schema").get() as {
          n: number;
        }
      ).n,
      0,
    );
    scratch.close();
  } finally {
    await done();
  }
});

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
      imports = calls.filter((call) => call.file);
    // The schema, the rows (fewer than one chunk holds) and the index are three imports.
    assert.equal(imports.length, 3);
    for (const imported of imports) {
      // Each import names the database by the ID that was checked, never by name or binding, so a
      // wrangler configuration cannot redirect it; it runs against the remote database from a
      // directory that holds no configuration.
      assert.equal(imported.args[2], SCRATCH_DATABASE);
      assert.ok(imported.args.includes("--remote"));
      assert.ok(imported.args.includes("--yes"));
      assert.ok(!imported.args.includes("--local"));
      assert.equal(imported.file!.mode, 0o600);
      assert.equal(imported.file!.directoryMode, 0o700);
      assert.equal(imported.cwd, imported.file!.directory);
      assert.equal(
        await stat(imported.file!.directory).catch(() => null),
        null,
        "the decrypted file stays",
      );
    }
    assert.ok(
      !calls.some(
        (call) =>
          call.args.includes("pgcf-restore-drill") &&
          call.args[1] === "execute",
      ),
    );
    // The chunks are the artifact's SQL: the same statements with the CREATE TABLE statements
    // ahead of the rows, and the dump's pragma at the head of each chunk.
    assert.equal(
      imports.reduce((sum, call) => sum + call.file!.bytes, 0),
      DUMP.length + imports.length * PREAMBLE.length - PRAGMA_STATEMENT.length,
    );
    assert.equal(imports[0]!.file!.firstInsert, -1);
    assert.ok(imports[1]!.file!.firstInsert >= 0);
    assert.equal(imports[1]!.file!.lastCreate, -1);
    assert.ok(
      !calls.some((call) => call.keyring),
      "the keyring reached wrangler",
    );
    // Nothing the tool prints holds the SQL, a value from it or the key.
    const printed = lines.join("\n");
    assert.ok(!printed.includes("bucket-secret-name"));
    assert.ok(!printed.includes("INSERT INTO"));
    assert.ok(!printed.includes(JSON.parse(KEYRING).keys.v2));
    assert.match(printed, /imported: 2 tables/);
    assert.match(printed, /3 chunks/);
    assert.match(printed, /foreign_key_check: no violations/);
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
        /chunk 1 of 3/.test((error as Error).message) &&
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

test("stops at the chunk that fails with its number and wrangler's exit code, and does not import again into the half-filled database", async () => {
  const { dir, done } = await workspace();
  try {
    const { bytes } = await artifact(OUT_OF_ORDER_BYTES),
      input = join(dir, "d1-control.pgcfenc");
    await writeFile(input, bytes);
    const fixture = await wranglerFixture(dir, { failImportCall: 3 }),
      go = () =>
        importArtifact(
          {
            input,
            keyring: KEYRING,
            keysEnvironment: "PGCF_TEST_KEYS",
            database: "pgcf-restore-drill",
            wrangler: fixture.wrangler,
            chunkBytes: 150,
            chunkStatements: 3,
          },
          { environment: fixture.environment, log: () => {} },
        );
    await assert.rejects(
      go(),
      (error) =>
        refused("wrangler_failed")(error) &&
        /chunk 3 of \d+/.test((error as Error).message) &&
        /exit code 1/.test((error as Error).message) &&
        /delete/.test((error as Error).message) &&
        !/SQLITE_ERROR|CREATE|INSERT/.test((error as Error).message),
    );
    // Chunks 1 and 2 are in the scratch database, chunk 3 was the last asked, and nothing stays.
    const imports = (await fixture.calls()).filter((call) => call.file);
    assert.equal(imports.length, 3);
    assert.equal(
      await stat(imports[0]!.file!.directory).catch(() => null),
      null,
    );
    const scratch = new DatabaseSync(join(dir, `${SCRATCH_DATABASE}.sqlite`));
    assert.ok(
      (
        scratch.prepare("SELECT count(*) AS n FROM sqlite_schema").get() as {
          n: number;
        }
      ).n > 0,
    );
    scratch.close();
    // A second run on that database is refused before anything is written; the operator deletes it.
    await assert.rejects(go(), refused("database_not_empty"));
    assert.equal((await fixture.calls()).filter((call) => call.file).length, 3);
  } finally {
    await done();
  }
});

test("names the failed chunk's size, and says whether D1 reset the database, without printing wrangler's text", async () => {
  const { dir, done } = await workspace();
  try {
    const { bytes } = await artifact(OUT_OF_ORDER_BYTES),
      input = join(dir, "d1-control.pgcfenc"),
      dump = join(dir, "dump.sql");
    await writeFile(input, bytes);
    await writeFile(dump, OUT_OF_ORDER);
    const bounds = { chunkBytes: 150, chunkStatements: 3 },
      planned = (await chunkSql(dump, dir, bounds)).chunks,
      failure = async (
        overrides: Parameters<typeof wranglerFixture>[1],
      ): Promise<{ message: string; sizes: number[] }> => {
        const fixture = await wranglerFixture(dir, overrides);
        let message = "";
        await assert.rejects(
          importArtifact(
            {
              input,
              keyring: KEYRING,
              keysEnvironment: "PGCF_TEST_KEYS",
              database: "pgcf-restore-drill",
              wrangler: fixture.wrangler,
              ...bounds,
            },
            { environment: fixture.environment, log: () => {} },
          ),
          (error) => {
            message = (error as Error).message;
            return refused("wrangler_failed")(error);
          },
        );
        const sizes = (await fixture.calls())
          .filter((call) => call.file)
          .map((call) => call.file!.bytes);
        return { message, sizes };
      };
    // wrangler's text and the SQL it may quote are never printed, whatever the cause.
    const quiet = (message: string) =>
      assert.ok(
        !/SQLITE_ERROR|PRAGMA|CREATE|INSERT|\{|true/.test(message),
        message,
      );
    // Chunk 3 fails with an SQL error: the size is the chunk's own, and it was not a reset.
    const sql = await failure({ failImportCall: 3 });
    assert.equal(sql.sizes.length, 3);
    assert.ok(
      sql.message.includes(
        `chunk 3 of ${planned.length} failed (${planned[2]!.statements} statements, ${sql.sizes[2]} bytes): `,
      ),
      sql.message,
    );
    assert.equal(sql.sizes[2], planned[2]!.bytes);
    assert.ok(/D1 reset in its output: no/.test(sql.message), sql.message);
    assert.ok(/exit code 1/.test(sql.message), sql.message);
    quiet(sql.message);
    // The provider resets the database on every file: chunk 1, the body on stdout or on stderr.
    for (const resetOnStderr of [false, true]) {
      const reset = await failure({ maxFileBytes: 1, resetOnStderr });
      assert.equal(reset.sizes.length, 1);
      assert.ok(
        reset.message.includes(
          `chunk 1 of ${planned.length} failed (${planned[0]!.statements} statements, ${reset.sizes[0]} bytes): `,
        ),
        reset.message,
      );
      assert.ok(
        /D1 reset in its output: yes/.test(reset.message),
        reset.message,
      );
      assert.ok(/exit code 1/.test(reset.message), reset.message);
      assert.ok(/delete/.test(reset.message), reset.message);
      quiet(reset.message);
    }
    // The provider's other documented resets name no token. Cloudflare's D1 debugging page words
    // them "D1 DB exceeded its CPU time limit and was reset.", "D1 DB's isolate exceeded its memory
    // limit and was reset." and "D1 DB storage operation exceeded timeout which caused object to be
    // reset."; wrangler 4.145 throws "D1 reset before execute completed!" when the import ends
    // unfinished. Each is a reset, whichever stream wrangler writes it to.
    for (const text of [
      "D1 DB exceeded its CPU time limit and was reset.",
      "D1 DB's isolate exceeded its memory limit and was reset.",
      "D1 DB storage operation exceeded timeout which caused object to be reset.",
      "D1 reset before execute completed!",
    ])
      for (const resetOnStderr of [false, true]) {
        const reset = await failure({
          maxFileBytes: 1,
          resetOnStderr,
          resetBody: { error: { text } },
        });
        assert.ok(
          /D1 reset in its output: yes/.test(reset.message),
          `${text}: ${reset.message}`,
        );
        assert.ok(/exit code 1/.test(reset.message), reset.message);
        quiet(reset.message);
        assert.ok(
          !reset.message.includes(text),
          "wrangler's text is not printed",
        );
      }
    // A refusal that is not a reset stays a no.
    const refusedLogin = await failure({
      maxFileBytes: 1,
      resetBody: { error: { text: "Authentication error [code: 10000]" } },
    });
    assert.ok(
      /D1 reset in its output: no/.test(refusedLogin.message),
      refusedLogin.message,
    );
  } finally {
    await done();
  }
});

test("a chunk that outlives the timeout is reported as a timeout, whatever exit code wrangler's launcher answers the stop with", async () => {
  const { dir, done } = await workspace(),
    holding = join(dir, "holding");
  try {
    const { bytes } = await artifact(OUT_OF_ORDER_BYTES),
      input = join(dir, "d1-control.pgcfenc");
    await writeFile(input, bytes);
    // The double never answers the import. Like bin/wrangler.js it ends with exit code 0 when it is
    // stopped (a remote import), or with 143 (a local one), and never by the signal.
    for (const stoppedWith of ["0", "143"]) {
      const fixture = await wranglerFixture(dir, { hold: holding }),
        environment = {
          ...fixture.environment,
          FAKE_WRANGLER_TERM_EXIT_CODE: stoppedWith,
        };
      await assert.rejects(
        importArtifact(
          {
            input,
            keyring: KEYRING,
            keysEnvironment: "PGCF_TEST_KEYS",
            database: "pgcf-restore-drill",
            wrangler: fixture.wrangler,
            chunkBytes: 150,
            chunkStatements: 3,
          },
          { environment, log: () => {}, chunkTimeoutMs: 1500 },
        ),
        (error) =>
          refused("wrangler_failed")(error) &&
          /^chunk 1 of \d+ failed \(\d+ statements, \d+ bytes\): wrangler d1 execute failed \(timeout\); D1 reset in its output: no; delete /.test(
            (error as Error).message,
          ),
        `stopped with exit code ${stoppedWith}`,
      );
      const imports = (await fixture.calls()).filter((call) => call.file);
      assert.equal(imports.length, 1);
      assert.equal(
        await stat(imports[0]!.file!.directory).catch(() => null),
        null,
      );
    }
  } finally {
    await done();
  }
});

test("refuses an import that leaves a foreign key violated, and names the table, never a value", async () => {
  const { dir, done } = await workspace();
  try {
    const dump = Buffer.from(
        [
          "PRAGMA defer_foreign_keys=TRUE;",
          "CREATE TABLE regions (id TEXT PRIMARY KEY);",
          "CREATE TABLE nodes (id TEXT PRIMARY KEY, region_id TEXT REFERENCES regions(id));",
          `INSERT INTO "nodes" VALUES('n-secret','gone');`,
          "",
        ].join("\n"),
      ),
      { bytes } = await artifact(dump),
      input = join(dir, "d1-control.pgcfenc");
    await writeFile(input, bytes);
    // A database that does not enforce foreign keys while it loads; the provider's does.
    const fixture = await wranglerFixture(dir, { looseForeignKeys: true });
    await assert.rejects(
      importArtifact(
        {
          input,
          keyring: KEYRING,
          keysEnvironment: "PGCF_TEST_KEYS",
          database: "pgcf-restore-drill",
          wrangler: fixture.wrangler,
        },
        { environment: fixture.environment, log: () => {} },
      ),
      (error) =>
        refused("foreign_key_violations")(error) &&
        /1 row/.test((error as Error).message) &&
        /nodes/.test((error as Error).message) &&
        !/n-secret|gone/.test((error as Error).message),
    );
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
  // The chunk bounds are whole positive numbers and belong to import.
  const bounded = parseOptions(
    database(
      "--database",
      "pgcf-restore-drill",
      "--chunk-bytes",
      "1048576",
      "--chunk-statements",
      "2500",
    ),
  );
  assert.ok(bounded.mode === "import" && bounded.chunkBytes === 1048576);
  assert.ok(bounded.mode === "import" && bounded.chunkStatements === 2500);
  for (const bad of ["0", "-1", "1.5", "1e6", "many"])
    assert.throws(
      () =>
        parseOptions(
          database("--database", "pgcf-restore-drill", "--chunk-bytes", bad),
        ),
      /--chunk-bytes/,
    );
  assert.throws(
    () =>
      parseOptions(
        argv("--keys-env", "PGCF_KEYS", "--chunk-statements", "100"),
      ),
    /belong to import/,
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
      // kill(0, ...) addresses the caller's whole process group; it must never be reached.
      if (!Number.isInteger(pid) || pid <= 0) return false;
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
      // The fake renames a finished file into place; the pattern also refuses an empty read.
      await until(async () => {
        const text = await readFile(holding, "utf8").catch(() => "");
        if (!/^[1-9]\d*$/.test(text)) return false;
        pid = Number(text);
        return true;
      });
      const names = await readdir(temporary);
      assert.equal(names.length, 1);
      const directory = names[0]!;
      assert.ok(directory.startsWith("pgcf-restore-"));
      // The decrypted SQL is gone; its chunks, all but those already imported, are not.
      assert.deepEqual(await readdir(join(temporary, directory)), [
        "chunk-0001.sql",
        "chunk-0002.sql",
        "chunk-0003.sql",
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
