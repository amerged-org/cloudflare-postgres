// SPDX-License-Identifier: Apache-2.0
// The JSON Schemas the node agent validates with (`node.generated.json`). The Zod contracts are
// strict objects, which is right for the API: it never sends or accepts a property by accident.
// The node reads what Cloudflare sends it with every object open, because the API deploys before
// the nodes and an additive change must not make a running agent refuse the page that would
// update it (ULTRA plan 9.3, "Changing the page"). Everything else of a schema stays: required
// properties, enums, constants, patterns and bounds.
import { z } from "zod";
import { nodeReceives, nodeSchemas } from "./node-vectors.ts";

/** `schema` with every object that refuses properties it does not name opened. */
export function opened(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(opened);
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, child]) =>
      key === "additionalProperties" && child === false
        ? []
        : [[key, opened(child)]],
    ),
  );
}

/**
 * The schema of each node document by name. A property with a default is optional for the node
 * (the schema of its input), which is how a property starts: the node and the API both leave it
 * out. Plan 9.3, "Changing the page", says when it may be made required.
 */
export function nodeJsonSchemas() {
  const received = new Set<string>(nodeReceives);
  return Object.fromEntries(
    Object.entries(nodeSchemas).map(([name, schema]) => {
      const json = z.toJSONSchema(schema, { io: "input" });
      return [name, received.has(name) ? opened(json) : json];
    }),
  );
}
