// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("bootstraps private files on the observed isolated sticky kubelet mount, then refuses an unsafe retained journal without repairs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pgcf-suspend-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["bootstrap", "private", "journal-volume"])
    mkdirSync(join(root, name), { mode: 0o700 });
  const configuration = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      kubeconfigFile: "/private/pgcf/kubeconfig.json",
      kubeconfigContext: "pgcf-suspend-worker",
      journalDirectory: "/var/lib/pgcf/suspend",
    })}\n`,
  );
  writeFileSync(join(root, "bootstrap/suspend-config.json"), configuration, {
    mode: 0o600,
  });
  const initializer = fileURLToPath(
    new URL("../deploy/suspend-worker/prepare.mjs", import.meta.url),
  );
  const mounts = fileURLToPath(
    new URL("./fixtures/suspend-bootstrap-mounts.mjs", import.meta.url),
  );
  function initialize() {
    return spawnSync(process.execPath, ["--import", mounts, initializer], {
      env: {
        PGCF_FIXTURE_ROOT: root,
        KUBERNETES_SERVICE_HOST: "10.43.0.1",
        KUBERNETES_SERVICE_PORT_HTTPS: "443",
      },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
    });
  }
  const first = initialize();
  assert.equal(first.error, undefined);
  assert.equal(first.signal, null);
  assert.equal(first.status, 0, "observed kubelet bootstrap mount was refused");
  assert.equal(first.stderr, "");
  assert.equal(
    first.stdout,
    '{"mode":"suspend-worker-init","status":"ready"}\n',
  );
  const privateDirectory = join(root, "private/pgcf");
  const journalDirectory = join(root, "journal-volume/suspend");
  const configurationPath = join(privateDirectory, "suspend.json");
  const kubeconfigPath = join(privateDirectory, "kubeconfig.json");
  assert.equal(statSync(privateDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(journalDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(configurationPath).mode & 0o777, 0o600);
  assert.equal(statSync(kubeconfigPath).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(configurationPath), configuration);
  const kubeconfigBytes = readFileSync(kubeconfigPath);
  const kubeconfig = JSON.parse(kubeconfigBytes);
  assert.equal(kubeconfig.clusters[0].cluster.server, "https://10.43.0.1:443");
  assert.equal(
    kubeconfig.clusters[0].cluster["insecure-skip-tls-verify"],
    false,
  );
  assert.deepEqual(kubeconfig.users[0].user, {
    "auth-provider": {
      name: "tokenFile",
      config: { tokenFile: "/var/run/pgcf-kubernetes/token" },
    },
  });

  const journalPath = join(
    journalDirectory,
    "88888888-8888-4888-8888-888888888888.sqlite",
  );
  const retainedBytes = Buffer.from("retained fixture seal\n");
  writeFileSync(journalPath, retainedBytes, { mode: 0o600 });
  chmodSync(journalPath, 0o640);
  const restart = initialize();
  assert.equal(restart.error, undefined);
  assert.equal(restart.signal, null);
  assert.equal(restart.status, 1);
  assert.equal(restart.stdout, "");
  assert.equal(restart.stderr, "suspend_worker_initialization_failed\n");
  assert.equal(statSync(journalPath).mode & 0o777, 0o640);
  assert.deepEqual(readFileSync(journalPath), retainedBytes);
  assert.deepEqual(readFileSync(configurationPath), configuration);
  assert.deepEqual(readFileSync(kubeconfigPath), kubeconfigBytes);
});
