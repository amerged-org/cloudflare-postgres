// SPDX-License-Identifier: Apache-2.0
// The rule of the page (ULTRA plan 9.3, "Changing the page"): a node reads what Cloudflare sends
// and ignores the properties it does not know, so that an additive change deploys API first with
// no hand step. These tests are its mechanical part.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import node from "../native/node.generated.json" with { type: "json" };
import vectors from "../native/node-vectors.generated.json" with { type: "json" };
import { nodeReceives, nodeSchemas } from "../native/node-vectors.ts";
import {
  NodeDesiredPage,
  NodeEventReport,
  NodeObservationReport,
  NodePolicy,
} from "../src/node-link.ts";
import { NODE_CLOSED_SETS } from "./node-closed-sets.ts";
import { NODE_REQUIRED } from "./node-required.ts";
import { closedSets, requiredProperties } from "./node-schema-walk.ts";

type Schema = {
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  const?: unknown;
  default?: unknown;
};
type Vector = {
  schema: string;
  name: string;
  valid: boolean;
  node_valid: boolean;
  value: unknown;
};
type Path = (string | number)[];
const schemas = node.schemas as unknown as Record<string, Schema>;
const allVectors = vectors.schemas as unknown as Vector[];
const vector = (schema: string, name: string) => {
  const found = allVectors.find((v) => v.schema === schema && v.name === name);
  if (!found) throw new Error(`no vector ${schema}/${name}`);
  return found;
};
const strict = (name: keyof typeof nodeSchemas) =>
  z.toJSONSchema(nodeSchemas[name], { io: "input" }) as Schema;
const received = (name: string) =>
  (nodeReceives as readonly string[]).includes(name);

/** The objects of a JSON Schema that refuse a property they do not name. */
function closedObjects(schema: unknown): number {
  if (Array.isArray(schema))
    return schema.reduce((n: number, child) => n + closedObjects(child), 0);
  if (typeof schema !== "object" || schema === null) return 0;
  return Object.entries(schema).reduce(
    (n, [key, child]) =>
      n +
      (key === "additionalProperties" && child === false
        ? 1
        : closedObjects(child)),
    0,
  );
}
/** The same schema with every closed object opened: nothing else may differ. */
const opened = (schema: unknown): unknown =>
  JSON.parse(
    JSON.stringify(schema, (key, value) =>
      key === "additionalProperties" && value === false ? undefined : value,
    ),
  );

/** The example page of the contract with one property of its own added at `path`. */
function withExtra(path: Path) {
  const page = structuredClone(vector("NodeDesiredPage", "full-page").value);
  let at = page as Record<string | number, unknown>;
  for (const key of path) at = at[key] as Record<string | number, unknown>;
  at.slot = 1;
  return page;
}

describe("the node reads the documents Cloudflare sends and ignores the properties it does not know", () => {
  it("leaves no object of a received schema closed and changes nothing else of it", () => {
    expect([...nodeReceives]).toEqual([
      "NodeEnrollmentSeed",
      "NodeEnrollmentResponse",
      "NodeCredentials",
      "ArchiveCredential",
      "NodeDesiredPage",
      "NodeObservationAnswer",
      "NodeFencedResponse",
      "ServerLinkMessage",
    ]);
    for (const name of nodeReceives) {
      expect(closedObjects(schemas[name]), name).toBe(0);
      // Required properties, enums, constants, patterns and bounds are the contract's.
      expect(schemas[name], name).toEqual(opened(strict(name)));
      expect(closedObjects(strict(name)), name).toBeGreaterThan(0);
    }
  });

  it("holds what the node sends to the contract as it is, closed objects included", () => {
    for (const name of Object.keys(nodeSchemas) as (keyof typeof nodeSchemas)[])
      if (!received(name)) expect(schemas[name], name).toEqual(strict(name));
  });

  it("keeps the API's contract closed, so that the API never sends a property by accident", () => {
    const page = vector("NodeDesiredPage", "full-page").value;
    expect(NodeDesiredPage.safeParse(page).success).toBe(true);
    for (const path of [
      [],
      ["policy"],
      ["policy", "admission"],
      ["release"],
      ["release", "image"],
      ["release", "binaries", "pgcf-agent"],
      ["release", "os", "host_files", 0],
      ["databases", 0],
      ["databases", 0, "resources"],
      ["orders", 0],
    ])
      expect(
        NodeDesiredPage.safeParse(withExtra(path)).success,
        path.join("."),
      ).toBe(false);
  });

  it("states which vectors only an unknown property fails: the node accepts them, the contract does not", () => {
    for (const name of [
      "extra-property-on-the-page",
      "extra-property-on-the-policy",
      "extra-property-on-a-policy-group",
      "extra-property-on-the-release",
      "extra-property-on-the-image",
      "extra-property-on-a-binary",
      "extra-property-on-a-host-file",
      "extra-property-on-an-entry",
      "extra-property-on-a-role",
      "extra-property-on-an-order",
      "release-with-cloudflared",
      "extra-property-on-an-origin",
      "extra-property-everywhere",
    ]) {
      const v = vector("NodeDesiredPage", name);
      expect([v.valid, v.node_valid], name).toEqual([false, true]);
    }
    // What the node still refuses: a variant it does not know, a missing property, a wrong type
    // and a value out of bound.
    for (const name of [
      "order-of-an-unknown-type",
      "origin-of-an-unknown-kind",
      "host-file-of-an-unknown-kind",
      "unknown-memory-rule",
      "unknown-desired-state",
      "order-without-an-operation",
      "order-generation-as-text",
      "release-without-the-gateway",
      "memory-step",
    ])
      expect(vector("NodeDesiredPage", name).node_valid, name).toBe(false);
    // Nothing the node sends is judged more leniently than the contract judges it.
    for (const v of allVectors)
      if (!received(v.schema))
        expect(v.node_valid, `${v.schema}/${v.name}`).toBe(v.valid);
  });
});

describe("a property of the page starts optional", () => {
  const policy = () =>
    structuredClone(vector("NodeDesiredPage", "full-page").value) as {
      policy: { admission: Record<string, unknown> };
    };

  it("lets the node and the API leave out the CPU burst, which then is 0", () => {
    const admission =
      schemas.NodeDesiredPage!.properties!.policy!.properties!.admission!;
    expect(admission.required).not.toContain("cpu_boost_ms");
    expect(admission.properties!.cpu_boost_ms!.default).toBe(0);
    const without = policy().policy;
    delete without.admission.cpu_boost_ms;
    expect(NodePolicy.parse(without).admission.cpu_boost_ms).toBe(0);
    expect(NodePolicy.parse(policy().policy).admission.cpu_boost_ms).toBe(5000);
    for (const broken of [-1, 0.5, 60_001, "5000", null]) {
      const bad = policy().policy;
      bad.admission.cpu_boost_ms = broken;
      expect(NodePolicy.safeParse(bad).success, String(broken)).toBe(false);
    }
  });

  it("lists every property that is required, so that a new one is a decision", () => {
    // While the nodes and the API run different releases, a REQUIRED property breaks the other
    // end: an API refuses the hello of an agent that does not send it yet, and an agent refuses
    // the page of an API that does not send it yet. When a line may be added here is the table in
    // plan 9.3.
    const found: Record<string, string[]> = {};
    for (const [name, schema] of Object.entries(schemas))
      Object.assign(found, requiredProperties(schema, name));
    const diff = (
      from: Record<string, string[]>,
      to: Record<string, string[]>,
    ) =>
      Object.entries(from).flatMap(([path, names]) =>
        names
          .filter((name) => !to[path]?.includes(name))
          .map((name) => `${path}.${name}`),
      );
    const added = diff(found, NODE_REQUIRED);
    const ofReceived = (entry: string) => received(entry.split(/[.|[]/)[0]!);
    expect(
      added.filter(ofReceived),
      "required properties of what the node receives: a property starts optional with a default; read the table of plan 9.3, 'Changing the page', before taking a line in test/node-required.ts",
    ).toEqual([]);
    expect(
      added.filter((entry) => !ofReceived(entry)),
      "required properties of what the node sends: the API refuses a hello or a report without one, so a property starts optional; read the table of plan 9.3, 'Changing the page', before taking a line in test/node-required.ts",
    ).toEqual([]);
    expect(
      diff(NODE_REQUIRED, found),
      "required properties gone: remove them from test/node-required.ts, after reading the rows for a removal and a rename in the table of plan 9.3, 'Changing the page' (an agent in the field may still send what the API stops accepting)",
    ).toEqual([]);
  });

  it("lists every value of a closed set the node reads, so that a new one is a decision", () => {
    // The node refuses a page with a value outside a closed set (an enum, a constant such as the
    // type of an order or the kind of an origin), and the API deploys before the nodes. The order
    // of releases for a new value is the table in plan 9.3; this list makes it a deliberate line.
    const found: Record<string, unknown[]> = {};
    for (const name of nodeReceives)
      Object.assign(found, closedSets(schemas[name]!, name));
    const values = (set: Record<string, unknown[]>, other: typeof set) =>
      Object.entries(set).flatMap(([path, list]) =>
        list
          .filter((value) => !other[path]?.includes(value))
          .map((value) => `${path}=${JSON.stringify(value)}`),
      );
    expect(
      values(found, NODE_CLOSED_SETS),
      "values added to a closed set the node reads: read the row for a new value in the table of plan 9.3, 'Changing the page', before taking a line in test/node-closed-sets.ts",
    ).toEqual([]);
    expect(
      values(NODE_CLOSED_SETS, found),
      "values gone from a closed set: remove them from test/node-closed-sets.ts",
    ).toEqual([]);
  });
});

describe("a phase of a wake event starts optional", () => {
  // The agent times the slot it took from the pool or built, and the bind of its properties,
  // mounts and order, on the slot path only; an agent before that path reports its wake without
  // them. The strict API reads the event, so it deploys first (plan 9.3, "Changing the page").
  type WakeEvent = { type: string; phases_ms: Record<string, number> };
  const wakes = (name: string) =>
    (vector("NodeEventReport", name).value as { events: WakeEvent[] }).events
      .filter((event) => event.type === "wake")
      .map((event) => event.phases_ms);

  it("lets the API read the wake of an agent that reports the slot and the bind and of one that does not", () => {
    for (const name of ["events", "wake-on-the-slot-path"]) {
      const v = vector("NodeEventReport", name);
      expect([v.valid, v.node_valid], name).toEqual([true, true]);
      expect(NodeEventReport.safeParse(v.value).success, name).toBe(true);
    }
    expect(wakes("events")[0]).not.toHaveProperty("slot");
    expect(wakes("events")[0]).not.toHaveProperty("bind");
    expect(wakes("wake-on-the-slot-path")[0]).toMatchObject({
      slot: 38,
      bind: 9,
    });
  });

  it("names both in the schema the agent holds its events to, and requires neither", () => {
    const events = schemas.NodeEventReport!.properties!.events!.items!;
    const wake = (events.oneOf ?? events.anyOf ?? []).find(
      (variant) => variant.properties?.type?.const === "wake",
    )!;
    const phases = wake.properties!.phases_ms!;
    expect(Object.keys(phases.properties!)).toEqual(
      expect.arrayContaining(["slot", "bind"]),
    );
    expect(phases.required).toBeUndefined();
    expect(wake.required).toContain("phases_ms");
  });
});

describe("the fields of an event reach the API within a bound it reads first", () => {
  // `events::sanitize` of the agent keeps the first NODE_REPORT_EVENT_FIELDS_MAX fields by key
  // order and drops the rest without a word, so the bound has to hold what the agent emits: a
  // wake that came up on the slot path emits 19. A bound that is raised is an API first change
  // (plan 9.3): an API with the old bound refuses the whole report that carries such an event.
  it("holds the 19 fields of the wake_detail of a wake on the slot path", () => {
    const v = vector(
      "NodeObservationReport",
      "event-with-the-fields-of-a-wake-on-the-slot-path",
    );
    const { fields } = (v.value as { events: { fields: object }[] }).events[0]!;
    expect(Object.keys(fields)).toHaveLength(19);
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining(["steal_ms", "steal_window_ms", "throttled_usec"]),
    );
    expect([v.valid, v.node_valid]).toEqual([true, true]);
    expect(NodeObservationReport.safeParse(v.value).success).toBe(true);
  });
});
