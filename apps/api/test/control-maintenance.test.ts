// SPDX-License-Identifier: Apache-2.0
import { env, type WorkflowStep } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect, it } from "vitest";
import { ErrorBody, newApiKey, newDatabaseId } from "@pgcf/contracts";
import { PgcfClient } from "@pgcf/contracts/client";
import worker from "../src/index.ts";
import { DatabaseActor } from "../src/database-actor.ts";
import { NodeActor } from "../src/node-actor.ts";
import { CronWatchdog } from "../src/cron-watchdog.ts";
import { ActorWarmer } from "../src/actor-warmer.ts";
import { maintenanceEnvironment } from "../src/control-maintenance.ts";
import { AddNode, InfrastructureBackup } from "../src/workflows/entrypoints.ts";
import type { Env } from "../src/env.ts";

const paused = () => ({ ...env, CONTROL_PLANE_MAINTENANCE: "on" }) as Env;

it("refuses HTTP before authentication or D1 and does not start scheduled producers", async () => {
  const context = createExecutionContext();
  for (const method of ["GET", "POST", "DELETE", "HEAD"]) {
    const response = await worker.fetch(
      new Request("https://control.invalid/v1/projects", { method }),
      paused(),
      context,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("X-PGCF-Control-Maintenance")).toBe("on");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    if (method === "HEAD") expect(await response.text()).toBe("");
    else
      expect(ErrorBody.parse(await response.json()).error.code).toBe(
        "service_unavailable",
      );
  }
  const before = await env.DB.prepare("SELECT * FROM cron_heartbeat").all();
  worker.scheduled({} as ScheduledController, paused(), context);
  await waitOnExecutionContext(context);
  expect(
    (await env.DB.prepare("SELECT * FROM cron_heartbeat").all()).results,
  ).toEqual(before.results);
  const resumed = await worker.fetch(
    new Request("https://control.invalid/v1/openapi.json"),
    env,
    context,
  );
  expect(resumed.status).toBe(200);
});

it("gives the published client a retryable service error rather than an invalid response", async () => {
  const context = createExecutionContext();
  const client = new PgcfClient({
    baseUrl: "https://control.invalid",
    apiKey: newApiKey().key,
    fetch: (input, init) =>
      worker.fetch(
        new Request(input, init) as Parameters<typeof worker.fetch>[0],
        paused(),
        context,
      ),
  });
  await expect(client.getDatabase(newDatabaseId())).rejects.toMatchObject({
    code: "service_unavailable",
    status: 503,
    requestId: expect.any(String),
  });
});

it("refuses new Workflow invocations before loading their D1 implementations", async () => {
  const at = new Date();
  const step = {} as WorkflowStep;
  await expect(
    AddNode.prototype.run.call(
      { env: paused() } as unknown as AddNode,
      {
        payload: { operation_id: "op_invalid" },
        timestamp: at,
        instanceId: "maintenance-add",
        workflowName: "maintenance-add",
      },
      step,
    ),
  ).rejects.toThrow("control_plane_maintenance");
  await expect(
    InfrastructureBackup.prototype.run.call(
      { env: paused() } as unknown as InfrastructureBackup,
      {
        payload: { run_id: "maintenance-backup" },
        timestamp: at,
        instanceId: "maintenance-backup",
        workflowName: "maintenance-backup",
      },
      step,
    ),
  ).rejects.toThrow("control_plane_maintenance");
});

it("closes a native control link before accepting its next message, without touching tenant data sockets", async () => {
  const stub = env.NODE_ACTOR.get(env.NODE_ACTOR.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const actor = new NodeActor(state, paused());
    const pair = new WebSocketPair();
    pair[0].accept();
    pair[1].accept();
    const ended = new Promise<CloseEvent>((resolve) =>
      pair[0].addEventListener("close", resolve, { once: true }),
    );
    await actor.webSocketMessage(pair[1], "invalid-before-parse");
    expect((await ended).code).toBe(1013);
    await expect(actor.notify()).rejects.toThrow("control_plane_maintenance");
    await expect(actor.fence()).rejects.toThrow("control_plane_maintenance");
  });
});

it("also refuses direct D1 use in paused actor environments and leaves the active binding intact", async () => {
  expect(() => maintenanceEnvironment(paused()).DB.prepare("SELECT 1")).toThrow(
    "control_plane_maintenance",
  );
  expect(maintenanceEnvironment(env)).toBe(env);
  expect(await env.DB.prepare("SELECT 1 n").first("n")).toBe(1);
});

it("refuses admission and mutation RPCs before parsing or writing actor state", async () => {
  const stub = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const actor = new DatabaseActor(state, paused());
    const before = state.storage.sql
      .exec("SELECT name FROM sqlite_master")
      .toArray();
    await expect(actor.admit("invalid", "invalid")).rejects.toThrow(
      "control_plane_maintenance",
    );
    await expect(actor.seed({})).rejects.toThrow("control_plane_maintenance");
    await expect(actor.beginAdmissionMutation({})).rejects.toThrow(
      "control_plane_maintenance",
    );
    await expect(actor.repairAdmissionMutation()).rejects.toThrow(
      "control_plane_maintenance",
    );
    expect(
      state.storage.sql.exec("SELECT name FROM sqlite_master").toArray(),
    ).toEqual(before);
  });
});

it("keeps independent alarms armed without D1 evaluation or discarded local samples", async () => {
  const before = await env.DB.prepare("SELECT * FROM cron_heartbeat").all();
  const probes = [
    [env.CRON_WATCHDOG!, CronWatchdog],
    [env.ACTOR_WARMER!, ActorWarmer],
    [env.NODE_ACTOR, NodeActor],
  ] as const;
  for (const [namespace, Actor] of probes) {
    const stub = namespace.get(namespace.newUniqueId());
    await runInDurableObject(stub, async (_instance, state) => {
      const actor = new Actor(state, paused());
      const at = Date.now();
      await actor.alarm();
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(
        at + 60_000,
      );
      await state.storage.deleteAlarm();
    });
  }
  expect(
    (await env.DB.prepare("SELECT * FROM cron_heartbeat").all()).results,
  ).toEqual(before.results);
});
