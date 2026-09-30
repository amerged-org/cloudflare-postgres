import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  provisioningAllowanceUnits,
  provisioningResourceEnvelope,
} from "@cloudflare-postgres/resource-envelope";
import { runController } from "../src/run.ts";
import { ProvisioningFundingJournal } from "../src/provisioning-funding.ts";

test("provisioning retains one funding hold across ambiguity and refuses expired effects and readiness", async () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "pgcf-provisioning-funding-")),
  );
  const environmentId = "11111111-1111-4111-8111-111111111111";
  const regionId = "22222222-2222-4222-8222-222222222222";
  const operationId = "33333333-3333-4333-8333-333333333333";
  const spec = {
    name: "ordinary",
    regionId,
    catalogVersion: "test-v1",
    profileId: "small",
    volumeGiB: 5,
    profile: {
      id: "small",
      postgresImage: `example.invalid/postgres@sha256:${"a".repeat(64)}`,
      compute: { cpuMilli: 100, memoryMiB: 128 },
      storage: {
        classId: "local",
        storageClassName: "pgcf-lvm",
        minGiB: 5,
        maxGiB: 50,
        stepGiB: 5,
      },
      instances: 1,
      backup: {
        endpointURL: "https://archive.example.invalid",
        region: "auto",
        destinationPath: "s3://test-backups",
        retentionPolicy: "7d",
        credentialSecret: {
          namespace: "platform",
          name: "backups",
          accessKeyIdKey: "access",
          secretAccessKeyKey: "secret",
        },
      },
    },
  };
  const claim = {
    operationId,
    environmentId,
    regionId,
    kind: "environment.create",
    leaseToken: "opaque-test-only",
    leaseEpoch: 1,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    specRevision: 1,
    specHash: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    spec,
  };
  const config = {
    operatorNamespace: "cnpg-system",
    operatorPodLabels: { "app.kubernetes.io/name": "cloudnative-pg" },
    allowedBackupSecrets: [spec.profile.backup.credentialSecret],
  };
  const effects = [];
  let published = 0;
  let holds = 0;
  let now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;
  let committedFunding;
  const requests = [];
  async function once(currentClaim, funding, authority, api) {
    const shutdown = new AbortController();
    let claimed = false;
    const client = {
      async claim() {
        if (claimed) return null;
        claimed = true;
        return currentClaim;
      },
      async renew() {
        throw new Error("must_not_renew");
      },
      async funding(input, seconds) {
        requests.push({
          operationId: input.operationId,
          fundingSeconds: seconds,
        });
        return funding(input, seconds);
      },
      authority,
      async result() {
        published += 1;
        shutdown.abort();
      },
    };
    await runController(api, client, config, {
      leaseSeconds: 90,
      pollMilliseconds: 1,
      readinessMilliseconds: 30_000,
      provisioningJournalDirectory: directory,
      signal: shutdown.signal,
      log(event) {
        if (["operation_deferred", "readiness_deferred"].includes(event))
          shutdown.abort();
      },
    });
  }
  const noEffectsApi = {
    async read() {
      return null;
    },
    async create(resource) {
      effects.push(resource.kind);
      throw new Error("must_not_create");
    },
    async readSecret() {
      throw new Error("must_not_read_credentials");
    },
    async listPods() {
      return [];
    },
  };
  const unreachableAuthority = async () => {
    throw new Error("must_not_observe_authority");
  };
  try {
    await once(
      claim,
      async () => {
        throw new Error("funding_service_unavailable");
      },
      unreachableAuthority,
      noEffectsApi,
    );
    assert.deepEqual(
      effects,
      [],
      "unavailable funding must prevent the first Namespace effect",
    );
    const requestDb = new DatabaseSync(
      join(directory, `${operationId}.sqlite`),
      { readOnly: true },
    );
    const request = JSON.parse(
      requestDb
        .prepare(
          "SELECT payload_json FROM provisioning_funding_state WHERE name='request'",
        )
        .get().payload_json,
    );
    requestDb.close();
    assert.deepEqual(
      request,
      { requestId: operationId, fundingSeconds: 300 },
      "the fixed horizon is durable before the failed HTTP request",
    );
    const replay = { ...claim, leaseEpoch: 2, leaseToken: "replacement-lease" };
    const envelopeInput = { ...spec.profile, volumeGiB: spec.volumeGiB };
    const rates = provisioningResourceEnvelope(envelopeInput).rates;
    const units = provisioningAllowanceUnits(envelopeInput, 300);
    await once(
      replay,
      async () => {
        holds += 1;
        committedFunding = {
          version: 1,
          envelopeVersion: 1,
          operationId,
          organizationId: "44444444-4444-4444-8444-444444444444",
          projectId: "55555555-5555-4555-8555-555555555555",
          environmentId,
          regionId,
          specRevision: 1,
          specHash: claim.specHash,
          runEpoch: null,
          fundingSeconds: 300,
          rates,
          units,
          reservation: {
            id: "66666666-6666-4666-8666-666666666666",
            environmentId,
            regionId,
            specRevision: 1,
            specHash: claim.specHash,
            epoch: "0",
            revision: "0",
            units,
            issuedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 300_000).toISOString(),
            status: "issued",
            gapCount: "0",
            stoppedAt: null,
            fenceToken: `cprsv_${"x".repeat(43)}`,
            runtimeEnforced: false,
            enforcementStatus: "pending_runtime",
          },
        };
        throw new Error("connection_lost_after_durable_server_reservation");
      },
      unreachableAuthority,
      noEffectsApi,
    );
    assert.equal(holds, 1);
    assert.equal(published, 0);
    assert.deepEqual(
      effects,
      [],
      "a lost committed funding response permits no Kubernetes effect",
    );
    const thirdClaim = { ...claim, leaseEpoch: 3, leaseToken: "third-lease" };
    const resources = new Map();
    let readyReadback = false;
    let readyAuthorityChecks = 0;
    let authorityCalls = 0;
    const fundedApi = {
      async read(kind, ns, name) {
        const value = resources.get(`${kind}:${ns}:${name}`) ?? null;
        if (kind === "Cluster" && value) readyReadback = true;
        return structuredClone(value);
      },
      async create(resource, dispatchAuthority) {
        assert.equal(typeof dispatchAuthority?.check, "function");
        dispatchAuthority.check();
        assert.ok(dispatchAuthority.expiresAt() > now);
        const durable = new ProvisioningFundingJournal(directory, thirdClaim);
        assert.deepEqual(
          durable.funding,
          committedFunding,
          "receipt and server ownership are durable before every effect",
        );
        assert.equal(durable.authority?.decision, "allow");
        durable.close();
        assert.ok(now < Date.parse(committedFunding.reservation.expiresAt));
        effects.push(resource.kind);
        const value = structuredClone(resource);
        value.metadata.uid = operationId;
        value.metadata.generation = 1;
        if (resource.kind === "Cluster")
          value.status = {
            readyInstances: 1,
            currentPrimary: "database-1",
            conditions: [
              { type: "Ready", status: "True", observedGeneration: 1 },
            ],
          };
        resources.set(
          `${resource.kind}:${resource.metadata.namespace ?? ""}:${resource.metadata.name}`,
          value,
        );
        return structuredClone(value);
      },
      async readSecret() {
        return { access: "ZmFrZQ==", secret: "ZmFrZQ==" };
      },
      async listPods() {
        return [
          {
            metadata: {
              name: "database-1",
              uid: "77777777-7777-4777-8777-777777777777",
              labels: { "cnpg.io/podRole": "instance" },
              ownerReferences: [
                { kind: "Cluster", uid: operationId, controller: true },
              ],
            },
            status: {
              phase: "Running",
              conditions: [{ type: "Ready", status: "True" }],
            },
          },
        ];
      },
    };
    await once(
      thirdClaim,
      async () => committedFunding,
      async (id) => {
        assert.equal(id, committedFunding.reservation.id);
        authorityCalls += 1;
        if (readyReadback) {
          readyAuthorityChecks += 1;
          now = Date.parse(committedFunding.reservation.expiresAt) + 1;
        }
        return {
          schemaVersion: 1,
          reservationId: id,
          environmentId,
          regionId,
          projectId: committedFunding.projectId,
          specRevision: 1,
          specHash: claim.specHash,
          epoch: "0",
          decision: readyReadback ? "stop" : "allow",
          reason: readyReadback ? "reservation_expired" : "authorized",
          observedAt: new Date(now).toISOString(),
          validUntil: new Date(
            now + (readyReadback ? 0 : 15_000),
          ).toISOString(),
          units,
          limitedMetrics: [],
          bindings: [],
          evidenceHash: "b".repeat(64),
          runtimeEnforced: false,
          enforcementStatus: "pending_runtime",
        };
      },
      fundedApi,
    );
    assert.equal(
      readyAuthorityChecks,
      1,
      "fresh funding must be checked after actual ready reconciliation",
    );
    assert.ok(
      authorityCalls >= effects.length + 3,
      "every create and readiness has a fresh authority observation",
    );
    assert.ok(
      effects.includes("Namespace") &&
        effects.includes("ResourceQuota") &&
        effects.includes("Cluster"),
    );
    assert.equal(
      published,
      0,
      "expiry between ready readback and publication cannot publish readiness",
    );
    const before = [...effects];
    await once(
      { ...claim, leaseEpoch: 4 },
      async () => {
        throw new Error("must_not_replace_expired_hold");
      },
      unreachableAuthority,
      noEffectsApi,
    );
    assert.deepEqual(
      effects,
      before,
      "expired durable custody prevents all further Kubernetes effects on reclaim",
    );
    assert.equal(holds, 1);
    assert.equal(published, 0);
    assert.equal(requests.length, 3);
    assert.ok(
      requests.every(
        (v) => v.operationId === operationId && v.fundingSeconds === 300,
      ),
    );
    const reopened = new ProvisioningFundingJournal(directory, {
      ...claim,
      leaseEpoch: 4,
    });
    assert.deepEqual(reopened.funding, committedFunding);
    assert.equal(reopened.authority?.decision, "stop");
    reopened.close();
    assert.equal(
      lstatSync(join(directory, `${operationId}.sqlite`)).mode & 0o777,
      0o600,
    );
  } finally {
    Date.now = originalNow;
    rmSync(directory, { recursive: true, force: true });
  }
});
