// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  memoryCapacityWindow,
  type MemorySample,
} from "../../src/domain/memory-capacity.ts";

const uid = "11111111-1111-4111-8111-111111111111";
const now = Date.parse("2026-10-06T12:10:30.000Z");
const samples = (percent: number): MemorySample[] =>
  Array.from({ length: 10 }, (_, i) => ({
    node_uid: uid,
    observed_at: new Date(now - i * 60_000).toISOString(),
    working_set_bytes: percent * 100,
    capacity_memory_bytes: 10_000,
    available_bytes: 10_000 - percent * 100,
    memory_pressure: false,
  }));

it("requires ten measured minutes and expands at exactly 76 percent without closing placement", () => {
  expect(memoryCapacityWindow(uid, samples(75), now)).toMatchObject({
    complete: true,
    expand: false,
    utilization_ppm: 750000,
  });
  expect(memoryCapacityWindow(uid, samples(76), now)).toMatchObject({
    complete: true,
    expand: true,
    admissible: true,
    utilization_ppm: 760000,
  });
  expect(memoryCapacityWindow(uid, samples(81), now)).toMatchObject({
    complete: true,
    expand: true,
    admissible: true,
    utilization_ppm: 810000,
  });
  const mixed = samples(75);
  mixed[0]!.working_set_bytes = 8500;
  expect(memoryCapacityWindow(uid, mixed, now)).toMatchObject({
    complete: true,
    expand: true,
    utilization_ppm: 760000,
  });
});

it("refuses wrong identity, missing minutes, unknown measurements and stale evidence", () => {
  expect(memoryCapacityWindow(uid, samples(80).slice(1), now).complete).toBe(
    false,
  );
  const wrong = samples(80);
  wrong[3]!.node_uid = "22222222-2222-4222-8222-222222222222";
  expect(memoryCapacityWindow(uid, wrong, now).complete).toBe(false);
  const gap = samples(80);
  gap[3]!.observed_at = gap[4]!.observed_at;
  expect(memoryCapacityWindow(uid, gap, now).complete).toBe(false);
  expect(memoryCapacityWindow(uid, samples(80), now + 90_001).complete).toBe(
    false,
  );
  const unknown = samples(80);
  unknown[4]!.working_set_bytes = null;
  expect(memoryCapacityWindow(uid, unknown, now).complete).toBe(false);
});

it("refuses changed physical capacity and current memory pressure without fabricating zero", () => {
  const changed = samples(80);
  changed[3]!.capacity_memory_bytes = 20_000;
  expect(memoryCapacityWindow(uid, changed, now).complete).toBe(false);
  const pressure = samples(80);
  pressure[0]!.memory_pressure = true;
  expect(memoryCapacityWindow(uid, pressure, now)).toMatchObject({
    complete: true,
    admissible: false,
    expand: true,
  });
});
