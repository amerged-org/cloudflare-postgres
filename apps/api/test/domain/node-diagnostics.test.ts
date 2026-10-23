// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  INFRA_ALERT_ACTIONS,
  InfraAlert,
  NODE_BOOT_REPORT_MAX_BYTES,
  NODE_DIAGNOSTIC_ROW_MAX_BYTES,
  NODE_PROBE_RESULT_MAX_BYTES,
  NodeDiagnostic,
  NodeProbeDiagnostic,
  newOperationId,
} from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
import { evaluateAlerts } from "../../src/cron-watchdog.ts";
import { infrastructureAlertStatus } from "../../src/domain/infrastructure-alerts.ts";
import {
  cleanupFixtures,
  desiredPage,
  fixture,
  nodeOs,
  nodeRequest,
  nodeSample,
  request,
} from "./fixtures.ts";
import { heldLink, nextMessage, openLink } from "./node-fixtures.ts";

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
 * The agent of the node says hello over a new link, on the boot `BOOT` unless the change names
 * another, and the link stays open for the caller to close.
 */
async function greeted(f: F, change: Record<string, unknown> = {}) {
  const socket = await openLink(f, false);
  const welcome = nextMessage(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      agent_version: "0.1.0",
      release_id: null,
      os: nodeOs({ boot_id: BOOT, ...change }),
    }),
  );
  await welcome;
  return socket;
}
const observedAt = (f: F) =>
  env.DB.prepare("SELECT last_observed_at FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string | null>("last_observed_at");
/** Waits until `done` holds, up to two seconds. */
async function until(done: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("not_reached");
}
/**
 * The node's agent, started at `bootedAt` on the boot `BOOT`: its hello says so over the link, and
 * its first sample, a minute old, is stored. The link stays open for the caller to close.
 */
async function started(f: F, bootedAt: string) {
  const socket = await greeted(f, { booted_at: bootedAt });
  const observed = ago(MINUTE);
  socket.send(
    JSON.stringify({
      type: "sample",
      sample: nodeSample(Date.parse(observed)),
    }),
  );
  await until(async () => (await observedAt(f)) === observed);
  return socket;
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
const BOOT_COLUMNS = [
  "id",
  "node_id",
  "kind",
  "boot_id",
  "previous_boot_id",
  "received_at",
  "expected_reboot",
  "body",
];
const REQUEST_COLUMNS = [
  "id",
  "node_id",
  "probe",
  "boot",
  "since_seconds",
  "lines",
  "requested_by_key_id",
  "requested_at",
  "received_at",
  "body",
];
/**
 * The bytes of the `INSERT` statement that a dump of the control database writes for one row:
 * SQLite's own quote() writes the values (single quotes doubled), as its dump and D1's export do.
 * D1 refuses a statement above 100,000 bytes when such a dump is imported.
 */
const dumped = (table: string, id: string, columns: string[]) =>
  env.DB.prepare(
    `SELECT length(CAST('INSERT INTO "${table}" VALUES(' || ${columns
      .map((column) => `quote(${column})`)
      .join(" || ',' || ")} || ');' AS BLOB)) bytes FROM ${table} WHERE id=?`,
  )
    .bind(id)
    .first<number>("bytes")
    .then((bytes) => bytes!);
/**
 * The agent's report of a reboot. Its hello of the new boot has reached the API first, as the API
 * requires (the agent sends the report again until it has).
 */
const reboot = async (f: F, body: ReturnType<typeof report> = report()) => {
  const stored = await env.DB.prepare("SELECT os_boot_id FROM nodes WHERE id=?")
    .bind(f.node)
    .first<string | null>("os_boot_id");
  if (stored !== body.boot_id)
    (await greeted(f, { boot_id: body.boot_id })).close(1000);
  return (await send(f, body)).json<{
    id: string;
    expected_reboot: boolean | null;
  }>();
};
const episode = async (f: F) => {
  await evaluateAlerts(env);
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
    (await greeted(f)).close(1000);
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

  it("waits for the hello of its boot, and is then judged by the newest sample the actor holds", async () => {
    const f = await fixture();
    // Both samples fall into one minute that has a few seconds to run, so that D1 holds the first
    // until the minute's alarm: from 4 s to 40 s into a minute, or wait for the next one's 5 s.
    const phase = Date.now() % MINUTE;
    if (phase < 4_000 || phase > MINUTE - 20_000)
      await new Promise((resolve) =>
        setTimeout(resolve, (5_000 - phase + MINUTE) % MINUTE),
      );
    const now = Date.now(),
      iso = (at: number) => new Date(at).toISOString();
    const sample = (at: number) =>
      JSON.stringify({ type: "sample", sample: nodeSample(at) });
    // The previous boot samples, an order is made, and the node samples again before it goes down.
    const before = await greeted(f, { boot_id: PREVIOUS });
    before.send(sample(now - 3_000));
    await until(async () => (await observedAt(f)) === iso(now - 3_000));
    // The actor opens the node after it writes the first sample; later samples wait for the alarm.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await maintenance(f, iso(now - 2_000));
    before.send(sample(now - 1_000));
    await until(
      async () =>
        (await heldLink(f.node)).sample?.observed_at === iso(now - 1_000),
    );
    expect(await observedAt(f)).toBe(iso(now - 3_000));
    before.close(1000);

    // The report is at the API before the hello of the new boot: the newest sample is not in D1
    // yet, so it is sent again.
    const early = await send(f, report());
    expect(early.status).toBe(503);
    expect(early.headers.get("Retry-After")).toBe("5");
    expect(await early.json()).toMatchObject({
      error: { code: "capacity_exhausted", details: { reason: "not_ready" } },
    });
    expect(await stored(f)).toEqual([]);

    // The hello stores the sample the actor holds as the end of the previous boot: the order was
    // open at it.
    (await greeted(f)).close(1000);
    expect((await reboot(f)).expected_reboot).toBe(true);
    expect(await episode(f)).toBeNull();
  }, 60_000);

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

  it("is kept whole while its row fits the bound of a backup, and cut to the newest lines when it does not", async () => {
    // Every line holds a multibyte letter (2 bytes, 1 character) and a quote (written twice in a
    // dump): counting characters, or leaving out the doubled quote, would put the row over.
    const line = (i: number) => ({
      ...entry,
      message: `line ${String(i).padStart(4, "0")} ${"\u00e9'x".repeat(40)}`,
    });
    const lines = (count: number) =>
      Array.from({ length: count }, (_, i) => line(i));
    const rowOf = async (count: number) => {
      const f = await fixture();
      const made = await reboot(f, report({ entries: lines(count) }));
      return {
        f,
        made,
        bytes: await dumped("node_diagnostics", made.id, BOOT_COLUMNS),
      };
    };
    // What one more line costs a row, and how many lines make the largest row that fits.
    const [one, two] = [await rowOf(1), await rowOf(2)];
    const cost = two.bytes - one.bytes;
    const fits =
      1 + Math.floor((NODE_DIAGNOSTIC_ROW_MAX_BYTES - one.bytes) / cost);
    const whole = await rowOf(fits);
    expect(whole.bytes).toBeLessThanOrEqual(NODE_DIAGNOSTIC_ROW_MAX_BYTES);
    expect(NODE_DIAGNOSTIC_ROW_MAX_BYTES - whole.bytes).toBeLessThan(cost);
    expect(JSON.parse((await stored(whole.f))[0]!.body)).toEqual(
      report({ entries: lines(fits) }),
    );
    // One line more does not fit: the newest lines are kept, as many as fit with the mark.
    const cut = await rowOf(fits + 1);
    const body = JSON.parse((await stored(cut.f))[0]!.body) as {
      entries: unknown[];
      truncated?: boolean;
      dropped_entries?: number;
    };
    expect(cut.bytes).toBeLessThanOrEqual(NODE_DIAGNOSTIC_ROW_MAX_BYTES);
    expect(NODE_DIAGNOSTIC_ROW_MAX_BYTES - cut.bytes).toBeLessThan(cost);
    expect(body.truncated).toBe(true);
    expect(body.dropped_entries).toBeGreaterThanOrEqual(1);
    expect(body.entries).toEqual(lines(fits + 1).slice(body.dropped_entries));
    expect(body.entries.length + body.dropped_entries!).toBe(fits + 1);
    // The operator reads what was stored, and sees the cut.
    const read = await request(
      `/v1/nodes/${cut.f.node}/diagnostics/${cut.made.id}`,
      cut.f.admin,
    );
    expect(read.status).toBe(200);
    const answer = NodeDiagnostic.parse(await read.json());
    expect(answer.report).toMatchObject({
      truncated: true,
      dropped_entries: body.dropped_entries,
    });
    expect(answer.report.entries).toEqual(body.entries);
  });

  it("answers a report of 1 MiB like any other and keeps the newest lines of it", async () => {
    const f = await fixture();
    // The largest report the contract allows: as many full lines as fit 1 MiB.
    const full = { ...entry, message: "a".repeat(2048) };
    const count = Math.floor(
      (NODE_BOOT_REPORT_MAX_BYTES -
        JSON.stringify(report({ entries: [] })).length) /
        (JSON.stringify(full).length + 1),
    );
    // A node that knew no earlier boot sends no previous boot: its row holds two NULLs.
    const largest = report({
      previous_boot_id: null,
      entries: Array.from({ length: count }, (_, i) => ({
        ...full,
        message: `${String(i).padStart(4, "0")}${"a".repeat(2044)}`,
      })),
    });
    expect(JSON.stringify(largest).length).toBeLessThanOrEqual(
      NODE_BOOT_REPORT_MAX_BYTES,
    );
    const made = await reboot(f, largest);
    expect(made.id).toEqual(expect.any(String));
    const [row] = await stored(f);
    const body = JSON.parse(row!.body) as {
      entries: { message: string }[];
      dropped_entries: number;
    };
    expect(
      await dumped("node_diagnostics", made.id, BOOT_COLUMNS),
    ).toBeLessThanOrEqual(NODE_DIAGNOSTIC_ROW_MAX_BYTES);
    expect(body.entries.at(-1)!.message.slice(0, 4)).toBe(
      String(count - 1).padStart(4, "0"),
    );
    expect(body.entries.length + body.dropped_entries).toBe(count);
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

  it("are deleted by the alert evaluation after 30 days", async () => {
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
    await evaluateAlerts(env);
    const left = await env.DB.prepare(
      "SELECT id FROM node_diagnostics WHERE node_id=?",
    )
      .bind(f.node)
      .all<{ id: string }>();
    expect(left.results.map((row) => row.id)).toEqual([recent.id]);
  });
});

const LISTENERS = "tcp   LISTEN 0      4096   127.0.0.1:8443     0.0.0.0:*\n";
/** An administrator asks the node of `f` for a probe. */
const ask = (f: F, body: unknown = { probe: "listeners" }, key = f.admin) =>
  request(`/v1/nodes/${f.node}/diagnostics`, key, "POST", body);
const asked = async (f: F, body?: unknown) => {
  const answer = await ask(f, body);
  expect(answer.status).toBe(202);
  return (await answer.json<{ diagnostic_id: string }>()).diagnostic_id;
};
/** The result the agent posts for a request. */
const probed = (id: string, change: Record<string, unknown> = {}) => ({
  kind: "probe",
  diagnostic_id: id,
  probe: "listeners",
  status: "ok",
  entries: [],
  text: LISTENERS,
  ...change,
});
const reading = (f: F, id: string, key = f.admin) =>
  request(`/v1/nodes/${f.node}/diagnostics/${id}`, key);
const requests = (f: F) =>
  env.DB.prepare(
    "SELECT id,probe,boot,since_seconds,lines,requested_by_key_id,received_at,body FROM node_diagnostic_requests WHERE node_id=? ORDER BY requested_at,id",
  )
    .bind(f.node)
    .all<{
      id: string;
      probe: string;
      boot: number;
      since_seconds: number;
      lines: number;
      requested_by_key_id: string;
      received_at: string | null;
      body: string | null;
    }>()
    .then((rows) => rows.results);
const keyIdOf = (key: string) =>
  env.DB.prepare("SELECT id FROM api_keys WHERE lookup_id=?")
    .bind(key.split("_")[2])
    .first<string>("id");
const askedAt = (id: string, at: string) =>
  env.DB.prepare(
    "UPDATE node_diagnostic_requests SET requested_at=? WHERE id=?",
  )
    .bind(at, id)
    .run();

describe("a probe on request", () => {
  it("is accepted from an administrator, records the key that asked, and tells the node to pull its page", async () => {
    const f = await fixture();
    const socket = await openLink(f);
    const hint = nextMessage(socket);
    const answer = await ask(f, {
      probe: "journal",
      boot: -1,
      since_seconds: 120,
      lines: 50,
    });
    expect(answer.status).toBe(202);
    const { diagnostic_id } = await answer.json<{ diagnostic_id: string }>();
    expect(JSON.parse(await hint)).toEqual({ type: "desired" });
    expect(await requests(f)).toEqual([
      {
        id: diagnostic_id,
        probe: "journal",
        boot: -1,
        since_seconds: 120,
        lines: 50,
        requested_by_key_id: await keyIdOf(f.admin),
        received_at: null,
        body: null,
      },
    ]);
    socket.close(1000);
  });

  it("takes the defaults for the numbers left out", async () => {
    const f = await fixture();
    await asked(f, { probe: "boots" });
    expect(await requests(f)).toMatchObject([
      { probe: "boots", boot: 0, since_seconds: 3600, lines: 200 },
    ]);
  });

  it("is refused for an unknown probe, a number out of range, or a field the contract does not have", async () => {
    const f = await fixture();
    const probe = "journal";
    for (const body of [
      {},
      { probe: "shell" },
      { probe: "journal; id" },
      { probe, boot: 1 },
      { probe, boot: -2 },
      { probe, boot: "0" },
      { probe, since_seconds: 59 },
      { probe, since_seconds: 86_401 },
      { probe, since_seconds: 60.5 },
      { probe, lines: 0 },
      { probe, lines: 2001 },
      { probe, command: "ss -p" },
      { probe, path: "/etc/shadow" },
      { probe, unit: "pgcf-pg@aaaaaaaaaaaaaaaaaaaa.service" },
    ]) {
      expect((await ask(f, body)).status, JSON.stringify(body)).toBe(400);
    }
    // The ends of the ranges are in.
    for (const body of [
      { probe, boot: 0, since_seconds: 60, lines: 1 },
      { probe, boot: -1, since_seconds: 86_400, lines: 2000 },
    ])
      expect((await ask(f, body)).status, JSON.stringify(body)).toBe(202);
    expect(await requests(f)).toHaveLength(2);
  });

  it("is not made, nor read, by an integrator's key: it is not found", async () => {
    const f = await fixture(),
      other = await fixture();
    const id = await asked(f);
    for (const key of [f.integrator, f.otherKey]) {
      expect((await ask(f, undefined, key)).status).toBe(404);
      expect((await reading(f, id, key)).status).toBe(404);
    }
    expect(await requests(f)).toHaveLength(1);
    expect((await ask(f, undefined, "pgcf_sk_bad")).status).toBe(401);
    // A node that is not there, and a request under another node, are not found either.
    expect(
      (
        await request(
          `/v1/nodes/nod_${"z".repeat(20)}/diagnostics`,
          f.admin,
          "POST",
          { probe: "boots" },
        )
      ).status,
    ).toBe(404);
    expect((await reading(other, id)).status).toBe(404);
  });

  it("is on the desired page of its node exactly once until the node answers it", async () => {
    const f = await fixture(),
      other = await fixture();
    const id = await asked(f, { probe: "kernel", boot: -1, lines: 30 });
    const request = {
      id,
      probe: "kernel",
      boot: -1,
      since_seconds: 3600,
      lines: 30,
    };
    expect((await desiredPage(f)).diagnostics).toEqual([request]);
    // Pulled again: still there once. Another node has none.
    expect((await desiredPage(f)).diagnostics).toEqual([request]);
    expect((await desiredPage(other)).diagnostics).toBeUndefined();
    // A pull of named databases, which is a wake's, and a later page do not carry them.
    for (const query of [
      "?ids=aaaaaaaaaaaaaaaaaaaa",
      "?after=aaaaaaaaaaaaaaaaaaaa",
    ])
      expect((await desiredPage(f, query)).diagnostics, query).toBeUndefined();
    const answer = await send(f, probed(id, { probe: "kernel" }));
    expect(answer.status).toBe(200);
    expect((await desiredPage(f)).diagnostics).toBeUndefined();
  });

  it("is listed eight at a time, the oldest first", async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await asked(f);
      await askedAt(id, ago(9 * MINUTE - i * 1000));
      ids.push(id);
    }
    const listed = async () =>
      (await desiredPage(f)).diagnostics?.map((request) => request.id);
    expect(await listed()).toEqual(ids.slice(0, 8));
    expect((await send(f, probed(ids[0]!))).status).toBe(200);
    expect(await listed()).toEqual(ids.slice(1, 9));
  });

  it("is requested, then received with the result, as the API reads it", async () => {
    const f = await fixture();
    const id = await asked(f, { probe: "journal", lines: 5 });
    const waiting = NodeProbeDiagnostic.parse(
      await (await reading(f, id)).json(),
    );
    expect(waiting).toEqual({
      id,
      node_id: f.node,
      kind: "probe",
      probe: "journal",
      boot: 0,
      since_seconds: 3600,
      lines: 5,
      requested_by: await keyIdOf(f.admin),
      requested_at: expect.any(String),
      status: "requested",
      received_at: null,
      body: null,
    });
    const result = probed(id, {
      probe: "journal",
      entries: [entry],
      text: "",
    });
    expect((await send(f, result)).status).toBe(200);
    const done = NodeProbeDiagnostic.parse(await (await reading(f, id)).json());
    expect(done).toMatchObject({ id, status: "received", body: result });
    expect(done.received_at).toEqual(expect.any(String));
  });

  it("is expired after ten minutes without an answer, and leaves the page", async () => {
    const f = await fixture();
    const id = await asked(f);
    const status = async () =>
      (await (await reading(f, id)).json<{ status: string }>()).status;
    await askedAt(id, ago(10 * MINUTE - 5000));
    expect(await status()).toBe("requested");
    expect((await desiredPage(f)).diagnostics).toHaveLength(1);
    await askedAt(id, ago(10 * MINUTE + 1000));
    expect(await status()).toBe("expired");
    expect(
      (await reading(f, id).then((r) => r.json())) as object,
    ).toMatchObject({
      received_at: null,
      body: null,
    });
    expect((await desiredPage(f)).diagnostics).toBeUndefined();
  });

  it("keeps the answer of a probe that ran just before it expired", async () => {
    const f = await fixture();
    const id = await asked(f);
    await askedAt(id, ago(10 * MINUTE + 1000));
    expect((await send(f, probed(id))).status).toBe(200);
    expect(
      (await (await reading(f, id)).json<{ status: string }>()).status,
    ).toBe("received");
  });

  it("is answered once: a second answer is accepted and the first stays", async () => {
    const f = await fixture();
    const id = await asked(f);
    expect((await send(f, probed(id))).status).toBe(200);
    expect((await send(f, probed(id, { text: "other\n" }))).status).toBe(200);
    const [row] = await requests(f);
    expect(JSON.parse(row!.body!).text).toBe(LISTENERS);
  });

  it("is refused a result over 1 MiB, or one that breaks the contract", async () => {
    const f = await fixture();
    const id = await asked(f);
    const fits =
      NODE_PROBE_RESULT_MAX_BYTES -
      JSON.stringify(probed(id, { text: "" })).length;
    expect(
      (await send(f, probed(id, { text: "a".repeat(fits + 1) }))).status,
    ).toBe(400);
    expect(
      (
        await send(
          f,
          probed(id, { text: "a".repeat(NODE_PROBE_RESULT_MAX_BYTES) }),
        )
      ).status,
    ).toBe(400);
    for (const broken of [
      { ...probed(id), extra: true },
      probed(id, { probe: "shell" }),
      probed(id, { status: "partial" }),
      probed(id, { entries: Array.from({ length: 2001 }, () => entry) }),
      probed(id, { entries: [{ ...entry, message: "\u00e9".repeat(1025) }] }),
      probed("not-an-id"),
    ])
      expect(
        (await send(f, broken)).status,
        JSON.stringify(broken).slice(0, 80),
      ).toBe(400);
    expect((await requests(f))[0]!.body).toBeNull();
    // Exactly 1 MiB is accepted; the row keeps what fits a backup of it (below).
    expect((await send(f, probed(id, { text: "a".repeat(fits) }))).status).toBe(
      200,
    );
    const read = await (
      await reading(f, id)
    ).json<{ body: { text: string; truncated?: boolean } }>();
    expect(read.body.truncated).toBe(true);
    expect(read.body.text.length).toBeLessThan(fits);
  });

  it("keeps the newest entries of a journal result that does not fit the bound of a backup, and says how many went", async () => {
    const f = await fixture();
    const id = await asked(f, { probe: "journal", lines: 2000 });
    // 2000 lines of 300 bytes are about 900 KB: under the 1 MiB a node may send.
    const lines = Array.from({ length: 2000 }, (_, i) => ({
      ...entry,
      message: `line ${String(i).padStart(4, "0")} ${"\u00e9'x".repeat(75)}`,
    }));
    const result = probed(id, { probe: "journal", entries: lines, text: "" });
    expect(JSON.stringify(result).length).toBeLessThan(
      NODE_PROBE_RESULT_MAX_BYTES,
    );
    expect((await send(f, result)).status).toBe(200);
    const [row] = await requests(f);
    const body = JSON.parse(row!.body!) as {
      entries: unknown[];
      truncated?: boolean;
      dropped_entries?: number;
    };
    const bytes = await dumped("node_diagnostic_requests", id, REQUEST_COLUMNS);
    expect(bytes).toBeLessThanOrEqual(NODE_DIAGNOSTIC_ROW_MAX_BYTES);
    // Another line would not have fit: a line is about 700 bytes in a dump.
    expect(NODE_DIAGNOSTIC_ROW_MAX_BYTES - bytes).toBeLessThan(750);
    expect(body.truncated).toBe(true);
    expect(body.dropped_entries).toBeGreaterThan(1000);
    expect(body.entries).toEqual(lines.slice(body.dropped_entries));
    const read = NodeProbeDiagnostic.parse(await (await reading(f, id)).json());
    expect(read.body).toMatchObject({
      truncated: true,
      dropped_entries: body.dropped_entries,
    });
  });

  it("keeps the beginning of a text that does not fit, on a character boundary, and marks it with no entry dropped", async () => {
    const f = await fixture();
    const id = await asked(f);
    // Letters of 2 and 4 bytes, a quote, a tab and a line break (a JSON escape each): about 900 KB.
    const unit = "ss 'x' \u00e9 \u{1f600}\t\n";
    const unitBytes = new TextEncoder().encode(JSON.stringify(unit)).length - 2;
    const text = unit.repeat(Math.floor(900_000 / unitBytes));
    expect(
      new TextEncoder().encode(JSON.stringify(probed(id, { text }))).length,
    ).toBeLessThan(NODE_PROBE_RESULT_MAX_BYTES);
    expect((await send(f, probed(id, { text }))).status).toBe(200);
    const [row] = await requests(f);
    const body = JSON.parse(row!.body!) as {
      text: string;
      entries: unknown[];
      truncated?: boolean;
      dropped_entries?: number;
    };
    const bytes = await dumped("node_diagnostic_requests", id, REQUEST_COLUMNS);
    expect(bytes).toBeLessThanOrEqual(NODE_DIAGNOSTIC_ROW_MAX_BYTES);
    // The next character costs at most 6 bytes (the JSON escape of a control character), and a
    // surrogate pair that the cut would split costs 4 more.
    expect(NODE_DIAGNOSTIC_ROW_MAX_BYTES - bytes).toBeLessThan(12);
    expect(body).toMatchObject({
      entries: [],
      truncated: true,
      dropped_entries: 0,
    });
    expect(text.startsWith(body.text)).toBe(true);
    // No half of a surrogate pair: the text round-trips through UTF-8.
    expect(new TextDecoder().decode(new TextEncoder().encode(body.text))).toBe(
      body.text,
    );
  });

  it("is answered by its own node, with its own probe, and by none that did not ask", async () => {
    const f = await fixture(),
      other = await fixture();
    const id = await asked(f);
    expect((await send(other, probed(id))).status).toBe(404);
    expect((await send(f, probed(crypto.randomUUID()))).status).toBe(404);
    expect((await send(f, probed(id, { probe: "pool" }))).status).toBe(400);
    expect((await requests(f))[0]!.body).toBeNull();
  });

  it("is deleted after 30 days, by the next request for a probe of any node", async () => {
    const f = await fixture(),
      other = await fixture();
    const old = await asked(f),
      recent = await asked(f);
    await askedAt(old, ago(30 * 24 * 60 * MINUTE + MINUTE));
    await askedAt(recent, ago(29 * 24 * 60 * MINUTE));
    // The minute cron leaves them, and a request for another node's probe takes the old one.
    await runCron(env, Date.now());
    expect((await requests(f)).map((row) => row.id)).toEqual([old, recent]);
    const next = await asked(other);
    expect((await requests(f)).map((row) => row.id)).toEqual([recent]);
    expect((await requests(other)).map((row) => row.id)).toEqual([next]);
  });
});
