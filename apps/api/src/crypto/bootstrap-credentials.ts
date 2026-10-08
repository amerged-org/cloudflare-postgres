// SPDX-License-Identifier: Apache-2.0
import {
  base64urlToBytes,
  bytesToBase64url,
  RegionId,
  Timestamp,
  hashApiKey,
  parseAgentKey,
  timingSafeEqual,
} from "@pgcf/contracts";
import { z } from "zod";

export const BOOTSTRAP_PLAINTEXT_MAX_BYTES = 256 * 1024;
const CIPHERTEXT_MAX_CHARS = 349547;
const KeyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Reference = z
  .strictObject({
    version: z.literal(1),
    region_id: RegionId,
    purpose: z.enum(["agent_key", "region_seed", "join_bundle"]),
    revision: Revision,
  })
  .refine((ref) => ref.purpose !== "agent_key" || ref.revision === 1);
export type BootstrapCredentialRef = z.infer<typeof Reference>;
const Envelope = z.strictObject({
  version: z.literal(1),
  region_id: RegionId,
  purpose: z.enum(["agent_key", "region_seed", "join_bundle"]),
  revision: Revision,
  kid: KeyId,
  iv: z.string().max(16),
  ciphertext: z.string().max(CIPHERTEXT_MAX_CHARS),
});
export type EncryptedBootstrapCredential = z.infer<typeof Envelope>;
const Config = z.strictObject({
  active: KeyId,
  keys: z.record(KeyId, z.string().length(43)),
});
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
class CustodyError extends Error {
  constructor(
    code:
      | "invalid"
      | "keyring_invalid"
      | "key_unavailable"
      | "unavailable"
      | "region_missing"
      | "agent_mismatch"
      | "conflict",
  ) {
    super(`bootstrap_credential_${code}`);
  }
}
function valid<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new CustodyError("invalid");
  return parsed.data;
}
function utf8(value: string, maximum: number): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  )
    throw new CustodyError("invalid");
  const bytes = encoder.encode(value);
  if (bytes.byteLength > maximum || decoder.decode(bytes) !== value)
    throw new CustodyError("invalid");
  return bytes;
}
const Document = z.string().min(1).max(BOOTSTRAP_PLAINTEXT_MAX_BYTES);
const Version = z
  .string()
  .regex(/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,63})?$/)
  .max(96);
const MaterialFields = {
  version: z.literal(1),
  cluster_name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  cluster_endpoint: z.string().max(2048),
  talos_version: Version,
  kubernetes_version: Version,
  talos_machine_secrets_yaml: Document,
  talos_admin_config: Document,
};
const Seed = z.strictObject(MaterialFields);
const Bundle = z.strictObject({
  ...MaterialFields,
  kube_system_uid: z.uuid(),
  kubeconfig: Document,
});
export type RegionSeed = z.infer<typeof Seed>;
export type RegionJoinBundle = z.infer<typeof Bundle>;
function material<T extends RegionSeed>(
  schema: z.ZodType<T>,
  input: unknown,
): T {
  const value = valid(schema, input);
  let endpoint: URL;
  try {
    endpoint = new URL(value.cluster_endpoint);
  } catch {
    throw new CustodyError("invalid");
  }
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new CustodyError("invalid");
  for (const text of [
    value.talos_machine_secrets_yaml,
    value.talos_admin_config,
    ...("kubeconfig" in value ? [value.kubeconfig as string] : []),
  ])
    utf8(text, BOOTSTRAP_PLAINTEXT_MAX_BYTES);
  utf8(JSON.stringify(value), BOOTSTRAP_PLAINTEXT_MAX_BYTES);
  return value;
}
const bundle = (input: unknown) => material(Bundle, input);
const seed = (input: unknown) => material(Seed, input);
export function agentKeyReference(regionId: string): BootstrapCredentialRef {
  return valid(Reference, {
    version: 1,
    region_id: regionId,
    purpose: "agent_key",
    revision: 1,
  });
}
export function joinBundleReference(
  regionId: string,
  revision: number,
): BootstrapCredentialRef {
  return valid(Reference, {
    version: 1,
    region_id: regionId,
    purpose: "join_bundle",
    revision,
  });
}
export function regionSeedReference(
  regionId: string,
  revision: number,
): BootstrapCredentialRef {
  return valid(Reference, {
    version: 1,
    region_id: regionId,
    purpose: "region_seed",
    revision,
  });
}
export async function loadCurrentRegionMaterialReference(
  db: D1Database,
  regionId: string,
  purpose: "join_bundle" | "region_seed",
): Promise<BootstrapCredentialRef> {
  valid(RegionId, regionId);
  valid(z.enum(["join_bundle", "region_seed"]), purpose);
  try {
    const row = await db
      .prepare("SELECT bootstrap_material_revision FROM regions WHERE id=?")
      .bind(regionId)
      .first<{ bootstrap_material_revision: number }>();
    if (!row) throw new CustodyError("region_missing");
    const revision = valid(
      z.number().int().min(1).max(2147483647),
      row.bootstrap_material_revision,
    );
    return valid(Reference, {
      version: 1,
      region_id: regionId,
      purpose,
      revision,
    });
  } catch (error) {
    if (error instanceof CustodyError) throw error;
    throw new CustodyError("unavailable");
  }
}
function reference(
  input: BootstrapCredentialRef,
  purpose: BootstrapCredentialRef["purpose"],
): BootstrapCredentialRef {
  const ref = valid(Reference, input);
  if (ref.purpose !== purpose) throw new CustodyError("invalid");
  return ref;
}
function keys(secret: string): {
  active: string;
  keys: Map<string, Uint8Array>;
} {
  try {
    if (typeof secret !== "string" || secret.length > 16384)
      throw new CustodyError("keyring_invalid");
    const parsed = Config.safeParse(JSON.parse(secret));
    if (!parsed.success) throw new CustodyError("keyring_invalid");
    const entries = Object.entries(parsed.data.keys);
    if (!entries.length || entries.length > 16)
      throw new CustodyError("keyring_invalid");
    const values = new Map<string, Uint8Array>();
    for (const [kid, text] of entries) {
      const bytes = base64urlToBytes(text);
      if (!bytes || bytes.length !== 32)
        throw new CustodyError("keyring_invalid");
      values.set(kid, bytes);
    }
    if (!values.has(parsed.data.active))
      throw new CustodyError("keyring_invalid");
    return { active: parsed.data.active, keys: values };
  } catch {
    throw new CustodyError("keyring_invalid");
  }
}
function aad(ref: BootstrapCredentialRef, kid: string): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "pgcf-region-bootstrap/v1",
      ref.version,
      ref.purpose,
      ref.region_id,
      ref.revision,
      kid,
    ]),
  );
}
interface EncryptedCustodyDocument {
  kid: string;
  iv: string;
  ciphertext: string;
}
async function sealDocument(
  secret: string,
  identity: (kid: string) => Uint8Array,
  plaintext: string,
): Promise<EncryptedCustodyDocument> {
  const ring = keys(secret),
    kid = ring.active,
    iv = crypto.getRandomValues(new Uint8Array(12)),
    value = utf8(plaintext, BOOTSTRAP_PLAINTEXT_MAX_BYTES);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(ring.keys.get(kid)!),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: Uint8Array.from(identity(kid)),
        tagLength: 128,
      },
      key,
      Uint8Array.from(value),
    );
    return {
      kid,
      iv: bytesToBase64url(iv),
      ciphertext: bytesToBase64url(new Uint8Array(ciphertext)),
    };
  } catch {
    throw new CustodyError("unavailable");
  }
}
async function openDocument(
  secret: string,
  identity: (kid: string) => Uint8Array,
  encrypted: EncryptedCustodyDocument,
): Promise<string> {
  const iv = base64urlToBytes(encrypted.iv),
    ciphertext = base64urlToBytes(encrypted.ciphertext);
  if (
    !iv ||
    iv.length !== 12 ||
    !ciphertext ||
    ciphertext.length < 16 ||
    ciphertext.length > BOOTSTRAP_PLAINTEXT_MAX_BYTES + 16
  )
    throw new CustodyError("invalid");
  const bytes = keys(secret).keys.get(encrypted.kid);
  if (!bytes) throw new CustodyError("key_unavailable");
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(bytes),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(iv),
        additionalData: Uint8Array.from(identity(encrypted.kid)),
        tagLength: 128,
      },
      key,
      Uint8Array.from(ciphertext),
    );
    const text = decoder.decode(plaintext);
    utf8(text, BOOTSTRAP_PLAINTEXT_MAX_BYTES);
    return text;
  } catch {
    throw new CustodyError("invalid");
  }
}
async function seal(
  secret: string,
  ref: BootstrapCredentialRef,
  plaintext: string,
): Promise<EncryptedBootstrapCredential> {
  return {
    ...ref,
    ...(await sealDocument(secret, (kid) => aad(ref, kid), plaintext)),
  };
}
async function open(
  secret: string,
  ref: BootstrapCredentialRef,
  input: EncryptedBootstrapCredential,
): Promise<string> {
  const encrypted = valid(Envelope, input);
  if (
    encrypted.version !== ref.version ||
    encrypted.region_id !== ref.region_id ||
    encrypted.purpose !== ref.purpose ||
    encrypted.revision !== ref.revision
  )
    throw new CustodyError("invalid");
  return openDocument(secret, (kid) => aad(ref, kid), encrypted);
}
function documentIdentity(
  scope: readonly (string | number)[],
  kid: string,
): Uint8Array {
  if (
    !scope.length ||
    scope.length > 8 ||
    scope.some((value) =>
      typeof value === "string"
        ? !value || value.length > 512
        : !Number.isSafeInteger(value),
    )
  )
    throw new CustodyError("invalid");
  return encoder.encode(
    JSON.stringify(["pgcf-custody-document/v1", ...scope, kid]),
  );
}
/** Uses the same rotating credential keyring; caller binds the complete domain identity. */
export function encryptCustodyDocument(
  secret: string,
  scope: readonly (string | number)[],
  plaintext: string,
) {
  return sealDocument(secret, (kid) => documentIdentity(scope, kid), plaintext);
}
export function decryptCustodyDocument(
  secret: string,
  scope: readonly (string | number)[],
  encrypted: EncryptedCustodyDocument,
) {
  valid(
    z.strictObject({
      kid: KeyId,
      iv: z.string().max(16),
      ciphertext: z.string().max(CIPHERTEXT_MAX_CHARS),
    }),
    encrypted,
  );
  return openDocument(secret, (kid) => documentIdentity(scope, kid), encrypted);
}

function agentKey(ref: BootstrapCredentialRef, key: string): string {
  if (
    typeof key !== "string" ||
    key.length > 128 ||
    parseAgentKey(key)?.regionId !== ref.region_id
  )
    throw new CustodyError("agent_mismatch");
  return key;
}
export function encryptAgentKey(
  secret: string,
  input: BootstrapCredentialRef,
  key: string,
): Promise<EncryptedBootstrapCredential> {
  const ref = reference(input, "agent_key");
  return seal(secret, ref, agentKey(ref, key));
}
export async function decryptAgentKey(
  secret: string,
  input: BootstrapCredentialRef,
  encrypted: EncryptedBootstrapCredential,
): Promise<string> {
  const ref = reference(input, "agent_key");
  return agentKey(ref, await open(secret, ref, encrypted));
}
export function encryptJoinBundle(
  secret: string,
  input: BootstrapCredentialRef,
  value: RegionJoinBundle,
): Promise<EncryptedBootstrapCredential> {
  const ref = reference(input, "join_bundle");
  return seal(secret, ref, JSON.stringify(bundle(value)));
}
export async function decryptJoinBundle(
  secret: string,
  input: BootstrapCredentialRef,
  encrypted: EncryptedBootstrapCredential,
): Promise<RegionJoinBundle> {
  const ref = reference(input, "join_bundle"),
    text = await open(secret, ref, encrypted);
  try {
    return bundle(JSON.parse(text));
  } catch {
    throw new CustodyError("invalid");
  }
}
export function encryptRegionSeed(
  secret: string,
  input: BootstrapCredentialRef,
  value: RegionSeed,
): Promise<EncryptedBootstrapCredential> {
  const ref = reference(input, "region_seed");
  return seal(secret, ref, JSON.stringify(seed(value)));
}
export async function decryptRegionSeed(
  secret: string,
  input: BootstrapCredentialRef,
  encrypted: EncryptedBootstrapCredential,
): Promise<RegionSeed> {
  const ref = reference(input, "region_seed"),
    text = await open(secret, ref, encrypted);
  try {
    return seed(JSON.parse(text));
  } catch {
    throw new CustodyError("invalid");
  }
}
export function bootstrapCredentialInsert(
  db: D1Database,
  input: EncryptedBootstrapCredential,
  createdAt: string,
): D1PreparedStatement {
  const value = valid(Envelope, input);
  valid(Reference, {
    version: value.version,
    region_id: value.region_id,
    purpose: value.purpose,
    revision: value.revision,
  });
  valid(Timestamp, createdAt);
  return db
    .prepare(
      "INSERT INTO region_bootstrap_credentials(region_id,purpose,revision,version,kid,iv,ciphertext,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      value.region_id,
      value.purpose,
      value.revision,
      value.version,
      value.kid,
      value.iv,
      value.ciphertext,
      createdAt,
    );
}
async function read(
  db: D1Database,
  ref: BootstrapCredentialRef,
): Promise<EncryptedBootstrapCredential> {
  try {
    const row = await db
      .prepare(
        "SELECT region_id,purpose,revision,version,kid,iv,ciphertext FROM region_bootstrap_credentials WHERE region_id=? AND purpose=? AND revision=?",
      )
      .bind(ref.region_id, ref.purpose, ref.revision)
      .first();
    if (!row) throw new CustodyError("unavailable");
    return valid(Envelope, row);
  } catch (error) {
    if (error instanceof CustodyError) throw error;
    throw new CustodyError("unavailable");
  }
}
async function regionHash(
  db: D1Database,
  ref: BootstrapCredentialRef,
): Promise<string> {
  try {
    const row = await db
      .prepare("SELECT agent_key_hash FROM regions WHERE id=?")
      .bind(ref.region_id)
      .first<{ agent_key_hash: string }>();
    if (!row || typeof row.agent_key_hash !== "string")
      throw new CustodyError("region_missing");
    return row.agent_key_hash;
  } catch (error) {
    if (error instanceof CustodyError) throw error;
    throw new CustodyError("unavailable");
  }
}
export interface AgentCustodyConfig {
  CREDENTIAL_KEYS: string;
  API_KEY_PEPPER: string;
}
export async function loadRegionAgentKey(
  db: D1Database,
  config: AgentCustodyConfig,
  input: BootstrapCredentialRef,
): Promise<string> {
  const ref = reference(input, "agent_key"),
    key = await decryptAgentKey(
      config.CREDENTIAL_KEYS,
      ref,
      await read(db, ref),
    );
  if (
    !timingSafeEqual(
      await regionHash(db, ref),
      await hashApiKey(config.API_KEY_PEPPER, key),
    )
  )
    throw new CustodyError("agent_mismatch");
  return key;
}
export async function importRegionAgentKey(
  db: D1Database,
  config: AgentCustodyConfig,
  regionId: string,
  supplied: string,
): Promise<BootstrapCredentialRef> {
  const ref = agentKeyReference(regionId),
    key = agentKey(ref, supplied),
    hash = await hashApiKey(config.API_KEY_PEPPER, key);
  if (!timingSafeEqual(await regionHash(db, ref), hash))
    throw new CustodyError("agent_mismatch");
  const value = await encryptAgentKey(config.CREDENTIAL_KEYS, ref, key);
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO region_bootstrap_credentials(region_id,purpose,revision,version,kid,iv,ciphertext,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM regions WHERE id=? AND agent_key_hash=?)",
      )
      .bind(
        ref.region_id,
        ref.purpose,
        ref.revision,
        value.version,
        value.kid,
        value.iv,
        value.ciphertext,
        new Date().toISOString(),
        ref.region_id,
        hash,
      )
      .run();
  } catch {
    throw new CustodyError("unavailable");
  }
  if (!timingSafeEqual(await loadRegionAgentKey(db, config, ref), key))
    throw new CustodyError("conflict");
  return ref;
}
export async function loadRegionJoinBundle(
  db: D1Database,
  secret: string,
  input: BootstrapCredentialRef,
): Promise<RegionJoinBundle> {
  const ref = reference(input, "join_bundle");
  await regionHash(db, ref);
  return decryptJoinBundle(secret, ref, await read(db, ref));
}
async function storeMaterial(
  db: D1Database,
  secret: string,
  ref: BootstrapCredentialRef,
  plaintext: string,
): Promise<BootstrapCredentialRef> {
  await regionHash(db, ref);
  const encrypted = await seal(secret, ref, plaintext);
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO region_bootstrap_credentials(region_id,purpose,revision,version,kid,iv,ciphertext,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        ref.region_id,
        ref.purpose,
        ref.revision,
        encrypted.version,
        encrypted.kid,
        encrypted.iv,
        encrypted.ciphertext,
        new Date().toISOString(),
      )
      .run();
  } catch {
    throw new CustodyError("unavailable");
  }
  if ((await open(secret, ref, await read(db, ref))) !== plaintext)
    throw new CustodyError("conflict");
  return ref;
}
export async function storeRegionJoinBundle(
  db: D1Database,
  secret: string,
  input: BootstrapCredentialRef,
  supplied: RegionJoinBundle,
): Promise<BootstrapCredentialRef> {
  return storeMaterial(
    db,
    secret,
    reference(input, "join_bundle"),
    JSON.stringify(bundle(supplied)),
  );
}
export async function storeRegionSeed(
  db: D1Database,
  secret: string,
  input: BootstrapCredentialRef,
  supplied: RegionSeed,
): Promise<BootstrapCredentialRef> {
  return storeMaterial(
    db,
    secret,
    reference(input, "region_seed"),
    JSON.stringify(seed(supplied)),
  );
}
export async function loadRegionSeed(
  db: D1Database,
  secret: string,
  input: BootstrapCredentialRef,
): Promise<RegionSeed> {
  const ref = reference(input, "region_seed");
  await regionHash(db, ref);
  return decryptRegionSeed(secret, ref, await read(db, ref));
}
