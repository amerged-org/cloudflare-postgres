// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { NodeAddition } from "@pgcf/contracts/nodes";
import type { Env } from "../env.ts";
import type { ContaboClient } from "../providers/contabo.ts";
import { contaboClient } from "./bootstrap-relay.ts";
import {
  NodeStateError,
  readNodeAddition,
  cancelUnattemptedNodeAddition,
  cancelProviderCancelledNodeAddition,
} from "./node-state.ts";

const refuse = (message: string): never => {
  throw new NodeStateError("conflict", message);
};

/** Record an owner's existing provider cancellation; never requests a provider mutation. */
export async function cancelAlreadyCancelledProviderAddition(
  env: Env,
  operationId: string,
  expectedRevision: number,
  options: { provider?: Pick<ContaboClient, "getInstance"> } = {},
): Promise<NodeAddition> {
  const addition = await readNodeAddition(env.DB, operationId);
  if (addition.status === "cancelled") return addition;
  if (
    addition.dispatch_request_id === null &&
    addition.provider_instance_id === null
  )
    return cancelUnattemptedNodeAddition(env.DB, operationId, expectedRevision);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    addition.revision !== expectedRevision ||
    !addition.slot_held ||
    !["audited", "provider_bound", "unknown"].includes(addition.status) ||
    addition.intent.request.mode !== "order" ||
    !addition.dispatch_request_id ||
    !addition.provider_instance_id ||
    !addition.receipt ||
    addition.receipt.provider_instance_id !== addition.provider_instance_id ||
    addition.receipt.request_id !== addition.dispatch_request_id ||
    addition.checkpoint ||
    addition.network ||
    addition.capacity
  )
    return refuse(
      "Only an empty paid reservation with its original receipt can record provider cancellation",
    );
  const order = addition.intent.request.order,
    region = await env.DB.prepare(
      "SELECT provider,provider_region FROM regions WHERE id=?",
    )
      .bind(addition.intent.request.region_id)
      .first<{ provider: string; provider_region: string }>();
  if (
    region?.provider !== "contabo" ||
    region.provider_region !== order.provider_region
  )
    return refuse(
      "Provider cancellation requires the original owned region selection",
    );
  const actual = await (options.provider ?? contaboClient(env)).getInstance(
    addition.provider_instance_id,
    { requestId: crypto.randomUUID() },
  );
  if (
    actual.id !== addition.provider_instance_id ||
    actual.displayName !== addition.intent.requested_hostname ||
    actual.region !== order.provider_region ||
    actual.productId !== order.product_id ||
    actual.imageId !== order.image_id ||
    !z.iso.date().safeParse(actual.cancelDate).success ||
    (addition.audit &&
      (addition.audit.provider_instance_id !== actual.id ||
        addition.audit.provider_region !== actual.region ||
        addition.audit.product_id !== actual.productId ||
        addition.audit.image_id !== actual.imageId))
  )
    return refuse(
      "Fresh owned provider inventory must match the original order and already record its cancellation",
    );
  return cancelProviderCancelledNodeAddition(
    env.DB,
    addition,
    expectedRevision,
  );
}

/** Best effort after the known D1 commit; failure never reopens the addition or retries an order. */
export async function stopCancelledNodeAdditionWorkflow(
  env: Env,
  operationId: string,
): Promise<void> {
  try {
    await (await env.ADD_NODE.get(operationId)).terminate();
  } catch {
    // The logical cancellation is already committed, including when no Workflow exists.
  }
}
