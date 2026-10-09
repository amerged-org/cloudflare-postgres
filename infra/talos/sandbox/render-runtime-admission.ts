// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { sandboxRuntimeAdmission } from "./runtime-admission.ts";
const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length)
  throw Error("Input and output files required");
const scope = JSON.parse(await readFile(input, "utf8")) as Parameters<
    typeof sandboxRuntimeAdmission
  >[0],
  rendered = sandboxRuntimeAdmission(scope);
await writeFile(
  output,
  JSON.stringify(
    { apiVersion: "v1", kind: "List", items: rendered.objects },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(JSON.stringify({ objects: rendered.objects.length }));
