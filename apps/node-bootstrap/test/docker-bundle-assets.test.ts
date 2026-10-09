// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const storageSource = "infra/storage/sources.lock.json";

function privateInput(name: string) {
  return (
    name.startsWith(".") ||
    ["node_modules", "dist", "target", "kubeconfig", "talosconfig"].includes(
      name,
    ) ||
    /(?:\.pem|\.key)$|\.private\./.test(name)
  );
}

async function copyPublicInput(source: string, destination: string) {
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (privateInput(entry.name)) continue;
    assert.equal(
      entry.isSymbolicLink(),
      false,
      "public source input is a symlink",
    );
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyPublicInput(from, to);
    else {
      assert.equal(entry.isFile(), true);
      await copyFile(from, to);
    }
  }
}

test("Native bundles all five commands from clean public Docker inputs including the storage source lock", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "pgcf-native-docker-inputs-"));
  await chmod(temporary, 0o700);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const context = join(temporary, "context");
  const dependencies = join(temporary, "public-dependencies");
  await mkdir(context, { mode: 0o700 });
  await mkdir(dependencies, { mode: 0o700 });
  const dockerfile = await readFile(
    join(repository, "apps/node-bootstrap/Dockerfile"),
    "utf8",
  );
  const buildStage = dockerfile.split(/^FROM .* AS clients$/m)[0]!;
  const copySources: string[] = [];
  for (const line of buildStage.split("\n")) {
    if (!line.startsWith("COPY ")) continue;
    const fields = line.slice(5).trim().split(/\s+/);
    const destination = fields.pop()!;
    assert.ok(!fields.some((field) => field.startsWith("--")));
    for (const source of fields) {
      assert.ok(!source.startsWith("/") && !source.split("/").includes(".."));
      assert.ok(!source.split("/").some(privateInput));
      const normalized = source.replace(/\/$/, "");
      assert.ok(
        destination === "./" || destination.replace(/\/$/, "") === normalized,
      );
      const from = join(repository, normalized);
      const to = join(context, normalized);
      if (source.endsWith("/") || normalized === "apps/node-bootstrap/src")
        await copyPublicInput(from, to);
      else {
        await mkdir(dirname(to), { recursive: true, mode: 0o700 });
        await copyFile(from, to);
      }
      copySources.push(normalized);
    }
  }
  // Reuse only installed upstream code. The workspace contract resolves inside
  // the clean context; no checkout node_modules tree or private files are copied.
  for (const name of ["yaml", "zod"]) {
    const installed = await realpath(
      join(repository, "apps/node-bootstrap/node_modules", name),
    );
    await symlink(installed, join(dependencies, name), "dir");
  }
  await mkdir(join(dependencies, "@pgcf"), { mode: 0o700 });
  await symlink(
    join(context, "packages/contracts"),
    join(dependencies, "@pgcf/contracts"),
    "dir",
  );
  const result = await build({
    absWorkingDir: context,
    entryPoints: [
      "server",
      "proxy-command",
      "inspection-proxy-command",
      "outside-scan-command",
      "proof-proxy-command",
    ].map((name) => `apps/node-bootstrap/src/${name}.ts`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["ws"],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    outdir: "apps/node-bootstrap/dist",
    outExtension: { ".js": ".mjs" },
    nodePaths: [dependencies],
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  assert.equal(result.outputFiles.length, 5);
  assert.ok(
    result.outputFiles.every(
      (file) => file.path.endsWith(".mjs") && file.contents.length > 0,
    ),
  );
  assert.ok(copySources.includes(storageSource));
  assert.ok(Object.keys(result.metafile.inputs).includes(storageSource));
  const dockerignore = await readFile(
    join(repository, ".dockerignore"),
    "utf8",
  );
  assert.ok(dockerignore.split("\n").includes("!infra/storage/"));
  assert.ok(dockerignore.split("\n").includes(`!${storageSource}`));
  assert.match(
    dockerfile.split(/^FROM .* AS clients$/m)[1]!,
    /^COPY infra\/storage\/sources\.lock\.json \/workspace\/infra\/storage\/sources\.lock\.json$/m,
  );
  assert.equal(resolve(context, storageSource).startsWith(context + "/"), true);
});
