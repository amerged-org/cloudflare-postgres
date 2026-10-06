// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApiKeyCreate,
  DatabasePatch,
  DatabaseResize,
  OperationKind,
  ERROR_CODES,
  ErrorBody,
  IDEMPOTENCY_KEY_PATTERN,
  ListQuery,
  Node,
  Region,
  RegionCreated,
  newAgentKey,
  newSecret,
  bytesToBase64url,
  decodeCursor,
  encodeCursor,
  errorBody,
  errorStatus,
  newDatabaseId,
  newProjectId,
  newNodeId,
  RoleCreate,
  SizeClassUpsert,
  MAINTENANCE_ROLE,
} from "../src/index.ts";

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

it("reserves only the exact internal maintenance role in customer creation", () => {
  expect(RoleCreate.safeParse({ name: MAINTENANCE_ROLE }).success).toBe(false);
  expect(RoleCreate.parse({ name: "pgcf_customer" }).name).toBe(
    "pgcf_customer",
  );
});

describe("node CPU measurement compatibility", () => {
  it("keeps legacy views valid without inventing measured platform CPU", () => {
    const now = new Date().toISOString();
    const node = {
      id: newNodeId(),
      region_id: "eu-test",
      k8s_node_name: "test-node",
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
});

describe("request bodies", () => {
  it("returns a complete routing keyring only at region creation", () => {
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
    const created = {
      region,
      agent_key: newAgentKey(region.id),
      route_keyring: {
        active: "k1",
        keys: { k1: newSecret(), k0: newSecret() },
      },
    };
    expect(RegionCreated.safeParse(created).success).toBe(true);
    expect(
      RegionCreated.safeParse({ region, agent_key: created.agent_key }).success,
    ).toBe(false);
    expect(Region.safeParse(region).success).toBe(true);
    expect(
      Region.safeParse({ ...region, route_keyring: created.route_keyring })
        .success,
    ).toBe(false);
    expect(
      RegionCreated.safeParse({
        ...created,
        route_keyring: { active: "absent", keys: created.route_keyring.keys },
      }).success,
    ).toBe(false);
    expect(
      RegionCreated.safeParse({
        ...created,
        route_keyring: {
          active: "k1",
          keys: { k1: created.route_keyring.keys.k1 + "=" },
        },
      }).success,
    ).toBe(false);
    const nonCanonical = created.route_keyring.keys.k1.slice(0, -1) + "B";
    expect(
      RegionCreated.safeParse({
        ...created,
        route_keyring: { active: "k1", keys: { k1: nonCanonical } },
      }).success,
    ).toBe(false);
    expect(
      RegionCreated.safeParse({
        ...created,
        route_keyring: {
          active: "k1",
          keys: { k1: bytesToBase64url(new Uint8Array(31)) },
        },
      }).success,
    ).toBe(false);
    expect(
      RegionCreated.safeParse({
        ...created,
        route_keyring: {
          active: "k1",
          keys: { k1: bytesToBase64url(new Uint8Array(33)) },
        },
      }).success,
    ).toBe(false);
    expect(
      RegionCreated.safeParse({
        ...created,
        route_keyring: { active: ".bad", keys: { ".bad": newSecret() } },
      }).success,
    ).toBe(false);
  });

  it("binds integrator keys to a project and admin keys to none", () => {
    const project_id = newProjectId();
    expect(
      ApiKeyCreate.safeParse({ scope: "integrator", project_id, name: "omh" })
        .success,
    ).toBe(true);
    expect(
      ApiKeyCreate.safeParse({ scope: "integrator", name: "omh" }).success,
    ).toBe(false);
    expect(
      ApiKeyCreate.safeParse({ scope: "admin", project_id, name: "ops" })
        .success,
    ).toBe(false);
    expect(
      ApiKeyCreate.safeParse({ scope: "admin", name: "ops", extra: 1 }).success,
    ).toBe(false);
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
