// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { snapshotFileLimit } from "../src/talos-operator.ts";

test("the actual snapshot child has a kernel file limit before writing its private snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-snapshot-limit-")),
    file = join(directory, "snapshot");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = snapshotFileLimit(
    process.execPath,
    [
      "--eval",
      `const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'wx',0o600);for(let i=0;i<1000;i++)fs.writeSync(fd,Buffer.alloc(1024));`,
      file,
    ],
    16 * 1024,
  );
  const child = spawn(command.program, command.args, {
    stdio: "ignore",
    cwd: directory,
  });
  const code = await new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  assert.notEqual(code, 0);
  const snapshot = await stat(file);
  assert.ok(snapshot.size > 0 && snapshot.size <= 16 * 1024);
  assert.equal(snapshot.mode & 0o777, 0o600);
  assert.throws(
    () => snapshotFileLimit(process.execPath, [], NaN),
    /snapshot_limit_invalid/,
  );
});

test("the extracted operator bundles with the actual Bootstrap banner without duplicate module bindings", async () => {
  const metadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: { build: string } };
  const banner = /--banner:js="([^"]+)"/.exec(metadata.scripts.build)?.[1];
  assert.ok(banner);
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../src/infrastructure-backup.ts", import.meta.url),
      ),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["ws"],
    banner: { js: banner },
    write: false,
    logLevel: "silent",
  });
  const checked = spawnSync(
    process.execPath,
    ["--check", "--input-type=module"],
    {
      input: result.outputFiles[0]!.text,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(checked.status, 0, checked.stderr);
});
