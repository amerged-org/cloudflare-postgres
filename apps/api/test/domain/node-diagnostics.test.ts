// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  INFRA_ALERT_ACTIONS,
  InfraAlert,
  NODE_BOOT_REPORT_MAX_BYTES,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
import { infrastructureAlertStatus } from "../../src/domain/infrastructure-alerts.ts";
import {
  cleanupFixtures,
  fixture,
  nodeOs,
  nodeRequest,
  nodeSample,
  request,
} from "./fixtures.ts";
import { nextMessage, openLink } from "./node-fixtures.ts";

afterEach(cleanupFixtures);

type F = Awaited<ReturnType<typeof fixture>>;
const BOOT = "2f1c8a6e-3b57-4d0a-9c1e-7a4b5d6e8f90",
  PREVIOUS = "9a7c1d2e-4b3f-4a65-8e10-6c5d4b3a2f10";
const entry = {
  at: new Date().toISOString(),
  unit: "pgcf-agent.service",
  identifier: "pgcf-agent",
  transport: "stdout",
  priority: 6,
  message: '{"event":"agent_started","uptime_s":12}',
};
const report = (change: Record<string, unknown> = {}) => ({
  boot_id: BOOT,
  previous_boot_id: PREVIOUS,
  kernel_release: "6.12.113+deb13-amd64",
  entries: [entry],
  ...change,
});
const send = (f: F, body: unknown) =>
  nodeRequest(f, "/node/v1/diagnostics", { method: "POST", body });
const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** The node's newest sample, which a node that has reported and then rebooted last said. */
const sampled = (f: F, at: string) =>
  env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(at, f.node)
    .run();
/** A maintenance order of the node; `closed` is when it ended, if it did. */
const maintenance = (f: F, created: string, closed: string | null = null) =>
  env.DB.prepare(
    `INSERT INTO lifecycle_orders(operation,node_id,type,created_at,closed_at,result_status)
     VALUES(?,?,'maintenance',?,?,?)`,
  )
    .bind(
      newOperationId(),
      f.node,
      created,
      closed,
      closed === null ? null : "done",
    )
    .run();
/**
 * The node's agent, started at `bootedAt` on the boot `BOOT`: its hello says so over the link, and
 * its first sample, a minute old, is stored. The link stays open for the caller to close.
 */
async function started(f: F, bootedAt: string) {
  const socket = await openLink(f, false);
  const welcome = nextMessage(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      agent_version: "0.1.0",
      release_id: null,
      os: nodeOs({ boot_id: BOOT, booted_at: bootedAt }),
    }),
  );
  await welcome;
  const observed = ago(MINUTE);
  socket.send(
    JSON.stringify({
      type: "sample",
      sample: nodeSample(Date.parse(observed)),
    }),
  );
  for (let i = 0; i < 400; i++) {
    const row = await env.DB.prepare(
      "SELECT last_observed_at FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first<{ last_observed_at: string }>();
    if (row!.last_observed_at === observed) return socket;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("sample_not_stored");
}
const stored = (f: F) =>
  env.DB.prepare(
    "SELECT kind,boot_id,previous_boot_id,expected_reboot,body FROM node_diagnostics WHERE node_id=? ORDER BY received_at,id",
  )
    .bind(f.node)
    .all<{
      kind: string;
      boot_id: string;
      previous_boot_id: string | null;
      expected_reboot: number | null;
      body: string;
    }>()
    .then((rows) => rows.results);
const reboot = async (f: F, body: unknown = report()) =>
  (await send(f, body)).json<{ id: string; expected_reboot: boolean | null }>();
const episode = async (f: F) => {
  await runCron(env, Date.now());
  const row = await env.DB.prepare(
    "SELECT active,payload FROM infrastructure_alerts WHERE region_id=? AND kind='node_unexpected_reboot'",
  )
    .bind(f.region)
    .first<{ active: number; payload: string }>();
  return row === null
    ? null
    : {
        active: row.active === 1,
        event: InfraAlert.parse(JSON.parse(row.payload)),
      };
};

describe("a boot report whose reboot nobody asked for", () => {
  it("is kept and raises node_unexpected_reboot for the node", async () => {
    const f = await fixture();
    await sampled(f, ago(2 * MINUTE));
    const answer = await send(f, report());
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      id: expect.any(String),
      expected_reboot: false,
    });
    expect(await stored(f)).toEqual([
      {
        kind: "boot",
        boot_id: BOOT,
        previous_boot_id: PREVIOUS,
        expected_reboot: 0,
        body: JSON.stringify(report()),
      },
    ]);
    const raised = await episode(f);
    expect(raised?.active).toBe(true);
    expect(raised?.event).toMatchObject({
      kind: "node_unexpected_reboot",
      region_id: f.region,
      node_ids: [f.node],
      action: INFRA_ALERT_ACTIONS.node_unexpected_reboot,
    });
    expect(
      (await infrastructureAlertStatus(env.DB, f.region)).find(
        (value) => value.kind === "node_unexpected_reboot",
      ),
    ).toMatchObject({ active: true, delivered_at: null });
  });

  it("is an unexpected reboot also when the node never sampled, or a maintenance order ended before its last sample", async () => {
    const f = await fixture();
    await env.DB.prepare("UPDATE nodes SET last_observed_at=NULL WHERE id=?")
      .bind(f.node)
      .run();
    expect((await reboot(f)).expected_reboot).toBe(false);
    await sampled(f, ago(2 * MINUTE));
    await maintenance(f, ago(30 * MINUTE), ago(10 * MINUTE));
    expect(
      (await reboot(f, report({ boot_id: crypto.randomUUID() })))
        .expected_reboot,
    ).toBe(false);
  });

  it("is not raised for a maintenance order that was open at the node's last sample", async () => {
    const f = await fixture();
    await sampled(f, ago(2 * MINUTE));
    await maintenance(f, ago(30 * MINUTE));
    expect((await reboot(f)).expected_reboot).toBe(true);
    expect((await stored(f))[0]?.expected_reboot).toBe(1);
    expect(await episode(f)).toBeNull();
  });

  it("is expected too when the order ended after that sample", async () => {
    const f = await fixture();
    await sampled(f, ago(2 * MINUTE));
    await maintenance(f, ago(30 * MINUTE), ago(MINUTE));
    expect((await reboot(f)).expected_reboot).toBe(true);
    expect(await episode(f)).toBeNull();
  });

  it("is not blamed on an order made after the last sample while the node was down", async () => {
    const f = await fixture();
    await sampled(f, ago(10 * MINUTE));
    await maintenance(f, ago(5 * MINUTE));
    expect((await reboot(f)).expected_reboot).toBe(false);
  });

  it("reads the sample of the previous boot, not the first sample of this one", async () => {
    const f = await fixture();
    // The previous boot's last sample is 4 minutes old; the boot began 3 minutes ago and its first
    // sample is 1 minute old; the order ended 2 minutes ago, between the two samples.
    await sampled(f, ago(4 * MINUTE));
    await maintenance(f, ago(30 * MINUTE), ago(2 * MINUTE));
    const socket = await started(f, ago(3 * MINUTE));
    expect((await reboot(f)).expected_reboot).toBe(true);
    socket.close(1000);
  });

  it("is not blamed on an order made while the node was down, also when this boot has said hello and sampled, or its agent restarted", async () => {
    const f = await fixture();
    await sampled(f, ago(10 * MINUTE));
    await maintenance(f, ago(5 * MINUTE));
    (await started(f, ago(3 * MINUTE))).close(1000);
    // The agent starts again within the boot and says hello again, and its report goes out then.
    const socket = await started(f, ago(3 * MINUTE));
    expect((await reboot(f)).expected_reboot).toBe(false);
    socket.close(1000);
  });

  it("claims no reboot of a node whose agent knew no earlier boot", async () => {
    const f = await fixture();
    await sampled(f, ago(MINUTE));
    const answer = await reboot(f, report({ previous_boot_id: null }));
    expect(answer.expected_reboot).toBeNull();
    expect((await stored(f))[0]).toMatchObject({
      previous_boot_id: null,
      expected_reboot: null,
    });
    expect(await episode(f)).toBeNull();
  });

  it("holds the episode of a node that rebooted for 24 hours", async () => {
    const f = await fixture();
    await reboot(f);
    expect((await episode(f))?.active).toBe(true);
    await env.DB.prepare(
      "UPDATE node_diagnostics SET received_at=? WHERE node_id=?",
    )
      .bind(ago(25 * 60 * MINUTE), f.node)
      .run();
    expect((await episode(f))?.active).toBe(false);
  });

  it("is stored once for a boot, and a report sent again is answered with the stored one", async () => {
    const f = await fixture();
    await sampled(f, ago(2 * MINUTE));
    const first = await reboot(f);
    expect(first.expected_reboot).toBe(false);
    // The answer was lost, and the agent sends the report again when an order is open.
    await maintenance(f, ago(30 * MINUTE));
    expect(await reboot(f)).toEqual(first);
    expect(await stored(f)).toHaveLength(1);
    // Another node's report of the same boot ID is its own.
    const other = await fixture();
    expect((await reboot(other)).id).not.toBe(first.id);
    expect(await stored(other)).toHaveLength(1);
  });

  it("is refused when it breaks the contract, whatever the size of its body", async () => {
    const f = await fixture();
    const full = { ...entry, message: "a".repeat(2048) };
    for (const broken of [
      report({ entries: [{ ...entry, priority: 8 }] }),
      report({ entries: [{ ...entry, message: "é".repeat(1025) }] }),
      report({ entries: Array.from({ length: 1001 }, () => entry) }),
      report({ entries: Array.from({ length: 1000 }, () => full) }),
      { ...report(), extra: true },
      report({ boot_id: "boot" }),
    ]) {
      const answer = await send(f, broken);
      expect(answer.status, JSON.stringify(broken).slice(0, 80)).toBe(400);
    }
    expect(
      JSON.stringify(
        report({ entries: Array.from({ length: 1000 }, () => full) }),
      ).length,
    ).toBeGreaterThan(NODE_BOOT_REPORT_MAX_BYTES);
    expect(await stored(f)).toEqual([]);
  });

  it("is kept whole at the largest size the contract allows", async () => {
    const f = await fixture();
    const full = { ...entry, message: "a".repeat(2048) };
    // As many full lines as fit under the cap, which a row of D1 holds and a read returns whole.
    let lines = Math.floor(
      (NODE_BOOT_REPORT_MAX_BYTES -
        JSON.stringify(report({ entries: [] })).length) /
        (JSON.stringify(full).length + 1),
    );
    while (
      JSON.stringify(
        report({ entries: Array.from({ length: lines + 1 }, () => full) }),
      ).length <= NODE_BOOT_REPORT_MAX_BYTES
    )
      lines++;
    const largest = report({
      entries: Array.from({ length: lines }, () => full),
    });
    expect(JSON.stringify(largest).length).toBeLessThanOrEqual(
      NODE_BOOT_REPORT_MAX_BYTES,
    );
    expect(
      NODE_BOOT_REPORT_MAX_BYTES - JSON.stringify(largest).length,
    ).toBeLessThan(JSON.stringify(full).length + 1);
    const made = await reboot(f, largest);
    const read = await request(
      `/v1/nodes/${f.node}/diagnostics/${made.id}`,
      f.admin,
    );
    expect(read.status).toBe(200);
    expect(((await read.json()) as { report: unknown }).report).toEqual(
      largest,
    );
  });

  it("is refused for a request the node did not sign", async () => {
    const f = await fixture();
    const unsigned = await nodeRequest(f, "/node/v1/diagnostics", {
      method: "POST",
      body: report(),
      key: (await fixture()).nodeKey,
    });
    expect(unsigned.status).toBe(401);
    expect(await stored(f)).toEqual([]);
  });
});

describe("the diagnostics of a node", () => {
  it("are listed newest first and read one by one by an administrator", async () => {
    const f = await fixture();
    await sampled(f, ago(MINUTE));
    const first = await reboot(
      f,
      report({ boot_id: PREVIOUS, previous_boot_id: BOOT }),
    );
    const second = await reboot(f);
    const list = await request(
      `/v1/nodes/${f.node}/diagnostics?limit=1`,
      f.admin,
    );
    expect(list.status).toBe(200);
    const page = await list.json<{
      data: Record<string, unknown>[];
      next_cursor: string | null;
    }>();
    expect(page.data).toEqual([
      {
        id: second.id,
        node_id: f.node,
        kind: "boot",
        boot_id: BOOT,
        previous_boot_id: PREVIOUS,
        received_at: expect.any(String),
        expected_reboot: false,
      },
    ]);
    expect(page.data[0]).not.toHaveProperty("report");
    expect(page.next_cursor).not.toBeNull();
    const rest = await (
      await request(
        `/v1/nodes/${f.node}/diagnostics?limit=1&cursor=${encodeURIComponent(page.next_cursor!)}`,
        f.admin,
      )
    ).json<{ data: { id: string }[]; next_cursor: string | null }>();
    expect(rest.data.map((row) => row.id)).toEqual([first.id]);
    expect(rest.next_cursor).toBeNull();
    const one = await request(
      `/v1/nodes/${f.node}/diagnostics/${second.id}`,
      f.admin,
    );
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ ...page.data[0], report: report() });
  });

  it("are not found by an integrator's key, for a node that is not there, or under another node", async () => {
    const f = await fixture(),
      other = await fixture();
    const made = await reboot(f);
    for (const key of [f.integrator, f.otherKey]) {
      expect(
        (await request(`/v1/nodes/${f.node}/diagnostics`, key)).status,
      ).toBe(404);
      expect(
        (await request(`/v1/nodes/${f.node}/diagnostics/${made.id}`, key))
          .status,
      ).toBe(404);
    }
    expect(
      (await request(`/v1/nodes/${other.node}/diagnostics/${made.id}`, f.admin))
        .status,
    ).toBe(404);
    expect(
      (await request(`/v1/nodes/nod_${"z".repeat(20)}/diagnostics`, f.admin))
        .status,
    ).toBe(404);
    expect(
      (
        await request(
          `/v1/nodes/${f.node}/diagnostics/${crypto.randomUUID()}`,
          f.admin,
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(`/v1/nodes/${f.node}/diagnostics`, "pgcf_sk_bad")).status,
    ).toBe(401);
  });

  it("are deleted by the minute cron after 30 days", async () => {
    const f = await fixture();
    const old = await reboot(
        f,
        report({ boot_id: PREVIOUS, previous_boot_id: BOOT }),
      ),
      recent = await reboot(f);
    await env.DB.prepare("UPDATE node_diagnostics SET received_at=? WHERE id=?")
      .bind(ago(30 * 24 * 60 * MINUTE + MINUTE), old.id)
      .run();
    await env.DB.prepare("UPDATE node_diagnostics SET received_at=? WHERE id=?")
      .bind(ago(29 * 24 * 60 * MINUTE), recent.id)
      .run();
    await runCron(env, Date.now());
    const left = await env.DB.prepare(
      "SELECT id FROM node_diagnostics WHERE node_id=?",
    )
      .bind(f.node)
      .all<{ id: string }>();
    expect(left.results.map((row) => row.id)).toEqual([recent.id]);
  });
});
