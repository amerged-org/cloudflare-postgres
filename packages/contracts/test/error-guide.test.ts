// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderErrorGuide } from "../src/error-guide.ts";

const page = new URL("../../../docs/errors.md", import.meta.url);

describe("docs/errors.md", () => {
  it("is the rendering of the error code, reason and refusal lists", () => {
    // Regenerate with: UPDATE_ERRORS_DOC=1 pnpm --filter @pgcf/contracts exec vitest run test/error-guide.test.ts
    if (process.env["UPDATE_ERRORS_DOC"] === "1")
      writeFileSync(page, renderErrorGuide());
    expect(readFileSync(page, "utf8")).toBe(renderErrorGuide());
  });
});
