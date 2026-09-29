// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import { accountingFixture } from "./accounting-fixture";

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
        active: "test-deletion-v1",
        keys: {
          "test-deletion-v1": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      }),
    } as typeof env,
  );
}

it("atomically retains an owned deletion intention and its real suspend child, fences new work, and recovers pending deletion without erasing history", async () => {
  const f = await accountingFixture("environment deletion");
  const base = `/v1/organizations/${f.organizationId}/projects/${f.projectId}/environments/${f.environmentId}`;
  const deletionInput = {
    expectedRevision: 0,
    volumePolicy: "delete",
    backupPolicy: "retain",
  };
  const remove = (input = deletionInput) =>
    call(base, {
      method: "DELETE",
      headers: { ...f.orgHeaders, "idempotency-key": "owned-deletion" },
      body: JSON.stringify(input),
    });
  // Pending provisioning must not be relabeled as disposable ready compute.
  expect((await remove()).status).toBe(409);
  const creationLane = `/v1/regions/${f.regionId}/operations`;
  const creation = (
    (await (
      await call(`${creationLane}/claim`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({ leaseSeconds: 90 }),
      })
    ).json()) as {
      claim: { operationId: string; leaseToken: string; leaseEpoch: number };
    }
  ).claim;
  const clusterUid = "44444444-4444-4444-8444-444444444444";
  expect(
    (
      await call(`${creationLane}/${creation.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          leaseToken: creation.leaseToken,
          leaseEpoch: creation.leaseEpoch,
          status: "ready",
          resultCode: "cnpg_ready",
          observation: { clusterUid, clusterGeneration: 1, readyInstances: 1 },
        }),
      })
    ).status,
  ).toBe(200);
  const roleResponse = await call(`${base}/roles`, {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "deletion-owner" },
    body: JSON.stringify({ name: "deletionowner", connectionLimit: 20 }),
  });
  expect(roleResponse.status).toBe(202);
  const role = ((await roleResponse.json()) as { role: { id: string } }).role;
  // A queued role task remains an interlock, including an uncertain lease.
  expect((await remove()).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM environment_deletions",
    ).first(),
  ).toEqual({ n: 0 });
  const roleLane = `/v1/regions/${f.regionId}/role-operations`;
  const roleClaim = (
    (await (
      await call(`${roleLane}/claim`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({ leaseSeconds: 90 }),
      })
    ).json()) as {
      claim: { operationId: string; leaseToken: string; leaseEpoch: number };
    }
  ).claim;
  expect(
    (
      await call(`${roleLane}/${roleClaim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          leaseToken: roleClaim.leaseToken,
          leaseEpoch: roleClaim.leaseEpoch,
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
            authenticatedUser: "deletionowner",
            authenticatedDatabase: "app",
            writablePrimary: true,
            previousCredentialRejected: null,
          },
        }),
      })
    ).status,
  ).toBe(200);
  const ciphertextBefore = await env.DB.prepare(
    "SELECT encrypted_json FROM role_credentials WHERE role_id=?",
  )
    .bind(role.id)
    .first();
  const accepted = await remove();
  expect(accepted.status).toBe(202);
  const intent = (await accepted.json()) as {
    deletion: { operationId: string; stopOperationId: string };
    operation: { id: string; kind: string; status: string };
    stopOperation: { id: string; kind: string; status: string };
    runtime: { revision: number; phase: string };
  };
  expect(intent).toMatchObject({
    deletion: {
      desiredState: "deleted",
      phase: "stopping",
      volumePolicy: "delete",
      backupPolicy: "retain",
      physicalDeletionVerified: false,
    },
    operation: { kind: "environment.delete", status: "queued" },
    stopOperation: { kind: "environment.suspend", status: "queued" },
    runtime: { revision: 1, desiredState: "suspended", phase: "suspending" },
  });
  expect(intent.deletion.operationId).toBe(intent.operation.id);
  expect(intent.deletion.stopOperationId).toBe(intent.stopOperation.id);
  expect(await (await remove()).json()).toEqual(intent);
  const creationReplay = await call(base.slice(0, base.lastIndexOf("/")), {
    method: "POST",
    headers: { ...f.orgHeaders, "idempotency-key": "accounting-environment" },
    body: JSON.stringify({
      name: "environment deletion environment",
      regionId: f.regionId,
      catalogVersion: "accounting-v1",
      profileId: "accounting-fixture",
      volumeGiB: 8,
    }),
  });
  expect(creationReplay.status).toBe(202);
  expect(await creationReplay.json()).toMatchObject({
    environment: { lifecycle: intent.deletion },
    operation: { id: creation.operationId },
  });
  expect((await remove({ ...deletionInput, expectedRevision: 1 })).status).toBe(
    409,
  );
  expect(
    (
      await call(`${base}/suspend`, {
        method: "POST",
        headers: {
          ...f.orgHeaders,
          "idempotency-key": "ordinary-stop-after-delete",
        },
        body: JSON.stringify({ expectedRevision: 1 }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(`${base}/roles/${role.id}/credentials`, {
        headers: f.orgHeaders,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(`${base}/roles/${role.id}/rotate`, {
        method: "POST",
        headers: {
          ...f.orgHeaders,
          "idempotency-key": "deleted-role-rotation",
        },
        body: JSON.stringify({ expectedCredentialRevision: 1 }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(`${base}/backups`, {
        method: "POST",
        headers: { ...f.orgHeaders, "idempotency-key": "deleted-backup" },
        body: "{}",
      })
    ).status,
  ).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT encrypted_json FROM role_credentials WHERE role_id=?",
    )
      .bind(role.id)
      .first(),
  ).toEqual(ciphertextBefore);
  const lifecycle = await call(`${base}/lifecycle`, { headers: f.orgHeaders });
  expect(lifecycle.status).toBe(200);
  expect(await lifecycle.json()).toMatchObject({ lifecycle: intent.deletion });
  expect(
    await (await call(base, { headers: f.orgHeaders })).json(),
  ).toMatchObject({
    environment: { status: "ready", lifecycle: intent.deletion },
  });
  expect(
    await (
      await call(base.slice(0, base.lastIndexOf("/")), {
        headers: f.orgHeaders,
      })
    ).json(),
  ).toMatchObject({
    environments: [
      {
        environment: { lifecycle: intent.deletion },
        currentOperationId: intent.operation.id,
      },
    ],
  });
  const stopLane = `/v1/regions/${f.regionId}/suspend-operations`;
  const stopClaim = (
    (await (
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
      };
    }
  ).claim;
  expect(stopClaim).toMatchObject({
    operationId: intent.stopOperation.id,
    runtimeRevision: 1,
  });
  expect(
    (
      await call(`${stopLane}/${stopClaim.operationId}/renew`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          leaseToken: stopClaim.leaseToken,
          leaseEpoch: stopClaim.leaseEpoch,
          leaseSeconds: 90,
        }),
      })
    ).status,
  ).toBe(200);
  // Protocol fixture acknowledgement is never promoted to deletion proof.
  expect(
    (
      await call(`${stopLane}/${stopClaim.operationId}/result`, {
        method: "POST",
        headers: f.regionHeaders,
        body: JSON.stringify({
          leaseToken: stopClaim.leaseToken,
          leaseEpoch: stopClaim.leaseEpoch,
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
        }),
      })
    ).status,
  ).toBe(200);
  expect(
    await (await call(`${base}/lifecycle`, { headers: f.orgHeaders })).json(),
  ).toMatchObject({
    lifecycle: {
      ...intent.deletion,
      phase: "pending_physical_deletion",
      physicalDeletionVerified: false,
    },
    operation: { status: "queued" },
    stopOperation: { status: "succeeded" },
  });
  expect(await (await remove()).json()).toEqual(intent);
  expect(
    await (
      await call(
        `/v1/organizations/${f.organizationId}/operations/${intent.operation.id}`,
        { headers: f.orgHeaders },
      )
    ).json(),
  ).toMatchObject({
    operation: { kind: "environment.delete", status: "queued" },
  });
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM environments WHERE id=?")
      .bind(f.environmentId)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM environment_deletions WHERE environment_id=?",
    )
      .bind(f.environmentId)
      .first(),
  ).toEqual({ n: 1 });
  expect(JSON.stringify(intent)).not.toMatch(
    /credentialSecret|endpointURL|destinationPath|encrypted_json|password|leaseToken/,
  );
  expect(
    (await call(`${base}/lifecycle`, { headers: f.regionHeaders })).status,
  ).toBe(401);
});
