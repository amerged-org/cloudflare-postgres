// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const unsupported = (source: string) =>
  source.match(
    /--(?:file|filename|patch-file)(?:=|["']\s*,\s*["'])(?:\/dev\/stdin|\/proc\/self\/fd(?:\/\d+)?)/g,
  ) ?? [];

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
      0,
      `${path}: filename payload must use a private real file`,
    );
  }
});
test("the compact check catches stdin and FD reopening", () => {
  assert.equal(
    unsupported('spawn("tool", ["apply", "--file=/dev/stdin"])').length,
    1,
  );
  assert.equal(
    unsupported('spawn("tool", ["patch", "--patch-file=/proc/self/fd/0"])')
      .length,
    1,
  );
  assert.equal(unsupported('const hostFD = "/proc/self/fd/3";').length, 0);
  assert.equal(
    unsupported('spawn("tool", ["patch", "--patch-file", "/dev/stdin"])')
      .length,
    1,
  );
});
