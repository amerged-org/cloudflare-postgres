// SPDX-License-Identifier: Apache-2.0
// The walk that `node-compat.test.ts` lists the required properties and the closed sets of the
// node's schemas with. A property or a value the walk does not reach would escape the lists that
// make a change of the page a decision (ULTRA plan 9.3, "Changing the page"), so each place a
// schema can hold one is tested here with a schema of its own.
import { describe, expect, it } from "vitest";
import {
  closedSets,
  requiredProperties,
  type Schema,
} from "./node-schema-walk.ts";

const text: Schema = { type: "string" };
const object = (
  required: string[],
  extra: Schema = {},
): Schema & { properties: Record<string, Schema> } => ({
  type: "object",
  properties: Object.fromEntries(required.map((name) => [name, text])),
  required,
  ...extra,
});

describe("the required properties of a schema", () => {
  it("are listed by the path of their object, the root included", () => {
    const schema: Schema = {
      ...object(["id", "kind"]),
      properties: {
        id: text,
        kind: text,
        inner: object(["b", "a"]),
        list: { type: "array", items: object(["x"]) },
      },
    };
    expect(requiredProperties(schema, "Doc")).toEqual({
      Doc: ["id", "kind"],
      "Doc.inner": ["a", "b"],
      "Doc.list[]": ["x"],
    });
  });

  it("are found in an object that a $ref names, at the place that uses it", () => {
    const schema: Schema = {
      type: "object",
      properties: {
        first: { $ref: "#/$defs/Part", description: "the first part" },
        many: { type: "array", items: { $ref: "#/$defs/Part" } },
      },
      $defs: { Part: object(["secret"]) },
    };
    expect(requiredProperties(schema, "Doc")).toEqual({
      "Doc.first": ["secret"],
      "Doc.many[]": ["secret"],
    });
  });

  it("are found in the value schema of a record, in a tuple and under allOf", () => {
    const schema: Schema = {
      type: "object",
      properties: {
        record: {
          type: "object",
          propertyNames: { type: "string", pattern: "^[a-z]+$" },
          additionalProperties: object(["token"]),
        },
        pair: { type: "array", prefixItems: [text, object(["second"])] },
        both: { allOf: [object(["left"]), object(["right"])] },
      },
    };
    expect(requiredProperties(schema, "Doc")).toEqual({
      "Doc.record{}": ["token"],
      "Doc.pair[1]": ["second"],
      "Doc.both&0": ["left"],
      "Doc.both&1": ["right"],
    });
  });

  it("name a variant by the constant that every variant requires, else by its position", () => {
    const tagged = (type: string, required: string[]): Schema => ({
      ...object([...required, "type"]),
      properties: { ...object(required).properties, type: { const: type } },
    });
    const schema: Schema = {
      type: "object",
      properties: {
        // `type` is required and constant in each variant: the position does not matter.
        tagged: { oneOf: [tagged("wake", ["a"]), tagged("move", ["b"])] },
        // One variant has an optional constant only, which tells the variants nothing.
        optional: {
          anyOf: [
            {
              ...object(["name"]),
              properties: { name: text, flag: { const: true } },
            },
            {
              ...object(["name", "state"]),
              properties: { name: text, state: { const: "absent" } },
            },
          ],
        },
        // A nullable object is a union of two, and null has no property to tell it by.
        nullable: { anyOf: [tagged("only", ["c"]), { type: "null" }] },
      },
    };
    expect(requiredProperties(schema, "Doc")).toEqual({
      "Doc.tagged|type=wake": ["a", "type"],
      "Doc.tagged|type=move": ["b", "type"],
      "Doc.optional|0": ["name"],
      "Doc.optional|1": ["name", "state"],
      "Doc.nullable|0": ["c", "type"],
    });
  });

  it("name two variants that share their constant by position, so that no path is lost", () => {
    const variant = (required: string[]): Schema => ({
      ...object([...required, "type"]),
      properties: { ...object(required).properties, type: { const: "same" } },
    });
    const schema: Schema = { oneOf: [variant(["a"]), variant(["b"])] };
    expect(requiredProperties(schema, "Doc")).toEqual({
      "Doc|0": ["a", "type"],
      "Doc|1": ["b", "type"],
    });
  });

  it("end for a schema that refers to itself", () => {
    const schema: Schema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          ...object(["name"]),
          properties: { name: text, child: { $ref: "#/$defs/Node" } },
        },
      },
    };
    expect(requiredProperties(schema, "Tree")).toEqual({ Tree: ["name"] });
  });

  it("fail for a keyword that the walk does not know, so that nothing escapes the list", () => {
    for (const keyword of ["if", "not", "contains", "dependentSchemas"])
      expect(
        () =>
          requiredProperties(
            { type: "object", [keyword]: object(["hidden"]) },
            "Doc",
          ),
        keyword,
      ).toThrow(`schema keyword '${keyword}'`);
    expect(() =>
      requiredProperties({ $ref: "https://example.test/x.json" }, "Doc"),
    ).toThrow("$ref");
    expect(() => requiredProperties({ $ref: "#/$defs/Gone" }, "Doc")).toThrow(
      "Gone",
    );
  });
});

describe("the closed sets of a schema", () => {
  it("are the values of every enum and constant, by the path of their place and in order", () => {
    const schema: Schema = {
      type: "object",
      properties: {
        mode: { enum: ["reserved", "measured"] },
        v: { const: 1 },
        flag: { type: "boolean", const: true },
        list: { type: "array", items: { enum: [3, 1, 2] } },
        shared: { $ref: "#/$defs/Kind" },
        record: { type: "object", additionalProperties: { enum: ["ok"] } },
        free: { type: "string", default: "not a set" },
      },
      $defs: { Kind: { type: "string", enum: ["file", "link"] } },
    };
    expect(closedSets(schema, "Doc")).toEqual({
      "Doc.mode": ["measured", "reserved"],
      "Doc.v": [1],
      "Doc.flag": [true],
      "Doc.list[]": [1, 2, 3],
      "Doc.shared": ["file", "link"],
      "Doc.record{}": ["ok"],
    });
  });

  it("do not look into the data of a default", () => {
    const schema: Schema = {
      type: "object",
      properties: {
        value: { default: { enum: ["a"], required: ["b"] } },
      },
    };
    expect(requiredProperties(schema, "Doc")).toEqual({});
    expect(closedSets(schema, "Doc")).toEqual({});
  });
});
