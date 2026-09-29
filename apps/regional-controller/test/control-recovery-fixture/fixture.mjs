// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export const migrationDirectory = new URL(
  "../../../control-api/migrations",
  import.meta.url,
).pathname;
export const source = {
  installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  databaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
export const migrationTableSql =
  'CREATE TABLE "d1_migrations"(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)';
export async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pgcf-control-recovery-"));
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(migrationTableSql);
  for (const name of readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()) {
    db.exec(readFileSync(join(migrationDirectory, name), "utf8"));
    db.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES(?,?)").run(
      name,
      "2026-09-29T00:00:00.000Z",
    );
  }
  const packages = new URL("../../../../node_modules/.pnpm", import.meta.url)
    .pathname;
  const esbuildPath = join(
    packages,
    readdirSync(packages).find((name) => /^esbuild@/.test(name)),
    "node_modules/esbuild/lib/main.js",
  );
  const { build } = await import(pathToFileURL(esbuildPath));
  const workerCodec = join(directory, "worker-codec.mjs");
  await build({
    stdin: {
      contents:
        'export {encryptCredential,roleCredentialContext} from "./apps/control-api/src/role-credentials.ts"; export {protectFence} from "./apps/control-api/src/accounting.ts";',
      resolveDir: new URL("../../../../", import.meta.url).pathname,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: workerCodec,
    logLevel: "silent",
  });
  const codec = await import(pathToFileURL(workerCodec));
  const oldKey = randomBytes(32).toString("base64url"),
    currentKey = randomBytes(32).toString("base64url");
  const ring = {
    active: "current",
    keys: { old: oldKey, current: currentKey },
  };
  const keyrings = {
    ROLE_CREDENTIAL_KEYS: JSON.stringify(ring),
    ALLOWANCE_FENCE_KEYS: JSON.stringify({
      active: "current",
      keys: {
        old: randomBytes(32).toString("base64url"),
        current: randomBytes(32).toString("base64url"),
      },
    }),
  };
  const ids = {
    organization: "11111111-1111-4111-8111-111111111111",
    project: "22222222-2222-4222-8222-222222222222",
    region: "33333333-3333-4333-8333-333333333333",
    environment: "44444444-4444-4444-8444-444444444444",
    role: "55555555-5555-4555-8555-555555555555",
    cluster: "66666666-6666-4666-8666-666666666666",
    reservation: "77777777-7777-4777-8777-777777777777",
  };
  const now = "2026-09-29T00:00:00.000Z",
    specHash = "a".repeat(64);
  db.prepare("INSERT INTO organizations VALUES(?,?,?)").run(
    ids.organization,
    "Recovery fixture",
    now,
  );
  db.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run(
    ids.project,
    ids.organization,
    "Retained project",
    "active",
    now,
  );
  db.prepare("INSERT INTO regions VALUES(?,?,?,?)").run(
    ids.region,
    "Recovery region",
    "active",
    now,
  );
  db.prepare("INSERT INTO region_catalogs VALUES(?,?,?,?,?)").run(
    ids.region,
    "v1",
    "[]",
    "b".repeat(64),
    now,
  );
  db.prepare(
    "INSERT INTO environments(id,organization_id,project_id,region_id,catalog_version,profile_id,name,status,spec_revision,spec_hash,resolved_spec,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    ids.environment,
    ids.organization,
    ids.project,
    ids.region,
    "v1",
    "fixture",
    "Fixture database",
    "ready",
    1,
    specHash,
    JSON.stringify({ profile: {} }),
    now,
  );
  db.prepare(
    "INSERT INTO database_roles(id,organization_id,project_id,environment_id,region_id,spec_revision,spec_hash,cluster_uid,name,connection_limit,desired_credential_revision,applied_credential_revision,status,version_token,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    ids.role,
    ids.organization,
    ids.project,
    ids.environment,
    ids.region,
    1,
    specHash,
    ids.cluster,
    "owner",
    20,
    2,
    2,
    "applied",
    "role-version",
    now,
  );
  const role = {
    id: ids.role,
    organization_id: ids.organization,
    project_id: ids.project,
    environment_id: ids.environment,
    region_id: ids.region,
    spec_revision: 1,
    spec_hash: specHash,
    cluster_uid: ids.cluster,
    name: "owner",
  };
  const firstPassword = randomBytes(32).toString("base64url"),
    currentPassword = randomBytes(32).toString("base64url");
  const oldRing = JSON.stringify({ ...ring, active: "old" });
  const first = await codec.encryptCredential(
    { ROLE_CREDENTIAL_KEYS: oldRing },
    firstPassword,
    codec.roleCredentialContext(role, 1),
  );
  const current = await codec.encryptCredential(
    keyrings,
    currentPassword,
    codec.roleCredentialContext(role, 2),
  );
  db.prepare("INSERT INTO role_credentials VALUES(?,?,?,?)").run(
    ids.role,
    1,
    first,
    now,
  );
  db.prepare("INSERT INTO role_credentials VALUES(?,?,?,?)").run(
    ids.role,
    2,
    current,
    now,
  );
  const fence = "cprsv_" + randomBytes(32).toString("base64url"),
    fenceHash = createHash("sha256").update(fence).digest("hex");
  const protectedFence = await codec.protectFence(
    {
      ALLOWANCE_FENCE_KEYS: JSON.stringify({
        ...JSON.parse(keyrings.ALLOWANCE_FENCE_KEYS),
        active: "old",
      }),
    },
    fence,
    {
      reservationId: ids.reservation,
      environmentId: ids.environment,
      regionId: ids.region,
      specHash,
    },
  );
  db.prepare(
    "INSERT INTO allowance_reservations(id,request_id,region_id,environment_id,organization_id,project_id,spec_revision,spec_hash,request_hash,issued_at,expires_at,execution_epoch,fence_token_hash,fence_ciphertext,fence_iv,fence_key_version,units_json,status,revision,gap_count,version_token) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    ids.reservation,
    "88888888-8888-4888-8888-888888888888",
    ids.region,
    ids.environment,
    ids.organization,
    ids.project,
    1,
    specHash,
    "c".repeat(64),
    now,
    "2026-09-29T00:01:00.000Z",
    "1",
    fenceHash,
    protectedFence.ciphertext,
    protectedFence.iv,
    protectedFence.keyVersion,
    JSON.stringify({ cpu_millicore_ms: "900719925474099312345" }),
    "issued",
    "1",
    "0",
    "reservation-version",
  );
  db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='d1_migrations'").run(
    9007199254740993n,
  );
  const recoveryKeyFile = join(directory, "recovery.key");
  writeFileSync(recoveryKeyFile, randomBytes(32).toString("base64url") + "\n", {
    mode: 0o600,
  });
  const query = async (sql) => db.prepare(sql).get().snapshot_json;
  return {
    directory,
    db,
    keyrings,
    recoveryKeyFile,
    query,
    source,
    ids,
    firstPassword,
    currentPassword,
    fence,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
