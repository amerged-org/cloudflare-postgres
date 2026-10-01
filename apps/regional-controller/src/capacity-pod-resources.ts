// SPDX-License-Identifier: Apache-2.0
import { quantity } from "./owned-stop.ts";
import type { Resource } from "./types.ts";
const fail = () => new Error("capacity_pod_resources_unproven");
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw fail();
  return v as Record<string, unknown>;
}
function items(v: unknown): unknown[] {
  if (!Array.isArray(v) || v.length > 64) throw fail();
  return v;
}
function sum(a: [bigint, bigint], b: [bigint, bigint]): [bigint, bigint] {
  return [a[0] + b[0], a[1] + b[1]];
}
function max(a: [bigint, bigint], b: [bigint, bigint]): [bigint, bigint] {
  return [a[0] > b[0] ? a[0] : b[0], a[1] > b[1] ? a[1] : b[1]];
}
export function capacityResourceAmounts(v: unknown): [bigint, bigint] {
  const r = object(v);
  if (Object.keys(r).some((k) => !["cpu", "memory"].includes(k))) throw fail();
  const cpu = quantity(r.cpu, 1000n),
    memory = quantity(r.memory, 1n);
  if (cpu === null || memory === null || cpu < 0n || memory < 0n) throw fail();
  return [cpu, memory];
}
export function effectiveCapacityResources(
  pod: Resource,
  field: "requests" | "limits",
): [bigint, bigint] {
  const p = object(pod.spec);
  if (p.resources !== undefined || p.ephemeralContainers !== undefined)
    throw fail();
  let app: [bigint, bigint] = [0n, 0n],
    sidecars: [bigint, bigint] = [0n, 0n],
    peak: [bigint, bigint] = [0n, 0n];
  for (const raw of items(p.containers)) {
    const c = object(raw);
    app = sum(app, capacityResourceAmounts(object(c.resources)[field]));
  }
  for (const raw of items(p.initContainers ?? [])) {
    const c = object(raw),
      r = capacityResourceAmounts(object(c.resources)[field]);
    if (c.restartPolicy === "Always") {
      sidecars = sum(sidecars, r);
      peak = max(peak, sidecars);
    } else if (c.restartPolicy === undefined)
      peak = max(peak, sum(sidecars, r));
    else throw fail();
  }
  const result = max(sum(app, sidecars), peak);
  return p.overhead === undefined
    ? result
    : sum(result, capacityResourceAmounts(p.overhead));
}
