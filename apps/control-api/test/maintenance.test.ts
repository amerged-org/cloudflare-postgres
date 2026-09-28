// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const installer = "test-installation-token";
function call(path: string, token: string, value?: unknown, key?: string) {
  return worker.fetch(
    new IncomingRequest(`https://control.example.test${path}`, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(value === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }),
    env,
  );
}

it("durably prepares installation maintenance with scoped credentials, replay and lease fencing", async () => {
  const registration = await call("/v1/regions", installer, {
    name: "Maintenance region",
  });
  expect(registration.status).toBe(201);
  const region = (await registration.json()) as {
    region: { id: string };
    apiToken: string;
  };
  const base = `/v1/regions/${region.region.id}/maintenance`;
  const issued = await call(`${base}/preparers`, installer, {});
  expect(issued.status).toBe(201);
  const preparer = (await issued.json()) as {
    apiToken: string;
    scopes: string[];
  };
  expect(preparer.apiToken).toMatch(/^cpmtp_[A-Za-z0-9_-]+$/);
  expect(preparer.scopes).toEqual([
    "maintenance:prepare:claim",
    "maintenance:prepare:report",
  ]);
  const plan = {
    schemaVersion: 1,
    kind: "kubernetes.upgrade",
    clusterUid: "11111111-1111-4111-8111-111111111111",
    nodeUids: ["22222222-2222-4222-8222-222222222222"],
    fromVersion: "1.36.3",
    toVersion: "1.36.4",
    talosVersion: "1.14.1",
    toolImage: `ghcr.io/amerged-org/pgcf-talosctl@sha256:${"a".repeat(64)}`,
    targetArtifactsHash: "b".repeat(64),
  };
  const created = await call(
    `${base}/preparations`,
    installer,
    { plan },
    "maintenance-plan-one",
  );
  expect(created.status).toBe(201);
  const initial = (await created.json()) as {
    preparation: {
      id: string;
      planHash: string;
      status: string;
      executionAuthorized: boolean;
      executionSupported: boolean;
    };
  };
  const path = `${base}/preparations/${initial.preparation.id}`;
  expect(initial.preparation.status).toBe("queued");
  expect(initial.preparation.planHash).toMatch(/^[a-f0-9]{64}$/);
  expect(initial.preparation.executionAuthorized).toBe(false);
  expect(initial.preparation.executionSupported).toBe(false);
  const replay = await call(
    `${base}/preparations`,
    installer,
    { plan },
    "maintenance-plan-one",
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(initial);
  const conflict = await call(
    `${base}/preparations`,
    installer,
    { plan: { ...plan, toVersion: "1.36.5" } },
    "maintenance-plan-one",
  );
  expect(conflict.status).toBe(409);
  expect(
    (
      await call(`${base}/preparations/claim`, region.apiToken, {
        leaseSeconds: 90,
      })
    ).status,
  ).toBe(401);
  expect((await call(path, preparer.apiToken)).status).toBe(401);
  const foreignRegion = "33333333-3333-4333-8333-333333333333";
  expect(
    (
      await call(
        `/v1/regions/${foreignRegion}/maintenance/preparations/claim`,
        preparer.apiToken,
        { leaseSeconds: 90 },
      )
    ).status,
  ).toBe(404);
  const firstClaimResponse = await call(
    `${base}/preparations/claim`,
    preparer.apiToken,
    { leaseSeconds: 90 },
  );
  expect(firstClaimResponse.status).toBe(200);
  const first = (await firstClaimResponse.json()) as {
    claim: {
      operationId: string;
      leaseToken: string;
      leaseEpoch: number;
      planHash: string;
    };
  };
  expect(first.claim.operationId).toBe(initial.preparation.id);
  expect(first.claim.planHash).toBe(initial.preparation.planHash);
  await env.DB.prepare(
    "UPDATE maintenance_preparations SET lease_expires_at=? WHERE id=?",
  )
    .bind("2026-01-01T00:00:00.000Z", initial.preparation.id)
    .run();
  const secondClaimResponse = await call(
    `${base}/preparations/claim`,
    preparer.apiToken,
    { leaseSeconds: 90 },
  );
  const second = (await secondClaimResponse.json()) as typeof first;
  expect(second.claim.leaseEpoch).toBe(first.claim.leaseEpoch + 1);
  const observedAt = new Date().toISOString();
  const assessment = {
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
    evidenceHash: "c".repeat(64),
    blockers: [
      "quorum_unproven",
      "database_availability_unproven",
      "recovery_unproven",
      "capacity_unreserved",
    ],
    dryRun: { status: "not_run", jobUid: null },
  };
  const stale = await call(`${path}/result`, preparer.apiToken, {
    leaseToken: first.claim.leaseToken,
    leaseEpoch: first.claim.leaseEpoch,
    planHash: initial.preparation.planHash,
    assessment,
  });
  expect(stale.status).toBe(409);
  const report = {
    leaseToken: second.claim.leaseToken,
    leaseEpoch: second.claim.leaseEpoch,
    planHash: initial.preparation.planHash,
    assessment,
  };
  const completed = await call(`${path}/result`, preparer.apiToken, report);
  expect(completed.status).toBe(201);
  const result = (await completed.json()) as {
    preparation: {
      status: string;
      eligibility: string;
      executionAuthorized: boolean;
      executionSupported: boolean;
    };
  };
  expect(result.preparation.status).toBe("assessed");
  expect(result.preparation.eligibility).toBe("blocked");
  expect(result.preparation.executionAuthorized).toBe(false);
  expect(result.preparation.executionSupported).toBe(false);
  const repeated = await call(`${path}/result`, preparer.apiToken, report);
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual(result);
  expect(await (await call(path, installer)).json()).toEqual(result);
  expect(
    (
      await call(`${base}/preparations/claim`, preparer.apiToken, {
        leaseSeconds: 90,
      })
    ).status,
  ).toBe(200);
  const stored = await env.DB.prepare(
    "SELECT token_hash FROM maintenance_preparer_tokens WHERE region_id=? AND revoked_at IS NULL",
  )
    .bind(region.region.id)
    .first<{ token_hash: string }>();
  expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(stored?.token_hash).not.toBe(preparer.apiToken);
  expect(JSON.stringify(result)).not.toContain(second.claim.leaseToken);

  // A real asynchronous provider rejection must remain a sanitized response.
  const unavailableDatabase = new Proxy(env.DB, {
    get(target, property) {
      if (property === "withSession")
        return () => ({
          prepare: () => ({
            bind() {
              return this;
            },
            async first() {
              throw new Error("private-maintenance-storage-error");
            },
          }),
        });
      return Reflect.get(target, property);
    },
  });
  const unavailable = await worker.fetch(
    new IncomingRequest(`https://control.example.test${base}/preparers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${installer}`,
        "content-type": "application/json",
      },
      body: "{}",
    }),
    { ...env, DB: unavailableDatabase },
  );
  expect(unavailable.status).toBe(500);
  expect(await unavailable.json()).toEqual({
    error: { code: "maintenance_unavailable" },
  });
});
