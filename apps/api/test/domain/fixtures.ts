// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  hashApiKey,
  newAgentKey,
  newApiKey,
  newApiKeyId,
  newNodeId,
  newProjectId,
  randomString,
} from "@pgcf/contracts";
import { createApp } from "../../src/app.ts";

const fixtures: {
  projects: string[];
  regions: string[];
  keyIds: string[];
  size: string;
}[] = [];
export async function cleanupFixtures(): Promise<void> {
  for (const fixture of fixtures.splice(0)) {
    const [project, other] = fixture.projects;
    const [region, foreign] = fixture.regions;
    const databaseScope =
      "database_id IN(SELECT id FROM databases WHERE project_id IN(?,?))";
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM node_bootstrap_jobs WHERE region_id IN(?,?)",
      ).bind(region, foreign),
      env.DB.prepare(
        "DELETE FROM node_provider_mutations WHERE operation_id IN(SELECT operation_id FROM node_additions WHERE region_id IN(?,?))",
      ).bind(region, foreign),
      env.DB.prepare(
        "DELETE FROM node_network_mutations WHERE operation_id IN(SELECT operation_id FROM node_additions WHERE region_id IN(?,?))",
      ).bind(region, foreign),
      env.DB.prepare(
        "DELETE FROM node_network_firewalls WHERE operation_id IN(SELECT operation_id FROM node_additions WHERE region_id IN(?,?))",
      ).bind(region, foreign),
      env.DB.prepare(
        "DELETE FROM node_network_preparations WHERE operation_id IN(SELECT operation_id FROM node_additions WHERE region_id IN(?,?))",
      ).bind(region, foreign),
      env.DB.prepare("DELETE FROM node_additions WHERE region_id IN(?,?)").bind(
        region,
        foreign,
      ),
      env.DB.prepare(
        "DELETE FROM node_region_policies WHERE region_id IN(?,?)",
      ).bind(region, foreign),
      env.DB.prepare(`DELETE FROM operations WHERE ${databaseScope}`).bind(
        project,
        other,
      ),
      env.DB.prepare(`DELETE FROM roles WHERE ${databaseScope}`).bind(
        project,
        other,
      ),
      env.DB.prepare(
        `DELETE FROM lifecycle_events WHERE ${databaseScope}`,
      ).bind(project, other),
      env.DB.prepare("DELETE FROM databases WHERE project_id IN(?,?)").bind(
        project,
        other,
      ),
      env.DB.prepare(
        "DELETE FROM idempotency_keys WHERE api_key_id IN(?,?,?)",
      ).bind(...fixture.keyIds),
      env.DB.prepare("DELETE FROM api_keys WHERE id IN(?,?,?)").bind(
        ...fixture.keyIds,
      ),
      env.DB.prepare("DELETE FROM projects WHERE id IN(?,?)").bind(
        project,
        other,
      ),
      env.DB.prepare("DELETE FROM nodes WHERE region_id IN(?,?)").bind(
        region,
        foreign,
      ),
      env.DB.prepare("DELETE FROM regions WHERE id IN(?,?)").bind(
        region,
        foreign,
      ),
      env.DB.prepare("DELETE FROM size_classes WHERE id=?").bind(fixture.size),
    ]);
  }
}

export async function request(
  path: string,
  key: string,
  method = "GET",
  body?: unknown,
  idempotency?: string,
  extraHeaders?: HeadersInit,
): Promise<Response> {
  const context = createExecutionContext();
  const headers = new Headers(extraHeaders);
  headers.set("Authorization", `Bearer ${key}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (idempotency) headers.set("Idempotency-Key", idempotency);
  const response = await createApp().fetch(
    new Request(new URL(path, `https://${["api", "invalid"].join(".")}`), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, DB_ENDPOINT_HOST: ["db", "invalid"].join(".") },
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
export async function fixture(memory = 4096, storage: number | null = 30) {
  const now = new Date().toISOString(),
    project = newProjectId(),
    other = newProjectId(),
    region = "eu-" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 8),
    foreign = "us-" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 8),
    node = newNodeId();
  const admin = newApiKey().key,
    integrator = newApiKey().key,
    otherKey = newApiKey().key,
    agent = newAgentKey(region),
    foreignAgent = newAgentKey(foreign);
  const size = "s" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 8),
    nodeName =
      "node-" + randomString("abcdefghijklmnopqrstuvwxyz0123456789", 8);
  const statements = [
    env.DB.prepare(
      "INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)",
    ).bind(project, "one", now, now),
    env.DB.prepare(
      "INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)",
    ).bind(other, "two", now, now),
    env.DB.prepare(
      `INSERT INTO size_classes(id,memory_mib,cpu_millicores,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at) VALUES (?,512,500,5,50,NULL,60,7,1,?,?)`,
    ).bind(size, now, now),
  ];
  for (const [id, key] of [
    [region, agent],
    [foreign, foreignAgent],
  ])
    statements.push(
      env.DB.prepare(
        "INSERT INTO regions(id,provider,provider_region,gateway_url,backup_bucket,backup_endpoint_url,agent_key_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        "contabo",
        "test",
        `https://${["gateway", "invalid"].join(".")}`,
        env.ARCHIVE_BUCKET_NAME,
        `https://${["archive", "invalid"].join(".")}`,
        await hashApiKey(env.API_KEY_PEPPER, key!),
        now,
        now,
      ),
    );
  const keyIds: string[] = [];
  for (const [key, scope, projectId] of [
    [admin, "admin", null],
    [integrator, "integrator", project],
    [otherKey, "integrator", other],
  ]) {
    const keyId = newApiKeyId();
    keyIds.push(keyId);
    statements.push(
      env.DB.prepare(
        "INSERT INTO api_keys(id,lookup_id,key_hash,scope,project_id,name,created_at) VALUES (?,?,?,?,?,?,?)",
      ).bind(
        keyId,
        key!.split("_")[2]!,
        await hashApiKey(env.API_KEY_PEPPER, key!),
        scope,
        projectId,
        "test",
        now,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid) VALUES (?,?,?,1,?,2000,?,128,100,?,?,?,?)",
    ).bind(
      node,
      region,
      nodeName,
      memory,
      storage,
      now,
      now,
      now,
      crypto.randomUUID(),
    ),
  );
  await env.DB.batch(statements);
  fixtures.push({
    projects: [project, other],
    regions: [region, foreign],
    keyIds,
    size,
  });
  const create = (name = "database", key = integrator, idempotency?: string) =>
    request(
      "/v1/databases",
      key,
      "POST",
      { project_id: project, region_id: region, name, size_class_id: size },
      idempotency,
    );
  return {
    project,
    other,
    region,
    foreign,
    node,
    nodeName,
    size,
    admin,
    integrator,
    otherKey,
    agent,
    foreignAgent,
    create,
  };
}
export function observation(
  id: string,
  generation: number,
  state = "ready",
  message?: string,
) {
  return {
    id,
    generation,
    state,
    ...(message ? { message } : {}),
    archive: { continuous: true, ready_wal_files: 0 },
  };
}
export function observedBody(
  databases: unknown[],
  nodes: unknown[] = [],
  orphans: unknown[] = [],
) {
  return {
    observed_at: new Date(Date.now() + 1000).toISOString(),
    nodes,
    databases,
    orphans,
  };
}
