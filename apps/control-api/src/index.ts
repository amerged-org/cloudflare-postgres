import { environmentRoutes } from "./environments";
import { issueRuntimePermit } from "./runtime-permit";
import { usageArchiveRoutes } from "./usage-archives";
import { assertion } from "./accounting";
import { actorBindings, actorPredicate, type Actor } from "./execution-auth";
import { usageRoutes } from "./usage";
import { budgetRoutes, planBudgetCorrection } from "./budgets";
import { maintenanceRoutes } from "./maintenance";
import { roleRoutes } from "./roles";
import { databaseRoutes } from "./databases";
import { backupRoutes } from "./backups";
import { resizeRoutes } from "./resize";
import { suspendRoutes } from "./suspend";
import { deletionRoutes } from "./environment-deletion";
import { providerInventoryRoute } from "./provider-inventory";
import { organizationTokenRoutes } from "./organization-tokens";
import {
  executionReads,
  projectFromRow,
  operationFromRow,
  type ProjectRow,
  type LegacyOperationRow as OperationRow,
} from "./execution-reads";

type Env = Cloudflare.Env;

type Scope = "projects:read" | "projects:write" | "operations:read";

interface TokenRow {
  id: string;
  organization_id: string;
  scopes: string;
}

interface OrganizationRow {
  id: string;
  name: string;
  created_at: string;
}

interface RegionRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

interface CreatedIdCursor {
  createdAt: string;
  id: string;
}

interface IdempotencyRow {
  request_hash: string;
  project_id: string;
  operation_id: string;
}

const tokenScopes: readonly Scope[] = [
  "projects:read",
  "projects:write",
  "operations:read",
];

const regionTokenScopes = ["operations:claim", "operations:report"] as const;

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function error(status: number, code: string): Response {
  return json({ error: { code } }, status);
}

function bearerToken(request: Request): string | null {
  return (
    /^Bearer ([^\s]+)$/i.exec(
      request.headers.get("authorization") ?? "",
    )?.[1] ?? null
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function matchesSecret(
  actual: string,
  expected: string,
): Promise<boolean> {
  const [actualHash, expectedHash] = await Promise.all([
    sha256(actual),
    sha256(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < actualHash.length; index += 1) {
    difference |= actualHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return difference === 0;
}

function newApiToken(prefix: "cporg" | "cprgn" = "cporg"): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...random))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${prefix}_${base64}`;
}

async function readBoundedText(
  request: Request,
  maximumBytes: number,
): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: false,
  });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function nameFromJson(request: Request): Promise<string | null> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) {
    return null;
  }
  if (Number(request.headers.get("content-length")) > 4096) {
    return null;
  }
  let parsed: unknown;
  try {
    const body = await readBoundedText(request, 4096);
    if (body === null) return null;
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "name") return null;
  const { name } = parsed as { name?: unknown };
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 120 ||
    name.trim() !== name ||
    Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return null;
  }
  return name;
}

async function authorizedInstallation(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (!env.INSTALLATION_BOOTSTRAP_TOKEN)
    return error(503, "bootstrap_unconfigured");
  const bearer = bearerToken(request);
  if (
    !bearer ||
    !(await matchesSecret(bearer, env.INSTALLATION_BOOTSTRAP_TOKEN))
  ) {
    return error(401, "unauthorized");
  }
  return null;
}

async function bootstrapOrganization(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await authorizedInstallation(request, env);
  if (auth) return auth;
  const name = await nameFromJson(request);
  if (name === null) return error(400, "invalid_request");

  const id = crypto.randomUUID();
  const token = newApiToken();
  const createdAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)",
    ).bind(id, name, createdAt),
    env.DB.prepare(
      "INSERT INTO api_tokens (id, organization_id, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      id,
      await sha256(token),
      tokenScopes.join(" "),
      createdAt,
    ),
  ]);
  return json(
    {
      organization: { id, name, createdAt },
      apiToken: token,
      scopes: tokenScopes,
    },
    201,
  );
}

function encodeCreatedIdCursor(row: {
  created_at: string;
  id: string;
}): string {
  return btoa(JSON.stringify({ createdAt: row.created_at, id: row.id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCreatedIdCursor(value: string): CreatedIdCursor | null {
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    const keys = Object.keys(parsed);
    if (
      keys.length !== 2 ||
      !keys.includes("createdAt") ||
      !keys.includes("id")
    )
      return null;
    const { createdAt, id } = parsed as Record<string, unknown>;
    if (
      typeof createdAt !== "string" ||
      typeof id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ||
      new Date(createdAt).toISOString() !== createdAt
    ) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

async function listOrganizations(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await authorizedInstallation(request, env);
  if (auth) return auth;
  const query = new URL(request.url).searchParams;
  if (
    Array.from(query.keys()).some(
      (key) => key !== "limit" && key !== "cursor",
    ) ||
    query.getAll("limit").length > 1 ||
    query.getAll("cursor").length > 1
  ) {
    return error(400, "invalid_request");
  }
  const limitText = query.get("limit");
  if (limitText !== null && !/^[1-9][0-9]{0,3}$/.test(limitText))
    return error(400, "invalid_request");
  const limit = limitText === null ? 1000 : Number(limitText);
  if (limit > 1000) return error(400, "invalid_request");
  const cursorText = query.get("cursor");
  const cursor = cursorText === null ? null : decodeCreatedIdCursor(cursorText);
  if (cursorText !== null && cursor === null)
    return error(400, "invalid_request");

  const statement = cursor
    ? env.DB.prepare(
        "SELECT id, name, created_at FROM organizations WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?",
      ).bind(cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
    : env.DB.prepare(
        "SELECT id, name, created_at FROM organizations ORDER BY created_at DESC, id DESC LIMIT ?",
      ).bind(limit + 1);
  const result = await statement.all<OrganizationRow>();
  const page = result.results.slice(0, limit);
  return json(
    {
      organizations: page.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
      })),
      nextCursor:
        result.results.length > limit
          ? encodeCreatedIdCursor(page[page.length - 1]!)
          : null,
    },
    200,
  );
}

async function reissueOrganizationToken(
  request: Request,
  env: Env,
  organizationId: string,
): Promise<Response> {
  const auth = await authorizedInstallation(request, env);
  if (auth) return auth;
  const organization = await env.DB.prepare(
    "SELECT id, name, created_at FROM organizations WHERE id = ?",
  )
    .bind(organizationId)
    .first<OrganizationRow>();
  if (!organization) return error(404, "not_found");

  const token = newApiToken();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE api_tokens SET revoked_at = ? WHERE organization_id = ? AND revoked_at IS NULL",
    ).bind(now, organizationId),
    env.DB.prepare(
      "INSERT INTO api_tokens (id, organization_id, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      organizationId,
      await sha256(token),
      tokenScopes.join(" "),
      now,
    ),
  ]);
  return json(
    {
      organization: {
        id: organization.id,
        name: organization.name,
        createdAt: organization.created_at,
      },
      apiToken: token,
      scopes: tokenScopes,
    },
    201,
  );
}

function regionFromRow(row: RegionRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function registerRegion(request: Request, env: Env): Promise<Response> {
  const auth = await authorizedInstallation(request, env);
  if (auth) return auth;
  const name = await nameFromJson(request);
  if (name === null) return error(400, "invalid_request");

  const id = crypto.randomUUID();
  const token = newApiToken("cprgn");
  const createdAt = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO regions (id, name, status, created_at) VALUES (?, ?, ?, ?)",
      ).bind(id, name, "registered", createdAt),
      env.DB.prepare(
        "INSERT INTO region_tokens (id, region_id, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        crypto.randomUUID(),
        id,
        await sha256(token),
        regionTokenScopes.join(" "),
        createdAt,
      ),
    ]);
  } catch {
    const existing = await env.DB.prepare(
      "SELECT id FROM regions WHERE name = ?",
    )
      .bind(name)
      .first<{ id: string }>();
    if (existing) return error(409, "region_name_conflict");
    return error(500, "write_failed");
  }
  return json(
    {
      region: regionFromRow({
        id,
        name,
        status: "registered",
        created_at: createdAt,
      }),
      apiToken: token,
      scopes: regionTokenScopes,
    },
    201,
  );
}

async function listRegions(request: Request, env: Env): Promise<Response> {
  const auth = await authorizedInstallation(request, env);
  if (auth) return auth;
  const query = new URL(request.url).searchParams;
  if (
    Array.from(query.keys()).some(
      (key) => key !== "limit" && key !== "cursor",
    ) ||
    query.getAll("limit").length > 1 ||
    query.getAll("cursor").length > 1
  ) {
    return error(400, "invalid_request");
  }
  const limitText = query.get("limit");
  if (limitText !== null && !/^[1-9][0-9]{0,3}$/.test(limitText))
    return error(400, "invalid_request");
  const limit = limitText === null ? 1000 : Number(limitText);
  if (limit > 1000) return error(400, "invalid_request");
  const cursorText = query.get("cursor");
  const cursor = cursorText === null ? null : decodeCreatedIdCursor(cursorText);
  if (cursorText !== null && cursor === null)
    return error(400, "invalid_request");

  const statement = cursor
    ? env.DB.prepare(
        "SELECT id, name, status, created_at FROM regions WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?",
      ).bind(cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
    : env.DB.prepare(
        "SELECT id, name, status, created_at FROM regions ORDER BY created_at DESC, id DESC LIMIT ?",
      ).bind(limit + 1);
  const result = await statement.all<RegionRow>();
  const page = result.results.slice(0, limit);
  return json(
    {
      regions: page.map(regionFromRow),
      nextCursor:
        result.results.length > limit
          ? encodeCreatedIdCursor(page[page.length - 1]!)
          : null,
    },
    200,
  );
}

async function getRegion(
  request: Request,
  env: Env,
  regionId: string,
): Promise<Response> {
  const auth = await authorizedInstallation(request, env);
  if (auth) return auth;
  const region = await env.DB.prepare(
    "SELECT id, name, status, created_at FROM regions WHERE id = ?",
  )
    .bind(regionId)
    .first<RegionRow>();
  if (!region) return error(404, "not_found");
  return json({ region: regionFromRow(region) }, 200);
}

async function reissueRegionToken(
  request: Request,
  env: Env,
  regionId: string,
): Promise<Response> {
  const auth = await authorizedInstallation(request, env);
  if (auth) return auth;
  const region = await env.DB.prepare(
    "SELECT id, name, status, created_at FROM regions WHERE id = ?",
  )
    .bind(regionId)
    .first<RegionRow>();
  if (!region) return error(404, "not_found");

  const token = newApiToken("cprgn");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE region_tokens SET revoked_at = ? WHERE region_id = ? AND revoked_at IS NULL",
    ).bind(now, regionId),
    env.DB.prepare(
      "INSERT INTO region_tokens (id, region_id, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      regionId,
      await sha256(token),
      regionTokenScopes.join(" "),
      now,
    ),
  ]);
  return json(
    {
      region: regionFromRow(region),
      apiToken: token,
      scopes: regionTokenScopes,
    },
    201,
  );
}

async function authorizedOrganization(
  request: Request,
  env: Env,
  organizationId: string,
  requiredScope: Scope,
): Promise<Response | null> {
  const actor = await organizationActor(
    request,
    env.DB,
    organizationId,
    requiredScope,
  );
  return actor instanceof Response ? actor : null;
}

async function organizationActor(
  request: Request,
  db: D1Database | D1DatabaseSession,
  organizationId: string,
  requiredScope: Scope,
): Promise<Actor | Response> {
  const bearer = bearerToken(request);
  if (!bearer) return error(401, "unauthorized");
  const hash = await sha256(bearer);
  const token = await db
    .prepare(
      "SELECT id, organization_id, scopes FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .bind(hash)
    .first<TokenRow>();
  if (!token) return error(401, "unauthorized");
  if (token.organization_id !== organizationId) return error(404, "not_found");
  if (!token.scopes.split(" ").includes(requiredScope))
    return error(403, "forbidden");
  return {
    kind: "organization",
    id: token.id,
    ownerId: organizationId,
    hash,
    scope: requiredScope,
  };
}

async function projectAndOperation(
  db: D1Database,
  organizationId: string,
  projectId: string,
  operationId: string,
  actor: Actor,
  currentAuthority: () => Promise<Response | null>,
): Promise<Response> {
  const [project, operation] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM projects WHERE id = ? AND organization_id = ? AND ${actorPredicate(actor)}`,
      )
      .bind(projectId, organizationId, ...actorBindings(actor))
      .first<ProjectRow>(),
    db
      .prepare(
        `SELECT * FROM operations WHERE id = ? AND organization_id = ? AND ${actorPredicate(actor)}`,
      )
      .bind(operationId, organizationId, ...actorBindings(actor))
      .first<OperationRow>(),
  ]);
  const denied = await currentAuthority();
  if (denied) return denied;
  if (!project || !operation) return error(500, "state_inconsistent");
  const status =
    project.status === "active" && operation.status === "succeeded"
      ? 201
      : project.status === "pending" && operation.status === "queued"
        ? 202
        : null;
  if (status === null) return error(500, "state_inconsistent");
  return json(
    {
      project: projectFromRow(project),
      operation: operationFromRow(operation),
    },
    status,
  );
}

async function existingRequest(
  db: D1Database,
  organizationId: string,
  key: string,
  actor: Actor,
): Promise<IdempotencyRow | null> {
  return db
    .prepare(
      `SELECT request_hash, project_id, operation_id FROM idempotency_requests WHERE organization_id = ? AND idempotency_key = ? AND ${actorPredicate(actor)}`,
    )
    .bind(organizationId, key, ...actorBindings(actor))
    .first<IdempotencyRow>();
}

async function createProject(
  request: Request,
  env: Env,
  organizationId: string,
): Promise<Response> {
  // Non-session D1 reads hit primary, including after sibling revocation or a
  // concurrent committed winner. Reusing a session bookmark can miss those.
  const db = env.DB;
  const actor = await organizationActor(
    request,
    db,
    organizationId,
    "projects:write",
  );
  if (actor instanceof Response) return actor;
  const currentAuthority = async (): Promise<Response | null> => {
    const current = await organizationActor(
      request,
      db,
      organizationId,
      "projects:write",
    );
    if (current instanceof Response) return current;
    // A replacement row cannot inherit this request's captured actor identity.
    return current.id === actor.id &&
      current.hash === actor.hash &&
      current.ownerId === actor.ownerId
      ? null
      : error(401, "unauthorized");
  };
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9._~-]{1,128}$/.test(key)) {
    return error(400, "invalid_idempotency_key");
  }
  const name = await nameFromJson(request);
  if (name === null) return error(400, "invalid_request");
  const requestHash = await sha256(
    `POST /v1/organizations/${organizationId}/projects\n${JSON.stringify({ name })}`,
  );
  const existing = await existingRequest(db, organizationId, key, actor);
  const denied = await currentAuthority();
  if (denied) return denied;
  if (existing) {
    if (existing.request_hash !== requestHash)
      return error(409, "idempotency_conflict");
    return projectAndOperation(
      db,
      organizationId,
      existing.project_id,
      existing.operation_id,
      actor,
      currentAuthority,
    );
  }

  const projectId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const guardId = crypto.randomUUID();
  try {
    await db.batch([
      assertion(db, actorPredicate(actor), actorBindings(actor), guardId),
      db
        .prepare(
          "INSERT INTO projects (id, organization_id, name, status, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(projectId, organizationId, name, "active", createdAt),
      db
        .prepare(
          "INSERT INTO operations (id, organization_id, project_id, kind, status, created_at, observed_at, result_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          operationId,
          organizationId,
          projectId,
          "project.create",
          "succeeded",
          createdAt,
          createdAt,
          "logical_container_created",
        ),
      db
        .prepare(
          "INSERT INTO idempotency_requests (organization_id, idempotency_key, request_hash, project_id, operation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          organizationId,
          key,
          requestHash,
          projectId,
          operationId,
          createdAt,
        ),
      db.prepare("DELETE FROM accounting_assertions WHERE id=?").bind(guardId),
    ]);
  } catch {
    const revoked = await currentAuthority();
    if (revoked) return revoked;
    const winner = await existingRequest(db, organizationId, key, actor);
    const expired = await currentAuthority();
    if (expired) return expired;
    if (!winner) return error(500, "write_failed");
    if (winner.request_hash !== requestHash)
      return error(409, "idempotency_conflict");
    return projectAndOperation(
      db,
      organizationId,
      winner.project_id,
      winner.operation_id,
      actor,
      currentAuthority,
    );
  }

  const revokedAfterCommit = await currentAuthority();
  if (revokedAfterCommit) return revokedAfterCommit;

  return json(
    {
      project: projectFromRow({
        id: projectId,
        organization_id: organizationId,
        name,
        status: "active",
        created_at: createdAt,
      }),
      operation: operationFromRow({
        id: operationId,
        organization_id: organizationId,
        project_id: projectId,
        kind: "project.create",
        status: "succeeded",
        created_at: createdAt,
        observed_at: createdAt,
        result_code: "logical_container_created",
      }),
    },
    201,
  );
}

async function getProject(
  request: Request,
  env: Env,
  organizationId: string,
  id: string,
) {
  const auth = await authorizedOrganization(
    request,
    env,
    organizationId,
    "projects:read",
  );
  if (auth) return auth;
  const row = await env.DB.prepare(
    "SELECT * FROM projects WHERE id = ? AND organization_id = ?",
  )
    .bind(id, organizationId)
    .first<ProjectRow>();
  if (!row) return error(404, "not_found");
  return json({ project: projectFromRow(row) }, 200);
}

export default {
  async fetch(request, env): Promise<Response> {
    const archiveResponse = await usageArchiveRoutes(request, env);
    if (archiveResponse) return archiveResponse;
    const tokenResponse = await organizationTokenRoutes(request, env);
    if (tokenResponse) return tokenResponse;
    const providerResponse = await providerInventoryRoute(request, env);
    if (providerResponse) return providerResponse;
    const deletionResponse = await deletionRoutes(request, env);
    if (deletionResponse) return deletionResponse;
    const suspendResponse = await suspendRoutes(request, env);
    if (suspendResponse) return suspendResponse;
    const recoveryResponse = await executionReads(request, env);
    if (recoveryResponse) return recoveryResponse;
    const backupResponse = await backupRoutes(request, env);
    if (backupResponse) return backupResponse;
    const resizeResponse = await resizeRoutes(request, env);
    if (resizeResponse) return resizeResponse;
    const databaseResponse = await databaseRoutes(request, env);
    if (databaseResponse) return databaseResponse;
    const roleResponse = await roleRoutes(request, env);
    if (roleResponse) return roleResponse;
    const maintenanceResponse = await maintenanceRoutes(request, env);
    if (maintenanceResponse) return maintenanceResponse;
    try {
      const runtimePermitPath =
        /^\/v1\/regions\/([^/]+)\/operations\/([^/]+)\/execution-permits$/.exec(
          new URL(request.url).pathname,
        );
      if (request.method === "POST" && runtimePermitPath)
        return await issueRuntimePermit(
          request,
          env,
          env.DB,
          runtimePermitPath[1]!,
          runtimePermitPath[2]!,
        );
      const budgetResponse = await budgetRoutes(request, env);
      if (budgetResponse) return budgetResponse;
      const usageResponse = await usageRoutes(
        request,
        env,
        planBudgetCorrection,
      );
      if (usageResponse) return usageResponse;
    } catch {
      // Provider/crypto errors can carry private evidence. Keep them out of
      // customer responses and logs; durable facts remain available for retry.
      return error(500, "accounting_unavailable");
    }
    const environmentResponse = await environmentRoutes(request, env);
    if (environmentResponse) return environmentResponse;
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === "/v1/regions") {
      return registerRegion(request, env);
    }
    if (request.method === "GET" && pathname === "/v1/regions") {
      return listRegions(request, env);
    }
    const regionReissue = /^\/v1\/regions\/([^/]+)\/tokens\/reissue$/.exec(
      pathname,
    );
    if (request.method === "POST" && regionReissue) {
      return reissueRegionToken(request, env, regionReissue[1]!);
    }
    const regionItem = /^\/v1\/regions\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && regionItem) {
      return getRegion(request, env, regionItem[1]!);
    }
    if (request.method === "POST" && pathname === "/v1/organizations") {
      return bootstrapOrganization(request, env);
    }
    if (request.method === "GET" && pathname === "/v1/organizations") {
      return listOrganizations(request, env);
    }
    const tokenReissue = /^\/v1\/organizations\/([^/]+)\/tokens\/reissue$/.exec(
      pathname,
    );
    if (request.method === "POST" && tokenReissue) {
      return reissueOrganizationToken(request, env, tokenReissue[1]!);
    }
    const projectCollection = /^\/v1\/organizations\/([^/]+)\/projects$/.exec(
      pathname,
    );
    if (request.method === "POST" && projectCollection) {
      return createProject(request, env, projectCollection[1]!);
    }
    const projectItem =
      /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && projectItem) {
      return getProject(request, env, projectItem[1]!, projectItem[2]!);
    }
    return error(404, "not_found");
  },
} satisfies ExportedHandler<Env>;
