import { expect, it } from "vitest";
import {
  accountingCall,
  accountingFixture,
  installerHeaders,
} from "./accounting-fixture";

interface UsagePage {
  records: Array<{
    factId: string;
    revision: number;
    quantity: string | null;
    status: string;
  }>;
  pageTotals: Record<string, string>;
  nextCursor: string | null;
  snapshot: { watermark: string };
}

it("records exact usage revisions and preserves a tenant-bound export snapshot across corrections and token rotation", async () => {
  const fixture = await accountingFixture("Usage ledger");
  const issued = await accountingCall(
    `/v1/regions/${fixture.regionId}/usage-tokens/reissue`,
    {
      method: "POST",
      headers: installerHeaders,
    },
  );
  expect(issued.status).toBe(201);
  const meter = (await issued.json()) as {
    sourceId: string;
    sourceEpoch: number;
    apiToken: string;
    scopes: string[];
  };
  expect(meter.apiToken).toMatch(/^cpmtr_[A-Za-z0-9_-]{43}$/);
  expect(meter.scopes).toEqual(["usage:write"]);
  const meterHeaders = {
    authorization: `Bearer ${meter.apiToken}`,
    "content-type": "application/json",
  };
  const input = {
    factId: crypto.randomUUID(),
    environmentId: fixture.environmentId,
    sourceId: meter.sourceId,
    sourceEpoch: meter.sourceEpoch,
    revision: 1,
    expectedPreviousRevision: 0,
    metric: "cpu_millicore_ms",
    attribution: "primary",
    start: "2026-09-28T00:00:00.000Z",
    end: "2026-09-28T00:01:00.000Z",
    quantity: "9007199254740993",
    status: "final",
    evidenceHash: "a".repeat(64),
  };
  const factPath = `/v1/regions/${fixture.regionId}/usage-facts`;
  const wrongPurpose = await accountingCall(factPath, {
    method: "POST",
    headers: fixture.regionHeaders,
    body: JSON.stringify(input),
  });
  expect(wrongPurpose.status).toBe(401);
  const accepted = await accountingCall(factPath, {
    method: "POST",
    headers: meterHeaders,
    body: JSON.stringify(input),
  });
  expect(accepted.status).toBe(201);
  const gap = {
    ...input,
    factId: crypto.randomUUID(),
    start: input.end,
    end: "2026-09-28T00:02:00.000Z",
    quantity: null,
    status: "gap",
  };
  const acceptedGap = await accountingCall(factPath, {
    method: "POST",
    headers: meterHeaders,
    body: JSON.stringify(gap),
  });
  expect(acceptedGap.status).toBe(201);

  const base = `/v1/organizations/${fixture.organizationId}/usage`;
  const filters =
    "from=2026-09-28T00%3A00%3A00.000Z&to=2026-09-28T00%3A03%3A00.000Z&limit=1";
  const first = await accountingCall(`${base}?${filters}`, {
    headers: fixture.orgHeaders,
  });
  expect(first.status).toBe(200);
  const firstPage = (await first.json()) as UsagePage;
  expect(firstPage.records[0]).toMatchObject({
    factId: input.factId,
    quantity: input.quantity,
    revision: 1,
    status: "final",
  });
  expect(firstPage.pageTotals.cpu_millicore_ms).toBe(input.quantity);
  expect(firstPage.snapshot.watermark).toMatch(/^(0|[1-9][0-9]*)$/);
  expect(firstPage.nextCursor).toEqual(expect.any(String));

  const rotated = await accountingCall(
    `/v1/regions/${fixture.regionId}/usage-tokens/reissue`,
    {
      method: "POST",
      headers: installerHeaders,
    },
  );
  expect(rotated.status).toBe(201);
  const replacement = (await rotated.json()) as typeof meter;
  expect([replacement.sourceId, replacement.sourceEpoch]).toEqual([
    meter.sourceId,
    meter.sourceEpoch,
  ]);
  const replacementHeaders = {
    authorization: `Bearer ${replacement.apiToken}`,
    "content-type": "application/json",
  };
  const correction = {
    ...input,
    revision: 2,
    expectedPreviousRevision: 1,
    quantity: "9007199254740995",
    evidenceHash: "b".repeat(64),
  };
  const corrected = await accountingCall(factPath, {
    method: "POST",
    headers: replacementHeaders,
    body: JSON.stringify(correction),
  });
  expect(corrected.status).toBe(201);
  const oldJournalReplay = await accountingCall(factPath, {
    method: "POST",
    headers: replacementHeaders,
    body: JSON.stringify(input),
  });
  expect(oldJournalReplay.status).toBe(200);
  const changedReplay = await accountingCall(factPath, {
    method: "POST",
    headers: replacementHeaders,
    body: JSON.stringify({ ...input, quantity: "7" }),
  });
  expect(changedReplay.status).toBe(409);
  const staleParent = await accountingCall(factPath, {
    method: "POST",
    headers: replacementHeaders,
    body: JSON.stringify({
      ...correction,
      revision: 3,
      expectedPreviousRevision: 1,
    }),
  });
  expect(staleParent.status).toBe(409);

  const next = await accountingCall(
    `${base}?${filters}&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    { headers: fixture.orgHeaders },
  );
  expect(next.status).toBe(200);
  const nextPage = (await next.json()) as UsagePage;
  expect(nextPage.snapshot).toEqual(firstPage.snapshot);
  expect(nextPage.records[0]).toMatchObject({
    factId: gap.factId,
    quantity: null,
    status: "gap",
  });
  expect(nextPage.pageTotals).toEqual({});
  const exported = await accountingCall(
    `${base}/export?${filters}&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    { headers: fixture.orgHeaders },
  );
  expect(exported.status).toBe(200);
  expect(exported.headers.get("content-type")).toContain(
    "application/x-ndjson",
  );
  const lines = (await exported.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines[0]).toMatchObject({
    factId: gap.factId,
    quantity: null,
    status: "gap",
  });
  expect(lines.at(-1)).toMatchObject({
    type: "metadata",
    snapshot: firstPage.snapshot,
  });
  const latest = await accountingCall(
    `${base}?${filters.replace("limit=1", "limit=100")}`,
    { headers: fixture.orgHeaders },
  );
  const latestPage = (await latest.json()) as UsagePage;
  expect(latestPage.records[0]).toMatchObject({
    quantity: correction.quantity,
    revision: 2,
  });
  expect(latestPage.pageTotals.cpu_millicore_ms).toBe(correction.quantity);

  const other = await accountingFixture("Foreign usage reader");
  const stolenCursor = await accountingCall(
    `/v1/organizations/${other.organizationId}/usage?${filters}&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    { headers: other.orgHeaders },
  );
  expect(stolenCursor.status).toBe(400);
  const foreignScope = await accountingCall(
    `${base}?${filters}&environmentId=${other.environmentId}`,
    { headers: fixture.orgHeaders },
  );
  expect(foreignScope.status).toBe(404);
});
