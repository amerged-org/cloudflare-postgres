// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  base64urlToBytes,
  bytesToBase64url,
  newAgentKey,
  randomString,
} from "@pgcf/contracts";
import {
  agentKeyReference,
  joinBundleReference,
  encryptAgentKey,
  decryptAgentKey,
  encryptJoinBundle,
  decryptJoinBundle,
  importRegionAgentKey,
  loadRegionAgentKey,
  storeRegionJoinBundle,
  loadRegionJoinBundle,
  BOOTSTRAP_PLAINTEXT_MAX_BYTES,
  regionSeedReference,
  encryptRegionSeed,
  decryptRegionSeed,
  storeRegionSeed,
  loadRegionSeed,
} from "../../src/crypto/bootstrap-credentials.ts";
import { cleanupFixtures, fixture } from "../domain/fixtures.ts";
afterEach(cleanupFixtures);
const region = () =>
  "r-" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 12);
function config() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return {
    raw,
    secret: JSON.stringify({
      active: "old",
      keys: { old: bytesToBase64url(raw) },
    }),
  };
}
function bundle() {
  return {
    version: 1 as const,
    cluster_name: "c-" + crypto.randomUUID(),
    cluster_endpoint: `https://${["cluster", "invalid"].join(".")}:6443`,
    kube_system_uid: crypto.randomUUID(),
    talos_version: "v1.14.1",
    kubernetes_version: "v1.36.0",
    talos_machine_secrets_yaml: `cluster:\n  id: ${crypto.randomUUID()}\n`,
    talos_admin_config: `context: ${crypto.randomUUID()}\n`,
    kubeconfig: `apiVersion: v1\nkind: Config\nfixture: ${crypto.randomUUID()}\n`,
  };
}
it("uses real AES-GCM round trips with random twelve-byte IVs and references containing no payload", async () => {
  const { secret } = config(),
    id = region(),
    key = newAgentKey(id),
    ref = agentKeyReference(id),
    join = joinBundleReference(id, 1),
    data = bundle();
  const first = await encryptAgentKey(secret, ref, key),
    second = await encryptAgentKey(secret, ref, key);
  expect(first.iv).not.toBe(second.iv);
  expect(base64urlToBytes(first.iv)!.length).toBe(12);
  expect(base64urlToBytes(first.ciphertext)!.length).toBe(
    new TextEncoder().encode(key).length + 16,
  );
  expect(await decryptAgentKey(secret, ref, first)).toBe(key);
  const encrypted = await encryptJoinBundle(secret, join, data);
  expect(await decryptJoinBundle(secret, join, encrypted)).toEqual(data);
  expect(JSON.stringify(join)).not.toContain(data.talos_admin_config);
  expect(JSON.stringify(encrypted)).not.toContain(key);
});
it("binds region, purpose, revision, version and kid rather than allowing metadata swaps", async () => {
  const { secret, raw } = config(),
    id = region(),
    ref = joinBundleReference(id, 1),
    encrypted = await encryptJoinBundle(secret, ref, bundle());
  const foreign = joinBundleReference(region(), 1);
  await expect(
    decryptJoinBundle(secret, foreign, {
      ...encrypted,
      region_id: foreign.region_id,
    }),
  ).rejects.toThrow("bootstrap_credential_invalid");
  const next = joinBundleReference(id, 2);
  await expect(
    decryptJoinBundle(secret, next, { ...encrypted, revision: 2 }),
  ).rejects.toThrow("bootstrap_credential_invalid");
  const agent = agentKeyReference(id);
  await expect(
    decryptAgentKey(secret, agent, { ...encrypted, purpose: "agent_key" }),
  ).rejects.toThrow("bootstrap_credential_invalid");
  const twoKids = JSON.stringify({
    active: "old",
    keys: { old: bytesToBase64url(raw), alternate: bytesToBase64url(raw) },
  });
  await expect(
    decryptJoinBundle(twoKids, ref, { ...encrypted, kid: "alternate" }),
  ).rejects.toThrow("bootstrap_credential_invalid");
  await expect(
    decryptJoinBundle(secret, ref, {
      ...encrypted,
      version: 2,
    } as unknown as typeof encrypted),
  ).rejects.toThrow("bootstrap_credential_invalid");
});
it("retains old kid custody across active-key changes and fails closed when the old kid is missing", async () => {
  const { secret, raw } = config(),
    id = region(),
    ref = agentKeyReference(id),
    key = newAgentKey(id),
    encrypted = await encryptAgentKey(secret, ref, key);
  const fresh = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const rotated = JSON.stringify({
    active: "new",
    keys: { old: bytesToBase64url(raw), new: fresh },
  });
  expect(await decryptAgentKey(rotated, ref, encrypted)).toBe(key);
  expect(encrypted.kid).toBe("old");
  await expect(
    decryptAgentKey(
      JSON.stringify({ active: "new", keys: { new: bytesToBase64url(raw) } }),
      ref,
      encrypted,
    ),
  ).rejects.toThrow("bootstrap_credential_key_unavailable");
});
it("refuses tampering, malformed encodings and noncanonical keys with bounded nonsecret errors", async () => {
  const { secret, raw } = config(),
    id = region(),
    ref = agentKeyReference(id),
    key = newAgentKey(id),
    encrypted = await encryptAgentKey(secret, ref, key);
  const bytes = base64urlToBytes(encrypted.ciphertext)!;
  bytes[0] = bytes[0]! ^ 1;
  await expect(
    decryptAgentKey(secret, ref, {
      ...encrypted,
      ciphertext: bytesToBase64url(bytes),
    }),
  ).rejects.toThrow("bootstrap_credential_invalid");
  await expect(
    decryptAgentKey(secret, ref, {
      ...encrypted,
      iv: bytesToBase64url(new Uint8Array(11)),
    }),
  ).rejects.toThrow("bootstrap_credential_invalid");
  await expect(
    decryptAgentKey(secret, ref, {
      ...encrypted,
      ciphertext: encrypted.ciphertext + "=",
    }),
  ).rejects.toThrow("bootstrap_credential_invalid");
  const padded = JSON.stringify({
    active: "old",
    keys: { old: bytesToBase64url(raw) + "=" },
  });
  await expect(encryptAgentKey(padded, ref, key)).rejects.toThrow(
    "bootstrap_credential_keyring_invalid",
  );
  try {
    await encryptAgentKey(key, ref, key);
    throw new Error("fixture_missing_rejection");
  } catch (error) {
    expect((error as Error).message).toBe(
      "bootstrap_credential_keyring_invalid",
    );
  }
});
it("enforces structured bundle bounds and strict UTF8 without interpreting or fabricating Talos configuration", async () => {
  const { secret, raw } = config(),
    ref = joinBundleReference(region(), 1),
    data = bundle();
  expect(() =>
    encryptJoinBundle(secret, ref, {
      ...data,
      extra: crypto.randomUUID(),
    } as unknown as typeof data),
  ).toThrow("bootstrap_credential_invalid");
  expect(() =>
    encryptJoinBundle(secret, ref, {
      ...data,
      kubeconfig: "x".repeat(BOOTSTRAP_PLAINTEXT_MAX_BYTES),
    }),
  ).toThrow("bootstrap_credential_invalid");
  expect(() =>
    encryptJoinBundle(secret, ref, {
      ...data,
      talos_admin_config: String.fromCharCode(0xd800),
    }),
  ).toThrow("bootstrap_credential_invalid");
  expect(() =>
    encryptJoinBundle(secret, ref, {
      ...data,
      cluster_endpoint: `http://${["cluster", "invalid"].join(".")}`,
    }),
  ).toThrow("bootstrap_credential_invalid");
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    imported = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
      "encrypt",
    ]);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(
        JSON.stringify([
          "pgcf-region-bootstrap/v1",
          1,
          "join_bundle",
          ref.region_id,
          1,
          "old",
        ]),
      ),
      tagLength: 128,
    },
    imported,
    new Uint8Array([0xc3, 0x28]),
  );
  await expect(
    decryptJoinBundle(secret, ref, {
      ...ref,
      kid: "old",
      iv: bytesToBase64url(iv),
      ciphertext: bytesToBase64url(new Uint8Array(ciphertext)),
    }),
  ).rejects.toThrow("bootstrap_credential_invalid");
});
it("imports only a matching legacy region agent key and never rotates its actual hash", async () => {
  const state = await fixture(),
    cfg = {
      CREDENTIAL_KEYS: env.CREDENTIAL_KEYS,
      API_KEY_PEPPER: env.API_KEY_PEPPER,
    };
  await expect(
    importRegionAgentKey(env.DB, cfg, state.region, state.foreignAgent),
  ).rejects.toThrow("bootstrap_credential_agent_mismatch");
  await expect(
    importRegionAgentKey(env.DB, cfg, state.region, newAgentKey(state.region)),
  ).rejects.toThrow("bootstrap_credential_agent_mismatch");
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM region_bootstrap_credentials WHERE region_id=?",
    )
      .bind(state.region)
      .first("count"),
  ).toBe(0);
  const before = await env.DB.prepare(
    "SELECT agent_key_hash FROM regions WHERE id=?",
  )
    .bind(state.region)
    .first("agent_key_hash");
  const refs = await Promise.all([
    importRegionAgentKey(env.DB, cfg, state.region, state.agent),
    importRegionAgentKey(env.DB, cfg, state.region, state.agent),
  ]);
  expect(refs[0]).toEqual(refs[1]);
  expect(await loadRegionAgentKey(env.DB, cfg, refs[0]!)).toBe(state.agent);
  expect(
    await env.DB.prepare("SELECT agent_key_hash FROM regions WHERE id=?")
      .bind(state.region)
      .first("agent_key_hash"),
  ).toBe(before);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM region_bootstrap_credentials WHERE region_id=?",
    )
      .bind(state.region)
      .first("count"),
  ).toBe(1);
});
it("stores immutable versioned bundle references on real D1 and refuses conflicting overwrite", async () => {
  const state = await fixture(),
    ref = joinBundleReference(state.region, 1),
    data = bundle();
  const references = await Promise.all([
    storeRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref, data),
    storeRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref, data),
  ]);
  expect(references[0]).toEqual(ref);
  expect(references[1]).toEqual(ref);
  const original = await env.DB.prepare(
    "SELECT kid,iv,ciphertext FROM region_bootstrap_credentials WHERE region_id=? AND purpose='join_bundle' AND revision=1",
  )
    .bind(state.region)
    .first();
  await expect(
    storeRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref, {
      ...data,
      kubeconfig: crypto.randomUUID(),
    }),
  ).rejects.toThrow("bootstrap_credential_conflict");
  expect(
    await env.DB.prepare(
      "SELECT kid,iv,ciphertext FROM region_bootstrap_credentials WHERE region_id=? AND purpose='join_bundle' AND revision=1",
    )
      .bind(state.region)
      .first(),
  ).toEqual(original);
  expect(await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref)).toEqual(
    data,
  );
  await expect(
    loadRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(state.foreign, 1),
    ),
  ).rejects.toThrow("bootstrap_credential_unavailable");
});

it("a durable region seed resumes the same keys before full cluster readback and cannot masquerade as a join bundle", async () => {
  const state = await fixture(),
    full = bundle(),
    value = {
      version: full.version,
      cluster_name: full.cluster_name,
      cluster_endpoint: full.cluster_endpoint,
      talos_version: full.talos_version,
      kubernetes_version: full.kubernetes_version,
      talos_machine_secrets_yaml: full.talos_machine_secrets_yaml,
      talos_admin_config: full.talos_admin_config,
    };
  const ref = regionSeedReference(state.region, 1),
    join = joinBundleReference(state.region, 1);
  await storeRegionSeed(env.DB, env.CREDENTIAL_KEYS, ref, value);
  expect(await loadRegionSeed(env.DB, env.CREDENTIAL_KEYS, ref)).toEqual(value);
  expect(
    await storeRegionSeed(env.DB, env.CREDENTIAL_KEYS, ref, value),
  ).toEqual(ref);
  const encrypted = await encryptRegionSeed(env.CREDENTIAL_KEYS, ref, value);
  expect(await decryptRegionSeed(env.CREDENTIAL_KEYS, ref, encrypted)).toEqual(
    value,
  );
  await expect(
    decryptJoinBundle(env.CREDENTIAL_KEYS, join, {
      ...encrypted,
      purpose: "join_bundle",
    }),
  ).rejects.toThrow("bootstrap_credential_invalid");
  await expect(
    loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref),
  ).rejects.toThrow("bootstrap_credential_invalid");
  await storeRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, join, full);
  expect(await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, join)).toEqual(
    full,
  );
  await expect(
    decryptRegionSeed(env.CREDENTIAL_KEYS, ref, {
      ...(await encryptJoinBundle(env.CREDENTIAL_KEYS, join, full)),
      purpose: "region_seed",
    }),
  ).rejects.toThrow("bootstrap_credential_invalid");
});
it("a legacy import cannot commit after the actual region hash changes during encryption", async () => {
  const state = await fixture(),
    replacement = newAgentKey(state.region);
  const { hashApiKey } = await import("@pgcf/contracts"),
    changedHash = await hashApiKey(env.API_KEY_PEPPER, replacement);
  const original = crypto.subtle.encrypt.bind(crypto.subtle);
  const spy = vi
    .spyOn(crypto.subtle, "encrypt")
    .mockImplementation(async (algorithm, key, data) => {
      await env.DB.prepare("UPDATE regions SET agent_key_hash=? WHERE id=?")
        .bind(changedHash, state.region)
        .run();
      return original(algorithm, key, data);
    });
  try {
    await expect(
      importRegionAgentKey(env.DB, env, state.region, state.agent),
    ).rejects.toThrow("bootstrap_credential_unavailable");
  } finally {
    spy.mockRestore();
  }
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM region_bootstrap_credentials WHERE region_id=?",
    )
      .bind(state.region)
      .first("count"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT agent_key_hash FROM regions WHERE id=?")
      .bind(state.region)
      .first("agent_key_hash"),
  ).toBe(changedHash);
});
