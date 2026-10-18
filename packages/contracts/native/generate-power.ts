// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { ID_ALPHABET } from "../src/ids.ts";
import { SLEEP_SQL, SLEEP_REFUSALS } from "../src/sleep.ts";
import { GATEWAY_RETIRE_HOLD_MS } from "../src/gateway-control.ts";
import { physicalReclamationVectors } from "./power-vectors.ts";
const contract = {
  version: 1,
  constants: {
    ID_ALPHABET,
    SLEEP_SQL,
    SLEEP_REFUSALS,
    GATEWAY_RETIRE_HOLD_MS,
  },
};
for (const [name, value] of Object.entries({
  "power.generated.json": contract,
  "power-vectors.generated.json": {
    reclamation: await physicalReclamationVectors(),
  },
})) {
  const path = new URL(name, import.meta.url);
  const text = await format(JSON.stringify(value), { parser: "json" });
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== text)
      throw new Error(`Regenerate ${name}`);
  } else await writeFile(path, text);
}
