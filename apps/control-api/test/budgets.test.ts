import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import {
  accountingCall,
  accountingFixture,
  installerHeaders,
} from "./accounting-fixture";

const metric = "cpu_millicore_ms";
const ramMetric = "memory_byte_ms";
async function grantor(organizationId: string) {
  const response = await accountingCall(
    `/v1/organizations/${organizationId}/budget-tokens/reissue`,
    { method: "POST", headers: installerHeaders },
  );
  expect(response.status).toBe(201);
  const issued = (await response.json()) as {
    apiToken: string;
    scopes: string[];
  };
  expect(issued.apiToken).toMatch(/^cpbgt_[A-Za-z0-9_-]{43}$/);
  expect(issued.scopes).toEqual([
    "budgets:read",
    "budgets:write",
    "usage:read",
  ]);
  return {
    token: issued.apiToken,
    headers: {
      authorization: `Bearer ${issued.apiToken}`,
      "content-type": "application/json",
    },
  };
}
function budgetPath(
  fixture: Awaited<ReturnType<typeof accountingFixture>>,
  environment = false,
) {
  return `/v1/organizations/${fixture.organizationId}/projects/${fixture.projectId}${environment ? `/environments/${fixture.environmentId}` : ""}/budget`;
}
async function write(
  path: string,
  headers: Record<string, string>,
  payload: unknown,
  expected = 200,
) {
  const response = await accountingCall(path, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(expected);
  return response;
}
async function readBudget(path: string, headers: Record<string, string>) {
  const response = await accountingCall(path, { headers });
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      budget: {
        revision: string;
        executionEpoch: string;
        requestedState: string;
        runtimeEnforced: boolean;
        enforcementStatus: string;
        account: {
          id: string;
          granted: Record<string, string>;
          consumed: Record<string, string>;
          reserved: Record<string, string>;
          gapCount: string;
        };
        reservations: Array<{ id: string; status: string; expired: boolean }>;
      };
    }
  ).budget;
}

it("separates grantor authority and preserves conditional policy revisions and requested pause state", async () => {
  const fixture = await accountingFixture("Budget policy");
  const issued = await grantor(fixture.organizationId);
  const path = budgetPath(fixture);
  const now = Date.now();
  const period = {
    start: new Date(now - 60_000).toISOString(),
    end: new Date(now + 3_600_000).toISOString(),
  };
  const granted = { [metric]: "900719925474099312345" };
  const policy = { expectedRevision: "0", period, granted };
  await write(path, fixture.orgHeaders, policy, 403);
  await write(path, issued.headers, policy);
  const stored = await env.DB.prepare(
    "SELECT token_hash FROM budget_tokens WHERE organization_id = ? AND scopes = ? AND revoked_at IS NULL",
  )
    .bind(fixture.organizationId, "budgets:read budgets:write usage:read")
    .first<{ token_hash: string }>();
  expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(stored?.token_hash).not.toBe(issued.token);
  const created = await readBudget(path, fixture.orgHeaders);
  expect(created.revision).toBe("1");
  expect(created.account.granted[metric]).toBe(granted[metric]);
  expect(created.runtimeEnforced).toBe(false);
  expect(created.enforcementStatus).toBe("pending_runtime");
  await write(path, issued.headers, policy, 409);
  await write(
    path,
    issued.headers,
    {
      expectedRevision: "1",
      period: { ...period, end: new Date(now + 7_200_000).toISOString() },
      granted,
    },
    409,
  );
  const paused = await accountingCall(`${path}/pause`, {
    method: "POST",
    headers: issued.headers,
    body: JSON.stringify({ expectedRevision: "1" }),
  });
  expect(paused.status).toBe(200);
  const afterPause = await readBudget(path, fixture.orgHeaders);
  expect(afterPause.revision).toBe("2");
  expect(afterPause.requestedState).toBe("paused");
  expect(BigInt(afterPause.executionEpoch)).toBeGreaterThan(
    BigInt(created.executionEpoch),
  );
  expect(afterPause.runtimeEnforced).toBe(false);
  const staleResume = await accountingCall(`${path}/resume`, {
    method: "POST",
    headers: issued.headers,
    body: JSON.stringify({ expectedRevision: "1" }),
  });
  expect(staleResume.status).toBe(409);
  const resumed = await accountingCall(`${path}/resume`, {
    method: "POST",
    headers: issued.headers,
    body: JSON.stringify({ expectedRevision: "2" }),
  });
  expect(resumed.status).toBe(200);
  const afterResume = await readBudget(path, fixture.orgHeaders);
  expect(afterResume.revision).toBe("3");
  expect(afterResume.requestedState).toBe("running");
  const stranger = await accountingFixture("Other budget organization");
  expect(
    (await accountingCall(path, { headers: stranger.orgHeaders })).status,
  ).toBe(404);
  expect(
    (
      await accountingCall(
        `/v1/organizations/${fixture.organizationId}/projects`,
        {
          method: "POST",
          headers: {
            ...issued.headers,
            "idempotency-key": "grantor-is-not-project-admin",
          },
          body: JSON.stringify({ name: "Forbidden project" }),
        },
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await accountingCall(
        `/v1/organizations/${fixture.organizationId}/budget-tokens/reissue`,
        { method: "POST", headers: fixture.orgHeaders },
      )
    ).status,
  ).toBe(401);
});

it("reserves every hierarchy atomically, retains expired holds and settles corrected accepted facts exactly once", async () => {
  const fixture = await accountingFixture("Budget settlement");
  const issued = await grantor(fixture.organizationId);
  const projectPath = budgetPath(fixture);
  const environmentPath = budgetPath(fixture, true);
  const now = Date.now();
  const period = {
    start: new Date(now - 60_000).toISOString(),
    end: new Date(now + 3_600_000).toISOString(),
  };
  await write(projectPath, issued.headers, {
    expectedRevision: "0",
    period,
    granted: { [metric]: "10", [ramMetric]: "10" },
  });
  await write(environmentPath, issued.headers, {
    expectedRevision: "0",
    period,
    granted: { [metric]: "8", [ramMetric]: "8" },
  });
  const reservationPath = `/v1/regions/${fixture.regionId}/allowance-reservations`;
  const request = {
    requestId: crypto.randomUUID(),
    environmentId: fixture.environmentId,
    leaseSeconds: 30,
    units: { [metric]: "7", [ramMetric]: "3" },
  };
  const issue = (body: unknown) =>
    accountingCall(reservationPath, {
      method: "POST",
      headers: fixture.regionHeaders,
      body: JSON.stringify(body),
    });
  const race = await Promise.all([
    issue(request),
    issue({ ...request, requestId: crypto.randomUUID() }),
  ]);
  expect(race.map((response) => response.status).sort()).toEqual([201, 409]);
  const receipt = (
    (await race.find((response) => response.status === 201)!.json()) as {
      reservation: {
        id: string;
        epoch: string;
        revision: string;
        fenceToken: string;
        expiresAt: string;
        issuedAt: string;
        units: Record<string, string>;
      };
    }
  ).reservation;
  // Select the winning request identity without generating more cases.
  const winning = await env.DB.prepare(
    "SELECT request_id FROM allowance_reservations WHERE id = ?",
  )
    .bind(receipt.id)
    .first<{ request_id: string }>();
  expect(
    (await readBudget(projectPath, fixture.orgHeaders)).account.reserved[
      metric
    ],
  ).toBe("7");
  expect(
    (await readBudget(environmentPath, fixture.orgHeaders)).account.reserved[
      metric
    ],
  ).toBe("7");
  const pause = await accountingCall(`${environmentPath}/pause`, {
    method: "POST",
    headers: issued.headers,
    body: JSON.stringify({ expectedRevision: "1" }),
  });
  expect(pause.status).toBe(200);
  const replay = await issue({ ...request, requestId: winning!.request_id });
  expect(replay.status).toBe(200);
  expect(
    ((await replay.json()) as { reservation: unknown }).reservation,
  ).toEqual(receipt);
  expect(
    (await issue({ ...request, requestId: crypto.randomUUID() })).status,
  ).toBe(409);
  expect(
    (
      await accountingCall(`${environmentPath}/resume`, {
        method: "POST",
        headers: issued.headers,
        body: JSON.stringify({ expectedRevision: "2" }),
      })
    ).status,
  ).toBe(200);
  vi.setSystemTime(new Date(Date.parse(receipt.expiresAt) + 1_000));
  try {
    expect(
      (
        await issue({
          ...request,
          requestId: crypto.randomUUID(),
          units: { [metric]: "1" },
        })
      ).status,
    ).toBe(409);
    const held = await readBudget(projectPath, fixture.orgHeaders);
    expect(held.account.reserved[metric]).toBe("7");
    expect(
      held.reservations.find((reservation) => reservation.id === receipt.id)
        ?.expired,
    ).toBe(true);
    const meterResponse = await accountingCall(
      `/v1/regions/${fixture.regionId}/usage-tokens/reissue`,
      { method: "POST", headers: installerHeaders },
    );
    expect(meterResponse.status).toBe(201);
    const meter = (await meterResponse.json()) as {
      sourceId: string;
      sourceEpoch: number;
      apiToken: string;
    };
    const issuedTime = Date.parse(receipt.issuedAt);
    const fact = {
      factId: crypto.randomUUID(),
      environmentId: fixture.environmentId,
      sourceId: meter.sourceId,
      sourceEpoch: meter.sourceEpoch,
      revision: 1,
      expectedPreviousRevision: 0,
      metric,
      attribution: "primary",
      start: receipt.issuedAt,
      end: new Date(issuedTime + 1).toISOString(),
      quantity: "9",
      status: "final",
      evidenceHash: "a".repeat(64),
    };
    const ingest = (body: unknown) =>
      accountingCall(`/v1/regions/${fixture.regionId}/usage-facts`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${meter.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect((await ingest(fact)).status).toBe(201);
    const settlement = {
      fenceToken: receipt.fenceToken,
      epoch: receipt.epoch,
      expectedRevision: "0",
      usageRefs: [{ factId: fact.factId, revision: 1 }],
      stoppedAt: new Date().toISOString(),
      stopEvidenceHash: "b".repeat(64),
    };
    const settle = (body: unknown) =>
      accountingCall(`${reservationPath}/${receipt.id}/settlement`, {
        method: "POST",
        headers: fixture.regionHeaders,
        body: JSON.stringify(body),
      });
    expect(
      (await settle({ ...settlement, fenceToken: `cprsv_${"c".repeat(43)}` }))
        .status,
    ).toBe(409);
    // Releasing positive RAM authority requires explicit final evidence;
    // omitting that metric must never imply zero usage.
    expect((await settle(settlement)).status).toBe(409);
    const ramFact = {
      ...fact,
      factId: crypto.randomUUID(),
      metric: ramMetric,
      quantity: "0",
      evidenceHash: "f".repeat(64),
    };
    expect((await ingest(ramFact)).status).toBe(201);
    const preceding = {
      ...fact,
      factId: crypto.randomUUID(),
      start: new Date(issuedTime - 120_000).toISOString(),
      end: new Date(issuedTime - 119_999).toISOString(),
    };
    expect((await ingest(preceding)).status).toBe(201);
    expect(
      (
        await settle({
          ...settlement,
          usageRefs: [
            { factId: preceding.factId, revision: 1 },
            { factId: ramFact.factId, revision: 1 },
          ],
        })
      ).status,
    ).toBe(409);
    settlement.usageRefs.push({ factId: ramFact.factId, revision: 1 });
    settlement.usageRefs.sort((left, right) =>
      left.factId.localeCompare(right.factId),
    );
    expect((await settle(settlement)).status).toBe(200);
    expect((await settle(settlement)).status).toBe(200);
    const overrun = await readBudget(environmentPath, fixture.orgHeaders);
    expect(overrun.account.consumed[metric]).toBe("9");
    expect(overrun.account.reserved[metric]).toBe("0");
    expect(overrun.account.reserved[ramMetric]).toBe("0");
    expect(overrun.account.consumed[ramMetric]).toBe("0");
    expect(
      (
        await issue({
          ...request,
          requestId: crypto.randomUUID(),
          units: { [metric]: "1" },
        })
      ).status,
    ).toBe(409);
    const corrected = {
      ...fact,
      revision: 2,
      expectedPreviousRevision: 1,
      quantity: "6",
      evidenceHash: "c".repeat(64),
    };
    expect((await ingest(corrected)).status).toBe(201);
    expect((await ingest(corrected)).status).toBe(200);
    expect(
      (await readBudget(projectPath, fixture.orgHeaders)).account.consumed[
        metric
      ],
    ).toBe("6");
    expect(
      (await readBudget(environmentPath, fixture.orgHeaders)).account.consumed[
        metric
      ],
    ).toBe("6");
    expect((await settle(settlement)).status).toBe(200);
    const gap = {
      ...corrected,
      revision: 3,
      expectedPreviousRevision: 2,
      quantity: null,
      status: "gap",
      evidenceHash: "d".repeat(64),
    };
    expect((await ingest(gap)).status).toBe(201);
    const incomplete = await readBudget(environmentPath, fixture.orgHeaders);
    expect(incomplete.account.consumed[metric]).toBe("6");
    expect(incomplete.account.gapCount).toBe("1");
    const oldAccountId = incomplete.account.id;
    // Advancing a policy period preserves the unsettled coverage gap in the
    // old bound account; a clean new account cannot bypass that authority.
    vi.setSystemTime(new Date(Date.parse(period.end) + 1_000));
    const nextPeriod = {
      start: period.end,
      end: new Date(Date.parse(period.end) + 3_600_000).toISOString(),
    };
    await write(projectPath, issued.headers, {
      expectedRevision: "1",
      period: nextPeriod,
      granted: { [metric]: "10", [ramMetric]: "10" },
    });
    await write(environmentPath, issued.headers, {
      expectedRevision: "3",
      period: nextPeriod,
      granted: { [metric]: "8", [ramMetric]: "8" },
    });
    expect(
      (
        await issue({
          ...request,
          requestId: crypto.randomUUID(),
          units: { [metric]: "1" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await ingest({
          ...corrected,
          revision: 4,
          expectedPreviousRevision: 3,
          quantity: "5",
          evidenceHash: "e".repeat(64),
        })
      ).status,
    ).toBe(201);
    const resolved = await readBudget(environmentPath, fixture.orgHeaders);
    expect(resolved.account.consumed[metric] ?? "0").toBe("0");
    expect(resolved.account.gapCount).toBe("0");
    const oldAccount = await env.DB.prepare(
      "SELECT consumed_json, gap_count FROM budget_accounts WHERE id = ?",
    )
      .bind(oldAccountId)
      .first<{ consumed_json: string; gap_count: string }>();
    expect(JSON.parse(oldAccount!.consumed_json)[metric]).toBe("5");
    expect(oldAccount!.gap_count).toBe("0");
    expect(
      (
        await issue({
          ...request,
          requestId: crypto.randomUUID(),
          units: { [metric]: "3" },
        })
      ).status,
    ).toBe(201);
    const evidence = await env.DB.prepare(
      "SELECT evidence_json FROM allowance_settlement_versions WHERE reservation_id = ? AND revision = '1'",
    )
      .bind(receipt.id)
      .first<{ evidence_json: string }>();
    expect(JSON.parse(evidence!.evidence_json).usageRefs).toEqual(
      settlement.usageRefs,
    );
  } finally {
    vi.useRealTimers();
  }
});
