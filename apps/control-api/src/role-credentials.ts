// SPDX-License-Identifier: Apache-2.0
import { fields, object, type AccountingDb } from "./accounting";

export type RoleEnv = Cloudflare.Env & { ROLE_CREDENTIAL_KEYS?: string };
export interface CredentialContext {
  organizationId: string;
  projectId: string;
  environmentId: string;
  regionId: string;
  specRevision: number;
  specHash: string;
  clusterUid: string;
  roleId: string;
  roleName: string;
  credentialRevision: number;
}
export interface RoleCredentialIdentity {
  id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  region_id: string;
  spec_revision: number;
  spec_hash: string;
  cluster_uid: string;
  name: string;
}
export function roleCredentialContext(
  role: RoleCredentialIdentity,
  revision: number,
): CredentialContext {
  return {
    organizationId: role.organization_id,
    projectId: role.project_id,
    environmentId: role.environment_id,
    regionId: role.region_id,
    specRevision: role.spec_revision,
    specHash: role.spec_hash,
    clusterUid: role.cluster_uid,
    roleId: role.id,
    roleName: role.name,
    credentialRevision: revision,
  };
}
export async function readRoleCredential(
  db: AccountingDb,
  role: RoleCredentialIdentity,
  revision: number,
  env: RoleEnv,
): Promise<string> {
  const row = await db
    .prepare(
      "SELECT encrypted_json FROM role_credentials WHERE role_id = ? AND credential_revision = ?",
    )
    .bind(role.id, revision)
    .first<{ encrypted_json: string }>();
  if (!row) throw new Error("role_credential_missing");
  return decryptCredential(
    env,
    row.encrypted_json,
    roleCredentialContext(role, revision),
  );
}
interface EncryptedCredential {
  schemaVersion: 1;
  keyId: string;
  iv: string;
  ciphertext: string;
}
function base64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("role_credential_invalid");
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
function keys(env: RoleEnv): { active: string; keys: Record<string, string> } {
  try {
    const value: unknown = JSON.parse(env.ROLE_CREDENTIAL_KEYS ?? "null");
    if (
      !fields(value, ["active", "keys"]) ||
      typeof value.active !== "string" ||
      !object(value.keys) ||
      !Object.hasOwn(value.keys, value.active) ||
      Object.keys(value.keys).length < 1 ||
      Object.keys(value.keys).length > 8 ||
      !Object.keys(value.keys).every((key) =>
        /^[A-Za-z0-9_.-]{1,32}$/.test(key),
      ) ||
      !Object.values(value.keys).every(
        (key) =>
          typeof key === "string" &&
          key.length <= 64 &&
          bytes(key).byteLength === 32,
      )
    )
      throw new Error();
    return value as unknown as { active: string; keys: Record<string, string> };
  } catch {
    throw new Error("role_credential_key_unavailable");
  }
}
function context(value: CredentialContext): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(
    JSON.stringify({
      version: "database-role-credential/v1",
      organizationId: value.organizationId,
      projectId: value.projectId,
      environmentId: value.environmentId,
      regionId: value.regionId,
      specRevision: value.specRevision,
      specHash: value.specHash,
      clusterUid: value.clusterUid,
      roleId: value.roleId,
      roleName: value.roleName,
      credentialRevision: value.credentialRevision,
    }),
  );
  const owned = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  owned.set(encoded);
  return owned;
}
export function newPassword(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32)));
}
export async function encryptCredential(
  env: RoleEnv,
  password: string,
  identity: CredentialContext,
): Promise<string> {
  const ring = keys(env);
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(ring.keys[ring.active]!),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: context(identity) },
    key,
    new TextEncoder().encode(password),
  );
  return JSON.stringify({
    schemaVersion: 1,
    keyId: ring.active,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  } satisfies EncryptedCredential);
}
export async function decryptCredential(
  env: RoleEnv,
  encrypted: string,
  identity: CredentialContext,
): Promise<string> {
  const ring = keys(env);
  const value: unknown = JSON.parse(encrypted);
  if (
    !fields(value, ["schemaVersion", "keyId", "iv", "ciphertext"]) ||
    value.schemaVersion !== 1 ||
    typeof value.keyId !== "string" ||
    !Object.hasOwn(ring.keys, value.keyId) ||
    typeof value.iv !== "string" ||
    bytes(value.iv).byteLength !== 12 ||
    typeof value.ciphertext !== "string" ||
    value.ciphertext.length > 512
  )
    throw new Error("role_credential_key_unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(ring.keys[value.keyId]!),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(value.iv), additionalData: context(identity) },
    key,
    bytes(value.ciphertext),
  );
  const password = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: false,
  }).decode(plaintext);
  if (!/^[A-Za-z0-9_-]{43}$/.test(password))
    throw new Error("role_credential_invalid");
  return password;
}
