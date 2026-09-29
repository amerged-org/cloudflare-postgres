// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import { accountingCall, accountingFixture } from "./accounting-fixture";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
function call(
  path: string,
  init: RequestInit<IncomingRequestCfProperties> = {},
) {
  return worker.fetch(
    new IncomingRequest(`https://control.example.test${path}`, init),
    {
      ...env,
      ROLE_CREDENTIAL_KEYS: JSON.stringify({
        active: "test-suspend-v1",
        keys: {
          "test-suspend-v1": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      }),
    } as typeof env,
  );
}

it("persists an owned suspend intent, locks database work and current funding, and recovers a fenced regional acknowledgement", async () => {
  const f = await accountingFixture("manual suspend");
  const lane = `/v1/regions/${f.regionId}/operations`;
  const creation = (await (
    await accountingCall(`${lane}/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    })
  ).json()) as {
    claim: { operationId: string; leaseToken: string; leaseEpoch: number };
  };
  const clusterUid = "44444444-4444-4444-8444-444444444444";
  expect(
    (
      await accountingCall(`${lane}/${creation.claim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          leaseToken: creation.claim.leaseToken,
          leaseEpoch: creation.claim.leaseEpoch,
          status: "ready",
          resultCode: "cnpg_ready",
          observation: { clusterUid, clusterGeneration: 1, readyInstances: 1 },
        }),
      })
    ).status,
  ).toBe(200);
  const base = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments/${f.environmentId}`;
  const initial = await call(`${base}/runtime`, { headers: f.orgHeaders });
  expect(initial.status).toBe(200);
  expect(await initial.json()).toMatchObject({
    runtime: { revision: 0, desiredState: "running", phase: "running" },
  });
  const roleCreated = await call(`${base}/roles`, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "suspend-owner" },
    body: JSON.stringify({ name: "suspendowner", connectionLimit: 20 }),
  });
  expect(roleCreated.status).toBe(202);
  const role = (await roleCreated.json()) as { role: { id: string } };
  const suspend = () =>
    call(`${base}/suspend`, {
      method: "POST",
      headers: { ...f.orgHeaders, "idempotency-key": "suspend-intent" },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
  expect((await suspend()).status).toBe(409);
  const roleLane = `/v1/regions/${f.regionId}/role-operations`;
  const granted = (await (
    await call(`${roleLane}/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    })
  ).json()) as {
    claim: {
      operationId: string;
      leaseToken: string;
      leaseEpoch: number;
      password: string;
    };
  };
  expect(
    (
      await call(`${roleLane}/${granted.claim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          leaseToken: granted.claim.leaseToken,
          leaseEpoch: granted.claim.leaseEpoch,
          status: "applied",
          resultCode: "role_verified",
          observation: {
            namespaceUid: "33333333-3333-4333-8333-333333333333",
            clusterUid,
            roleUid: "55555555-5555-4555-8555-555555555555",
            roleGeneration: 1,
            roleObservedGeneration: 1,
            secretUid: "66666666-6666-4666-8666-666666666666",
            secretResourceVersion: "101",
            roleSecretResourceVersion: "101",
            authenticatedUser: "suspendowner",
            authenticatedDatabase: "app",
            writablePrimary: true,
            previousCredentialRejected: null,
          },
        }),
      })
    ).status,
  ).toBe(200);
  const reservations = `/v1/regions/${f.regionId}/allowance-reservations`;
  const input = {
    requestId: crypto.randomUUID(),
    environmentId: f.environmentId,
    leaseSeconds: 90,
    units: { cpu_millicore_ms: "1000" },
  };
  const receipt = (await (
    await accountingCall(reservations, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify(input),
    })
  ).json()) as {
    reservation: { id: string; fenceToken: string; expiresAt: string };
  };
  expect(
    (
      await accountingCall(
        `${reservations}/${receipt.reservation.id}/authority`,
        { headers: f.regionHeaders },
      )
    ).status,
  ).toBe(200);
  const accepted = await suspend();
  expect(accepted.status).toBe(202);
  const intent = (await accepted.json()) as {
    runtime: { revision: number; desiredState: string; phase: string };
    operation: { id: string; kind: string };
  };
  expect(intent.runtime).toMatchObject({
    revision: 1,
    desiredState: "suspended",
    phase: "suspending",
  });
  expect(intent.operation.kind).toBe("environment.suspend");
  expect(await (await suspend()).json()).toEqual(intent);
  expect(
    (
      await call(`${base}/suspend`, {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "stale-suspend" },
        body: JSON.stringify({ expectedRevision: 0 }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(`${base}/roles/${role.role.id}/credentials`, {
        headers: f.orgHeaders,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(`${base}/roles/${role.role.id}/rotate`, {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "stopped-rotation" },
        body: JSON.stringify({ expectedCredentialRevision: 1 }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(`${base}/databases`, {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "stopped-create" },
        body: JSON.stringify({ name: "stoppeddb", ownerRoleId: role.role.id }),
      })
    ).status,
  ).toBe(409);
  const current = await (
    await accountingCall(
      `${reservations}/${receipt.reservation.id}/authority`,
      { headers: f.regionHeaders },
    )
  ).json();
  expect(current).toMatchObject({
    authority: { decision: "stop", reason: "environment_suspended" },
  });
  expect(
    (
      await accountingCall(reservations, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({ ...input, requestId: crypto.randomUUID() }),
      })
    ).status,
  ).toBe(409);
  expect(
    await (
      await accountingCall(reservations, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify(input),
      })
    ).json(),
  ).toMatchObject({
    reservation: {
      fenceToken: receipt.reservation.fenceToken,
      expiresAt: receipt.reservation.expiresAt,
    },
  });
  const stopLane = `/v1/regions/${f.regionId}/suspend-operations`;
  const leased = (await (
    await call(`${stopLane}/claim`, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify({ leaseSeconds: 90 }),
    })
  ).json()) as {
    claim: {
      operationId: string;
      leaseToken: string;
      leaseEpoch: number;
      runtimeRevision: number;
      clusterUid: string;
    };
  };
  expect(leased.claim).toMatchObject({
    operationId: intent.operation.id,
    runtimeRevision: 1,
    clusterUid,
  });
  const report = {
    leaseToken: leased.claim.leaseToken,
    leaseEpoch: leased.claim.leaseEpoch,
    status: "suspended",
    resultCode: "compute_suspended",
    observation: {
      namespaceUid: "33333333-3333-4333-8333-333333333333",
      clusterUid,
      quotaUid: "77777777-7777-4777-8777-777777777777",
      volumesHash: "a".repeat(64),
      pooler: null,
      computeAbsent: true,
      quotaPodsZero: true,
      clusterHibernated: true,
      poolerStopped: true,
    },
  };
  expect(
    (
      await call(`${stopLane}/${intent.operation.id}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          ...report,
          leaseEpoch: leased.claim.leaseEpoch + 1,
        }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(`${stopLane}/${intent.operation.id}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          ...report,
          observation: { ...report.observation, computeAbsent: false },
        }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(`${stopLane}/${intent.operation.id}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify(report),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(`${stopLane}/${intent.operation.id}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify(report),
      })
    ).status,
  ).toBe(200);
  expect(
    await (await call(`${base}/runtime`, { headers: f.orgHeaders })).json(),
  ).toMatchObject({ runtime: { revision: 1, phase: "suspended" } });
  expect(
    await (
      await call(
        `/v1/organizations/${f.organizationId}/operations/${intent.operation.id}`,
        { headers: f.orgHeaders },
      )
    ).json(),
  ).toMatchObject({
    operation: { kind: "environment.suspend", status: "succeeded" },
  });
  expect(JSON.stringify(intent)).not.toContain(granted.claim.password);
  expect(
    (await call(`${base}/runtime`, { headers: f.regionHeaders })).status,
  ).toBe(401);
  const stranger = await accountingFixture("foreign suspend");
  expect(
    (await call(`${base}/runtime`, { headers: stranger.orgHeaders })).status,
  ).toBe(404);
});

it("rotates an expired deferred suspend behind newer queued work, including a deletion-bound stop, without completing either", async () => {
  const f = await accountingFixture("fair suspend queue");
  const environments = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments`;
  const lane = `/v1/regions/${f.regionId}/suspend-operations`;
  interface Claim {
    operationId: string;
    leaseToken: string;
    leaseEpoch: number;
    leaseExpiresAt: string;
  }
  const post = (path: string, body: unknown) =>
    call(path, {
      method: "POST",
      headers: f.regionHeaders,
      body: JSON.stringify(body),
    });
  const claim = async () => {
    const response = await post(`${lane}/claim`, { leaseSeconds: 90 });
    expect(response.status).toBe(200);
    return ((await response.json()) as { claim: Claim }).claim;
  };
  const ready = async (environmentId: string, clusterUid: string) => {
    const creationLane = `/v1/regions/${f.regionId}/operations`;
    const response = await post(`${creationLane}/claim`, {
      leaseSeconds: 90,
    });
    expect(response.status).toBe(200);
    const creation = (
      (await response.json()) as { claim: Claim & { environmentId: string } }
    ).claim;
    expect(creation.environmentId).toBe(environmentId);
    expect(
      (
        await post(`${creationLane}/${creation.operationId}/result`, {
          leaseToken: creation.leaseToken,
          leaseEpoch: creation.leaseEpoch,
          status: "ready",
          resultCode: "cnpg_ready",
          observation: { clusterUid, clusterGeneration: 1, readyInstances: 1 },
        })
      ).status,
    ).toBe(200);
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  const startedAt = Date.now();
  try {
    await ready(f.environmentId, "44444444-4444-4444-8444-444444444444");
    const accepted = await call(`${environments}/${f.environmentId}/suspend`, {
      method: "POST",
      headers: { ...f.orgHeaders, "idempotency-key": "fair-old-stop" },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    expect(accepted.status).toBe(202);
    const older = (await accepted.json()) as { operation: { id: string } };
    const original = await claim();
    expect(original.operationId).toBe(older.operation.id);

    // Advance the clock through genuine API lease renewal, not database edits.
    vi.setSystemTime(startedAt + 20_000);
    const renewal = await post(`${lane}/${original.operationId}/renew`, {
      leaseToken: original.leaseToken,
      leaseEpoch: original.leaseEpoch,
      leaseSeconds: 90,
    });
    expect(renewal.status).toBe(200);
    const renewed = (await renewal.json()) as { leaseExpiresAt: string };
    expect(Date.parse(renewed.leaseExpiresAt)).toBeGreaterThan(
      Date.parse(original.leaseExpiresAt),
    );

    vi.setSystemTime(startedAt + 21_000);
    const created = await call(environments, {
      method: "POST",
      headers: { ...f.orgHeaders, "idempotency-key": "fair-new-environment" },
      body: JSON.stringify({
        name: "fair newer environment",
        regionId: f.regionId,
        catalogVersion: "accounting-v1",
        profileId: "accounting-fixture",
        volumeGiB: 8,
      }),
    });
    expect(created.status).toBe(202);
    const newer = (await created.json()) as { environment: { id: string } };
    await ready(newer.environment.id, "55555555-5555-4555-8555-555555555555");
    const deletion = await call(`${environments}/${newer.environment.id}`, {
      method: "DELETE",
      headers: { ...f.orgHeaders, "idempotency-key": "fair-new-deletion" },
      body: JSON.stringify({
        expectedRevision: 0,
        volumePolicy: "delete",
        backupPolicy: "retain",
      }),
    });
    expect(deletion.status).toBe(202);
    const deleting = (await deletion.json()) as {
      operation: { id: string };
      stopOperation: { id: string };
    };

    vi.setSystemTime(Date.parse(renewed.leaseExpiresAt) + 1_000);
    const waiting = await claim();
    expect(waiting.operationId).toBe(deleting.stopOperation.id);
    expect(waiting.leaseEpoch).toBe(1);
    vi.setSystemTime(Date.now() + 1_000);
    const reclaimed = await claim();
    expect(reclaimed.operationId).toBe(older.operation.id);
    expect(reclaimed.leaseEpoch).toBe(original.leaseEpoch + 1);
    expect(
      (
        await post(`${lane}/${original.operationId}/renew`, {
          leaseToken: original.leaseToken,
          leaseEpoch: original.leaseEpoch,
          leaseSeconds: 90,
        })
      ).status,
    ).toBe(409);

    // With both deferred leases expired, the least recently attempted stop wins.
    vi.setSystemTime(Date.parse(reclaimed.leaseExpiresAt) + 1_000);
    const rotated = await claim();
    expect(rotated.operationId).toBe(deleting.stopOperation.id);
    expect(rotated.leaseEpoch).toBe(waiting.leaseEpoch + 1);
    for (const environmentId of [f.environmentId, newer.environment.id]) {
      expect(
        await (
          await call(`${environments}/${environmentId}/runtime`, {
            headers: f.orgHeaders,
          })
        ).json(),
      ).toMatchObject({
        runtime: { desiredState: "suspended", phase: "suspending" },
      });
    }
    expect(
      await (
        await call(`${environments}/${newer.environment.id}/lifecycle`, {
          headers: f.orgHeaders,
        })
      ).json(),
    ).toMatchObject({
      lifecycle: { phase: "stopping", physicalDeletionVerified: false },
      operation: { id: deleting.operation.id, status: "queued" },
      stopOperation: { status: "running", resultCode: null },
    });
  } finally {
    vi.useRealTimers();
  }
});
