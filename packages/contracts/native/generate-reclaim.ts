// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { format } from "prettier";
import { z } from "zod";
import {
  ReclaimClaims,
  ReclaimTaskSnapshot,
  ReclaimIntentSnapshot,
  ReclaimObservations,
  DatabaseRuntimeAttestation,
  RECLAIM_LIMITS,
  RECLAIM_DOMAIN,
  RECLAIM_PREFIX,
  RECLAIM_FILES,
  signReclaimIntent,
} from "../src/reclaim.ts";
import { bytesToBase64url } from "../src/encoding.ts";
const id = (n: number) =>
  `01234567-89ab-4def-8123-${n.toString(16).padStart(12, "0")}`;
const claims: ReclaimClaims = {
  v: 1,
  kid: "cf-unit",
  database_id: "abcdefghijklmnopqrst",
  operation_id: `op_${"a".repeat(20)}`,
  intent_revision: 1,
  generation: 1,
  storage_generation: 1,
  node_uid: id(1),
  boot_id: id(2),
  cluster_uid: id(3),
  namespace_uid: id(4),
  cnpg_cluster_uid: id(5),
  storage_uid: id(6),
  pvc_uid: id(7),
  pv_uid: id(8),
  pod_uid: id(9),
  container_id: "b".repeat(64),
  postgres_image_sha256: "c".repeat(64),
  mode: "reclaim",
  budget_bytes: 16777216,
  step_bytes: 1048576,
  memory_request_bytes: 134217728,
  memory_limit_bytes: 268435456,
  issued_at: 1000,
  expires_at: 6000,
};
// Explicit deterministic unit-only key; no deployment key material enters generated files.
const der = Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"),
  Buffer.alloc(32, 17),
]);
const key = await crypto.subtle.importKey("pkcs8", der, "Ed25519", true, [
  "sign",
]);
const jwk = await crypto.subtle.exportKey("jwk", key),
  keyset = { "cf-unit": jwk.x! },
  raw = JSON.stringify(keyset),
  pin = createHash("sha256").update(raw).digest("hex");
const nextDer = Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"),
  Buffer.alloc(32, 18),
]);
const nextKey = await crypto.subtle.importKey(
  "pkcs8",
  nextDer,
  "Ed25519",
  true,
  ["sign"],
);
const nextJwk = await crypto.subtle.exportKey("jwk", nextKey);
const rotatedKeyset = Object.fromEntries(
  Object.entries({ ...keyset, "cf-next": nextJwk.x! }).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ),
);
const rotatedPin = createHash("sha256")
  .update(JSON.stringify(rotatedKeyset))
  .digest("hex");
const token = await signReclaimIntent(claims, key, 1000),
  revoked = {
    ...claims,
    intent_revision: 2,
    mode: "revoked" as const,
    budget_bytes: 0,
    step_bytes: 0,
  };
const files = {
  "reclaim.generated.json": {
    schemas: {
      ReclaimClaims: z.toJSONSchema(ReclaimClaims),
      ReclaimTaskSnapshot: z.toJSONSchema(ReclaimTaskSnapshot),
      ReclaimIntentSnapshot: z.toJSONSchema(ReclaimIntentSnapshot),
      ReclaimObservations: z.toJSONSchema(ReclaimObservations),
      DatabaseRuntimeAttestation: z.toJSONSchema(DatabaseRuntimeAttestation),
    },
    constants: {
      RECLAIM_LIMITS,
      RECLAIM_DOMAIN,
      RECLAIM_PREFIX,
      RECLAIM_FILES,
    },
  },
  "reclaim-vectors.generated.json": {
    keyset,
    pin,
    claims,
    token,
    revoked,
    revokedToken: await signReclaimIntent(revoked, key, 1000),
    rotatedKeyset,
    rotatedPin,
    rotatedRevokedToken: await signReclaimIntent(
      {
        ...revoked,
        kid: "cf-next",
        intent_revision: 3,
        issued_at: 1001,
        expires_at: 6001,
      },
      nextKey,
      1001,
    ),
    malformedToken: `${RECLAIM_PREFIX}.${bytesToBase64url(new TextEncoder().encode(JSON.stringify({ ...claims, database_id: "b".repeat(20) })))}.${token.split(".")[2]}`,
  },
};
for (const [name, value] of Object.entries(files)) {
  const file = new URL(name, import.meta.url),
    text = await format(JSON.stringify(value), { parser: "json" });
  if (process.argv.includes("--check")) {
    if ((await readFile(file, "utf8")) !== text)
      throw Error(`Regenerate ${name}`);
  } else await writeFile(file, text);
}
