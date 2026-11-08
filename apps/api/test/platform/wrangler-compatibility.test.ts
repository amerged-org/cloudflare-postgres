// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import exampleConfig from "../../wrangler.example.jsonc?raw";
import testConfig from "../../wrangler.test.jsonc?raw";

// Both files are JSONC: line comments and trailing commas. The pattern keeps string literals
// (URLs contain "//") and drops comments and trailing commas outside them.
const parseJsonc = (text: string): { compatibility_flags?: string[] } =>
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
