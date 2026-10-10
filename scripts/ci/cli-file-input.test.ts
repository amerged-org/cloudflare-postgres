// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const unsupported = (source: string) =>
  source.match(
    /--(?:file|filename|patch-file)(?:=|["']\s*,\s*["'])(?:\/dev\/stdin|\/proc\/self\/fd(?:\/\d+)?)|--file=-/g,
  ) ?? [];

// Logical command producers feed only the reviewed native file materializer.
// New raw-FD or Talos '-' inputs require fixing the boundary, not extending this list.
const materialized = new Map([
  ["apps/node-bootstrap/src/fleet-patch.ts", 6],
  ["apps/node-bootstrap/src/fleet-platform-patch.ts", 2],
  ["apps/node-bootstrap/src/fleet-host-configuration.ts", 1],
  ["apps/node-bootstrap/src/fleet-kubernetes-images.ts", 1],
]);
async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? [
            "node_modules",
            "target",
            "build",
            "dist",
            "test",
            "tests",
            "fixtures",
            "Cargo",
            ".local",
            ".wrangler",
          ].includes(entry.name)
          ? Promise.resolve([])
          : sources(path)
        : Promise.resolve(
            /\.(?:ts|js|mjs|sh)$/.test(entry.name) &&
              !/\.(?:test|spec)\./.test(entry.name)
              ? [path]
              : [],
          );
    }),
  );
  return nested.flat();
}

test("native CLI payload file flags cannot regain raw stdin aliases", async () => {
  const files = (
    await Promise.all(
      ["apps", "scripts", "infra"].map((path) => sources(resolve(root, path))),
    )
  ).flat();
  for (const file of files) {
    const path = relative(root, file);
    const source = await readFile(file, "utf8");
    assert.equal(
      unsupported(source).length,
      materialized.get(path) ?? 0,
      `${path}: filename payload must use a private real file`,
    );
    if (materialized.has(path) && !path.endsWith("/fleet-patch.ts"))
      assert.equal(
        /\bspawn(?:Sync)?\s*\(/.test(source),
        false,
        `${path}: logical payload producer must use the reviewed native adapter`,
      );
  }
});
test("the compact check catches FD reopening and unsupported Talos files but preserves kubectl direct streams", () => {
  assert.equal(
    unsupported('spawn("talosctl", ["apply-config", "--file=-"])').length,
    1,
  );
  assert.equal(
    unsupported('spawn("kubectl", ["patch", "--patch-file=/dev/stdin"])')
      .length,
    1,
  );
  assert.equal(
    unsupported('spawn("kubectl", ["patch", "--patch-file=/proc/self/fd/0"])')
      .length,
    1,
  );
  assert.equal(
    unsupported('spawn("kubectl", ["create", "--filename=-"])').length,
    0,
  );
  assert.equal(unsupported('const hostFD = "/proc/self/fd/3";').length, 0);
  assert.equal(
    unsupported('spawn("kubectl", ["patch", "--patch-file", "/dev/stdin"])')
      .length,
    1,
  );
});
