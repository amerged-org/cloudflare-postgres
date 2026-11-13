// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import exampleConfig from "../../wrangler.example.jsonc?raw";
import testConfig from "../../wrangler.test.jsonc?raw";

// Both files are JSONC: line comments and trailing commas. The pattern keeps string literals
// (URLs contain "//") and drops comments and trailing commas outside them.
const parseJsonc = (
  text: string,
): {
  compatibility_flags?: string[];
  ratelimits?: { name: string; namespace_id: string; simple: unknown }[];
} =>
  JSON.parse(
    text.replace(
      /("(?:\\.|[^"\\])*")|\/\/[^\n]*|,(\s*[}\]])/g,
      (match, string: string | undefined, closing: string | undefined) =>
        string ?? closing ?? "",
    ),
  );

// Without this flag fetch() to a hostname of the Worker's own zone reaches that zone's origin
// (skipping Workers, WAF and Access) instead of the public path. Webhook delivery relies on it.
it.each([
  ["wrangler.example.jsonc", exampleConfig],
  ["wrangler.test.jsonc", testConfig],
])("%s keeps webhook fetches on the public path", (_name, text) => {
  expect(parseJsonc(text).compatibility_flags).toContain(
    "global_fetch_strictly_public",
  );
});

// The API limits each source address on its own namespace, before any key is read: the default is
// 3000 requests a minute, and an operator puts the namespace id of the account in place of its placeholder.
it("limits each source address in the example to 3000 requests a minute on the API's own namespace", () => {
  expect(parseJsonc(exampleConfig).ratelimits).toContainEqual({
    name: "API_RATE_LIMITER",
    namespace_id: "<API_RATE_LIMIT_NAMESPACE_ID>",
    simple: { limit: 3000, period: 60 },
  });
});
