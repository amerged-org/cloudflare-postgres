// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createNodeRescueHostIdentity } from "@pgcf/contracts/node-installation";

test("fresh generated rescue host keys are accepted by the real OpenSSH client", async () => {
  const first = await createNodeRescueHostIdentity(),
    second = await createNodeRescueHostIdentity();
  assert.notEqual(first.ssh_host_key, second.ssh_host_key);
  const directory = await mkdtemp(join(tmpdir(), "pgcf-rescue-host-"));
  await chmod(directory, 0o700);
  try {
    const config = JSON.parse(first.user_data.split("\n")[1]!);
    const path = join(directory, "host-key");
    await writeFile(path, config.ssh_keys.ed25519_private, { mode: 0o600 });
    const derived = await promisify(execFile)(
      "ssh-keygen",
      ["-y", "-P", "", "-f", path],
      { timeout: 10000 },
    );
    assert.equal(derived.stdout.trim(), first.ssh_host_key);
    assert.equal(config.ssh_keys.ed25519_public, first.ssh_host_key);
    assert.equal(config.ssh_deletekeys, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
