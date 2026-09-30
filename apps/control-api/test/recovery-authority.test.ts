// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import { installerHeaders } from "./accounting-fixture";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const keys = JSON.stringify({
  active: "recovery-authority-v1",
  keys: {
    "recovery-authority-v1": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
});
function call(
  path: string,
  init: RequestInit<IncomingRequestCfProperties> = {},
  db = env.DB,
) {
  return worker.fetch(
    new IncomingRequest(`https://control.example.test${path}`, init),
    { ...env, DB: db, ROLE_CREDENTIAL_KEYS: keys } as typeof env,
  );
}
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
interface Issued {
  token: { id: string };
  apiToken: string;
}
async function fixture(label: string) {
  const boot = await call("/v1/organizations", {
    method: "POST",
    headers: installerHeaders,
    body: JSON.stringify({ name: label }),
  });
  expect(boot.status).toBe(201);
  const owner = (await boot.json()) as {
    organization: { id: string };
    apiToken: string;
  };
  const base = `/v1/organizations/${owner.organization.id}`;
  const projects: Array<{
    project: { id: string };
    operation: { id: string };
  }> = [];
  for (const name of ["first", "second"]) {
    const response = await call(`${base}/projects`, {
      method: "POST",
      headers: {
        ...headers(owner.apiToken),
        "content-type": "application/json",
        "idempotency-key": name,
      },
      body: JSON.stringify({ name: `${label} ${name}` }),
    });
    expect(response.status).toBe(201);
    projects.push(await response.json());
  }
  async function issue(): Promise<Issued> {
    const response = await call(`${base}/tokens`, {
      method: "POST",
      headers: installerHeaders,
      body: JSON.stringify({
        id: crypto.randomUUID(),
        scopes: ["projects:read", "operations:read"],
      }),
    });
    expect(response.status).toBe(201);
    return response.json();
  }
  const attacked = await issue(),
    sibling = await issue();
  const revoke = async () => {
    const response = await call(`${base}/tokens/${attacked.token.id}`, {
      method: "DELETE",
      headers: installerHeaders,
    });
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { token: { revokedAt: string | null } }).token
        .revokedAt,
    ).toEqual(expect.any(String));
  };
  const business = () =>
    env.DB.batch([
      env.DB.prepare(
        "SELECT * FROM projects WHERE organization_id=? ORDER BY id",
      ).bind(owner.organization.id),
      env.DB.prepare(
        "SELECT * FROM operations WHERE organization_id=? ORDER BY id",
      ).bind(owner.organization.id),
    ]).then((result) => result.map((row) => row.results));
  return { base, projects, attacked, sibling, revoke, business };
}
interface SavedPage {
  batch: D1Result[] | null;
}
// A reused session may serve the actual pre-revocation page after its first
// primary query. Direct binding reads stay real. No SQL parsing or invented
// authorized rows: both the batch and final actor row come from calibration.
function view(saved: SavedPage, afterLookup?: () => Promise<void>) {
  const state = {
    cut: false,
    staleBatches: 0,
    staleFinalReads: 0,
    primaryReadsAfterCut: 0,
    lookupCut: false,
  };
  const unwrapped = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let lookupDone = false;
  function statement(
    real: D1PreparedStatement,
    session: { reads: number } | null,
  ): D1PreparedStatement {
    const proxy = new Proxy(real, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            statement(target.bind(...values), session);
        if (property === "first")
          return async (...args: unknown[]) => {
            const first = session ? session.reads++ === 0 : true;
            if (state.cut && session && !first) {
              state.staleFinalReads++;
              expect(saved.batch).not.toBeNull();
              const row = structuredClone(saved.batch![0]!.results[0]!);
              return typeof args[0] === "string"
                ? (row as Record<string, unknown>)[args[0]]
                : row;
            }
            if (state.cut) state.primaryReadsAfterCut++;
            const method = target.first as (
              ...values: unknown[]
            ) => Promise<unknown>;
            const row = await method.apply(target, args);
            if (!lookupDone) {
              lookupDone = true;
              if (afterLookup) {
                expect(row).not.toBeNull();
                await afterLookup();
                state.cut = true;
                state.lookupCut = true;
              }
            }
            return row;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    unwrapped.set(proxy, real);
    return proxy;
  }
  function reader<T extends D1Database | D1DatabaseSession>(
    target: T,
    session: { reads: number } | null,
  ): T {
    return new Proxy(target, {
      get(db, property) {
        if (property === "prepare")
          return (sql: string) => statement(db.prepare(sql), session);
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const first = session ? session.reads++ === 0 : true;
            if (state.cut && session && !first) {
              state.staleBatches++;
              expect(saved.batch).not.toBeNull();
              return structuredClone(saved.batch!);
            }
            if (state.cut) state.primaryReadsAfterCut++;
            const result = await db.batch(
              statements.map((item) => unwrapped.get(item) ?? item),
            );
            if (!state.cut) saved.batch = structuredClone(result);
            return result;
          };
        if (property === "withSession" && "withSession" in db)
          return (constraint?: D1SessionConstraint) =>
            reader(db.withSession(constraint), { reads: 0 });
        const value = Reflect.get(db, property);
        return typeof value === "function" ? value.bind(db) : value;
      },
    });
  }
  return {
    database: reader(env.DB, null),
    state,
    cut: () => {
      state.cut = true;
    },
  };
}

it("denies operation metadata when the actor is revoked after authentication despite its original session snapshot", async () => {
  const f = await fixture("operation recovery authority");
  const path = `${f.base}/operations/${f.projects[0]!.operation.id}`;
  const saved: SavedPage = { batch: null };
  const calibration = view(saved);
  const healthy = await call(
    path,
    { headers: headers(f.attacked.apiToken) },
    calibration.database,
  );
  expect(healthy.status).toBe(200);
  expect(saved.batch?.[0]?.results).toHaveLength(1);
  const before = await f.business();
  const attack = view(saved, f.revoke);
  const response = await call(
    path,
    { headers: headers(f.attacked.apiToken) },
    attack.database,
  );
  expect(attack.state.lookupCut).toBe(true);
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
  expect(attack.state.primaryReadsAfterCut).toBeGreaterThan(0);
  expect(attack.state.staleBatches).toBe(0);
  expect(await f.business()).toEqual(before);
  const sibling = await call(path, { headers: headers(f.sibling.apiToken) });
  expect(sibling.status).toBe(200);
  expect(await sibling.json()).toEqual(await healthy.json());
});

it("withholds a real signed page when revocation commits during cursor signing despite the saved active actor", async () => {
  const f = await fixture("page recovery authority");
  const path = `${f.base}/projects?limit=1`;
  const saved: SavedPage = { batch: null };
  const calibration = view(saved);
  const healthy = await call(
    path,
    { headers: headers(f.attacked.apiToken) },
    calibration.database,
  );
  expect(healthy.status).toBe(200);
  expect(
    ((await healthy.json()) as { nextCursor: string | null }).nextCursor,
  ).toEqual(expect.any(String));
  expect(saved.batch?.[2]?.results).toHaveLength(2);
  const before = await f.business();
  const attack = view(saved);
  const realSign = crypto.subtle.sign.bind(crypto.subtle);
  let signed = 0;
  const sign = vi
    .spyOn(crypto.subtle, "sign")
    .mockImplementation(async (algorithm, key, data) => {
      const result = await realSign(algorithm, key, data);
      signed++;
      expect(signed).toBe(1);
      await f.revoke();
      attack.cut();
      return result;
    });
  let response: Response;
  try {
    response = await call(
      path,
      { headers: headers(f.attacked.apiToken) },
      attack.database,
    );
  } finally {
    sign.mockRestore();
  }
  expect(signed).toBe(1);
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
  expect(attack.state.primaryReadsAfterCut).toBeGreaterThan(0);
  expect(attack.state.staleFinalReads).toBe(0);
  expect(await f.business()).toEqual(before);
  const sibling = await call(path, { headers: headers(f.sibling.apiToken) });
  expect(sibling.status).toBe(200);
  const page = (await sibling.json()) as {
    projects: Array<{ project: { id: string } }>;
    nextCursor: string;
    consistency: string;
  };
  expect(page.consistency).toBe("observed-page");
  const next = await call(
    `${f.base}/projects?limit=1&cursor=${page.nextCursor}`,
    { headers: headers(f.sibling.apiToken) },
  );
  expect(next.status).toBe(200);
  const continuation = (await next.json()) as {
    projects: Array<{ project: { id: string } }>;
    nextCursor: string | null;
  };
  expect(continuation.nextCursor).toBeNull();
  expect(
    new Set(
      [...page.projects, ...continuation.projects].map((row) => row.project.id),
    ),
  ).toEqual(new Set(f.projects.map((row) => row.project.id)));
});
