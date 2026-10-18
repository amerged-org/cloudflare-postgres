// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { SLEEP_SQL, SLEEP_REFUSALS } from "../src/sleep.ts";
const contract = {
  version: 1,
  constants: {
    SLEEP_SQL,
    SLEEP_REFUSALS,
  },
};
const path = new URL("power.generated.json", import.meta.url),
  text = await format(JSON.stringify(contract), { parser: "json" });
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== text)
    throw new Error("Regenerate power.generated.json");
} else await writeFile(path, text);
