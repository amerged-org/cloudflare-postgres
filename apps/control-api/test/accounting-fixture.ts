import { env } from "cloudflare:workers";
import { expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export function accountingCall(
  path: string,
  init: RequestInit<IncomingRequestCfProperties> = {},
) {
  return worker.fetch(
    new IncomingRequest(`https://control.example.test${path}`, init),
    env,
  );
}

export const installerHeaders = {
  authorization: "Bearer test-installation-token",
  "content-type": "application/json",
};

export async function accountingFixture(label: string) {
  const organizationResponse = await accountingCall("/v1/organizations", {
    method: "POST",
    headers: installerHeaders,
    body: JSON.stringify({ name: `${label} organization` }),
  });
  expect(organizationResponse.status).toBe(201);
  const organization = (await organizationResponse.json()) as {
    organization: { id: string };
    apiToken: string;
  };
  const orgHeaders = {
    authorization: `Bearer ${organization.apiToken}`,
    "content-type": "application/json",
  };
  const regionResponse = await accountingCall("/v1/regions", {
    method: "POST",
    headers: installerHeaders,
    body: JSON.stringify({ name: `${label} region` }),
  });
  expect(regionResponse.status).toBe(201);
  const region = (await regionResponse.json()) as {
    region: { id: string };
    apiToken: string;
  };
  const projectResponse = await accountingCall(
    `/v1/organizations/${organization.organization.id}/projects`,
    {
      method: "POST",
      headers: { ...orgHeaders, "idempotency-key": "accounting-project" },
      body: JSON.stringify({ name: `${label} project` }),
    },
  );
  expect(projectResponse.status).toBe(201);
  const project = (await projectResponse.json()) as { project: { id: string } };
  const profile = {
    id: "accounting-fixture",
    postgresImage: `ghcr.io/cloudnative-pg/postgresql@sha256:${"a".repeat(64)}`,
    compute: { cpuMilli: 500, memoryMiB: 512 },
    storage: {
      classId: "local-volume",
      storageClassName: "test-local",
      minGiB: 4,
      maxGiB: 64,
      stepGiB: 4,
    },
    instances: 1,
    backup: {
      region: "auto",
      endpointURL: "https://object-store.example.test",
      destinationPath: "s3://fixture-backups/accounting",
      retentionPolicy: "30d",
      credentialSecret: {
        namespace: "platform-secrets",
        name: "fixture-backup",
        accessKeyIdKey: "ACCESS_KEY_ID",
        secretAccessKeyKey: "SECRET_ACCESS_KEY",
      },
    },
  };
  const catalog = await accountingCall(
    `/v1/regions/${region.region.id}/catalogs`,
    {
      method: "POST",
      headers: installerHeaders,
      body: JSON.stringify({ version: "accounting-v1", profiles: [profile] }),
    },
  );
  expect(catalog.status).toBe(201);
  const admitted = await accountingCall(
    `/v1/regions/${region.region.id}/admission`,
    {
      method: "PUT",
      headers: installerHeaders,
      body: JSON.stringify({
        catalogVersion: "accounting-v1",
        acceptingNewEnvironments: true,
      }),
    },
  );
  expect(admitted.status).toBe(200);
  const environmentResponse = await accountingCall(
    `/v1/organizations/${organization.organization.id}/projects/${project.project.id}/environments`,
    {
      method: "POST",
      headers: { ...orgHeaders, "idempotency-key": "accounting-environment" },
      body: JSON.stringify({
        name: `${label} environment`,
        regionId: region.region.id,
        catalogVersion: "accounting-v1",
        profileId: profile.id,
        volumeGiB: 8,
      }),
    },
  );
  expect(environmentResponse.status).toBe(202);
  const environment = (await environmentResponse.json()) as {
    environment: { id: string };
  };
  return {
    organizationId: organization.organization.id,
    organizationToken: organization.apiToken,
    orgHeaders,
    projectId: project.project.id,
    environmentId: environment.environment.id,
    regionId: region.region.id,
    regionToken: region.apiToken,
    regionHeaders: {
      authorization: `Bearer ${region.apiToken}`,
      "content-type": "application/json",
    },
  };
}
