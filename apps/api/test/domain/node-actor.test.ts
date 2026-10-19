// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { NodeSample, newDatabaseId } from "@pgcf/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  foldSample,
  NODE_HEADER,
  NODE_UID_HEADER,
} from "../../src/node-actor.ts";
import {
  choosePlacement,
  placementNodes,
  type PlacementNeed,
} from "../../src/domain/placement.ts";
import {
  assignRelease,
  RELEASE_OS,
  cleanupFixtures,
  fixture,
  nodeOs,
  nodeRequest,
  nodeSample,
  request,
} from "./fixtures.ts";
import {
  enroll,
  forgetInstalls,
  heldLink,
  installed,
  nextMessage as next,
  openLink as connect,
} from "./node-fixtures.ts";

const releases: string[] = [];
afterEach(async () => {
  await forgetInstalls();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

const MINUTE = 60_000;
const placementNeed: PlacementNeed = {
  memory_mib: 256,
  cpu_millicores: 500,
  storage_gib: 5,
};
const actor = (node: string) =>
  env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(node));
const closed = (socket: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener(
      "close",
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    ),
  );
const hello = (
  release: string | null = null,
  os: Record<string, unknown> = nodeOs(),
) =>
  JSON.stringify({
    type: "hello",
    protocol: 1,
    agent_version: "0.1.0",
    release_id: release,
    os,
  });
const sampleMessage = (at: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "sample", sample: nodeSample(at, extra) });

const minutes = (node: string) =>
  env.DB.prepare("SELECT * FROM node_minutes WHERE node_id=? ORDER BY minute")
    .bind(node)
    .all<Record<string, number | null>>()
    .then((rows) => rows.results);
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition_not_met");
};

describe("the link of a node", () => {
  it("answers a hello with a welcome and records the agent and the release it runs", async () => {
    const f = await fixture(0);
    const socket = await connect(f, false);
    const welcome = next(socket);
    socket.send(hello("release-1-2-0"));
    expect(JSON.parse(await welcome)).toEqual({ type: "welcome", protocol: 1 });
    expect(
      await env.DB.prepare(
        "SELECT agent_version,reported_release_id FROM nodes WHERE id=?",
      )
        .bind(f.node)
        .first(),
    ).toEqual({ agent_version: "0.1.0", reported_release_id: "release-1-2-0" });
    socket.close(1000);
  });

  it("stores the boot and the operating system a hello reports, and says whether they are its region's release", async () => {
    const f = await fixture(0);
    const inventory = async () => {
      const { os, os_converged } = await (
        await request(`/v1/nodes/${f.node}`, f.admin)
      ).json<{
        os: Record<string, string> | null;
        os_converged: boolean | null;
      }>();
      return { os, os_converged };
    };
    const said = async (os: Record<string, unknown>) => {
      const socket = await connect(f, false);
      const welcome = next(socket);
      socket.send(hello(null, os));
      expect(JSON.parse(await welcome)).toEqual({
        type: "welcome",
        protocol: 1,
      });
      return socket;
    };
    // Nothing reported yet: nothing to compare.
    expect(await inventory()).toEqual({ os: null, os_converged: null });

    // The region has no release: the node's OS is known, and has nothing to be compared with.
    const old = nodeOs({ kernel_release: "6.12.111+deb13-amd64" });
    let socket = await said(old);
    expect(
      await env.DB.prepare(
        "SELECT os_boot_id,os_booted_at,os_kernel_release,os_packages_sha256 FROM nodes WHERE id=?",
      )
        .bind(f.node)
        .first(),
    ).toEqual({
      os_boot_id: old.boot_id,
      os_booted_at: old.booted_at,
      os_kernel_release: old.kernel_release,
      os_packages_sha256: old.packages_sha256,
    });
    expect(await inventory()).toEqual({ os: old, os_converged: null });

    // The release names another kernel: not converged. A kernel that matches with other packages
    // is not either; the release's kernel and packages together are.
    releases.push(await assignRelease(f));
    expect(await inventory()).toEqual({ os: old, os_converged: false });
    for (const [os, converged] of [
      [nodeOs({ packages_sha256: "e".repeat(64) }), false],
      [nodeOs(), true],
    ] as const) {
      socket.close(1000);
      socket = await said(os);
      expect(await inventory()).toEqual({ os, os_converged: converged });
      expect(os.kernel_release).toBe(RELEASE_OS.kernel_release);
    }
    socket.close(1000);
  });

  it("closes a link on anything but a hello and then samples", async () => {
    const f = await fixture(0);
    for (const [message, greeted] of [
      [sampleMessage(Date.now()), false],
      [hello(), true],
      ["not json", false],
      [
        JSON.stringify({
          type: "hello",
          protocol: 2,
          agent_version: "x",
          release_id: null,
        }),
        false,
      ],
      [
        JSON.stringify({
          type: "hello",
          protocol: 1,
          agent_version: "x",
          release_id: null,
          extra: 1,
          os: nodeOs(),
        }),
        false,
      ],
      // A hello says what the node boots and runs; one without it, or with a partial one, is no hello.
      [
        JSON.stringify({
          type: "hello",
          protocol: 1,
          agent_version: "x",
          release_id: null,
        }),
        false,
      ],
      [hello(null, { ...nodeOs(), boot_id: "not-a-uuid" }), false],
      [hello(null, { ...nodeOs(), extra: 1 }), false],
      [
        JSON.stringify({ type: "sample", sample: { observed_at: "now" } }),
        true,
      ],
      ["x".repeat(64 * 1024 + 1), true],
    ] as const) {
      const socket = await connect(f, greeted);
      const end = closed(socket);
      socket.send(message);
      expect((await end).code, message.slice(0, 40)).toBe(1008);
    }
  });

  it("sends hints to the connected agent, also after hibernation, and replaces the older socket", async () => {
    const f = await fixture(0);
    const stub = actor(f.node),
      id = newDatabaseId();
    const first = await connect(f);
    const hint = next(first);
    expect(await stub.notify([id])).toBe(1);
    expect(JSON.parse(await hint)).toEqual({ type: "desired", ids: [id] });
    await evictDurableObject(stub);
    const resumed = next(first);
    expect(await stub.notify()).toBe(1);
    expect(JSON.parse(await resumed)).toEqual({ type: "desired" });
    const replaced = closed(first);
    const second = await connect(f);
    expect((await replaced).code).toBe(1012);
    const last = next(second);
    expect(await stub.notify([id])).toBe(1);
    expect(JSON.parse(await last)).toEqual({ type: "desired", ids: [id] });
    second.close(1000);
  });

  it("reaches no agent that has not said hello", async () => {
    const f = await fixture(0);
    const socket = await connect(f, false);
    expect(await actor(f.node).notify([newDatabaseId()])).toBe(0);
    socket.close(1000);
  });

  it("refuses a link that does not come from the Worker for its own node", async () => {
    const f = await fixture(0);
    const other = await fixture(0);
    const attempt = (headers: Record<string, string>) =>
      actor(f.node).fetch(
        new Request(`https://${["link", "invalid"].join(".")}/node/v1/link`, {
          headers: { Upgrade: "websocket", ...headers },
        }),
      );
    expect((await attempt({})).status).toBe(400);
    expect(
      (
        await attempt({
          [NODE_HEADER]: other.node,
          [NODE_UID_HEADER]: other.nodeUid,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await actor(f.node).fetch(
          new Request(`https://${["link", "invalid"].join(".")}/`),
        )
      ).status,
    ).toBe(426);
  });

  it("is opened by the node's signed request", async () => {
    const f = await fixture(0);
    const response = await nodeRequest(f, "/node/v1/link", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const welcome = next(socket);
    socket.send(hello());
    expect(JSON.parse(await welcome)).toEqual({ type: "welcome", protocol: 1 });
    expect(await actor(f.node).notify([newDatabaseId()])).toBe(1);
    socket.close(1000);
    expect((await nodeRequest(f, "/node/v1/link")).status).toBe(426);
  });

  it("is told to pull the fence and closed when the node is declared lost", async () => {
    const f = await fixture(0);
    const socket = await connect(f);
    const hint = next(socket),
      end = closed(socket);
    await actor(f.node).fence();
    expect(JSON.parse(await hint)).toEqual({ type: "desired" });
    expect((await end).code).toBe(1008);
  });
});

describe("the samples of a node", () => {
  it("folds a minute into one row, the first sample written at once and the rest with the minute", async () => {
    const f = await fixture(0);
    const socket = await connect(f);
    const start = Math.floor((Date.now() - 5 * MINUTE) / MINUTE) * MINUTE;
    const send = async (message: string) => {
      socket.send(message);
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    await send(
      sampleMessage(start + 5_000, {
        cpu: { cores: 6, busy_millicores: 1000 },
      }),
    );
    // The first sample is written at once: it opens the node.
    await until(async () => (await minutes(f.node)).length === 1);
    await send(
      sampleMessage(start + 20_000, {
        cpu: { cores: 6, busy_millicores: 3000 },
        awake: [newDatabaseId()],
        awake_memory_mib: 256,
      }),
    );
    await send(
      sampleMessage(start + 35_000, {
        cpu: { cores: 6, busy_millicores: 2000 },
        room: false,
        queued: 2,
      }),
    );
    await send(sampleMessage(start + MINUTE + 5_000));
    await until(async () => (await minutes(f.node))[0]!.samples === 3);
    expect((await minutes(f.node))[0]).toMatchObject({
      minute: start / MINUTE,
      samples: 3,
      memory_total_bytes: 12 * 1024 ** 3,
      memory_used_bytes_sum: 3 * 3 * 1024 ** 3,
      memory_used_bytes_max: 3 * 1024 ** 3,
      cpu_cores: 6,
      cpu_busy_millicores_sum: 6000,
      cpu_busy_millicores_max: 3000,
      awake_sum: 1,
      awake_max: 1,
      awake_memory_mib_sum: 256,
      queued_max: 2,
      no_room_samples: 1,
      pool_data_total_bytes: 125 * 1024 ** 3,
      pool_data_used_bytes: 40 * 1024 ** 3,
      volumes_total: 3,
      volumes_mounted: 3,
      admitted: 0,
    });
    socket.close(1000);
  });

  it("writes the last minute when its alarm rings, and not twice", async () => {
    const f = await fixture(0);
    const socket = await connect(f);
    // Samples of the minute that is running, so that its alarm is still to come, and both of them
    // inside it: near the end of a minute, wait until the next one is 3 s old.
    if (Date.now() % MINUTE > MINUTE - 20_000)
      await new Promise((resolve) =>
        setTimeout(resolve, MINUTE - (Date.now() % MINUTE) + 3_000),
      );
    const now = Date.now();
    for (const offset of [2_000, 1_000]) {
      socket.send(sampleMessage(now - offset));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await until(async () => (await minutes(f.node)).length === 1);
    expect((await minutes(f.node))[0]!.samples).toBe(1);
    // Both samples are folded before the alarm rings.
    await until(
      async () =>
        (await heldLink(f.node)).sample?.observed_at ===
        new Date(now - 1_000).toISOString(),
    );
    expect(await runDurableObjectAlarm(actor(f.node))).toBe(true);
    expect((await minutes(f.node))[0]!.samples).toBe(2);
    // Nothing is left to write.
    expect(await runDurableObjectAlarm(actor(f.node))).toBe(false);
    socket.close(1000);
  }, 60_000);

  describe("when a minute's first sample comes less than 5 s into the minute", () => {
    // The alarm of a minute rings 5 s after it ends, so a first sample sooner than that moves the
    // alarm on before it rings. The node's vitals must follow the sample all the same.
    async function rollOver(forceAlarm: boolean) {
      const f = await fixture(0);
      const socket = await connect(f);
      const minute = Math.floor(Date.now() / MINUTE) * MINUTE;
      const send = async (message: string) => {
        socket.send(message);
        await new Promise((resolve) => setTimeout(resolve, 30));
      };
      await send(sampleMessage(minute - 40_000));
      await until(async () => (await minutes(f.node)).length === 1);
      await send(sampleMessage(minute - 25_000));
      if (forceAlarm) await runDurableObjectAlarm(actor(f.node));
      const first = new Date(minute + 2_000).toISOString();
      await send(sampleMessage(minute + 2_000));
      await until(
        async () =>
          (await env.DB.prepare("SELECT last_observed_at FROM nodes WHERE id=?")
            .bind(f.node)
            .first("last_observed_at")) === first,
      );
      expect(
        NodeSample.parse(
          JSON.parse(
            (await env.DB.prepare(
              "SELECT last_sample_json FROM nodes WHERE id=?",
            )
              .bind(f.node)
              .first<{ last_sample_json: string }>())!.last_sample_json,
          ),
        ).observed_at,
      ).toBe(first);
      // The minute that ended holds both of its samples, once. The alarm of the new minute may
      // have written its first sample's row already; that is another minute's.
      const ended = minute / MINUTE - 1;
      await until(
        async () =>
          (await minutes(f.node)).find((row) => row.minute === ended)
            ?.samples === 2,
      );
      expect(
        (await minutes(f.node)).filter((row) => row.minute === ended),
      ).toHaveLength(1);
      socket.close(1000);
    }
    it("refreshes the vitals at the rollover", () => rollOver(false));
    it("refreshes the vitals at the rollover also when the alarm already wrote the minute", () =>
      rollOver(true));
  });

  it("leaves what placement reads: the newest sample and the averages of the minutes", async () => {
    const f = await fixture(0);
    const socket = await connect(f);
    const start = Math.floor((Date.now() - 20 * MINUTE) / MINUTE) * MINUTE;
    // Twelve minutes of one sample each at 25 % RAM and 20 % CPU, the last minute still open.
    for (let i = 0; i < 12; i++) {
      socket.send(sampleMessage(start + i * MINUTE + 5_000));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    // The alarm of the minute still open may have written its row as well.
    await until(
      async () =>
        (await minutes(f.node)).filter(
          (row) => row.minute! < start / MINUTE + 11,
        ).length === 11,
    );
    const last = start + 11 * MINUTE + 5_000;
    const now = last + 1_000;
    const node = (await placementNodes(env.DB, f.region, now)).find(
      (value) => value.id === f.node,
    )!;
    expect(node).toMatchObject({
      sampled_at: new Date(last).toISOString(),
      memory_total_bytes: 12 * 1024 ** 3,
      cpu_cores: 6,
      room: 1,
      pool_data_total_bytes: 125 * 1024 ** 3,
      pool_nominal_bytes: 300 * 1024 ** 3,
      // 3 GiB of 12 in use, 1200 of 6000 millicores busy: a node with less than 30 minutes of
      // history has one average over all of it.
      ram_peak_ppm: 250_000,
      cpu_peak_ppm: 200_000,
    });
    expect(choosePlacement([node], placementNeed, now)?.id).toBe(f.node);
    socket.close(1000);
  });

  it("opens an enrolled node for placement at its first sample and keeps a lost node closed", async () => {
    const i = await installed();
    expect((await enroll(i.request)).status).toBe(200);
    const node = {
      node: i.id,
      nodeUid: (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
        .bind(i.id)
        .first<{ node_uid: string }>())!.node_uid,
    };
    expect(
      await env.DB.prepare(
        "SELECT ready,schedulable,last_observed_at,allocatable_memory_mib FROM nodes WHERE id=?",
      )
        .bind(i.id)
        .first(),
    ).toEqual({
      ready: 0,
      schedulable: 0,
      last_observed_at: null,
      allocatable_memory_mib: 0,
    });
    const socket = await connect(node);
    const at = Date.now() - 1000;
    socket.send(sampleMessage(at));
    await until(async () => (await minutes(i.id)).length === 1);
    expect(
      await env.DB.prepare(
        "SELECT ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total FROM nodes WHERE id=?",
      )
        .bind(i.id)
        .first(),
    ).toEqual({
      ready: 1,
      schedulable: 1,
      allocatable_memory_mib: 12 * 1024,
      allocatable_cpu_millicores: 6000,
      storage_gib_total: 125,
    });
    expect(
      NodeSample.parse(
        JSON.parse(
          (await env.DB.prepare("SELECT last_sample_json FROM nodes WHERE id=?")
            .bind(i.id)
            .first<{ last_sample_json: string }>())!.last_sample_json,
        ),
      ).observed_at,
    ).toBe(new Date(at).toISOString());
    expect(
      await env.DB.prepare("SELECT status FROM node_additions WHERE node_id=?")
        .bind(i.id)
        .first("status"),
    ).toBe("ready");
    // A node declared lost is not reopened by a sample that was already on the way.
    await env.DB.prepare(
      "UPDATE nodes SET lost_at=?,lost_reason='test',ready=0,schedulable=0 WHERE id=?",
    )
      .bind(new Date().toISOString(), i.id)
      .run();
    socket.send(sampleMessage(at + 20_000));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runDurableObjectAlarm(actor(i.id));
    expect(
      await env.DB.prepare("SELECT ready,schedulable FROM nodes WHERE id=?")
        .bind(i.id)
        .first(),
    ).toEqual({ ready: 0, schedulable: 0 });
    socket.close(1000);
  });

  it("keeps an enrolled node closed until it applied the credentials the API holds for it", async () => {
    const i = await installed();
    expect((await enroll(i.request)).status).toBe(200);
    const nodeUid = (await env.DB.prepare(
      "SELECT node_uid FROM nodes WHERE id=?",
    )
      .bind(i.id)
      .first<{ node_uid: string }>())!.node_uid;
    // The Tunnel token and the route keyring are at revision 2; the node has read none, or one.
    await env.DB.prepare("UPDATE nodes SET credentials_revision=2 WHERE id=?")
      .bind(i.id)
      .run();
    const socket = await connect({ node: i.id, nodeUid });
    const state = () =>
      env.DB.prepare(
        "SELECT n.ready,n.schedulable,n.last_observed_at observed,a.status FROM nodes n JOIN node_additions a ON a.node_id=n.id WHERE n.id=?",
      )
        .bind(i.id)
        .first<{
          ready: number;
          schedulable: number;
          observed: string | null;
          status: string;
        }>();
    const at = Date.now() - 5_000;
    const send = async (offset: number, revision: number | null) => {
      socket.send(
        sampleMessage(at + offset, { credentials_revision: revision }),
      );
      await until(
        async () =>
          (await state())?.observed === new Date(at + offset).toISOString(),
      );
    };
    // A node with no gateway and no Tunnel takes no database, however fresh its samples are.
    const closed = { ready: 0, schedulable: 0, status: "audited" };
    await send(0, null);
    expect(await state()).toMatchObject(closed);
    await send(1_000, 1);
    expect(await state()).toMatchObject(closed);
    // The sample that holds the revision opens it at once, not at the end of its minute.
    await send(2_000, 2);
    expect(await state()).toMatchObject({
      ready: 1,
      schedulable: 1,
      status: "ready",
    });
    // A later revision (a rotation) does not close an open node.
    await env.DB.prepare("UPDATE nodes SET credentials_revision=3 WHERE id=?")
      .bind(i.id)
      .run();
    socket.send(sampleMessage(at + 3_000, { credentials_revision: 2 }));
    await until(
      async () =>
        (await heldLink(i.id)).sample?.observed_at ===
        new Date(at + 3_000).toISOString(),
    );
    await runDurableObjectAlarm(actor(i.id));
    expect(await state()).toMatchObject({ ready: 1, schedulable: 1 });
    socket.close(1000);
  });

  it("ignores a sample from the future and one older than the newest", async () => {
    const f = await fixture(0);
    const socket = await connect(f);
    const now = Date.now();
    socket.send(sampleMessage(now - 20_000));
    await until(async () => (await minutes(f.node)).length === 1);
    socket.send(sampleMessage(now + 10 * MINUTE));
    socket.send(sampleMessage(now - 40_000));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const latest = await heldLink(f.node);
    expect(latest.connected).toBe(true);
    expect(latest.sample!.observed_at).toBe(
      new Date(now - 20_000).toISOString(),
    );
    expect(latest.received_at).toBeGreaterThan(now - 1000);
    socket.close(1000);
  });

  it("reports no sample before the first and no link after it closed", async () => {
    const f = await fixture(0);
    expect(await heldLink(f.node)).toEqual({
      connected: false,
      received_at: null,
      sample: null,
    });
    const socket = await connect(f);
    expect((await heldLink(f.node)).connected).toBe(true);
    const end = closed(socket);
    socket.close(1000);
    await end;
    await until(async () => !(await heldLink(f.node)).connected);
  });
});

describe("folding samples", () => {
  const at = Date.UTC(2026, 9, 18, 10, 30, 15);
  const sample = (offset: number, extra: Record<string, unknown> = {}) =>
    NodeSample.parse(nodeSample(at + offset, extra));

  it("starts a new row for a new minute and keeps the last pool reading of a minute", () => {
    const a = foldSample(undefined, sample(0));
    expect(a).toMatchObject({ minute: at / MINUTE - 0.25, samples: 1 });
    const b = foldSample(a, sample(15_000, { pool: null }));
    expect(b.samples).toBe(2);
    expect(b.pool).toBeNull();
    const c = foldSample(b, sample(45_000));
    expect(c.minute).toBe(b.minute + 1);
    expect(c.samples).toBe(1);
    expect(c.memory_used_bytes_sum).toBe(3 * 1024 ** 3);
  });
});

describe("a node's reading in the actor", () => {
  it("is kept in the actor's own storage across evictions", async () => {
    const f = await fixture(0);
    const socket = await connect(f);
    socket.send(sampleMessage(Date.now() - 1000));
    await until(async () => (await heldLink(f.node)).sample !== null);
    await evictDurableObject(actor(f.node));
    expect((await heldLink(f.node)).sample).not.toBeNull();
    expect(
      await runInDurableObject(actor(f.node), (_instance, state) =>
        state.storage.sql
          .exec<{ node_id: string }>("SELECT node_id FROM node_link")
          .toArray(),
      ),
    ).toEqual([{ node_id: f.node }]);
    socket.close(1000);
  });
});
