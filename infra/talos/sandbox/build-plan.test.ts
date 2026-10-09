// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
test("CI qualification stops after first-party extension and recipe publication", async () => {
  const script = await readFile(new URL("ci-artifacts.sh", import.meta.url), "utf8");
  assert.match(script, /--profile sandbox-extension qualify/);
  assert.match(script, /--profile talos-recipe qualify/);
  assert.match(script, /values=\{extension_ref:extension,recipe_ref:recipe\}/);
  assert.doesNotMatch(
    script,
    /docker run|docker (?:load|save|tag)|builder prune|PGCF_IMAGER|boot-image-qualification|whole-os-qualification|installer-gate|publish-artifacts/,
  );
});
test("the real producer emits only public recipe inputs and binds both actual imager profiles after recipe qualification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-talos-plan-")),
    extension = "ghcr.io/example/sandbox@sha256:" + "a".repeat(64),
    recipe = "ghcr.io/example/recipe@sha256:" + "b".repeat(64),
    script = new URL("build-plan.ts", import.meta.url).pathname;
  try {
    let result = spawnSync(
      process.execPath,
      [script, "prepare", "c".repeat(40), extension, directory],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).bound, false);
    assert.equal(
      (await stat(join(directory, "recipe.json"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      await readFile(join(directory, "LICENSE"), "utf8"),
      await readFile(new URL("../../../LICENSE", import.meta.url), "utf8"),
    );
    result = spawnSync(process.execPath, [script, "bind", directory, recipe], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).bound, true);
    const installer = JSON.parse(
        await readFile(join(directory, "installer.profile.json"), "utf8"),
      ),
      raw = JSON.parse(
        await readFile(join(directory, "raw.profile.json"), "utf8"),
      );
    assert.deepEqual(
      installer.input.systemExtensions,
      raw.input.systemExtensions,
    );
    assert.equal(installer.input.systemExtensions.at(-1).imageRef, recipe);
    assert.doesNotMatch(
      JSON.stringify([installer, raw]),
      /machineconfig|agent_key|talos\.config|ip=/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
