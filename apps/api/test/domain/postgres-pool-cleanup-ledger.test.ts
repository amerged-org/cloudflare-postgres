// SPDX-License-Identifier: Apache-2.0
// Controlled real D1 reservation metadata only; no cleanup worker or physical proof is claimed.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { newDatabaseId } from "@pgcf/contracts";
import {
  PoolBindingScope,
  poolBindingScopeHash,
} from "@pgcf/contracts/postgres-pool";
import generatedPool from "../../../../packages/contracts/native/postgres-pool.generated.json" with { type: "json" };
import { cleanupFixtures, fixture } from "./fixtures.ts";
afterEach(async () => {
  await cleanupFixtures();
});
it("keeps one immutable full logical allocation reserve and refuses any alternate cleanup mode", async () => {
  const f = await fixture(),
    operation = "op_" + "a".repeat(20),
    bytes = 5 * 1024 ** 3,
    now = Date.now();
  const id = newDatabaseId(),
    scope = PoolBindingScope.parse({
      ...generatedPool.thin_scope,
      database_id: id,
      node_id: f.node,
      region_id: f.region,
      binding_id: crypto.randomUUID(),
      pool_pod_uid: crypto.randomUUID(),
    }),
    timestamp = new Date(now).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,archive_path,created_at,updated_at) VALUES(?,?,?,?,?,?,'running','s3://fixture/ledger',?,?)",
    ).bind(
      id,
      f.project,
      f.region,
      f.node,
      "cleanup_ledger",
      f.size,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      "INSERT INTO pool_pods(pod_uid,node_id,node_uid,boot_id,policy_revision,attestation_json,state,binding_id,first_observed_at,last_observed_at) VALUES(?,?,?,?,1,?,'claimed',?,?,?)",
    ).bind(
      scope.pool_pod_uid,
      f.node,
      scope.node_uid,
      scope.boot_id,
      JSON.stringify({ v: 1 }),
      scope.binding_id,
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO pool_bindings(id,database_id,node_id,node_uid,boot_id,pool_pod_uid,generation,route_revision,admission_epoch,holder_revision,scope_sha256,scope_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,'detaching',?,?)",
    ).bind(
      scope.binding_id,
      id,
      f.node,
      scope.node_uid,
      scope.boot_id,
      scope.pool_pod_uid,
      scope.generation,
      scope.route_revision,
      scope.admission_epoch,
      await poolBindingScopeHash(scope),
      JSON.stringify(scope),
      now,
      now,
    ),
  ]);
  const claims = {
    binding_id: scope.binding_id,
    operation_id: operation,
    authority_revision: 3,
    allocation_reserve_bytes: bytes,
    cleanup_mode: "drain_unmount",
    iat: now,
    exp: now + 1000,
  };
  const reserve = (value: typeof claims) =>
    env.DB.prepare(
      "INSERT INTO pool_cleanup_grants(binding_id,operation_id,authority_revision,claims_json,issued_at,expires_at,allocation_reserve_bytes,headroom_authority_revision,headroom_snapshot_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,'reserved',?,?)",
    )
      .bind(
        value.binding_id,
        value.operation_id,
        value.authority_revision,
        JSON.stringify(value),
        value.iat,
        value.exp,
        value.allocation_reserve_bytes,
        "b".repeat(64),
        now,
        now,
      )
      .run();
  await expect(
    reserve({ ...claims, cleanup_mode: "tenant_start" }),
  ).rejects.toThrow();
  expect((await reserve(claims)).meta.changes).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT allocation_reserve_bytes FROM pool_cleanup_grants WHERE binding_id=?",
    )
      .bind(claims.binding_id)
      .first("allocation_reserve_bytes"),
  ).toBe(bytes);
  await expect(
    env.DB.prepare(
      "UPDATE pool_cleanup_grants SET allocation_reserve_bytes=allocation_reserve_bytes+1 WHERE binding_id=?",
    )
      .bind(claims.binding_id)
      .run(),
  ).rejects.toThrow();
  await expect(
    reserve({
      ...claims,
      operation_id: "op_" + "c".repeat(20),
      authority_revision: 4,
    }),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare(
      "UPDATE pool_cleanup_grants SET claims_json=json_set(claims_json,'$.cleanup_mode','tenant_start') WHERE binding_id=?",
    )
      .bind(claims.binding_id)
      .run(),
  ).rejects.toThrow();
});
