// SPDX-License-Identifier: Apache-2.0
import { z, type RouteConfig } from "@hono/zod-openapi";
import { ErrorBody, NodeId, OperationId, RegionId } from "@pgcf/contracts";
import {
  BootstrapCapability,
  NodeBootstrapAuthority,
  NodeBootstrapCallback,
  NodeBootstrapMaintenanceObservation,
  NodeBootstrapTransport,
  NodeBootstrapTransportBatch,
  RelayGrantCount,
} from "@pgcf/contracts/node-bootstrap";
import {
  BOOTSTRAP_RELAY_HEADER,
  BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH,
} from "@pgcf/contracts/bootstrap-relay";
import {
  NodeProofBinding,
  NodeProofControl,
  NodeProofMeasurement,
  NodeProofMode,
  NodeProofNonce,
  NodeProofReport,
} from "@pgcf/contracts/node-proof";
import { NodeThinStorageReport } from "@pgcf/contracts/node-thin-storage";
import {
  ThinQualificationCheckpoint,
  ThinQualificationReport,
  ThinQualificationStep,
} from "@pgcf/contracts/thin-qualification";
import {
  FleetPatchCheckpoint,
  FleetPatchStatus,
  FleetPostgresPatchProgress,
} from "@pgcf/contracts/fleet-patches";
import { ComputePoolObservation } from "@pgcf/contracts/compute-pool";
import { FleetRegionMaterialRotationCheckpoint } from "@pgcf/contracts/region-material-rotation";
import { NODE_OPERATOR_KUBERNETES_HEADERS } from "@pgcf/contracts/node-operator";
import type { ApiApp } from "./app.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative();
const transportCapability = z.enum(["talos_api", "kubernetes_api"]);
const fields = z.record(z.string(), z.unknown());
type Params = NonNullable<NonNullable<RouteConfig["request"]>["params"]>;

/** Agent auth is regional; handler reads and state fences determine the remaining refusals. */
export const agentRouteErrors: Readonly<Record<string, readonly number[]>> = {
  "POST /agent/v1/nodes/{id}/postgres-pool/preparations": [400, 401, 409, 500],
  "GET /agent/v1/nodes/{id}/postgres-pool/bindings": [400, 401, 409, 500],
  "POST /agent/v1/nodes/{id}/postgres-pool/inventory": [400, 401, 409, 500],
  "GET /agent/v1/pool-bindings/{id}": [400, 401, 404, 409, 500],
  "POST /agent/v1/databases/{id}/postgres-pool/storage": [
    400, 401, 404, 409, 500,
  ],
  "POST /agent/v1/databases/{id}/postgres-pool/sleep": [
    400, 401, 404, 409, 500,
  ],
  "POST /agent/v1/pool-bindings/{id}/node": [400, 401, 404, 409, 500],
  "POST /agent/v1/pool-bindings/{id}/serving": [400, 401, 404, 409, 500],
  "POST /agent/v1/pool-bindings/{id}/supervisor": [400, 401, 404, 409, 500],
  "POST /agent/v1/pool-bindings/{id}/io": [400, 401, 404, 409, 500],
  "POST /agent/v1/pool-bindings/{id}/cleanup-io": [400, 401, 404, 409, 500],
  "GET /agent/v1/desired": [400, 401, 404, 409, 500],
  "POST /agent/v1/observations": [400, 401, 500],
  "GET /agent/v1/link": [401, 500],
  "POST /agent/v1/activity": [400, 401, 404, 409, 500],
  "POST /agent/v1/usage": [400, 401, 404, 500],
  "GET /agent/v1/nodes/{id}/compute-pool": [400, 401, 404, 500],
  "POST /agent/v1/nodes/{id}/compute-pool": [400, 401, 404, 409, 500],
  "GET /agent/v1/nodes/{id}/storage-guard": [400, 401, 404, 409, 500],
  "POST /agent/v1/nodes/{id}/storage-headroom": [400, 401, 404, 409, 500],
  "GET /agent/v1/nodes/{id}/reclaim": [400, 401, 404, 409, 500],
  "POST /agent/v1/nodes/{id}/reclaim-observations": [400, 401, 404, 409, 500],
  "POST /agent/v1/fleet-observations": [400, 401, 404, 409, 500],
};

/** These schemas describe existing callbacks and their plain replies, without installing validators. */
export function registerCallbackDocumentation(app: ApiApp): void {
  const callback = (
    path: string,
    params: Params,
    request: z.ZodType,
    response: z.ZodType,
    statuses: readonly number[],
    description: string,
  ) =>
    app.openAPIRegistry.registerPath({
      method: "post",
      path,
      tags: ["Operation callbacks"],
      description,
      request: { params, body: { required: true, content: json(request) } },
      responses: {
        200: {
          description: "Result of the requested callback action",
          content: json(response),
        },
        ...Object.fromEntries(
          statuses.map((status) => [
            status,
            {
              description: "Local API refusal or failure",
              content: json(ErrorBody),
            },
          ]),
        ),
      },
    });
  const relay = (
    path: string,
    params: Params,
    statuses: readonly number[],
    bootstrap: boolean,
    kubernetes = false,
  ) =>
    app.openAPIRegistry.registerPath({
      method: "get",
      path,
      tags: ["Operation relays"],
      description:
        "Opaque end-to-end byte transport for the current scoped operation bearer. Local API refusals use ErrorBody." +
        (bootstrap
          ? " The single-use X-PGCF-Bootstrap grant is additionally required. The relay service's non-101 handshake responses are passed through and may have a different body or content type."
          : " Cloudflare mints the upstream transport grant; the caller does not supply X-PGCF-Bootstrap. An upstream handshake refusal is returned as a local conflict."),
      request: {
        params,
        headers: z.object({
          Upgrade: z.literal("websocket"),
          ...(bootstrap
            ? {
                [BOOTSTRAP_RELAY_HEADER]: z
                  .string()
                  .max(BOOTSTRAP_RELAY_TOKEN_MAX_LENGTH)
                  .regex(/^br1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
              }
            : {}),
        }),
      },
      responses: {
        101: {
          description:
            "WebSocket upgraded to an opaque mTLS or SSH byte stream",
          ...(kubernetes
            ? {
                headers: Object.fromEntries(
                  Object.values(NODE_OPERATOR_KUBERNETES_HEADERS).map(
                    (name) => [
                      name,
                      {
                        description: "Fenced Kubernetes relay target identity",
                        schema: { type: "string" as const },
                      },
                    ],
                  ),
                ),
              }
            : {}),
        },
        ...Object.fromEntries(
          statuses.map((status) => [
            status,
            {
              description: bootstrap
                ? "Local API refusal or failure; an upstream handshake refusal may be passed through instead"
                : "Local API refusal or failure",
              content: {
                ...json(ErrorBody),
                ...(bootstrap ? { "*/*": { schema: {} } } : {}),
              },
            },
          ]),
        ),
        ...(bootstrap
          ? {
              default: {
                description:
                  "Unmodified upstream handshake refusal; its status, headers, content type and body are preserved",
                content: { "*/*": { schema: {} } },
              },
            }
          : {}),
      },
    });
  const op = z.object({ id: OperationId });
  const operation = z.object({ operation_id: OperationId });
  const node = z.object({ id: NodeId });

  // bootstrap-jobs.ts callback: strict shared envelope; seal returns the stored reference, not material.
  callback(
    "/internal/v1/node-bootstrap/{operation_id}",
    operation,
    NodeBootstrapCallback,
    z.union([
      NodeBootstrapAuthority,
      NodeBootstrapTransport,
      z.strictObject({ revision }),
      z.strictObject({
        ref: z.strictObject({
          version: z.literal(1),
          region_id: RegionId,
          purpose: z.enum(["agent_key", "region_seed", "join_bundle"]),
          revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        }),
      }),
    ]),
    [400, 401, 403, 404, 409, 500],
    "The strict NodeBootstrapCallback kind selects authority read, single transport grant, checkpoint revision, or sealed credential reference. Authentication and current bootstrap authority precede parsing; no private material is returned by the seal reply.",
  );
  relay(
    "/internal/v1/node-bootstrap/{operation_id}/relay",
    operation,
    [400, 401, 403, 404, 409, 500],
    true,
  );
  relay(
    "/internal/v1/node-installation/{id}/relay",
    op,
    [400, 401, 403, 404, 409, 500],
    true,
  );

  // node-proof.ts strict requests and source-control's signed plain envelope.
  callback(
    "/source-control",
    z.object({}),
    NodeProofNonce,
    z.strictObject({
      kid: z.string(),
      payload: NodeProofControl,
      signature: z.string(),
    }),
    [400, 401, 403, 404, 409, 500],
    "Returns a signed source-control observation. CF-Connecting-IP is Cloudflare-observed provenance, not a client input or credential.",
  );
  callback(
    "/internal/v1/node-proof/{id}/transport",
    op,
    z.strictObject({
      capability: BootstrapCapability,
      direction: z.enum(["target", "source"]),
    }),
    NodeBootstrapTransport,
    [400, 401, 403, 404, 409, 500],
    "Issues a single grant for the authorized proof target or source transport.",
  );
  callback(
    "/internal/v1/node-proof/{id}/access",
    op,
    z.strictObject({
      binding: NodeProofBinding,
      maintenance_observation: NodeBootstrapMaintenanceObservation.optional(),
    }),
    NodeProofMeasurement.options[0],
    [400, 401, 403, 404, 409, 500],
    "Collects the access measurement for the current physical node proof session.",
  );
  callback(
    "/internal/v1/node-proof/{id}/report",
    op,
    NodeProofReport,
    z.strictObject({
      sha256: digest,
      operation_id: OperationId,
      mode: NodeProofMode,
      verified: z.boolean(),
    }),
    [400, 401, 403, 404, 409, 500],
    "Accepts the current proof report and returns its artifact digest and verification result.",
  );
  callback(
    "/internal/v1/node-proof/{id}/ownership",
    op,
    z.strictObject({
      action: z.enum(["read", "save", "expired"]),
      kind: z.enum(["source", "postjoin"]),
      key: z.string().max(64).optional(),
      state: fields.optional(),
      originalInput: fields.optional(),
      publicSource: fields.optional(),
    }),
    z.union([
      z.strictObject({ entry: fields.nullable() }),
      z.strictObject({ entries: z.array(fields) }),
      z.strictObject({ saved: z.literal(true) }),
    ]),
    [400, 401, 403, 404, 409, 500],
    "Reads, retains or lists proof ownership records. Nested record contents intentionally have no additional shared shape.",
  );
  relay(
    "/internal/v1/node-proof/{id}/relay",
    op,
    [400, 401, 403, 404, 409, 500],
    true,
  );

  // The physical-storage route accepts a loose kind envelope and validates only each selected action.
  callback(
    "/internal/v1/node-thin-storage/{id}",
    node,
    z.discriminatedUnion("kind", [
      z.looseObject({ kind: z.literal("status") }),
      z.looseObject({
        kind: z.literal("transport"),
        capability: transportCapability,
        count: RelayGrantCount.default(1),
      }),
      z.looseObject({
        kind: z.literal("dispatch"),
        nonce: OperationId,
        driver_pod_uid: z.uuid(),
        boot_id: z.uuid(),
      }),
      z.looseObject({
        kind: z.literal("report"),
        report: NodeThinStorageReport,
      }),
    ]),
    z.union([
      z.strictObject({
        operation_id: OperationId,
        revision,
        node_uid: z.uuid(),
        release_id: z.string(),
        spec_sha256: digest,
        assignment_revision: z.number().int().positive(),
        region_revision: z.number().int().positive(),
      }),
      NodeBootstrapTransport,
      NodeBootstrapTransportBatch,
      z.strictObject({ dispatched: z.literal(true) }),
      z.strictObject({
        accepted: z.literal(true),
        revision,
        write_allowed: z.boolean(),
      }),
    ]),
    [400, 401, 409, 500],
    "Loose kind envelope: status reads lease authority; transport with omitted count or count=1 returns one NodeBootstrapTransport, while count=2..8 returns NodeBootstrapTransportBatch; dispatch records the fenced action nonce; report records qualified physical observations.",
  );
  relay(
    "/internal/v1/node-thin-storage/{id}/relay",
    node,
    [400, 401, 403, 409, 500],
    true,
  );

  callback(
    "/internal/v1/thin-qualifications/{id}",
    op,
    z.discriminatedUnion("kind", [
      z.looseObject({ kind: z.literal("status") }),
      z.looseObject({
        kind: z.literal("transport"),
        capability: transportCapability,
      }),
      z.looseObject({
        kind: z.literal("checkpoint"),
        ...ThinQualificationCheckpoint.shape,
      }),
      z.looseObject({
        kind: z.literal("report"),
        report: ThinQualificationReport,
      }),
      z.looseObject({ kind: z.literal("release") }),
    ]),
    z.union([
      z.strictObject({
        run_id: OperationId,
        step: ThinQualificationStep,
        lease_id: OperationId,
        lease_revision: revision,
        node_uid: z.uuid(),
        release_id: z.string(),
        spec_sha256: digest,
      }),
      NodeBootstrapTransport,
      z.strictObject({ revision }),
      z.strictObject({
        step: ThinQualificationStep,
        status: z.literal("running"),
        waiting: z.boolean(),
      }),
    ]),
    [400, 401, 404, 409, 500],
    "Loose kind envelope scoped to the live turn lease. Transport always returns one grant. Checkpoint returns the next journal revision; report returns the next step with status=running and waiting=false; release returns current status with waiting=true.",
  );
  relay(
    "/internal/v1/thin-qualifications/{id}/relay",
    op,
    [400, 401, 403, 404, 409, 500],
    true,
  );

  callback(
    "/internal/v1/fleet-patches/{operation_id}",
    operation,
    z.union([
      z.looseObject({
        kind: z.literal("transport"),
        capability: transportCapability,
        target: z.enum(["node", "control"]).default("node"),
        count: RelayGrantCount.optional(),
      }),
      z.looseObject({
        kind: z.literal("status"),
        expected_compute_pool_revision: z.number().int().positive().optional(),
      }),
      z.strictObject({
        kind: z.literal("checkpoint"),
        ...FleetPatchCheckpoint.shape,
      }),
      z.looseObject({ kind: z.literal("postgres_rollout") }),
    ]),
    z.union([
      NodeBootstrapTransport,
      NodeBootstrapTransportBatch,
      FleetPatchStatus,
      FleetPatchStatus.extend({
        compute_pool_observation: ComputePoolObservation.nullable(),
      }),
      FleetPostgresPatchProgress,
    ]),
    [400, 401, 404, 409, 500],
    "Transport with omitted count returns a singleton; every explicit count=1..8 returns a batch. Status with expected_compute_pool_revision returns the compute observation as well as patch status. Checkpoint fields are flattened beside kind and return current patch status. postgres_rollout returns reconciliation progress.",
  );
  relay(
    "/internal/v1/fleet-patches/{operation_id}/relay",
    operation,
    [400, 401, 403, 404, 409, 500],
    true,
  );

  const rotation = z.object({ rollout: OperationId, region: RegionId });
  callback(
    "/internal/v1/fleet-rollouts/{rollout}/regions/{region}/rotation",
    rotation,
    z.looseObject({
      expected_revision: revision,
      checkpoint: FleetRegionMaterialRotationCheckpoint,
    }),
    z.strictObject({
      checkpoint: FleetRegionMaterialRotationCheckpoint,
      bearer: z.string(),
    }),
    [400, 401, 404, 409, 500],
    "Checkpoints safe authority-rotation progress at the expected revision and returns its successor scoped bearer. Private rotation input is not the callback request.",
  );
  relay(
    "/internal/v1/fleet-rollouts/{rollout}/regions/{region}/rotation/kubernetes/{node}",
    rotation.extend({ node: NodeId }),
    [400, 401, 404, 409, 500],
    false,
    true,
  );
  relay(
    "/internal/v1/infrastructure-backups/{run}/{artifact}/kubernetes",
    z.object({ run: z.uuid(), artifact: z.string() }),
    [400, 401, 404, 409, 500],
    false,
    true,
  );
}
