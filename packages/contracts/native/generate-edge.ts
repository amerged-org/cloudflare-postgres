// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  DatabaseRegionRoute,
  DatabaseAdmission,
} from "../src/database-admission.ts";
import {
  ROUTE_TOKEN_HEADER,
  ROUTE_TOKEN_NODE_KEY_DOMAIN,
  ROUTE_TOKEN_SIGN_TTL_SECONDS,
  parseRouteKeyring,
  signNodeRouteToken,
} from "../src/route-token.ts";
import {
  ADMISSION_DEADLINE_MS,
  connectionRateKey,
} from "../../../apps/edge/src/session-policy.ts";
import {
  MAX_SQL_REQUEST_BYTES,
  MAX_SQL_STATEMENTS,
  connection as sqlConnection,
  decodeBody,
  forwardBody,
  statements as sqlStatements,
  transaction as sqlTransaction,
} from "../src/edge-sql.ts";
import {
  DECOY_AUTH_MAX_BYTES,
  DECOY_DEADLINE_MS,
  DECOY_MAX_BYTES,
  DECOY_MAX_FRAMES,
  DECOY_SALT_DOMAIN,
  DECOY_SCRAM_ITERATIONS,
  decoySalt,
} from "../src/edge-policy.ts";

export function edgeContract() {
  return {
    constants: {
      ROUTE_TOKEN_SIGN_TTL_SECONDS,
      ADMISSION_DEADLINE_MS,
      DECOY_AUTH_MAX_BYTES,
      DECOY_DEADLINE_MS,
      DECOY_MAX_BYTES,
      DECOY_MAX_FRAMES,
      DECOY_SCRAM_ITERATIONS,
      MAX_SQL_REQUEST_BYTES,
      MAX_SQL_STATEMENTS,
    },
    wire: {
      routeKeyDomain: ROUTE_TOKEN_NODE_KEY_DOMAIN,
      routeHeader: ROUTE_TOKEN_HEADER,
      decoySaltDomain: DECOY_SALT_DOMAIN,
    },
    gatewayRegion: z.toJSONSchema(DatabaseRegionRoute),
    databaseAdmission: z.toJSONSchema(DatabaseAdmission),
  };
}
export async function edgeVectors() {
  const ips = [
    null,
    "",
    "1",
    "192.0.2.1",
    "192.000.2.1",
    "256.0.0.1",
    "127.0.0.1",
    "::",
    "::1",
    "2001:DB8::1",
    "2001:db8:0:0:ffff:ffff:ffff:ffff",
    "2001:db8:0:1::1",
    "::ffff:192.0.2.128",
    "::ffff:192.000.2.1",
    "2001::db8::1",
    "1:2:3:4:5:6:7:8",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:192.0.2.1",
    "[::1]",
    "fe80::1%eth0",
    " 192.0.2.1",
    "2001:db8::1 ",
    "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
    "f".repeat(46),
  ];
  const keyring = parseRouteKeyring(
    JSON.stringify({
      active: "fixture",
      keys: { fixture: Buffer.alloc(32, 7).toString("base64url") },
    }),
  );
  const signing = [];
  for (const input of [
    {
      region: "eu-test",
      node: `nod_${"a".repeat(20)}`,
      db: "a".repeat(20),
      user: "app",
      cid: "01234567-89ab-4def-8123-0123456789ab",
      now: 1000000,
      ttlSeconds: 30,
      target: {
        revision: 7,
        route_revision: 19,
        instance: "01234567-89ab-4def-8123-0123456789ad",
      },
    },
    {
      region: "us-test",
      node: `nod_${"b".repeat(20)}`,
      db: "b".repeat(20),
      user: "another",
      cid: "01234567-89ab-4def-8123-0123456789ac",
      now: 1000999,
      ttlSeconds: 1,
      target: {
        revision: Number.MAX_SAFE_INTEGER,
        route_revision: Number.MAX_SAFE_INTEGER,
        instance: "01234567-89ab-4def-8123-0123456789ae",
      },
    },
  ])
    signing.push({
      ...input,
      active: keyring.active,
      key: [...keyring.keys.get(keyring.active)!],
      expected: await signNodeRouteToken({ keyring, ...input }),
    });
  return {
    ips: ips.map((ip) => ({ ip, expected: connectionRateKey(ip) })),
    sql: sqlVectors(),
    signing,
    salts: await Promise.all(
      signing.map(async (row) => ({
        database: row.db,
        user: row.user,
        active: keyring.active,
        key: [...keyring.keys.get(keyring.active)!],
        expected: await decoySalt(
          JSON.stringify({
            active: keyring.active,
            keys: {
              [keyring.active]: Buffer.from(
                keyring.keys.get(keyring.active)!,
              ).toString("base64url"),
            },
          }),
          row.db,
          row.user,
        ),
      })),
    ),
  };
}

/** What a TypeScript function of HTTP SQL answers: its value, or the failure it refuses with. */
function sqlOutcome<T>(run: () => T) {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    const { code, message, severity } = error as {
      code: string;
      message: string;
      severity: string;
    };
    if (typeof code !== "string") throw error;
    return { ok: false, code, message, severity };
  }
}

/** The HTTP SQL requests the Rust Edge must read as the TypeScript Edge does. */
function sqlVectors() {
  const database = "a".repeat(20);
  const connections = [
    null,
    "",
    "not a url",
    `postgres://app:secret@host.invalid/${database}`,
    `postgresql://app:secret@host.invalid/${database}?sslmode=require`,
    `postgres://app:p%40ss%2Fword%20x@host.invalid:5432/${database}`,
    `postgres://app:p%C3%A4ss@host.invalid/${database}`,
    `postgres://app:p%E4ss@host.invalid/${database}`,
    `postgres://app:p%zzss@host.invalid/${database}`,
    `postgres://app:p%2@host.invalid/${database}`,
    `postgres://app:p%+1ss@host.invalid/${database}`,
    `postgres://ap%70:secret@host.invalid/${database}`,
    `postgres://app@host.invalid/${database}`,
    `postgres://app:@host.invalid/${database}`,
    `postgres://app:secret@host.invalid/${database}x`,
    `postgres://app:secret@host.invalid/`,
    `postgres://app:secret@host.invalid`,
    `postgres://pg_admin:secret@host.invalid/${database}`,
    `postgres://app:secret@host.invalid/%61${"a".repeat(19)}`,
    `postgres:///${database}`,
    `postgres:${database}`,
    `mysql://app:secret@host.invalid/${database}`,
    `http://app:secret@host.invalid/${database}`,
    ` postgres://app:secret@host.invalid/${database}`,
  ].map((header) => ({
    header,
    expected: sqlOutcome(() =>
      sqlConnection(
        new Headers(
          header === null ? {} : { "Neon-Connection-String": header },
        ),
      ),
    ),
  }));
  const driver = { "Neon-Raw-Text-Output": "true", "Neon-Array-Mode": "true" };
  const transactions = [
    {},
    driver,
    { "Neon-Raw-Text-Output": "TRUE", "Neon-Array-Mode": "True" },
    { "Neon-Raw-Text-Output": "true" },
    { "Neon-Raw-Text-Output": "false", "Neon-Array-Mode": "true" },
    { ...driver, Authorization: "Bearer token" },
    { ...driver, Authorization: "" },
    { ...driver, "Neon-Batch-Isolation-Level": "Serializable" },
    { ...driver, "Neon-Batch-Isolation-Level": "ReadCommitted" },
    { ...driver, "Neon-Batch-Isolation-Level": "serializable" },
    { ...driver, "Neon-Batch-Read-Only": "true" },
    {
      ...driver,
      "Neon-Batch-Read-Only": "false",
      "Neon-Batch-Deferrable": "true",
    },
    { ...driver, "Neon-Batch-Read-Only": "TRUE" },
    { ...driver, "Neon-Batch-Deferrable": "1" },
    {
      ...driver,
      "Neon-Batch-Isolation-Level": "RepeatableRead",
      "Neon-Batch-Read-Only": "true",
      "Neon-Batch-Deferrable": "false",
    },
  ].map((headers) => ({
    headers,
    expected: sqlOutcome(() => sqlTransaction(new Headers(headers))),
  }));
  const queries = (count: number) =>
    JSON.stringify({
      queries: Array.from({ length: count }, () => ({ query: "SELECT 1" })),
    });
  const bodies = [
    "",
    "null",
    "1",
    '"text"',
    "[]",
    "[1]",
    "{",
    "{}",
    '{"query":"SELECT 1"}',
    '{"query":"SELECT 1","params":[]}',
    '{"query":"SELECT 1","params":null}',
    '{"query":"SELECT 1","params":{}}',
    '{"query":"SELECT 1","params":"x"}',
    '{"query":"SELECT 1","params":[[1]]}',
    '{"query":"SELECT 1","params":[{}]}',
    '{"query":"SELECT 1","extra":1}',
    '{"query":1}',
    '{"query":"a","query":"b"}',
    '{"query":"SELECT $1, $2, $3, $4","params":["a",null,true,false]}',
    '{"query":"SELECT \\u00e9, \\ud83d\\ude00, \\n, \\u0001, \\"","params":["\\u00e9\\u0000x"]}',
    '{"query":"SELECT $1","params":[1]}',
    '{"query":"SELECT $1","params":[-1]}',
    '{"query":"SELECT $1","params":[-0]}',
    '{"query":"SELECT $1","params":[0.0]}',
    '{"query":"SELECT $1","params":[1.0]}',
    '{"query":"SELECT $1","params":[1.5]}',
    '{"query":"SELECT $1","params":[0.1]}',
    '{"query":"SELECT $1","params":[3.14159265358979]}',
    '{"query":"SELECT $1","params":[100]}',
    '{"query":"SELECT $1","params":[1e3]}',
    '{"query":"SELECT $1","params":[1E3]}',
    '{"query":"SELECT $1","params":[1e21]}',
    '{"query":"SELECT $1","params":[1e20]}',
    '{"query":"SELECT $1","params":[123456789012345678901234567890]}',
    '{"query":"SELECT $1","params":[9007199254740993]}',
    '{"query":"SELECT $1","params":[0.000001]}',
    '{"query":"SELECT $1","params":[0.0000001]}',
    '{"query":"SELECT $1","params":[1.5e-7]}',
    '{"query":"SELECT $1","params":[1.7976931348623157e308]}',
    '{"query":"SELECT $1","params":[5e-324]}',
    '{"query":"SELECT $1","params":[2.2250738585072014e-308]}',
    '{"query":"SELECT $1","params":[8.41e21]}',
    '{"query":"SELECT $1","params":[0.30000000000000004]}',
    '{"query":"SELECT $1","params":[1.00000000000000011102230246251565404236316680908203125]}',
    '{"query":"SELECT $1","params":[123456789.123456789]}',
    '{"query":"SELECT $1","params":[1.2345678901234567e25]}',
    '{"query":"SELECT $1","params":[4.35e-100]}',
    '{"query":"SELECT $1","params":[9.5367431640625e-7]}',
    '{"queries":[]}',
    '{"queries":[{"query":"SELECT 1"},{"query":"SELECT $1","params":["x"]}]}',
    '{"queries":[{"query":"SELECT 1"}],"extra":1}',
    '{"queries":{}}',
    '{"queries":null}',
    '{"queries":[1]}',
    '{"queries":[{"query":"SELECT 1","extra":1}]}',
    queries(MAX_SQL_STATEMENTS),
    queries(MAX_SQL_STATEMENTS + 1),
    '\ufeff{"query":"SELECT 1"}',
  ].map((text) => ({
    text,
    expected: sqlOutcome(() => sqlStatements(text)),
  }));
  const encoded = new TextEncoder();
  const decoded = [
    encoded.encode('{"query":"é"}'),
    Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d),
    Uint8Array.of(0x7b, 0xff, 0x7d),
    Uint8Array.of(0xc3, 0x28),
    Uint8Array.of(0xed, 0xa0, 0x80),
    new Uint8Array(),
  ].map((bytes) => ({
    bytes: [...bytes],
    expected: sqlOutcome(() => decodeBody(bytes)),
  }));
  const forwards = [
    { password: "secret", text: '{"query":"SELECT 1"}', transaction: {} },
    {
      password: "p\u00e4ss/w\u00f6rd+x",
      text: '{"queries":[{"query":"SELECT 1"},{"query":"SELECT $1","params":[null]}]}',
      transaction: {
        isolation: "Serializable",
        read_only: true,
        deferrable: false,
      },
    },
    {
      password: "secret",
      text: '{"queries":[{"query":"SELECT 1"}]}',
      transaction: {},
    },
  ].map((row) => ({
    ...row,
    expected: sqlOutcome(() =>
      forwardBody(row.password, sqlStatements(row.text), row.transaction),
    ),
  }));
  return { connections, transactions, bodies, decoded, forwards };
}
