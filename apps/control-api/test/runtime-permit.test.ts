// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import { readRuntimePermitFunding } from "../src/budgets";
import {
  accountingCall as call,
  accountingFixture,
} from "./accounting-fixture";

const domain = "cloudflare-postgres/execution-permit/v2\u0000";
const keyId = "fixture-v2";
// RFC8032 test vector; publicly known and never suitable for an installation.
const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const publicKey =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const hex = (value: string) =>
  Uint8Array.from(value.match(/../g)!, (n) => Number.parseInt(n, 16));
const b64 = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const unb64 = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
const encoder = new TextEncoder();
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
async function sha(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}

// Capture real pre-revocation reads by exact statement and bindings. A reused
// first-primary session may subsequently see this snapshot; direct reads stay
// on the real database. No SQL parsing or constructed authority rows.
function replicatedView() {
  const saved = new Map<string, unknown>();
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const keys = new WeakMap<D1PreparedStatement, string>();
  const state = { cut: false, staleReads: 0, primaryReadsAfterCut: 0 };
  async function read(
    key: string,
    session: { reads: number } | null,
    real: () => Promise<unknown>,
  ) {
    const first = session ? session.reads++ === 0 : true;
    if (state.cut && session && !first) {
      state.staleReads++;
      if (!saved.has(key)) throw new Error("Missing captured read");
      return structuredClone(saved.get(key));
    }
    if (state.cut) state.primaryReadsAfterCut++;
    const result = await real();
    if (!state.cut) saved.set(key, structuredClone(result));
    return result;
  }
  function statement(
    real: D1PreparedStatement,
    sql: string,
    values: unknown[],
    session: { reads: number } | null,
  ): D1PreparedStatement {
    const identity = JSON.stringify([sql, values]);
    const proxy = new Proxy(real, {
      get(target, property) {
        if (property === "bind")
          return (...bound: unknown[]) =>
            statement(target.bind(...bound), sql, bound, session);
        if (property === "first" || property === "all" || property === "raw")
          return (...args: unknown[]) =>
            read(JSON.stringify([property, identity, args]), session, () => {
              const method = target[property] as (
                ...args: unknown[]
              ) => Promise<unknown>;
              return method.apply(target, args);
            });
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, real);
    keys.set(proxy, identity);
    return proxy;
  }
  function reader<T extends D1Database | D1DatabaseSession>(
    real: T,
    session: { reads: number } | null,
  ): T {
    return new Proxy(real, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) =>
            statement(target.prepare(sql), sql, [], session);
        if (property === "batch")
          return (statements: D1PreparedStatement[]) =>
            read(
              JSON.stringify(["batch", statements.map((s) => keys.get(s))]),
              session,
              () => target.batch(statements.map((s) => originals.get(s) ?? s)),
            );
        if (property === "withSession" && "withSession" in target)
          return (constraint?: D1SessionConstraint) =>
            reader(target.withSession(constraint), { reads: 0 });
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return { database: reader(env.DB, null), state };
}

it("issues one workload-scoped signed window from existing funding and refuses an actor revoked during signing", async () => {
  const f = await accountingFixture("Signed execution", undefined, {
    executionFencing: { version: 1 },
  });
  const claimResponse = await call(
    `/v1/regions/${f.regionId}/operations/claim`,
    {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    },
  );
  expect(claimResponse.status).toBe(200);
  const claim = (
    (await claimResponse.json()) as {
      claim: {
        operationId: string;
        leaseToken: string;
        leaseEpoch: number;
        specHash: string;
      };
    }
  ).claim;
  const fundedResponse = await call(
    `/v1/regions/${f.regionId}/operations/${claim.operationId}/funding`,
    {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        fundingSeconds: 300,
      }),
    },
  );
  expect(fundedResponse.status).toBe(201);
  const funded = (
    (await fundedResponse.json()) as {
      funding: {
        reservation: {
          id: string;
          revision: string;
          epoch: string;
          expiresAt: string;
        };
      };
    }
  ).funding;
  const before = await env.DB.prepare(
    "SELECT * FROM allowance_reservations WHERE id=?",
  )
    .bind(funded.reservation.id)
    .first();
  const asserted = {
    installationId: "fixture-installation",
    namespaceUid: "11111111-1111-4111-8111-111111111111",
    podUid: "22222222-2222-4222-8222-222222222222",
    containerName: "postgres",
    nodeName: "fixture-node",
    nodeUid: "33333333-3333-4333-8333-333333333333",
    bootId: "44444444-4444-4444-8444-444444444444",
    imageHash: "a".repeat(64),
    commandHash: "c".repeat(64),
  };
  const input = {
    leaseToken: claim.leaseToken,
    leaseEpoch: claim.leaseEpoch,
    reservationId: funded.reservation.id,
    challenge: {
      version: 2,
      nonce: b64(new Uint8Array(32).fill(7)),
      binding: asserted,
    },
  };
  const signingKeys = JSON.stringify({
    version: 1,
    installationId: asserted.installationId,
    active: keyId,
    keys: { [keyId]: b64(hex("302e020100300506032b657004220420" + seed)) },
  });
  const request = () =>
    new Request<unknown, IncomingRequestCfProperties>(
      `https://control.example.test/v1/regions/${f.regionId}/operations/${claim.operationId}/execution-permits`,
      { method: "POST", headers: f.regionHeaders, body: JSON.stringify(input) },
    );
  const invoke = (database = env.DB) =>
    worker.fetch(request(), {
      ...env,
      DB: database,
      RUNTIME_PERMIT_SIGNING_KEYS: signingKeys,
    } as Cloudflare.Env);
  const result = await invoke();
  expect(result.status).toBe(201);
  const value = (await result.json()) as {
    permit: {
      version: number;
      keyId: string;
      payload: string;
      signature: string;
    };
    runtimeEnforced: boolean;
    enforcementStatus: string;
  };
  expect(value.runtimeEnforced).toBe(false);
  expect(value.enforcementStatus).toBe("pending_runtime");
  expect(Object.keys(value.permit).sort()).toEqual([
    "keyId",
    "payload",
    "signature",
    "version",
  ]);
  expect(value.permit.version).toBe(2);
  expect(value.permit.keyId).toBe(keyId);
  const raw = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: false,
  }).decode(unb64(value.permit.payload));
  const payload = JSON.parse(raw) as {
    version: number;
    nonce: string;
    binding: Record<string, unknown>;
    durationNs: string;
    issuedAt: string;
    validUntil: string;
  };
  expect(raw).toBe(JSON.stringify(canonical(payload)));
  const envelope = {
    version: 1,
    instanceSlots: 2,
    quotaHard: {
      "requests.cpu": "1050m",
      "limits.cpu": "1200m",
      "requests.memory": "1152Mi",
      "limits.memory": "1280Mi",
      "requests.storage": "16Gi",
      persistentvolumeclaims: "2",
      pods: "2",
    },
    rates: {
      cpu_millicore_ms: "1050",
      memory_byte_ms: "1207959552",
      data_storage_byte_ms: "17179869184",
    },
  };
  expect(payload.binding).toEqual({
    ...asserted,
    organizationId: f.organizationId,
    projectId: f.projectId,
    regionId: f.regionId,
    reservationId: funded.reservation.id,
    reservationRevision: funded.reservation.revision,
    reservationEpoch: funded.reservation.epoch,
    operationId: claim.operationId,
    environmentId: f.environmentId,
    specRevision: 1,
    specHash: claim.specHash,
    runEpoch: "1",
    namespace: `pgcf-${f.environmentId.replaceAll("-", "")}`,
    resourceEnvelopeHash: await sha(JSON.stringify(canonical(envelope))),
  });
  expect(payload.version).toBe(2);
  expect(payload.nonce).toBe(input.challenge.nonce);
  expect(
    BigInt(payload.durationNs) > 0n &&
      BigInt(payload.durationNs) <= 15_000_000_000n,
  ).toBe(true);
  expect(Date.parse(payload.validUntil) - Date.parse(payload.issuedAt)).toBe(
    Number(BigInt(payload.durationNs) / 1_000_000n),
  );
  const knownPayload =
    '{"binding":{"bootId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","commandHash":"1f259a04d72c56de188723150f69d8f2375c6e8b0cb32d7931ae1a544a960add","containerName":"postgres","environmentId":"66666666-6666-4666-8666-666666666666","imageHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","installationId":"fixture-installation","namespace":"pgcf-env-66666666-6666-4666-8666-666666666666","namespaceUid":"77777777-7777-4777-8777-777777777777","nodeName":"fixture-node","nodeUid":"99999999-9999-4999-8999-999999999999","operationId":"55555555-5555-4555-8555-555555555555","organizationId":"11111111-1111-4111-8111-111111111111","podUid":"88888888-8888-4888-8888-888888888888","projectId":"22222222-2222-4222-8222-222222222222","regionId":"33333333-3333-4333-8333-333333333333","reservationEpoch":"1","reservationId":"44444444-4444-4444-8444-444444444444","reservationRevision":"0","resourceEnvelopeHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","runEpoch":"1","specHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","specRevision":1},"durationNs":"12000000000","issuedAt":"2026-09-30T00:00:00.000Z","nonce":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc","validUntil":"2026-09-30T00:00:12.000Z","version":2}';
  const knownSignature =
    "S-CpuT0BcWV8idvUJrCEVHTz3elN2cR9JY-yYbtDa_aZhp9laVFt4BS0jTRSvfjlib_U_1HPZwvEZjY7AIZtAQ";
  const pinned = await crypto.subtle.importKey(
    "raw",
    hex(publicKey),
    "Ed25519",
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      "Ed25519",
      pinned,
      unb64(knownSignature),
      encoder.encode(domain + keyId + "\u0000" + knownPayload),
    ),
  ).toBe(true);
  expect(
    await crypto.subtle.verify(
      "Ed25519",
      pinned,
      unb64(value.permit.signature),
      encoder.encode(domain + keyId + "\u0000" + raw),
    ),
  ).toBe(true);

  const actor = await env.DB.prepare(
    "SELECT lease_actor_token_id AS id FROM operations WHERE id=?",
  )
    .bind(claim.operationId)
    .first<{ id: string }>();
  expect(actor).not.toBeNull();
  const scopes = await env.DB.prepare(
    "SELECT scopes FROM region_tokens WHERE id=?",
  )
    .bind(actor!.id)
    .first<{ scopes: string }>();
  const originalSign = crypto.subtle.sign.bind(crypto.subtle);
  const attack = replicatedView();
  // Reuse the actual sampled caller time so the history query has identical
  // bindings in calibration and replay. D1's authoritative clock stays real.
  const wallClock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  let signingCalls = 0;
  const sign = vi
    .spyOn(crypto.subtle, "sign")
    .mockImplementation(async (algorithm, key, data) => {
      const signature = await originalSign(algorithm, key, data);
      signingCalls++;
      // Include the exact required-until read, using real funding before the
      // revocation. This is a legal stale snapshot, not synthetic success.
      const signed = JSON.parse(
        new TextDecoder().decode(data).split("\u0000").at(-1)!,
      ) as { validUntil: string };
      const proof = await readRuntimePermitFunding(
        request(),
        attack.database,
        f.regionId,
        claim.operationId,
        {
          leaseToken: claim.leaseToken,
          leaseEpoch: claim.leaseEpoch,
          reservationId: funded.reservation.id,
        },
      );
      expect(proof).not.toBeInstanceOf(Response);
      if (proof instanceof Response) throw new Error("Invalid calibration");
      expect(await proof.recheck(signed.validUntil)).not.toBeInstanceOf(
        Response,
      );
      await env.DB.prepare("UPDATE region_tokens SET scopes='' WHERE id=?")
        .bind(actor!.id)
        .run();
      attack.state.cut = true;
      return signature;
    });
  let denied: Response;
  try {
    denied = await invoke(attack.database);
  } finally {
    sign.mockRestore();
    wallClock.mockRestore();
    await env.DB.prepare("UPDATE region_tokens SET scopes=? WHERE id=?")
      .bind(scopes!.scopes, actor!.id)
      .run();
  }
  expect(signingCalls).toBe(1);
  expect(denied.status).toBe(409);
  expect(attack.state.primaryReadsAfterCut).toBeGreaterThan(0);
  expect(attack.state.staleReads).toBe(0);
  expect(await denied.json()).toEqual({
    error: { code: "runtime_permit_unavailable" },
  });
  expect(
    await env.DB.prepare("SELECT * FROM allowance_reservations WHERE id=?")
      .bind(funded.reservation.id)
      .first(),
  ).toEqual(before);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS count FROM allowance_reservations WHERE environment_id=?",
    )
      .bind(f.environmentId)
      .first(),
  ).toEqual({ count: 1 });
});
