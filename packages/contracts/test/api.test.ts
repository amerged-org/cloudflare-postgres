// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApiKeyCreate,
  AuditEvent,
  DatabaseCreate,
  DatabaseIdleTime,
  DatabasePatch,
  DatabaseResize,
  OperationKind,
  ERROR_CODES,
  ERROR_REASONS,
  ErrorBody,
  RETRYABLE_ERROR_REASONS,
  TERMINAL_ERROR_REASONS,
  retryAfterSeconds,
  IDEMPOTENCY_KEY_PATTERN,
  ListQuery,
  Node,
  Region,
  RegionRouteKeyring,
  newSecret,
  bytesToBase64url,
  decodeCursor,
  encodeCursor,
  errorBody,
  errorStatus,
  newDatabaseId,
  newProjectId,
  newNodeId,
  Role,
  RoleCreate,
  roleExpiryInstant,
  SizeClassUpsert,
} from "../src/index.ts";
import { FleetReleaseId } from "../src/releases.ts";

const encode = (text: string) =>
  bytesToBase64url(new TextEncoder().encode(text));

it("assigns database RAM in 256 MiB increments", () => {
  const body = {
    memory_mib: 256,
    cpu_millicores: 100,
    storage_gib: 5,
    max_connections: 50,
    sleep_after_seconds: 60,
    archive_timeout_seconds: 60,
    backup_retention_days: 7,
    enabled: true,
  };
  expect(SizeClassUpsert.parse(body).memory_mib).toBe(256);
  expect(SizeClassUpsert.parse({ ...body, memory_mib: 4096 }).memory_mib).toBe(
    4096,
  );
  expect(SizeClassUpsert.safeParse({ ...body, memory_mib: 300 }).success).toBe(
    false,
  );
});

it("has no PostgreSQL scheduling share beside the hard CPU limit", () => {
  const body = {
    memory_mib: 256,
    cpu_millicores: 250,
    storage_gib: 1,
    max_connections: 50,
    sleep_after_seconds: 60,
    archive_timeout_seconds: 60,
    backup_retention_days: 7,
    enabled: true,
  };
  expect(SizeClassUpsert.parse(body)).toEqual(body);
  expect(
    SizeClassUpsert.safeParse({ ...body, cpu_request_millicores: 25 }).success,
  ).toBe(false);
});

it("refuses the reserved role names in customer creation and takes every other name", () => {
  for (const name of [
    "postgres",
    "pg_monitor",
    "pgcf_backup",
    "public",
    "none",
  ])
    expect(RoleCreate.safeParse({ name }).success, name).toBe(false);
  // The names of the Kubernetes runtime are ordinary customer roles now.
  for (const name of [
    "pgcf_customer",
    "pgcf_maintenance",
    "streaming_replica",
    "cnpg_app",
  ])
    expect(RoleCreate.parse({ name }).name).toBe(name);
  expect(
    RoleCreate.parse({
      name: "report_job",
      member_of: ["cnpg_app", "streaming_replica", "pgcf_maintenance"],
    }).member_of,
  ).toEqual(["cnpg_app", "streaming_replica", "pgcf_maintenance"]);
});

describe("role lifecycle attributes", () => {
  const until = "2031-01-02T03:04:05.678Z";
  it("accepts expiry, a connection limit, memberships and row-level-security bypass on creation", () => {
    expect(
      RoleCreate.parse({
        name: "report_job",
        valid_until: until,
        connection_limit: 5,
        member_of: ["reader", "writer"],
        bypass_rls: true,
      }),
    ).toEqual({
      name: "report_job",
      valid_until: until,
      connection_limit: 5,
      member_of: ["reader", "writer"],
      bypass_rls: true,
    });
    // Every attribute is optional; a plain request keeps its wire shape.
    expect(RoleCreate.parse({ name: "plain" })).toEqual({ name: "plain" });
  });
  it("bounds each attribute and refuses unknown or reserved targets", () => {
    const base = { name: "report_job" };
    const refused: Record<string, unknown>[] = [
      { valid_until: "2031-01-02" },
      { valid_until: "2031-01-02T03:04:05Z" },
      { valid_until: null },
      { connection_limit: 0 },
      { connection_limit: 10001 },
      { connection_limit: 1.5 },
      { connection_limit: null },
      { member_of: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
      { member_of: ["reader", "reader"] },
      { member_of: ["app"] },
      { member_of: ["pg_read_all_data"] },
      { member_of: ["pg_execute_server_program"] },
      { member_of: ["postgres"] },
      { member_of: ["pgcf_backup"] },
      { member_of: ["public"] },
      { member_of: ["none"] },
      { member_of: ["report_job"] },
      { member_of: "reader" },
      { bypass_rls: "yes" },
      { superuser: true },
      { password: "chosen" },
    ];
    for (const extra of refused)
      expect(
        RoleCreate.safeParse({ ...base, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    expect(
      RoleCreate.safeParse({ ...base, connection_limit: 10000, member_of: [] })
        .success,
    ).toBe(true);
  });
  it("returns every attribute on a role", () => {
    const row = {
      database_id: newDatabaseId(),
      name: "report_job",
      owner: false,
      password_revision: 1,
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:00:00.000Z",
    };
    // A response omitting an attribute is not a role of this contract.
    expect(Role.safeParse(row).success).toBe(false);
    const full = {
      ...row,
      valid_until: until,
      connection_limit: 5,
      member_of: ["reader"],
      bypass_rls: false,
    };
    expect(Role.parse(full)).toEqual(full);
    const open = {
      ...row,
      valid_until: null,
      connection_limit: null,
      member_of: [],
      bypass_rls: false,
    };
    expect(Role.parse(open)).toEqual(open);
    expect(Role.safeParse({ ...full, member_of: ["Reader"] }).success).toBe(
      false,
    );
    expect(Role.safeParse({ ...full, connection_limit: 0 }).success).toBe(
      false,
    );
  });
  it("names the role removal as an operation kind", () => {
    expect(OperationKind.parse("database.role.delete")).toBe(
      "database.role.delete",
    );
  });
  it("takes the instant an expiry is applied at from its whole second", () => {
    // PostgreSQL gets the expiry through a Kubernetes time, which holds whole seconds: the
    // fraction is cut, so the credential is refused from the start of the second it falls in.
    const second = Date.parse("2031-01-02T03:04:05.000Z");
    for (const fraction of ["000", "001", "678", "999"])
      expect(roleExpiryInstant(`2031-01-02T03:04:05.${fraction}Z`)).toBe(
        second,
      );
    expect(roleExpiryInstant("2031-01-02T03:04:06.000Z")).toBe(second + 1000);
  });
});

describe("node CPU measurement compatibility", () => {
  it("keeps legacy views valid without inventing measured platform CPU", () => {
    const now = new Date().toISOString();
    const node = {
      id: newNodeId(),
      region_id: "eu-test",
      hostname: "test-node",
      provider_instance_id: null,
      provider_product: null,
      monthly_price: null,
      currency: null,
      ready: true,
      schedulable: true,
      allocatable_memory_mib: 4096,
      allocatable_cpu_millicores: 2000,
      storage_gib_total: 30,
      platform_reserved_memory_mib: 128,
      last_observed_at: null,
      created_at: now,
      updated_at: now,
    };
    expect(Node.parse(node).node_uid).toBeUndefined();
    for (const window of [
      { memory_window_valid: false },
      { memory_window_observed_at: null },
      { memory_utilization_ppm: null },
      { memory_expansion_triggered_at: null },
    ])
      expect(Node.safeParse({ ...node, ...window }).success).toBe(false);
    const uid = randomUUID();
    expect(Node.parse({ ...node, node_uid: uid }).node_uid).toBe(uid);
    expect(Node.parse({ ...node, node_uid: null }).node_uid).toBeNull();
    expect(Node.safeParse({ ...node, node_uid: "invalid" }).success).toBe(
      false,
    );
    expect(Node.parse(node).platform_reserved_cpu_millicores).toBeUndefined();
    expect(
      Node.parse({ ...node, platform_reserved_cpu_millicores: null })
        .platform_reserved_cpu_millicores,
    ).toBeNull();
    expect(
      Node.parse({ ...node, platform_reserved_cpu_millicores: 0 })
        .platform_reserved_cpu_millicores,
    ).toBe(0);
  });
});

describe("cursor", () => {
  it("supports an authoritative release-ID validator without widening the default cursor grammar", () => {
    const cursor = {
      created_at: "2026-10-02T10:46:00.123Z",
      id: `9r2.6-${"a".repeat(90)}`,
    };
    const releaseId = (id: string) => FleetReleaseId.safeParse(id).success;
    expect(() => encodeCursor(cursor)).toThrow();
    const encoded = encodeCursor(cursor, releaseId);
    expect(encoded.length).toBeLessThanOrEqual(256);
    expect(decodeCursor(encoded, releaseId)).toEqual(cursor);
    expect(decodeCursor(encoded)).toBeNull();
    expect(
      decodeCursor(encode(`${cursor.created_at}|invalid/release`), releaseId),
    ).toBeNull();
    expect(
      decodeCursor(encode(`${cursor.created_at}|r2.6|extra`), releaseId),
    ).toBeNull();
    expect(
      decodeCursor(encode(`2026-02-30T10:46:00.123Z|r2.6`), releaseId),
    ).toBeNull();
    expect(() =>
      encodeCursor({ ...cursor, id: cursor.id + "a" }, releaseId),
    ).toThrow();
  });

  it("round-trips created_at and id", () => {
    const cursor = {
      created_at: "2026-10-02T10:46:00.123Z",
      id: newProjectId(),
    };
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(cursor);
    const database = { created_at: cursor.created_at, id: newDatabaseId() };
    expect(decodeCursor(encodeCursor(database))).toEqual(database);
  });

  it("rejects malformed cursors", () => {
    const id = newProjectId();
    for (const value of [
      "",
      "not base64!",
      encode(`2026-10-02T10:46:00.123Z`),
      encode(`2026-10-02T10:46:00.123Z|${id}|x`),
      encode(`2026-10-02T10:46:00Z|${id}`),
      encode(`2026-02-30T10:46:00.123Z|${id}`),
      encode(`2026-10-02T10:46:00.123Z|' OR 1=1 --`),
      encode(`2026-10-02T10:46:00.123Z|`),
      encode(`2026-10-02T10:46:00.123Z|${id}`) + "=",
      "A".repeat(300),
    ]) {
      expect(decodeCursor(value)).toBeNull();
    }
    expect(() => encodeCursor({ created_at: "yesterday", id })).toThrow();
  });
});

describe("errors", () => {
  it("builds a valid envelope for every code", () => {
    for (const code of ERROR_CODES) {
      const body = errorBody(code, "message", "req-1");
      expect(ErrorBody.parse(body)).toEqual(body);
      expect(errorStatus(code)).toBeGreaterThanOrEqual(400);
    }
    expect(errorStatus("capacity_exhausted")).toBe(503);
    expect(errorStatus("idempotency_conflict")).toBe(409);
    expect(
      errorBody("conflict", "x", "r", { field: "name" }).error.details,
    ).toEqual({ field: "name" });
    expect(
      ErrorBody.safeParse({
        error: { code: "teapot", message: "", request_id: "r" },
      }).success,
    ).toBe(false);
  });

  it("takes the stable reason of the details from the closed set", () => {
    for (const reason of ERROR_REASONS)
      expect(
        ErrorBody.parse(errorBody("conflict", "x", "r", { reason })).error
          .details,
      ).toEqual({ reason });
    const parse = (details: unknown) =>
      ErrorBody.safeParse({
        error: { code: "conflict", message: "x", request_id: "r", details },
      }).success;
    expect(parse({ reason: "because" })).toBe(false);
    // Route-specific context travels beside it.
    expect(parse({ reason: "name_in_use", run_id: "op_1" })).toBe(true);
    expect(parse({ run_id: "op_1" })).toBe(true);
  });

  it("classifies every reason exactly once and advises a delay only for the retryable ones", () => {
    const retryable = Object.keys(RETRYABLE_ERROR_REASONS);
    expect(new Set([...retryable, ...TERMINAL_ERROR_REASONS]).size).toBe(
      retryable.length + TERMINAL_ERROR_REASONS.length,
    );
    expect([...ERROR_REASONS].sort()).toEqual(
      [...retryable, ...TERMINAL_ERROR_REASONS].sort(),
    );
    for (const reason of TERMINAL_ERROR_REASONS)
      expect(retryAfterSeconds("conflict", reason), reason).toBeUndefined();
    for (const reason of retryable)
      expect(
        retryAfterSeconds(
          "conflict",
          reason as keyof typeof RETRYABLE_ERROR_REASONS,
        ),
        reason,
      ).toBeGreaterThan(0);
    // A refusal without a reason is not advised: the message is all there is.
    expect(retryAfterSeconds("conflict")).toBeUndefined();
    // These codes are transient by their meaning alone.
    expect(retryAfterSeconds("capacity_exhausted")).toBeGreaterThan(0);
    expect(retryAfterSeconds("idempotency_in_progress")).toBeGreaterThan(0);
    for (const code of [
      "invalid_request",
      "idempotency_conflict",
      "internal",
    ] as const)
      expect(retryAfterSeconds(code), code).toBeUndefined();
  });
});

describe("request bodies", () => {
  it("never returns a key with a region, and a gateway's routing keyring is canonical and complete", () => {
    const region = {
      id: "eu-1",
      provider: "contabo",
      provider_region: "EU",
      gateway_url: `https://${["gateway", "example", "com"].join(".")}`,
      gateway_binding: null,
      backup_bucket: "pgcf-backups",
      backup_endpoint_url: `https://${["r2", "example", "com"].join(".")}`,
      agent_last_seen_at: null,
      created_at: "2026-10-02T10:46:00.000Z",
      updated_at: "2026-10-02T10:46:00.000Z",
    };
    const keyring = {
      active: "k1",
      keys: { k1: newSecret(), k0: newSecret() },
    };
    expect(Region.safeParse(region).success).toBe(true);
    for (const extra of [
      { route_keyring: keyring },
      { agent_key: `pgcf_ak_eu-1_${newSecret()}` },
    ])
      expect(Region.safeParse({ ...region, ...extra }).success).toBe(false);
    expect(RegionRouteKeyring.safeParse(keyring).success).toBe(true);
    const nonCanonical = keyring.keys.k1.slice(0, -1) + "B";
    for (const broken of [
      { active: "absent", keys: keyring.keys },
      { active: "k1", keys: { k1: keyring.keys.k1 + "=" } },
      { active: "k1", keys: { k1: nonCanonical } },
      { active: "k1", keys: { k1: bytesToBase64url(new Uint8Array(31)) } },
      { active: "k1", keys: { k1: bytesToBase64url(new Uint8Array(33)) } },
      { active: ".bad", keys: { ".bad": newSecret() } },
    ])
      expect(RegionRouteKeyring.safeParse(broken).success).toBe(false);
  });

  it("binds integrator keys to a project and admin keys to none", () => {
    const project_id = newProjectId();
    expect(
      ApiKeyCreate.safeParse({
        scope: "integrator",
        project_id,
        name: "integrator",
      }).success,
    ).toBe(true);
    expect(
      ApiKeyCreate.safeParse({ scope: "integrator", name: "integrator" })
        .success,
    ).toBe(false);
    expect(
      ApiKeyCreate.safeParse({ scope: "admin", project_id, name: "ops" })
        .success,
    ).toBe(false);
    expect(
      ApiKeyCreate.safeParse({ scope: "admin", name: "ops", extra: 1 }).success,
    ).toBe(false);
  });

  it("takes a read-only administrator scope with no project and an optional canonical expiry", () => {
    const project_id = newProjectId();
    expect(
      ApiKeyCreate.safeParse({ scope: "admin_read", name: "monitoring" })
        .success,
    ).toBe(true);
    expect(
      ApiKeyCreate.safeParse({ scope: "admin_read", project_id, name: "x" })
        .success,
    ).toBe(false);
    const expires_at = "2030-01-01T09:30:00.000Z";
    expect(
      ApiKeyCreate.safeParse({ scope: "admin", name: "ops", expires_at })
        .success,
    ).toBe(true);
    for (const bad of ["2030-01-01", "2030-01-01T09:30:00Z", "tomorrow", 5])
      expect(
        ApiKeyCreate.safeParse({ scope: "admin", name: "ops", expires_at: bad })
          .success,
      ).toBe(false);
  });

  it("says in an audit event what was asked, and keeps no body or address", () => {
    const event = {
      id: randomUUID(),
      key_id: "key_abcdefghij1234567890",
      scope: "admin_read",
      method: "POST",
      route: "/v1/api-keys/{id}",
      status: null,
      request_id: "request-1",
      created_at: "2030-01-01T09:30:00.000Z",
    };
    expect(AuditEvent.safeParse(event).success).toBe(true);
    expect(AuditEvent.safeParse({ ...event, status: 403 }).success).toBe(true);
    for (const change of [
      { scope: "integrator" },
      { method: "TRACE" },
      { status: 99 },
      { request_id: "has space" },
      { ip: "203.0.113.7" },
      { body: {} },
    ])
      expect(AuditEvent.safeParse({ ...event, ...change }).success).toBe(false);
  });

  it("requires a field in database patches", () => {
    expect(DatabasePatch.safeParse({}).success).toBe(false);
    expect(DatabaseResize.safeParse({}).success).toBe(false);
    expect(DatabaseResize.safeParse({ size_class_id: "small" }).success).toBe(
      true,
    );
    expect(
      DatabaseResize.safeParse({ size_class_id: "small", name: "rename" })
        .success,
    ).toBe(false);
    expect(OperationKind.parse("database.resize")).toBe("database.resize");
    expect(DatabasePatch.safeParse({ size_class_id: "small" }).success).toBe(
      true,
    );
  });

  it("takes a database's own idle time of 60 to 900 s, or null for its class's", () => {
    const create = {
      project_id: newProjectId(),
      region_id: "eu-1",
      name: "orders",
      size_class_id: "small",
    };
    for (const value of [60, 900, null]) {
      expect(
        DatabaseCreate.safeParse({ ...create, sleep_after_seconds: value })
          .success,
      ).toBe(true);
      expect(
        DatabaseIdleTime.safeParse({ sleep_after_seconds: value }).success,
      ).toBe(true);
    }
    for (const value of [59, 901, 60.5]) {
      expect(
        DatabaseCreate.safeParse({ ...create, sleep_after_seconds: value })
          .success,
      ).toBe(false);
      expect(
        DatabaseIdleTime.safeParse({ sleep_after_seconds: value }).success,
      ).toBe(false);
    }
    for (const body of [
      {},
      { sleep_after_seconds: 120, size_class_id: "small" },
    ])
      expect(DatabaseIdleTime.safeParse(body).success).toBe(false);
    // The size class alone is resized; the idle time has its own resource.
    for (const body of [
      { sleep_after_seconds: 120 },
      { size_class_id: "small", sleep_after_seconds: 120 },
    ])
      expect(DatabaseResize.safeParse(body).success).toBe(false);
  });

  it("validates list queries and idempotency keys", () => {
    expect(ListQuery.parse({})).toEqual({ limit: 50 });
    expect(ListQuery.parse({ limit: "10" }).limit).toBe(10);
    expect(ListQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(ListQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("a.b_c~d-1")).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test("")).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("a".repeat(129))).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("a b")).toBe(false);
  });
});

it("publishes hibernation and explicit manual/automatic lifecycle operation kinds", () => {
  expect(OperationKind.parse("database.suspend")).toBe("database.suspend");
  expect(OperationKind.parse("database.resume")).toBe("database.resume");
  expect(OperationKind.parse("database.hibernate")).toBe("database.hibernate");
  expect(OperationKind.parse("database.wake")).toBe("database.wake");
});
