// SPDX-License-Identifier: Apache-2.0
// Zod and existing protocol implementations are authoritative. Check generated files in CI.
import { edgeContract, edgeVectors } from "./generate-edge.ts";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { format } from "prettier";
import {
  DATABASE_ID_PATTERN,
  REGION_ID_PATTERN,
  ROLE_NAME_PATTERN,
  OPERATION_ID_PATTERN,
  NODE_ID_PATTERN,
  RESERVED_ROLE_NAMES,
  RESERVED_ROLE_PREFIXES,
} from "../src/ids.ts";
import {
  wakeRouteTokenClaimsSchema,
  nodeRouteTokenClaimsSchema,
  ROUTE_TOKEN_NODE_PREFIX,
  ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN,
  ROUTE_TOKEN_NODE_KEY_DOMAIN,
  signNodeRouteToken,
  ROUTE_TOKEN_WAKE_PREFIX,
  ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN,
  roleRevisionHash,
  signWakeRouteToken,
  ROUTE_TOKEN_MAX_LENGTH,
  ROUTE_TOKEN_MAX_LIFETIME_SECONDS,
  ROUTE_TOKEN_SKEW_SECONDS,
  ROUTE_KEY_MIN_BYTES,
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
import { bytesToBase64url } from "../src/encoding.ts";
import {
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_FRAME_BYTES,
  MAX_STARTUP_BUFFER_BYTES,
  DEFAULT_DATABASE_CONNECTION_LIMIT,
  DEFAULT_TOTAL_CONNECTION_LIMIT,
  MAX_ACTIVITY_RECORDS,
} from "../src/gateway-limits.ts";
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
      "minLength",
      "maxLength",
    ]);
    for (const key of Object.keys(field as object))
      if (!allowed.has(key))
        throw new Error(`Unhandled route schema keyword: ${key}`);
  }
  return routeClaims;
}
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
    DEFAULT_MEMORY_LIMIT_BYTES,
    DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
    MAX_PAYLOAD_BYTES,
    MAX_FRAME_BYTES,
    MAX_STARTUP_BUFFER_BYTES,
    DEFAULT_DATABASE_CONNECTION_LIMIT,
    DEFAULT_TOTAL_CONNECTION_LIMIT,
    MAX_ACTIVITY_RECORDS,
  },
  wire: {
    ...edge.wire,
    wakeRouteTokenPrefix: ROUTE_TOKEN_WAKE_PREFIX,
    wakeRouteSignatureDomain: ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN,
    nodeRouteTokenPrefix: ROUTE_TOKEN_NODE_PREFIX,
    nodeRouteSignatureDomain: ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN,
    nodeRouteKeyDomain: ROUTE_TOKEN_NODE_KEY_DOMAIN,
  },
  patterns: {
    database: DATABASE_ID_PATTERN.source,
    region: REGION_ID_PATTERN.source,
    role: ROLE_NAME_PATTERN.source,
    operation: OPERATION_ID_PATTERN.source,
    node: NODE_ID_PATTERN.source,
    uuid: z.toJSONSchema(z.uuid()).pattern,
  },
  reservedRoles: [...RESERVED_ROLE_NAMES],
  reservedRolePrefixes: RESERVED_ROLE_PREFIXES,
  gatewayRegion: edge.gatewayRegion,
  databaseAdmission: edge.databaseAdmission,
  wakeRouteClaims: schema(wakeRouteTokenClaimsSchema),
  nodeRouteClaims: schema(nodeRouteTokenClaimsSchema),
};
const key = new Uint8Array(32).fill(7),
  database = "a".repeat(20),
  region = "eu-test";
const connection = {
  db: database,
  user: "app",
  cid: "00000000-0000-0000-0000-000000000001",
  rg: region,
  kid: "test",
  iat: 1000,
  exp: 1030,
};
// The fixture key stands for the key derived for this node, and for the other node's.
const nodeId = `nod_${"n".repeat(20)}`,
  otherNode = `nod_${"o".repeat(20)}`;
// The claims of the Kubernetes runtime's route (v3, naming a Pod): no route token of a node.
const podClaims = {
  ...connection,
  v: 3,
  rev: 7,
  pod: "01234567-89ab-4def-8123-0123456789ab",
};
const cryptoKey = await crypto.subtle.importKey(
  "raw",
  key,
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
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
async function rawToken(
  json: string,
  prefix: string,
  domain: string,
): Promise<string> {
  const payload = bytesToBase64url(new TextEncoder().encode(json));
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(domain + payload),
    ),
  );
  return `${prefix}.${payload}.${bytesToBase64url(mac)}`;
}
const wakeClaims = {
  ...connection,
  v: 5,
  op: `op_${"c".repeat(20)}`,
  gen: 8,
  route_revision: 19,
  rh: "d".repeat(64),
};
async function wakeToken(
  value: unknown,
  domain = ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN,
): Promise<string> {
  return rawToken(JSON.stringify(value), ROUTE_TOKEN_WAKE_PREFIX, domain);
}
// Only v5-prefixed tokens: wake.rs verifies nothing else.
const wakeRouteInputs: {
  name: string;
  token: string | null;
  now?: number;
  region?: string;
}[] = [
  { name: "valid", token: await wakeToken(wakeClaims) },
  {
    name: "v6-domain",
    token: await wakeToken(wakeClaims, ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN),
  },
  {
    name: "pod-claims-under-v5",
    token: await wakeToken({ ...podClaims, v: 4, route_revision: 19 }),
  },
  { name: "v6-version", token: await wakeToken({ ...wakeClaims, v: 6 }) },
  {
    name: "missing-rh",
    token: await wakeToken({ ...wakeClaims, rh: undefined }),
  },
  {
    name: "uppercase-rh",
    token: await wakeToken({ ...wakeClaims, rh: "D".repeat(64) }),
  },
  {
    name: "short-rh",
    token: await wakeToken({ ...wakeClaims, rh: "d".repeat(63) }),
  },
  { name: "zero-gen", token: await wakeToken({ ...wakeClaims, gen: 0 }) },
  {
    name: "fraction-gen",
    token: await wakeToken({ ...wakeClaims, gen: 7.5 }),
  },
  {
    name: "unsafe-gen",
    token: await wakeToken({ ...wakeClaims, gen: 2 ** 53 }),
  },
  {
    name: "zero-route-revision",
    token: await wakeToken({ ...wakeClaims, route_revision: 0 }),
  },
  {
    name: "bad-operation",
    token: await wakeToken({ ...wakeClaims, op: "op_SHORT" }),
  },
  {
    name: "extra-pod",
    token: await wakeToken({ ...wakeClaims, pod: podClaims.pod }),
  },
  {
    name: "reserved-role",
    token: await wakeToken({ ...wakeClaims, user: "postgres" }),
  },
  {
    name: "wrong-region",
    token: await wakeToken(wakeClaims),
    region: "us-test",
  },
  {
    name: "unknown-kid",
    token: await wakeToken({ ...wakeClaims, kid: "other" }),
  },
  {
    name: "bad-signature",
    token: (await wakeToken(wakeClaims)).slice(0, -3) + "AAA",
  },
  {
    name: "bad-lifetime",
    token: await wakeToken({ ...wakeClaims, exp: 1031 }),
  },
  {
    name: "zero-lifetime",
    token: await wakeToken({ ...wakeClaims, exp: 1000 }),
  },
  { name: "not-yet-valid", token: await wakeToken(wakeClaims), now: 994999 },
  { name: "skew-start", token: await wakeToken(wakeClaims), now: 995000 },
  { name: "skew-end", token: await wakeToken(wakeClaims), now: 1035000 },
  { name: "expired", token: await wakeToken(wakeClaims), now: 1035001 },
  { name: "missing", token: null },
  { name: "malformed", token: "v5.a.b" },
  {
    name: "too-long",
    token: `v5.${"A".repeat(ROUTE_TOKEN_MAX_LENGTH)}.x`,
  },
];
const wakeRoutes = await Promise.all(
  wakeRouteInputs.map(async (input) => ({
    name: input.name,
    token: input.token,
    now: input.now ?? 1000000,
    region: input.region ?? region,
    expected: await verifyRouteToken(input.token, {
      keys: new Map([["test", key]]),
      region: input.region ?? region,
      now: input.now ?? 1000000,
    }),
  })),
);
const wakeSignedInput = {
  region,
  node: nodeId,
  db: database,
  user: "app",
  cid: connection.cid,
  now: 1000000,
  ttlSeconds: 30,
  wake: {
    operation: wakeClaims.op,
    generation: wakeClaims.gen,
    route_revision: wakeClaims.route_revision,
    role_revision_hash: wakeClaims.rh,
  },
};
const wakeSigned = {
  input: wakeSignedInput,
  token: await signWakeRouteToken({
    ...wakeSignedInput,
    keyring: { active: "test", keys: new Map([["test", key]]) },
  }),
};
// Route v6 names a node and its unit. The verifier's key is the one derived for that node.
const nodeClaims = {
  ...connection,
  v: 6,
  rev: 7,
  route_revision: 19,
  node: nodeId,
  inst: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c",
};
async function nodeToken(
  value: unknown,
  domain = ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN,
): Promise<string> {
  return rawToken(JSON.stringify(value), ROUTE_TOKEN_NODE_PREFIX, domain);
}
// Only v6-prefixed tokens: a node verifier reads nothing else of this group.
const nodeRouteInputs: {
  name: string;
  token: string | null;
  now?: number;
  region?: string;
  node?: string;
}[] = [
  { name: "valid", token: await nodeToken(nodeClaims) },
  {
    name: "v5-domain",
    token: await nodeToken(nodeClaims, ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN),
  },
  {
    name: "v5-claims-under-v6",
    token: await nodeToken(wakeClaims),
  },
  {
    name: "pod-claims-under-v6",
    token: await nodeToken({ ...podClaims, v: 4, route_revision: 19 }),
  },
  {
    name: "pod-instead-of-instance",
    token: await nodeToken({
      ...nodeClaims,
      inst: undefined,
      pod: podClaims.pod,
    }),
  },
  {
    name: "missing-instance",
    token: await nodeToken({ ...nodeClaims, inst: undefined }),
  },
  {
    name: "uppercase-instance",
    token: await nodeToken({
      ...nodeClaims,
      inst: nodeClaims.inst.toUpperCase(),
    }),
  },
  {
    name: "missing-node",
    token: await nodeToken({ ...nodeClaims, node: undefined }),
  },
  {
    name: "bad-node",
    token: await nodeToken({ ...nodeClaims, node: "nod_short" }),
  },
  {
    name: "missing-route-revision",
    token: await nodeToken({ ...nodeClaims, route_revision: undefined }),
  },
  {
    name: "zero-route-revision",
    token: await nodeToken({ ...nodeClaims, route_revision: 0 }),
  },
  {
    name: "unsafe-generation",
    token: await nodeToken({ ...nodeClaims, rev: 2 ** 53 }),
  },
  {
    name: "reserved-role",
    token: await nodeToken({ ...nodeClaims, user: "postgres" }),
  },
  { name: "wrong-node", token: await nodeToken(nodeClaims), node: otherNode },
  {
    name: "wrong-region",
    token: await nodeToken(nodeClaims),
    region: "us-test",
  },
  {
    name: "unknown-kid",
    token: await nodeToken({ ...nodeClaims, kid: "other" }),
  },
  {
    name: "bad-signature",
    token: (await nodeToken(nodeClaims)).slice(0, -3) + "AAA",
  },
  {
    name: "bad-lifetime",
    token: await nodeToken({ ...nodeClaims, exp: 1031 }),
  },
  { name: "not-yet-valid", token: await nodeToken(nodeClaims), now: 994999 },
  { name: "skew-start", token: await nodeToken(nodeClaims), now: 995000 },
  { name: "skew-end", token: await nodeToken(nodeClaims), now: 1035000 },
  { name: "expired", token: await nodeToken(nodeClaims), now: 1035001 },
  { name: "missing", token: null },
  { name: "malformed", token: "v6.a.b" },
  {
    name: "too-long",
    token: `v6.${"A".repeat(ROUTE_TOKEN_MAX_LENGTH)}.x`,
  },
];
const nodeRoutes = await Promise.all(
  nodeRouteInputs.map(async (input) => ({
    name: input.name,
    token: input.token,
    now: input.now ?? 1000000,
    region: input.region ?? region,
    node: input.node ?? nodeId,
    expected: await verifyRouteToken(input.token, {
      keys: new Map([["test", key]]),
      region: input.region ?? region,
      node: input.node ?? nodeId,
      now: input.now ?? 1000000,
    }),
  })),
);
const nodeSignedInput = {
  region,
  node: nodeId,
  db: database,
  user: "app",
  cid: connection.cid,
  now: 1000000,
  ttlSeconds: 30,
  target: {
    revision: nodeClaims.rev,
    route_revision: nodeClaims.route_revision,
    instance: nodeClaims.inst,
  },
};
const nodeSigned = {
  input: nodeSignedInput,
  token: await signNodeRouteToken({
    ...nodeSignedInput,
    keyring: { active: "test", keys: new Map([["test", key]]) },
  }),
};
const roleRevisionHashes = await Promise.all(
  [
    [],
    [{ name: "app", revision: 1 }],
    [
      { name: "reader", revision: 12 },
      { name: "app", revision: 3 },
      { name: "app_admin", revision: 9007199254740991 },
      { name: "a", revision: 2 },
    ],
  ].map(async (roles) => ({ roles, hash: await roleRevisionHash(roles) })),
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
for (const [name, value] of [
  ["protocol.generated.json", contract],
  [
    "conformance.generated.json",
    {
      edge: await edgeVectors(),
      key: [...key],
      wakeRoutes,
      wakeSigned,
      nodeRoutes,
      nodeSigned,
      roleRevisionHashes,
      startups,
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
