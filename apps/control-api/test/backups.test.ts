// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
  accountingCall as call,
  accountingFixture,
  installerHeaders,
} from "./accounting-fixture";

it("retains one scoped manual base-backup intent and dispatch checkpoint across uncertain leases, exposes only operator artifact evidence, and interlocks normal suspend", async () => {
  const f = await accountingFixture("manual backup");
  const initial = await call(`/v1/regions/${f.regionId}/operations/claim`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({ leaseSeconds: 90 }),
  });
  const creation = (
    (await initial.json()) as {
      claim: { operationId: string; leaseToken: string; leaseEpoch: number };
    }
  ).claim;
  const clusterUid = "33333333-3333-4333-8333-333333333333";
  expect(
    (
      await call(
        `/v1/regions/${f.regionId}/operations/${creation.operationId}/result`,
        {
          method: "POST",
          headers: f.regionHeaders,
          body: JSON.stringify({
            leaseToken: creation.leaseToken,
            leaseEpoch: creation.leaseEpoch,
            status: "ready",
            resultCode: "cnpg_ready",
            observation: {
              clusterUid,
              clusterGeneration: 1,
              readyInstances: 1,
            },
          }),
        },
      )
    ).status,
  ).toBe(200);
  const environment = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments/${f.environmentId}`;
  const base = `${environment}/backups`;
  const create = () =>
    call(base, {
      method: "POST",
      headers: { ...f.orgHeaders, "idempotency-key": "one-base-backup" },
      body: "{}",
    });
  const accepted = await create();
  expect(accepted.status).toBe(202);
  const requested = (await accepted.json()) as {
    backup: { id: string; status: string };
    operation: { id: string };
  };
  expect(requested.backup.status).toBe("pending");
  expect(await (await create()).json()).toEqual(requested);
  expect(JSON.stringify(requested)).not.toMatch(
    /credentialSecret|endpointURL|destinationPath|password/,
  );
  expect(
    (
      await call(`${environment}/suspend`, {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "backup-interlock" },
        body: JSON.stringify({ expectedRevision: 0 }),
      })
    ).status,
  ).toBe(409);
  const lane = `/v1/regions/${f.regionId}/backup-operations`;
  const claimed = await call(`${lane}/claim`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({ leaseSeconds: 90 }),
  });
  expect(claimed.status).toBe(200);
  const first = (
    (await claimed.json()) as {
      claim: {
        operationId: string;
        backupId: string;
        leaseToken: string;
        leaseEpoch: number;
        specHash: string;
        dispatch: unknown;
      };
    }
  ).claim;
  expect(first.backupId).toBe(requested.backup.id);
  expect(first.dispatch).toBeNull();
  const spec = {
    cluster: { name: "database" },
    method: "plugin",
    pluginConfiguration: { name: "barman-cloud.cloudnative-pg.io" },
    target: "primary",
  };
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(spec)),
  );
  const backupSpecHash = Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  const binding = {
    namespaceUid: "44444444-4444-4444-8444-444444444444",
    clusterUid,
    specHash: first.specHash,
    objectStoreUid: "55555555-5555-4555-8555-555555555555",
    objectStoreGeneration: 1,
    objectStoreSpecHash: "a".repeat(64),
    backupName: `backup-${first.backupId.replaceAll("-", "")}`,
    backupSpecHash,
  };
  const dispatchInput = {
    leaseToken: first.leaseToken,
    leaseEpoch: first.leaseEpoch,
    nonce: "66666666-6666-4666-8666-666666666666",
    binding,
  };
  const checkpoint = await call(`${lane}/${first.operationId}/dispatch`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify(dispatchInput),
  });
  expect(checkpoint.status).toBe(200);
  expect((await checkpoint.json()) as object).toMatchObject({
    created: true,
    dispatch: {
      nonce: dispatchInput.nonce,
      leaseEpoch: first.leaseEpoch,
      binding,
    },
  });
  const repeated = await call(`${lane}/${first.operationId}/dispatch`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify(dispatchInput),
  });
  expect((await repeated.json()) as object).toMatchObject({ created: false });
  await env.DB.prepare(
    "UPDATE backup_operations SET lease_expires_at = ? WHERE id = ?",
  )
    .bind(new Date(Date.now() - 1000).toISOString(), first.operationId)
    .run();
  expect(
    (
      await call(`${environment}/suspend`, {
        method: "POST",
        headers: {
          ...f.orgHeaders,
          "idempotency-key": "expired-backup-interlock",
        },
        body: JSON.stringify({ expectedRevision: 0 }),
      })
    ).status,
  ).toBe(409);
  const reclaimed = await call(`${lane}/claim`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify({ leaseSeconds: 90 }),
  });
  const current = ((await reclaimed.json()) as { claim: typeof first }).claim;
  expect(current.leaseEpoch).toBe(first.leaseEpoch + 1);
  expect(current.dispatch).toMatchObject({
    nonce: dispatchInput.nonce,
    leaseEpoch: first.leaseEpoch,
    binding,
  });
  expect(
    (
      await call(`${lane}/${first.operationId}/dispatch`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          ...dispatchInput,
          leaseToken: current.leaseToken,
          leaseEpoch: current.leaseEpoch,
          nonce: "77777777-7777-4777-8777-777777777777",
        }),
      })
    ).status,
  ).toBe(409);
  const artifact = {
    backupId: "20260929T160000",
    backupName: "backup-20260929T160000",
    majorVersion: 18,
    startedAt: "2026-09-29T16:00:00Z",
    stoppedAt: "2026-09-29T16:00:04Z",
    beginWal: "000000010000000000000001",
    endWal: "000000010000000000000002",
    beginLSN: "0/1000028",
    endLSN: "0/2000050",
    online: true,
    pluginMetadata: {
      timeline: "1",
      version: "0.15.0",
      name: "barman-cloud.cloudnative-pg.io",
      displayName: "BarmanCloudInstance",
      clusterUID: clusterUid,
      pluginName: "barman-cloud.cloudnative-pg.io",
    },
  };
  const observation = {
    namespaceUid: binding.namespaceUid,
    clusterUid,
    objectStoreUid: binding.objectStoreUid,
    objectStoreGeneration: 1,
    objectStoreSpecHash: binding.objectStoreSpecHash,
    backupResourceUid: "88888888-8888-4888-8888-888888888888",
    backupResourceVersion: "20",
    backupSpecHash,
    phase: "completed",
    artifact,
    remoteObjectsVerified: false,
    restoreVerified: false,
  };
  const resultInput = {
    leaseToken: current.leaseToken,
    leaseEpoch: current.leaseEpoch,
    status: "completed",
    resultCode: "base_backup_completed",
    observation,
  };
  // A requested budget pause denies every new effect/renewal, but an existing
  // unexpired winning lease can retain terminal evidence without new authority.
  const issued = await call(
    `/v1/organizations/${f.organizationId}/budget-tokens/reissue`,
    { method: "POST", headers: installerHeaders },
  );
  const budgetToken = ((await issued.json()) as { apiToken: string }).apiToken;
  const budgetHeaders = {
    authorization: `Bearer ${budgetToken}`,
    "content-type": "application/json",
  };
  const budgetPath = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/budget`;
  const now = Date.now();
  expect(
    (
      await call(budgetPath, {
        method: "PUT",
        headers: budgetHeaders,
        body: JSON.stringify({
          expectedRevision: "0",
          period: {
            start: new Date(now - 60_000).toISOString(),
            end: new Date(now + 3_600_000).toISOString(),
          },
          granted: { cpu_millicore_ms: "100000" },
        }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(`${budgetPath}/pause`, {
        method: "POST",
        headers: budgetHeaders,
        body: JSON.stringify({ expectedRevision: "1" }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(`${lane}/${first.operationId}/renew`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          leaseToken: current.leaseToken,
          leaseEpoch: current.leaseEpoch,
          leaseSeconds: 90,
        }),
      })
    ).status,
  ).toBe(409);
  const completed = await call(`${lane}/${first.operationId}/result`, {
    method: "POST",
    headers: f.regionHeaders,
    body: JSON.stringify(resultInput),
  });
  expect(completed.status).toBe(200);
  expect(
    await (
      await call(`${lane}/${first.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify(resultInput),
      })
    ).json(),
  ).toEqual(await completed.json());
  const read = await call(`${base}/${requested.backup.id}`, {
    headers: f.orgHeaders,
  });
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(await read.json()).toMatchObject({
    backup: {
      status: "completed",
      remoteObjectsVerified: false,
      restoreVerified: false,
      PITRVerified: false,
      artifact: {
        backupId: artifact.backupId,
        startedAt: "2026-09-29T16:00:00.000Z",
      },
    },
  });
  const recovered = await call(
    `/v1/organizations/${f.organizationId}/operations/${requested.operation.id}`,
    { headers: f.orgHeaders },
  );
  expect(await recovered.json()).toMatchObject({
    operation: {
      backupId: requested.backup.id,
      kind: "environment.backup",
      status: "completed",
    },
  });
  expect(
    await (await call(base, { headers: f.orgHeaders })).json(),
  ).toMatchObject({
    backups: [
      {
        backup: { id: requested.backup.id },
        currentOperationId: requested.operation.id,
      },
    ],
    nextCursor: null,
  });
  const foreign = await accountingFixture("foreign backup");
  expect(
    (
      await call(`${base}/${requested.backup.id}`, {
        headers: foreign.orgHeaders,
      })
    ).status,
  ).toBe(404);
  expect(
    (await call(`${base}/${requested.backup.id}`, { headers: f.regionHeaders }))
      .status,
  ).toBe(401);
  expect(
    (
      await call(`${budgetPath}/resume`, {
        method: "POST",
        headers: budgetHeaders,
        body: JSON.stringify({ expectedRevision: "2" }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(`${environment}/suspend`, {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "after-backup" },
        body: JSON.stringify({ expectedRevision: 0 }),
      })
    ).status,
  ).toBe(202);
  expect(
    (
      await call(base, {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "while-suspending" },
        body: "{}",
      })
    ).status,
  ).toBe(409);
});
