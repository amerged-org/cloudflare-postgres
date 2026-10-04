// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const contracts = createRequire(import.meta.resolve("@pgcf/contracts"));
const zod = dirname(contracts.resolve("zod/package.json"));
await build({
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["ws"],
  outfile: resolve(root, "dist/main.js"),
  banner: { js: "// SPDX-License-Identifier: Apache-2.0" },
});
await mkdir(resolve(root, "dist/licenses"), { recursive: true });
await writeFile(
  resolve(root, "dist/licenses/Apache-2.0.txt"),
  await readFile(resolve(root, "../../LICENSE")),
);
await writeFile(
  resolve(root, "dist/licenses/zod-MIT.txt"),
  await readFile(resolve(zod, "LICENSE")),
);
