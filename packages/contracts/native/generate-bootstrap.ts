// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { z } from "zod";
import { BOOTSTRAP_RELAY_LIMITS } from "../../../apps/regional/src/bootstrap-relay.ts";
import {
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_PROBE_PATH,
  BOOTSTRAP_RELAY_HEADER,
  BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH,
  BOOTSTRAP_RELAY_MAX_TOKEN_SECONDS,
  BOOTSTRAP_RELAY_TOKEN_PREFIX,
  BOOTSTRAP_RELAY_SIGNATURE_PURPOSE,
  BOOTSTRAP_PORTS,
  bootstrapCapabilitySchema,
  bootstrapRelayClaimsSchema,
  bootstrapRelayIdentitySchema,
  bootstrapRelayProbeSchema,
  importBootstrapVerificationKeys,
  verifyBootstrapRelay,
} from "../src/bootstrap-relay.ts";
import {
  REGION_ID_PATTERN,
  NODE_ID_PATTERN,
  OPERATION_ID_PATTERN,
} from "../src/ids.ts";
import { bytesToBase64url } from "../src/encoding.ts";
const claimsSchema = z.toJSONSchema(bootstrapRelayClaimsSchema);
const contract = {
  version: 1,
  limits: BOOTSTRAP_RELAY_LIMITS,
  wire: {
    path: BOOTSTRAP_RELAY_PATH,
    identityPath: BOOTSTRAP_RELAY_IDENTITY_PATH,
    probePath: BOOTSTRAP_RELAY_PROBE_PATH,
    header: BOOTSTRAP_RELAY_HEADER,
    prefix: BOOTSTRAP_RELAY_TOKEN_PREFIX,
    purpose: BOOTSTRAP_RELAY_SIGNATURE_PURPOSE,
  },
  maxTokenLength: BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH,
  maxTokenSeconds: BOOTSTRAP_RELAY_MAX_TOKEN_SECONDS,
  ports: BOOTSTRAP_PORTS,
  capabilities: bootstrapCapabilitySchema.options,
  patterns: {
    region: REGION_ID_PATTERN.source,
    node: NODE_ID_PATTERN.source,
    operation: OPERATION_ID_PATTERN.source,
  },
  schemas: {
    claims: claimsSchema,
    identity: z.toJSONSchema(bootstrapRelayIdentitySchema),
    probe: z.toJSONSchema(bootstrapRelayProbeSchema),
  },
};
// Fixed public test key. Signing is fixture generation only; runtime receives public keys.
const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const pkcs8 = new Uint8Array(48);
pkcs8.set([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]);
pkcs8.set(seed, 16);
const privateKey = await crypto.subtle.importKey(
  "pkcs8",
  pkcs8,
  { name: "Ed25519" },
  true,
  ["sign"],
);
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
const publicKeys = { test: jwk.x! };
const keys = await importBootstrapVerificationKeys(publicKeys);
const epoch = "01234567-89ab-4def-8123-0123456789ab";
const original = bootstrapRelayClaimsSchema.parse({
  v: 1,
  region: "us-test",
  issuer_region: "eu-test",
  relay_epoch: epoch,
  purpose: "bootstrap",
  operation: `op_${"a".repeat(20)}`,
  node: `nod_${"b".repeat(20)}`,
  revision: 1,
  capability: "talos_api",
  target: { address: "127.0.0.1", port: 50000 },
  nonce: "c".repeat(32),
  kid: "test",
  iat: 100,
  exp: 130,
});
const cases = [
  { name: "exact_cross_region", claims: original, now: 100001 },
  { name: "expired", claims: original, now: 130000 },
  { name: "future", claims: { ...original, iat: 101, exp: 131 }, now: 100001 },
  {
    name: "wrong_port",
    claims: { ...original, target: { ...original.target, port: 22 } },
    now: 100001,
  },
  {
    name: "wrong_epoch",
    claims: {
      ...original,
      relay_epoch: "01234567-89ab-4def-8123-0123456789ac",
    },
    now: 100001,
  },
  {
    name: "unlisted_region",
    claims: { ...original, region: "other-test" },
    now: 100001,
  },
  {
    name: "wrong_issuer",
    claims: { ...original, issuer_region: "us-test" },
    now: 100001,
  },
  { name: "excess_lifetime", claims: { ...original, exp: 161 }, now: 100001 },
  {
    name: "revision_float_canonicality",
    raw: JSON.stringify(original).replace('"revision":1', '"revision":1.0'),
    claims: original,
    now: 100001,
  },
  {
    name: "object_order_is_canonical",
    raw: JSON.stringify(Object.assign({ purpose: original.purpose }, original)),
    claims: original,
    now: 100001,
  },
];
const expected = {
  region: "eu-test",
  issuer_region: "eu-test",
  relay_epoch: epoch,
  allowedTargetRegions: ["us-test"],
};
const vectors = [];
for (const entry of cases) {
  const text = "raw" in entry ? entry.raw! : JSON.stringify(entry.claims);
  const body = bytesToBase64url(new TextEncoder().encode(text));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      new TextEncoder().encode(BOOTSTRAP_RELAY_SIGNATURE_PURPOSE + body),
    ),
  );
  const token = `${BOOTSTRAP_RELAY_TOKEN_PREFIX}.${body}.${bytesToBase64url(signature)}`;
  const result = await verifyBootstrapRelay(token, {
    ...expected,
    keys,
    now: entry.now,
  });
  vectors.push({
    name: entry.name,
    token,
    now: entry.now,
    expected: result.ok,
    claims: result.ok ? result.claims : null,
  });
}
for (const [name, value] of Object.entries({
  "bootstrap.generated.json": contract,
  "bootstrap-vectors.generated.json": {
    public_keys: publicKeys,
    identity: expected,
    cases: vectors,
  },
})) {
  const path = new URL(name, import.meta.url);
  const output = await format(JSON.stringify(value), { parser: "json" });
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== output)
      throw new Error(`Regenerate ${name}`);
  } else await writeFile(path, output);
}
