// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  accountingCall,
  accountingFixture,
  installerHeaders,
} from "./accounting-fixture";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const fixtureKeys = JSON.stringify({
  active: "test-role-v1",
  keys: { "test-role-v1": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
});
function call(
  path: string,
  init: RequestInit<IncomingRequestCfProperties> = {},
  database = env.DB,
) {
  return worker.fetch(
    new IncomingRequest(`https://control.example.test${path}`, init),
    { ...env, DB: database, ROLE_CREDENTIAL_KEYS: fixtureKeys } as typeof env,
  );
}
interface RoleClaim {
  operationId: string;
  password: string;
  previousPassword: string | null;
  leaseToken: string;
  leaseEpoch: number;
  credentialRevision: number;
}
async function fixture(label: string) {
  const f = await accountingFixture(label);
  const issued = await accountingCall(
    `/v1/regions/${f.regionId}/operations/claim`,
    {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    },
  );
  const creation = (
    (await issued.json()) as {
      claim: { operationId: string; leaseToken: string; leaseEpoch: number };
    }
  ).claim;
  const namespaceUid = "33333333-3333-4333-8333-333333333333",
    clusterUid = "44444444-4444-4444-8444-444444444444",
    roleUid = "55555555-5555-4555-8555-555555555555",
    secretUid = "66666666-6666-4666-8666-666666666666";
  const ready = await accountingCall(
    `/v1/regions/${f.regionId}/operations/${creation.operationId}/result`,
    {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({
        leaseToken: creation.leaseToken,
        leaseEpoch: creation.leaseEpoch,
        status: "ready",
        resultCode: "cnpg_ready",
        observation: { clusterUid, clusterGeneration: 1, readyInstances: 1 },
      }),
    },
  );
  expect(ready.status).toBe(200);
  const base = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments/${f.environmentId}`;
  const created = await call(`${base}/roles`, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "owner" },
    body: JSON.stringify({ name: "dbowner", connectionLimit: 20 }),
  });
  expect(created.status).toBe(202);
  const role = ((await created.json()) as { role: { id: string } }).role;
  const roleLane = `/v1/regions/${f.regionId}/role-operations`;
  const owner = (
    (await (
      await call(`${roleLane}/claim`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({ leaseSeconds: 90 }),
      })
    ).json()) as { claim: RoleClaim }
  ).claim;
  const observation = {
    namespaceUid,
    clusterUid,
    roleUid,
    roleGeneration: 1,
    roleObservedGeneration: 1,
    secretUid,
    secretResourceVersion: "101",
    roleSecretResourceVersion: "101",
    authenticatedUser: "dbowner",
    authenticatedDatabase: "app",
    writablePrimary: true,
    previousCredentialRejected: null,
  };
  const applied = await call(`${roleLane}/${owner.operationId}/result`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({
      leaseToken: owner.leaseToken,
      leaseEpoch: owner.leaseEpoch,
      status: "applied",
      resultCode: "role_verified",
      observation,
    }),
  });
  expect(applied.status).toBe(200);
  const rotate = () =>
    call(`${base}/roles/${role.id}/rotate`, {
      method: "POST",
      headers: { ...f.orgHeaders, "idempotency-key": "rotate" },
      body: JSON.stringify({ expectedCredentialRevision: 1 }),
    });
  return { ...f, base, role, roleLane, owner, observation, rotate };
}

type Snapshot = Record<string, unknown>;
function object(value: unknown): value is Snapshot {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
// This facade models only a legal stale read from a reused original bookmark.
// It never parses/whitelists SQL: after the concrete primary cut ANY original
// session read gets the saved verified snapshot. Fresh primary reads stay real.
function laggingView(
  saved: Snapshot | null = null,
  onLeaseWrite?: (row: Snapshot) => Promise<Snapshot>,
) {
  let sessions = 0,
    cut = false,
    snapshot = saved;
  const stats = { staleReads: 0, freshPrimaryReadsAfterCut: 0, cut: false };
  function statement(
    real: D1PreparedStatement,
    original: boolean,
    first: () => boolean,
    direct = false,
  ): D1PreparedStatement {
    return new Proxy(real, {
      get(target, key) {
        if (key === "bind")
          return (...args: unknown[]) =>
            statement(target.bind(...args), original, first, direct);
        if (key === "first" || key === "all" || key === "raw")
          return async (...args: unknown[]) => {
            const firstRead = first();
            if (cut && original && !firstRead) {
              stats.staleReads++;
              expect(snapshot).not.toBeNull();
              const row = structuredClone(snapshot!);
              if (key === "first")
                return typeof args[0] === "string" ? row[args[0]] : row;
              if (key === "all")
                return { success: true, meta: {}, results: [row] };
              return [Object.values(row)];
            }
            if (cut && (direct || (!original && firstRead)))
              stats.freshPrimaryReadsAfterCut++;
            const method = Reflect.get(target, key) as (
              ...args: unknown[]
            ) => Promise<unknown>;
            const result = await method.apply(target, args);
            if (
              !cut &&
              object(result) &&
              Object.keys(result).length === 1 &&
              Object.values(result)[0] === 1
            ) {
              const clock = await env.DB.prepare(
                "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS serverNow",
              ).first<{ serverNow: string }>();
              expect(clock).not.toBeNull();
              snapshot = {
                ...structuredClone(result),
                serverNow: clock!.serverNow,
                leaseExpiresAt: null,
              };
            }
            if (
              !cut &&
              onLeaseWrite &&
              object(result) &&
              result.kind === "database.role.apply" &&
              result.status === "running" &&
              result.credential_revision === 2
            ) {
              snapshot = await onLeaseWrite(result);
              cut = true;
              stats.cut = true;
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "withSession")
        return (constraint?: D1SessionConstraint) => {
          const session = target.withSession(constraint),
            original = sessions++ === 0;
          let reads = 0;
          return new Proxy(session, {
            get(s, property) {
              if (property === "prepare")
                return (sql: string) =>
                  statement(s.prepare(sql), original, () => reads++ === 0);
              const value = Reflect.get(s, property);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
        };
      if (key === "prepare")
        return (sql: string) =>
          statement(target.prepare(sql), false, () => true, true);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database,
    stats,
    snapshot: () => snapshot,
    cut: () => {
      expect(snapshot).not.toBeNull();
      cut = true;
      stats.cut = true;
    },
  };
}
async function afterDecrypt(
  change: () => Promise<void>,
  invoke: () => Promise<Response>,
) {
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  let calls = 0;
  const decrypt = vi
    .spyOn(crypto.subtle, "decrypt")
    .mockImplementation(async (algorithm, key, data) => {
      const plaintext = await original(algorithm, key, data);
      calls++;
      expect(calls).toBe(1);
      await change();
      return plaintext;
    });
  try {
    return await invoke();
  } finally {
    decrypt.mockRestore();
  }
}

it("withholds role plaintext when the original organization actor is revoked during decryption despite a legal stale session snapshot", async () => {
  const f = await fixture("role plaintext authority");
  const path = `${f.base}/roles/${f.role.id}/credentials`;
  const healthyView = laggingView();
  const healthy = await call(
    path,
    { headers: f.orgHeaders },
    healthyView.database,
  );
  expect(healthy.status).toBe(200);
  expect(
    ((await healthy.json()) as { credential: { password: string } }).credential
      .password,
  ).toBe(f.owner.password);
  const view = laggingView(healthyView.snapshot());
  const denied = await afterDecrypt(
    async () => {
      const rotated = await call(
        `/v1/organizations/${f.organizationId}/tokens/reissue`,
        { method: "POST", headers: installerHeaders },
      );
      expect(rotated.status).toBe(201);
      view.cut();
    },
    () => call(path, { headers: f.orgHeaders }, view.database),
  );
  expect(view.stats.cut).toBe(true);
  expect(denied.status).toBe(409);
  expect(await denied.json()).toEqual({
    error: { code: "credential_not_applied" },
  });
  expect(view.stats.freshPrimaryReadsAfterCut).toBeGreaterThan(0);
});

it("withholds a superseded database-owner plaintext after real rotation during decryption and keeps latest-owner discovery distinct from creation history", async () => {
  const f = await fixture("owner plaintext rotation");
  const created = await call(`${f.base}/databases`, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "database" },
    body: JSON.stringify({ name: "customerdb", ownerRoleId: f.role.id }),
  });
  expect(created.status).toBe(202);
  const database = ((await created.json()) as { database: { id: string } })
    .database;
  const lane = `/v1/regions/${f.regionId}/database-operations`;
  const issued = (
    (await (
      await call(`${lane}/claim`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({ leaseSeconds: 90 }),
      })
    ).json()) as {
      claim: { operationId: string; leaseToken: string; leaseEpoch: number };
    }
  ).claim;
  const applied = await call(`${lane}/${issued.operationId}/result`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({
      leaseToken: issued.leaseToken,
      leaseEpoch: issued.leaseEpoch,
      status: "applied",
      resultCode: "database_verified",
      observation: {
        namespaceUid: f.observation.namespaceUid,
        clusterUid: f.observation.clusterUid,
        ownerRoleUid: f.observation.roleUid,
        ownerCredentialRevision: 1,
        secretUid: f.observation.secretUid,
        secretResourceVersion: "101",
        databaseUid: "77777777-7777-4777-8777-777777777777",
        databaseGeneration: 1,
        databaseObservedGeneration: 1,
        databaseOid: "16400",
        authenticatedUser: "dbowner",
        authenticatedDatabase: "customerdb",
        writablePrimary: true,
        databaseOwned: true,
        schemaCreateVerified: true,
        probeRolledBack: true,
      },
    }),
  });
  expect(applied.status).toBe(200);
  const path = `${f.base}/databases/${database.id}/credentials`;
  const healthyView = laggingView();
  const healthy = await call(
    path,
    { headers: f.orgHeaders },
    healthyView.database,
  );
  expect(healthy.status).toBe(200);
  expect(
    ((await healthy.json()) as { credential: { password: string } }).credential
      .password,
  ).toBe(f.owner.password);
  const view = laggingView(healthyView.snapshot());
  const denied = await afterDecrypt(
    async () => {
      expect((await f.rotate()).status).toBe(202);
      view.cut();
    },
    () => call(path, { headers: f.orgHeaders }, view.database),
  );
  expect(view.stats.cut).toBe(true);
  expect(denied.status).toBe(409);
  expect(await denied.json()).toEqual({
    error: { code: "credential_not_applied" },
  });
  expect(view.stats.freshPrimaryReadsAfterCut).toBeGreaterThan(0);
  const next = (
    (await (
      await call(`${f.roleLane}/claim`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({ leaseSeconds: 90 }),
      })
    ).json()) as { claim: RoleClaim }
  ).claim;
  expect(next.credentialRevision).toBe(2);
  const reported = await call(`${f.roleLane}/${next.operationId}/result`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({
      leaseToken: next.leaseToken,
      leaseEpoch: next.leaseEpoch,
      status: "applied",
      resultCode: "role_verified",
      observation: {
        ...f.observation,
        roleGeneration: 2,
        roleObservedGeneration: 2,
        secretUid: "88888888-8888-4888-8888-888888888888",
        secretResourceVersion: "202",
        roleSecretResourceVersion: "202",
        previousCredentialRejected: true,
      },
    }),
  });
  expect(reported.status).toBe(200);
  const current = await call(path, { headers: f.orgHeaders });
  expect(current.status).toBe(200);
  expect(
    (
      (await current.json()) as {
        credential: { credentialRevision: number; password: string };
      }
    ).credential,
  ).toMatchObject({ credentialRevision: 2, password: next.password });
});

it("withholds both rotation passwords after regional authority is cut following the real lease write and retains that committed lease", async () => {
  const f = await fixture("regional plaintext authority");
  const rotated = await f.rotate();
  expect(rotated.status).toBe(202);
  const operation = ((await rotated.json()) as { operation: { id: string } })
    .operation;
  let committed: Snapshot | null = null;
  const view = laggingView(null, async (row) => {
    expect(row.id).toBe(operation.id);
    expect(row.credential_revision).toBe(2);
    const verified = await env.DB.prepare(
      `SELECT 1 AS valid,strftime('%Y-%m-%dT%H:%M:%fZ','now') AS serverNow,o.lease_expires_at AS leaseExpiresAt
      FROM role_operations o JOIN region_tokens t ON t.id=o.lease_actor_token_id
      WHERE o.id=? AND o.status='running' AND o.lease_token_hash=? AND o.lease_epoch=?
      AND t.revoked_at IS NULL AND instr(' '||t.scopes||' ',' operations:claim ')>0`,
    )
      .bind(row.id, row.lease_token_hash, row.lease_epoch)
      .first<Snapshot>();
    expect(verified).not.toBeNull();
    committed = structuredClone(row);
    const reissued = await call(`/v1/regions/${f.regionId}/tokens/reissue`, {
      method: "POST",
      headers: installerHeaders,
    });
    expect(reissued.status).toBe(201);
    return { ...verified!, "1": 1 };
  });
  const denied = await call(
    `${f.roleLane}/claim`,
    {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    },
    view.database,
  );
  expect(view.stats.cut).toBe(true);
  expect(denied.status).toBe(409);
  const body = await denied.json();
  expect(body).toEqual({ error: { code: "lease_conflict" } });
  expect(JSON.stringify(body)).not.toContain("password");
  expect(JSON.stringify(body)).not.toContain("previousPassword");
  expect(view.stats.freshPrimaryReadsAfterCut).toBeGreaterThan(0);
  const retained = await env.DB.prepare(
    "SELECT * FROM role_operations WHERE id=?",
  )
    .bind(operation.id)
    .first<Snapshot>();
  expect(retained).toEqual(committed);
  expect(retained).toMatchObject({
    status: "running",
    lease_epoch: 1,
    credential_revision: 2,
  });
});
