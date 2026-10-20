// SPDX-License-Identifier: Apache-2.0
/**
 * A walk over the JSON Schemas of `native/node.generated.json` that lists what a change of the page
 * has to decide on (ULTRA plan 9.3, "Changing the page"): the required properties and the closed
 * sets (enums and constants) of every object, by the path of the place that holds them. The
 * paths are `.name` for a property, `[]` for the items of a list, `[1]` for a tuple, `{}` for the
 * values of a record, `|type=wake` for a variant that a required constant of the same name
 * tells from the others (else `|1`, its position), `&1` for a member of an allOf. A `$ref` is
 * followed to its `$defs` entry and listed at the place that uses it.
 *
 * Nothing may escape the lists, so the walk fails for a keyword it does not know instead of
 * passing over it: a schema that starts to use one must teach the walk what it means.
 */
export type Schema = { [keyword: string]: unknown };

/** Keywords whose value is plain data: bounds, formats, the values of a set, a default. */
const DATA = new Set([
  "$comment",
  "$id",
  "$schema",
  "const",
  "contentEncoding",
  "contentMediaType",
  "default",
  "deprecated",
  "description",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "readOnly",
  "required",
  "title",
  "type",
  "uniqueItems",
  "writeOnly",
]);

type Place = { path: string; schema: Schema };

const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every schema of `root` with the path of its place; a `$ref` is followed. */
function places(root: Schema, name: string): Place[] {
  const defs = isSchema(root.$defs) ? root.$defs : {};
  const found: Place[] = [];
  const resolve = (ref: string): Schema => {
    const target = /^#\/\$defs\/([^/]+)$/.exec(ref)?.[1];
    const schema = target === undefined ? undefined : defs[target];
    if (!isSchema(schema))
      throw new Error(
        `${name}: the walk follows only a $ref to a $defs entry of its own schema, not '${ref}'`,
      );
    return schema;
  };
  /** The object a variant stands for, with its $ref followed. */
  const target = (schema: Schema): Schema =>
    typeof schema.$ref === "string"
      ? { ...resolve(schema.$ref), ...schema }
      : schema;
  /** The constant a variant requires of a property, if it does. */
  const constantOf = (schema: Schema, key: string) => {
    const { required, properties } = target(schema);
    const property = isSchema(properties) ? properties[key] : undefined;
    return Array.isArray(required) &&
      required.includes(key) &&
      isSchema(property) &&
      "const" in property
      ? ([property.const] as const)
      : undefined;
  };
  /** `|type=wake` when one required constant tells the variants apart, else `|1`. */
  const labels = (variants: Schema[]) => {
    const first = variants[0] && target(variants[0]);
    const keys = isSchema(first?.properties)
      ? Object.keys(first.properties)
      : [];
    for (const key of keys) {
      const values = variants.map((variant) => constantOf(variant, key)?.[0]);
      if (
        values.every((value) => value !== undefined) &&
        new Set(values.map(String)).size === values.length
      )
        return values.map((value) => `|${key}=${String(value)}`);
    }
    return variants.map((_, index) => `|${index}`);
  };
  const subschemas = (value: unknown, keyword: string, path: string) => {
    if (!Array.isArray(value) || !value.every(isSchema))
      throw new Error(`${path}: '${keyword}' is not a list of schemas`);
    return value;
  };

  const visit = (schema: Schema, path: string, refs: readonly string[]) => {
    found.push({ path, schema });
    for (const [keyword, value] of Object.entries(schema)) {
      if (DATA.has(keyword) || keyword === "$defs") continue;
      switch (keyword) {
        case "$ref": {
          if (typeof value !== "string")
            throw new Error(`${path}: $ref is not a string`);
          // A schema that refers to itself lists what it requires once, where it first stands.
          if (!refs.includes(value))
            visit(resolve(value), path, [...refs, value]);
          break;
        }
        case "properties":
        case "patternProperties":
          if (!isSchema(value))
            throw new Error(`${path}: '${keyword}' is not a map of schemas`);
          for (const [key, child] of Object.entries(value))
            if (isSchema(child)) visit(child, `${path}.${key}`, refs);
          break;
        case "additionalProperties":
          if (isSchema(value)) visit(value, `${path}{}`, refs);
          break;
        case "propertyNames":
          if (isSchema(value)) visit(value, `${path}{names}`, refs);
          break;
        case "items":
          if (!isSchema(value))
            throw new Error(`${path}: 'items' is not one schema`);
          visit(value, `${path}[]`, refs);
          break;
        case "prefixItems":
          subschemas(value, keyword, path).forEach((child, index) =>
            visit(child, `${path}[${index}]`, refs),
          );
          break;
        case "anyOf":
        case "oneOf": {
          const variants = subschemas(value, keyword, path);
          const named = labels(variants);
          variants.forEach((child, index) =>
            visit(child, `${path}${named[index]}`, refs),
          );
          break;
        }
        case "allOf":
          subschemas(value, keyword, path).forEach((child, index) =>
            visit(child, `${path}&${index}`, refs),
          );
          break;
        default:
          throw new Error(
            `${path}: the walk does not know the schema keyword '${keyword}'; teach it in test/node-schema-walk.ts so that nothing under it escapes the lists of required properties and closed sets`,
          );
      }
    }
  };
  visit(root, name, []);
  return found;
}

const sorted = (values: Iterable<string>) => [...values].sort();
const byText = (a: unknown, b: unknown) =>
  JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;

/** The required properties of every object of `schema`, by the path of the object. */
export function requiredProperties(schema: Schema, name: string) {
  const out: Record<string, Set<string>> = {};
  for (const { path, schema: at } of places(schema, name))
    if (Array.isArray(at.required) && at.required.length)
      out[path] = new Set([...(out[path] ?? []), ...(at.required as string[])]);
  return Object.fromEntries(
    Object.entries(out).map(([path, names]) => [path, sorted(names)]),
  );
}

/** The values of every enum and constant of `schema`, by the path of the place, in a fixed order. */
export function closedSets(schema: Schema, name: string) {
  const out: Record<string, unknown[]> = {};
  for (const { path, schema: at } of places(schema, name)) {
    const values = [
      ...(Array.isArray(at.enum) ? (at.enum as unknown[]) : []),
      ...("const" in at ? [at.const] : []),
    ];
    if (values.length)
      out[path] = [...new Set([...(out[path] ?? []), ...values])].sort(byText);
  }
  return out;
}
