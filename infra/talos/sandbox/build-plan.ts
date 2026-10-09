// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { sandboxImagePlan, bindSandboxImageProfiles } from "./images.ts";
const [mode, ...args] = process.argv.slice(2);
async function save(directory: string, name: string, value: unknown) {
  await writeFile(
    join(directory, name),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
}
if (mode === "prepare" && args.length >= 3) {
  const [commit, extension, output, ...other] = args;
  const plan = sandboxImagePlan({
    sourceCommit: commit!,
    architecture: "amd64",
    sandboxExtension: extension!,
    otherExtensions: other,
  });
  const directory = resolve(output!);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await save(directory, "recipe.json", plan.recipe);
  await save(directory, "manifest.yaml", plan.schematicManifest);
  await save(directory, "plan.json", plan);
  await writeFile(
    join(directory, "LICENSE"),
    await readFile(new URL("../../../LICENSE", import.meta.url)),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ recipeSha256: plan.recipeSha256, bound: false }),
  );
} else if (mode === "bind" && args.length === 2) {
  const directory = resolve(args[0]!),
    previous = JSON.parse(
      await readFile(join(directory, "plan.json"), "utf8"),
    ) as ReturnType<typeof sandboxImagePlan>,
    recipe = previous.recipe;
  const plan = sandboxImagePlan({
    sourceCommit: recipe.source_commit,
    architecture: recipe.architecture as "amd64",
    sandboxExtension: recipe.sandbox_extension,
    otherExtensions: recipe.system_extensions.filter(
      (value) => value !== recipe.sandbox_extension,
    ),
  });
  if (plan.recipeSha256 !== previous.recipeSha256)
    throw Error("talos_recipe_changed");
  const profiles = bindSandboxImageProfiles(plan, args[1]!);
  await save(directory, "installer.profile.json", profiles.installer);
  await save(directory, "raw.profile.json", profiles.raw);
  console.log(JSON.stringify({ recipeSha256: plan.recipeSha256, bound: true }));
} else
  throw Error(
    "Use prepare <source-commit> <qualified-sandbox-extension@sha256> <output-dir> [other-qualified-extensions@sha256...] or bind <output-dir> <qualified-recipe-extension@sha256>",
  );
