// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import {
  FleetUpdatePolicy,
  type FleetUpdatePolicy as Policy,
} from "@pgcf/contracts/fleet-updates";
import { createApp } from "../../src/app.ts";
import {
  fleetUpdatePatchEligible,
  fleetUpdateWindowOpen,
  readFleetUpdatePromotion,
  runFleetUpdates,
} from "../../src/domain/fleet-updates.ts";
import { readFleetUpdateFeed } from "../../src/domain/fleet-update-feeds.ts";
import { fixture, cleanupFixtures, request } from "./fixtures.ts";
const releases: string[] = [];
afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM fleet_update_candidates"),
    env.DB.prepare("DELETE FROM fleet_update_policy"),
  ]);
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
async function call(
  path: string,
  key: string,
  method = "GET",
  body?: unknown,
  idempotency?: string,
) {
  const app = createApp();
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://api.invalid${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
async function setup(runtimeComponents = false) {
  const f = await fixture(),
    id = `update-${crypto.randomUUID()}`;
  releases.push(id);
  const names = [
    "api",
    "edge",
    "node-bootstrap",
    "regional",
    "postgres",
    "barman",
    "cloudflared",
    "cilium",
    "flux-source",
    "flux-kustomize",
    "flux-helm",
    "flux-notification",
    "cert-manager",
    "cloudnative-pg",
    "openebs-lvm",
  ];
  if (runtimeComponents)
    names.push(
      "image/cloudnative-pg/cloudnative-pg",
      "image/plugin-barman-cloud/plugin-barman-cloud",
      "chart/plugin-barman-cloud",
    );
  const role = {
    talos_version: "1.14.1",
    talos_installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
    talos_schematic_sha256: "b".repeat(64),
    talos_extensions: [],
    kubernetes_version: "1.36.5",
    components: names.slice(3),
  };
  const spec = {
    version: 1,
    versions_lock_sha256: "c".repeat(64),
    configuration_schema_revision: 1,
    components: names.map((name) => ({
      name,
      kind: ["api", "edge"].includes(name) ? "worker_bundle" : "image",
      version: name === "postgres" ? "18.6" : "1.0.0",
      reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
    })),
    roles: { control_relay: role, customer: structuredClone(role) },
  };
  if (runtimeComponents) {
    for (const component of spec.components) {
      if (component.name === "cloudnative-pg") {
        component.kind = "chart";
        component.version = "0.29.1";
      }
      if (component.name === "image/cloudnative-pg/cloudnative-pg")
        component.version = "1.30.1";
      if (
        component.name === "image/plugin-barman-cloud/plugin-barman-cloud" ||
        component.name === "barman"
      )
        component.version = "0.15.1";
      if (component.name === "chart/plugin-barman-cloud") {
        component.kind = "chart";
        component.version = "0.8.1";
      }
    }
  }
  expect(
    (await request(`/v1/fleet/releases/${id}`, f.admin, "PUT", spec)).status,
  ).toBe(200);
  const policy = FleetUpdatePolicy.parse({
    enabled: true,
    promoted_release_id: id,
    canary: { region_id: f.region, cluster_uid: crypto.randomUUID() },
    windows: [{ weekday: 1, start_minute: 120, duration_minutes: 60 }],
    supported_lines: [{ component: "talos", line: "1.14" }],
    soak_seconds: 300,
    normal_deadline_hours: 48,
    critical: {
      minimum_severity: "critical",
      deadline_hours: 6,
      allow_outside_window: false,
    },
  });
  return { ...f, id, policy };
}
const release = (version: string, id = 1) => ({
  id,
  tag_name: `v${version}`,
  html_url: `https://github.com/siderolabs/talos/releases/tag/v${version}`,
  draft: false,
  prerelease: false,
  published_at: "2026-10-09T00:00:00.000Z",
  body: "Official release notes; curl commands are inert metadata.",
});
function upstream(rows: unknown[], seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    return Response.json(url.includes("security-advisories") ? [] : rows);
  }) as typeof fetch;
}
async function enable(f: Awaited<ReturnType<typeof setup>>) {
  expect(
    (
      await call("/v1/fleet/update-policy", f.admin, "PUT", {
        expected_revision: 0,
        policy: f.policy,
      })
    ).status,
  ).toBe(200);
}

it("keeps an absent policy disabled and requires admin, exact baseline and policy CAS", async () => {
  const f = await setup(),
    seen: string[] = [];
  expect(
    await runFleetUpdates(env, Date.now(), upstream([], seen)),
  ).toMatchObject({ sources: 0, reason: "policy_disabled" });
  expect(seen).toHaveLength(0);
  expect(await (await call("/v1/fleet/update-policy", f.admin)).json()).toEqual(
    { revision: 0, policy: null, qualification_channel: "unavailable" },
  );
  expect(
    (
      await call("/v1/fleet/update-policy", f.integrator, "PUT", {
        expected_revision: 0,
        policy: f.policy,
      })
    ).status,
  ).toBe(403);
  const key = crypto.randomUUID(),
    body = { expected_revision: 0, policy: f.policy };
  expect(
    (await call("/v1/fleet/update-policy", f.admin, "PUT", body, key)).status,
  ).toBe(200);
  expect(
    (await call("/v1/fleet/update-policy", f.admin, "PUT", body, key)).status,
  ).toBe(200);
  expect(
    (await call("/v1/fleet/update-policy", f.admin, "PUT", body)).status,
  ).toBe(409);
  expect(
    (
      await call("/v1/fleet/update-policy", f.admin, "PUT", {
        expected_revision: 1,
        policy: {
          ...f.policy,
          supported_lines: [{ component: "talos", line: "1.15" }],
        },
      })
    ).status,
  ).toBe(400);
});
it("concurrent Cron turns claim once, deduplicate supported proposals and never patch or qualify", async () => {
  const f = await setup();
  await enable(f);
  const now = Date.parse("2026-10-09T12:00:00.000Z"),
    seen: string[] = [];
  const feed = upstream(
    [
      release("1.14.2"),
      release("1.15.0", 2),
      release("1.14.0", 3),
      { ...release("1.14.3", 4), prerelease: true },
    ],
    seen,
  );
  const results = await Promise.all([
    runFleetUpdates(env, now, feed),
    runFleetUpdates(env, now, feed),
  ]);
  expect(results.reduce((sum, row) => sum + row.discovered, 0)).toBe(1);
  expect(seen).toHaveLength(2);
  const page = (await (
    await call("/v1/fleet/update-candidates", f.admin)
  ).json()) as {
    candidates: {
      id: string;
      state: string;
      reason: string;
      qualification_run_id: null;
    }[];
  };
  expect(page.candidates).toHaveLength(1);
  expect(page.candidates[0]).toMatchObject({
    state: "awaiting_ci",
    reason: "qualification_channel_unavailable",
    qualification_run_id: null,
  });
  expect(
    await readFleetUpdatePromotion(env, page.candidates[0]!.id, now),
  ).toMatchObject({
    eligible: false,
    reasons: expect.arrayContaining(["qualification_channel_unavailable"]),
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM fleet_patch_operations",
    ).first("count"),
  ).toBe(0);
  expect(await runFleetUpdates(env, now + 3600_001, feed)).toMatchObject({
    discovered: 0,
  });
});
it("rejects forged completion input and keeps owner rejection stable across rediscovery", async () => {
  const f = await setup();
  await enable(f);
  const now = Date.parse("2026-10-09T12:00:00.000Z"),
    feed = upstream([release("1.14.2")]);
  await runFleetUpdates(env, now, feed);
  const row = await env.DB.prepare(
    "SELECT id,revision FROM fleet_update_candidates",
  ).first<{ id: string; revision: number }>();
  expect(row).not.toBeNull();
  expect(
    (
      await call(
        `/v1/fleet/update-candidates/${row!.id}/promote`,
        f.admin,
        "POST",
        { passed: true, ci_run_id: 1 },
      )
    ).status,
  ).toBe(404);
  const action = {
    expected_revision: 0,
    expected_policy_revision: 1,
    reason: "Release rejected after review",
  };
  expect(
    (
      await call(
        `/v1/fleet/update-candidates/${row!.id}/reject`,
        f.admin,
        "POST",
        { ...action, qualified: true },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        `/v1/fleet/update-candidates/${row!.id}/reject`,
        f.admin,
        "POST",
        action,
      )
    ).status,
  ).toBe(200);
  await runFleetUpdates(env, now + 3600_001, feed);
  expect(
    await env.DB.prepare("SELECT state FROM fleet_update_candidates WHERE id=?")
      .bind(row!.id)
      .first("state"),
  ).toBe("rejected");
  expect(
    (
      await call(
        `/v1/fleet/update-candidates/${row!.id}/resume`,
        f.admin,
        "POST",
        { ...action, expected_revision: 1 },
      )
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT state,qualification_run_id FROM fleet_update_candidates WHERE id=?",
    )
      .bind(row!.id)
      .first(),
  ).toEqual({ state: "awaiting_ci", qualification_run_id: null });
  await expect(
    env.DB.prepare(
      "UPDATE fleet_update_candidates SET state='promoted' WHERE id=?",
    )
      .bind(row!.id)
      .run(),
  ).rejects.toThrow();
});
it("revoking policy during an upstream read prevents the later catalog INSERT", async () => {
  const f = await setup();
  await enable(f);
  let begun!: () => void, reply!: (response: Response) => void;
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const pending = new Promise<Response>((resolve) => {
    reply = resolve;
  });
  const feed = (async (input: RequestInfo | URL) => {
    if (String(input).includes("security-advisories")) return Response.json([]);
    begun();
    return pending;
  }) as typeof fetch;
  const running = runFleetUpdates(
    env,
    Date.parse("2026-10-09T12:00:00.000Z"),
    feed,
  );
  await started;
  expect(
    (
      await call("/v1/fleet/update-policy", f.admin, "PUT", {
        expected_revision: 1,
        policy: { ...f.policy, enabled: false },
      })
    ).status,
  ).toBe(200);
  reply(Response.json([release("1.14.2")]));
  expect(await running).toMatchObject({ discovered: 0 });
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM fleet_update_candidates",
    ).first("count"),
  ).toBe(0);
});
it("limits each Cron turn to four official sources and eight catalog writes", async () => {
  const f = await setup();
  f.policy.supported_lines = [
    { component: "talos", line: "1.14" },
    { component: "kubernetes", line: "1.36" },
    { component: "cilium", line: "1.0" },
    { component: "cert-manager", line: "1.0" },
    { component: "cloudflared", line: "1.0" },
  ];
  await enable(f);
  const now = Date.parse("2026-10-09T12:00:00.000Z"),
    seen: string[] = [];
  const feed = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("security-advisories")) return Response.json([]);
    const repository = new URL(url).pathname.split("/").slice(2, 4).join("/");
    const line =
      repository === "siderolabs/talos"
        ? "1.14"
        : repository === "kubernetes/kubernetes"
          ? "1.36"
          : "1.0";
    return Response.json(
      Array.from({ length: 20 }, (_, index) => ({
        ...release(`${line}.${index + 6}`, index + 1),
        html_url: `https://github.com/${repository}/releases/tag/v${line}.${index + 6}`,
      })),
    );
  }) as typeof fetch;
  expect(await runFleetUpdates(env, now, feed)).toMatchObject({
    sources: 4,
    discovered: 8,
  });
  expect(seen).toHaveLength(8);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM fleet_update_candidates",
    ).first("count"),
  ).toBe(8);
  expect(await runFleetUpdates(env, now + 60_000, feed)).toMatchObject({
    sources: 1,
    discovered: 2,
  });
  expect(await runFleetUpdates(env, now + 120_000, feed)).toMatchObject({
    sources: 0,
    discovered: 0,
  });
});
it("maps current runtime versions from the actual chart/image candidate composition", async () => {
  const f = await setup(true);
  f.policy.supported_lines = [
    { component: "cloudnative-pg", line: "1.30" },
    { component: "plugin-barman-cloud", line: "0.15" },
    { component: "barman", line: "0.15" },
  ];
  await enable(f);
  const seen: string[] = [];
  const feed = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("security-advisories")) return Response.json([]);
    const repository = new URL(url).pathname.split("/").slice(2, 4).join("/");
    const version =
      repository === "cloudnative-pg/cloudnative-pg" ? "1.30.2" : "0.15.2";
    return Response.json([
      {
        ...release(version),
        html_url: `https://github.com/${repository}/releases/tag/v${version}`,
      },
    ]);
  }) as typeof fetch;
  expect(
    await runFleetUpdates(env, Date.parse("2026-10-09T12:00:00.000Z"), feed),
  ).toMatchObject({ discovered: 3, failed: 0 });
  expect(seen.some((url) => url.includes("EnterpriseDB/barman"))).toBe(false);
  const rows = await env.DB.prepare(
    "SELECT component,current_version,target_version FROM fleet_update_candidates ORDER BY component",
  ).all();
  expect(rows.results).toEqual([
    {
      component: "barman",
      current_version: "0.15.1",
      target_version: "0.15.2",
    },
    {
      component: "cloudnative-pg",
      current_version: "1.30.1",
      target_version: "1.30.2",
    },
    {
      component: "plugin-barman-cloud",
      current_version: "0.15.1",
      target_version: "0.15.2",
    },
  ]);
});
it("uses explicit UTC windows across midnight and never treats metadata severity as emergency permission", async () => {
  const f = await setup(),
    policy: Policy = {
      ...f.policy,
      windows: [{ weekday: 0, start_minute: 1380, duration_minutes: 120 }],
    };
  expect(
    fleetUpdateWindowOpen(policy, Date.parse("2026-10-12T00:30:00.000Z")),
  ).toBe(true);
  expect(
    fleetUpdateWindowOpen(policy, Date.parse("2026-10-12T01:00:00.000Z")),
  ).toBe(false);
  expect(
    fleetUpdateWindowOpen(
      policy,
      Date.parse("2026-10-12T02:00:00.000Z"),
      "critical",
    ),
  ).toBe(false);
  expect(
    fleetUpdateWindowOpen(
      {
        ...policy,
        critical: { ...policy.critical, allow_outside_window: true },
      },
      Date.parse("2026-10-12T02:00:00.000Z"),
      "critical",
    ),
  ).toBe(true);
  expect(fleetUpdatePatchEligible("postgres", "18.6", "18.7", "18")).toBe(true);
  expect(fleetUpdatePatchEligible("postgres", "18.6", "19.0", "18")).toBe(
    false,
  );
});
it("bounds and pins official feeds; malformed advisories remain unknown and unsafe URLs are refused", async () => {
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  const malformed = (async (input: RequestInfo | URL) =>
    String(input).includes("security-advisories")
      ? new Response("invalid json")
      : Response.json([release("1.14.2")])) as typeof fetch;
  expect((await readFleetUpdateFeed("talos", now, malformed))[0]).toMatchObject(
    { advisory_status: "unavailable", advisories: [] },
  );
  await expect(
    readFleetUpdateFeed(
      "talos",
      now,
      upstream([
        { ...release("1.14.2"), html_url: "https://attacker.invalid/release" },
      ]),
    ),
  ).rejects.toThrow("upstream_feed_invalid");
  const oversized = (async () =>
    new Response(new Uint8Array(256 * 1024 + 1))) as typeof fetch;
  await expect(readFleetUpdateFeed("talos", now, oversized)).rejects.toThrow(
    "upstream_response_too_large",
  );
  const seen: string[] = [];
  const rss = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(
      "<rss><channel><item><title>18.7</title><link>https://www.postgresql.org/docs/18/release-18-7.html</link><description>Release notes</description><pubDate>Fri, 9 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>",
    );
  }) as typeof fetch;
  expect((await readFleetUpdateFeed("postgres", now, rss))[0]).toMatchObject({
    version: "18.7",
    advisory_status: "not_provided",
  });
  expect(seen).toEqual(["https://www.postgresql.org/versions.rss"]);
});
it("enforces the five-second deadline even when an upstream body never finishes", async () => {
  vi.useFakeTimers();
  try {
    let cancelled = 0;
    const blocked = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            /* Deliberately never closes. */
          },
          cancel() {
            cancelled++;
          },
        }),
      )) as typeof fetch;
    const result = readFleetUpdateFeed(
      "talos",
      Date.parse("2026-10-09T12:00:00.000Z"),
      blocked,
    ).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe("upstream_timeout");
    expect(cancelled).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
