// SPDX-License-Identifier: Apache-2.0
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { OperationId } from "@pgcf/contracts";
import { z } from "zod";
import type { Env } from "../env.ts";
import {
  contaboClient,
  type ContaboClient,
  type ContaboOrderInput,
} from "../providers/contabo.ts";
import {
  claimNodeDispatch,
  markNodeAdditionFailed,
  markNodeDispatchUnknown,
  readNodeAddition,
  recordNodeAudit,
  recordNodeReceipt,
  NodeStateError,
  assertNodeRecoveryAuthority,
} from "../domain/node-state.ts";
import { placePendingDatabases } from "../domain/node-capacity.ts";

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
          if (ids.length) {
            await this.env.REGION_LINK.get(
              this.env.REGION_LINK.idFromName(
                addition.intent.request.region_id,
              ),
            ).notify(ids);
          }
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
      // The audited server waits for the node installer, which this release does not have.
      if (["audited", "bootstrapping"].includes(addition.status))
        return { operation_id: id, status: addition.status };
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
