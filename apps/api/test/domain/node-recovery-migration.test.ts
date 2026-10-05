// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "./fixtures.ts";

const migrations = (env as typeof env & { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;
const childTables = [
  "node_network_mutations",
  "node_network_firewalls",
  "node_network_preparations",
  "node_provider_mutations",
  "node_bootstrap_jobs",
];

// The setup hook applies all migrations. Recreate only the empty node-addition
// tables from their original migrations so this exercises a populated upgrade.
beforeEach(async () => {
  await env.DB.batch(
    [...childTables, "node_additions"].map((table) =>
      env.DB.prepare(`DROP TABLE ${table}`),
    ),
  );
  await env.DB.prepare(
    "DROP INDEX IF EXISTS nodes_provider_instance_active_idx",
  ).run();
  for (const prefix of ["0011", "0013", "0014"])
    await env.DB.batch(
      migrations
        .find((migration) => migration.name.startsWith(prefix))!
        .queries.filter((query) =>
          /CREATE (TABLE|(?:UNIQUE )?INDEX|TRIGGER) node_(?:additions|addition_intent|bootstrap|provider|network)/.test(
            query,
          ),
        )
        .map((query) => env.DB.prepare(query)),
    );
  for (const migration of recoveryMigrations())
    await env.DB.prepare("DELETE FROM d1_migrations WHERE name=?")
      .bind(migration.name)
      .run();
});
afterEach(cleanupFixtures);

function recoveryMigrations() {
  return migrations.filter((migration) => migration.name.startsWith("0017"));
}
async function migrate() {
  await applyD1Migrations(env.DB, recoveryMigrations());
}
const hash = () => crypto.randomUUID().replaceAll("-", "").repeat(2);
async function addition(
  region: string,
  options: {
    node?: string;
    requested?: string;
    provider?: string;
    status?: "reserved" | "unknown" | "ready" | "cancelled";
    predecessor?: string;
  } = {},
) {
  const operation = newOperationId(),
    node = options.node ?? newNodeId(),
    now = new Date().toISOString(),
    status = options.status ?? "reserved";
  await env.DB.prepare(
    `INSERT INTO node_additions(operation_id,node_id,region_id,request_key,request_hash,intent_hash,intent_json,status,slot_held,requested_instance_id,provider_instance_id,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      operation,
      node,
      region,
      crypto.randomUUID(),
      hash(),
      hash(),
      JSON.stringify({
        operation_id: operation,
        node_id: node,
        request: {
          region_id: region,
          mode: options.predecessor ? "recover" : "adopt",
          provider_instance_id: options.requested,
          ...(options.predecessor
            ? {
                predecessor_node_id: options.predecessor,
                predecessor_node_uid: "retained-node-uid",
              }
            : {}),
        },
      }),
      status,
      status === "cancelled" ? 0 : 1,
      options.requested ?? null,
      options.provider ?? null,
      now,
      now,
    )
    .run();
  return operation;
}

it("upgrades populated D1 without changing tombstones, encrypted custody, jobs, network claims, constraints or triggers", async () => {
  const f = await fixture(),
    now = new Date().toISOString(),
    operation = await addition(f.region, {
      node: f.node,
      requested: "retained-provider",
      provider: "retained-provider",
      status: "ready",
    }),
    firewall = crypto.randomUUID();
  await addition(f.region, {
    status: "unknown",
    provider: "uncertain-provider",
  });
  await addition(f.region, {
    status: "cancelled",
    requested: "retained-provider",
  });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE nodes SET provider_instance_id='retained-provider',node_uid='retained-node-uid',ready=0,schedulable=0,lost_at=?,lost_reason='confirmed lost' WHERE id=?",
    ).bind(now, f.node),
    env.DB.prepare(
      "INSERT INTO node_bootstrap_jobs(operation_id,node_id,region_id,input_hash,inventory_revision,sealed_revision,input_ciphertext,input_iv,input_kid,callback_hash,checkpoint_json,created_at,updated_at) VALUES(?,?,?, ?,1,1,'retained-ciphertext','retained-iv-data','retained-kid',?,'{}',?,?)",
    ).bind(operation, f.node, f.region, hash(), hash(), now, now),
    env.DB.prepare(
      "INSERT INTO node_provider_mutations(operation_id,mutation,request_id,revision,state,created_at,updated_at) VALUES(?,'restart',?,1,'accepted',?,?)",
    ).bind(operation, crypto.randomUUID(), now, now),
    env.DB.prepare(
      "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_sha256,plan_json,status,created_at,updated_at) VALUES(?,?,?,'{}','verified',?,?)",
    ).bind(operation, hash(), hash(), now, now),
    env.DB.prepare(
      "INSERT INTO node_network_firewalls(firewall_id,operation_id,plan_sha256) VALUES(?,?,?)",
    ).bind(firewall, operation, hash()),
    env.DB.prepare(
      "INSERT INTO node_network_mutations(operation_id,firewall_id,action,request_id,plan_sha256,state) VALUES(?,?,'assign',?,?,'confirmed')",
    ).bind(operation, firewall, crypto.randomUUID(), hash()),
    ...["agent_key", "region_seed", "join_bundle"].map((purpose) =>
      env.DB.prepare(
        "INSERT INTO region_bootstrap_credentials(region_id,purpose,revision,version,kid,iv,ciphertext,created_at) VALUES(?,?,1,1,'retained-kid','abcdefghijklmnop','retainedciphertext123456',?)",
      ).bind(f.region, purpose, now),
    ),
  ]);
  const tables = (
    await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations' ORDER BY name",
    ).all<{ name: string }>()
  ).results;
  const snapshot = new Map<
    string,
    {
      rows: unknown[];
      columns: unknown[];
      foreignKeys: unknown[];
      schema: string;
    }
  >();
  for (const { name } of tables)
    snapshot.set(name, {
      rows: (await env.DB.prepare(`SELECT * FROM ${name} ORDER BY 1,2`).all())
        .results,
      columns: (await env.DB.prepare(`PRAGMA table_info(${name})`).all())
        .results,
      foreignKeys: (
        await env.DB.prepare(`PRAGMA foreign_key_list(${name})`).all()
      ).results,
      schema: (await env.DB.prepare(
        "SELECT sql FROM sqlite_master WHERE name=?",
      )
        .bind(name)
        .first<string>("sql"))!,
    });
  const indexes = (
    await env.DB.prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name<>'node_additions_requested_instance_idx' ORDER BY name",
    ).all<{ name: string; sql: string }>()
  ).results;
  const triggers = (
    await env.DB.prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
    ).all()
  ).results;
  await migrate();
  for (const [name, before] of snapshot) {
    expect(
      (await env.DB.prepare(`SELECT * FROM ${name} ORDER BY 1,2`).all())
        .results,
    ).toEqual(before.rows);
    expect(
      (await env.DB.prepare(`PRAGMA table_info(${name})`).all()).results,
    ).toEqual(before.columns);
    expect(
      (await env.DB.prepare(`PRAGMA foreign_key_list(${name})`).all()).results,
    ).toEqual(before.foreignKeys);
    const schema = (await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE name=?",
    )
      .bind(name)
      .first<string>("sql"))!;
    const expected =
      name === "node_additions"
        ? before.schema.replace(
            "provider_instance_id TEXT UNIQUE",
            "provider_instance_id TEXT",
          )
        : before.schema;
    const normalize = (sql: string) =>
      sql.replaceAll('"', "").replace(/\s+/g, " ").trim();
    expect(normalize(schema)).toBe(normalize(expected));
  }
  for (const index of indexes)
    expect(
      await env.DB.prepare("SELECT name,sql FROM sqlite_master WHERE name=?")
        .bind(index.name)
        .first(),
    ).toEqual(index);
  expect(
    (
      await env.DB.prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      ).all()
    ).results,
  ).toEqual(triggers);
  expect(
    (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
  expect(await env.DB.prepare("PRAGMA quick_check").first("quick_check")).toBe(
    "ok",
  );
  await expect(
    addition(f.region, {
      requested: "retained-provider",
      provider: "retained-provider",
      predecessor: f.node,
    }),
  ).resolves.toBeTypeOf("string");
  await expect(
    env.DB.prepare(
      "UPDATE node_additions SET intent_json='{}' WHERE operation_id=?",
    )
      .bind(operation)
      .run(),
  ).rejects.toThrow("node_addition_intent_immutable");
  await expect(
    env.DB.prepare("UPDATE nodes SET node_uid='replacement' WHERE id=?")
      .bind(f.node)
      .run(),
  ).rejects.toThrow("lost_node_identity_immutable");
});

it("holds pending provider bindings and one recovery predecessor, then releases cancelled reservations", async () => {
  const f = await fixture();
  await migrate();
  const operation = await addition(f.region, {
    requested: "pending-request",
    provider: "pending-provider",
    predecessor: f.node,
  });
  await expect(
    addition(f.region, { requested: "pending-request" }),
  ).rejects.toThrow("UNIQUE constraint failed");
  await expect(
    addition(f.region, { provider: "pending-provider" }),
  ).rejects.toThrow("UNIQUE constraint failed");
  await expect(
    addition(f.region, {
      predecessor: f.node,
      requested: "different-request",
      provider: "different-provider",
    }),
  ).rejects.toThrow("UNIQUE constraint failed");
  await env.DB.prepare(
    "UPDATE node_additions SET status='cancelled',slot_held=0 WHERE operation_id=?",
  )
    .bind(operation)
    .run();
  await expect(
    addition(f.region, {
      requested: "pending-request",
      provider: "pending-provider",
      predecessor: f.node,
    }),
  ).resolves.toBeTypeOf("string");
});

it("allows a retained lost owner and one active replacement while enforcing ownership across regions", async () => {
  const f = await fixture(),
    now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE nodes SET provider_instance_id='same-provider',ready=0,schedulable=0,lost_at=?,lost_reason='confirmed lost' WHERE id=?",
  )
    .bind(now, f.node)
    .run();
  await migrate();
  const insert = (region: string, provider: string | null) =>
    env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,provider_instance_id,allocatable_memory_mib,allocatable_cpu_millicores,created_at,updated_at) VALUES(?,?,?,?,0,0,?,?)",
    )
      .bind(newNodeId(), region, crypto.randomUUID(), provider, now, now)
      .run();
  await insert(f.region, "same-provider");
  await expect(insert(f.foreign, "same-provider")).rejects.toThrow(
    "UNIQUE constraint failed",
  );
  await insert(f.region, null);
  await insert(f.foreign, null);
});
