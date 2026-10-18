// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import {
  MEASUREMENT_COHORT,
  MEASUREMENT_BODY_BYTES,
} from "../src/measurements.ts";
const path = new URL("measurements.generated.json", import.meta.url),
  source = await format(
    JSON.stringify({
      version: 1,
      constants: { MEASUREMENT_COHORT, MEASUREMENT_BODY_BYTES },
    }),
    { parser: "json" },
  );
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== source)
    throw new Error("Regenerate measurements.generated.json");
} else await writeFile(path, source);
