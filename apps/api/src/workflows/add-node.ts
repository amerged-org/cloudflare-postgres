// SPDX-License-Identifier: Apache-2.0
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { OperationId } from "@pgcf/contracts";
import { z } from "zod";
import type { Env } from "../env.ts";
import type { ContaboClient, ContaboOrderInput } from "../providers/contabo.ts";
import { contaboClient } from "../domain/bootstrap-relay.ts";
import {
  readBootstrapJob,
  finalizeNodeAdmission,
  type BootstrapJobRow,
  bootstrapJobInput,
} from "../domain/bootstrap-jobs.ts";
import {
  claimNodeDispatch,
  markNodeAdditionFailed,
  markNodeDispatchUnknown,
  readNodeAddition,
  recordNodeAudit,
  recordNodeReceipt,
  saveNodeBootstrapCheckpoint,
  NodeStateError,
  assertNodeRecoveryAuthority,
} from "../domain/node-state.ts";
import { placePendingDatabases } from "../domain/node-capacity.ts";
import {
  ensureNodeFirewall,
  ensureNodeNetwork,
  hasVerifiedNodePreparation,
} from "../domain/node-network.ts";
import { validateRescueConfiguration } from "../domain/rescue-configuration.ts";
import { prepareNodeInstallationInputs } from "../domain/prepare-node-installation.ts";
import { ensureNodeInstallationInspection } from "../domain/node-inspection.ts";
import { composeConfiguredNodeBootstrap } from "../domain/bootstrap-composition.ts";
import {
  ensureNodePreparationProof,
  ensureNodeVerificationProof,
} from "../domain/node-proof.ts";
import { NodeBootstrapCheckpoint } from "@pgcf/contracts/node-bootstrap";

function orderInput(
  env: Env,
  addition: Awaited<ReturnType<typeof readNodeAddition>>,
): ContaboOrderInput {
  if (addition.intent.request.mode !== "order")
    throw new Error("node_order_intent_required");
  const order = addition.intent.request.order;
  return {
    productId: order.product_id,
    region: z
      .enum([
        "EU",
        "US-central",
        "US-east",
        "US-west",
        "SIN",
        "UK",
        "AUS",
        "JPN",
        "IND",
      ])
      .parse(order.provider_region),
    imageId: order.image_id,
    period: order.term_months,
    displayName: addition.intent.requested_hostname,
    ...(order.add_ons === undefined
      ? {}
      : {
          addOns: { addonsIds: order.add_ons.map((addon) => ({ ...addon })) },
        }),
    defaultUser: z
      .enum(["root", "admin", "administrator"])
      .parse(env.CONTABO_ORDER_DEFAULT_USER),
    sshKeys: z
      .array(z.string().regex(/^[1-9]\d{0,18}$/))
      .min(1)
      .max(100)
      .parse(JSON.parse(env.CONTABO_ORDER_SSH_KEY_IDS)),
  };
}
export async function dispatchNodeOrder(
  env: Env,
  operationId: string,
  provider: Pick<ContaboClient, "order"> = contaboClient(env),
): Promise<void> {
  let addition = await readNodeAddition(env.DB, operationId);
  if (
    addition.intent.request.mode !== "order" ||
    addition.status !== "reserved"
  )
    return;
  // Validate all local configuration before persisting the irreversible dispatch claim.
  const input = orderInput(env, addition);
  const claim = await claimNodeDispatch(env.DB, operationId, addition.revision);
  if (!claim.claimed) return;
  addition = claim.addition;
  let result;
  try {
    result = await provider.order(input, {
      requestId: claim.request_id,
      accounting: { operation_id: operationId, stage: "order" },
    });
  } catch {
    await markNodeDispatchUnknown(env.DB, operationId, addition.revision);
    return;
  }
  if (result.kind === "accepted") {
    await recordNodeReceipt(env.DB, operationId, addition.revision, {
      provider_instance_id: result.value.instanceId,
      request_id: claim.request_id,
      reference: `provider-order:${claim.request_id}`,
      received_at: new Date().toISOString(),
    });
  } else if (result.kind === "unknown")
    await markNodeDispatchUnknown(env.DB, operationId, addition.revision);
  else
    await markNodeAdditionFailed(
      env.DB,
      operationId,
      addition.revision,
      "provider_rejected",
    );
}
export async function reconcileNodeProvider(
  env: Env,
  operationId: string,
  provider: Pick<
    ContaboClient,
    "getInstance" | "instanceAudits"
  > = contaboClient(env),
): Promise<void> {
  let addition = await readNodeAddition(env.DB, operationId);
  if (addition.status === "dispatching")
    addition = await markNodeDispatchUnknown(
      env.DB,
      operationId,
      addition.revision,
    );
  if (
    addition.intent.request.mode !== "order" &&
    addition.status === "reserved"
  ) {
    await assertNodeRecoveryAuthority(env.DB, addition);
    const actual = await provider.getInstance(
      addition.intent.request.provider_instance_id,
      {
        requestId: crypto.randomUUID(),
        accounting: { operation_id: operationId, stage: "resolution" },
      },
    );
    addition = await recordNodeReceipt(env.DB, operationId, addition.revision, {
      provider_instance_id: actual.id,
      request_id: null,
      reference: `provider-${addition.intent.request.mode}:${actual.id}`,
      received_at: new Date().toISOString(),
    });
  }
  if (
    ["unknown", "failed"].includes(addition.status) &&
    addition.dispatch_request_id !== null &&
    addition.provider_instance_id === null
  ) {
    const audits = await provider.instanceAudits(
      {
        requestId: addition.dispatch_request_id,
        startDate: addition.created_at.slice(0, 10),
        endDate: new Date().toISOString().slice(0, 10),
      },
      {
        requestId: crypto.randomUUID(),
        accounting: { operation_id: operationId, stage: "resolution" },
      },
    );
    const matches = [
      ...new Set(
        audits
          .filter(
            (a) =>
              a.requestId === addition.dispatch_request_id &&
              a.action === "CREATED" &&
              a.instanceId !== "0",
          )
          .map((a) => a.instanceId),
      ),
    ];
    if (matches.length !== 1) return;
    const actual = await provider.getInstance(matches[0]!, {
      requestId: crypto.randomUUID(),
      accounting: { operation_id: operationId, stage: "resolution" },
    });
    if (
      actual.displayName !== addition.intent.requested_hostname ||
      addition.intent.request.mode !== "order" ||
      actual.region !== addition.intent.request.order.provider_region ||
      actual.productId !== addition.intent.request.order.product_id ||
      actual.imageId !== addition.intent.request.order.image_id
    )
      return;
    addition = await recordNodeReceipt(env.DB, operationId, addition.revision, {
      provider_instance_id: actual.id,
      request_id: addition.dispatch_request_id,
      reference: `provider-audit:${audits.find((a) => a.instanceId === actual.id)!.id}`,
      received_at: new Date().toISOString(),
    });
  }
  if (
    addition.status === "provider_bound" &&
    addition.provider_instance_id !== null
  ) {
    const actual = await provider.getInstance(addition.provider_instance_id, {
      requestId: crypto.randomUUID(),
      accounting: { operation_id: operationId, stage: "resolution" },
    });
    if (!actual.imageId) return;
    await recordNodeAudit(env.DB, operationId, addition.revision, {
      provider_instance_id: actual.id,
      provider_region: actual.region,
      product_id: actual.productId,
      image_id: actual.imageId,
      reference: `provider-detail:${actual.id}`,
      observed_at: new Date().toISOString(),
    });
  }
}
export async function ensureNodeRescue(
  env: Env,
  operationId: string,
  provider?: Pick<ContaboClient, "getInstance" | "rescue" | "actionAudits">,
): Promise<boolean> {
  const addition = await readNodeAddition(env.DB, operationId);
  const job = await env.DB.prepare(
    "SELECT * FROM node_bootstrap_jobs WHERE operation_id=?",
  )
    .bind(operationId)
    .first<BootstrapJobRow>();
  if (
    !addition.provider_instance_id ||
    !addition.audit ||
    !["audited", "bootstrapping"].includes(addition.status) ||
    (job !== null && (!job.authorized || job.admitted || job.cancelled))
  )
    return false;
  if (job !== null && job.rescue_active) {
    await assertNodeRecoveryAuthority(env.DB, addition);
    const { spec } = await bootstrapJobInput(env, job);
    const current = await readBootstrapJob(env.DB, operationId),
      currentAddition = await readNodeAddition(env.DB, operationId);
    return (
      spec.provider_instance_id === addition.provider_instance_id &&
      spec.node_id === addition.intent.node_id &&
      spec.region_id === addition.intent.request.region_id &&
      Boolean(current.authorized) &&
      !current.admitted &&
      !current.cancelled &&
      Boolean(current.rescue_active) &&
      current.input_hash === job.input_hash &&
      current.revision === job.revision &&
      currentAddition.revision === addition.revision &&
      currentAddition.intent_hash === addition.intent_hash &&
      currentAddition.provider_instance_id === addition.provider_instance_id &&
      currentAddition.slot_held &&
      ["audited", "bootstrapping"].includes(currentAddition.status)
    );
  }
  const rescueConfiguration = await validateRescueConfiguration(
    env,
    addition.provider_instance_id,
    env.CONTABO_RESCUE_CONFIGURATION !== undefined && job !== null
      ? await bootstrapJobInput(env, job)
      : undefined,
  );
  if (job !== null && JSON.parse(job.checkpoint_json).stage !== "created")
    return Boolean(job.rescue_active);
  await assertNodeRecoveryAuthority(env.DB, addition);
  if (!(await ensureNodeFirewall(env, operationId))) return false;
  const client = provider ?? contaboClient(env);
  const actual = await client.getInstance(addition.provider_instance_id, {
    requestId: crypto.randomUUID(),
    accounting: { operation_id: operationId, stage: "rescue" },
  });
  if (actual.status === "rescue") {
    if (job !== null)
      await env.DB.prepare(
        "UPDATE node_bootstrap_jobs SET rescue_active=1 WHERE operation_id=? AND input_hash=? AND authorized=1 AND admitted=0 AND cancelled=0",
      )
        .bind(operationId, job.input_hash)
        .run();
    return true;
  }
  if (!["running", "stopped", "uninstalled"].includes(actual.status))
    return false;
  const sshKeys = z
    .array(z.string().regex(/^[1-9]\d{0,18}$/))
    .min(1)
    .max(100)
    .parse(JSON.parse(env.CONTABO_RESCUE_SSH_KEY_IDS));
  const requestId = crypto.randomUUID(),
    now = new Date().toISOString();
  const claim = await env.DB.prepare(
    `INSERT INTO node_provider_mutations(operation_id,mutation,request_id,revision,state,created_at,updated_at)
    SELECT operation_id,'rescue',?,revision,'dispatching',?,? FROM node_additions WHERE operation_id=? AND revision=?
      AND status IN('audited','bootstrapping') AND provider_instance_id=? ON CONFLICT(operation_id,mutation) DO NOTHING`,
  )
    .bind(
      requestId,
      now,
      now,
      operationId,
      addition.revision,
      addition.provider_instance_id,
    )
    .run();
  if (claim.meta.changes === 1) {
    let state = "unknown",
      code = "provider_unknown";
    try {
      const result = await client.rescue(
        addition.provider_instance_id,
        {
          sshKeys,
          ...(rescueConfiguration
            ? { userData: rescueConfiguration.user_data }
            : {}),
        },
        {
          requestId,
          accounting: { operation_id: operationId, stage: "rescue" },
        },
      );
      state = result.kind;
      code = result.code;
    } catch {
      /* Persisted dispatch remains uncertain. */
    }
    await env.DB.prepare(
      "UPDATE node_provider_mutations SET state=?,code=?,updated_at=? WHERE operation_id=? AND mutation='rescue' AND request_id=? AND state='dispatching'",
    )
      .bind(state, code, new Date().toISOString(), operationId, requestId)
      .run();
  } else {
    const mutation = await env.DB.prepare(
      "SELECT request_id FROM node_provider_mutations WHERE operation_id=? AND mutation='rescue'",
    )
      .bind(operationId)
      .first<{ request_id: string }>();
    if (mutation)
      await client.actionAudits(
        {
          requestId: mutation.request_id,
          instanceId: addition.provider_instance_id,
        },
        {
          requestId: crypto.randomUUID(),
          accounting: { operation_id: operationId, stage: "resolution" },
        },
      );
  }
  return false;
}
export async function ensureBootstrapNetworkBoundary(
  env: Env,
  operationId: string,
): Promise<boolean> {
  const addition = await readNodeAddition(env.DB, operationId),
    job = await readBootstrapJob(env.DB, operationId);
  if (
    !addition.slot_held ||
    !["audited", "bootstrapping"].includes(addition.status) ||
    !job.authorized ||
    job.admitted ||
    job.cancelled
  )
    return false;
  await assertNodeRecoveryAuthority(env.DB, addition);
  const checkpoint = NodeBootstrapCheckpoint.parse(
    JSON.parse(job.checkpoint_json),
  );
  if (
    (addition.checkpoint?.stage === "prepared" &&
      addition.checkpoint.reference === addition.intent_hash) ||
    checkpoint.stage !== "created"
  )
    return hasVerifiedNodePreparation(
      env.DB,
      operationId,
      addition.intent_hash,
    );
  if (!(await ensureNodeNetwork(env, operationId))) return false;
  const current = await readNodeAddition(env.DB, operationId);
  if (current.checkpoint === null)
    await saveNodeBootstrapCheckpoint(env.DB, operationId, current.revision, {
      stage: "prepared",
      reference: current.intent_hash,
      saved_at: new Date().toISOString(),
    });
  return true;
}
export class AddNode extends WorkflowEntrypoint<Env, { operation_id: string }> {
  override async run(
    event: WorkflowEvent<{ operation_id: string }>,
    step: WorkflowStep,
  ) {
    const id = OperationId.parse(event.payload.operation_id);
    for (let cycle = 0; cycle < 288; cycle++) {
      // Workflow cached outputs never authorize another side effect: D1 is consulted on every resume.
      let addition = await readNodeAddition(this.env.DB, id);
      if (addition.status === "cancelled")
        return { operation_id: id, status: "cancelled" };
      if (addition.status === "ready") {
        await step.do(`placement-${cycle}`, async () => {
          const ids = await placePendingDatabases(
            this.env.DB,
            addition.intent.request.region_id,
          );
          if (ids.length)
            await this.env.REGION_LINK.get(
              this.env.REGION_LINK.idFromName(
                addition.intent.request.region_id,
              ),
            ).notify(ids);
          return { placed: ids.length };
        });
        return { operation_id: id, status: "ready" };
      }
      if (
        addition.status === "reserved" &&
        addition.intent.request.mode === "order"
      ) {
        await step.do(
          `purchase-${cycle}`,
          { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
          async () => {
            try {
              await dispatchNodeOrder(this.env, id);
            } catch (error) {
              if (!(
                error instanceof NodeStateError &&
                error.code === "approval_required"
              ))
                throw error;
            }
            return { operation_id: id };
          },
        );
      }
      addition = await readNodeAddition(this.env.DB, id);
      if (
        [
          "reserved",
          "dispatching",
          "unknown",
          "provider_bound",
          "failed",
        ].includes(addition.status) &&
        (addition.intent.request.mode !== "order" ||
          addition.dispatch_request_id !== null)
      ) {
        await step.do(
          `provider-readback-${cycle}`,
          { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
          async () => {
            await reconcileNodeProvider(this.env, id);
            return { operation_id: id };
          },
        );
      }
      addition = await readNodeAddition(this.env.DB, id);
      if (["audited", "bootstrapping"].includes(addition.status)) {
        const prepared = await step.do(
          `installation-inputs-${cycle}`,
          { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
          async () => {
            return prepareNodeInstallationInputs(this.env, id);
          },
        );
        if (prepared.profile_configured && !prepared.binding_ready) {
          await step.sleep(`installation-inputs-wait-${cycle}`, "1 minute");
          continue;
        }
        await step.do(
          `network-rescue-${cycle}`,
          { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
          async () => {
            await ensureNodeRescue(this.env, id);
            return { operation_id: id };
          },
        );
        if (prepared.profile_configured && !prepared.job_configured) {
          const inspected = await step.do(
            `inspection-${cycle}`,
            { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
            () => ensureNodeInstallationInspection(this.env, id),
          );
          if (!inspected) {
            await step.sleep(`inspection-wait-${cycle}`, "1 minute");
            continue;
          }
          await step.do(
            `compose-inspected-${cycle}`,
            { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
            () => composeConfiguredNodeBootstrap(this.env, id),
          );
        }
        const job = await this.env.DB.prepare(
          "SELECT input_hash FROM node_bootstrap_jobs WHERE operation_id=?",
        )
          .bind(id)
          .first();
        if (job) {
          await step.do(
            `bootstrap-${cycle}`,
            { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
            async () => {
              const job = await readBootstrapJob(this.env.DB, id);
              if (job.admission_authorized) {
                if (!(await finalizeNodeAdmission(this.env, id))) {
                  await this.env.NODE_BOOTSTRAP.get(
                    this.env.NODE_BOOTSTRAP.idFromName(id),
                  ).admit(id);
                  await finalizeNodeAdmission(this.env, id);
                }
              } else if (
                job.rescue_active &&
                job.authorized &&
                !job.admitted &&
                !job.cancelled
              ) {
                const checkpoint = NodeBootstrapCheckpoint.parse(
                  JSON.parse(job.checkpoint_json),
                );
                if (checkpoint.stage === "awaiting_verification") {
                  await ensureNodeVerificationProof(this.env, id);
                  return { operation_id: id };
                }
                if (!(await ensureNodePreparationProof(this.env, id)))
                  return { operation_id: id };
                if (!(await ensureBootstrapNetworkBoundary(this.env, id)))
                  return { operation_id: id };
                await this.env.NODE_BOOTSTRAP.get(
                  this.env.NODE_BOOTSTRAP.idFromName(id),
                ).start(id);
              }
              return { operation_id: id };
            },
          );
        }
      }
      await step.sleep(
        `waiting-${cycle}`,
        addition.status === "reserved" && addition.approval === null
          ? "5 minutes"
          : "30 seconds",
      );
    }
    return { operation_id: id, status: "waiting_for_operator" };
  }
}
