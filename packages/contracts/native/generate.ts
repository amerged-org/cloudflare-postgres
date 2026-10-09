// SPDX-License-Identifier: Apache-2.0
// Zod and existing protocol implementations are authoritative. Check generated files in CI.
import { edgeContract, edgeVectors } from "./generate-edge.ts";
import { ReclaimClaims } from "../src/reclaim.ts";
import { HostStorageLease } from "../src/node-thin-storage.ts";
import { StorageLvmUuid } from "../src/database-storage.ts";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  StorageWriteClaims,
  LegacyStorageBinding,
  STORAGE_AUTHORITY_LEDGER_KEY,
  STORAGE_AUTHORITY_PREFIX,
  STORAGE_AUTHORITY_DOMAIN,
  STORAGE_AUTHORITY_MAX_LENGTH,
  STORAGE_AUTHORITY_MAX_SECONDS,
  STORAGE_AUTHORITY_SKEW_MS,
  STORAGE_AUTHORITY_KEY_ID_PATTERN,
} from "../src/storage-write-authority.ts";
import { format } from "prettier";
import {
  DATABASE_ID_PATTERN,
  REGION_ID_PATTERN,
  ROLE_NAME_PATTERN,
  OPERATION_ID_PATTERN,
  RESERVED_ROLE_NAMES,
  RESERVED_ROLE_PREFIXES,
} from "../src/ids.ts";
import {
  routeTokenClaimsSchema,
  ROUTE_TOKEN_MAX_LENGTH,
  ROUTE_TOKEN_MAX_LIFETIME_SECONDS,
  ROUTE_TOKEN_SKEW_SECONDS,
  ROUTE_KEY_MIN_BYTES,
  ROUTE_TOKEN_PREFIX,
  ROUTE_TOKEN_SIGNATURE_DOMAIN,
  ROUTE_TOKEN_SIGNATURE_BYTES,
  verifyRouteToken,
} from "../src/route-token.ts";
import {
  SSL_REQUEST_CODE,
  GSSENC_REQUEST_CODE,
  CANCEL_REQUEST_CODE,
  STARTUP_MIN_LENGTH,
  STARTUP_MAX_LENGTH,
  MAX_PRELUDES,
  DEFAULT_MAX_BUFFERED,
  CANCEL_MIN_LENGTH,
  CANCEL_MAX_LENGTH,
  StartupReader,
  encodeStartup,
  encodeSslRequest,
} from "../src/pg-wire.ts";
import {
  gatewayPodUidSchema,
  gatewayControlClaimsSchema,
  gatewayIntentSchema,
  GATEWAY_CONTROL_MAX_LENGTH,
  GATEWAY_CONTROL_MAX_LIFETIME_SECONDS,
  GATEWAY_CONTROL_TOKEN_PREFIX,
  GATEWAY_CONTROL_SIGNING_PURPOSE,
  GATEWAY_CONTROL_KEY_PURPOSE,
  GATEWAY_CONTROL_PATH_PREFIX,
  GATEWAY_CONTROL_HEADER,
  GATEWAY_RETIRE_HOLD_MS,
  GATEWAY_FENCE_NAMESPACE,
  GATEWAY_FENCE_LABEL,
  GATEWAY_FENCE_SELECTOR,
  signGatewayControl,
  verifyGatewayControl,
} from "../src/gateway-control.ts";
import {
  gatewayActivityClaimsSchema,
  GATEWAY_ACTIVITY_MAX_LENGTH,
  GATEWAY_ACTIVITY_MAX_LIFETIME_SECONDS,
  GATEWAY_ACTIVITY_SIGNING_PURPOSE,
  GATEWAY_ACTIVITY_TOKEN_PREFIX,
  GATEWAY_ACTIVITY_KEY_PURPOSE,
  GATEWAY_ACTIVITY_PATH,
  GATEWAY_ACTIVITY_HEADER,
  verifyGatewayActivity,
} from "../src/gateway-activity.ts";
import { bytesToBase64url } from "../src/encoding.ts";
import {
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
} from "../../../apps/regional/src/gateway/frame-budget.ts";
import {
  MAX_PAYLOAD_BYTES,
  MAX_FRAME_BYTES,
  MAX_STARTUP_BUFFER_BYTES,
  DEFAULT_DATABASE_CONNECTION_LIMIT,
  DEFAULT_TOTAL_CONNECTION_LIMIT,
} from "../../../apps/regional/src/gateway/server.ts";
import { MAX_ACTIVITY_RECORDS } from "../../../apps/regional/src/gateway/telemetry.ts";
import { activityVectors, telemetryVectors } from "./generate-activity.ts";

function schema(source: z.ZodType) {
  const routeClaims = z.toJSONSchema(source);
  if (
    routeClaims.type !== "object" ||
    routeClaims.additionalProperties !== false ||
    routeClaims.required?.length !==
      Object.keys(routeClaims.properties ?? {}).length
  )
    throw new Error("Unhandled route schema structure");
  for (const [key, field] of Object.entries(routeClaims.properties ?? {})) {
    if (typeof field === "object" && "$ref" in field) {
      const reference = field.$ref;
      if (typeof reference !== "string" || !reference.startsWith("#/$defs/"))
        throw new Error("Unhandled route schema reference");
      routeClaims.properties![key] = routeClaims.$defs![reference.slice(8)]!;
    }
  }
  // Refinement is represented explicitly from the same reserved names used by RoleName.
  for (const field of Object.values(routeClaims.properties ?? {})) {
    const allowed = new Set([
      "type",
      "const",
      "pattern",
      "minimum",
      "maximum",
      "$id",
      "id",
      "enum",
      "format",
      "exclusiveMinimum",
    ]);
    for (const key of Object.keys(field as object))
      if (!allowed.has(key))
        throw new Error(`Unhandled route schema keyword: ${key}`);
  }
  return routeClaims;
}
const routeClaims = schema(routeTokenClaimsSchema);
const edge = edgeContract();
const contract = {
  version: 1,
  constants: {
    ...edge.constants,
    ROUTE_TOKEN_MAX_LENGTH,
    ROUTE_TOKEN_MAX_LIFETIME_SECONDS,
    ROUTE_TOKEN_SKEW_SECONDS,
    ROUTE_KEY_MIN_BYTES,
    SSL_REQUEST_CODE,
    GSSENC_REQUEST_CODE,
    CANCEL_REQUEST_CODE,
    STARTUP_MIN_LENGTH,
    STARTUP_MAX_LENGTH,
    MAX_PRELUDES,
    DEFAULT_MAX_BUFFERED,
    CANCEL_MIN_LENGTH,
    CANCEL_MAX_LENGTH,
    ROUTE_TOKEN_SIGNATURE_BYTES,
    GATEWAY_CONTROL_MAX_LENGTH,
    GATEWAY_CONTROL_MAX_LIFETIME_SECONDS,
    GATEWAY_ACTIVITY_MAX_LENGTH,
    GATEWAY_ACTIVITY_MAX_LIFETIME_SECONDS,
    GATEWAY_RETIRE_HOLD_MS,
    DEFAULT_MEMORY_LIMIT_BYTES,
    DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
    MAX_PAYLOAD_BYTES,
    MAX_FRAME_BYTES,
    MAX_STARTUP_BUFFER_BYTES,
    DEFAULT_DATABASE_CONNECTION_LIMIT,
    DEFAULT_TOTAL_CONNECTION_LIMIT,
    MAX_ACTIVITY_RECORDS,
    STORAGE_AUTHORITY_MAX_LENGTH,
    STORAGE_AUTHORITY_MAX_SECONDS,
    STORAGE_AUTHORITY_SKEW_MS,
  },
  wire: {
    ...edge.wire,
    routeTokenPrefix: ROUTE_TOKEN_PREFIX,
    routeSignatureDomain: ROUTE_TOKEN_SIGNATURE_DOMAIN,
    controlSigningPurpose: GATEWAY_CONTROL_SIGNING_PURPOSE,
    controlTokenPrefix: GATEWAY_CONTROL_TOKEN_PREFIX,
    controlKeyPurpose: GATEWAY_CONTROL_KEY_PURPOSE,
    activitySigningPurpose: GATEWAY_ACTIVITY_SIGNING_PURPOSE,
    activityTokenPrefix: GATEWAY_ACTIVITY_TOKEN_PREFIX,
    activityKeyPurpose: GATEWAY_ACTIVITY_KEY_PURPOSE,
    controlPathPrefix: GATEWAY_CONTROL_PATH_PREFIX,
    controlHeader: GATEWAY_CONTROL_HEADER,
    activityPath: GATEWAY_ACTIVITY_PATH,
    activityHeader: GATEWAY_ACTIVITY_HEADER,
    fenceNamespace: GATEWAY_FENCE_NAMESPACE,
    fenceLabel: GATEWAY_FENCE_LABEL,
    fenceSelector: GATEWAY_FENCE_SELECTOR,
    storageAuthorityLedgerKey: STORAGE_AUTHORITY_LEDGER_KEY,
    storageAuthorityPrefix: STORAGE_AUTHORITY_PREFIX,
    storageAuthorityDomain: STORAGE_AUTHORITY_DOMAIN,
  },
  patterns: {
    database: DATABASE_ID_PATTERN.source,
    region: REGION_ID_PATTERN.source,
    role: ROLE_NAME_PATTERN.source,
    operation: OPERATION_ID_PATTERN.source,
    uuid: z.toJSONSchema(gatewayPodUidSchema).pattern,
    storageAuthorityKid: STORAGE_AUTHORITY_KEY_ID_PATTERN.source,
    storageLvmUuid: z.toJSONSchema(StorageLvmUuid).pattern,
  },
  reservedRoles: [...RESERVED_ROLE_NAMES],
  reservedRolePrefixes: RESERVED_ROLE_PREFIXES,
  gatewayRegion: edge.gatewayRegion,
  databaseAdmission: edge.databaseAdmission,
  routeClaims,
  controlClaims: schema(gatewayControlClaimsSchema),
  activityClaims: schema(gatewayActivityClaimsSchema),
  intent: schema(gatewayIntentSchema),
  storageWriteClaims: schema(StorageWriteClaims),
  reclaimClaims: schema(ReclaimClaims),
  legacyStorageBinding: z.toJSONSchema(LegacyStorageBinding),
  storageHostLease: z.toJSONSchema(HostStorageLease),
};
const key = new Uint8Array(32).fill(7),
  database = "a".repeat(20),
  region = "eu-test";
const claims = {
  v: 2,
  db: database,
  user: "app",
  cid: "00000000-0000-0000-0000-000000000001",
  rg: region,
  kid: "test",
  iat: 1000,
  exp: 1030,
};
const cryptoKey = await crypto.subtle.importKey(
  "raw",
  key,
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
async function token(value: unknown): Promise<string> {
  return rawToken(JSON.stringify(value));
}
const rustConstants =
  "// SPDX-License-Identifier: Apache-2.0\n// Generated by packages/contracts/native/generate.ts. Do not edit.\n" +
  Object.entries({
    MAX_PAYLOAD_BYTES,
    MAX_FRAME_BYTES,
    MAX_STARTUP_BUFFER_BYTES,
  })
    .map(([name, value]) => `pub const ${name}: usize = ${value};\n`)
    .join("");
const rustConstantsPath = new URL(
  "../../native-protocol/src/constants.generated.rs",
  import.meta.url,
);
if (process.argv.includes("--check")) {
  if ((await readFile(rustConstantsPath, "utf8")) !== rustConstants)
    throw new Error("Regenerate Rust protocol constants");
} else await writeFile(rustConstantsPath, rustConstants);
async function rawToken(json: string): Promise<string> {
  const payload = bytesToBase64url(new TextEncoder().encode(json));
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(ROUTE_TOKEN_SIGNATURE_DOMAIN + payload),
    ),
  );
  return `${ROUTE_TOKEN_PREFIX}.${payload}.${bytesToBase64url(mac)}`;
}
const routeInputs: {
  name: string;
  claims?: unknown;
  token?: string | null;
  now?: number;
  region?: string;
}[] = [
  { name: "valid", claims },
  {
    name: "equivalent-json-numbers",
    token: await rawToken(
      JSON.stringify(claims)
        .replace('"v":2', '"v":2.0')
        .replace('"iat":1000', '"iat":1e3'),
    ),
  },
  {
    name: "leading-json-bom",
    token: await rawToken("\uFEFF" + JSON.stringify(claims)),
  },
  { name: "missing", token: null },
  { name: "malformed", token: "v1.a.b" },
  { name: "unknown-kid", claims: { ...claims, kid: "other" } },
  { name: "bad-signature", token: (await token(claims)).slice(0, -3) + "AAA" },
  { name: "wrong-region", claims, region: "us-test" },
  { name: "reserved-role", claims: { ...claims, user: "postgres" } },
  { name: "reserved-prefix", claims: { ...claims, user: "pg_owner" } },
  { name: "extra-field", claims: { ...claims, extra: true } },
  { name: "wrong-db", claims: { ...claims, db: "../x" } },
  { name: "wrong-cid", claims: { ...claims, cid: "NOT-A-UUID" } },
  { name: "bad-lifetime", claims: { ...claims, exp: 1031 } },
  { name: "zero-lifetime", claims: { ...claims, exp: 1000 } },
  { name: "not-yet-valid", claims, now: 994999 },
  { name: "skew-start", claims, now: 995000 },
  { name: "skew-end", claims, now: 1035000 },
  { name: "expired", claims, now: 1035001 },
  { name: "fraction-time", claims: { ...claims, iat: 1000.1 } },
];
const routes = await Promise.all(
  routeInputs.map(async (input) => {
    const encoded =
      input.claims === undefined ? input.token! : await token(input.claims);
    const expected = await verifyRouteToken(encoded, {
      keys: new Map([["test", key]]),
      region: input.region ?? region,
      now: input.now ?? 1000000,
    });
    return {
      name: input.name,
      token: encoded,
      now: input.now ?? 1000000,
      region: input.region ?? region,
      expected,
    };
  }),
);
const startup = encodeStartup(
  new Map([
    ["user", "app"],
    ["database", database],
    ["options", "-c search_path=public"],
    ["_pq_.extension", "preserved"],
  ]),
  2,
);
const gss = encodeSslRequest();
new DataView(gss.buffer).setUint32(4, GSSENC_REQUEST_CODE);
const concat = (...values: Uint8Array[]) =>
  Uint8Array.from(values.flatMap((v) => [...v]));
const startupInputs: { name: string; chunks: Uint8Array[] }[] = [
  { name: "exact", chunks: [startup] },
  { name: "fragmented", chunks: [...startup].map((v) => Uint8Array.of(v)) },
  {
    name: "preludes",
    chunks: [
      concat(
        gss,
        encodeSslRequest(),
        startup,
        Uint8Array.of(81, 0, 0, 0, 5, 0),
      ),
    ],
  },
  {
    name: "duplicate-prelude",
    chunks: [concat(encodeSslRequest(), encodeSslRequest())],
  },
  { name: "fallback-database", chunks: [encodeStartup({ user: "app" })] },
  { name: "missing-user", chunks: [encodeStartup({ database })] },
  {
    name: "replication",
    chunks: [encodeStartup({ user: "app", database, replication: "false" })],
  },
  { name: "invalid-length", chunks: [Uint8Array.of(0, 0, 0, 7, 0, 3, 0, 0)] },
  {
    name: "invalid-utf8",
    chunks: [
      Uint8Array.of(
        0,
        0,
        0,
        17,
        0,
        3,
        0,
        0,
        117,
        115,
        101,
        114,
        0,
        255,
        0,
        0,
        0,
      ),
    ],
  },
  { name: "too-much", chunks: [new Uint8Array(DEFAULT_MAX_BUFFERED + 1)] },
];
const startups = startupInputs.map((input) => {
  const reader = new StartupReader(),
    events: unknown[] = [];
  for (const chunk of input.chunks) {
    let event = reader.push(chunk);
    for (;;) {
      if (event.kind === "startup")
        events.push({
          ...event,
          params: [...event.params],
          raw: [...event.raw],
          rest: [...event.rest],
        });
      else events.push(event);
      if (event.kind !== "ssl" && event.kind !== "gss") break;
      event = reader.push(new Uint8Array());
    }
  }
  return { ...input, chunks: input.chunks.map(bytesToBase64url), events };
});
const pod = "01234567-89ab-4def-8123-0123456789ab",
  operation = `op_${"b".repeat(20)}`;
const keyring = { active: "test", keys: new Map([["test", key]]) };
const controls = [];
for (const action of [
  "begin",
  "status",
  "close",
  "release",
  "retire",
] as const) {
  const value = await signGatewayControl({
    keyring,
    region,
    pod,
    database,
    operation,
    revision: 7,
    action,
    now: 1000000,
  });
  for (const change of [
    { name: "valid" },
    { name: "wrong-pod", pod: "01234567-89ab-4def-8123-0123456789ac" },
    { name: "wrong-region", region: "us-test" },
    { name: "expired", now: 1030001 },
    { name: "exact-expiry", now: 1030000 },
  ]) {
    const expectedInput = {
      keys: keyring.keys,
      region: change.region ?? region,
      pod: change.pod ?? pod,
      action,
      now: change.now ?? 1000000,
    };
    controls.push({
      name: `${action}-${change.name}`,
      token: value,
      ...expectedInput,
      keys: undefined,
      expected: await verifyGatewayControl(value, expectedInput),
    });
  }
}
const activityClaims = {
  v: 1,
  region,
  database,
  revision: 7,
  pod,
  nonce: "01234567-89ab-4def-8123-0123456789ac",
  kid: "test",
  iat: 1000,
  exp: 1030,
};
async function purposeToken(
  prefix: string,
  keyPurpose: string,
  signingPurpose: string,
  value: unknown,
) {
  const payload = bytesToBase64url(
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(keyPurpose),
  );
  const imported = await crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    imported,
    new TextEncoder().encode(signingPurpose + payload),
  );
  return `${prefix}.${payload}.${bytesToBase64url(new Uint8Array(signature))}`;
}
const activityToken = await purposeToken(
  GATEWAY_ACTIVITY_TOKEN_PREFIX,
  GATEWAY_ACTIVITY_KEY_PURPOSE,
  GATEWAY_ACTIVITY_SIGNING_PURPOSE,
  activityClaims,
);
const activities = [];
for (const change of [
  { name: "valid" },
  { name: "wrong-pod", pod: "01234567-89ab-4def-8123-0123456789ad" },
  { name: "wrong-region", region: "us-test" },
  { name: "expired", now: 1030000 },
  { name: "before-issued", now: 999999 },
]) {
  const input = {
    keys: keyring.keys,
    region: change.region ?? region,
    pod: change.pod ?? pod,
    now: change.now ?? 1000000,
  };
  activities.push({
    name: change.name,
    token: activityToken,
    ...input,
    keys: undefined,
    expected: await verifyGatewayActivity(activityToken, input),
  });
}
for (const [name, value] of [
  ["protocol.generated.json", contract],
  [
    "conformance.generated.json",
    {
      edge: await edgeVectors(),
      key: [...key],
      routes,
      startups,
      controls,
      activities,
      postgresActivity: activityVectors(),
      gatewayMeasurements: telemetryVectors(),
    },
  ],
] as const) {
  const path = new URL(name, import.meta.url),
    content = await format(JSON.stringify(value), { parser: "json" });
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== content)
      throw new Error(`Regenerate ${name}`);
  } else await writeFile(path, content);
}
