// SPDX-License-Identifier: Apache-2.0
// Real local D1/Actor metadata tests; these are not host or Dev acceptance evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { DatabasePoolRuntimeAttestationV2 } from "@pgcf/contracts/reclaim";
import { servingPostgresPoolFixture } from "./postgres-pool-fixture.ts";
import {
  cleanupFixtures,
  observedBody,
  observation,
  request,
} from "./fixtures.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { publishDatabaseAdmission } from "../../src/domain/database-admission-snapshot.ts";
import { readDesiredPostgresPoolBinding } from "../../src/domain/postgres-pool.ts";

afterEach(async () => {
  await cleanupFixtures();
  await env.DB.prepare(
    "DELETE FROM postgres_pool_qualification_receipts WHERE candidate_release_id IN(SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(admissionFixtureReleases))
    .run();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
type Fixture = Awaited<ReturnType<typeof servingPostgresPoolFixture>>;
const actor = (id: string) =>
  env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(id));
async function send(f: Fixture, proof?: DatabasePoolRuntimeAttestationV2) {
  const power = await env.DB.prepare(
    "SELECT power_operation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<string | null>("power_operation");
  const image = f.desired.postgres!.image;
  return request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, f.proof.generation, "ready"),
        ...(power
          ? {
              power: {
                operation: power,
                revision: f.proof.generation,
                state: "awake",
              },
            }
          : {}),
        postgres: { image, image_id: image.split("@")[1]! },
        ...(proof ? { runtime_attestation: proof } : {}),
      },
    ]),
  );
}
function refreshed(f: Fixture) {
  const now = Date.now();
  return DatabasePoolRuntimeAttestationV2.parse({
    ...f.proof,
    ca_secret_resource_version: "82",
    ca_sha256: "0".repeat(64),
    observed_at: now,
    observation: {
      ...f.proof.observation,
      verified_at: now,
      expires_at: now + 60000,
      resource_versions: {
        ...f.proof.observation.resource_versions,
        ca_secret: "82",
      },
    },
  });
}

it("a positively continuous CA-only refresh closes admission but preserves its serving pool holder", async () => {
  const f = await servingPostgresPoolFixture();
  await publishDatabaseAdmission(env, f.id);
  expect(await actor(f.id).admit(f.id, "app")).toMatchObject({
    ok: true,
    target: { kind: "pool" },
  });
  const proof = refreshed(f),
    response = await send(f, proof);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ accepted: 1 });
  expect(
    await env.DB.prepare("SELECT state FROM pool_bindings WHERE id=?")
      .bind(f.binding.scope.binding_id)
      .first("state"),
  ).toBe("serving");
  const epochs = await env.DB.prepare(
    "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
  )
    .bind(f.id)
    .first<{ admission_revision: number; route_revision: number }>();
  expect(epochs).toEqual({
    admission_revision: f.proof.admission_epoch + 1,
    route_revision: f.proof.route_revision + 1,
  });
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
  expect((await readDesiredPostgresPoolBinding(env, f.id))?.authority).toBe(
    "current",
  );
  const current = DatabasePoolRuntimeAttestationV2.parse({
    ...proof,
    admission_epoch: epochs!.admission_revision,
    route_revision: epochs!.route_revision,
  });
  expect((await send(f, current)).status).toBe(200);
  expect(await actor(f.id).admit(f.id, "app")).toMatchObject({
    ok: true,
    target: { kind: "pool", route_revision: epochs!.route_revision },
  });
});
it("a continuous CA refresh tolerates an unrelated pool Namespace label resource-version update", async () => {
  const f = await servingPostgresPoolFixture();
  await publishDatabaseAdmission(env, f.id);
  const proof = DatabasePoolRuntimeAttestationV2.parse({
    ...refreshed(f),
    pool_namespace_resource_version: "82",
  });
  const response = await send(f, proof);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ accepted: 1 });
  expect(
    await env.DB.prepare("SELECT state FROM pool_bindings WHERE id=?")
      .bind(f.binding.scope.binding_id)
      .first("state"),
  ).toBe("serving");
  const epochs = await env.DB.prepare(
    "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
  )
    .bind(f.id)
    .first<{ admission_revision: number; route_revision: number }>();
  expect(
    (
      await send(
        f,
        DatabasePoolRuntimeAttestationV2.parse({
          ...proof,
          admission_epoch: epochs!.admission_revision,
          route_revision: epochs!.route_revision,
        }),
      )
    ).status,
  ).toBe(200);
  expect(await actor(f.id).admit(f.id, "app")).toMatchObject({
    ok: true,
    target: { kind: "pool" },
  });
});

it("missing pool proof cannot use the certificate refresh exception", async () => {
  const f = await servingPostgresPoolFixture();
  await publishDatabaseAdmission(env, f.id);
  const response = await send(f);
  expect(response.status).toBe(200);
  expect(
    await env.DB.prepare("SELECT state FROM pool_bindings WHERE id=?")
      .bind(f.binding.scope.binding_id)
      .first("state"),
  ).toBe("detaching");
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});

it("a changed physical pool target cannot use an otherwise valid CA-only refresh", async () => {
  const f = await servingPostgresPoolFixture();
  await publishDatabaseAdmission(env, f.id);
  const response = await send(
    f,
    DatabasePoolRuntimeAttestationV2.parse({
      ...refreshed(f),
      pod_uid: crypto.randomUUID(),
    }),
  );
  expect(response.status).toBe(200);
  expect(
    await env.DB.prepare("SELECT state FROM pool_bindings WHERE id=?")
      .bind(f.binding.scope.binding_id)
      .first("state"),
  ).toBe("detaching");
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});

it("a watch continuity gap cannot preserve the pool holder even when its CA change is valid", async () => {
  const f = await servingPostgresPoolFixture();
  await publishDatabaseAdmission(env, f.id);
  const proof = refreshed(f);
  const response = await send(
    f,
    DatabasePoolRuntimeAttestationV2.parse({
      ...proof,
      observation: {
        ...proof.observation,
        watch_epoch: proof.observation.watch_epoch + 1,
      },
    }),
  );
  expect(response.status).toBe(200);
  expect(
    await env.DB.prepare("SELECT state FROM pool_bindings WHERE id=?")
      .bind(f.binding.scope.binding_id)
      .first("state"),
  ).toBe("detaching");
  expect(await actor(f.id).admit(f.id, "app")).toEqual({
    ok: false,
    sqlstate: "57P03",
  });
});
