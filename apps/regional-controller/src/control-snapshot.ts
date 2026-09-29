// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
export type ControlCell =
  | { type: "null"; value: null }
  | { type: "integer" | "real" | "text" | "blob"; value: string };
export interface ControlSchemaObject {
  type: "table" | "index" | "view" | "trigger";
  name: string;
  sql: string | null;
}
export interface MigrationFile {
  name: string;
  sha256: string;
}
export interface MigrationSet {
  files: MigrationFile[];
  sha256: string;
  schema: ControlSchemaObject[];
  tables: {
    name: string;
    columns: string[];
    order: string[];
    withoutRowid: boolean;
  }[];
}
export interface ControlSnapshot {
  version: 1;
  source: { installationId: string; databaseId: string };
  capturedAtUTC: string;
  migrations: { files: MigrationFile[]; sha256: string };
  schema: ControlSchemaObject[];
  tables: { name: string; columns: string[]; rows: ControlCell[][] }[];
  sequences: { name: string; seq: string }[];
  sha256: string;
}
interface SnapshotData {
  schema: ControlSchemaObject[];
  tables: ControlSnapshot["tables"];
  sequences: ControlSnapshot["sequences"];
}
const maximumBytes = 8 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const fail = (code = "control_snapshot_invalid") => new Error(code);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (
  value: unknown,
  keys: string[],
): value is Record<string, unknown> =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
function canonical(value: unknown): string {
  const sort = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(sort)
      : object(entry)
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, value]) => [key, sort(value)]),
          )
        : entry;
  return JSON.stringify(sort(value));
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const schemaWhere = "name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'";
const migratorSql =
  'CREATE TABLE "d1_migrations"(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)';
const trustedSql = new WeakMap<MigrationSet, ControlSchemaObject[]>();
function sqlCanonical(sql: string | null): string | null {
  if (sql === null) return null;
  let result = "",
    delimiter = "",
    space = false;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index]!;
    if (delimiter) {
      result += character;
      if (character === delimiter) {
        if (sql[index + 1] === delimiter) {
          result += delimiter;
          index++;
        } else delimiter = "";
      }
      continue;
    }
    if (
      character === "'" ||
      character === '"' ||
      character === "`" ||
      character === "["
    ) {
      if (space && result) result += " ";
      space = false;
      delimiter = character === "[" ? "]" : character;
      result += character;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index++;
      space = true;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      index += 2;
      while (
        index < sql.length &&
        !(sql[index] === "*" && sql[index + 1] === "/")
      )
        index++;
      index++;
      space = true;
      continue;
    }
    if (/\s/.test(character)) {
      space = true;
      continue;
    }
    if (space && result) result += " ";
    space = false;
    result += character;
  }
  if (delimiter) throw fail();
  return result.trim().replace(/;$/, "");
}
function schemaRows(db: DatabaseSync): ControlSchemaObject[] {
  return db
    .prepare(
      `SELECT type,name,sql FROM sqlite_master WHERE ${schemaWhere} ORDER BY type,name`,
    )
    .all() as unknown as ControlSchemaObject[];
}
function canonicalSchema(rows: ControlSchemaObject[]): ControlSchemaObject[] {
  return rows.map((row) => ({
    type: row.type,
    name: row.name,
    sql: sqlCanonical(row.sql),
  }));
}
function createMemory(): DatabaseSync {
  return new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
}
export async function migrationSet(directory: string): Promise<MigrationSet> {
  if (!isAbsolute(directory)) throw fail("control_snapshot_migrations_invalid");
  const entries = await readdir(directory, { withFileTypes: true }),
    names = entries
      .filter((entry) => entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort();
  if (
    names.length < 1 ||
    names.length > 128 ||
    names.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  )
    throw fail("control_snapshot_migrations_invalid");
  const db = createMemory(),
    files: MigrationFile[] = [];
  let sqlBytes = 0;
  try {
    for (const name of names) {
      const path = join(directory, name),
        stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 95000)
        throw fail("control_snapshot_migrations_invalid");
      const bytes = await readFile(path);
      sqlBytes += bytes.length;
      if (sqlBytes > 512000) throw fail("control_snapshot_migrations_invalid");
      const sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      files.push({ name, sha256: digest(bytes.toString("utf8")) });
      db.exec(sql);
    }
    db.exec(migratorSql);
    const rawSchema = schemaRows(db),
      schema = canonicalSchema(rawSchema),
      tables: MigrationSet["tables"] = [];
    for (const table of schema.filter((row) => row.type === "table")) {
      const columns = db
        .prepare(`PRAGMA table_xinfo(${quote(table.name)})`)
        .all() as unknown as { name: string; hidden: number; pk: number }[];
      const visible = columns.filter((column) => column.hidden === 0),
        withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(table.sql ?? "");
      if (
        visible.length < 1 ||
        new Set(visible.map((column) => column.name)).size !== visible.length
      )
        throw fail();
      if (visible.length > 32) throw fail("control_snapshot_columns_bound");
      const aliases = ["_rowid_", "rowid", "oid"],
        alias = aliases.find(
          (name) =>
            !columns.some((column) => column.name.toLowerCase() === name),
        );
      const order = withoutRowid
        ? columns
            .filter((column) => column.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((column) => column.name)
        : alias
          ? [alias]
          : [];
      if (order.length === 0) throw fail();
      tables.push({
        name: table.name,
        columns: visible.map((column) => column.name),
        order,
        withoutRowid,
      });
    }
    if (tables.length < 1 || tables.length > 128) throw fail();
    const set: MigrationSet = {
      files,
      sha256: digest(canonical(files)),
      schema,
      tables,
    };
    trustedSql.set(set, rawSchema);
    return set;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "control_snapshot_columns_bound"
    )
      throw error;
    throw fail("control_snapshot_migrations_invalid");
  } finally {
    db.close();
  }
}
export function buildSnapshotQuery(set: MigrationSet): string {
  if (!trustedSql.has(set)) throw fail("control_snapshot_migrations_invalid");
  const fragments = set.tables.map((table) => {
    // Short, private projection aliases keep a one-read snapshot below D1's
    // statement bound as trusted migrations add application columns.
    const aliases = table.columns.map((_, index) => quote(`c${index}`));
    const cells = aliases.map((column) => {
      return `json_object('type',typeof(${column}),'value',CASE typeof(${column}) WHEN 'blob' THEN hex(${column}) WHEN 'real' THEN printf('%!.17g',${column}) ELSE CAST(${column} AS TEXT) END)`;
    });
    const selected = table.columns
      .map((name, index) => `${quote(name)} AS ${aliases[index]}`)
      .join(",");
    const ordered = table.order
      .map((name) => `${quote(table.name)}.${quote(name)}`)
      .join(",");
    return `(SELECT json_object('name',${literal(table.name)},'columns',json(${literal(JSON.stringify(table.columns))}),'rows',json((SELECT json_group_array(json_array(${cells.join(",")})) FROM (SELECT ${selected} FROM ${quote(table.name)} ORDER BY ${ordered})))))`;
  });
  const concatenate = (parts: string[]): string => {
    if (parts.length === 1) return parts[0]!;
    const middle = Math.floor(parts.length / 2);
    return `(${concatenate(parts.slice(0, middle))} || ',' || ${concatenate(parts.slice(middle))})`;
  };
  const tables = concatenate(fragments);
  const sql = `SELECT json_object('schema',json((SELECT json_group_array(json_object('name',name,'type',type,'sql',sql)) FROM (SELECT name,type,sql FROM sqlite_master WHERE ${schemaWhere} ORDER BY type,name))),'tables',json('[' || ${tables} || ']'),'sequences',json((SELECT json_group_array(json_object('name',name,'seq',CAST(seq AS TEXT))) FROM (SELECT name,seq FROM sqlite_sequence WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name)))) AS snapshot_json;`;
  // Keep a margin below D1's 100,000-byte SQL statement limit.
  if (Buffer.byteLength(sql, "utf8") > 99000)
    throw fail("control_snapshot_query_bound");
  return sql;
}
export function buildSnapshotRowsQuery(set: MigrationSet): string {
  if (!trustedSql.has(set)) throw fail("control_snapshot_migrations_invalid");
  const schemaRows = `(SELECT json_group_array(json_object('name',name,'type',type,'sql',sql)) FROM (SELECT name,type,sql FROM sqlite_master WHERE ${schemaWhere} ORDER BY type,name))`;
  const sequenceWhere = "name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'";
  const sequenceRows = `(SELECT json_group_array(json_object('name',name,'seq',CAST(seq AS TEXT))) FROM (SELECT name,seq FROM sqlite_sequence WHERE ${sequenceWhere} ORDER BY name))`;
  const parts = [
    `SELECT -1 AS segment,0 AS ordinal,'schema' AS kind,json_object('count',(SELECT count(*) FROM sqlite_master WHERE ${schemaWhere}),'rows',json(${schemaRows})) AS payload`,
  ];
  for (const [index, table] of set.tables.entries()) {
    const aliases = table.columns.map((_, column) => quote(`c${column}`));
    const cells = aliases.map(
      (column) =>
        `json_array(typeof(${column}),CASE typeof(${column}) WHEN 'blob' THEN hex(${column}) WHEN 'real' THEN printf('%!.17g',${column}) ELSE CAST(${column} AS TEXT) END)`,
    );
    const selected = table.columns
      .map((name, column) => `${quote(name)} AS ${aliases[column]}`)
      .concat(
        table.order.map(
          (name, order) => `${quote(name)} AS ${quote(`o${order}`)}`,
        ),
      )
      .join(",");
    const order = table.order.map((_, column) => quote(`o${column}`)).join(",");
    parts.push(
      `SELECT ${index},0,'table',json_object('name',${literal(table.name)},'columns',json(${literal(JSON.stringify(table.columns))}),'count',(SELECT count(*) FROM ${quote(table.name)}))`,
      `SELECT ${index},row_number() OVER (ORDER BY ${order}),'row',json_array(${cells.join(",")}) FROM (SELECT ${selected} FROM ${quote(table.name)})`,
    );
  }
  parts.push(
    `SELECT ${set.tables.length},0,'sequences',json_object('count',(SELECT count(*) FROM sqlite_sequence WHERE ${sequenceWhere}),'rows',json(${sequenceRows}))`,
    `SELECT ${set.tables.length + 1},0,'end','1'`,
  );
  const sql = `SELECT segment,ordinal,kind,payload FROM (${parts.join(" UNION ALL ")}) ORDER BY segment,ordinal;`;
  if (Buffer.byteLength(sql, "utf8") > 99000)
    throw fail("control_snapshot_query_bound");
  return sql;
}
function integerValue(value: string, nonnegative = false): bigint {
  if (!/^(?:0|-?[1-9][0-9]{0,18})$/.test(value)) throw fail();
  const parsed = BigInt(value);
  if (
    parsed < -9223372036854775808n ||
    parsed > 9223372036854775807n ||
    (nonnegative && parsed < 0n)
  )
    throw fail();
  return parsed;
}
function cell(value: unknown): ControlCell {
  if (!fields(value, ["type", "value"])) throw fail();
  if (value.type === "null") {
    if (value.value !== null) throw fail();
    return { type: "null", value: null };
  }
  if (typeof value.value !== "string") throw fail();
  switch (value.type) {
    case "integer":
      integerValue(value.value);
      break;
    case "real":
      if (
        !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.value) ||
        !Number.isFinite(Number(value.value))
      )
        throw fail();
      break;
    case "blob":
      if (!/^(?:[A-F0-9]{2})*$/.test(value.value)) throw fail();
      break;
    case "text":
      break;
    default:
      throw fail();
  }
  return { type: value.type, value: value.value } as ControlCell;
}
function validateData(input: unknown, set: MigrationSet): SnapshotData {
  if (
    !fields(input, ["schema", "tables", "sequences"]) ||
    !Array.isArray(input.schema) ||
    !Array.isArray(input.tables) ||
    !Array.isArray(input.sequences) ||
    input.schema.length !== set.schema.length ||
    input.tables.length !== set.tables.length ||
    input.sequences.length > set.tables.length
  )
    throw fail();
  const schema = input.schema.map((value) => {
    if (
      !fields(value, ["type", "name", "sql"]) ||
      typeof value.name !== "string" ||
      !["table", "index", "view", "trigger"].includes(String(value.type)) ||
      (value.sql !== null && typeof value.sql !== "string")
    )
      throw fail();
    return value as unknown as ControlSchemaObject;
  });
  if (canonical(canonicalSchema(schema)) !== canonical(set.schema))
    throw fail("control_snapshot_schema_mismatch");
  let rowCount = 0;
  const tables = input.tables.map((value, index) => {
    const expected = set.tables[index]!;
    if (
      !fields(value, ["name", "columns", "rows"]) ||
      value.name !== expected.name ||
      canonical(value.columns) !== canonical(expected.columns) ||
      !Array.isArray(value.rows)
    )
      throw fail();
    const rows = value.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== expected.columns.length)
        throw fail();
      rowCount++;
      if (rowCount > 100000) throw fail("control_snapshot_rows_bound");
      return row.map(cell);
    });
    return { name: expected.name, columns: [...expected.columns], rows };
  });
  const migrationTable = tables.find((table) => table.name === "d1_migrations");
  if (!migrationTable) throw fail();
  const nameIndex = migrationTable.columns.indexOf("name"),
    idIndex = migrationTable.columns.indexOf("id"),
    appliedIndex = migrationTable.columns.indexOf("applied_at");
  if (
    nameIndex < 0 ||
    idIndex < 0 ||
    appliedIndex < 0 ||
    migrationTable.rows.length !== set.files.length
  )
    throw fail("control_snapshot_migrations_mismatch");
  const applied = migrationTable.rows
    .map((row) => {
      if (
        row[nameIndex]?.type !== "text" ||
        row[idIndex]?.type !== "integer" ||
        integerValue(String(row[idIndex]!.value)) < 1n ||
        row[appliedIndex]?.type !== "text" ||
        String(row[appliedIndex]!.value).length === 0
      )
        throw fail();
      return String(row[nameIndex]!.value);
    })
    .sort();
  if (canonical(applied) !== canonical(set.files.map((file) => file.name)))
    throw fail("control_snapshot_migrations_mismatch");
  const auto = set.schema
      .filter(
        (item) =>
          item.type === "table" && /\bAUTOINCREMENT\b/i.test(item.sql ?? ""),
      )
      .map((item) => item.name),
    seen = new Set<string>();
  let previous = "";
  const sequences = input.sequences.map((value) => {
    if (
      !fields(value, ["name", "seq"]) ||
      typeof value.name !== "string" ||
      typeof value.seq !== "string" ||
      !auto.includes(value.name) ||
      seen.has(value.name) ||
      value.name <= previous
    )
      throw fail();
    const seq = integerValue(value.seq, true);
    seen.add(value.name);
    previous = value.name;
    const table = tables.find((table) => table.name === value.name)!,
      definition = set.tables.find((table) => table.name === value.name)!;
    const raw = trustedSql
      .get(set)!
      .find((row) => row.type === "table" && row.name === value.name)!.sql!;
    const check = createMemory();
    try {
      check.exec(raw);
      const info = check
        .prepare(`PRAGMA table_xinfo(${quote(value.name)})`)
        .all() as unknown as { name: string; type: string; pk: number }[];
      const primary = info.filter((column) => column.pk > 0);
      if (primary.length !== 1 || primary[0]!.type.toUpperCase() !== "INTEGER")
        throw fail();
      const index = definition.columns.indexOf(primary[0]!.name);
      for (const row of table.rows)
        if (
          row[index]?.type !== "integer" ||
          integerValue(String(row[index]!.value)) > seq
        )
          throw fail();
    } finally {
      check.close();
    }
    return { name: value.name, seq: value.seq };
  });
  for (const name of auto)
    if (
      tables.find((table) => table.name === name)!.rows.length > 0 &&
      !seen.has(name)
    )
      throw fail();
  return { schema: set.schema, tables, sequences };
}
function snapshotDataFromRows(input: unknown, set: MigrationSet): SnapshotData {
  if (
    !Array.isArray(input) ||
    input.length < set.tables.length + 3 ||
    input.length > 100000 + set.tables.length + 3
  )
    throw fail();
  let cursor = 0;
  let bytes = 0;
  const next = (segment: number, ordinal: number, kind: string): unknown => {
    const row: unknown = input[cursor++];
    if (
      !fields(row, ["segment", "ordinal", "kind", "payload"]) ||
      row.segment !== segment ||
      row.ordinal !== ordinal ||
      row.kind !== kind ||
      typeof row.payload !== "string"
    )
      throw fail();
    const size = Buffer.byteLength(row.payload, "utf8");
    bytes += size;
    if (size > 2_000_000 || bytes > maximumBytes) throw fail();
    try {
      return JSON.parse(row.payload) as unknown;
    } catch {
      throw fail();
    }
  };
  const schema = next(-1, 0, "schema");
  if (
    !fields(schema, ["count", "rows"]) ||
    schema.count !== set.schema.length ||
    !Array.isArray(schema.rows) ||
    schema.rows.length !== schema.count
  )
    throw fail();
  const tables: unknown[] = [];
  let totalRows = 0;
  for (const [index, table] of set.tables.entries()) {
    const marker = next(index, 0, "table");
    if (
      !fields(marker, ["name", "columns", "count"]) ||
      marker.name !== table.name ||
      canonical(marker.columns) !== canonical(table.columns) ||
      !Number.isSafeInteger(marker.count) ||
      (marker.count as number) < 0
    )
      throw fail();
    totalRows += marker.count as number;
    if (totalRows > 100000) throw fail("control_snapshot_rows_bound");
    const rows: unknown[] = [];
    for (let ordinal = 1; ordinal <= (marker.count as number); ordinal++) {
      const raw = next(index, ordinal, "row");
      if (!Array.isArray(raw) || raw.length !== table.columns.length)
        throw fail();
      rows.push(
        raw.map((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2) throw fail();
          return { type: entry[0], value: entry[1] };
        }),
      );
    }
    tables.push({ name: table.name, columns: table.columns, rows });
  }
  const sequences = next(set.tables.length, 0, "sequences");
  if (
    !fields(sequences, ["count", "rows"]) ||
    !Number.isSafeInteger(sequences.count) ||
    (sequences.count as number) < 0 ||
    (sequences.count as number) > set.tables.length ||
    !Array.isArray(sequences.rows) ||
    sequences.rows.length !== sequences.count
  )
    throw fail();
  if (next(set.tables.length + 1, 0, "end") !== 1 || cursor !== input.length)
    throw fail();
  return validateData(
    { schema: schema.rows, tables, sequences: sequences.rows },
    set,
  );
}
function validSource(source: unknown): source is ControlSnapshot["source"] {
  return (
    fields(source, ["installationId", "databaseId"]) &&
    typeof source.installationId === "string" &&
    uuid.test(source.installationId) &&
    typeof source.databaseId === "string" &&
    uuid.test(source.databaseId)
  );
}
function validTime(time: unknown): time is string {
  return (
    typeof time === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) &&
    Number.isFinite(Date.parse(time)) &&
    new Date(time).toISOString() === time
  );
}
export async function captureControlSnapshot(
  query: (sql: string) => Promise<string>,
  directory: string,
  source: ControlSnapshot["source"],
  nowUTC: string,
): Promise<ControlSnapshot> {
  if (!validSource(source) || !validTime(nowUTC)) throw fail();
  const set = await migrationSet(directory),
    serialized = await query(buildSnapshotQuery(set));
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  )
    throw fail("control_snapshot_result_bound");
  const data = validateData(JSON.parse(serialized) as unknown, set),
    body = {
      version: 1 as const,
      source: { ...source },
      capturedAtUTC: nowUTC,
      migrations: { files: set.files, sha256: set.sha256 },
      ...data,
    };
  return { ...body, sha256: digest(canonical(body)) };
}
export async function captureControlSnapshotRows(
  query: (sql: string) => Promise<unknown>,
  directory: string,
  source: ControlSnapshot["source"],
  nowUTC: string,
): Promise<ControlSnapshot> {
  if (!validSource(source) || !validTime(nowUTC)) throw fail();
  const set = await migrationSet(directory);
  const data = snapshotDataFromRows(
    await query(buildSnapshotRowsQuery(set)),
    set,
  );
  const body = {
    version: 1 as const,
    source: { ...source },
    capturedAtUTC: nowUTC,
    migrations: { files: set.files, sha256: set.sha256 },
    ...data,
  };
  const snapshot = { ...body, sha256: digest(canonical(body)) };
  if (Buffer.byteLength(canonical(snapshot), "utf8") > maximumBytes)
    throw fail("control_snapshot_result_bound");
  return snapshot;
}
export async function restoreControlSnapshot(
  snapshot: ControlSnapshot,
  targetPath: string,
  directory: string,
): Promise<{ tables: number; rows: number; sha256: string }> {
  if (
    !isAbsolute(targetPath) ||
    Buffer.byteLength(canonical(snapshot), "utf8") > maximumBytes ||
    !fields(snapshot, [
      "version",
      "source",
      "capturedAtUTC",
      "migrations",
      "schema",
      "tables",
      "sequences",
      "sha256",
    ]) ||
    snapshot.version !== 1 ||
    !validSource(snapshot.source) ||
    !validTime(snapshot.capturedAtUTC) ||
    typeof snapshot.sha256 !== "string" ||
    !digestPattern.test(snapshot.sha256)
  )
    throw fail();
  const { sha256, ...body } = snapshot;
  if (digest(canonical(body)) !== sha256)
    throw fail("control_snapshot_hash_mismatch");
  const set = await migrationSet(directory);
  if (
    canonical(snapshot.migrations) !==
    canonical({ files: set.files, sha256: set.sha256 })
  )
    throw fail("control_snapshot_migrations_mismatch");
  const data = validateData(
      {
        schema: snapshot.schema,
        tables: snapshot.tables,
        sequences: snapshot.sequences,
      },
      set,
    ),
    parent = await lstat(dirname(targetPath));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.mode & 0o077 ||
    (process.getuid && parent.uid !== process.getuid())
  )
    throw fail("control_snapshot_output_not_private");
  let created = false,
    db: DatabaseSync | null = null;
  try {
    const file = await open(
      targetPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    created = true;
    await file.sync();
    await file.close();
    db = new DatabaseSync(targetPath, {
      enableForeignKeyConstraints: false,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    db.exec(
      "PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;BEGIN IMMEDIATE",
    );
    const trusted = trustedSql.get(set)!;
    for (const schema of trusted)
      if (schema.type === "table") {
        if (!schema.sql) throw fail();
        db.exec(schema.sql);
      }
    for (const table of data.tables) {
      const statement = db.prepare(
        `INSERT INTO ${quote(table.name)}(${table.columns.map(quote).join(",")}) VALUES(${table.columns.map(() => "?").join(",")})`,
      );
      for (const row of table.rows) {
        const values = row.map((value) =>
          value.type === "null"
            ? null
            : value.type === "integer"
              ? integerValue(value.value)
              : value.type === "real"
                ? Number(value.value)
                : value.type === "blob"
                  ? Buffer.from(value.value, "hex")
                  : value.value,
        );
        statement.run(...values);
      }
    }
    db.exec("DELETE FROM sqlite_sequence");
    const seq = db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)");
    for (const entry of data.sequences)
      seq.run(entry.name, integerValue(entry.seq, true));
    for (const schema of trusted)
      if (schema.type !== "table" && schema.sql) db.exec(schema.sql);
    if (
      db.prepare("PRAGMA foreign_key_check").all().length !== 0 ||
      db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    )
      throw fail("control_snapshot_restore_unproven");
    const rows = db.prepare(buildSnapshotRowsQuery(set)).all();
    if (canonical(snapshotDataFromRows(rows, set)) !== canonical(data))
      throw fail("control_snapshot_restore_mismatch");
    db.exec("COMMIT");
    db.close();
    db = null;
    const completed = await open(
      targetPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await completed.sync();
    } finally {
      await completed.close();
    }
    const parentFile = await open(dirname(targetPath), constants.O_RDONLY);
    try {
      await parentFile.sync();
    } finally {
      await parentFile.close();
    }
    return {
      tables: data.tables.length,
      rows: data.tables.reduce((sum, table) => sum + table.rows.length, 0),
      sha256,
    };
  } catch (error) {
    if (db) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* Preserve the original bounded failure. */
      }
      db.close();
      db = null;
    }
    if (created) await rm(targetPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw fail("control_snapshot_output_exists");
    throw fail("control_snapshot_restore_failed");
  }
}
