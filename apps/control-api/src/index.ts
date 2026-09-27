type Env = Cloudflare.Env;

type Scope = "projects:read" | "projects:write" | "operations:read";

interface TokenRow {
  organization_id: string;
  scopes: string;
}

interface OrganizationRow {
  id: string;
  name: string;
  created_at: string;
}

interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  status: string;
  created_at: string;
}

interface OperationRow {
  id: string;
  organization_id: string;
  project_id: string;
  kind: string;
  status: string;
  created_at: string;
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

function newApiToken(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...random))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `cporg_${base64}`;
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

async function listOrganizations(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await authorizedInstallation(request, env);
  if (auth) return auth;
  const result = await env.DB.prepare(
    "SELECT id, name, created_at FROM organizations ORDER BY created_at DESC, id DESC LIMIT 1000",
  ).all<OrganizationRow>();
  return json(
    {
      organizations: result.results.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
      })),
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

async function authorizedOrganization(
  request: Request,
  env: Env,
  organizationId: string,
  requiredScope: Scope,
): Promise<Response | null> {
  const bearer = bearerToken(request);
  if (!bearer) return error(401, "unauthorized");
  const token = await env.DB.prepare(
    "SELECT organization_id, scopes FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL",
  )
    .bind(await sha256(bearer))
    .first<TokenRow>();
  if (!token) return error(401, "unauthorized");
  if (token.organization_id !== organizationId) return error(404, "not_found");
  if (!token.scopes.split(" ").includes(requiredScope))
    return error(403, "forbidden");
  return null;
}

function projectFromRow(row: ProjectRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
  };
}

function operationFromRow(row: OperationRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function projectAndOperation(
  db: D1Database,
  organizationId: string,
  projectId: string,
  operationId: string,
): Promise<Response> {
  const [project, operation] = await Promise.all([
    db
      .prepare("SELECT * FROM projects WHERE id = ? AND organization_id = ?")
      .bind(projectId, organizationId)
      .first<ProjectRow>(),
    db
      .prepare("SELECT * FROM operations WHERE id = ? AND organization_id = ?")
      .bind(operationId, organizationId)
      .first<OperationRow>(),
  ]);
  if (!project || !operation) return error(500, "state_inconsistent");
  return json(
    {
      project: projectFromRow(project),
      operation: operationFromRow(operation),
    },
    202,
  );
}

async function existingRequest(
  db: D1Database,
  organizationId: string,
  key: string,
): Promise<IdempotencyRow | null> {
  return db
    .prepare(
      "SELECT request_hash, project_id, operation_id FROM idempotency_requests WHERE organization_id = ? AND idempotency_key = ?",
    )
    .bind(organizationId, key)
    .first<IdempotencyRow>();
}

async function createProject(
  request: Request,
  env: Env,
  organizationId: string,
): Promise<Response> {
  const auth = await authorizedOrganization(
    request,
    env,
    organizationId,
    "projects:write",
  );
  if (auth) return auth;
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9._~-]{1,128}$/.test(key)) {
    return error(400, "invalid_idempotency_key");
  }
  const name = await nameFromJson(request);
  if (name === null) return error(400, "invalid_request");
  const requestHash = await sha256(
    `POST /v1/organizations/${organizationId}/projects\n${JSON.stringify({ name })}`,
  );
  const existing = await existingRequest(env.DB, organizationId, key);
  if (existing) {
    if (existing.request_hash !== requestHash)
      return error(409, "idempotency_conflict");
    return projectAndOperation(
      env.DB,
      organizationId,
      existing.project_id,
      existing.operation_id,
    );
  }

  const projectId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO projects (id, organization_id, name, status, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(projectId, organizationId, name, "pending", createdAt),
      env.DB.prepare(
        "INSERT INTO operations (id, organization_id, project_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(
        operationId,
        organizationId,
        projectId,
        "project.create",
        "queued",
        createdAt,
      ),
      env.DB.prepare(
        "INSERT INTO idempotency_requests (organization_id, idempotency_key, request_hash, project_id, operation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(
        organizationId,
        key,
        requestHash,
        projectId,
        operationId,
        createdAt,
      ),
    ]);
  } catch {
    const winner = await existingRequest(env.DB, organizationId, key);
    if (!winner) return error(500, "write_failed");
    if (winner.request_hash !== requestHash)
      return error(409, "idempotency_conflict");
    return projectAndOperation(
      env.DB,
      organizationId,
      winner.project_id,
      winner.operation_id,
    );
  }

  return json(
    {
      project: projectFromRow({
        id: projectId,
        organization_id: organizationId,
        name,
        status: "pending",
        created_at: createdAt,
      }),
      operation: operationFromRow({
        id: operationId,
        organization_id: organizationId,
        project_id: projectId,
        kind: "project.create",
        status: "queued",
        created_at: createdAt,
      }),
    },
    202,
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

async function getOperation(
  request: Request,
  env: Env,
  organizationId: string,
  id: string,
) {
  const auth = await authorizedOrganization(
    request,
    env,
    organizationId,
    "operations:read",
  );
  if (auth) return auth;
  const row = await env.DB.prepare(
    "SELECT * FROM operations WHERE id = ? AND organization_id = ?",
  )
    .bind(id, organizationId)
    .first<OperationRow>();
  if (!row) return error(404, "not_found");
  return json({ operation: operationFromRow(row) }, 200);
}

export default {
  async fetch(request, env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
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
    const operationItem =
      /^\/v1\/organizations\/([^/]+)\/operations\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && operationItem) {
      return getOperation(request, env, operationItem[1]!, operationItem[2]!);
    }
    return error(404, "not_found");
  },
} satisfies ExportedHandler<Env>;
