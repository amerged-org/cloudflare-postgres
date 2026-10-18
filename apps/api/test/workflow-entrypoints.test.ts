// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { newOperationId } from "@pgcf/contracts/ids";
import { expect, it } from "vitest";

// The exported Workflow classes load their implementation when a run starts; a run reaches it.
it("runs the AddNode implementation it loads", async () => {
  const id = newOperationId();
  await using instance = await introspectWorkflowInstance(env.ADD_NODE, id);
  await env.ADD_NODE.create({ id, params: { operation_id: id } });
  await instance.waitForStatus("errored");
  // The implementation reads the addition first, and this operation has none.
  expect((await instance.getError()).message).toBe("Node addition not found");
});

it("runs the InfrastructureBackup implementation it loads", async () => {
  const id = crypto.randomUUID();
  await using instance = await introspectWorkflowInstance(
    env.INFRASTRUCTURE_BACKUP!,
    id,
  );
  await env.INFRASTRUCTURE_BACKUP!.create({ id, params: { run_id: id } });
  await instance.waitForStatus("complete");
  // The implementation fails a run it does not know and reports it.
  expect(await instance.getOutput()).toEqual({ run_id: id, status: "failed" });
});
