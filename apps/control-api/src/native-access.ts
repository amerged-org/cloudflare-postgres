// SPDX-License-Identifier: Apache-2.0
import {
  error,
  fields,
  json,
  sha256,
  timestamp,
  type AccountingDb,
} from "./accounting";
import {
  actorBindings,
  actorPredicate,
  authorize,
  integer,
  rv,
  uid,
} from "./execution-auth";
import { environmentRunning } from "./environment-runtime";
import {
  validEnvironmentObservation,
  type EnvironmentRow,
} from "./environments";

export interface NativeAccessPolicy {
  version: 1;
  clientProfileId: string;
}
export interface NativeConnectionObservation {
  version: 1;
  visibility: "private";
  mode: "direct";
  clientProfileId: string;
  namespaceUid: string;
  clusterUid: string;
  clusterGeneration: number;
  specHash: string;
  serviceUid: string;
  serviceResourceVersion: string;
  primaryPodUid: string;
  endpointSliceUid: string;
  policyUid: string;
  host: string;
  port: 5432;
  caCertificate: string;
  caCertificateSha256: string;
  serverCertificateSha256: string;
  caValidFrom: string;
  caValidUntil: string;
  serverValidUntil: string;
  observedAt: string;
}
const hash = /^[a-f0-9]{64}$/;
export function validNativeAccess(value: unknown): value is NativeAccessPolicy {
  return (
    fields(value, ["version", "clientProfileId"]) &&
    value.version === 1 &&
    typeof value.clientProfileId === "string" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(value.clientProfileId)
  );
}
// The trusted regional executor parses and verifies the X509 chain. This
// boundary accepts exactly one bounded public PEM with canonical base64 only;
// it does not turn reported validity or hashes into independent chain proof.
function publicCertificate(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  const match =
    /^-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/=\n]+)\n-----END CERTIFICATE-----\n?$/.exec(
      value,
    );
  if (!match) return false;
  const encoded = match[1]!.replaceAll("\n", "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    return false;
  try {
    const der = atob(encoded);
    return der.length >= 128 && btoa(der) === encoded;
  } catch {
    return false;
  }
}
export function validNativeConnection(
  value: unknown,
): value is NativeConnectionObservation {
  if (
    !fields(value, [
      "version",
      "visibility",
      "mode",
      "clientProfileId",
      "namespaceUid",
      "clusterUid",
      "clusterGeneration",
      "specHash",
      "serviceUid",
      "serviceResourceVersion",
      "primaryPodUid",
      "endpointSliceUid",
      "policyUid",
      "host",
      "port",
      "caCertificate",
      "caCertificateSha256",
      "serverCertificateSha256",
      "caValidFrom",
      "caValidUntil",
      "serverValidUntil",
      "observedAt",
    ]) ||
    value.version !== 1 ||
    value.visibility !== "private" ||
    value.mode !== "direct" ||
    !validNativeAccess({
      version: 1,
      clientProfileId: value.clientProfileId,
    }) ||
    ![
      value.namespaceUid,
      value.clusterUid,
      value.serviceUid,
      value.primaryPodUid,
      value.endpointSliceUid,
      value.policyUid,
    ].every(uid) ||
    !integer(value.clusterGeneration) ||
    !rv(value.serviceResourceVersion) ||
    typeof value.specHash !== "string" ||
    !hash.test(value.specHash) ||
    typeof value.host !== "string" ||
    !/^database-rw\.pgcf-[a-f0-9]{32}\.svc$/.test(value.host) ||
    value.port !== 5432 ||
    !publicCertificate(value.caCertificate) ||
    typeof value.caCertificateSha256 !== "string" ||
    !hash.test(value.caCertificateSha256) ||
    typeof value.serverCertificateSha256 !== "string" ||
    !hash.test(value.serverCertificateSha256)
  )
    return false;
  const observed = timestamp(value.observedAt),
    from = timestamp(value.caValidFrom),
    until = timestamp(value.caValidUntil),
    serverUntil = timestamp(value.serverValidUntil);
  return (
    observed !== null &&
    from !== null &&
    until !== null &&
    serverUntil !== null &&
    from <= observed &&
    observed < until &&
    observed < serverUntil
  );
}
export function boundNativeConnection(
  value: unknown,
  environment: EnvironmentRow,
  profile: { nativeAccess?: NativeAccessPolicy },
  observed: { clusterUid: string; clusterGeneration: number },
): value is NativeConnectionObservation {
  return (
    validNativeConnection(value) &&
    validNativeAccess(profile.nativeAccess) &&
    value.clientProfileId === profile.nativeAccess.clientProfileId &&
    value.specHash === environment.spec_hash &&
    value.clusterUid === observed.clusterUid &&
    value.clusterGeneration === observed.clusterGeneration &&
    value.host === `database-rw.pgcf-${environment.id.replaceAll("-", "")}.svc`
  );
}
export async function readNativeConnection(
  request: Request,
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId: string,
): Promise<Response> {
  const actor = await authorize(
    request,
    db,
    "organization",
    organizationId,
    "projects:read",
  );
  if (actor instanceof Response) return actor;
  if (new URL(request.url).search) return error(400, "invalid_request");
  // One primary batch rechecks the actor and reads ownership/runtime/budget
  // authority. The stored proof remains a provisioning observation, not a
  // synchronous regional health lookup or permission to create resources.
  const result = await db.batch([
    db
      .prepare(`SELECT 1 AS authorized WHERE ${actorPredicate(actor)}`)
      .bind(...actorBindings(actor)),
    db
      .prepare(
        `SELECT e.id FROM environments e WHERE e.id = ? AND e.organization_id = ? AND e.project_id = ? AND ${actorPredicate(actor)}`,
      )
      .bind(environmentId, organizationId, projectId, ...actorBindings(actor)),
    db
      .prepare(
        `SELECT e.* FROM environments e JOIN projects p ON p.id = e.project_id AND p.organization_id = e.organization_id JOIN regions r ON r.id = e.region_id WHERE e.id = ? AND e.organization_id = ? AND e.project_id = ? AND p.status = 'active' AND r.status <> 'disabled' AND ${environmentRunning("e")} AND NOT EXISTS (SELECT 1 FROM budget_targets b WHERE b.organization_id = e.organization_id AND b.project_id = e.project_id AND (b.environment_id IS NULL OR b.environment_id = e.id) AND b.requested_state <> 'running') AND ${actorPredicate(actor)}`,
      )
      .bind(environmentId, organizationId, projectId, ...actorBindings(actor)),
  ]);
  if (!result[0]?.results.length) return error(401, "unauthorized");
  if (!result[1]?.results.length) return error(404, "not_found");
  const row = result[2]?.results[0] as unknown as EnvironmentRow | undefined;
  if (!row) return error(409, "native_connection_unavailable");
  try {
    const spec = JSON.parse(row.resolved_spec) as {
      profile: {
        nativeAccess?: NativeAccessPolicy;
        pooling?: unknown;
        nodeTracking?: unknown;
        instances: number;
      };
    };
    const observed = JSON.parse(row.observation_json ?? "null") as {
      clusterUid: string;
      clusterGeneration: number;
      nativeConnection?: unknown;
      runEpoch?: string;
    } | null;
    if (
      !validEnvironmentObservation(
        observed,
        spec.profile.pooling !== undefined,
        row.run_epoch ?? undefined,
        spec.profile.nodeTracking !== undefined,
        spec.profile.nativeAccess !== undefined,
      ) ||
      !integer(spec.profile.instances, 1, 9) ||
      observed.readyInstances < spec.profile.instances ||
      !boundNativeConnection(
        observed.nativeConnection,
        row,
        spec.profile,
        observed,
      )
    )
      return error(409, "native_connection_unavailable");
    const proof = observed.nativeConnection;
    if (
      Date.now() < Date.parse(proof.caValidFrom) ||
      Date.now() >= Date.parse(proof.caValidUntil) ||
      Date.now() < Date.parse(proof.observedAt) ||
      (await sha256(proof.caCertificate)) !== proof.caCertificateSha256
    )
      return error(409, "native_connection_unavailable");
    return json({
      connection: {
        ...proof,
        environmentId: row.id,
        specRevision: row.spec_revision,
        sslmode: "verify-full",
        observationScope: "provisioning",
      },
    });
  } catch {
    return error(409, "native_connection_unavailable");
  }
}
