// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import { installerHeaders } from "./accounting-fixture";

type TokenEnv = Cloudflare.Env & { ROLE_CREDENTIAL_KEYS?: string };
interface TokenMetadata {
  id: string;
  organizationId: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
}
interface IssuedToken {
  token: TokenMetadata;
  apiToken: string;
}
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const firstKey = btoa(String.fromCharCode(...new Uint8Array(32)));
const secondKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const ring = (active = "fixture-v1", historical = true) =>
  JSON.stringify({
    active,
    keys: {
      ...(historical ? { "fixture-v1": firstKey.replaceAll("=", "") } : {}),
      ...(active === "fixture-v2"
        ? { "fixture-v2": secondKey.replaceAll("=", "") }
        : {}),
    },
  });
const settings = (): TokenEnv => ({ ...env, ROLE_CREDENTIAL_KEYS: ring() });
function call(
  context: TokenEnv,
  path: string,
  init: RequestInit<IncomingRequestCfProperties> = {},
) {
  return worker.fetch(
    new IncomingRequest(`https://control.example.test${path}`, init),
    context,
  );
}
async function bootstrap(context: TokenEnv, name: string) {
  const response = await call(context, "/v1/organizations", {
    method: "POST",
    headers: installerHeaders,
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    organization: { id: string };
    apiToken: string;
  };
}
function issue(
  context: TokenEnv,
  organizationId: string,
  id: string,
  scopes: string[],
) {
  return call(context, `/v1/organizations/${organizationId}/tokens`, {
    method: "POST",
    headers: installerHeaders,
    body: JSON.stringify({ id, scopes }),
  });
}
function credentials(secret: string, key = "token-project") {
  return {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
    "idempotency-key": key,
  };
}
function withLostWrite(
  context: TokenEnv,
  prefix: string,
  committed: () => void,
) {
  let lost = false;
  const db = new Proxy(context.DB, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.startsWith(prefix)) return statement;
          return new Proxy(statement, {
            get(source, method) {
              if (method === "bind")
                return (...values: unknown[]) => {
                  const bound = source.bind(...values);
                  return new Proxy(bound, {
                    get(next, operation) {
                      if (operation === "run")
                        return async () => {
                          const result = await next.run();
                          if (!lost) {
                            lost = true;
                            committed();
                            throw new Error("fixture_lost_committed_response");
                          }
                          return result;
                        };
                      const value = Reflect.get(next, operation);
                      return typeof value === "function"
                        ? value.bind(next)
                        : value;
                    },
                  });
                };
              const value = Reflect.get(source, method);
              return typeof value === "function" ? value.bind(source) : value;
            },
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { context: { ...context, DB: db }, lost: () => lost };
}

it("issues an exact scoped token and recovers its committed response without duplicating authority", async () => {
  const context = settings();
  const owner = await bootstrap(context, "Scoped integration owner");
  const organizationId = owner.organization.id;
  const id = crypto.randomUUID();
  const uncertain = withLostWrite(context, "INSERT INTO api_tokens", () => {});
  const response = await issue(uncertain.context, organizationId, id, [
    "projects:read",
    "operations:read",
  ]);
  expect(response.status).toBe(201);
  expect(uncertain.lost()).toBe(true);
  const issued = (await response.json()) as IssuedToken;
  expect(issued.token).toEqual({
    id,
    organizationId,
    scopes: ["operations:read", "projects:read"],
    createdAt: expect.any(String),
    revokedAt: null,
  });
  expect(issued.apiToken).toMatch(/^cporg_[A-Za-z0-9_-]{43}$/);
  const replay = await issue(context, organizationId, id, [
    "operations:read",
    "projects:read",
  ]);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(issued);
  const stored = await env.DB.prepare("SELECT * FROM api_tokens WHERE id=?")
    .bind(id)
    .first<{ token_hash: string; scopes: string }>();
  expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(stored)).not.toContain(issued.apiToken);
  expect(stored?.scopes).toBe("operations:read projects:read");

  const created = await call(
    context,
    `/v1/organizations/${organizationId}/projects`,
    {
      method: "POST",
      headers: credentials(owner.apiToken),
      body: JSON.stringify({ name: "Integration read target" }),
    },
  );
  expect(created.status).toBe(201);
  const project = (await created.json()) as {
    project: { id: string };
    operation: { id: string };
  };
  const withoutKeys = { ...context, ROLE_CREDENTIAL_KEYS: undefined };
  const readable = await call(
    withoutKeys,
    `/v1/organizations/${organizationId}/projects/${project.project.id}`,
    {
      headers: credentials(issued.apiToken),
    },
  );
  expect(readable.status).toBe(200);
  const operation = await call(
    withoutKeys,
    `/v1/organizations/${organizationId}/operations/${project.operation.id}`,
    {
      headers: credentials(issued.apiToken),
    },
  );
  expect(operation.status).toBe(200);
  const denied = await call(
    context,
    `/v1/organizations/${organizationId}/projects`,
    {
      method: "POST",
      headers: credentials(issued.apiToken, "readonly-denied"),
      body: JSON.stringify({ name: "Must not be created" }),
    },
  );
  expect(denied.status).toBe(403);
});

it("retains redacted organization-bound history and revokes one in-flight writer while preserving a sibling", async () => {
  const context = settings();
  const owner = await bootstrap(context, "Selective revoke owner");
  const foreign = await bootstrap(context, "Selective revoke foreign");
  const organizationId = owner.organization.id;
  const collection = `/v1/organizations/${organizationId}/tokens`;
  const legacy = await env.DB.prepare(
    "SELECT id FROM api_tokens WHERE organization_id=?",
  )
    .bind(organizationId)
    .first<{ id: string }>();
  const initial = await call(context, `${collection}/${legacy!.id}`, {
    headers: installerHeaders,
  });
  expect(initial.status).toBe(200);
  expect(
    Object.keys(
      ((await initial.json()) as { token: TokenMetadata }).token,
    ).sort(),
  ).toEqual(["createdAt", "id", "organizationId", "revokedAt", "scopes"]);
  const writerId = crypto.randomUUID();
  const issuedResponse = await issue(context, organizationId, writerId, [
    "projects:write",
  ]);
  expect(issuedResponse.status).toBe(201);
  const writer = (await issuedResponse.json()) as IssuedToken;
  context.ROLE_CREDENTIAL_KEYS = undefined;
  const deniedAdmin = await call(context, collection, {
    headers: credentials(owner.apiToken),
  });
  expect(deniedAdmin.status).toBe(401);
  const wrongOwner = await call(
    context,
    `/v1/organizations/${foreign.organization.id}/tokens/${writerId}`,
    {
      method: "DELETE",
      headers: installerHeaders,
    },
  );
  expect(wrongOwner.status).toBe(404);
  const page = await call(context, `${collection}?limit=1`, {
    headers: installerHeaders,
  });
  expect(page.status).toBe(200);
  const first = (await page.json()) as {
    tokens: TokenMetadata[];
    nextCursor: string;
  };
  expect(first.tokens).toHaveLength(1);
  expect(first.nextCursor).toEqual(expect.any(String));
  const remaining = await call(
    context,
    `${collection}?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    {
      headers: installerHeaders,
    },
  );
  expect(remaining.status).toBe(200);
  const second = (await remaining.json()) as {
    tokens: TokenMetadata[];
    nextCursor: null;
  };
  expect(second.tokens).toHaveLength(1);
  expect(second.tokens[0]?.id).not.toBe(first.tokens[0]?.id);
  expect(second.nextCursor).toBeNull();
  expect(JSON.stringify([...first.tokens, ...second.tokens])).not.toMatch(
    /token_hash|apiToken|cporg_/,
  );
  const moved = await call(
    context,
    `/v1/organizations/${foreign.organization.id}/tokens?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    {
      headers: installerHeaders,
    },
  );
  expect(moved.status).toBe(400);

  const before = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM projects WHERE organization_id=?",
  )
    .bind(organizationId)
    .first<{ count: number }>();
  let revoked: TokenMetadata | null = null;
  const uncertain = withLostWrite(
    context,
    "UPDATE api_tokens SET revoked_at",
    () => {},
  );
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const response = await call(
          uncertain.context,
          `${collection}/${writerId}`,
          {
            method: "DELETE",
            headers: installerHeaders,
            body: new ReadableStream<Uint8Array>({
              start(empty) {
                empty.close();
              },
            }),
          },
        );
        expect(response.status).toBe(200);
        revoked = ((await response.json()) as { token: TokenMetadata }).token;
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ name: "Revoked before commit" }),
          ),
        );
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const deniedWrite = await call(
    context,
    `/v1/organizations/${organizationId}/projects`,
    {
      method: "POST",
      headers: credentials(writer.apiToken, "revoked-writer"),
      body,
    },
  );
  expect(deniedWrite.status).toBe(401);
  expect(uncertain.lost()).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM projects WHERE organization_id=?",
    )
      .bind(organizationId)
      .first(),
  ).toEqual(before);
  const repeated = await call(context, `${collection}/${writerId}`, {
    method: "DELETE",
    headers: installerHeaders,
  });
  expect(repeated.status).toBe(200);
  expect(((await repeated.json()) as { token: TokenMetadata }).token).toEqual(
    revoked,
  );
  const revokedReplay = await issue(context, organizationId, writerId, [
    "projects:write",
  ]);
  expect(revokedReplay.status).toBe(409);
  const sibling = await call(
    context,
    `/v1/organizations/${organizationId}/projects`,
    {
      method: "POST",
      headers: credentials(owner.apiToken, "sibling-survives"),
      body: JSON.stringify({ name: "Unaffected sibling" }),
    },
  );
  expect(sibling.status).toBe(201);
});

it("replays historical derived credentials after key rotation and refuses unavailable or conflicting authority without mutation", async () => {
  const context = settings();
  const owner = await bootstrap(context, "Historical credential owner");
  const organizationId = owner.organization.id;
  const legacy = await env.DB.prepare(
    "SELECT id FROM api_tokens WHERE organization_id=?",
  )
    .bind(organizationId)
    .first<{ id: string }>();
  const legacyReplay = await issue(context, organizationId, legacy!.id, [
    "projects:read",
    "projects:write",
    "operations:read",
  ]);
  expect(legacyReplay.status).toBe(409);
  expect(await legacyReplay.json()).toEqual({
    error: { code: "token_replay_unavailable" },
  });
  const id = crypto.randomUUID();
  const uncertain = withLostWrite(context, "INSERT INTO api_tokens", () => {
    context.ROLE_CREDENTIAL_KEYS = ring("fixture-v2");
    uncertain.context.ROLE_CREDENTIAL_KEYS = context.ROLE_CREDENTIAL_KEYS;
  });
  const created = await issue(uncertain.context, organizationId, id, [
    "projects:read",
  ]);
  expect(created.status).toBe(201);
  expect(uncertain.lost()).toBe(true);
  const original = (await created.json()) as IssuedToken;
  const replay = await issue(context, organizationId, id, ["projects:read"]);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(original);
  const before = await env.DB.prepare(
    "SELECT * FROM api_tokens WHERE organization_id=? ORDER BY id",
  )
    .bind(organizationId)
    .all();
  expect(before.success).toBe(true);
  const unavailable = await issue(
    { ...context, ROLE_CREDENTIAL_KEYS: ring("fixture-v2", false) },
    organizationId,
    id,
    ["projects:read"],
  );
  expect(unavailable.status).toBe(409);
  expect(await unavailable.json()).toEqual({
    error: { code: "token_replay_unavailable" },
  });
  const upgrade = await issue(context, organizationId, id, [
    "projects:read",
    "projects:write",
  ]);
  expect(upgrade.status).toBe(409);
  const invalid = await issue(context, organizationId, crypto.randomUUID(), [
    "budgets:write",
  ]);
  expect(invalid.status).toBe(400);
  const missing = await call(
    context,
    `/v1/organizations/${organizationId}/tokens/${crypto.randomUUID()}`,
    { headers: installerHeaders },
  );
  expect(missing.status).toBe(404);
  const after = await env.DB.prepare(
    "SELECT * FROM api_tokens WHERE organization_id=? ORDER BY id",
  )
    .bind(organizationId)
    .all();
  expect(after.success).toBe(true);
  expect(after.results).toEqual(before.results);
});
